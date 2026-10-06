import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./cli-format.js";
import { inputProcessRuntime, runAuthoringProcess } from "./test-fixtures/source-input-process-driver.js";
import { READ_PROCESS_FACTS as facts } from "./test-fixtures/source-read-process-contract.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

describe.skipIf(process.platform !== "linux")("production Read meaning in a real terminal", () => {
  it("Escape retains the genuine question and Enter declines the default-No meaning readback", async () => {
    const cwd = fileURLToPath(new URL("../../..", import.meta.url));
    const capture = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-terminal-"));
    const runtime = await inputProcessRuntime(cwd, capture, path.join(capture, "preparation"));
    const project = path.join(capture, "read-terminal");
    const before = await runAuthoringProcess<{ pid: number; resume: BoundaryAuthoringResumeState }>(runtime,
      "source-read-process.ts", project, "start", "unanswered");
    const question = before.resume.operator_questions!.at(-1)!;
    expect(question.raw_answer).toBeUndefined();
    expect(before.resume.owner_handoffs!.at(-1)!.completion).toBeDefined();
    const source = path.join(project, ".synapsor/boundary-authoring/policy-sources", `${before.resume.policy_source_session}.json`);
    const sourceBefore = await fs.readFile(source);
    const terminal = new Terminal({ cols: 110, rows: 40, allowProposedApi: true });
    const helper = fileURLToPath(new URL("./test-fixtures/public-read-terminal.ts", import.meta.url));
    const child = spawn("script", ["-qefc", `stty cols 110 rows 40; ${[process.execPath, "--import", path.join(cwd, "node_modules/tsx/dist/loader.mjs"), helper, project, capture].map(shellQuote).join(" ")}`, "/dev/null"], {
      cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_COLOR: "1", NODE_NO_WARNINGS: "1",
        TERM: "xterm-256color", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: runtime.tsconfig }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", paint = Promise.resolve(); const screens: { stage: string; screen: string }[] = [];
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); paint = paint.then(() => new Promise<void>(resolve => terminal.write(chunk, resolve))); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "").join("\n");
    const wait = async (ready: () => boolean) => {
      const started = Date.now();
      for (;;) {
        await paint;
        if (ready()) return;
        if (Date.now() - started > 10_000 || child.exitCode !== null) throw new Error(`Missing terminal transition:\n${screen()}\n${output.slice(-5000)}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const rawCursor = () => /^\s*you>\s*$/u.test(terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)?.translateToString(true) ?? "");
    const recordScreen = (stage: string) => screens.push({ stage, screen: screen() });
    const resume = async () => {
      await wait(() => screen().includes("Resume the interrupted job") && screen().includes("Enter Select"));
      recordScreen("resume-default"); child.stdin.write("\r");
      await wait(rawCursor); expect(screen()).toContain(facts.question);
    };
    try {
      await resume(); recordScreen("question-cancel"); child.stdin.write("\u001b");
      await wait(() => output.includes("READ_PTY_DONE=1"));
      await resume(); child.stdin.write(facts.raw + "\r");
      await wait(() => screen().includes("Record these exact words as the meaning for this task?") && screen().includes("Enter Select"));
      recordScreen("readback-default-no"); expect(screen()).toContain("> No; go back"); child.stdin.write("\r");
      await wait(() => output.includes("READ_PTY_CLOSED=")); expect(await exited).toBe(0); await paint;
      const rounds = await Promise.all([1, 2].map(async round => JSON.parse(await fs.readFile(path.join(capture, `round-${round}.json`), "utf8"))));
      const selected = (resume: BoundaryAuthoringResumeState) => resume.operator_questions!.find(q => q.id === question.id)!;
      expect(selected(rounds[0].resume)).toMatchObject({ disposition: "cancelled" });
      expect(selected(rounds[0].resume).raw_answer).toBeUndefined();
      expect(selected(rounds[1].resume)).toMatchObject({ disposition: "declined", raw_answer: { text: facts.raw }, proposal: { value: { kind: "attributed_meaning" } } });
      expect(selected(rounds[1].resume).confirmation).toBeUndefined();
      expect(rounds.every(round => round.requests === 0 && round.code === 0 && round.resume.read_assistance.stage === "waiting"
        && !round.resume.authority_granted && !round.resume.source_query_executed && !round.resume.source_database_changed)).toBe(true);
      expect(await fs.readFile(source)).toEqual(sourceBefore);
      const identity = JSON.parse(await fs.readFile(path.join(capture, "child.json"), "utf8"));
      expect(identity.terminal).toEqual({ input: true, output: true });
      expect(() => process.kill(identity.pid, 0)).toThrow();
    } finally {
      child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM");
      const owned = JSON.parse(await fs.readFile(path.join(capture, "child.json"), "utf8").catch(() => "null"));
      if (owned) {
        const alive = () => { try { process.kill(owned.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
        if (alive()) process.kill(owned.pid, "SIGTERM");
        for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
        if (alive()) process.kill(owned.pid, "SIGKILL");
      }
      await exited.catch(() => undefined); await paint;
      await fs.writeFile(path.join(capture, "terminal.txt"), output); await fs.writeFile(path.join(capture, "screens.json"), JSON.stringify(screens, null, 2));
      terminal.dispose();
    }
  }, 70_000);
});
