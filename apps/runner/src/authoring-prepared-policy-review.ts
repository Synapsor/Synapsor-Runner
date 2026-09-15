import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
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
  authority?: ActionRuleAuthorityDraftV1;
  countingDomain?: CountingOutcomeDomain;
  clarifications: unknown[];
  assertCurrent: (permit?: ProjectAuthorityMutationPermit) => Promise<void>;
  progress?: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  state: PreparedPolicyReviewState;
  force?: boolean;
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
  const produce = () => reviewPolicyCoverage({ session: input.modelSession, source, draft: draftRecord,
    ...(sources.coverage?.source_digest === source.digest ? { previousReport: sources.coverage } : {}) });
  const report = reused ?? await (input.progress ? input.progress("Checking attached rules against this exact draft", produce) : produce());
  const staged = structuredClone(sources);
  bindPolicyCoverage(staged, report, input.authorityDigest);
  staged.coverage_context_digest = key;
  // Reuse has the same source/authority/history serialization as a new review.
  // Provider calls occur above, outside this coordinated section.
  await coordinated(async permit => {
    await assertCurrent(permit);
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
