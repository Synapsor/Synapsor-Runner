import type { ActionRuleBooleanExpressionV1, ActionRuleScalarExpressionV1 } from "@synapsor/spec";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";

/** Typed projection of compiled effects and approval. Formatting cannot select or remove checks. */
export function semanticActionBusinessReviewView(input: {
  compiled: CompiledActionRuleModelDraftV1; read: ExplorationBoundaryDraft;
  scalar(expression: ActionRuleScalarExpressionV1, fields?: ReadonlyMap<string, string>): string;
  boolean(expression: ActionRuleBooleanExpressionV1, fields?: ReadonlyMap<string, string>): string;
  unconditional(expression: ActionRuleBooleanExpressionV1): boolean;
  approval(compiled: CompiledActionRuleModelDraftV1, read: ExplorationBoundaryDraft): string;
}): { change: string; checks: string[]; completion: string } {
  const { compiled, read } = input;
  const actionRuleScalarSummary = input.scalar, actionRuleBooleanSummary = input.boolean;
  const actionRuleBooleanIsUnconditional = input.unconditional, automaticApprovalBusinessSummary = input.approval;
  const words = (value: string) => value.replaceAll("_", " ");
  const resources = new Map(read.pack.resources.map((resource) => [resource.id, resource]));
  const fieldNames = new Map<string, string>();
  for (const binding of compiled.verification_boundary.resources) {
    const resource = resources.get(binding.resource);
    for (const field of binding.fields) fieldNames.set(`${binding.binding}.${field.name}`,
      `${resource?.label ?? words(binding.binding)} ${resource?.field_metadata?.[field.name]?.label ?? words(field.name)}`);
  }
  const target = resources.get(compiled.rule.effect.target_resource);
  const targetBinding = compiled.verification_boundary.resources.find((entry) => entry.binding === compiled.effect_envelope.target_binding);
  let selectedBinding = targetBinding;
  const visited = new Set<string>();
  while (selectedBinding?.source.kind === "relationship" && !visited.has(selectedBinding.binding)) {
    visited.add(selectedBinding.binding);
    const fromBinding = selectedBinding.source.from_binding;
    selectedBinding = compiled.verification_boundary.resources.find((entry) => entry.binding === fromBinding);
  }
  const selectedName = selectedBinding && (resources.get(selectedBinding.resource)?.label ?? words(selectedBinding.binding));
  const changed = Object.entries(compiled.rule.effect.set).map(([field, value]) =>
    `${target?.field_metadata?.[field]?.label ?? words(field)} becomes ${actionRuleScalarSummary(value, fieldNames)}`);
  const expressions = Object.values(compiled.rule.effect.set);
  const sourceBindings = [...new Set(expressions.flatMap((value) => value.kind === "field" ? [value.binding] : []))];
  const sourceNames = sourceBindings.map((binding) => {
    const resource = compiled.verification_boundary.resources.find((entry) => entry.binding === binding)?.resource;
    return (resource && resources.get(resource)?.label) || words(binding);
  });
  const effect = sourceNames.length && expressions.every((value) => value.kind === "field")
    ? `terms come from verified ${sourceNames.join(" and ")} records`
    : changed.join("; ");
  const policy = compiled.approval_class;
  const automatic = policy.rules.find((rule) => rule.outcome === compiled.rule.outcome)?.auto_approve_when;
  const reviewers = `${policy.required_approvals} ${policy.required_approvals > 1 ? "distinct " : ""}${words(policy.required_role)} approval${policy.required_approvals === 1 ? "" : "s"}`;
  return {
    change: `${compiled.draft.discovery?.title ?? words(compiled.rule.outcome.split(".").at(-1)!)}. ${compiled.rule.effect.operation === "insert" ? "Create" : "Update"} one ${target?.label ?? words(target?.table ?? compiled.rule.effect.target_resource)} record; ${effect}.`,
    checks: [
    ...(compiled.rule.atomic_updates ? [
      ...compiled.rule.atomic_updates.map((effect) => {
        const related = resources.get(effect.target_resource);
        return `Also changes: ${related?.label ?? words(effect.target_resource.split(".").at(-1)!)} - ${Object.entries(effect.set).map(([field, value]) =>
          `${related?.field_metadata?.[field]?.label ?? words(field)} becomes ${actionRuleScalarSummary(value, fieldNames)}`).join("; ")}.`;
      }),
      "Saved together: every record is checked for intervening changes. All updates succeed in one transaction, or none are saved.",
    ] : []),
    ...(compiled.rule.effect.operation === "update" && selectedBinding?.source.kind === "subject_ref"
      ? [`Target: only ${targetBinding === selectedBinding ? `the selected ${selectedName} record` : `the record linked to the selected ${selectedName} through the reviewed relationship${visited.size > 1 ? "s" : ""}`}; Runner verifies that selection and its trusted scope before any change.`]
      : []),
    `Eligibility: ${actionRuleBooleanSummary(compiled.rule.require, fieldNames)}. Missing or failed eligibility checks are refused, not sent for human approval.`,
    ...(compiled.hard_limit_review ?? []),
    ...(compiled.hard_limit_review ? ["A hard-invariant violation is refused; human approval cannot override it."] : []),
    policy.mode === "policy" && automatic
      ? `Approval: automatic ${actionRuleBooleanIsUnconditional(automatic) ? "for valid requests" : `only when ${actionRuleBooleanSummary(automatic, fieldNames)}`}; other valid requests, including ${compiled.hard_limit_review ? "automatic-approval budget overruns" : "limit overruns"}, require ${reviewers}.`
      : `Approval: every valid request requires ${reviewers}.`,
    ...(policy.mode === "policy" ? [`Approval limits: ${automaticApprovalBusinessSummary(compiled, read)}.`] : []),
    ],
    completion: `${compiled.effect_envelope.writeback.mode === "none" ? "proposal only; automatic execution is not configured" : "automatic execution is prepared for separate review, not enabled by this Read decision"}.`,
  };
}
