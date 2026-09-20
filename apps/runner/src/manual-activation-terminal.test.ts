import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { shellQuote } from "./cli-format.js";

// Real Unix PTYs exercise alternate-screen ownership, not just mocked keys.
describe.skipIf(process.platform !== "linux")("manual activation in a real terminal", () => {
  it.each([... [48, 100, 120].flatMap((columns) => ["ready", "oversized", "drift"].map((mode) => ({ columns, mode }))),
    { columns: 100, mode: "cancel" }])(
    "$mode at $columns columns keeps review and activation distinct", async ({ columns, mode }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-manual-pty-"));
      const helper = fileURLToPath(new URL("./test-fixtures/manual-activation-terminal.ts", import.meta.url));
      const launcher = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
      const terminal = new Terminal({ cols: columns, rows: 30, allowProposedApi: true });
      const child = spawn("script", ["-qefc", `stty cols ${columns} rows 30; ${shellQuote(launcher)} ${shellQuote(helper)} ${shellQuote(root)} ${mode}`, "/dev/null"], {
        env: { ...process.env, NO_COLOR: "1", NODE_NO_WARNINGS: "1", TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let paint = Promise.resolve();
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        paint = paint.then(() => new Promise<void>((resolve) => terminal.write(chunk, resolve)));
      });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
      const waitFor = async (match: string, visible = false) => {
        const started = Date.now();
        for (;;) {
          await paint;
          if (output.includes(match) && (!visible || screen().includes(match))) return;
          if (Date.now() - started > 12_000 || child.exitCode !== null) throw new Error(`Missing terminal state ${match}: ${output.slice(-2500)}`);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      };
      const waitForEditor = async () => {
        await waitFor("EDIT ACCESS", true);
        // The renderer writes rows separately. Receiving/painting its header
        // does not mean later PTY chunks containing the controls arrived yet.
        // Await the actual current-frame control, never old scrollback text.
        await waitFor(mode === "oversized" ? "Inspect activation blocker" : "Review + activate", true);
      };
      try {
        await waitForEditor();
        if (mode === "oversized") {
          expect(screen()).toContain("ACTIVATION BLOCKED");
          expect(screen()).toContain("Inspect activation blocker");
          expect(output).not.toContain("C reviews and activates");
        }
        output = "";
        child.stdin.write("C");
        if (mode === "oversized") {
          await waitFor("READ ACCESS IS NOT READY");
          await waitFor("pending review", true);
          await waitFor("complete MCP response", true);
          expect(output).not.toContain("[y/N]");
          const blocked = screen();
          child.stdin.write("Y");
          await new Promise((resolve) => setTimeout(resolve, 80)); await paint;
          expect(screen()).toBe(blocked); // Y cannot activate through the blocker.
        } else {
          await waitFor("[y/N]");
          output = "";
          child.stdin.write(mode === "cancel" ? "\r" : "Y");
          if (mode === "cancel") {
            await waitFor("Enter alone does not activate", true);
            expect(screen()).toContain("Y Yes");
            child.stdin.write("N");
            await waitFor("ACTIVATION NOT CONFIRMED", true);
            await waitFor("Y Yes", true);
            child.stdin.write("N");
          }
          if (mode !== "cancel") await waitFor(mode === "drift" ? "Boundary activation did not complete" : "ACTIVATION SUCCEEDED");
        }
        if (mode !== "ready" && mode !== "cancel") {
          // The failure heading is also streamed before its diagnostic body.
          await waitFor(mode === "drift" ? "Generation lock is stale" : "complete MCP response", true);
          expect(output).toContain(mode === "drift" ? "Generation lock is stale" : "complete MCP response");
          expect(screen()).not.toContain("EDIT ACCESS");
          output = "";
          child.stdin.write("\r");
        }
        // Wait for the returned editor frame before sending Q, not the review dialog.
        await waitForEditor();
        child.stdin.write("Q");
        await waitFor("PERSISTED_ACTIVE_COUNT=");
        expect(output).toContain(`PERSISTED_ACTIVE_COUNT=${mode === "ready" ? 1 : 0}`);
        expect(await exited).toBe(0);
      } finally {
        child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM");
        await exited.catch(() => undefined); await paint; terminal.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 30_000);
});
