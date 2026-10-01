import { describe, expect, it, vi } from "vitest";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { requiredSingletonFixture } from "../../action-rules/src/testing/required-singleton-fixture.js";
import { assertPostgresRequiredSingletonRelationship } from "./required-singleton.js";
import { postgresRlsPrerequisiteErrors } from "./index.js";

/** Synthetic adapter/catalogue playback only; live protection has its own PG gate. */
function fixture() {
  const f = requiredSingletonFixture(), compiled = compileActionRule(f);
  const parent = compiled.bindings[0]!, witness = compiled.bindings[1]!;
  let changed = false, unsupported = false, missingProof = false;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "SHOW transaction_isolation") return { rows: [{ transaction_isolation: "read committed" }], rowCount: 1 };
    if (sql === "SHOW search_path") return { rows: [{ search_path: "fixture, public" }], rowCount: 1 };
    if (sql.includes("set_config('search_path'")) return { rows: [], rowCount: 0 };
    if (sql.includes("WHERE FALSE FOR UPDATE")) return { rows: [], rowCount: 0 };
    if (sql.includes("AS declaration")) {
      const resource = f.catalog.resources.find(resource => resource.table === values?.[1])!;
      const names = values?.[2] as string[];
      return { rows: names.map(name => ({ name, declaration: { synthetic_only: true,
        field: { ...resource.fields.find(field => field.name === name)!, ...(changed ? { nullable: true } : {}) } },
        supported_type: !unsupported })), rowCount: names.length };
    }
    if (sql.includes("AS usable")) return { rows: [{ local_field: "customer_id", target_field: "customer_id", usable: true,
      required_singleton_proof: missingProof ? null : f.catalog.relationships[0]!.required_singleton_proof }], rowCount: 1 };
    throw new Error("PRIVATE_UNEXPECTED_DIAGNOSTIC_LITERAL");
  });
  return { parent, witness, query, changeDeclaration: () => { changed = true; }, unsupportedType: () => { unsupported = true; },
    missingProof: () => { missingProof = true; } };
}

describe("required singleton PostgreSQL native guard boundary (synthetic)", () => {
  it("checks both base relations, restores qualified deparse settings and retains transaction row locks", async () => {
    const f = fixture();
    await expect(assertPostgresRequiredSingletonRelationship({ query: f.query }, f.witness, f.parent, "transaction_reverify")).resolves.toBeUndefined();
    const calls = f.query.mock.calls;
    expect(calls.filter(([sql]) => sql.includes("WHERE FALSE FOR UPDATE")).map(([sql]) => sql)).toEqual([
      'SELECT "customer_id" FROM ONLY "collections"."customers" WHERE FALSE FOR UPDATE',
      'SELECT "hold_id" FROM ONLY "collections"."holds" WHERE FALSE FOR UPDATE',
    ]);
    expect(calls.filter(([sql]) => sql.includes("AS declaration"))).toHaveLength(2);
    expect(calls.findIndex(([sql]) => sql.includes("AS usable")))
      .toBeLessThan(calls.findIndex(([sql]) => sql.includes("set_config('search_path', $1")));
    expect(calls.filter(([sql]) => sql.includes("set_config('search_path'"))).toEqual([
      ["SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)"],
      ["SELECT pg_catalog.set_config('search_path', $1, true)", ["fixture, public"]],
    ]);
  });
  it("refuses unavailable native proof and restores the original qualified path after the refusal", async () => {
    const f = fixture(); f.missingProof();
    await expect(assertPostgresRequiredSingletonRelationship({ query: f.query }, f.witness, f.parent, "proposal_snapshot"))
      .rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
    expect(f.query.mock.calls.at(-1)).toEqual(["SELECT pg_catalog.set_config('search_path', $1, true)", ["fixture, public"]]);
  });
  it("uses SELECT-only catalogue inspection for the normal proposal snapshot", async () => {
    const f = fixture();
    await expect(assertPostgresRequiredSingletonRelationship({ query: f.query }, f.witness, f.parent, "proposal_snapshot")).resolves.toBeUndefined();
    expect(f.query.mock.calls.every(([sql]) => !sql.includes("FOR UPDATE"))).toBe(true);
  });
  it.each(["changed declaration", "unsupported native type"])("refuses %s even if portable values would still parse", async change => {
    const f = fixture();
    if (change === "changed declaration") f.changeDeclaration(); else f.unsupportedType();
    await expect(assertPostgresRequiredSingletonRelationship({ query: f.query }, f.witness, f.parent, "proposal_snapshot"))
      .rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("AS usable"))).toBe(false);
    expect(f.query.mock.calls.at(-1)).toEqual(["SELECT pg_catalog.set_config('search_path', $1, true)", ["fixture, public"]]);
  });
  it("keeps a raw driver failure out of the audience diagnostic", async () => {
    const f = fixture();
    const query = vi.fn(async () => { throw new Error("PRIVATE_UNEXPECTED_DIAGNOSTIC_LITERAL"); });
    try { await assertPostgresRequiredSingletonRelationship({ query }, f.witness, f.parent, "proposal_snapshot"); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
      expect(String(error)).not.toContain("PRIVATE_UNEXPECTED_DIAGNOSTIC_LITERAL");
    }
  });
  it("separates evidence lock USING from an actual effect's WITH CHECK", () => {
    const using = "tenant_id=current_setting('app.tenant') AND principal_id=current_setting('app.principal')";
    const report = { row_security_enabled: true, force_row_security: true, role_is_superuser: false,
      role_has_bypassrls: false, role_is_table_owner: false, role_can_assume_table_owner: false,
      tenant_setting: "app.tenant", principal_setting: "app.principal", required_operations: ["SELECT", "UPDATE"] as const,
      policies: ["SELECT", "UPDATE"].map(command => ({ name: command, command: command as "SELECT" | "UPDATE",
        permissive: true, using_expression: using, with_check_expression: "false" })) };
    expect(postgresRlsPrerequisiteErrors({ ...report, required_operations: [...report.required_operations], update_purpose: "row_lock" })).toEqual([]);
    expect(postgresRlsPrerequisiteErrors({ ...report, required_operations: [...report.required_operations] })).toContain("POSTGRES_RLS_UPDATE_SETTING_MISSING:app.tenant");
    expect(postgresRlsPrerequisiteErrors({ ...report, required_operations: [...report.required_operations], update_purpose: "row_lock",
      policies: report.policies.map(policy => ({ ...policy, using_expression: "true" })) })).toContain("POSTGRES_RLS_UPDATE_SETTING_MISSING:app.tenant");
  });
});
