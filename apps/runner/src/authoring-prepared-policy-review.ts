import { scopedDisclosureInventory } from "./authoring-scoped-disclosure.js";
import { randomUUID } from "node:crypto";
import type { CoverageReviewEpisode } from "./authoring-policy-source.js";
import { reviewClientDutyOwnership } from "./authoring-client-duties.js";
import { authoringReceiptConfiguration } from "./authoring-receipt-configuration.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityReviewSubjectV1 } from "./action-rule-authority.js";
import { withCountingOutcomeDomain, type CountingOutcomeDomain } from "./authoring-counting-domain.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { activePolicySource, authoringDestination, bindPolicyCoverage, loadPolicySources, policySourceSavedDigest, savePolicySources,
  type PolicyCoverage, type PolicySourceSession } from "./authoring-policy-source.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** One coverage producer/validator/persistence path for guided and review-only
 * operations. Preparing the candidate never authorizes an edit or activation. */
export type PreparedPolicyReviewState = {
  attemptKey?: string;
  report?: { key: string; report: PolicyCoverage };
  activity?: "provider" | "validated_reuse";
};

export async function ensurePreparedPolicyCoverage(input: {
  projectRoot: string;
  sources: PolicySourceSession;
  modelSession: Parameters<typeof reviewPolicyCoverage>[0]["session"];
  operatorSession: BoundaryReviewInteractiveSession;
  currentDraft: () => ReturnType<typeof policyCoverageDraft>;
  authorityDigest: string;
  authority?: ActionRuleAuthorityReviewSubjectV1;
  countingDomain?: CountingOutcomeDomain;
  clarifications: unknown[];
  assertCurrent: (permit?: ProjectAuthorityMutationPermit) => Promise<void>;
  progress?: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  state: PreparedPolicyReviewState;
  force?: boolean;
  subjectLocation?: "active" | "draft";
  requireCountingChoice?: boolean;
  onValidated?: (result: { report: PolicyCoverage; key: string; sources: PolicySourceSession; activity: "provider" | "validated_reuse" }, permit: ProjectAuthorityMutationPermit) => Promise<void>;
}) {
  const { sources, state } = input;
  const source = activePolicySource(sources);
  if (!source) throw new Error("POLICY_REVIEW_SOURCE_UNAVAILABLE: Select a complete saved source before reviewing this job.");
  if (!sources.approvals.some(a => a.digest === source.digest && a.destination === authoringDestination(input.modelSession))) {
    throw new Error("POLICY_REVIEW_SOURCE_CONSENT_REQUIRED: Review transfer of this exact source to the selected model before continuing.");
  }
  let expectedSource = await policySourceSavedDigest(input.projectRoot, sources.id);
  if (canonicalJsonDigest(await loadPolicySources(input.projectRoot, sources.id)) !== canonicalJsonDigest(sources)) {
    throw new Error("POLICY_SOURCE_CHANGED: The in-memory source is not the current saved source. Reopen its review before continuing.");
  }
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    await input.assertCurrent(permit);
    if (await policySourceSavedDigest(input.projectRoot, sources.id) !== expectedSource) {
      throw new Error("POLICY_SOURCE_CHANGED: The selected source or its decisions changed during review. Reopen the current saved review; no stale result was saved.");
    }
  };
  const coordinated = async (operation: (permit: ProjectAuthorityMutationPermit) => Promise<void>) => {
    if (input.countingDomain && input.authority) {
      await withCountingOutcomeDomain(input.projectRoot, input.authority, async (current, permit) => {
        if (canonicalJsonDigest(current) !== canonicalJsonDigest(input.countingDomain)) {
          throw new Error("POLICY_COUNTING_DOMAIN_CHANGED: Current authority or retained history changed during review. Recheck the saved rules; no selector changed.");
        }
        await operation(permit);
      });
    } else await withProjectAuthorityMutation(input.projectRoot, operation);
  };
  await assertCurrent();
  let draftRecord = input.currentDraft();
  // Unknown owner facts do not become a request for another model opinion.
  // Local inspection/deferral is available before provider consent/selection.
  if (scopedDisclosureInventory(source, draftRecord).items.some(f => f.state !== "confirmed_non_sensitive"))
    throw new Error("SCOPED_DISCLOSURE_REVIEW_PENDING: The source-required classification remains pending. Open the local source-required disclosure review; no provider call was made.");
  const decisions = await reviewUnestablishedCounting({ source, draft: draftRecord,
    messages: sources.operator_messages ?? [], session: input.operatorSession, assertCurrent });
  if (decisions === undefined && input.requireCountingChoice) throw new Error("POLICY_COUNTING_REVIEW_PENDING: The counting choice remains unresolved. Resume Review attached rules; no business rule changed.");
  if (decisions?.length) {
    const staged = structuredClone(sources);
    staged.counting_decisions = [...(staged.counting_decisions ?? []).filter(d => !decisions.some(n => n.path === d.path)), ...decisions];
    await coordinated(async permit => {
      await assertCurrent(permit);
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
      // Later coverage must compare against our own committed snapshot. Reading
      // "latest" after releasing the lock could adopt a competing writer's digest
      // while retaining this older in-memory source and overwrite that writer.
      expectedSource = canonicalJsonDigest(staged);
    });
    Object.assign(sources, staged);
    draftRecord = input.currentDraft();
  }
  const preparedDraftDigest = canonicalJsonDigest(draftRecord);
  const key = canonicalJsonDigest({ source: source.digest, draft: draftRecord, messages: sources.operator_messages ?? [],
    clarifications: input.clarifications, interpretations: sources.read_interpretations ?? [] });
  let reused: PolicyCoverage | undefined;
  if (!input.force && (state.attemptKey === key && state.report?.key === key
    || state.attemptKey === undefined && sources.coverage_context_digest === key && sources.coverage)) {
    try {
      reused = parsePolicyCoverage({ passages: (state.report?.key === key ? state.report.report : sources.coverage!).passages },
        source, draftRecord, sources.operator_messages ?? []);
    } catch { /* Revalidate incompatible evidence; never treat a ready flag as proof. */ }
  }
  if (!input.force && state.attemptKey === key && !reused) {
    return { source, key, draftRecord, report: undefined, activity: state.activity };
  }
  state.attemptKey = key;
  let episode: CoverageReviewEpisode;
  const saveEpisode = async (update: (e: CoverageReviewEpisode) => void) => {
    await coordinated(async permit => {
      await assertCurrent(permit);
      if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest)
        throw new Error("POLICY_COVERAGE_CONTEXT_CHANGED: Reopen current Review; no stale correction was sent.");
      const staged = structuredClone(sources);
      const current = staged.coverage_episodes!.find(e => e.id === episode.id)!;
      update(current);
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
      expectedSource = canonicalJsonDigest(staged);
      Object.assign(sources,staged); episode = current;
    });
  };
  const produce = async () => {
    const prior = sources.coverage_episodes?.filter(e=>e.context===key).at(-1);
    if (prior && !await input.operatorSession.confirm("Start a new bounded review episode?", {
      defaultValue: false,
      context: [`The previous episode reserved ${prior.submissions.length} response submissions. Its evidence and unresolved review remain saved. A new episode is separately recorded; it is not an uninterrupted retry or a business edit.`],
    })) throw new Error("POLICY_COVERAGE_EPISODE_PENDING: Prior attempts are preserved. Review remains pending; no structural retries were replenished.");
    if ((sources.coverage_episodes?.length ?? 0) >= 120) throw new Error("POLICY_COVERAGE_EPISODE_HISTORY_FULL: Prior attempts are preserved; no provider call was started.");
    episode = {id:randomUUID(), context:key, started_at:new Date().toISOString(),submissions:[]};
    await coordinated(async permit=>{
      await assertCurrent(permit);
      const staged={...sources,coverage_episodes:[...(sources.coverage_episodes??[]),episode]};
      await savePolicySources(input.projectRoot,staged,{expectedDigest:expectedSource,permit});
      expectedSource=canonicalJsonDigest(staged); Object.assign(sources,staged);
    });
    return reviewPolicyCoverage({session:input.modelSession,source,draft:draftRecord,
      ...(sources.coverage?.source_digest===source.digest?{previousReport:sources.coverage}:{}),
      episode:{beforeSubmission:async number=>saveEpisode(e=>{
        if(number!==e.submissions.length+1 || number>3) throw new Error("POLICY_COVERAGE_EPISODE_EXHAUSTED");
        e.submissions.push({number,reserved_at:new Date().toISOString()});
      }),afterSubmission:async(number,feedback,accepted)=>saveEpisode(e=>{
        const submission=e.submissions[number-1]!;
        submission.completed_at=new Date().toISOString(); submission.validated=accepted;
        if(feedback) submission.diagnostic=JSON.stringify(feedback);
      })}});
  };
  const report = reused ?? await (input.progress ? input.progress(input.subjectLocation === "active" ? "Checking attached rules against this active published subject" : "Checking attached rules against this exact draft", produce) : produce());
  const staged = structuredClone(sources);
  bindPolicyCoverage(staged, report, input.authorityDigest);
  staged.coverage_context_digest = key;
  const assignments = await reviewClientDutyOwnership({ report, sources: staged, session: input.operatorSession, assertCurrent });
  if (assignments.length) {
    if ((staged.application_assignments?.length ?? 0) + assignments.length > 120)
      throw new Error("POLICY_CLIENT_ASSIGNMENT_HISTORY_FULL: Existing ownership history is preserved. No new acceptance was saved.");
    staged.application_assignments = [...(staged.application_assignments ?? []), ...assignments];
  }
  // Reuse has the same source/authority/history serialization as a new review.
  // Provider calls occur above, outside this coordinated section.
  await coordinated(async permit => {
    await assertCurrent(permit);
    if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest) {
      throw new Error("POLICY_CLIENT_CONTRACT_CHANGED: The prepared candidate or client contract changed during review. Reopen current Review; no stale ownership was saved.");
    }
    const capturedConfiguration = draftRecord.runner_evidence.runtime_contract.receipt_configuration;
    if (capturedConfiguration && canonicalJsonDigest(capturedConfiguration) !== canonicalJsonDigest(await authoringReceiptConfiguration(
      input.projectRoot, input.authority?.authority.rules.map(r => r.rule.source) ?? []))) {
      throw new Error("OBLIGATION_CONFIGURATION_CHANGED: Receipt configuration changed during review. Reopen current Review; no stale result was saved.");
    }
    if (canonicalJsonDigest(staged) !== canonicalJsonDigest(sources)) {
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
    }
    await input.onValidated?.({ report, key, sources: staged, activity: reused ? "validated_reuse" : "provider" }, permit);
  });
  Object.assign(sources, staged);
  state.report = { key, report };
  state.activity = reused ? "validated_reuse" : "provider";
  return { source, key, draftRecord, report, activity: state.activity };
}
