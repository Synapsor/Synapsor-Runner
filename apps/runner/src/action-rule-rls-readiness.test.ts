import { describe, expect, it } from "vitest";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { actionRuleRlsReadiness } from "./action-rule-rls-readiness.js";

function fixture() {
  const compiled = compileActionRule(completeCollectionFixture());
  const predicate = "tenant_id = current_setting('app.tenant') AND principal_id = current_setting('app.principal')";
  const tables = compiled.bindings.map(binding => ({ schema: binding.resource.schema, name: binding.resource.table, type: "table",
    row_level_security: true,
    row_level_security_policies: ["SELECT", "UPDATE"].map(command => ({ name: command, command, permissive: true, roles: ["role"], using_expression: predicate, check_expression: predicate })),
    role_posture: { current_role_is_owner: false, current_role_can_assume_owner: false, row_security_forced: true,
      row_security_effective_for_current_role: true, row_security_applicable_policies: ["SELECT", "UPDATE"] } } as TableInfo));
  const inspection = { engine: "postgres", tables, role_posture: { verified: true, superuser: false, bypass_rls: false } } as SchemaInspection;
  const source = { engine: "postgres" as const, read_url_env: "DATABASE_URL", database_scope: {
    mode: "postgres_rls" as const, tenant_setting: "app.tenant", principal_setting: "app.principal" } };
  return { compiled, inspection, source, connection: "reader" as const };
}

describe("Action RLS readiness matches runtime prerequisites", () => {
  it("needs no runtime identity and checks read versus write policies separately", () => {
    const f = fixture();
    expect(actionRuleRlsReadiness(f)).toEqual([]);
    expect(actionRuleRlsReadiness({ ...f, connection: "writer" })).toEqual([]);
    f.inspection.tables[0]!.role_posture!.row_security_applicable_policies = ["SELECT"];
    expect(actionRuleRlsReadiness(f)).toEqual([]);
    expect(actionRuleRlsReadiness({ ...f, connection: "writer" })).toMatchObject([{ reason: expect.stringContaining("UPDATE_POLICY_MISSING") }]);
  });
  it("rejects enabled but unforced RLS even when effective for a non-owner role", () => {
    const f = fixture();
    f.inspection.tables[0]!.role_posture!.row_security_forced = false;
    const before = structuredClone(f);
    expect(actionRuleRlsReadiness(f)).toEqual([{ relation: `${f.inspection.tables[0]!.schema}.${f.inspection.tables[0]!.name}`,
      reason: expect.stringContaining("FORCE ROW LEVEL SECURITY is required but not enabled") }]);
    expect(f).toEqual(before);
  });
  it("does not demand mutation WITH CHECK predicates for a verification-only bounded binding", () => {
    const f = fixture();
    const binding = f.compiled.bindings.find(binding => binding.verification.collection_consistency === "complete_locked")!;
    delete binding.verification.collection_consistency;
    const table = f.inspection.tables.find(table => table.schema === binding.resource.schema && table.name === binding.resource.table)!;
    table.row_level_security_policies!.find(policy => policy.command === "UPDATE")!.check_expression = "false";
    expect(actionRuleRlsReadiness({ ...f, connection: "writer" })).toEqual([]);
  });
  it.each(["reader", "writer"] as const)("accepts a uniquely linked tenant-only shared reference for the %s without relaxing customer or effect checks", connection => {
    const f = fixture();
    const shared = structuredClone(f.compiled.bindings[0]!);
    shared.binding = shared.verification.binding = "section";
    shared.resource.name = shared.verification.resource = "collections.sections";
    shared.resource.table = "sections";
    delete shared.resource.principal_scope_key;
    shared.verification.scope = { mode: "columns", tenant_field: "tenant_id" };
    const pairs = [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "customer_id", target_field: "customer_id" }];
    shared.verification.source = { kind: "relationship", from_binding: "customer", relationship: "customer_section_fk", direction: "forward", field_pairs: pairs };
    shared.relationship = { name: "customer_section_fk", from_resource: "collections.customers", to_resource: "collections.sections",
      cardinality: "many_to_one", target_unique: true, nullable: false, field_pairs: pairs };
    f.compiled.bindings.push(shared);
    const table = structuredClone(f.inspection.tables[0]!);
    table.name = "sections";
    for (const policy of table.row_level_security_policies!) {
      policy.using_expression = policy.check_expression = "tenant_id = current_setting('app.tenant')";
    }
    f.inspection.tables.push(table);
    const before = structuredClone(f);
    expect(actionRuleRlsReadiness({ ...f, connection })).toEqual([]);
    expect(f).toEqual(before);
    const strict = structuredClone(shared);
    strict.binding = strict.verification.binding = "direct_section";
    strict.verification.source = { kind: "subject_ref" };
    f.compiled.bindings.push(strict);
    for (let order = 0; order < 2; order++) {
      expect(actionRuleRlsReadiness({ ...f, connection })).toContainEqual({ relation: "collections.sections",
        reason: expect.stringContaining("POSTGRES_RLS_SELECT_SETTING_MISSING:app.principal") });
      f.compiled.bindings.reverse();
    }
    f.compiled.bindings = f.compiled.bindings.filter(binding => binding !== strict);
    f.inspection.tables[0]!.row_level_security_policies![0]!.using_expression = "tenant_id = current_setting('app.tenant')";
    expect(actionRuleRlsReadiness({ ...f, connection })).toContainEqual({ relation: "collections.customers",
      reason: expect.stringContaining("POSTGRES_RLS_SELECT_SETTING_MISSING:app.principal") });
    if (connection === "writer") {
      const originalTarget = f.compiled.target_resource;
      f.compiled.target_resource = shared.resource;
      expect(actionRuleRlsReadiness({ ...f, connection })).toContainEqual({ relation: "collections.sections",
        reason: expect.stringContaining("POSTGRES_RLS_SELECT_SETTING_MISSING:app.principal") });
      f.compiled.target_resource = originalTarget;
      f.compiled.atomic_updates = [{ target_resource: shared.resource, effect_field_types: {} }];
      expect(actionRuleRlsReadiness({ ...f, connection })).toContainEqual({ relation: "collections.sections",
        reason: expect.stringContaining("POSTGRES_RLS_SELECT_SETTING_MISSING:app.principal") });
    }
  });
  it.each(["owner", "bypass", "missing_policy", "missing_setting", "unknown"])("refuses %s metadata before execution review", issue => {
    const f = fixture(), table = f.inspection.tables[0]!;
    if (issue === "owner") table.role_posture!.current_role_can_assume_owner = true;
    if (issue === "bypass") f.inspection.role_posture!.bypass_rls = true;
    if (issue === "missing_policy") table.row_level_security_policies = [];
    if (issue === "missing_setting") table.row_level_security_policies![0]!.using_expression = "tenant_id = current_setting('app.tenant')";
    if (issue === "unknown") delete table.role_posture!.row_security_applicable_policies;
    expect(actionRuleRlsReadiness(f).length).toBeGreaterThan(0);
  });
  it("does not invent a PostgreSQL RLS requirement for application-scoped or MySQL sources", () => {
    const f = fixture();
    expect(actionRuleRlsReadiness({ ...f, source: { engine: "postgres" } })).toEqual([]);
    expect(actionRuleRlsReadiness({ ...f, inspection: { ...f.inspection, engine: "mysql" } })).toEqual([]);
  });
});
