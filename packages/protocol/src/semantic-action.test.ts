import { describe, expect, it } from "vitest";
import {
  canonicalJsonDigest,
  eligibilityProofDigest,
  exactDerivedEffectDigest,
  parseChangeSet,
  parseEligibilityProof,
  parseExecutionReceipt,
  parseWritebackJob,
  protocolVersions,
  semanticProtocolVersions,
  type EligibilityProofV1,
  type ExactDerivedEffectProtocolV1,
  type SemanticAuthorityV1,
} from "./index.js";

function semanticFixture() {
  const subjectBindings = [
    { binding: "appointment", resource: "field_service.appointments", subject_ref_digest: `sha256:${"1".repeat(64)}` as const },
    { binding: "offer", resource: "field_service.appointment_slot_offers", subject_ref_digest: `sha256:${"2".repeat(64)}` as const },
  ];
  const dependencies = [
    { binding: "appointment", resource: "field_service.appointments", primary_key: { column: "appointment_id", value: "appt_1" }, version: { column: "version", value: 7 }, row_digest: `sha256:${"3".repeat(64)}` as const },
    { binding: "offer", resource: "field_service.appointment_slot_offers", primary_key: { column: "offer_id", value: "offer_1" }, version: { column: "version", value: 4 }, row_digest: `sha256:${"4".repeat(64)}` as const },
    { binding: "request", resource: "field_service.service_requests", primary_key: { column: "request_id", value: "request_1" }, version: { column: "version", value: 3 }, row_digest: `sha256:${"5".repeat(64)}` as const },
  ];
  const effectUnsigned = {
    operation: "single_row_update" as const,
    source: "local_postgres",
    resource: "field_service.appointments",
    schema: "field_service",
    table: "appointments",
    primary_key: { column: "appointment_id", value: "appt_1" },
    tenant_guard: { column: "account_id", value: "acct_1" },
    principal_scope: { column: "principal_id", value: "customer_1" },
    expected_version: { column: "version", value: 7 },
    version_advance: { column: "version", strategy: "integer_increment" as const },
    allowed_columns: ["scheduled_end_at", "scheduled_start_at", "slot_id"],
    set: {
      scheduled_end_at: "2026-09-16T00:00:00.000Z",
      scheduled_start_at: "2026-09-15T20:00:00.000Z",
      slot_id: "slot_tuesday",
    },
  };
  const effect: ExactDerivedEffectProtocolV1 = {
    ...effectUnsigned,
    effect_digest: exactDerivedEffectDigest(effectUnsigned),
  };
  const proofUnsigned = {
    schema_version: semanticProtocolVersions.eligibilityProof,
    result: "eligible" as const,
    action_boundary_name: "field_service.actions",
    action_boundary_digest: `sha256:${"6".repeat(64)}` as const,
    verification_boundary_digest: `sha256:${"7".repeat(64)}` as const,
    effect_envelope_digest: `sha256:${"8".repeat(64)}` as const,
    action_rule_name: "field_service.reschedule_to_offered_slot",
    outcome: "field_service.reschedule_to_offered_slot",
    action_rule_digest: `sha256:${"9".repeat(64)}` as const,
    compiled_plan_digest: `sha256:${"a".repeat(64)}` as const,
    compiler_version: "synapsor.action-rule-compiler.v1",
    schema_lock_digest: `sha256:${"b".repeat(64)}` as const,
    generation_lock_fingerprint: `sha256:${"c".repeat(64)}` as const,
    verification_transaction: { isolation: "repeatable_read" as const, timezone: "UTC" as const },
    trusted_context_digest: `sha256:${"d".repeat(64)}` as const,
    subject_bindings_digest: canonicalJsonDigest(subjectBindings),
    evidence_provenance_digest: `sha256:${"e".repeat(64)}` as const,
    verified_facts_digest: `sha256:${"f".repeat(64)}` as const,
    dependency_set_digest: canonicalJsonDigest(dependencies),
    derived_effect_digest: effect.effect_digest,
    approval_class: "field_service.standard_reschedule",
    approval_policy_digest: `sha256:${"1".repeat(64)}` as const,
    approval_path: "automatic_eligible" as const,
    verified_at: "2026-09-02T20:00:00.000Z",
    valid_until: "2026-09-02T20:05:00.000Z",
    uses: 1 as const,
  };
  const proof: EligibilityProofV1 = { ...proofUnsigned, proof_digest: eligibilityProofDigest(proofUnsigned) };
  const semanticAuthority: SemanticAuthorityV1 = { proof, subject_bindings: subjectBindings, dependencies, effect };
  const principalScope = {
    schema_version: "synapsor.principal-scope.v1" as const,
    column: "principal_id",
    binding: "principal",
    provider: "environment" as const,
    value_fingerprint: canonicalJsonDigest({ principal: "customer_1" }),
    value: "customer_1",
  };
  const changeSetCore = {
    schema_version: protocolVersions.changeSetV4,
    proposal_id: "wrp_reschedule_1",
    proposal_version: 1,
    action: "field_service.reschedule_to_offered_slot",
    contract: { digest: `sha256:${"a".repeat(64)}` as const, version: "contract-v1" },
    operation: "single_row_update" as const,
    mode: "review_required" as const,
    principal: { id: "customer_1", source: "trusted_session" as const },
    scope: { tenant_id: "acct_1", business_object: "appointment", object_id: "appt_1" },
    source: { kind: "external_postgres" as const, source_id: "local_postgres", schema: "field_service", table: "appointments", primary_key: effect.primary_key },
    before: { appointment_id: "appt_1", version: 7 },
    patch: effect.set,
    after: { appointment_id: "appt_1", version: 8, ...effect.set },
    guards: {
      tenant: effect.tenant_guard,
      principal_scope: principalScope,
      allowed_columns: effect.allowed_columns,
      expected_version: effect.expected_version,
      version_advance: effect.version_advance,
    },
    evidence: { bundle_id: "ev_reschedule_1", query_fingerprint: `sha256:${"0".repeat(64)}`, items: [] },
    approval: {
      status: "pending" as const,
      mode: "policy" as const,
      approval_class: proof.approval_class,
      approval_policy_digest: proof.approval_policy_digest,
    },
    writeback: { status: "not_applied" as const, mode: "trusted_worker_required" as const, executor: "semantic_rule" as const },
    semantic_authority: semanticAuthority,
    source_database_mutated: false as const,
    created_at: "2026-09-02T20:00:01.000Z",
  };
  const changeSet = {
    ...changeSetCore,
    integrity: { proposal_hash: canonicalJsonDigest(changeSetCore) },
  };
  const normalizedJob = {
    protocol_version: protocolVersions.normalizedWritebackJobV5,
    job_id: "wbj_reschedule_1",
    proposal_id: changeSet.proposal_id,
    approval_id: `sha256:${"2".repeat(64)}` as const,
    proposal_hash: changeSet.integrity.proposal_hash,
    contract: {
      contract_id: "contract_1",
      contract_version_id: "contract-v1",
      digest: changeSet.contract.digest,
    },
    source_id: "local_postgres",
    engine: "postgres" as const,
    operation: effect.operation,
    target: {
      schema: effect.schema,
      table: effect.table,
      primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard,
      principal_scope: principalScope,
    },
    allowed_columns: effect.allowed_columns,
    patch: effect.set,
    conflict_guard: { kind: "version_column" as const, column: "version", expected_value: 7 },
    version_advance: effect.version_advance,
    semantic_authority: semanticAuthority,
    idempotency_key: "semantic:wrp_reschedule_1",
    lease_expires_at: "2026-09-02T20:10:00.000Z",
    attempt_count: 1,
  };
  const receiptCore = {
    schema_version: protocolVersions.executionReceiptV5,
    writeback_job_id: normalizedJob.job_id,
    proposal_id: normalizedJob.proposal_id,
    proposal_hash: normalizedJob.proposal_hash,
    approval_id: normalizedJob.approval_id,
    runner_id: "runner_1",
    operation: normalizedJob.operation,
    receipt_authority: "source_db" as const,
    status: "applied" as const,
    target: {
      source_id: normalizedJob.source_id,
      schema: normalizedJob.target.schema,
      table: normalizedJob.target.table,
      identity: [effect.primary_key as { column: string; value: string }],
    },
    rows_affected: 1,
    idempotency_key: normalizedJob.idempotency_key,
    before_digest: canonicalJsonDigest({ version: 7 }),
    after_digest: canonicalJsonDigest({ version: 8 }),
    semantic_verification: {
      status: "reverified" as const,
      proof_digest: proof.proof_digest,
      action_rule_digest: proof.action_rule_digest,
      compiled_plan_digest: proof.compiled_plan_digest,
      proposal_dependency_set_digest: proof.dependency_set_digest,
      dependency_set_digest: proof.dependency_set_digest,
      effect_digest: proof.derived_effect_digest,
      checked_at: "2026-09-02T20:02:00.000Z",
    },
    source_database_mutated: true,
    safe_outcome_code: "APPLIED",
    executed_at: "2026-09-02T20:02:01.000Z",
  };
  const receipt = { ...receiptCore, receipt_hash: canonicalJsonDigest(receiptCore) };
  return { proof, semanticAuthority, changeSet, normalizedJob, receipt };
}

describe("semantic Action protocol", () => {
  it("parses one required v4 rule-derived ChangeSet and v5 normalized job", () => {
    const fixture = semanticFixture();
    expect(parseEligibilityProof(fixture.proof)).toEqual(fixture.proof);
    expect(parseChangeSet(fixture.changeSet)).toMatchObject({
      schema_version: protocolVersions.changeSetV4,
      action: "field_service.reschedule_to_offered_slot",
      source_database_mutated: false,
    });
    expect(parseWritebackJob(fixture.normalizedJob)).toMatchObject({
      protocol_version: protocolVersions.normalizedWritebackJobV5,
      operation: "single_row_update",
      semantic_authority: { proof: { uses: 1 } },
    });
  });

  it("accepts existing reviewed Action Boundary names without treating them as capability names", () => {
    const { proof } = semanticFixture();
    const { proof_digest: _proofDigest, ...unsigned } = proof;
    const existingBoundaryName = {
      ...unsigned,
      action_boundary_name: "default_action_boundary",
    };
    expect(parseEligibilityProof({
      ...existingBoundaryName,
      proof_digest: eligibilityProofDigest(existingBoundaryName),
    }).action_boundary_name).toBe("default_action_boundary");

    const invalidBoundaryName = {
      ...unsigned,
      action_boundary_name: "Action Boundary with spaces",
    };
    expect(() => parseEligibilityProof({
      ...invalidBoundaryName,
      proof_digest: eligibilityProofDigest(invalidBoundaryName),
    })).toThrow(/fixed reviewed name/i);
  });

  it("normalizes the public v5 job without dropping semantic authority", () => {
    const { normalizedJob } = semanticFixture();
    const wireJob = {
      schema_version: protocolVersions.writebackJobV5,
      writeback_job_id: normalizedJob.job_id,
      proposal_id: normalizedJob.proposal_id,
      proposal_hash: normalizedJob.proposal_hash,
      approval_id: normalizedJob.approval_id,
      contract: normalizedJob.contract,
      runner_scope: { project_id: "project_1", source_id: normalizedJob.source_id },
      engine: normalizedJob.engine,
      operation: normalizedJob.operation,
      target: normalizedJob.target,
      allowed_columns: normalizedJob.allowed_columns,
      patch: normalizedJob.patch,
      conflict_guard: normalizedJob.conflict_guard,
      version_advance: normalizedJob.version_advance,
      semantic_authority: normalizedJob.semantic_authority,
      idempotency_key: normalizedJob.idempotency_key,
      lease: { lease_id: "lease_1", attempt: 1, expires_at: "2026-09-02T20:10:00.000Z" },
    };
    expect(parseWritebackJob(wireJob)).toEqual(normalizedJob);
  });

  it("rejects effect, dependency, proof, proposal, and worker authority drift", () => {
    const effectDrift = structuredClone(semanticFixture().changeSet);
    effectDrift.semantic_authority.effect.set.slot_id = "unreviewed_slot";
    expect(() => parseChangeSet(effectDrift)).toThrow(/derived effect digest mismatch/i);

    const dependencyDrift = structuredClone(semanticFixture().changeSet);
    dependencyDrift.semantic_authority.dependencies[0]!.version!.value = 8;
    expect(() => parseChangeSet(dependencyDrift)).toThrow(/dependency set digest mismatch/i);

    const proposalDrift = structuredClone(semanticFixture().changeSet);
    proposalDrift.patch = { ...proposalDrift.patch, slot_id: "unreviewed_slot" };
    expect(() => parseChangeSet(proposalDrift)).toThrow(/proposal hash mismatch|patch must equal/i);

    const jobDrift = structuredClone(semanticFixture().normalizedJob);
    jobDrift.conflict_guard.expected_value = 8;
    expect(() => parseWritebackJob(jobDrift)).toThrow(/conflict guard mismatch/i);
  });

  it("recomputes semantic proposal and execution-receipt hashes", () => {
    const fixture = semanticFixture();
    expect(parseExecutionReceipt(fixture.receipt)).toMatchObject({
      schema_version: protocolVersions.executionReceiptV5,
      status: "applied",
    });

    const proposalTamper = structuredClone(fixture.changeSet);
    proposalTamper.before.version = 6;
    expect(() => parseChangeSet(proposalTamper)).toThrow(/proposal hash mismatch/i);

    const receiptTamper = structuredClone(fixture.receipt);
    receiptTamper.rows_affected = 0;
    expect(() => parseExecutionReceipt(receiptTamper)).toThrow(/receipt hash mismatch/i);
  });

  it("rejects expired ordering and more than one use", () => {
    const expired = structuredClone(semanticFixture().proof) as any;
    expired.valid_until = expired.verified_at;
    const { proof_digest: _digest, ...unsigned } = expired;
    expired.proof_digest = eligibilityProofDigest(unsigned);
    expect(() => parseEligibilityProof(expired)).toThrow(/expire after verification/i);

    const reusable = structuredClone(semanticFixture().proof) as any;
    reusable.uses = 2;
    expect(() => parseEligibilityProof(reusable)).toThrow();
  });
});
