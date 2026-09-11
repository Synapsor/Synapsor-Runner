import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { renderTerminalModelTable, createTerminalTableBlocks } from "./terminal-model-table.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import { renderAnalyticsTurn } from "./analytics-shell-render.js";

const table = [
  "| Job | Required fields | Status |",
  "| :--- | :--- | ---: |",
  "| **Accept offered seat** | `registration_state`<br>`row_version` | Pending |",
  "| Restore erroneous drop | `university.registration_cases.registration_state` | Pending |",
  "| Release advising hold | `hold_state`, `released_at` | Not checked |",
].join("\n");
const style = { bold: (text: string) => `\x1b[1m${text}\x1b[22m`, code: (text: string) => `\x1b[36m${text}\x1b[39m` };

describe("model-authored terminal tables", () => {
  it("does not discard surplus values from malformed Markdown rows", () => {
    const malformed = "| Field | Access |\n| --- | --- |\n| version | private | unexpected-value |";
    expect(renderTerminalModelTable(malformed, 120, style)).toBeUndefined();
  });

  it.each([48, 100, 220])("renders model tables in local Ask too (%s columns)", (width) => {
    const output = stripVTControlCharacters(renderAnalyticsTurn({
      ok: true, answer: table, answer_is_untrusted_model_output: true, answer_source: "model",
      provider: "openrouter", model: "openai/gpt-5.6-terra", authority_digest: `sha256:${"1".repeat(64)}`,
      tool_calls: [], source_database_changed: false,
    }, [], width, { ansi: true }));
    expect(output).toContain("MODEL INTERPRETATION");
    expect(output).not.toMatch(/\*\*|`|<br>|:---/u);
    expect(output).toContain("No Runner data query was executed");
    if (width < 64) expect(output).toContain("Required fields:");
    else expect(output.split("\n").filter((line) => line.startsWith("|")).every((line) => line.length <= width)).toBe(true);
  });
  it.each([48, 80, 120, 220])("renders complete wrapped values without Markdown delimiters at %s columns", (width) => {
    const lines = renderTerminalModelTable(table, width, style)!;
    const plain = lines.map(stripVTControlCharacters);
    expect(plain.every((line) => line.length <= width)).toBe(true);
    expect(plain.join("\n")).not.toMatch(/\*\*|`|<br>|:---/u);
    const values = width < 64 ? plain.join("") : plain.filter((line) => line.startsWith("|")).map((line) => line.split("|")[2]).join("");
    expect(values.replace(/\s/gu, "")).toContain("university.registration_cases.registration_state");
    if (width < 64) expect(plain).toContain("Required fields:");
    else {
      const rows = plain.filter((line) => line.startsWith("|"));
      expect(new Set(rows.map((line) => line.length)).size).toBe(1);
    }
  });

  it("parses escaped pipes, formats inline emphasis and handles wide characters", () => {
    const rows = renderTerminalModelTable("| Field | Meaning |\n| --- | --- |\n| `a\\|b` | **学生** |", 90, style)!;
    expect(stripVTControlCharacters(rows.join("\n"))).toContain("a|b");
    expect(rows.join("\n")).toContain(style.bold("学生"));
  });

  it.each([1, 2, 7, 99])("buffers table blocks independent of chunk boundaries (%i)", (size) => {
    const prose: string[] = [], tables: string[] = [];
    const blocks = createTerminalTableBlocks({ prose: (value) => prose.push(value), table: (value) => tables.push(value) });
    blocks.push("Here are ");
    expect(prose.join("")).toBe("Here are "); // Ordinary text is not held for table detection.
    const source = "the requirements.\n\n" + table + "\n\nWhich next?";
    for (let i = 0; i < source.length; i += size) blocks.push(source.slice(i, i + size));
    blocks.finish();
    expect(tables).toEqual([table + "\n"]);
    expect(prose.join("")).toBe("Here are the requirements.\n\n\nWhich next?");
  });

  it("leaves fenced table examples literal and never executes terminal controls from a cell", () => {
    const prose: string[] = [], tables: string[] = [];
    const blocks = createTerminalTableBlocks({ prose: (value) => prose.push(value), table: (value) => tables.push(value) });
    const source = "```md\n" + table + "\n```\n";
    for (const char of source) blocks.push(char);
    blocks.finish();
    expect(tables).toEqual([]);
    expect(prose.join("")).toBe(source);
    const rows = renderTerminalModelTable("| Action | Result |\n| --- | --- |\n| test | \x1b[2J\x1b]0;bad\x07ok |", 100, style)!;
    expect(rows.join("\n")).not.toMatch(/\x1b\[2J|\x1b\]0;/u);
    expect(stripVTControlCharacters(rows.join("\n"))).toContain("ok");
  });

  it.each([48, 100, 220])("renders live and final authoring output identically in the real terminal at %i columns", async (columns) => {
    const outputs: string[] = [];
    for (const streamed of [false, true]) {
      const terminal = new Terminal({ cols: columns, rows: 35, scrollback: 1000, convertEol: true, allowProposedApi: true });
      const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
      const writable = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 35 });
      writable.on("data", (chunk) => terminal.write(String(chunk)));
      const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
      const chat = createBoundaryAuthoringChat({ io, color: true, streamLineDelayMs: 0 });
      const response = "Here are the requirements.\n\n" + table + "\n\nWhat would you like to do next?";
      const flush = () => new Promise<void>((resolve) => terminal.write("", resolve));
      try {
        if (streamed) {
          for (let i = 0; i < response.length; i += 3) chat.providerStream({ phase: "text_delta", operator_text: true, text: response.slice(i, i + 3) });
          chat.providerStream({ phase: "completed", operator_text: true });
        }
        await chat.streamModel(response.split("\n"));
        const answer = chat.readOperator!();
        await flush();
        const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
        const text = lines.join("\n").trimEnd(); outputs.push(text);
        expect(text).not.toMatch(/\*\*|`|<br>|:---/u);
        expect(text.match(/model>/gu)).toHaveLength(1);
        expect(text.endsWith("you>")).toBe(true);
        const tableLines = lines.filter((line) => /^\s*\|/u.test(line));
        if (columns >= 100) expect(new Set(tableLines.map((line) => line.length)).size).toBe(1);
        expect(lines.some((line) => line.startsWith("|") || line.startsWith("registration"))).toBe(false);
        readable.write("Continue\r");
        expect(await answer).toBe("Continue");
      } finally { chat.close(); await flush(); readable.destroy(); writable.destroy(); terminal.dispose(); }
    }
    expect(outputs[1]).toBe(outputs[0]);
  });
});
