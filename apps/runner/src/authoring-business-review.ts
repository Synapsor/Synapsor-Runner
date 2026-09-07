import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";

export function automaticApprovalBusinessSummary(compiled: { approval_class: Pick<CompiledActionRuleModelDraftV1["approval_class"], "shared_limits"> }, read: ExplorationBoundaryDraft): string {
  // Name the business scope only when the reviewed tenant binding selects that
  // resource's primary identity. Similar-looking column names are not proof.
  const roots = read.pack.resources.filter((resource) => !resource.shared_reference_scope
    && resource.tenant_key && resource.tenant_key === resource.primary_key);
  const root = roots.length === 1 ? roots[0] : undefined;
  const scope = root ? (root.field_metadata?.[root.primary_key]?.label ?? root.label
    ?? root.table.replaceAll("_", " ")).replace(/(?<!s)s$/u, "").toLowerCase() : "trusted group";
  const windows = new Map<number, string[]>();
  const limits = [...compiled.approval_class.shared_limits].sort((a, b) =>
    Number(!["boundary", "capability"].includes(a.scope)) - Number(!["boundary", "capability"].includes(b.scope)));
  for (const limit of limits) {
    const area = ({ boundary: "across this action bundle", capability: "for this outcome overall", tenant: `per ${scope}`,
      tenant_principal: `per signed-in user within the ${scope}`, tenant_object: `per selected record within the ${scope}` })[limit.scope];
    const quantity = limit.kind === "count" ? `${limit.maximum} approvals` : `${limit.maximum} total ${limit.field ?? "reviewed value"}`;
    const items = windows.get(limit.window_seconds) ?? [];
    items.push(`${quantity} ${area}`); windows.set(limit.window_seconds, items);
  }
  return [...windows].map(([seconds, items]) => {
    const period = seconds % 3600 === 0 ? `${seconds / 3600} hours` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
    return `Up to ${items.join(" and ")} in any rolling ${period}`;
  }).join("; ");
}
