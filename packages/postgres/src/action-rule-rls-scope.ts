import { actionRuleRelationshipPairs, type CompiledRuleBindingV1 } from "@synapsor-runner/action-rules";

/** A unique forward lookup is constrained by its authorized parent and its
 * own tenant predicate. Shared reference rows need not contain a principal.
 * This changes policy inspection only; both trusted session values stay bound. */
export function postgresActionRuleVerificationScope(
  binding: CompiledRuleBindingV1,
  source: { tenantSetting: string; principalSetting?: string },
): { tenantSetting: string; principalSetting?: string } {
  const scope = binding.verification.scope;
  const relationship = binding.relationship;
  const sharedLookup = binding.verification.source.kind === "relationship"
    && binding.verification.source.direction === "forward"
    && binding.verification.cardinality === "one"
    && scope.mode === "columns" && scope.tenant_field === binding.resource.tenant_key
    && scope.principal_field === undefined && binding.resource.principal_scope_key === undefined
    && relationship?.target_unique === true && relationship.to_resource === binding.resource.name
    && relationship.name === binding.verification.source.relationship
    && ["many_to_one", "one_to_one"].includes(relationship.cardinality)
    && actionRuleRelationshipPairs(relationship).some(pair => pair.target_field === scope.tenant_field);
  return { tenantSetting: source.tenantSetting,
    ...(!sharedLookup && source.principalSetting ? { principalSetting: source.principalSetting } : {}) };
}
