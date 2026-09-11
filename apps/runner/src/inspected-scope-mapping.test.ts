import { describe, expect, it } from "vitest";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { collectWriterRowScopes, type WriterRowScope } from "./writer-rls-requirements.js";
import { inspectedPostgresScopeMapping } from "./inspected-scope-mapping.js";

function fixture(type = "uuid", schema = "opaque", tableName = "r8", tenant = "q2", principal = "q1") {
  const expression = `${tenant} = NULLIF(current_setting('app.group', true), '')${type === "uuid" ? "::uuid" : ""} AND ${principal} = NULLIF(current_setting('app.person', true), '')${type === "uuid" ? "::uuid" : ""}`;
  const table: TableInfo = { schema, name: tableName, type: "table", writable: true, row_level_security: true,
    columns: [tenant, principal, "other"].map((name, index) => ({ name, data_type: type, nullable: false, generated: false,
      ordinal_position: index + 1, comment: "Obsolete UI label, not identity evidence", suggestions: { tenant: false, conflict: false,
        sensitive: false, immutable: false, large_or_binary: false } })),
    primary_key: [], unique_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] },
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
      row_security_forced: true, row_security_effective_for_current_role: true, row_security_applicable_policies: ["own"] },
    row_level_security_policies: [{ name: "own", command: "SELECT", permissive: true, roles: ["reader"], using_expression: expression }] };
  const inspection: SchemaInspection = { engine: "postgres", server_version: "16", current_user: "reader",
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    inspected_at: "2026-09-11T00:00:00Z", schemas: [schema], tables: [table], warnings: [] };
  return { inspection, resource: { schema, table: tableName, fields: [tenant, principal, "other"] },
    tenantField: tenant, tenantSetting: "app.group", principalSetting: "app.person" };
}

describe("closed inspected PostgreSQL scope mapping", () => {
  it.each(["text", "uuid"])("proves exact %s identity roles without names, values, SQL egress or mutation", type => {
    const input = fixture(type), before = structuredClone(input), result = inspectedPostgresScopeMapping(input);
    expect(result).toMatchObject({ tenant: { field: "q2", setting: "app.group" }, principal: { field: "q1", setting: "app.person" }, policy_names: ["own"] });
    expect(result?.policy_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/current_setting|NULLIF|Obsolete/);
    expect(input).toEqual(before);
  });

  it("works for renamed tables and reversed lexical field order", () => {
    const result = inspectedPostgresScopeMapping(fixture("uuid", "inventory", "reservations", "z_owner", "a_actor"));
    expect(result?.tenant.field).toBe("z_owner");
    expect(result?.principal.field).toBe("a_actor");
  });

  it.each(["ALL", "SELECT"])("accepts only an exact applicable permissive %s policy", command => {
    const input = fixture();
    input.inspection.tables[0]!.row_level_security_policies![0]!.command = command;
    expect(inspectedPostgresScopeMapping(input)?.principal.field).toBe("q1");
  });

  it.each(["missing_inspection", "mysql", "unverified", "superuser", "bypass", "owner", "assume_owner", "rls_off", "rls_unknown",
    "force_off", "force_unknown", "effective_off", "effective_unknown", "view", "other_schema", "other_table", "duplicate_table",
    "duplicate_column", "duplicate_candidate", "unreviewed_column", "tenant_missing", "same_setting", "empty_setting", "no_policy", "not_applicable",
    "restrictive", "missing_expression", "extra_business_fact", "or_true", "swapped", "broad_all", "duplicate_policy", "unknown_command", "uuid_type_changed"])(
    "does not produce scope proof for %s", change => {
      const input = fixture(), table = input.inspection.tables[0]!, role = input.inspection.role_posture!, posture = table.role_posture!;
      if (change === "missing_inspection") return expect(inspectedPostgresScopeMapping({ ...input, inspection: undefined })).toBeUndefined();
      if (change === "mysql") input.inspection.engine = "mysql";
      if (change === "unverified") role.verified = false;
      if (change === "superuser") role.superuser = true;
      if (change === "bypass") role.bypass_rls = true;
      if (change === "owner") posture.current_role_is_owner = true;
      if (change === "assume_owner") posture.current_role_can_assume_owner = true;
      if (change === "rls_off") table.row_level_security = false;
      if (change === "rls_unknown") table.row_level_security = "unknown";
      if (change === "force_off") posture.row_security_forced = false;
      if (change === "force_unknown") posture.row_security_forced = "unknown";
      if (change === "effective_off") posture.row_security_effective_for_current_role = false;
      if (change === "effective_unknown") posture.row_security_effective_for_current_role = "unsupported";
      if (change === "view") table.type = "view";
      if (change === "other_schema") table.schema = "another";
      if (change === "other_table") table.name = "another";
      if (change === "duplicate_table") input.inspection.tables.push(structuredClone(table));
      if (change === "duplicate_column") table.columns.push(structuredClone(table.columns[1]!));
      if (change === "duplicate_candidate") input.resource.fields.push("q1");
      if (change === "unreviewed_column") input.resource.fields = ["q2", "other"];
      if (change === "tenant_missing") table.columns = table.columns.filter(column => column.name !== "q2");
      if (change === "same_setting") input.principalSetting = input.tenantSetting;
      if (change === "empty_setting") input.principalSetting = "";
      if (change === "no_policy") table.row_level_security_policies = [];
      if (change === "not_applicable") posture.row_security_applicable_policies = [];
      if (change === "restrictive") table.row_level_security_policies![0]!.permissive = false;
      if (change === "missing_expression") delete table.row_level_security_policies![0]!.using_expression;
      if (change === "extra_business_fact") table.row_level_security_policies![0]!.using_expression += " AND state = 'ready'";
      if (change === "or_true") table.row_level_security_policies![0]!.using_expression += " OR true";
      if (change === "swapped") table.row_level_security_policies![0]!.using_expression = "q1 = current_setting('app.group', true)::uuid AND q2 = current_setting('app.person', true)::uuid";
      if (change === "broad_all") table.row_level_security_policies!.push({ ...table.row_level_security_policies![0]!, name: "broad", command: "ALL", using_expression: "true" });
      if (change === "duplicate_policy") table.row_level_security_policies!.push(structuredClone(table.row_level_security_policies![0]!));
      if (change === "unknown_command") table.row_level_security_policies![0]!.command = "custom";
      if (change === "uuid_type_changed") table.columns[1]!.data_type = "text";
      expect(inspectedPostgresScopeMapping(input)).toBeUndefined();
    });

  it("does not treat unrelated UPDATE metadata as a SELECT business condition", () => {
    const input = fixture();
    input.inspection.tables[0]!.row_level_security_policies!.push({ name: "writer_lock", command: "UPDATE", permissive: true,
      roles: ["dedicated_writer"], using_expression: "state = 'ready'" });
    expect(inspectedPostgresScopeMapping(input)?.policy_names).toEqual(["own"]);
  });

  it.each(["exact", "broad_all", "unknown_forced"])("shares the writer's conservative fallback for %s", change => {
    const compiled = compileActionRule(completeCollectionFixture());
    const first = compiled.bindings[0]!.resource;
    const input = fixture("text", first.schema, first.table, "tenant_id", "principal_id");
    for (const binding of compiled.bindings) {
      if (binding.verification.scope.mode === "columns") delete binding.verification.scope.principal_field;
      delete binding.resource.principal_scope_key;
    }
    delete compiled.target_resource.principal_scope_key;
    const table = input.inspection.tables[0]!;
    if (change === "broad_all") table.row_level_security_policies!.push({ name: "broad", command: "ALL", permissive: true, roles: ["reader"], using_expression: "true" });
    if (change === "unknown_forced") table.role_posture!.row_security_forced = "unknown";
    const result = new Map<string, WriterRowScope | null>();
    collectWriterRowScopes(compiled, { engine: "postgres", read_url_env: "DATABASE_URL", database_scope: {
      mode: "postgres_rls", tenant_setting: "app.group", principal_setting: "app.person" } }, result, input.inspection);
    expect(result.get(`${first.schema}.${first.table}`)).toEqual(change === "exact"
      ? [{ field: "principal_id", setting: "app.person" }, { field: "tenant_id", setting: "app.group" }] : null);
  });
});
