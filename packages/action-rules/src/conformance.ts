import {
  canonicalJsonDigest,
  eligibilityProofDigest,
  exactDerivedEffectDigest,
  parseWritebackJob,
  semanticProtocolVersions,
  type EligibilityProofV1,
  type ExactDerivedEffectProtocolV1,
  type NormalizedWritebackJobV5,
  type SemanticAuthorityV1,
} from "@synapsor-runner/protocol";
import type { ActionRuleFactQueryV1 } from "./fact-loader.js";
import type { SemanticActionReverificationV1 } from "./runtime.js";

function exactDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Expected an exact SHA-256 digest.");
  return value as `sha256:${string}`;
}

export type SemanticAdapterConformanceVectorV1 = {
  job: NormalizedWritebackJobV5;
  fact_query: ActionRuleFactQueryV1;
  fact_row: Record<string, unknown>;
  reverification: SemanticActionReverificationV1;
};

/**
 * One engine-neutral semantic writeback vector used to certify database
 * adapters. It is test authority, not an activated domain rule.
 */
export function createSemanticAdapterConformanceVector(
  engine: "postgres" | "mysql",
): SemanticAdapterConformanceVectorV1 {
  const subjectBindings = [{
    binding: "case",
    resource: "support_cases.case_actions",
    subject_ref_digest: canonicalJsonDigest({ subject_ref: "case_1" }),
  }];
  const dependencies = [{
    binding: "case",
    resource: "support_cases.case_actions",
    primary_key: { column: "case_id", value: "case_1" },
    version: { column: "version", value: 7 },
    row_digest: canonicalJsonDigest({ case_id: "case_1", status: "open", tenant_id: "acme", version: 7 }),
  }];
  const effectUnsigned = {
    operation: "single_row_update" as const,
    source: "semantic_source",
    resource: "support_cases.case_actions",
    schema: "support_cases",
    table: "case_actions",
    primary_key: { column: "case_id", value: "case_1" },
    tenant_guard: { column: "tenant_id", value: "acme" },
    expected_version: { column: "version", value: 7 },
    version_advance: { column: "version", strategy: "integer_increment" as const },
    allowed_columns: ["status"],
    set: { status: "scheduled" },
  };
  const effect: ExactDerivedEffectProtocolV1 = {
    ...effectUnsigned,
    effect_digest: exactDerivedEffectDigest(effectUnsigned),
  };
  const proofUnsigned = {
    schema_version: semanticProtocolVersions.eligibilityProof,
    result: "eligible" as const,
    action_boundary_name: "support_cases.actions",
    action_boundary_digest: canonicalJsonDigest({ action_boundary: "support_cases.actions", revision: 1 }),
    verification_boundary_digest: canonicalJsonDigest({ verification_boundary: "support_cases.verification", revision: 1 }),
    effect_envelope_digest: canonicalJsonDigest({ effect_envelope: "support_cases.schedule", revision: 1 }),
    action_rule_name: "support_cases.schedule_case",
    outcome: "support_cases.schedule_case",
    action_rule_digest: canonicalJsonDigest({ action_rule: "support_cases.schedule_case", revision: 1 }),
    compiled_plan_digest: canonicalJsonDigest({ compiled_plan: "support_cases.schedule_case", revision: 1 }),
    compiler_version: "synapsor.action-rule-compiler.v1",
    schema_lock_digest: canonicalJsonDigest({ schema: "support_cases", revision: 1 }),
    generation_lock_fingerprint: canonicalJsonDigest({ generation: "support_cases", revision: 1 }),
    verification_transaction: { isolation: "repeatable_read" as const, timezone: "UTC" as const },
    trusted_context_digest: canonicalJsonDigest({ tenant: "acme" }),
    subject_bindings_digest: canonicalJsonDigest(subjectBindings),
    evidence_provenance_digest: canonicalJsonDigest({ evidence: "case_1" }),
    verified_facts_digest: canonicalJsonDigest({ facts: dependencies }),
    dependency_set_digest: canonicalJsonDigest(dependencies),
    derived_effect_digest: effect.effect_digest,
    approval_class: "support_cases.standard_schedule",
    approval_policy_digest: canonicalJsonDigest({ approval_class: "support_cases.standard_schedule", revision: 1 }),
    approval_path: "human_review" as const,
    verified_at: "2026-09-03T12:00:00.000Z",
    valid_until: "2026-09-03T12:05:00.000Z",
    uses: 1 as const,
  };
  const proof: EligibilityProofV1 = {
    ...proofUnsigned,
    proof_digest: eligibilityProofDigest(proofUnsigned),
  };
  const semanticAuthority: SemanticAuthorityV1 = {
    proof,
    subject_bindings: subjectBindings,
    dependencies,
    effect,
  };
  const candidate = {
    protocol_version: semanticProtocolVersions.normalizedWritebackJobV5,
    job_id: "wbj_semantic_adapter_conformance_1",
    proposal_id: "wrp_semantic_adapter_conformance_1",
    approval_id: canonicalJsonDigest({ approval: "semantic_adapter_conformance_1" }),
    proposal_hash: canonicalJsonDigest({ proposal: "semantic_adapter_conformance_1" }),
    contract: {
      contract_id: "support_cases.schedule_case",
      contract_version_id: "support_cases.schedule_case.v1",
      digest: canonicalJsonDigest({ contract: "support_cases.schedule_case", revision: 1 }),
    },
    source_id: effect.source,
    engine,
    operation: effect.operation,
    target: {
      schema: effect.schema,
      table: effect.table,
      primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard,
    },
    allowed_columns: effect.allowed_columns,
    patch: effect.set,
    conflict_guard: {
      kind: "version_column" as const,
      column: effectUnsigned.expected_version.column,
      expected_value: effectUnsigned.expected_version.value,
    },
    version_advance: effect.version_advance,
    semantic_authority: semanticAuthority,
    idempotency_key: "semantic:wrp_semantic_adapter_conformance_1",
    lease_expires_at: "2099-09-03T12:10:00.000Z",
    attempt_count: 1,
  };
  const parsed = parseWritebackJob(candidate);
  if (parsed.protocol_version !== semanticProtocolVersions.normalizedWritebackJobV5) {
    throw new Error("Semantic adapter conformance vector did not normalize to protocol 5.0.");
  }
  return {
    job: parsed,
    fact_query: {
      binding: "case",
      engine,
      source: effect.source,
      schema: effect.schema,
      table: effect.table,
      projection: ["case_id", "status", "tenant_id", "version"],
      predicates: [
        { operation: "eq", column: "case_id", value: "case_1" },
        { operation: "eq", column: "tenant_id", value: "acme" },
      ],
      order_by: [{ column: "case_id", direction: "asc" }],
      limit: 2,
      lock: "for_update",
    },
    fact_row: { case_id: "case_1", status: "open", tenant_id: "acme", version: 7 },
    reverification: {
      status: "reverified",
      proof_digest: exactDigest(proof.proof_digest),
      action_rule_digest: exactDigest(proof.action_rule_digest),
      compiled_plan_digest: exactDigest(proof.compiled_plan_digest),
      proposal_dependency_set_digest: exactDigest(proof.dependency_set_digest),
      dependency_set_digest: exactDigest(proof.dependency_set_digest),
      effect_digest: exactDigest(proof.derived_effect_digest),
      checked_at: "2026-09-03T12:02:00.000Z",
    },
  };
}
