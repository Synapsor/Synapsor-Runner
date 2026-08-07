import { describe, expect, it } from "vitest";
import {
  renderTerminalJson,
  renderTerminalSql,
  renderTerminalSqlFrame,
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

  it("formats compiled PostgreSQL aggregates without splitting protected tokens", () => {
    const sql = 'SELECT t0."feature" AS "dimension_0", SUM(t0."event_count") AS "measure_0", COUNT(*) AS "__cohort_size" FROM "public"."usage_events" t0 WHERE t0."organization_id" = $1 AND t0."note" = \'FROM, AND\' GROUP BY t0."feature" ORDER BY "measure_0" DESC LIMIT $2';
    const formatted = [
      "SELECT",
      '  t0."feature" AS "dimension_0",',
      '  SUM(t0."event_count") AS "measure_0",',
      '  COUNT(*) AS "__cohort_size"',
      "FROM",
      '  "public"."usage_events" t0',
      "WHERE",
      '  t0."organization_id" = $1',
      '  AND t0."note" = \'FROM, AND\'',
      "GROUP BY",
      '  t0."feature"',
      "ORDER BY",
      '  "measure_0" DESC',
      "LIMIT $2",
    ].join("\n");

    expect(renderTerminalSql(sql)).toBe(formatted);
    expect(stripAnsi(renderTerminalSql(sql, true))).toBe(formatted);
  });

  it("formats MySQL SELECT diagnostics while preserving quoted identifiers and placeholders", () => {
    const sql = "SELECT `status`, COUNT(*) FROM `app`.`orders` WHERE `tenant_id` = ? GROUP BY `status` ORDER BY COUNT(*) DESC LIMIT ?";
    expect(renderTerminalSql(sql)).toBe([
      "SELECT",
      "  `status`,",
      "  COUNT(*)",
      "FROM",
      "  `app`.`orders`",
      "WHERE",
      "  `tenant_id` = ?",
      "GROUP BY",
      "  `status`",
      "ORDER BY",
      "  COUNT(*) DESC",
      "LIMIT ?",
    ].join("\n"));
  });

  it("frames formatted SQL and metadata without exceeding the terminal width", () => {
    const frame = renderTerminalSqlFrame(
      'SELECT "status", COUNT(*) FROM "public"."orders" WHERE "tenant_id" = $1 GROUP BY "status" ORDER BY COUNT(*) DESC LIMIT $2',
      {
        title: "Statement 1 - postgres",
        metadata: ["Parameter types: string, integer", "Parameter values: redacted"],
        columns: 64,
      },
    );
    const lines = frame.split("\n");
    expect(lines[0]).toMatch(/^\+-- Statement 1 - postgres -+\+$/);
    expect(frame).toContain("| SELECT");
    expect(frame).toContain("|   COUNT(*)");
    expect(frame).toContain("Parameter values: redacted");
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(62);

    const colored = renderTerminalSqlFrame("SELECT COUNT(*) FROM `orders` WHERE `id` = ?", {
      title: "Statement 1 - mysql",
      color: true,
      columns: 48,
    });
    expect(colored).toContain("\u001b[1;36mSELECT\u001b[0m");
    const coloredWidths = stripAnsi(colored).split("\n").map((line) => line.length);
    expect(new Set(coloredWidths).size).toBe(1);
    expect(coloredWidths[0]).toBeLessThanOrEqual(46);
  });

  it("escapes terminal controls before adding trusted syntax colors", () => {
    const unsafe = "SELECT '\u001b[31mspoof' -- \u202eright-to-left";
    const colored = renderTerminalSql(unsafe, true);
    expect(stripAnsi(colored)).toBe(renderTerminalSql(unsafe));
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
