import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { renderRunnerResultPanel } from "./runner-result-panel.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";

describe("selective Runner result panels", () => {
  it.each([48, 120, 220])("keeps a colored result separate from editable chat and a safe decision at %i columns", async columns => {
    const terminal = new Terminal({ cols: columns, rows: 35, scrollback: 1000, convertEol: true, allowProposedApi: true });
    const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode(value: boolean) { this.isRaw = value; } });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 35 });
    const chunks: string[] = [];
    writable.on("data", chunk => { chunks.push(String(chunk)); terminal.write(String(chunk)); });
    const flush = () => new Promise<void>(resolve => terminal.write("", resolve));
    const screen = () => Array.from({ length: terminal.buffer.active.length }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true) ?? "").join("\n");
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const chat = createBoundaryAuthoringChat({ io, color: true, streamLineDelayMs: 0 });
    try {
      await chat.streamRunner("Draft updated", renderRunnerResultPanel({
        result: "The plan change and offer consumption are saved as one draft.",
        checked: "Both changes succeed together or neither is saved.",
        changed: "Draft only. Customer records and current permissions are unchanged.",
        next: "Review access and change requests, then execution." }, columns - 8));
      const answer = chat.readOperator!();
      await flush();
      expect(screen()).toContain("Draft updated");
      expect(screen().replace(/\s+/gu, " ")).toContain("Both changes succeed together or neither is saved.");
      expect(screen().trimEnd().endsWith("you>")).toBe(true);
      expect(chunks.join("")).toMatch(/\u001b\[[\d;]+m/u);
      readable.write("Keep my saved policy.\r");
      expect(await answer).toBe("Keep my saved policy.");
      const decision = chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
        { value: "activate", label: "Activate this exact Read Boundary" },
        { value: "finish", label: "Keep Read Boundary disabled and finish" },
      ], { initialValue: "finish", explainOnRequest: true });
      await vi.waitFor(async () => { await flush(); expect(screen()).toContain("REVIEW ACCESS"); });
      readable.write("\r");
      expect(await decision).toBe("finish"); // Enter never silently enables authority.
      await flush();
      expect(screen().replace(/\s+/gu, " ")).toContain("Save without enabling access and finish");
    } finally {
      readable.emit("keypress", "", { name: "escape" });
      chat.close();
      await flush();
      terminal.dispose();
    }
  });
  it.each([32, 40, 80, 160, 240])("keeps meaningful result rows legible within %i columns", (width) => {
    const lines = renderRunnerResultPanel({ result: "The plan and selected offer are saved together, or neither changes.",
      checked: "Both records have conflict checks and belong to the same customer.",
      interpretation: "This meets the requested once-only offer policy.",
      changed: "Draft only; existing permissions and customer records are unchanged.",
      decision: "Review the new write permissions before enabling completion.",
      notChecked: "A live customer request and the worker connection.", next: "Review the writer or pause with the draft saved." }, width);
    expect(lines.every(line => line.length <= width)).toBe(true);
    const text = lines.join("\n");
    for (const label of ["Result", "Runner confirmed", "Model interpretation", "What changes now", "Decision needed", "Not checked", "Next step"]) {
      expect(text).toContain(label);
    }
  });

  it("does not invent checks, decisions or model explanations when only a result is supplied", () => {
    expect(renderRunnerResultPanel({ result: "Draft saved.", checked: "  " }, 80)).toEqual(["Result  Draft saved."]);
  });
});
