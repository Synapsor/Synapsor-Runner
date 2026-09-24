import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadActiveActionRuleAuthority, readActionRuleReviewSubjects, type ActionRuleReviewSubject } from "./action-rule-authority.js";
import type { BoundaryAuthoringResumeState, BoundaryPolicyReviewContext } from "./boundary-authoring-resume.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

type Context = { source_session: string; source_digest: `sha256:${string}`; read_name: string; read_digest: `sha256:${string}` };
type ReviewSubjectErrorCode = "POLICY_REVIEW_CANDIDATE_CHANGED" | "POLICY_REVIEW_CANDIDATE_UNAVAILABLE" | "POLICY_REVIEW_SUBJECT_CHANGED";
export class AuthoringReviewSubjectError extends Error {
  constructor(readonly code: ReviewSubjectErrorCode, message: string) { super(`${code}: ${message}`); }
}
const failure = (code: ReviewSubjectErrorCode, message: string): never => { throw new AuthoringReviewSubjectError(code, message); };
const sameContext = (record: BoundaryPolicyReviewContext, context: Context) => record.source_session === context.source_session
  && record.source_digest === context.source_digest && record.read_digest === context.read_digest;
const sameAction = (subject: ActionRuleReviewSubject, record: BoundaryPolicyReviewContext) => subject.authority.authority.name === record.action_name
  && subject.authority.digest === record.action_digest;

/** Resolve a review, never an edit. Names/outcomes/timestamps cannot establish
 * that a retained job was published. Its exact source/Read/semantic binding and
 * the repository's immutable publication relationship are both required. */
export async function resolveAuthoringReviewSubject(input: {
  projectRoot: string; resume: BoundaryAuthoringResumeState; context: Context;
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption">; selectCurrentContext?: boolean;
}): Promise<{ cancelled?: true; subject?: ActionRuleReviewSubject; assertCurrent(): Promise<void> }> {
  const all = await readActionRuleReviewSubjects(input.projectRoot);
  const matchesRead = (subject: ActionRuleReviewSubject) => subject.authority.authority.rules.every(rule =>
    rule.read_boundary_name === input.context.read_name && rule.read_boundary_digest === input.context.read_digest);
  const relevant = all.filter(matchesRead);
  const pending = input.resume.pending_policy_review;
  const last = input.resume.completed_policy_reviews?.at(-1)?.request;
  const anchor = pending?.action_name ? pending : last?.action_name ? last : undefined;
  const jobOutcomes = input.resume.action?.completed_outcomes ?? (input.resume.action?.outcome ? [input.resume.action.outcome] : []);
  const draftSubjects = relevant.filter(subject => subject.identity.location === "disabled"
    && (anchor ? subject.authority.authority.name === anchor.action_name
      : jobOutcomes.length > 0 && jobOutcomes.every(outcome => subject.authority.authority.rules.some(rule => rule.rule.outcome === outcome))));
  const active = relevant.find(subject => subject.identity.location === "active");
  const exactPublication = (item: ActionRuleReviewSubject, record: BoundaryPolicyReviewContext) => !record.action_subject
    || record.action_subject.store === item.identity.store && (record.action_subject.location === "disabled"
      ? record.action_subject.record === item.published_from : record.action_subject.record === item.identity.record);
  const published = active?.published_from && anchor && sameContext(anchor, input.context) && sameAction(active, anchor)
    && exactPublication(active, anchor) ? active : undefined;
  const explicitCurrent = active?.published_from && input.selectCurrentContext && anchor && sameContext(anchor, input.context)
    && active.authority.authority.name === anchor.action_name
    && (!anchor.action_subject || anchor.action_subject.store === active.identity.store)
    && active.prior_subjects?.some(prior => prior.digest === anchor.action_digest
      && (!anchor.action_subject || prior.record === anchor.action_subject.record)) ? active : undefined;
  let subject: ActionRuleReviewSubject | undefined;
  const select = async (choices: ActionRuleReviewSubject[]) => {
    const selected = await input.session.chooseOption?.("SELECT EXACT ACTION SUBJECT TO REVIEW", choices.map((value, index) => ({
      value: String(index), label: `${value.identity.location === "active" ? "Active published" : "Disabled candidate"}: ${value.authority.authority.name}`,
      detail: `${value.authority.digest} · ${value.identity.record}. Review only; other unfinished work remains saved.`,
    })), { reviewOnly: true });
    return choices.find((_, index) => String(index) === selected);
  };
  // A Read-only job does not acquire an Action simply because one shares its Read.
  if (!input.resume.action && !pending?.action_name) subject = undefined;
  else if (pending?.action_name) {
    subject = draftSubjects.find(item => sameAction(item, pending)
      && (!pending.action_subject || canonicalJsonDigest(item.identity) === canonicalJsonDigest(pending.action_subject)))
      ?? (published && (!pending.action_subject || pending.action_subject.location === "active"
        && canonicalJsonDigest(published.identity) === canonicalJsonDigest(pending.action_subject)) ? published : undefined);
    // A pending disabled review can move to its own exact publication only on
    // explicit Review, with a displayed lifecycle change and renewed binding.
    if (!subject && published && input.selectCurrentContext) subject = published;
    if (!subject) {
      if (!input.selectCurrentContext) failure("POLICY_REVIEW_CANDIDATE_CHANGED", "The exact pending review subject is no longer current. Select Review explicitly to inspect current choices; its intent remains pending.");
      const choices = [...draftSubjects.filter(item => item.authority.authority.name === pending.action_name), ...(explicitCurrent ? [explicitCurrent] : [])];
      if (!choices.length) failure("POLICY_REVIEW_CANDIDATE_UNAVAILABLE", "The exact review subject is unavailable or its publication cannot be established. Inspect the saved job and current authority; no draft recreation or replacement was inferred.");
      subject = await select(choices);
      if (!subject) return { cancelled: true, assertCurrent: async () => {} };
    }
  } else if (input.resume.pending_action_revision) {
    const prepared = input.resume.pending_action_revision.preparation?.prepared_digest;
    subject = prepared ? draftSubjects.find(item => item.authority.digest === prepared) : undefined;
    if (!subject) failure("POLICY_REVIEW_CANDIDATE_CHANGED", "The exact saved edit is not a current disabled candidate. Its request remains pending; current active authority cannot substitute for it.");
  } else if (anchor && sameContext(anchor, input.context) && draftSubjects.some(item => sameAction(item, anchor))) {
    subject = draftSubjects.find(item => sameAction(item, anchor));
  } else if (published && !draftSubjects.length) subject = published;
  else if (draftSubjects.length) {
    // When a different active revision exists, do not silently select it or a
    // newer candidate based on recency. A recorded pending edit still owns its
    // disabled target; otherwise ask the operator which exact subject to review.
    const choices = published ? [...draftSubjects, published] : draftSubjects;
    if (choices.length === 1) subject = choices[0];
    else {
      subject = await select(choices);
      if (!subject) return { cancelled: true, assertCurrent: async () => {} };
    }
  } else if (explicitCurrent) {
    subject = await select([explicitCurrent]);
    if (!subject) return { cancelled: true, assertCurrent: async () => {} };
  } else failure("POLICY_REVIEW_CANDIDATE_UNAVAILABLE", "No current Action matches this job's exact review and publication bindings. Inspect its recorded review and current authority; no draft recreation or unrelated active replacement was inferred.");
  const snapshot = canonicalJsonDigest(all);
  const assertCurrent = async () => {
    const current = await readActionRuleReviewSubjects(input.projectRoot);
    if (canonicalJsonDigest(current) !== snapshot)
      failure("POLICY_REVIEW_SUBJECT_CHANGED", "Action review subjects or their selected store changed. Reopen the exact current review; no stale completion was saved.");
    if (subject?.identity.location === "active") {
      const loaded = await loadActiveActionRuleAuthority(input.projectRoot);
      if (canonicalJsonDigest(loaded.activation) !== canonicalJsonDigest(subject.authority))
        failure("POLICY_REVIEW_SUBJECT_CHANGED", "The selected active publication changed or is unavailable. No current completion was inferred.");
    }
  };
  await assertCurrent();
  return { ...(subject ? { subject } : {}), assertCurrent };
}
