import { describe, expect, it } from "vitest";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { collectWriterRowScopes, type WriterRowScope } from "./writer-rls-requirements.js";

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
