import { describe, expect, it, vi } from "vitest";
import { inspectDatabaseWithConnection, type SchemaInspectionConnection } from "./index.js";

// Metadata-only connector characterization. The complete catalog is declared
// independently of the selected pack; no source value query or provider exists.
describe("B64 complete inspected Source inventory", () => {
  it.each(["tenant_id", "c7"])("retains an omitted foreign-schema %s field without a naming filter", async field => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT version()")) return { rows: [{ version: "PostgreSQL 16.2", current_user: "reader", superuser: false, bypass_rls: false }], rowCount: 1 };
      if (sql.includes("pg_catalog.pg_attribute a") && sql.includes("AS row_level_security")) return { rows: [
        { schema: "public", table_name: "selected", column_name: "id", row_level_security: false },
        { schema: "private_scope", table_name: "omitted", column_name: field, row_level_security: true },
      ], rowCount: 2 };
      if (sql.includes("c.relrowsecurity OR EXISTS")) return { rows: [{ schema: "private_scope", table_name: "omitted" }], rowCount: 1 };
      if (sql.includes("AS can_write_relation")) return { rows: [{ owns_relation: false, can_write_relation: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const source = { engine: "postgres", connection: { query } } as unknown as SchemaInspectionConnection;
    const inspection = await inspectDatabaseWithConnection({ engine: "postgres", databaseUrlEnv: "TEST_DATABASE_URL",
      env: { TEST_DATABASE_URL: "postgres://inert.invalid/metadata_fixture" },
      resources: [{ schema: "public", table: "selected" }], verifySingleOrganization: true }, source);
    const inventory = Reflect.get(inspection, "inspected_source_inventory");
    expect(inventory).toMatchObject({ schema_version: "synapsor.inspected-source-inventory.v1", engine: "postgres",
      scope: { kind: "database" }, coverage: "complete", resources: expect.arrayContaining([
        { schema: "private_scope", table: "omitted", columns: [field], row_level_security: true },
      ]) });
    const catalogSql = query.mock.calls.map(call => call[0]).filter(sql => sql.includes("pg_catalog.pg_attribute a") && sql.includes("AS row_level_security"));
    expect(catalogSql).toHaveLength(1);
    expect(catalogSql[0]).not.toContain("lower(a.attname)");
    expect(query.mock.calls.some(call => /FROM\s+private_scope\.omitted/iu.test(call[0]))).toBe(false);
  });

  it("does not certify a restricted MySQL readable subset as complete Source coverage", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT VERSION()")) return [[{ version: "8.0.36", current_user: "reader@localhost" }], []];
      if (sql.includes("SHOW GRANTS")) return [[{ grant: "GRANT SELECT ON `app`.`selected` TO 'reader'@'localhost'" }], []];
      if (sql.includes("column_name AS column_name")) return [[{ schema: "app", table_name: "selected", column_name: "id" }], []];
      return [[], []];
    });
    const source = { engine: "mysql", connection: { query } } as unknown as SchemaInspectionConnection;
    const inspection = await inspectDatabaseWithConnection({ engine: "mysql", databaseUrlEnv: "TEST_DATABASE_URL", schema: "app",
      env: { TEST_DATABASE_URL: "mysql://inert.invalid/app" }, resources: [{ schema: "app", table: "selected" }], verifySingleOrganization: true }, source);
    expect(Reflect.get(inspection, "inspected_source_inventory")).toMatchObject({ coverage: "unavailable", scope: { kind: "schema", schema: "app" } });
  });
});
