import { isPreparedProgramRemoval } from "./authoring-program-completion.js";
import { authoringReceiptConfiguration } from "./authoring-receipt-configuration.js";
import { deferredReviewObligation } from "./authoring-obligation-review.js";
import { boundaryAuthoringVersionReviews } from "./boundary-authoring-resume.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { countingConfigurationDigest, countingSourceRequirements } from "./authoring-counting-requirements.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { listActionRuleAuthorityDrafts } from "./action-rule-authority.js";
import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { withCountingOutcomeDomain } from "./authoring-counting-domain.js";
import { clientDutyInventory } from "./authoring-client-duties.js";

/** Rechecks saved policy status against the exact current dependencies. Never
 * replaces guided coverage production, exact authority consent or runtime admission. */
export async function savedAuthoringPolicyReview(input: {
  projectRoot: string; binding: BoundaryAuthoringResumeBinding; readDigest: string;
  exactActionDraft?: import("./action-rule-authority.js").ActionRuleAuthorityDraftV1;
  env?: NodeJS.ProcessEnv;
  /** Only supplied under an existing runtime-admission -> mutation scope. */
  permit?: import("./project-authority-mutation.js").ProjectAuthorityMutationPermit;
}): Promise<ReturnType<typeof policyReviewReadiness> | undefined> {
  const pending = (message: string) => ({ ready: false, privacy: false, summary: [message,
    "Resume the saved job to recheck its policy and pending work. Active authority is unchanged."] });
  const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, input.binding);
  if (loaded.status === "none") return undefined;
  if (loaded.status === "invalid") return pending("The saved job needs recovery before its review can continue.");
  const saved = loaded.value;
  if (!saved.policy_source_session) return undefined;
  if (loaded.status !== "ready") return pending("The saved policy review belongs to older database or access metadata.");
  try {
    const session = await loadPolicySources(input.projectRoot, saved.policy_source_session);
    const source = activePolicySource(session);
    if (!source) return undefined;
    const drafts = input.exactActionDraft ? [input.exactActionDraft] : await listActionRuleAuthorityDrafts(input.projectRoot);
    const authorityDigests = (drafts.length ? drafts.map(draft => draft.digest) : [null])
      .map(action => canonicalJsonDigest({ read: input.readDigest, action }));
    if (!session.coverage || session.coverage.source_digest !== source.digest
      || !session.coverage_authority_digest || !authorityDigests.some(digest => digest === session.coverage_authority_digest)) {
      return pending("Attached rules need a current interpretation check for this saved revision.");
    }
    const matchingAuthority = drafts.find(draft => canonicalJsonDigest({ read: input.readDigest, action: draft.digest }) === session.coverage_authority_digest);
    const countingActions = matchingAuthority ? matchingAuthority.authority.rules.map(action => actionRuleModelDraftFromAuthority({
      authority: matchingAuthority.authority, outcome: action.rule.outcome,
      review: matchingAuthority.reviews.find(r => r.outcome === action.rule.outcome)!, preserveVerificationFields: true })) : [];
    const clientDuties = clientDutyInventory({ actions: countingActions, runner_evidence: { runtime_contract: {
      client_contract: { mode: "interactive_four_tool", client: saved.intended_client ?? "unselected" },
    } } });
    if (!session.coverage.client_duties || canonicalJsonDigest(session.coverage.client_duties) !== canonicalJsonDigest(clientDuties)) {
      return pending("Client responsibilities need current contract and ownership review. Previous assignments remain unverified history.");
    }
    const inventory = countingActions.flatMap(action => action.approval.shared_limits.flatMap((limit, index) =>
      limit.kind === "count" ? [{ path: `/runner_evidence/actions/${action.outcome}/automatic_limits/${index}/history_selector/capability`, digest: countingConfigurationDigest(limit) }] : []));
    if (inventory.length && (session.coverage.counting_inventory?.version !== 1
      || session.coverage.counting_inventory.digest !== canonicalJsonDigest(inventory))) {
      return pending("Counting coverage lacks a current positive requirement inventory. Recheck the saved interpretation; historical authority is unchanged.");
    }
    const requirements = countingSourceRequirements(source, { actions: countingActions, runner_evidence: {
      counting_decisions: session.counting_decisions ?? [],
      actions: Object.fromEntries(countingActions.map(action => [action.outcome, { automatic_limits: action.approval.shared_limits }])) } }, session.operator_messages ?? []);
    if (requirements.some(r => r.state !== "established" || !session.coverage!.passages.some(p => p.disposition === "implemented"
      && (p.counting_requirement_bindings?.some(b => b.path === r.path && b.state === "established" && b.required_capability === r.required_capability)
        || p.counting_resolution?.comparisons.some(c => c.path === r.path && c.required_capability === r.required_capability))))) {
      return pending("Counting requirements lack applicable positive support. Recheck this review; no authority or history changed.");
    }
    const domains = session.coverage.passages.flatMap(passage => [
      ...(passage.counting_resolution ? [passage.counting_resolution.domain] : []),
      ...(passage.counting_components?.map(component => component.resolution.domain) ?? []),
    ]);
    if (domains.length) {
      const matching = drafts.filter(draft => canonicalJsonDigest({ read: input.readDigest, action: draft.digest }) === session.coverage_authority_digest);
      if (matching.length !== 1 || !await withCountingOutcomeDomain(input.projectRoot, matching[0]!, async current =>
        domains.every(domain => canonicalJsonDigest(domain) === canonicalJsonDigest(current)), input.env, input.permit)) {
        return pending("The saved counting comparison needs revalidation against current authority and retained history. Its former domain condition is not current review evidence.");
      }
    }
    const obligations = session.coverage.passages.filter(p => p.obligation_assessment);
    if (obligations.some(p => !deferredReviewObligation(p) || p.obligation_assessment!.source_digest !== source.digest)) {
      return pending("The saved obligation phase evidence needs current validation.");
    }
    const receipts = obligations.filter(p => p.obligation_assessment!.family === "receipt_setup");
    if (receipts.length) {
      const current = await authoringReceiptConfiguration(input.projectRoot, matchingAuthority?.authority.rules.map(r => r.rule.source) ?? [], input.env);
      if (current.status === "unavailable" || receipts.some(p => p.obligation_assessment!.configuration_digest !== current.digest)) {
        return pending("Receipt configuration changed or is unavailable. Recheck its setup obligation; no receipt or execution was verified.");
      }
    }
    const ownerReviews = boundaryAuthoringVersionReviews(saved);
    if (obligations.some(p => p.obligation_assessment!.family === "source_counter_maintenance"
      && !ownerReviews.some(r => r.proof_digest === p.source_counter_resolution?.proof_digest))) {
      return pending("The source-owner counter commitment changed. Recheck its current obligation; external writers remain unverified.");
    }
    const review = policyReviewReadiness(source, session.coverage, session);
    if (saved.pending_policy_review || saved.pending_job_revision || saved.pending_read_revision || saved.pending_action_revision
      || (saved.pending_action_removal && !isPreparedProgramRemoval(saved, input.exactActionDraft)) || saved.pending_action_addition
      || !["authority_review", "client_setup"].includes(saved.stage)) {
      return { ...review, ready: false, summary: ["A saved edit or unfinished drafting step is still pending.", ...review.summary] };
    }
    return { ...review, summary: [...review.summary,
      "This is the saved policy interpretation, not a live check or activation. Exact authority and execution reviews remain separate."] };
  } catch {
    return pending("The saved policy review is unavailable; the policy and draft have not been changed.");
  }
}
