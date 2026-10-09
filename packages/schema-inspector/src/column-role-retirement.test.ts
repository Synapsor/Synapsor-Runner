import { describe, expect, it } from "vitest";
import { inspectDatabaseWithConnection, type SchemaInspectionConnection } from "./index.js";

describe("B64 inspected columns do not acquire business roles from names", () => {
  it.each(["tenant_id", "updated_at", "created_at", "c7"])("leaves %s undecided while retaining exact primary-key facts", async name => {
    const source = { engine: "mysql", connection: { query: async (sql: string) => {
      if (sql.includes("SELECT VERSION()")) return [[{ version: "8.0.36", current_user: "reader@localhost" }], []];
      if (sql.includes("SHOW GRANTS")) return [[{ grant: "GRANT SELECT ON `app`.* TO 'reader'@'localhost'" }], []];
      if (sql.includes("FROM information_schema.tables")) return [[{ schema: "app", name: "records", type: "BASE TABLE" }], []];
      if (sql.includes("FROM information_schema.columns")) return [["opaque_key", name].map((field, index) => ({
        schema: "app", table_name: "records", name: field, data_type: "text", udt_name: "text", is_nullable: "NO",
        is_generated: "", is_identity: "", ordinal_position: index + 1,
      })), []];
      if (sql.includes("tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')")) return [[{ schema: "app", table_name: "records",
        constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "opaque_key", ordinal_position: 1 }], []];
      return [[], []];
    } } } as unknown as SchemaInspectionConnection;
    const inspection = await inspectDatabaseWithConnection({ engine: "mysql", databaseUrlEnv: "TEST_DATABASE_URL", schema: "app",
      env: { TEST_DATABASE_URL: "mysql://inert.invalid/app" } }, source);
    const table = inspection.tables[0]!;
    expect(table.primary_key).toEqual(["opaque_key"]);
    expect(table.columns.find(column => column.name === "opaque_key")?.suggestions.immutable).toBe(true);
    expect(table.columns.find(column => column.name === name)?.suggestions).toMatchObject({ tenant: false, conflict: false, immutable: false });
    expect(table.suggestions.tenant_columns).toEqual([]);
    expect(table.suggestions.conflict_columns).toEqual([]);
  });
});
