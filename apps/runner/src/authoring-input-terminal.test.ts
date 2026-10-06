import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./cli-format.js";
import { inputProcessRuntime } from "./test-fixtures/source-input-process-driver.js";
import { PUBLIC_INPUT_FACTS } from "./test-fixtures/public-input-resume-variant-facts.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
describe.skipIf(process.platform !== "linux")("production Input in a real terminal", () => {
  it("Escape cancels, Enter declines the default-No readback, and Resume keeps that decision pending", async () => {
    const cwd = fileURLToPath(new URL("../../..", import.meta.url));
    const capture = process.env.B51_INPUT_PTY_EVIDENCE ?? await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-input-terminal-"));
    await fs.mkdir(capture, { recursive: true, mode: 0o700 });
    const runtime = await inputProcessRuntime(cwd, path.join(capture, "runtime"));
    let receiptPath = process.env.B51_INPUT_PTY_WAIT_RECEIPT;
    if (!receiptPath) {
      receiptPath = path.join(capture, "native-wait-receipt.json");
      const tsconfig = JSON.parse(await fs.readFile(runtime.tsconfig, "utf8"));
      const config = path.join(capture, "vitest-source.mjs");
      await fs.writeFile(config, `export default ${JSON.stringify({ resolve: { alias: Object.entries(tsconfig.compilerOptions.paths)
        .map(([find, replacement]) => ({ find, replacement: (replacement as string[])[0] })) } })};`);
      const prep = spawn(process.execPath, [path.join(cwd, "node_modules/vitest/vitest.mjs"), "run", "apps/runner/src/authoring-public-input-resume-withheld.test.ts",
        "--config", config, "--configLoader", "native", "-t", "independent different-schema public Input Resume", "--maxWorkers=1", "--minWorkers=1"], {
        cwd, env: { ...process.env, B51_PUBLIC_INPUT_PREPARE_UNANSWERED_RECEIPT: receiptPath, OWNED_PUBLIC_POLICY_WAIT_EVIDENCE: path.join(capture, "preparation") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; prep.stdout.on("data", data => { output += String(data); }); prep.stderr.on("data", data => { output += String(data); });
      const timer = setTimeout(() => prep.kill("SIGTERM"), 30_000);
      const code = await new Promise<number | null>((resolve, reject) => { prep.once("error", reject); prep.once("close", resolve); }).finally(() => clearTimeout(timer));
      await fs.writeFile(path.join(capture, "preparation.txt"), output);
      expect(code, output).toBe(0);
    }
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    expect(receipt).toMatchObject({ origin: "SCRIPTED_ORDINARY_PUBLIC_UNANSWERED_INPUT_CHECKPOINT", rawAnswerPresent: false, mappingPresent: false,
      confirmationPresent: false, authorityGranted: false, budget: { iterations_used: 1, tool_calls_used: 1, correction_used: false } });
    const beforeBytes = await fs.readFile(receipt.resumePath), sourceBytes = await fs.readFile(receipt.sourcePath), before = JSON.parse(beforeBytes.toString());
    expect(sha(beforeBytes)).toBe(receipt.resumeSha); expect(sha(sourceBytes)).toBe(receipt.sourceSha);
    const beforeRead = await loadBoundaryReviewContext(receipt.projectRoot);
    const terminal = new Terminal({ cols: 110, rows: 40, allowProposedApi: true });
    const helper = fileURLToPath(new URL("./test-fixtures/public-input-terminal.ts", import.meta.url));
    const child = spawn("script", ["-qefc", `stty cols 110 rows 40; ${[process.execPath, "--import", path.join(cwd, "node_modules/tsx/dist/loader.mjs"), helper, receipt.projectRoot, capture].map(shellQuote).join(" ")}`, "/dev/null"], {
      cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_COLOR: "1", NODE_NO_WARNINGS: "1",
        TERM: "xterm-256color", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: runtime.tsconfig }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", paint = Promise.resolve(); const screens: { stage: string; screen: string }[] = [];
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); paint = paint.then(() => new Promise<void>(resolve => terminal.write(chunk, resolve))); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "").join("\n");
    const waitFor = async (text: string, visible = true) => {
      const started = Date.now();
      for (;;) {
        await paint;
        if ((visible ? screen() : output).includes(text)) return;
        if (Date.now() - started > 10_000 || child.exitCode !== null) throw new Error(`Missing ${text}:\n${screen()}\n${output.slice(-5000)}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const captureScreen = (stage: string) => screens.push({ stage, screen: screen() });
    const waitForRawPrompt = async () => {
      const started = Date.now();
      for (;;) {
        await paint;
        const cursorLine = terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)?.translateToString(true) ?? "";
        // Prior questions remain on the current screen across Resume rounds.
        // Only the real empty input line at the live cursor admits typing.
        if (/^\s*you>\s*$/u.test(cursorLine)) return;
        if (Date.now() - started > 10_000 || child.exitCode !== null) throw new Error(`Missing live raw input cursor:\n${screen()}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const selectAnswer = async () => {
      await waitFor("Resume the interrupted job"); await waitFor("Enter Select"); captureScreen("resume-default"); child.stdin.write("\r");
      await waitFor("SAVED INPUT-POLICY DECISION"); await waitFor("Answer the saved question"); await waitFor("Enter Select");
      captureScreen("pending-default-keep"); expect(screen()).toContain("> Keep this decision pending"); child.stdin.write("\u001b[B\r");
      await waitForRawPrompt();
      expect(screen()).toContain("model> How short or long may the handover note be, counting spaces?");
    };
    const pausePending = async (round: number) => {
      await waitFor("SETUP NEEDS ATTENTION"); await waitFor("> Save and continue later"); await waitFor("Enter Select");
      captureScreen(`normal-pending-pause-${round}`); child.stdin.write("\r"); await waitFor(`INPUT_PTY_DONE=${round}`, false);
    };
    try {
      await selectAnswer(); captureScreen("raw-question-cancel"); child.stdin.write("\u001b");
      await pausePending(1);
      await selectAnswer(); child.stdin.write(PUBLIC_INPUT_FACTS.rawAnswer + "\r");
      await waitFor("Save this exact attributed input-policy interpretation?"); await waitFor("Enter Select");
      captureScreen("input-readback-default-no"); expect(screen()).toContain("> No; go back"); child.stdin.write("\r");
      await pausePending(2);
      await waitFor("Resume the interrupted job"); await waitFor("Enter Select"); child.stdin.write("\r");
      await waitFor("SAVED INPUT-POLICY DECISION"); await waitFor("Keep this decision pending"); await waitFor("Enter Select");
      captureScreen("resume-declined-default-keep"); expect(screen()).toContain("> Keep this decision pending"); child.stdin.write("\r");
      await pausePending(3);
      await waitFor("INPUT_PTY_CLOSED=", false); expect(await exited).toBe(0); await paint;
      const rounds = await Promise.all([1, 2, 3].map(async round => JSON.parse(await fs.readFile(path.join(capture, `round-${round}.json`), "utf8"))));
      const selected = (resume: any) => resume.operator_questions.find((question: any) => question.id === receipt.childQuestionId);
      const rootQuestion = (resume: any) => resume.operator_questions.find((question: any) => question.id === receipt.rootQuestionId);
      expect(selected(before)).toMatchObject({ disposition: "cancelled" });
      expect(selected(rounds[0].resume)).toMatchObject({ disposition: "cancelled" });
      expect(selected(rounds[0].resume).raw_answer).toBeUndefined(); expect(rounds[0].requests).toBe(0);
      expect(rootQuestion(rounds[0].resume).budget).toEqual(rootQuestion(before).budget);
      expect(selected(rounds[1].resume)).toMatchObject({ disposition: "declined", raw_answer: { text: PUBLIC_INPUT_FACTS.rawAnswer },
        proposal: { value: { kind: "input_bounds", requirements: [{ outcomes: [...PUBLIC_INPUT_FACTS.outcomes], input: PUBLIC_INPUT_FACTS.input,
          min_length: PUBLIC_INPUT_FACTS.minimum, max_length: PUBLIC_INPUT_FACTS.maximum }] } } });
      expect(selected(rounds[1].resume).confirmation).toBeUndefined(); expect(rounds[1].requests).toBe(1);
      expect(rootQuestion(rounds[1].resume).budget).toEqual({ iterations_used: 2, tool_calls_used: 2, correction_used: false });
      expect(selected(rounds[2].resume)).toEqual(selected(rounds[1].resume)); expect(rounds[2].requests).toBe(1);
      expect(rounds[2].resume.operator_questions).toEqual(rounds[1].resume.operator_questions);
      expect(rounds[2].resume.owner_handoffs).toEqual(rounds[1].resume.owner_handoffs);
      expect(rounds[2].resume.generation_recovery).toEqual(rounds[1].resume.generation_recovery);
      expect(await fs.readFile(receipt.sourcePath)).toEqual(sourceBytes);
      expect((await loadBoundaryReviewContext(receipt.projectRoot)).candidate).toEqual(beforeRead.candidate);
      expect(await listActionRuleAuthorityDrafts(receipt.projectRoot)).toEqual([]);
      expect(await readActionRuleAuthorityActivation(receipt.projectRoot)).toBeUndefined();
      expect(rounds.every(round => !round.resume.authority_granted && !round.resume.source_query_executed && !round.resume.source_database_changed)).toBe(true);
      expect(await fs.readFile(path.join(receipt.projectRoot, ".synapsor/exploration-boundary.active.json")).catch(() => undefined)).toBeUndefined();
      expect(rounds.every(round => round.code === 0)).toBe(true);
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
      terminal.dispose(); // Native preparation root and all disk evidence retained.
    }
  }, 70_000);
});
