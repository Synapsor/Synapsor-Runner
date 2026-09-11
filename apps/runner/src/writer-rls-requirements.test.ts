import { describe, expect, it } from "vitest";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { collectWriterRowScopes, type WriterRowScope } from "./writer-rls-requirements.js";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";

describe("administrator row-scope requirements", () => {
  const source = { engine: "postgres" as const, read_url_env: "DATABASE_URL", database_scope: {
    mode: "postgres_rls" as const, tenant_setting: "app.tenant", principal_setting: "app.student" } };
  it("uses compiled column roles rather than table-name guesses and carries both customer settings", () => {
    const compiled = compileActionRule(completeCollectionFixture());
    const scopes = new Map<string, WriterRowScope | null>();
    collectWriterRowScopes(compiled, source, scopes);
    expect([...scopes.values()]).toEqual(Array(2).fill([
      { field: "principal_id", setting: "app.student" }, { field: "tenant_id", setting: "app.tenant" },
    ]));
  });
  it.each(["text", "uuid"])("recovers a private %s principal column from exact inspected simple RLS", type => {
    const compiled = compileActionRule(completeCollectionFixture());
    for (const binding of compiled.bindings) {
      if (binding.verification.scope.mode === "columns") delete binding.verification.scope.principal_field;
      delete binding.resource.principal_scope_key;
    }
    delete compiled.target_resource.principal_scope_key;
    const inspection = { engine: "postgres", role_posture: { verified: true, superuser: false, bypass_rls: false },
      tables: compiled.bindings.map(binding => ({ schema: binding.resource.schema, name: binding.resource.table, type: "table",
        row_level_security: true, columns: binding.resource.fields.map(field => ({ name: field.name,
          data_type: field.name === "principal_id" ? type : "text" })),
        role_posture: { row_security_forced: true, row_security_effective_for_current_role: true,
          current_role_is_owner: false, current_role_can_assume_owner: false, row_security_applicable_policies: ["scope"] },
        row_level_security_policies: [{ name: "scope", command: "SELECT", permissive: true, roles: ["reader"],
          using_expression: `tenant_id = NULLIF(current_setting('app.tenant', true), '') AND principal_id = NULLIF(current_setting('app.student', true), '')${type === "uuid" ? "::uuid" : ""}` }],
      })) } as unknown as SchemaInspection;
    const before = structuredClone({ compiled, inspection });
    const scopes = new Map<string, WriterRowScope | null>();
    collectWriterRowScopes(compiled, source, scopes, inspection);
    expect([...scopes.values()]).toEqual(Array(2).fill([
      { field: "principal_id", setting: "app.student" }, { field: "tenant_id", setting: "app.tenant" },
    ]));
    expect({ compiled, inspection }).toEqual(before);
    for (const change of ["role", "forced", "applicability", "custom", "swapped", "extra", "unreviewed_field", "conflicting_policy", "stale_type"]) {
      const changed = structuredClone(inspection), table = changed.tables[0]!;
      if (change === "role") changed.role_posture!.bypass_rls = true;
      if (change === "forced") table.role_posture!.row_security_forced = false;
      if (change === "applicability") table.role_posture!.row_security_applicable_policies = [];
      if (change === "custom") table.row_level_security_policies![0]!.using_expression += " AND state = 'active'";
      if (change === "swapped") table.row_level_security_policies![0]!.using_expression = "principal_id = current_setting('app.tenant', true) AND tenant_id = current_setting('app.student', true)";
      if (change === "extra") table.row_level_security_policies![0]!.using_expression += " OR true";
      if (change === "unreviewed_field") table.row_level_security_policies![0]!.using_expression = "tenant_id = current_setting('app.tenant', true) AND secret_id = current_setting('app.student', true)";
      if (change === "conflicting_policy") table.row_level_security_policies!.push({ ...table.row_level_security_policies![0]!, name: "different", using_expression: "true" });
      if (change === "stale_type") {
        table.columns.find(field => field.name === "principal_id")!.data_type = "text";
        table.row_level_security_policies![0]!.using_expression = "tenant_id = current_setting('app.tenant', true) AND principal_id = current_setting('app.student', true)::uuid";
      }
      const refused = new Map<string, WriterRowScope | null>();
      collectWriterRowScopes(compiled, source, refused, changed);
      expect(refused.get("collections.customers"), change).toBeNull();
    }
  });
  it.each(["inherited", "indirect_principal", "conflicting_field", "conflicting_setting", "effect_principal"])("does not generate a guessed policy for %s", change => {
    const compiled = compileActionRule(completeCollectionFixture());
    const scopes = new Map<string, WriterRowScope | null>();
    collectWriterRowScopes(compiled, source, scopes);
    if (change === "inherited") compiled.bindings[0]!.verification.scope = { mode: "inherited", from_binding: "other" };
    if (change === "indirect_principal" && compiled.bindings[0]!.verification.scope.mode === "columns") delete compiled.bindings[0]!.verification.scope.principal_field;
    if (change === "conflicting_field" && compiled.bindings[0]!.verification.scope.mode === "columns") compiled.bindings[0]!.verification.scope.principal_field = "different_student";
    if (change === "effect_principal") delete compiled.target_resource.principal_scope_key;
    collectWriterRowScopes(compiled, change === "conflicting_setting" ? { ...source, database_scope: { ...source.database_scope, principal_setting: "different.identity" } } : source, scopes);
    expect(scopes.get("collections.customers")).toBeNull();
    collectWriterRowScopes(compileActionRule(completeCollectionFixture()), source, scopes);
    expect(scopes.get("collections.customers")).toBeNull();
  });
});
