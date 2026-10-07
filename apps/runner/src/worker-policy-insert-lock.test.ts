import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import { createActionRuleAuthority } from "../../../packages/action-rules/src/authority.js";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";
import { writerProvisioningPlan, writerProvisioningSql } from "./writer-provisioning.js";
import { actionRuleRlsReadiness } from "./action-rule-rls-readiness.js";

function insertWriter(engine: "postgres" | "mysql" = "postgres") {
  const f = completeCollectionFixture(engine);
  f.verification_boundary.resources = f.verification_boundary.resources.filter(r => r.binding === "customer");
  f.verification_boundary.lock_order = ["customer"];
  f.verification_boundary.transaction.isolation = "repeatable_read";
  f.rule.require = { kind: "compare", operator: "eq", left: { kind: "field", binding: "customer", field: "state" },
    right: { kind: "literal", value: "active", value_type: f.effect_envelope.allowed_fields[0]!.type } };
  Object.assign(f.effect_envelope, { operation: "insert", target_resource: "collections.holds", primary_key: "hold_id",
    deduplication: { components: [{ column: "hold_id", source: "proposal_id" }, { column: "tenant_id", source: "trusted_tenant" }] } });
  delete f.effect_envelope.target_binding; delete f.effect_envelope.conflict_key; delete f.effect_envelope.version_advance;
  f.rule.effect.operation = "insert"; f.rule.effect.target_resource = "collections.holds"; delete f.rule.effect.target_binding;
  const { registry } = createActionRuleAuthority({ name: "lock_requirements", action_boundary_name: "collections.actions", catalog: f.catalog,
    rules: [{ read_boundary_name: "collections.read", read_boundary_digest: f.catalog.generation_lock_fingerprint,
      verification_boundary: f.verification_boundary, effect_envelope: f.effect_envelope, rule: f.rule, activated_at: "2026-10-07T00:00:00.000Z" }] });
  const table = (name: string, insert: boolean, updates: string[]): TableInfo => ({
    schema: "collections", name, type: "table", columns: f.catalog.resources.find(r => r.table === name)!.fields.map((field, index) => ({
      name: field.name, data_type: field.type.kind === "integer" ? "integer" : "text", nullable: field.nullable,
      generated: false, ordinal_position: index + 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } })),
    primary_key: [], foreign_keys: [], unique_constraints: [], indexes: [], row_level_security: false, row_level_security_policies: [], writable: true,
    role_posture: { owner: "separate_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, insert, update: false, delete: false, truncate: false, references: false, trigger: false },
      column_privileges: { update: updates }, row_security_forced: false, row_security_effective_for_current_role: false },
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] } });
  const inspection: SchemaInspection = { engine, server_version: "test", current_user: "dedicated_writer", schemas: ["collections"],
    inspected_at: "2026-10-07T00:00:00Z", warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: false, owned_relations: [], writable_relations: ["collections.holds"], reasons: [] },
    tables: [table("customers", false, ["customer_id"]), table("holds", true, [])] };
  const policy = { outcome: f.rule.outcome, action_boundary_digest: registry.rules[0]!.action_boundary_digest,
    mode: "supervised_worker" as const, concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 3,
    proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "INSERT_TEST_WRITER",
    require_least_privilege_writer: true, writer_posture_fingerprint: rolePostureFingerprint(inspection) };
  const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [], sources: { database: {
    engine, read_url_env: "INSERT_TEST_READER", write_url_env: policy.write_url_env, receipts: { authority: "runner_ledger" } } },
    supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [policy] } };
  const assess = () => { policy.writer_posture_fingerprint = rolePostureFingerprint(inspection); return assessSemanticSupervisedWriterPosture(config, policy, registry, inspection); };
  return { registry, inspection, policy, config, assess };
}

describe("generated PostgreSQL semantic INSERT target locking requirements", () => {
  it("declares the target identity lock before generating minimum grants", () => {
    const f = insertWriter(), result = f.assess();
    expect(result.reasons).toContain("writer_row_lock_privilege_missing");
    expect(result.required_relations).toContainEqual(expect.objectContaining({ relation: "collections.holds", privileges: ["select", "insert"], update_columns: [], lock_column: "hold_id" }));
    const plan = writerProvisioningPlan({ assessment: result, inspection: f.inspection, outcome: f.policy.outcome,
      actionDigest: f.policy.action_boundary_digest, writerEnv: f.policy.write_url_env })!;
    const sql = writerProvisioningSql(plan);
    expect(sql).toContain('GRANT UPDATE ("hold_id") ON TABLE "collections"."holds"');
    expect(sql).not.toContain('GRANT UPDATE ON TABLE "collections"."holds"');
    expect(sql).not.toContain('GRANT UPDATE ("state")');
    expect(sql).toContain("real database mutation authority");
  });

  it("accepts only the exact declared identity column and refuses other or broad UPDATE", () => {
    const f = insertWriter(), target = f.inspection.tables[1]!.role_posture!;
    target.column_privileges!.update = ["hold_id"];
    expect(f.assess().ok).toBe(true);
    target.column_privileges!.update = ["hold_id", "state"];
    expect(f.assess().reasons).toContain("writer_excess_column_privilege");
    target.column_privileges!.update = ["state"];
    expect(f.assess().reasons).toContain("writer_excess_column_privilege");
    target.column_privileges!.update = [];
    target.privileges.update = true;
    expect(f.assess().reasons).toContain("writer_excess_relation_privilege");
    target.privileges.update = false;
    expect(f.assess().reasons).toContain("writer_row_lock_privilege_missing");
  });

  it("requires an applicable scoped UPDATE policy for the INSERT target lock, without a mutation WITH CHECK", () => {
    const f = insertWriter(), compiled = f.registry.rules[0]!.compiled;
    const source = { ...f.config.sources!.database!, database_scope: { mode: "postgres_rls" as const,
      tenant_setting: "app.tenant", principal_setting: "app.principal" } };
    const predicate = "tenant_id = current_setting('app.tenant') AND principal_id = current_setting('app.principal')";
    for (const table of f.inspection.tables) {
      table.row_level_security = true;
      table.row_level_security_policies = ["SELECT", "INSERT", "UPDATE"].map(command => ({ name: command, command, permissive: true,
        roles: ["dedicated_writer"], using_expression: predicate, check_expression: command === "UPDATE" ? "false" : predicate }));
      Object.assign(table.role_posture!, { row_security_forced: true, row_security_effective_for_current_role: true,
        row_security_applicable_policies: ["SELECT", "INSERT", "UPDATE"], row_security_update_permitted: true });
    }
    const assess = () => actionRuleRlsReadiness({ compiled, inspection: f.inspection, source, connection: "writer" });
    expect(assess()).toEqual([]);
    f.inspection.tables[1]!.role_posture!.row_security_applicable_policies = ["SELECT", "INSERT"];
    expect(assess()).toContainEqual({ relation: "collections.holds", reason: expect.stringContaining("POSTGRES_RLS_UPDATE_POLICY_MISSING") });
    f.inspection.tables[1]!.role_posture!.row_security_applicable_policies = ["SELECT", "INSERT", "UPDATE"];
    f.inspection.tables[1]!.row_level_security_policies!.find(p => p.command === "UPDATE")!.using_expression = "tenant_id = current_setting('app.tenant')";
    expect(assess()).toContainEqual({ relation: "collections.holds", reason: expect.stringContaining("POSTGRES_RLS_UPDATE_SETTING_MISSING:app.principal") });
  });

  it("leaves MySQL INSERT target grant requirements unchanged", () => {
    const f = insertWriter("mysql"), result = f.assess();
    expect(result.ok).toBe(true);
    const target = result.required_relations!.find(r => r.relation === "collections.holds")!;
    expect(target).toMatchObject({ privileges: ["select", "insert"], update_columns: [] });
    expect(target.lock_column).toBeUndefined();
  });
});
