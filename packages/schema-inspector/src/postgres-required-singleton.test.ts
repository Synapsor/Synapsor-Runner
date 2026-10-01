import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabaseWithConnection, schemaFingerprintForInspection, type SchemaInspectionConnection } from "./index.js";

// Borrowed catalogue adapter responses; this file opens no database connection.
const proof = {
  child_unique_key: "witness_pk", child_unique_index: "witness_pk",
  parent_unique_key: "subject_pk", parent_unique_index: "subject_pk",
};
const declaration = {
  type_schema: "pg_catalog", type_name: "text", type_modifier: -1, nullable: false,
  collation_schema: "pg_catalog", collation_name: "default", generated: "", identity: "",
  default_expression: null, enum_values: [], domain_checks: [], table_checks: [],
};
const fk = {
  schema: "app", table_name: "witness", constraint_name: "witness_subject_fk", column_name: "id",
  referenced_schema: "app", referenced_table: "subject", referenced_column: "id", ordinal_position: 1,
  delete_rule: "NO ACTION", validated: true, deferrable: false, exact_equality: true,
  required_singleton_proof: proof,
};
async function inspect(options: { foreignKeys?: unknown[]; native?: unknown; columns?: unknown[] } = {}) {
  const query = vi.fn(async (sql: string) => {
    let rows: unknown[] = [];
    if (sql.includes("SELECT version()")) rows = [{ version: "PostgreSQL 17.10", current_user: "reader", superuser: false, bypass_rls: false }];
    else if (sql.includes("FROM information_schema.schemata")) rows = [{ schema_name: "app" }];
    else if (sql.includes("FROM information_schema.tables")) rows = ["subject", "witness"].map(name => ({ schema: "app", name, type: "BASE TABLE" }));
    else if (sql.includes("FROM information_schema.columns")) rows = options.columns ?? ["subject", "witness"].map(table_name => ({
      schema: "app", table_name, name: "id", data_type: "text", udt_name: "text", is_nullable: "NO", ordinal_position: 1,
      postgres_declaration: Object.hasOwn(options, "native") ? options.native : declaration,
    }));
    else if (sql.includes("AS constraint_type")) rows = options.columns ?? ["subject", "witness"].map(table_name => ({ schema: "app", table_name, constraint_name: `${table_name}_pk`, constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }));
    else if (sql.includes("source_ns.nspname AS schema")) rows = options.foreignKeys ?? [fk];
    return { rows };
  });
  const result = await inspectDatabaseWithConnection({ engine: "postgres", databaseUrlEnv: "TEST_URL", schema: "app", env: { TEST_URL: "postgresql://example.invalid/test" } }, {
    engine: "postgres", connection: { query } as unknown as SchemaInspectionConnection["connection"],
  } as SchemaInspectionConnection);
  return { result, statements: query.mock.calls.map(call => call[0]) };
}

describe("finite native required-singleton catalogue publication", () => {
  it("preserves the named positive FK proof in both catalogue directions", async () => {
    const { result } = await inspect();
    expect(result.tables.find(t => t.name === "witness")!.foreign_keys[0]).toHaveProperty("required_singleton_proof", proof);
    expect(result.tables.find(t => t.name === "subject")!.referenced_by![0]).toHaveProperty("required_singleton_proof", proof);
    expect(result.tables.find(t => t.name === "witness")!.primary_key).toEqual(["id"]);
  });
  it.each([
    ["absent", undefined], ["null", null], ["boolean", true], ["array", []], ["missing key", { child_unique_key: "witness_pk" }],
    ["extra key", { ...proof, approved: true }], ["empty name", { ...proof, child_unique_key: "" }],
    ["NUL name", { ...proof, child_unique_key: "a\0b" }], ["overlong identifier", { ...proof, child_unique_key: "x".repeat(64) }],
    ["nonstring", { ...proof, parent_unique_index: 1 }],
  ])("omits malformed or unknown optional proof: %s", async (_label, value) => {
    const { result } = await inspect({ foreignKeys: [{ ...fk, required_singleton_proof: value }] });
    const outgoing = result.tables.find(t => t.name === "witness")!.foreign_keys[0]!;
    expect(outgoing).not.toHaveProperty("required_singleton_proof");
    expect(result.tables.find(t => t.name === "subject")!.referenced_by![0]).not.toHaveProperty("required_singleton_proof");
    expect(outgoing.columns).toEqual(["id"]); // Legacy metadata is still usable by its existing consumers.
  });
  it.each([
    ["unvalidated", { validated: false }], ["unknown validation", { validated: undefined }], ["deferred", { deferrable: true }],
    ["unknown deferral", { deferrable: undefined }], ["inexact", { exact_equality: false }], ["unknown equality", { exact_equality: undefined }],
    ["wrong ordinal", { ordinal_position: 2 }], ["boolean ordinal", { ordinal_position: true }],
    ["different action", { delete_rule: "CASCADE" }], ["missing exact route", { referenced_column: undefined }],
  ])("does not project a positive proof with contradictory/unknown raw flags: %s", async (_label, change) => {
    const { result } = await inspect({ foreignKeys: [{ ...fk, ...change }] });
    expect(result.tables.find(t => t.name === "witness")!.foreign_keys[0]).not.toHaveProperty("required_singleton_proof");
  });
  it("refuses a composite or duplicated FK proof without changing legacy pairs", async () => {
    const { result } = await inspect({ foreignKeys: [fk, { ...fk, column_name: "tenant_id", referenced_column: "tenant_id", ordinal_position: 2 }] });
    const relation = result.tables.find(t => t.name === "witness")!.foreign_keys[0]!;
    expect(relation.columns).toEqual(["id", "tenant_id"]);
    expect(relation).not.toHaveProperty("required_singleton_proof");
    const duplicated = await inspect({ foreignKeys: [fk, fk] });
    expect(duplicated.result.tables.find(t => t.name === "witness")!.foreign_keys[0]).not.toHaveProperty("required_singleton_proof");
  });
  it("binds the optional proof names into the whole-schema fingerprint", async () => {
    const a = await inspect();
    const b = await inspect({ foreignKeys: [{ ...fk, required_singleton_proof: { ...proof, child_unique_index: "replacement" } }] });
    expect(schemaFingerprintForInspection(a.result)).not.toEqual(schemaFingerprintForInspection(b.result));
  });
  it("publishes only a digest of a supported native declaration and fingerprints it", async () => {
    const a = await inspect();
    const column = a.result.tables[0]!.columns[0]!;
    expect(column).toHaveProperty("postgres_declaration_digest", canonicalJsonDigest(declaration));
    expect(column).not.toHaveProperty("postgres_declaration");
    const b = await inspect({ native: { ...declaration, default_expression: "'constant'::text" } });
    expect(schemaFingerprintForInspection(a.result)).not.toEqual(schemaFingerprintForInspection(b.result));
  });
  it.each([
    ["missing", undefined], ["null", null], ["raw flag", true], ["missing field", { type_schema: "pg_catalog", type_name: "text" }],
    ["extra field", { ...declaration, accepted: true }], ["domain", { ...declaration, type_schema: "app", type_name: "my_domain" }],
    ["enum", { ...declaration, type_schema: "app", type_name: "state", enum_values: ["open"] }],
    ["custom base", { ...declaration, type_schema: "app" }], ["unsupported scalar", { ...declaration, type_name: "uuid" }],
    ["array", { ...declaration, type_name: "_text" }], ["bad modifier", { ...declaration, type_modifier: "-1" }], ["custom collation", { ...declaration, collation_schema: "app", collation_name: "custom" }],
    ["bad check", { ...declaration, table_checks: [{ name: "guard", definition: "CHECK (true)", validated: true, no_inherit: false, approved: true }] }],
  ])("omits unsupported or malformed native declarations: %s", async (_label, value) => {
    const { result } = await inspect({ native: value });
    expect(result.tables[0]!.columns[0]).not.toHaveProperty("postgres_declaration_digest");
    expect(result.tables[0]!.columns[0]).toHaveProperty("data_type", "text");
  });
  it("stamps original-shaped scalar scope/material columns and native constant defaults", async () => {
    const columns = [
      ...["id", "tenant_id", "principal_id"].map((name, index) => ({ schema: "app", table_name: "witness", name, data_type: "text", udt_name: "text", is_nullable: "NO", ordinal_position: index + 1, postgres_declaration: declaration })),
      { schema: "app", table_name: "witness", name: "allowed", data_type: "boolean", udt_name: "bool", is_nullable: "NO", ordinal_position: 4, postgres_declaration: { ...declaration, type_name: "bool", collation_schema: null, collation_name: null } },
      { schema: "app", table_name: "witness", name: "capacity", data_type: "integer", udt_name: "int4", is_nullable: "NO", ordinal_position: 5, postgres_declaration: { ...declaration, type_name: "int4", collation_schema: null, collation_name: null } },
      { schema: "app", table_name: "witness", name: "version", data_type: "integer", udt_name: "int4", is_nullable: "NO", ordinal_position: 6, column_default: "1", postgres_declaration: { ...declaration, type_name: "int4", collation_schema: null, collation_name: null, default_expression: "1" } },
    ];
    const { result } = await inspect({ columns });
    const material = result.tables.find(t => t.name === "witness")!.columns;
    expect(material.map(c => c.name)).toEqual(["id", "tenant_id", "principal_id", "allowed", "capacity", "version"]);
    expect(material.map(c => c.postgres_declaration_digest)).toEqual(columns.map(c => canonicalJsonDigest(c.postgres_declaration)));
    expect(material[5]).toHaveProperty("default", "1");
  });
  it.each(["custom type", "custom default/check dependency", "nondeterministic collation", "temporary relation", "custom access method", "unenforced FK", "unknown enforcement"])("keeps unsupported SQL-projection state absent without deleting legacy metadata: %s", async () => {
    // Actual CASE/subquery returns NULL in these cases. This tests the adapter
    // contract only; live SQL qualification needs the separately owned PG matrix.
    const { result } = await inspect({ native: null, foreignKeys: [{ ...fk, required_singleton_proof: null }] });
    const child = result.tables.find(t => t.name === "witness")!;
    expect(child.columns[0]).toHaveProperty("data_type", "text");
    expect(child.columns[0]).not.toHaveProperty("postgres_declaration_digest");
    expect(child.foreign_keys[0]).toHaveProperty("columns", ["id"]);
    expect(child.foreign_keys[0]).not.toHaveProperty("required_singleton_proof");
  });
  it("retains an original-shaped parent enum in legacy metadata without stamping it", async () => {
    const { result } = await inspect({ columns: [
      { schema: "app", table_name: "subject", name: "id", data_type: "text", is_nullable: "NO", ordinal_position: 1, postgres_declaration: declaration },
      { schema: "app", table_name: "subject", name: "status", data_type: "USER-DEFINED", udt_name: "unit_status", is_nullable: "NO", ordinal_position: 2, enum_values: ["open", "ready", "held", "closed"], postgres_declaration: null },
      { schema: "app", table_name: "witness", name: "id", data_type: "text", is_nullable: "NO", ordinal_position: 1, postgres_declaration: declaration },
    ] });
    const parent = result.tables.find(t => t.name === "subject")!;
    expect(parent.columns.map(c => c.name)).toEqual(["id", "status"]);
    expect(parent.columns[0]).toHaveProperty("postgres_declaration_digest", canonicalJsonDigest(declaration));
    expect(parent.columns[1]).toHaveProperty("enum_values", ["open", "ready", "held", "closed"]);
    expect(parent.columns[1]).not.toHaveProperty("postgres_declaration_digest");
  });
  it.each([
    ["nullability", { nullable: true }], ["type modifier", { type_modifier: 12 }],
    ["native default", { default_expression: "'x'::text" }], ["collation", { collation_name: "C" }],
    ["generated", { generated: "s" }], ["identity", { identity: "a" }],
    ["check", { table_checks: [{ name: "guard", definition: "CHECK (length(id) <= 64)", validated: true, no_inherit: false }] }],
  ])("binds supported structural change into digest: %s", async (_label, change) => {
    const value = { ...declaration, ...change };
    const { result } = await inspect({ columns: [{ schema: "app", table_name: "subject", name: "id", data_type: "text", is_nullable: value.nullable ? "YES" : "NO", ordinal_position: 1, postgres_declaration: value }] });
    expect(result.tables[0]!.columns[0]).toHaveProperty("postgres_declaration_digest", canonicalJsonDigest(value));
    expect(canonicalJsonDigest(value)).not.toEqual(canonicalJsonDigest(declaration));
  });
  it("keeps deparse local and advertises the actual finite SQL qualification", async () => {
    const { statements } = await inspect();
    const fkSql = statements.find(sql => sql.includes("source_ns.nspname AS schema"))!;
    for (const token of ["required_singleton_proof", "indislive", "indimmediate", "pg_inherits", "session_replication_role", "RI_FKey_check_ins", "opcdefault", "relpersistence", "amname='heap'", "conenforced", "server_version_num", "varchar", "text", "confdeltype='a'", "confupdtype='a'"]) expect(fkSql).toContain(token);
    const columnSql = statements.find(sql => sql.includes("FROM information_schema.columns"))!;
    for (const token of ["postgres_declaration", "pg_depend", "typtype", "typelem", "typbasetype", "attndims", "collisdeterministic", "collnamespace='pg_catalog'", "relpersistence", "amname='heap'"]) expect(columnSql).toContain(token);
    const pathIndex = statements.indexOf("SET LOCAL search_path = pg_catalog");
    expect(pathIndex).toBeGreaterThan(statements.indexOf("BEGIN READ ONLY"));
    expect(pathIndex).toBeLessThan(statements.indexOf(columnSql));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements).not.toContain("SET search_path = pg_catalog");
  });
});
