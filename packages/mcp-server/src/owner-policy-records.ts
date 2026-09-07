import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { ownerPolicyDefinitionSchema, ownerPolicyParentSchema } from "./owner-policy-language.js";
import { policyManagerGrantSchema, policyOwnerScopeSchema } from "./policy-management-identity.js";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
const id = z.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const runtimeBinding = z.object({
  agent: name, delegator: id, owner: policyOwnerScopeSchema,
  policies: z.array(z.object({ scope: policyOwnerScopeSchema, name }).strict()).min(1).max(8),
  expires_at: z.string().datetime().optional(),
}).strict();

export function sameOwnerScope(a: ControlPolicyScope, b: ControlPolicyScope): boolean {
  return canonicalJsonDigest(a) === canonicalJsonDigest(b);
}

export const policyManagementParentSchema = z.object({
  schema_version: z.literal("synapsor.policy-management-parent.v1"),
  managers: z.array(policyManagerGrantSchema).max(256),
  delegation: ownerPolicyParentSchema,
  agent_owners: z.array(z.object({ agent: name, scope: policyOwnerScopeSchema }).strict()).min(1).max(256),
  // No binding means no delegated runtime authority. Each selected layer is
  // mandatory; revocation never silently reverts to an unrestricted default.
  runtime_delegations: z.array(runtimeBinding).max(256).optional(),
}).strict().superRefine((parent, context) => {
  const identities = new Set<string>();
  for (const binding of parent.runtime_delegations ?? []) {
    const identity = canonicalJsonDigest({ agent: binding.agent, delegator: binding.delegator, owner: binding.owner });
    if (identities.has(identity) || binding.owner.level === "operator" || !parent.delegation.agents.includes(binding.agent)) {
      context.addIssue({ code: "custom", message: "Invalid or duplicate runtime delegation" });
    }
    identities.add(identity);
    const keys = new Set<string>();
    for (const policy of binding.policies) {
      const scope = policy.scope, owner = binding.owner, key = canonicalJsonDigest(policy);
      const ancestor = scope.level === "tenant" && owner.level !== "operator" && scope.tenant_id === owner.tenant_id;
      if (keys.has(key) || scope.level === "operator" || (!ancestor && !sameOwnerScope(scope, owner))
          || !parent.agent_owners.some((entry) => entry.agent === binding.agent && sameOwnerScope(entry.scope, scope))) {
        context.addIssue({ code: "custom", message: "Runtime policy must be a unique authorized owner or tenant ancestor" });
      }
      keys.add(key);
    }
  }
});
export type PolicyManagementParent = z.infer<typeof policyManagementParentSchema>;
export type OwnerRuntimeBinding = z.infer<typeof runtimeBinding>;

export const managedDelegationSchema = z.object({
  schema_version: z.literal("synapsor.managed-owner-policy.v1"),
  parent_revision_id: z.string().min(1).max(256), parent_authority_digest: digest,
  parent_name: name, definition: ownerPolicyDefinitionSchema, compiled_digest: digest,
}).strict();
export type ManagedDelegation = z.infer<typeof managedDelegationSchema>;

export function delegationForOwner(parent: PolicyManagementParent, scope: ControlPolicyScope) {
  const owners = parent.agent_owners.filter((owner) => sameOwnerScope(owner.scope, scope));
  return { ...parent.delegation, agents: parent.delegation.agents.filter((agent) => owners.some((owner) => owner.agent === agent)) };
}
