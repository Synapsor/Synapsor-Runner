import { canonicalJsonDigest, type ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import { parseActionRequirementProposals, type ActionRequirementProposals } from "./authoring-action-requirements.js";
import { parseActionRuleModelDraftProposal, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { ActionRuleAuthoringError } from "./action-rule-authoring-error.js";

const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function refuse(): never {
  throw new ActionRuleAuthoringError("ACTION_RULE_REQUIREMENTS_UNMET",
    "ACTION_RULE_REQUIREMENTS_UNMET: Retain the exact count inventory, selected target and execution setting. Unsupported or missing meaning remains pending.",
    { presentation: "terminal", path: "requirement_proposals" });
}

/** Scoped proposal DATA check, never confirmation, native custody or permission.
 * Main must first authenticate the actual protected Question and original native
 * receipt, then compare the complete current AST/dependencies under the same Held
 * boundary after UI and at save. Existing compiler checks remain mandatory.
 * null means an actual new draft. Missing proposals never designate no duty.
 * Resource/suggestion policies, units and transitions require their own consumers;
 * mixed sets refuse here rather than partially accepting unhandled meaning. */
export function assertActionRuleCountExecutionProposalsPreserved(input: {
  proposals: ActionRequirementProposals;
  baseline: ActionRuleModelDraftV1 | null;
  candidate: ActionRuleModelDraftV1;
}): void {
  try {
    const proposals = parseActionRequirementProposals(input.proposals);
    const candidate = parseActionRuleModelDraftProposal(input.candidate);
    if (input.baseline === undefined || !equal(candidate.requirement_proposals, proposals)
      || !proposals.some(p => p.kind === "approval_count") || !proposals.some(p => p.kind === "execution")) refuse();
    const baseline = input.baseline === null ? null : parseActionRuleModelDraftProposal(input.baseline);
    if (baseline && baseline.outcome !== candidate.outcome) refuse();
    const previous = baseline === null ? [] : baseline.approval?.shared_limits;
    if (!Array.isArray(previous)) refuse();
    const expected: ActionBoundarySharedLimitV1[] = structuredClone(previous);
    for (const p of proposals) {
      if (p.value.state !== "proposed" || p.kind !== "approval_count" && p.kind !== "execution"
        || !("outcome" in p.target) || p.target.outcome !== candidate.outcome) refuse();
      if (p.kind === "execution") {
        if (p.value.state !== "proposed" || candidate.effect.writeback !== p.value.mode) refuse();
        continue;
      }
      if (p.kind !== "approval_count" || p.value.state !== "proposed" || p.target.slot !== "approval.shared_limits"
        || !equal(p.previous_limits, previous)) refuse();
      const index = expected.findIndex(l => l.id === p.target.limit_id);
      if (baseline && index < 0) refuse();
      const v = p.value;
      if (v.scope === "capability" && v.selector.kind === "all_outcomes") refuse();
      const limit: ActionBoundarySharedLimitV1 = { id: p.target.limit_id, kind: "count", scope: v.scope,
        maximum: v.maximum, window_seconds: v.window_seconds,
        ...(v.selector.kind === "outcome" ? { capability: v.selector.outcome } : {}) };
      if (p.intent === "retain" && (index < 0 || !equal(expected[index], limit))) refuse();
      if (index < 0) expected.push(limit); else expected[index] = limit;
    }
    if (!equal(candidate.approval.shared_limits, expected)) refuse();
  } catch (error) {
    if (error instanceof ActionRuleAuthoringError && error.code === "ACTION_RULE_REQUIREMENTS_UNMET") throw error;
    refuse();
  }
}
