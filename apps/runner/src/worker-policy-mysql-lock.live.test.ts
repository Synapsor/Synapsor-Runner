import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import { createActionRuleAuthority } from "../../../packages/action-rules/src/authority.js";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";
import { writerProvisioningPlan, writerProvisioningSql } from "./writer-provisioning.js";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";

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

// Own disposable server only. Accounts and rows are preserved for inspection.
const adminUrl = process.env.B66_MYSQL_ADMIN_URL;
describe.skipIf(!adminUrl)("B66 native MySQL exact lock-column writer authority", () => {
  it("admits reviewed lock UPDATE and rejects table-wide, extra-column and extra-table authority", async () => {
    const admin = await mysql.createConnection(adminUrl!);
    const user = `b66_${crypto.randomBytes(6).toString("hex")}`;
    const password = crypto.randomBytes(24).toString("hex");
    let writer: mysql.Connection | undefined;
    try {
      await admin.query("CREATE DATABASE IF NOT EXISTS collections");
      await admin.query("CREATE TABLE IF NOT EXISTS collections.customers (customer_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL, state varchar(16) NOT NULL, version int NOT NULL) ENGINE=InnoDB");
      await admin.query("CREATE TABLE IF NOT EXISTS collections.holds (hold_id varchar(64) PRIMARY KEY, customer_id varchar(64) NOT NULL, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL, state varchar(16) NOT NULL) ENGINE=InnoDB");
      await admin.query("CREATE TABLE IF NOT EXISTS collections.unreviewed (id int PRIMARY KEY)");
      await admin.query("INSERT IGNORE INTO collections.customers VALUES ('c1', 't1', 'p1', 'active', 1)");
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`);
      await admin.query(`GRANT SELECT ON collections.customers TO '${user}'@'%'`);
      await admin.query(`GRANT SELECT, INSERT ON collections.holds TO '${user}'@'%'`);
      const writerUrl = new URL(adminUrl!); writerUrl.username = user; writerUrl.password = password; writerUrl.pathname = "/collections";
      const f = insertWriter("mysql");
      const inspect = () => inspectDatabase({ engine: "mysql", databaseUrlEnv: "B66_WRITER", env: { B66_WRITER: writerUrl.href } });
      const assess = async () => {
        const inspection = await inspect();
        f.policy.writer_posture_fingerprint = rolePostureFingerprint(inspection);
        return { inspection, result: assessSemanticSupervisedWriterPosture(f.config, f.policy, f.registry, inspection) };
      };
      expect((await assess()).result.reasons).toContain("writer_row_lock_privilege_missing");
      await admin.query(`GRANT UPDATE (customer_id) ON collections.customers TO '${user}'@'%'`);
      writer = await mysql.createConnection(writerUrl.href);
      await writer.beginTransaction();
      expect((await writer.query<mysql.RowDataPacket[]>("SELECT customer_id FROM customers WHERE customer_id='c1' FOR UPDATE"))[0]).toHaveLength(1);
      await writer.rollback();
      const narrow = await assess();
      expect(narrow.result.reasons).toEqual([]);
      expect(narrow.inspection.tables.find(t => t.name === "customers")?.role_posture).toMatchObject({ privileges: { update: false }, column_privileges: { update: ["customer_id"] } });
      const plan = writerProvisioningPlan({ assessment: narrow.result, inspection: narrow.inspection, outcome: f.policy.outcome, actionDigest: f.policy.action_boundary_digest, writerEnv: f.policy.write_url_env });
      expect(plan).toBeDefined();
      expect(writerProvisioningSql(plan!)).toContain("GRANT UPDATE (`customer_id`) ON `collections`.`customers`");
      await admin.query(`GRANT UPDATE ON collections.customers TO '${user}'@'%'`);
      expect((await assess()).result.reasons).toContain("writer_excess_relation_privilege");
      await admin.query(`REVOKE UPDATE ON collections.customers FROM '${user}'@'%'`);
      await admin.query(`GRANT UPDATE (customer_id, state) ON collections.customers TO '${user}'@'%'`);
      expect((await assess()).result.reasons).toContain("writer_excess_column_privilege");
      await admin.query(`REVOKE UPDATE (state) ON collections.customers FROM '${user}'@'%'`);
      await admin.query(`GRANT UPDATE (id) ON collections.unreviewed TO '${user}'@'%'`);
      expect((await assess()).result.reasons).toContain("writer_unreviewed_relation_privilege");
      expect((await admin.query<mysql.RowDataPacket[]>("SELECT * FROM collections.customers"))[0]).toEqual([{ customer_id: "c1", tenant_id: "t1", principal_id: "p1", state: "active", version: 1 }]);
    } finally { await writer?.end(); await admin.end(); }
  });
});
