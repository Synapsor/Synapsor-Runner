import { describe, expect, it } from "vitest";
import {
  renderTerminalJson,
  renderTerminalSql,
  safeTerminalText,
  terminalSyntaxColorEnabled,
} from "./terminal-syntax.js";

describe("terminal syntax rendering", () => {
  it("keeps JSON byte-clean without color and highlights typed tokens with color", () => {
    const value = {
      boundary: "reviewed_orders",
      plan: { top_n: 25, enabled: true, optional: null },
    };

    expect(renderTerminalJson(value)).toBe(JSON.stringify(value, null, 2));
    const colored = renderTerminalJson(value, true);
    expect(colored).toContain('\u001b[1;36m"boundary"\u001b[0m');
    expect(colored).toContain('\u001b[1;32m"reviewed_orders"\u001b[0m');
    expect(colored).toContain("\u001b[1;33m25\u001b[0m");
    expect(colored).toContain("\u001b[1;35mtrue\u001b[0m");
    expect(colored).toContain("\u001b[2mnull\u001b[0m");
  });

  it("supports compact JSON without changing the underlying value", () => {
    const value = { ok: true, count: 3 };
    const plain = renderTerminalJson(value, false, 0);
    const colored = renderTerminalJson(value, true, 0);
    expect(plain).toBe('{"ok":true,"count":3}');
    expect(stripAnsi(colored)).toBe(plain);
  });

  it("highlights PostgreSQL diagnostics including DDL, types, comments, and placeholders", () => {
    const sql = [
      "-- operator diagnostic",
      'CREATE TABLE IF NOT EXISTS "audit"."events" (id BIGSERIAL PRIMARY KEY, payload JSONB);',
      'SELECT COUNT(*) FROM "audit"."events" WHERE "tenant_id" = $1 LIMIT $2;',
    ].join("\n");
    expect(renderTerminalSql(sql)).toBe(sql);

    const colored = renderTerminalSql(sql, true);
    expect(colored).toContain("\u001b[2m-- operator diagnostic\u001b[0m");
    expect(colored).toContain("\u001b[1;36mCREATE\u001b[0m");
    expect(colored).toContain("\u001b[1;35mBIGSERIAL\u001b[0m");
    expect(colored).toContain('\u001b[1;32m"events"\u001b[0m');
    expect(colored).toContain("\u001b[1;34mCOUNT\u001b[0m");
    expect(colored).toContain("\u001b[1;33m$1\u001b[0m");
    expect(stripAnsi(colored)).toBe(sql);
  });

  it("highlights MySQL identifiers, strings, numbers, and parameter placeholders", () => {
    const sql = "INSERT INTO `audit`.`events` (`kind`, `count`) VALUES ('login', 4), (?, :count);";
    const colored = renderTerminalSql(sql, true);
    expect(colored).toContain("\u001b[1;36mINSERT\u001b[0m");
    expect(colored).toContain("\u001b[1;32m`events`\u001b[0m");
    expect(colored).toContain("\u001b[1;35m'login'\u001b[0m");
    expect(colored).toContain("\u001b[1;33m4\u001b[0m");
    expect(colored).toContain("\u001b[1;33m?\u001b[0m");
    expect(colored).toContain("\u001b[1;33m:count\u001b[0m");
    expect(stripAnsi(colored)).toBe(sql);
  });

  it("escapes terminal controls before adding trusted syntax colors", () => {
    const unsafe = "SELECT '\u001b[31mspoof' -- \u202eright-to-left";
    const colored = renderTerminalSql(unsafe, true);
    expect(stripAnsi(colored)).toBe(safeTerminalText(unsafe));
    expect(stripAnsi(colored)).toContain("\\u001b[31mspoof");
    expect(stripAnsi(colored)).toContain("\\u202e");
    expect(stripAnsi(colored)).not.toContain("\u202e");
  });

  it("enables color only for a TTY when NO_COLOR is absent", () => {
    const previous = process.env.NO_COLOR;
    try {
      delete process.env.NO_COLOR;
      expect(terminalSyntaxColorEnabled({ isTTY: true })).toBe(true);
      expect(terminalSyntaxColorEnabled({ isTTY: false })).toBe(false);
      process.env.NO_COLOR = "1";
      expect(terminalSyntaxColorEnabled({ isTTY: true })).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
