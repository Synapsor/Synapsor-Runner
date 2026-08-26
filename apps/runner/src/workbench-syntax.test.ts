import { describe, expect, it } from "vitest";
import { formatSqlForDisplay } from "./terminal-syntax.js";
import { tokenizeJson, tokenizeSynapsorDsl, workbenchSyntaxScript } from "./workbench-syntax.js";

describe("Workbench syntax highlighting", () => {
  it("classifies DSL keywords separately from user-defined names without changing text", () => {
    const source = [
      "CREATE CAPABILITY billing.propose_credit",
      "DESCRIPTION 'Review <script>alert(1)</script> safely'",
      "BOUND amount_cents 0..2500",
      "-- reviewer-visible comment",
      "END",
      "",
    ].join("\n");
    const tokens = tokenizeSynapsorDsl(source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ kind: "keyword", text: "CREATE" });
    expect(tokens).toContainEqual({ kind: "keyword", text: "CAPABILITY" });
    expect(tokens).toContainEqual({ kind: "identifier", text: "billing" });
    expect(tokens).toContainEqual({ kind: "identifier", text: "propose_credit" });
    expect(tokens).toContainEqual({ kind: "number", text: "2500" });
    expect(tokens).toContainEqual({
      kind: "string",
      text: "'Review <script>alert(1)</script> safely'",
    });
    expect(tokens).toContainEqual({ kind: "comment", text: "-- reviewer-visible comment" });
  });

  it("ships a local DOM renderer that reconstructs source with text nodes", () => {
    const script = workbenchSyntaxScript();

    expect(script).toContain("document.createTextNode");
    expect(script).toContain("span.textContent=token.text");
    expect(script).toContain("if(code.textContent!==source)");
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toContain("span.innerHTML");
    expect(script).toContain('toLowerCase()==="sql"');
    expect(script).toContain("formatSqlForDisplay(rawSource)");
  });

  it("formats parameterized PostgreSQL and MySQL reads without changing protected tokens", () => {
    const postgres = 'SELECT t0."region", COUNT(*) FROM "public"."orders" t0 WHERE t0."tenant_id" = $1 AND t0."note" = \'FROM is text\' GROUP BY t0."region" ORDER BY COUNT(*) DESC LIMIT $2';
    const mysql = "SELECT `region`, COUNT(*) FROM `app`.`orders` WHERE `tenant_id` = ? GROUP BY `region` LIMIT ?";

    const formattedPostgres = formatSqlForDisplay(postgres);
    const formattedMysql = formatSqlForDisplay(mysql);
    expect(formattedPostgres.split("\n")).toEqual(expect.arrayContaining([
      "SELECT",
      "FROM",
      "WHERE",
      "GROUP BY",
      "ORDER BY",
      "LIMIT $2",
    ]));
    expect(formattedPostgres).toContain("t0.\"tenant_id\" = $1");
    expect(formattedPostgres).toContain("'FROM is text'");
    expect(formattedMysql).toContain("\nFROM\n");
    expect(formattedMysql).toContain("`tenant_id` = ?");
    expect(formattedMysql).toContain("LIMIT ?");
  });

  it("highlights JSON properties, values, numbers, and literals without changing source", () => {
    const source = '{\n  "resource": "public.orders",\n  "top_n": 25,\n  "active": true,\n  "cursor": null\n}';
    const tokens = tokenizeJson(source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ kind: "identifier", text: '"resource"' });
    expect(tokens).toContainEqual({ kind: "string", text: '"public.orders"' });
    expect(tokens).toContainEqual({ kind: "number", text: "25" });
    expect(tokens).toContainEqual({ kind: "keyword", text: "true" });
    expect(tokens).toContainEqual({ kind: "keyword", text: "null" });
  });
});
