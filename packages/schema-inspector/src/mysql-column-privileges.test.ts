import { describe, expect, it } from "vitest";
import { mysqlGrantPosture } from "./index.js";

const relations = [{ schema: "app", table: "parent" }, { schema: "app", table: "other" }];
const inspect = (...privileges: string[]) => mysqlGrantPosture(privileges.map(value => `GRANT ${value} ON \`app\`.\`parent\` TO 'writer'@'localhost'`), relations);
describe("MySQL exact column grant representation", () => {
  it("keeps column UPDATE separate from table UPDATE, unions/sorts exact fields and preserves read-only relation grants", () => {
    const p = inspect("SELECT, UPDATE (`id`)", "UPDATE (`other`, `id`), INSERT (`state`), REFERENCES (`id`)");
    expect(p).toMatchObject({ verified: true, elevated: false,
      relations: { "app.parent": { select: true, update: false, insert: false, references: false }, "app.other": { select: false, update: false } },
      column_privileges: { "app.parent": { update: ["id", "other"], insert: ["state"], references: ["id"] }, "app.other": {} } });
    expect(inspect("UPDATE (`id`)", "UPDATE").relations["app.parent"]!.update).toBe(true);
  });
  it("parses quoted commas, parentheses, escaped backticks and case without widening identifiers", () => {
    expect(inspect("SELECT (`Case`), UPDATE (`a,b`, `c)d`, `tick``name`, plain)")).toMatchObject({ verified: true,
      column_privileges: { "app.parent": { select: ["Case"], update: ["a,b", "c)d", "plain", "tick`name"] } } });
  });
  it.each(["UPDATE ()", "UPDATE (`id`,)", "UPDATE (`id`", "UPDATE (`id`))", "UPDATE ((id))", "UPDATE (id) garbage", "DELETE (`id`)", "ALL (`id`)", "FUTURE (`id`)", "UPDATE (`unterminated)", "UPDATE,", "UPDATE (* )"])("fails closed on malformed or unsupported syntax: %s", value => {
    expect(inspect(value).verified).toBe(false);
  });
  it("refuses role assignments and column grants on wildcard targets", () => {
    expect(mysqlGrantPosture(["GRANT 'role'@'%' TO 'writer'@'%'"], relations).verified).toBe(false);
    expect(mysqlGrantPosture(["GRANT UPDATE (`id`) ON app.* TO 'writer'@'%'"], relations).verified).toBe(false);
  });
  it("preserves elevated and table-wide authority alongside exact column grants", () => {
    expect(inspect("UPDATE (`id`), ALTER")).toMatchObject({ elevated: true, column_privileges: { "app.parent": { update: ["id"] } } });
    expect(mysqlGrantPosture(["GRANT SELECT, UPDATE (`id`) ON app.parent TO 'w'@'%' WITH GRANT OPTION"], relations).elevated).toBe(true);
    expect(inspect("ALL PRIVILEGES")).toMatchObject({ elevated: true, relations: { "app.parent": { update: true, delete: true } } });
  });
});
