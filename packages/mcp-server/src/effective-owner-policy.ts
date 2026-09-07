import type { ActionRuleFactSetV1, CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyKey, ControlPolicyRepository, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { assertBoundedOwnerPolicyInput } from "./owner-policy-language.js";
import { compileOwnerPolicy, evaluateOwnerPolicy, type CompiledOwnerPolicy } from "./owner-policy-compiler.js";
import { delegationForOwner, managedDelegationSchema, policyManagementParentSchema } from "./owner-policy-records.js";
import { OwnerRuntimeError, ownerRuntimeIdentitySchema, type OwnerRuntimeAuthenticator, type OwnerRuntimeIdentity } from "./owner-runtime-identity.js";

export type EffectiveOwnerPolicy = {
  deployment_id: string;
  epoch: number;
  digest: string;
  actor: OwnerRuntimeIdentity;
  allowed_outcomes: string[];
  layers: Array<{ key: ControlPolicyKey; revision_id: string; policy: CompiledOwnerPolicy }>;
};

/** Internal current-authority resolver. No request body supplies owner keys or
 * parent policies. All applicable layers are operator-selected and conjunctive.
 * This is not an execution permit: dispatch must recheck current authority. */
export function createEffectiveOwnerPolicyResolver(options: {
  repository: ControlPolicyRepository; deployment_id: string; parent_name: string;
  authenticate: OwnerRuntimeAuthenticator; resolveRules: () => Promise<CompiledActionRuleV1[]>;
}) {
  const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: options.parent_name };
  function parseParent(revision: ControlPolicyRevision | undefined, actor: OwnerRuntimeIdentity) {
    if (!revision) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
    assertBoundedOwnerPolicyInput(revision.content);
    const parsed = policyManagementParentSchema.safeParse(revision.content);
    if (!parsed.success) throw new OwnerRuntimeError("DELEGATION_CONFIGURATION_INVALID");
    if (actor.expires_at_ms <= Date.now()) throw new OwnerRuntimeError("DELEGATION_AUTHENTICATION_FAILED");
    const matches = (parsed.data.runtime_delegations ?? []).filter((entry) => entry.agent === actor.agent_id && entry.delegator === actor.delegator
      && entry.owner.level !== "operator" && entry.owner.tenant_id === actor.tenant_id
      && (entry.owner.level === "tenant" || entry.owner.principal === actor.principal));
    // A tenant-wide binding plus a matching personal binding is ambiguous;
    // never choose the more permissive one by ordering or silent precedence.
    if (matches.length !== 1 || (matches[0]!.expires_at && Date.parse(matches[0]!.expires_at) <= Date.now())) {
      throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
    }
    return { revision, document: parsed.data, binding: matches[0]! };
  }
  const stamp = (revision: ControlPolicyRevision | undefined) => revision
    ? { revision_id: revision.revision_id, content_digest: revision.content_digest, authority_digest: revision.authority_digest } : null;
  async function resolve(credential: string): Promise<EffectiveOwnerPolicy> {
    const actor = ownerRuntimeIdentitySchema.parse(await options.authenticate(credential));
    const initial = await options.repository.snapshot(options.deployment_id, [parentKey]);
    const parent = parseParent(initial.policies[0]?.active, actor);
    const keys: ControlPolicyKey[] = parent.binding.policies.map((entry) => ({ ...entry, kind: "delegation" }));
    let currentParent: typeof parent | undefined;
    const snapshot = await options.repository.snapshot(options.deployment_id, keys, { keys: [parentKey], authorize(current) {
      currentParent = parseParent(current[0], actor);
      if (canonicalJsonDigest(stamp(currentParent.revision)) !== canonicalJsonDigest(stamp(parent.revision))) {
        throw new OwnerRuntimeError("DELEGATION_CHANGED");
      }
    } });
    if (!currentParent) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
    const rules = await options.resolveRules();
    const layers = snapshot.policies.map((entry, index) => {
      const revision = entry.active, key = keys[index]!;
      if (!revision) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
      assertBoundedOwnerPolicyInput(revision.content);
      const parsed = managedDelegationSchema.safeParse(revision.content);
      if (!parsed.success) throw new OwnerRuntimeError("DELEGATION_CONFIGURATION_INVALID");
      const document = parsed.data;
      if (document.parent_name !== parentKey.name || document.parent_revision_id !== parent.revision.revision_id
          || document.parent_authority_digest !== parent.revision.authority_digest) throw new OwnerRuntimeError("DELEGATION_PARENT_CHANGED");
      const policy = compileOwnerPolicy({ parent: delegationForOwner(parent.document, key.scope), definition: document.definition, rules });
      if (policy.digest !== document.compiled_digest || revision.authority_digest !== policy.digest
          || !policy.definition.agents.includes(actor.agent_id)) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
      return { key, revision_id: revision.revision_id, policy };
    });
    // Compilation/rule loading may await I/O. Do not return a chain withdrawn
    // while those operations ran; do not mix two repository snapshots.
    const final = await options.repository.snapshot(options.deployment_id, [parentKey, ...keys], { keys: [parentKey], authorize(current) {
      const checked = parseParent(current[0], actor);
      if (canonicalJsonDigest(stamp(checked.revision)) !== canonicalJsonDigest(stamp(parent.revision))) throw new OwnerRuntimeError("DELEGATION_CHANGED");
    } });
    const expected = [stamp(parent.revision), ...snapshot.policies.map((entry) => stamp(entry.active))];
    if (canonicalJsonDigest(final.policies.map((entry) => stamp(entry.active))) !== canonicalJsonDigest(expected)) {
      throw new OwnerRuntimeError("DELEGATION_CHANGED");
    }
    if (actor.expires_at_ms <= Date.now()) throw new OwnerRuntimeError("DELEGATION_AUTHENTICATION_FAILED");
    const allowed = parent.document.delegation.outcomes.map((entry) => entry.outcome)
      .filter((outcome) => layers.every((layer) => layer.policy.rules.some((rule) => rule.outcome === outcome))).sort();
    const digest = canonicalJsonDigest({ deployment_id: options.deployment_id, actor: actor.actor_digest, chain: expected, keys });
    return { deployment_id: options.deployment_id, epoch: final.epoch, digest, actor, allowed_outcomes: allowed, layers };
  }
  return { resolve, async assertCurrent(credential: string, previous: Pick<EffectiveOwnerPolicy, "digest">) {
    const current = await resolve(credential);
    if (current.digest !== previous.digest) throw new OwnerRuntimeError("DELEGATION_CHANGED");
    return current;
  } };
}

export function evaluateEffectiveOwnerPolicy(input: { effective: EffectiveOwnerPolicy; compiled: CompiledActionRuleV1;
  facts: ActionRuleFactSetV1; inputs?: Record<string, unknown>; proposal_id: string }) {
  const actor = input.effective.actor;
  if (!input.effective.layers.length || !input.effective.allowed_outcomes.includes(input.compiled.outcome)
      || actor.expires_at_ms <= Date.now() || input.facts.trusted.tenant !== actor.tenant_id || input.facts.trusted.principal !== actor.principal) {
    return { result: "refused" as const, code: "DELEGATION_NOT_AVAILABLE" };
  }
  let approval: "inherit" | "human" = "inherit";
  for (const layer of input.effective.layers) {
    const result = evaluateOwnerPolicy({ ...input, policy: layer.policy, acting_agent: actor.agent_id });
    if (result.result !== "allowed") return result;
    if (result.approval === "human") approval = "human";
  }
  return { result: "allowed" as const, approval };
}
