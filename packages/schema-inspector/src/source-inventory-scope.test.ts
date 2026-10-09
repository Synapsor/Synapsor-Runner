import { describe, expect, it, vi } from "vitest";
import { inspectDatabaseWithConnection, type SchemaInspectionConnection } from "./index.js";

async function inspectScope(engine: "postgres" | "mysql", schema: string, exists: boolean) {
  const query = vi.fn(async (sql: string) => {
    if (engine === "postgres") {
      if (sql.includes("SELECT version()")) return { rows: [{ version: "PostgreSQL 16.2", current_user: "reader", superuser: false, bypass_rls: false }], rowCount: 1 };
      if (sql.includes("pg_catalog.pg_attribute a") && sql.includes("AS row_level_security")) {
        // The existing namespace is real even when it has no persistent relations.
        const rows = exists ? [{ schema, table_name: null, column_name: null, row_level_security: false }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("AS can_write_relation")) return { rows: [{ owns_relation: false, can_write_relation: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT VERSION()")) return [[{ version: "8.0.36", current_user: "reader@localhost" }], []];
    if (sql.includes("SHOW GRANTS")) return [[{ grant: "GRANT SELECT ON *.* TO 'reader'@'localhost'" }], []];
    if (sql.includes("column_name AS column_name")) return [exists ? [{ schema, table_name: null, column_name: null }] : [], []];
    return [[], []];
  });
  const connection = { engine, connection: { query } } as unknown as SchemaInspectionConnection;
  const inspection = await inspectDatabaseWithConnection({ engine, databaseUrlEnv: "TEST_DATABASE_URL", schema,
    env: { TEST_DATABASE_URL: engine === "postgres" ? "postgres://inert.invalid/fixture" : "mysql://inert.invalid/fixture" },
    verifySingleOrganization: true }, connection);
  return { inventory: Reflect.get(inspection, "inspected_source_inventory"), query };
}

describe("B64 source inventory exact scope and supported population", () => {
  it.each(["", "pg_catalog", "pg_hidden", "absent_schema"])("refuses unverified PostgreSQL scope %j", async schema => {
    const { inventory } = await inspectScope("postgres", schema, false);
    expect(inventory).toMatchObject({ coverage: "unavailable" });
  });

  it("distinguishes a verified existing empty PostgreSQL schema", async () => {
    const { inventory, query } = await inspectScope("postgres", "empty_schema", true);
    expect(inventory).toMatchObject({ coverage: "complete", population: "persistent_user_relations", resources: [] });
    const catalog = query.mock.calls.map(call => call[0]).find(sql => sql.includes("pg_catalog.pg_attribute a") && sql.includes("AS row_level_security"))!;
    expect(catalog).toContain("c.relpersistence IN ('p', 'u')");
  });

  it("does not mistake whole-database MySQL grants for existence of a requested schema", async () => {
    const { inventory } = await inspectScope("mysql", "absent_schema", false);
    expect(inventory).toMatchObject({ coverage: "unavailable" });
  });

  it("distinguishes a verified existing empty MySQL schema within the supported population", async () => {
    const { inventory } = await inspectScope("mysql", "emptydb", true);
    expect(inventory).toMatchObject({ coverage: "complete", population: "persistent_user_relations", resources: [] });
  });
});
