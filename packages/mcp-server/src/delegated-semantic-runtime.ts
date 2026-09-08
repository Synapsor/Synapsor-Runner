import { z } from "zod";
import type { CompiledActionRuleV1, SemanticProposalDelegationCheck, SemanticExecutionDelegationCheck } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest, delegationProofV1Schema, type DelegationProofV1, type NormalizedWritebackJobV5, type SemanticAuthorityV1 } from "@synapsor-runner/protocol";
import type { ControlPolicyRepository, ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { createEffectiveOwnerPolicyResolver, evaluateEffectiveOwnerPolicy, type EffectiveOwnerPolicy } from "./effective-owner-policy.js";
import { OwnerRuntimeError, ownerRuntimeIdentitySchema, type OwnerRuntimeAuthenticator } from "./owner-runtime-identity.js";
import { effectiveOwnerBudgetCharges } from "./effective-owner-budgets.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const attestationSchema = z.object({
  schema_version: z.literal("synapsor.delegated-proposal-context.v1"),
  deployment_id: z.string().min(1).max(256), parent_name: z.string().min(1).max(128), proposal_id: z.string().min(1).max(256),
  actor: ownerRuntimeIdentitySchema, chain_digest: digest, compiled_plan_digest: digest, effect_digest: digest,
  inputs_digest: digest, approval: z.enum(["inherit", "human"]), valid_until: z.string().datetime(),
}).strict();
type Attestation = z.infer<typeof attestationSchema>;
type RuntimeOptions = { repository: ControlPolicyRepository; deployment_id: string; parent_name: string;
  resolveRules: () => Promise<CompiledActionRuleV1[]> };
export type DelegatedRequestContext = {
  trusted_context: { tenant_id: string; principal: string };
  authorization: { scope_key: string; revision: string; allowed_outcomes: string[] };
  assertCurrent(): Promise<void>;
  workflowSessionId(session: string): string;
  checkProposal: SemanticProposalDelegationCheck;
  checkExisting(proposal_id: string, authority: SemanticAuthorityV1): Promise<void>;
};
const ownerScope = (actor: Attestation["actor"]): ControlPolicyScope => ({ level: "principal", tenant_id: actor.tenant_id, principal: actor.principal });

/** Trusted composition API, never a model-callable handler. The authenticator
 * verifies a workload on every request. Persist only verified claims, not its
 * bearer credential, source rows, or a caller-selected control-store location. */
export function createDelegatedSemanticRuntime(options: RuntimeOptions & { authenticate: OwnerRuntimeAuthenticator }) {
  const resolver = createEffectiveOwnerPolicyResolver(options);
  return { async begin(credential: string): Promise<DelegatedRequestContext> {
    const initial = await resolver.resolve(credential);
    const current = () => resolver.assertCurrent(credential, initial);
    return {
      trusted_context: { tenant_id: initial.actor.tenant_id, principal: initial.actor.principal },
      assertCurrent: async () => { await current(); },
      authorization: { scope_key: initial.actor.actor_digest, revision: initial.digest, allowed_outcomes: [...initial.allowed_outcomes] },
      workflowSessionId(session) { return canonicalJsonDigest({ session, actor: initial.actor.actor_digest, policy: initial.digest }); },
      async checkProposal(input) {
        const effective = await current();
        const decision = evaluateEffectiveOwnerPolicy({ effective, compiled: input.activated.compiled,
          facts: input.facts, inputs: input.inputs, proposal_id: input.proposal_id });
        if (decision.result !== "allowed") throw new OwnerRuntimeError("DELEGATION_REQUEST_REFUSED");
        effectiveOwnerBudgetCharges(effective, input.activated.compiled.outcome, input.evaluation.effect);
        const validUntil = Math.min(effective.valid_until_ms, Date.parse(input.verified_at) + input.activated.compiled.ttl_seconds * 1000,
          Date.parse(input.verified_at) + 900_000);
        const content = attestationSchema.parse({ schema_version: "synapsor.delegated-proposal-context.v1",
          deployment_id: options.deployment_id, parent_name: options.parent_name, proposal_id: input.proposal_id, actor: effective.actor,
          chain_digest: effective.digest, compiled_plan_digest: input.activated.compiled.compiled_plan_digest,
          effect_digest: input.evaluation.effect.effect_digest, inputs_digest: canonicalJsonDigest(input.inputs),
          approval: decision.approval, valid_until: new Date(validUntil).toISOString() });
        const proof = proofFor(content);
        await options.repository.runtimeProofs.register({ deployment_id: options.deployment_id, proposal_id: input.proposal_id,
          scope: ownerScope(effective.actor), content, content_digest: proof.binding_digest, expires_at_ms: validUntil, expected_epoch: effective.epoch });
        return { proof, approval: decision.approval };
      },
      async checkExisting(proposalId, authority) {
        const effective = await current();
        const record = await readAttestation(options, proposalId, authority, ownerScope(effective.actor));
        assertBinding(record, effective, authority);
      },
    };
  } };
}

/** An executor loads an immutable attestation from the SAME authoritative
 * repository, then resolves today's parent/owner chain. This is not a login
 * using caller claims: only the trusted proposal service wrote this record.
 * One-use dispatch is additional to, never a substitute for, ordinary approval,
 * source freshness, exact-effect checks and the source executor's receipt. */
export function createDelegatedSemanticExecutor(options: RuntimeOptions) {
  return { forJob(job: NormalizedWritebackJobV5, sourceScope?: { mode: "postgres_rls"; tenantId: string; principal: string }) {
    // Capture an immutable execution attempt. A caller cannot swap the target
    // between re-verification and receipt accounting.
    const original = structuredClone(job), jobDigest = canonicalJsonDigest(original), scope = structuredClone(sourceScope);
    let dispatchId: string | undefined;
    async function current() {
      // RLS can enforce an owner without a physical principal column. Only the
      // approved proposal's captured source transaction scope supplies that owner;
      // never discover it through an unscoped proof lookup or worker credentials.
      const tenant = original.target.tenant_guard?.value, physicalPrincipal = original.target.principal_scope?.value;
      if (scope !== undefined && (original.engine !== "postgres" || scope.mode !== "postgres_rls"
          || typeof scope.tenantId !== "string" || !scope.tenantId || typeof scope.principal !== "string" || !scope.principal
          || tenant !== scope.tenantId || (physicalPrincipal !== undefined && physicalPrincipal !== scope.principal))) {
        throw new OwnerRuntimeError("DELEGATION_SOURCE_SCOPE_UNSUPPORTED");
      }
      const principal = scope === undefined ? physicalPrincipal : scope.principal;
      if (typeof tenant !== "string" || typeof principal !== "string") throw new OwnerRuntimeError("DELEGATION_SOURCE_SCOPE_UNSUPPORTED");
      const record = await readAttestation(options, original.proposal_id, original.semantic_authority,
        { level: "principal", tenant_id: tenant, principal });
      const resolver = createEffectiveOwnerPolicyResolver({ ...options, authenticate: async () => structuredClone(record.actor) });
      const effective = await resolver.resolve("");
      assertBinding(record, effective, original.semantic_authority);
      return { record, effective };
    }
    const check: SemanticExecutionDelegationCheck = async (input) => {
      if (canonicalJsonDigest(input.job) !== jobDigest) throw new OwnerRuntimeError("DELEGATION_JOB_CHANGED");
      const { effective, record } = await current();
      // Supply the RLS identity only to owner evaluation, without changing
      // general Action facts, source dependency digests or an existing principal.
      const facts = scope !== undefined && input.facts.trusted.principal === undefined
        ? { ...input.facts, trusted: { ...input.facts.trusted, principal: scope.principal } } : input.facts;
      const decision = evaluateEffectiveOwnerPolicy({ effective, compiled: input.activated.compiled,
        facts, inputs: input.inputs, proposal_id: original.proposal_id });
      if (decision.result !== "allowed" || input.evaluation.effect.effect_digest !== record.effect_digest
          || (decision.approval === "human" && original.semantic_authority.proof.approval_path !== "human_review")) {
        throw new OwnerRuntimeError("DELEGATION_REQUEST_REFUSED");
      }
      const target = { deployment_id: options.deployment_id, request_id: original.proposal_id, expected_epoch: effective.epoch,
        actor_digest: effective.actor.actor_digest, policy_chain_digest: effective.digest, effect_digest: record.effect_digest };
      const accounts = effectiveOwnerBudgetCharges(effective, input.activated.compiled.outcome, input.evaluation.effect);
      const prepared = await options.repository.effects.prepare({ ...target, expires_at_ms: Date.parse(record.valid_until),
        ...(accounts.length ? { budget_accounts: accounts } : {}) });
      if (!prepared.nonce) throw new OwnerRuntimeError("DELEGATION_EFFECT_RECONCILIATION_REQUIRED");
      const admitted = await options.repository.effects.dispatch({ ...target, nonce: prepared.nonce });
      if (admitted.status !== "authorized") throw new OwnerRuntimeError("DELEGATION_EFFECT_RECONCILIATION_REQUIRED");
      dispatchId = admitted.dispatch_id;
    };
    return { check, wasDispatched: () => dispatchId !== undefined, assertCurrent: async () => { await current(); },
      async record(input: { state: "completed" | "no_effect" | "unknown"; receipt_digest: string }) {
        if (!dispatchId) {
          const proof = original.semantic_authority.proof.delegation;
          if (!proof) throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
          const admission = await options.repository.effects.inspect({ deployment_id: options.deployment_id, request_id: original.proposal_id,
            actor_digest: proof.actor_digest, policy_chain_digest: proof.policy_chain_digest, effect_digest: original.semantic_authority.effect.effect_digest });
          if (admission.state === "prepared") throw new OwnerRuntimeError("DELEGATION_EFFECT_NOT_ADMITTED");
          dispatchId = admission.dispatch_id;
        }
        return options.repository.effects.record({ deployment_id: options.deployment_id, request_id: original.proposal_id,
          dispatch_id: dispatchId, effect_digest: original.semantic_authority.effect.effect_digest, ...input });
      },
    };
  } };
}

function proofFor(record: Attestation): DelegationProofV1 {
  return delegationProofV1Schema.parse({ schema_version: "synapsor.delegation-proof.v1", binding_digest: canonicalJsonDigest(record),
    policy_chain_digest: record.chain_digest, actor_digest: record.actor.actor_digest, valid_until: record.valid_until });
}
async function readAttestation(options: RuntimeOptions, proposalId: string, authority: SemanticAuthorityV1, scope: ControlPolicyScope): Promise<Attestation> {
  const proof = authority.proof.delegation;
  if (!proof) throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
  const stored = await options.repository.runtimeProofs.get({ deployment_id: options.deployment_id, proposal_id: proposalId,
    scope, content_digest: proof.binding_digest });
  const record = attestationSchema.parse(stored.content);
  if (record.deployment_id !== options.deployment_id || record.parent_name !== options.parent_name || record.proposal_id !== proposalId
      || canonicalJsonDigest(ownerScope(record.actor)) !== canonicalJsonDigest(scope)
      || stored.expires_at_ms !== Date.parse(record.valid_until) || canonicalJsonDigest(proofFor(record)) !== canonicalJsonDigest(proof)
      || record.compiled_plan_digest !== authority.proof.compiled_plan_digest || record.effect_digest !== authority.effect.effect_digest
      || record.inputs_digest !== canonicalJsonDigest(authority.business_inputs ?? {})
      || (record.approval === "human" && authority.proof.approval_path !== "human_review")) throw new OwnerRuntimeError("DELEGATION_PROOF_INVALID");
  return record;
}
function assertBinding(record: Attestation, effective: EffectiveOwnerPolicy, authority: SemanticAuthorityV1): void {
  if (effective.digest !== record.chain_digest || effective.actor.actor_digest !== record.actor.actor_digest
      || !effective.allowed_outcomes.includes(authority.proof.outcome) || Date.parse(record.valid_until) <= Date.now()
      || Date.parse(authority.proof.valid_until) > Date.parse(record.valid_until)) throw new OwnerRuntimeError("DELEGATION_CHANGED");
}
