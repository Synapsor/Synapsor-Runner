import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  readActionRuleAuthorityActivation, readActionRuleAuthorityDraft, readActionRuleAuthorityRevisionBaseline, readActionRuleReviewSubjects,
  readActionRuleProspectiveWithdrawal,
  type ActionRuleAuthorityDraftV1, type ActionWithdrawalReview,
} from "./action-rule-authority.js";
import { proveExactActionWithdrawal } from "./action-rule-withdrawal-proof.js";
import { explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { isPreparedProgramRemoval } from "./authoring-program-completion.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import { activePolicySource, loadPolicySources } from "./authoring-policy-source.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import {assertPendingWithdrawalDutyProofs} from './authoring-retained-duties.js';

export type { ActionWithdrawalReview } from "./action-rule-authority.js";

/** Read-only preview and publication use this same real dependency assessment.
 * Pending English obligations remain pending. No model result grants withdrawal,
 * and an exact semantic reduction alone does not establish current evidence. */
export async function assessActionWithdrawal(input: {
  projectRoot: string; draft: ActionRuleAuthorityDraftV1; env?: NodeJS.ProcessEnv;
  baseConfigPath?: string; outputConfigPath?: string;
  expected_context_digest?: string; permit?: ProjectAuthorityMutationPermit;
}): Promise<ActionWithdrawalReview> {
  const run = (root: string) => withProjectAuthorityMutation(root, async permit => {
    const refuse = (reason: string): never => { throw Object.assign(new Error(
      `ACTION_RULE_WITHDRAWAL_NOT_CURRENT: ${reason} Reopen this exact withdrawal review. Existing authority and pending source duties remain unchanged.`,
    ), { code: "ACTION_RULE_WITHDRAWAL_NOT_CURRENT" }); };
    const projectRoot = permit.projectRoot;
    const baseline = await readActionRuleAuthorityRevisionBaseline(projectRoot, permit);
    const active = await readActionRuleAuthorityActivation(projectRoot);
    const draft = await readActionRuleAuthorityDraft(projectRoot, input.draft.authority.name);
    if (!active || !draft || canonicalJsonDigest(draft) !== canonicalJsonDigest(input.draft)) return refuse("The selected active or disabled record changed.");
    const removed = proveExactActionWithdrawal(active, draft);
    const selected = (await readProjectReadAuthoring(projectRoot, input.env))?.selected;
    if (!selected) return refuse("Current guided Read and source records are unavailable.");
    const binding = { boundary_name: selected.progress.candidate.pack.name,
      generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
      schema_fingerprint: selected.draft_lock.schema_fingerprint,
      role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint };
    const resume = await readBoundaryAuthoringResumeState(projectRoot, binding);
    if (resume.status !== "ready" || !isPreparedProgramRemoval(resume.value, draft)
      || removed.length !== 1 || removed[0] !== resume.value.pending_action_removal?.outcome
      || resume.value.pending_job_revision || resume.value.pending_read_revision || resume.value.pending_action_revision
      || resume.value.pending_action_addition || resume.value.pending_read_relationship) {
      return refuse("The saved request does not identify this complete exact removal.");
    }
    const readDigest = explorationBoundaryCandidateDigest(selected.progress.candidate);
    if (draft.authority.rules.some(rule => rule.read_boundary_name !== binding.boundary_name || rule.read_boundary_digest !== readDigest)) {
      return refuse("A retained Action has a different Read binding.");
    }
    const activeReads = await loadActivatedExplorationBoundaries(projectRoot);
    if (draft.authority.rules.some(rule => !activeReads.some(read => read.pack.name === rule.read_boundary_name
      && read.activation.digest === rule.read_boundary_digest))) return refuse("The exact retained Read authority is unavailable.");
    const review = await savedAuthoringPolicyReview({ projectRoot, binding, readDigest, exactActionDraft: draft, env: input.env, permit });
    if (!review?.dependencies_current || !resume.value.policy_source_session) return refuse("Source, shared-count or other review dependencies need current validation.");
    const session = await loadPolicySources(projectRoot, resume.value.policy_source_session);
    const source = activePolicySource(session);
    if (!source || !session.coverage || session.coverage.source_digest !== source.digest) return refuse("Complete current source coverage is unavailable.");
    try {assertPendingWithdrawalDutyProofs(session.coverage,await readActionRuleProspectiveWithdrawal(projectRoot,draft,readDigest));}
    catch {return refuse('The exact prospective Source-duty audit needs current validation.');}
    const pending = resume.value.pending_policy_review;
    const subject = (await readActionRuleReviewSubjects(projectRoot)).find(s => s.identity.location === "disabled"
      && canonicalJsonDigest(s.authority) === canonicalJsonDigest(draft));
    if (!subject || (pending && (pending.source_session !== session.id || pending.source_digest !== source.digest
      || pending.read_digest !== readDigest || pending.action_name !== draft.authority.name || pending.action_digest !== draft.digest
      || !pending.action_subject || canonicalJsonDigest(pending.action_subject) !== canonicalJsonDigest(subject.identity)))) {
      return refuse("The pending review is not bound to this exact current source and disabled subject.");
    }
    const configPaths = [path.resolve(input.baseConfigPath ?? path.join(projectRoot, "synapsor.runner.json")),
      path.resolve(input.outputConfigPath ?? path.join(projectRoot, "synapsor.actions.runner.json"))];
    const configurations = await Promise.all(configPaths.map(async file => {
      try { return { file, content_digest: canonicalJsonDigest(await fs.readFile(file, "utf8")) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, content_digest: null }; throw error; }
    }));
    const context = canonicalJsonDigest({ configurations, baseline, active, draft, selected, activeReads, subject, resume: resume.value, session, readDigest });
    if (input.expected_context_digest && input.expected_context_digest !== context) return refuse("The reviewed source, target, authority or evidence changed after confirmation.");
    if (canonicalJsonDigest(baseline) !== canonicalJsonDigest(await readActionRuleAuthorityRevisionBaseline(projectRoot, permit))) {
      return refuse("Authority changed during the withdrawal assessment.");
    }
    return { kind: "withdrawal", from_digest: active.digest, removed_outcomes: removed,
      business_review_completed: false, review_context_digest: context,
      pending_source_ranges: session.coverage.passages.filter(p => ["needs_decision", "conflict", "unsupported"].includes(p.disposition))
        .map(p => ({ start: p.start, end: p.end })) } satisfies ActionWithdrawalReview;
  }, { permit: input.permit });
  return input.permit ? run(input.projectRoot) : withProjectRuntimeAdmission(input.projectRoot, run);
}
