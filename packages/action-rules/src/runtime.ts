import {
  canonicalJsonDigest,
  canonicalJsonStringify,
  delegationProofV1Schema,
  eligibilityProofDigest,
  parseSemanticAuthority,
  semanticProtocolVersions,
  type DelegationProofV1,
  type NormalizedWritebackJobV5,
  type SemanticAuthorityV1,
} from "@synapsor-runner/protocol";
import { checkHardLimitPostState, HardLimitPostStateExceeded, assertHardLimitWriterInventory } from "./hard-limit.js";
import { ActionRuleHardLimitRefusal } from "./hard-limit-refusal.js";
import { resolveExperimentalSharedSumProtection, checkExperimentalSharedSumPostState,
  type ExperimentalSharedSumProtection } from './experimental-shared-sum.js';
import { ActionRuleError } from "./errors.js";
import { validateActionRuleInputs } from "./inputs.js";
import {
  loadActionRuleFacts,
  type ActionRuleFactLoaderAdapterV1,
  type ActionRuleSubjectIdentityV1,
} from "./fact-loader.js";
import {
  evaluateActionRule,
  evaluateActionRuleApprovalPredicate,
} from "./evaluate.js";
import {
  resolveActivatedActionRule,
  resolveActivatedApprovalClass,
} from "./registry.js";
import type {
  ActionRuleEvaluationV1,
  ActionRuleFactSetV1,
  ActivatedActionRuleV1,
  ActivatedActionRuleApprovalClassV1,
  RuntimeActionRuleRegistryV1,
} from "./types.js";

export type SemanticActionEligibilityInputV1 = {
  inputs?: Record<string, unknown>;
  registry: RuntimeActionRuleRegistryV1;
  outcome: string;
  subjects: ActionRuleSubjectIdentityV1[];
  trusted: ActionRuleFactSetV1["trusted"];
  adapter: ActionRuleFactLoaderAdapterV1;
  proposal_id: string;
  trusted_context_digest: `sha256:${string}`;
  evidence_provenance_digest: `sha256:${string}`;
  verified_at?: string;
  check_delegation?: SemanticProposalDelegationCheck;
};

type EligibleRuleEvaluation = Extract<ActionRuleEvaluationV1, { result: "eligible" }>;
export type SemanticProposalDelegationCheck = (input: {
  activated: ActivatedActionRuleV1; evaluation: EligibleRuleEvaluation; facts: ActionRuleFactSetV1;
  proposal_id: string; inputs: Record<string, unknown>; verified_at: string;
}) => Promise<{ proof: DelegationProofV1; approval: "inherit" | "human" }>;
export type SemanticExecutionDelegationCheck = (input: {
  job: NormalizedWritebackJobV5; activated: ActivatedActionRuleV1; evaluation: EligibleRuleEvaluation;
  facts: ActionRuleFactSetV1; inputs: Record<string, unknown>; checked_at: string;
}) => Promise<void>;

export type SemanticActionEligibilityDecisionV1 =
  | {
    result: "eligible";
    activated: ActivatedActionRuleV1;
    evaluation: Extract<ActionRuleEvaluationV1, { result: "eligible" }>;
    semantic_authority: SemanticAuthorityV1;
    approval: {
      authority: ActivatedActionRuleApprovalClassV1;
      path: "automatic_eligible" | "human_review";
      predicate_result: "match" | "no_match" | "unknown" | "not_applicable";
    };
  }
  | {
    result: "ineligible" | "unknown";
    activated: ActivatedActionRuleV1;
    evaluation: Exclude<ActionRuleEvaluationV1, { result: "eligible" }>;
  };

export type SemanticActionReverificationV1 = {
  status: "reverified";
  proof_digest: `sha256:${string}`;
  action_rule_digest: `sha256:${string}`;
  compiled_plan_digest: `sha256:${string}`;
  proposal_dependency_set_digest: `sha256:${string}`;
  dependency_set_digest: `sha256:${string}`;
  effect_digest: `sha256:${string}`;
  checked_at: string;
};

function canonicalTimestamp(value: string | undefined, label: string): string {
  const timestamp = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(Date.parse(timestamp)).toISOString() !== timestamp) {
    throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

function assertDigest(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", `${label} is unavailable or invalid.`);
  }
}

function validatedDigest(value: string, label: string): `sha256:${string}` {
  assertDigest(value, label);
  return value;
}

function assertActivatedAuthority(
  activated: ActivatedActionRuleV1,
  approval: ActivatedActionRuleApprovalClassV1,
  authority: SemanticAuthorityV1,
): void {
  const proof = authority.proof;
  const compiled = activated.compiled;
  if (activated.action_boundary_name !== proof.action_boundary_name
    || activated.action_boundary_digest !== proof.action_boundary_digest
    || compiled.name !== proof.action_rule_name
    || compiled.outcome !== proof.outcome
    || compiled.rule_digest !== proof.action_rule_digest
    || compiled.compiled_plan_digest !== proof.compiled_plan_digest
    || compiled.verification_boundary_digest !== proof.verification_boundary_digest
    || compiled.effect_envelope_digest !== proof.effect_envelope_digest
    || compiled.schema_lock_digest !== proof.schema_lock_digest
    || compiled.generation_lock_fingerprint !== proof.generation_lock_fingerprint
    || canonicalJsonStringify(compiled.verification_boundary.transaction)
      !== canonicalJsonStringify(proof.verification_transaction)
    || compiled.compiler_version !== proof.compiler_version
    || compiled.approval_class !== proof.approval_class
    || activated.approval_policy_digest !== proof.approval_policy_digest
    || approval.digest !== proof.approval_policy_digest
    || approval.name !== proof.approval_class) {
    throw new ActionRuleError(
      "ACTION_RULE_AUTHORITY_STALE",
      "The active Action Rule authority no longer matches the immutable proposal.",
    );
  }
}

export function assertSemanticAuthorityCurrent(
  registry: RuntimeActionRuleRegistryV1,
  authority: SemanticAuthorityV1,
): {
  activated: ActivatedActionRuleV1;
  approval: ActivatedActionRuleApprovalClassV1;
} {
  const activated = resolveActivatedActionRule(registry, authority.proof.outcome);
  const approval = resolveActivatedApprovalClass(registry, authority.proof.outcome);
  assertActivatedAuthority(activated, approval, authority);
  return { activated, approval };
}

/**
 * Resolves and verifies the exact active semantic authority carried by a
 * writeback job without reading source facts. Transaction-time callers must
 * still use createSemanticActionVerifier before applying the effect.
 */
export function assertSemanticActionAuthorityCurrent(
  registry: RuntimeActionRuleRegistryV1,
  job: SemanticReverificationSubject,
): {
  activated: ActivatedActionRuleV1;
  approval: ActivatedActionRuleApprovalClassV1;
} {
  const { activated, approval } = assertSemanticAuthorityCurrent(registry, job.semantic_authority);
  if (job.source_id !== activated.compiled.source
    || job.engine !== activated.compiled.target_resource.engine
    || job.semantic_authority.effect.resource !== activated.compiled.effect_envelope.target_resource) {
    throw new ActionRuleError(
      "ACTION_RULE_AUTHORITY_STALE",
      "The semantic writeback target no longer matches the active Action Rule authority.",
    );
  }
  return { activated, approval };
}

export async function evaluateSemanticActionEligibility(
  input: SemanticActionEligibilityInputV1,
): Promise<SemanticActionEligibilityDecisionV1> {
  assertDigest(input.trusted_context_digest, "Trusted-context digest");
  assertDigest(input.evidence_provenance_digest, "Evidence-provenance digest");
  const verifiedAt = canonicalTimestamp(input.verified_at, "Eligibility verification time");
  const activated = resolveActivatedActionRule(input.registry, input.outcome);
  const approval = resolveActivatedApprovalClass(input.registry, input.outcome);
  const inputs = validateActionRuleInputs(activated.compiled.rule, input.inputs);
  const loaded = await loadActionRuleFacts({
    compiled: activated.compiled,
    subjects: input.subjects,
    trusted: { ...input.trusted, transaction_time: verifiedAt },
    adapter: input.adapter,
    mode: "proposal_snapshot",
  });
  const evaluation = evaluateActionRule({
    compiled: activated.compiled,
    facts: loaded.facts,
    proposal_id: input.proposal_id,
    inputs,
  });
  if (evaluation.result !== "eligible") return { result: evaluation.result, activated, evaluation };

  const delegation = await input.check_delegation?.({ activated, evaluation, facts: loaded.facts,
    proposal_id: input.proposal_id, inputs, verified_at: verifiedAt });
  if (input.check_delegation && (!delegation || !["inherit", "human"].includes(delegation.approval)
      || !delegationProofV1Schema.safeParse(delegation.proof).success)) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The current delegation could not be verified.");
  }
  if (delegation && Date.parse(delegation.proof.valid_until) <= Date.parse(verifiedAt)) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The current delegation expired before proposal verification.");
  }

  const approvalBinding = approval.rules.find((binding) => binding.outcome === input.outcome);
  if (approvalBinding === undefined) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The activated approval class does not bind this exact Action Rule.");
  }
  const approvalPredicate = approval.mode === "policy"
    ? evaluateActionRuleApprovalPredicate({
      compiled: activated.compiled,
      facts: loaded.facts,
      expression: approvalBinding.auto_approve_when!,
      inputs,
    })
    : undefined;
  const approvalPath = approval.mode === "policy" && approvalPredicate?.result === "match" && delegation?.approval !== "human"
    ? "automatic_eligible" as const
    : "human_review" as const;

  const subjectBindings = loaded.subject_bindings;
  const unsignedProof = {
    schema_version: semanticProtocolVersions.eligibilityProof,
    result: "eligible" as const,
    action_boundary_name: activated.action_boundary_name,
    action_boundary_digest: activated.action_boundary_digest,
    verification_boundary_digest: activated.compiled.verification_boundary_digest,
    effect_envelope_digest: activated.compiled.effect_envelope_digest,
    action_rule_name: activated.compiled.name,
    outcome: activated.compiled.outcome,
    action_rule_digest: activated.compiled.rule_digest,
    compiled_plan_digest: activated.compiled.compiled_plan_digest,
    compiler_version: activated.compiled.compiler_version,
    schema_lock_digest: activated.compiled.schema_lock_digest,
    generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
    verification_transaction: structuredClone(activated.compiled.verification_boundary.transaction),
    trusted_context_digest: input.trusted_context_digest,
    subject_bindings_digest: canonicalJsonDigest(subjectBindings),
    ...(Object.keys(inputs).length ? { business_inputs_digest: canonicalJsonDigest(inputs) } : {}),
    evidence_provenance_digest: input.evidence_provenance_digest,
    verified_facts_digest: evaluation.verified_facts_digest,
    dependency_set_digest: evaluation.dependency_set_digest,
    derived_effect_digest: evaluation.effect.effect_digest,
    approval_class: activated.compiled.approval_class,
    approval_policy_digest: approval.digest,
    approval_path: approvalPath,
    ...(delegation ? { delegation: delegation.proof } : {}),
    verified_at: verifiedAt,
    valid_until: new Date(Math.min(Date.parse(verifiedAt) + activated.compiled.ttl_seconds * 1_000,
      delegation ? Date.parse(delegation.proof.valid_until) : Infinity)).toISOString(),
    uses: 1 as const,
  };
  const semanticAuthority = parseSemanticAuthority({
    proof: { ...unsignedProof, proof_digest: eligibilityProofDigest(unsignedProof) },
    ...(Object.keys(inputs).length ? { business_inputs: inputs } : {}),
    subject_bindings: subjectBindings,
    dependencies: evaluation.dependencies,
    effect: evaluation.effect,
  });
  return {
    result: "eligible",
    activated,
    evaluation,
    semantic_authority: semanticAuthority,
    approval: {
      authority: approval,
      path: approvalPath,
      predicate_result: approvalPredicate?.result ?? "not_applicable",
    },
  };
}

export type SemanticReverificationSubject = Pick<NormalizedWritebackJobV5,
  "semantic_authority" | "source_id" | "engine" | "proposal_id" | "target">;

function subjectIdentitiesFromJob(job: SemanticReverificationSubject): ActionRuleSubjectIdentityV1[] {
  return job.semantic_authority.subject_bindings.map((subject) => {
    const matches = job.semantic_authority.dependencies.filter((dependency) =>
      dependency.binding === subject.binding && dependency.resource === subject.resource);
    if (matches.length !== 1) {
      throw new ActionRuleError(
        "ACTION_RULE_AUTHORITY_STALE",
        `Subject ${subject.binding} no longer has one exact immutable dependency.`,
      );
    }
    return {
      binding: subject.binding,
      resource: subject.resource,
      primary_key: matches[0]!.primary_key,
      subject_ref_digest: validatedDigest(subject.subject_ref_digest, `Subject ${subject.binding} reference digest`),
    };
  });
}

function trustedFactsFromJob(job: SemanticReverificationSubject, checkedAt: string): ActionRuleFactSetV1["trusted"] {
  const principal = job.target.principal_scope?.value;
  if (principal !== undefined && typeof principal !== "string") {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Trusted principal scope has an invalid type.");
  }
  if (job.target.tenant_guard !== undefined) {
    if (typeof job.target.tenant_guard.value !== "string") {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Trusted tenant scope has an invalid type.");
    }
    return {
      tenant: job.target.tenant_guard.value,
      ...(principal === undefined ? {} : { principal }),
      transaction_time: checkedAt,
    };
  }
  if (job.target.organization_scope === undefined) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Reviewed organization scope is unavailable.");
  }
  return {
    organization_scope: job.target.organization_scope,
    ...(principal === undefined ? {} : { principal }),
    transaction_time: checkedAt,
  };
}

export type CurrentSemanticActionVerifier = ((request: {
  job: NormalizedWritebackJobV5; factLoader: ActionRuleFactLoaderAdapterV1;
}) => Promise<SemanticActionReverificationV1>) & {
  admitSource(request: { job: NormalizedWritebackJobV5; factLoader: ActionRuleFactLoaderAdapterV1 }): Promise<void>;
};

function unsupportedHardLimitCapability(path: 'source.hard_limit.effect_capability' | 'source.hard_limit.admission_capability'): never {
  throw new ActionRuleError("ACTION_RULE_SCOPE_UNPROVEN", "Native Source effects cannot be inspected.", path);
}

export function createSemanticActionVerifier(input: {
  registry: RuntimeActionRuleRegistryV1 | ((outcome: string) => RuntimeActionRuleRegistryV1 | Promise<RuntimeActionRuleRegistryV1>);
  clock?: () => string;
  check_delegation?: SemanticExecutionDelegationCheck;
  allow_delayed_work?: (job: NormalizedWritebackJobV5, checkedAt: string) => Promise<void>;
  /** Compiler-issued host experiment only; no public activation/profile change. */
  experimental_shared_sum?: ExperimentalSharedSumProtection;
}): CurrentSemanticActionVerifier {
  const experimentalPlan = input.experimental_shared_sum;
  const verifier: CurrentSemanticActionVerifier = Object.assign(async ({ job, factLoader }: { job: NormalizedWritebackJobV5; factLoader: ActionRuleFactLoaderAdapterV1 }) => {
    // Refuse before loading rows when the execution path cannot enforce the
    // proof extension, or when a delegated deployment receives an unbound job.
    if (Boolean(job.semantic_authority.proof.delegation) !== Boolean(input.check_delegation)) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "This execution path cannot verify the required current delegation.");
    }
    const checkedAt = canonicalTimestamp(input.clock?.(), "Transaction verification time");
    const registry = typeof input.registry === "function" ? await input.registry(job.semantic_authority.proof.outcome) : input.registry;
    if (job.delayed_work) {
      if (!input.allow_delayed_work || job.semantic_authority.proof.delegation
        || job.engine !== "postgres"
        || Date.parse(job.delayed_work.requested_at) + job.delayed_work.absolute_request_age_seconds * 1_000 <= Date.parse(checkedAt)) {
        throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Reviewed delayed-work authority is unavailable or expired.");
      }
      await input.allow_delayed_work(job, checkedAt);
    } else if (Date.parse(job.semantic_authority.proof.valid_until) <= Date.parse(checkedAt)) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The semantic proposal proof has expired.");
    }
    const preliminary = assertSemanticActionAuthorityCurrent(registry, job);
    const experimentalBefore = experimentalPlan && resolveExperimentalSharedSumProtection(experimentalPlan, registry, preliminary.activated.compiled);
    if (experimentalBefore) {
      if (job.delayed_work || job.semantic_authority.proof.delegation || !factLoader.assertExperimentalSharedSumSource) {
        throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'Experimental native Source protection is unavailable.', 'experimental.shared_sum.source_capability');
      }
      await factLoader.assertExperimentalSharedSumSource(preliminary.activated.compiled);
      const afterProtection = typeof input.registry === 'function' ? await input.registry(job.semantic_authority.proof.outcome) : input.registry;
      const after = assertSemanticActionAuthorityCurrent(afterProtection, job);
      resolveExperimentalSharedSumProtection(experimentalPlan!, afterProtection, after.activated.compiled);
    }
    const verified = await reverifySemanticOperation({ registry, job, factLoader, checkedAt, mode: "transaction_reverify" });
    await input.check_delegation?.({ job, activated: verified.activated, evaluation: verified.evaluation,
      facts: verified.facts, inputs: verified.inputs, checked_at: checkedAt });
    // A Source wait must not preserve an obsolete designation, authority or expiry.
    const current = typeof input.registry === "function" ? await input.registry(job.semantic_authority.proof.outcome) : input.registry;
    assertSemanticActionAuthorityCurrent(current, job);
    assertHardLimitWriterInventory(current, verified.activated.compiled);
    if (!job.delayed_work && Date.parse(job.semantic_authority.proof.valid_until) <= Date.parse(canonicalTimestamp(input.clock?.(), "Post-wait verification time"))) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The semantic proposal proof has expired.");
    }
    const experimental = experimentalPlan && resolveExperimentalSharedSumProtection(experimentalPlan, current, verified.activated.compiled);
    if (verified.activated.compiled.hard_limit || experimental) {
      if (verified.activated.compiled.hard_limit) {
        if (!factLoader.assertHardLimitSource) unsupportedHardLimitCapability("source.hard_limit.effect_capability");
        await factLoader.assertHardLimitSource(verified.activated.compiled);
      }
      try {
        if (verified.activated.compiled.hard_limit) checkHardLimitPostState(verified.activated.compiled, verified.facts, verified.evaluation.effect, verified.inputs);
        if (experimental) checkExperimentalSharedSumPostState(experimentalPlan!, verified.activated.compiled, verified.facts, verified.evaluation.effect);
      } catch (error) {
        if (!(error instanceof HardLimitPostStateExceeded)) throw error;
        const proof = job.semantic_authority.proof;
        throw new ActionRuleHardLimitRefusal({ job_digest: canonicalJsonDigest(job),
          proof_digest: validatedDigest(proof.proof_digest, "Proof"), action_boundary_digest: validatedDigest(proof.action_boundary_digest, "Boundary"),
          compiled_plan_digest: validatedDigest(proof.compiled_plan_digest, "Plan"), effect_digest: validatedDigest(proof.derived_effect_digest, "Effect"),
          invariant_digest: verified.activated.compiled.hard_limit?.digest ?? experimental!.digest });
      }
    }
    return verified.result;
  }, { async admitSource({ job, factLoader }: { job: NormalizedWritebackJobV5; factLoader: ActionRuleFactLoaderAdapterV1 }) {
    const registry = typeof input.registry === "function" ? await input.registry(job.semantic_authority.proof.outcome) : input.registry;
    const { activated } = assertSemanticActionAuthorityCurrent(registry, job);
    const experimental = experimentalPlan && resolveExperimentalSharedSumProtection(experimentalPlan, registry, activated.compiled);
    if (!activated.compiled.hard_limit && !experimental) return;
    assertHardLimitWriterInventory(registry, activated.compiled);
    if (job.delayed_work || job.semantic_authority.proof.delegation) unsupportedHardLimitCapability("source.hard_limit.admission_capability");
    if (activated.compiled.hard_limit) {
      if (!factLoader.assertHardLimitSource) unsupportedHardLimitCapability("source.hard_limit.admission_capability");
      await factLoader.assertHardLimitSource(activated.compiled);
    }
    if (experimental) {
      if (!factLoader.assertExperimentalSharedSumSource) {
        throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'Experimental native Source protection is unavailable.', 'experimental.shared_sum.source_capability');
      }
      await factLoader.assertExperimentalSharedSumSource(activated.compiled);
    }
    const after = typeof input.registry === "function" ? await input.registry(job.semantic_authority.proof.outcome) : input.registry;
    const current = assertSemanticActionAuthorityCurrent(after, job);
    assertHardLimitWriterInventory(after, activated.compiled);
    if (experimental) resolveExperimentalSharedSumProtection(experimentalPlan!, after, current.activated.compiled);
    if (Date.parse(job.semantic_authority.proof.valid_until) <= Date.parse(canonicalTimestamp(input.clock?.(), "Source admission time"))) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The semantic proposal proof has expired.");
    }
  } });
  return verifier;
}

/** Approval-time checks compare the same exact facts/effect as the writer,
 * but use a reader's snapshot. The writer locks and rechecks in its own source transaction. */
export async function reverifySemanticProposal(input: {
  registry: RuntimeActionRuleRegistryV1;
  job: SemanticReverificationSubject;
  factLoader: ActionRuleFactLoaderAdapterV1;
  checkedAt?: string;
}): Promise<SemanticActionReverificationV1> {
  if (input.job.semantic_authority.proof.delegation) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Delegated delayed work is unsupported.");
  }
  const checkedAt = canonicalTimestamp(input.checkedAt, "Proposal reverification time");
  return (await reverifySemanticOperation({ ...input, checkedAt, mode: "proposal_snapshot" })).result;
}

async function reverifySemanticOperation(input: {
  registry: RuntimeActionRuleRegistryV1;
  job: SemanticReverificationSubject;
  factLoader: ActionRuleFactLoaderAdapterV1;
  checkedAt: string;
  mode: "proposal_snapshot" | "transaction_reverify";
}): Promise<{
  result: SemanticActionReverificationV1;
  activated: ActivatedActionRuleV1;
  evaluation: EligibleRuleEvaluation;
  facts: ActionRuleFactSetV1;
  inputs: Record<string, unknown>;
}> {
  const { job, checkedAt, factLoader } = input;
  const { activated, approval } = assertSemanticActionAuthorityCurrent(input.registry, job);
  const inputs = validateActionRuleInputs(activated.compiled.rule, job.semantic_authority.business_inputs);
  if ((Object.keys(inputs).length || job.semantic_authority.proof.business_inputs_digest)
    && canonicalJsonDigest(inputs) !== job.semantic_authority.proof.business_inputs_digest) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Business inputs no longer match the immutable proposal proof.");
  }
  const loaded = await loadActionRuleFacts({ compiled: activated.compiled,
    subjects: subjectIdentitiesFromJob(job), trusted: trustedFactsFromJob(job, checkedAt),
    adapter: factLoader, mode: input.mode });
  const evaluation = evaluateActionRule({ compiled: activated.compiled, facts: loaded.facts,
    proposal_id: job.proposal_id, inputs });
  const proof = job.semantic_authority.proof;
  const approvalBinding = approval.rules.find((binding) => binding.outcome === proof.outcome);
  const approvalPredicate = proof.approval_path === "automatic_eligible"
    ? approvalBinding?.auto_approve_when === undefined ? undefined
      : evaluateActionRuleApprovalPredicate({ compiled: activated.compiled, facts: loaded.facts,
        expression: approvalBinding.auto_approve_when, inputs })
    : undefined;
  if (evaluation.result !== "eligible"
    || evaluation.effect.effect_digest !== proof.derived_effect_digest
    || evaluation.effect.effect_digest !== job.semantic_authority.effect.effect_digest
    || evaluation.dependency_set_digest !== proof.dependency_set_digest
    || canonicalJsonDigest(loaded.subject_bindings) !== proof.subject_bindings_digest
    || (proof.approval_path === "automatic_eligible" && approvalPredicate?.result !== "match")) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Current authoritative facts no longer prove the proposal's exact effect.");
  }
  return { activated, evaluation, facts: loaded.facts, inputs,
    result: { status: "reverified", proof_digest: validatedDigest(proof.proof_digest, "Eligibility proof digest"),
      action_rule_digest: validatedDigest(proof.action_rule_digest, "Action Rule digest"),
      compiled_plan_digest: validatedDigest(proof.compiled_plan_digest, "Compiled plan digest"),
      proposal_dependency_set_digest: proof.dependency_set_digest,
      dependency_set_digest: evaluation.dependency_set_digest,
      effect_digest: evaluation.effect.effect_digest, checked_at: checkedAt } };
}
