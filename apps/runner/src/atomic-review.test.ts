import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import { canonicalJsonDigest, parseExecutionReceipt, type NormalizedWritebackResultV5 } from "@synapsor-runner/protocol";
import { semanticAtomicEffectResult } from "@synapsor-runner/worker-core";
import { atomicFixture, atomicJob, atomicRows } from "../../../packages/action-rules/src/testing/atomic-fixture.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";
import { writerProvisioningPlan, writerProvisioningSql } from "./writer-provisioning.js";
import { toExecutionReceipt } from "./writeback-domain.js";

describe("one atomic action in writer review and completion evidence", () => {
  it("requires exact offer-consumption permissions instead of silently reusing the previous lock-only writer", () => {
    const f = atomicFixture("postgres");
    const table = (name: string, updates: string[]): TableInfo => ({
      schema: "atomic_test", name, type: "table",
      columns: f.catalog.resources.find(resource => resource.table === name)!.fields.map((field, index) => ({
        name: field.name, data_type: field.type.kind === "integer" ? "integer" : "text", nullable: field.nullable,
        generated: false, ordinal_position: index + 1,
        suggestions: { tenant: field.name === "account_id", conflict: field.name === "version", sensitive: false, immutable: false, large_or_binary: false },
      })), primary_key: [], foreign_keys: [], unique_constraints: [], indexes: [],
      row_level_security: false, row_level_security_policies: [], writable: true,
      role_posture: { owner: "separate_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, update: false, insert: false, delete: false, truncate: false, references: false, trigger: false },
        column_privileges: { update: updates }, row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] },
    });
    const inspection: SchemaInspection = { engine: "postgres", server_version: "16", current_user: "dedicated_writer",
      schemas: ["atomic_test"], inspected_at: f.now, warnings: [],
      role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: false, owned_relations: [],
        writable_relations: ["atomic_test.subscriptions", "atomic_test.offers"], reasons: [] },
      tables: [table("subscriptions", ["plan", "version"]), table("offers", ["offer_id"])] };
    const policy = { outcome: f.rule.outcome, action_boundary_digest: f.registry.rules[0]!.action_boundary_digest,
      mode: "supervised_worker" as const, concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 3,
      proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "ATOMIC_TEST_WRITER",
      require_least_privilege_writer: true, writer_posture_fingerprint: rolePostureFingerprint(inspection) };
    const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [], sources: { atomic_source: {
      engine: "postgres", read_url_env: "ATOMIC_TEST_READER", write_url_env: "ATOMIC_TEST_WRITER", receipts: { authority: "runner_ledger" } } },
      supervised_worker: { enabled: true, profile: "production", capabilities: [], outcomes: [policy] } };
    const assess = () => assessSemanticSupervisedWriterPosture(config, policy, f.registry, inspection);
    const old = assess();
    expect(old.ok).toBe(false);
    expect(old.reasons).toContain("writer_update_missing");
    expect(old.required_relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "atomic_test.offers", privileges: ["select", "update"], update_columns: ["status", "version"] }),
    ]));
    const handoff = writerProvisioningPlan({ assessment: old, inspection, outcome: f.rule.outcome,
      actionDigest: policy.action_boundary_digest, writerEnv: policy.write_url_env });
    expect(writerProvisioningSql(handoff!)).toContain('GRANT UPDATE ("status", "version") ON TABLE "atomic_test"."offers"');
    const update = (fields: string[]) => {
      inspection.tables[1]!.role_posture!.column_privileges!.update = fields;
      policy.writer_posture_fingerprint = rolePostureFingerprint(inspection);
      return assess();
    };
    expect(update(["status", "version"]).ok).toBe(true);
    expect(update(["status"]).reasons).toContain("writer_update_missing");
    expect(update(["status", "version", "new_plan"]).reasons).toContain("writer_excess_column_privilege");
  });

  async function receiptFixture() {
    const f = atomicFixture("postgres"), job = await atomicJob(f, atomicRows());
    const proof = job.semantic_authority.proof, effect = job.semantic_authority.effect;
    const result: NormalizedWritebackResultV5 = { protocol_version: "5.0", job_id: job.job_id, runner_id: "test_worker",
      operation: job.operation, receipt_authority: "source_db", status: "applied", affected_rows: 2,
      target_identity: [effect.primary_key as { column: string; value: string }],
      atomic_effects: [effect, ...effect.atomic_updates!].map(member => semanticAtomicEffectResult(member, Number(member.expected_version!.value) + 1)),
      completed_at: f.now, semantic_verification: { status: "reverified", proof_digest: proof.proof_digest,
        action_rule_digest: proof.action_rule_digest, compiled_plan_digest: proof.compiled_plan_digest,
        proposal_dependency_set_digest: proof.dependency_set_digest, dependency_set_digest: proof.dependency_set_digest,
        effect_digest: proof.derived_effect_digest, checked_at: f.now } };
    return { job, result };
  }

  it("converts complete evidence into a valid receipt; approval/dry run is never completion", async () => {
    const { job, result } = await receiptFixture();
    expect(parseExecutionReceipt(toExecutionReceipt(job, result, false))).toMatchObject({
      schema_version: "synapsor.execution-receipt.v5", proposal_hash: job.proposal_hash,
      rows_affected: 2, source_database_mutated: true, atomic_effects: [{ affected_rows: 1 }, { affected_rows: 1 }] });
    expect(parseExecutionReceipt(toExecutionReceipt(job, result, true))).toMatchObject({
      status: "canceled", rows_affected: 0, source_database_mutated: false, atomic_effects: [{ affected_rows: 0 }, { affected_rows: 0 }] });
  });

  it.each(["missing", "partial", "different_member", "different_proof", "different_job", "different_primary"])("refuses incomplete or unrelated completion evidence: %s", async (failure) => {
    const { job, result } = await receiptFixture();
    if (failure === "missing") { delete result.atomic_effects; result.affected_rows = 1; }
    if (failure === "partial") result.atomic_effects!.pop();
    if (failure === "different_member") result.atomic_effects![1]!.effect_digest = canonicalJsonDigest({ unrelated: true });
    if (failure === "different_proof") result.semantic_verification.proof_digest = canonicalJsonDigest({ unrelated: true });
    if (failure === "different_job") result.job_id = "unrelated";
    if (failure === "different_primary") result.target_identity[0]!.value = "unrelated";
    expect(() => toExecutionReceipt(job, result, false)).toThrow();
  });
});
