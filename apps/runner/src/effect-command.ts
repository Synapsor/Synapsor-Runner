import { spawn } from "node:child_process";
import path from "node:path";
import { parseEffectResult, type EffectResult } from "./effect-regression.js";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SAFE_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
] as const;

export async function runEffectCommandAdapter(input: {
  command: string;
  args?: string[];
  fixturePath: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<EffectResult> {
  const command = boundedCommandText(input.command, "effect adapter command");
  const args = (input.args ?? []).map((value, index) => boundedCommandText(value, `effect adapter argument ${index + 1}`));
  if (args.length > 100) throw new Error("effect adapter accepts at most 100 arguments");
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error("effect adapter timeout must be an integer from 100 to 600000 milliseconds");
  }
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const fixturePath = path.resolve(input.fixturePath);
  const sourceEnv = input.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENV_NAMES) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  }
  env.SYNAPSOR_EFFECT_MODE = "propose_only";
  env.SYNAPSOR_EFFECT_FIXTURE_PATH = fixturePath;
  env.SYNAPSOR_EFFECT_SOURCE_DATABASE_CHANGED = "false";
  env.NO_COLOR = "1";
  if (sourceEnv.CI !== undefined) env.CI = sourceEnv.CI;

  const stdout = await runBoundedCommand({ command, args, cwd, env, timeoutMs });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("effect adapter must write exactly one valid JSON result document to stdout");
  }
  return parseEffectResult(parsed);
}

async function runBoundedCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`effect adapter timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error(`effect adapter stdout exceeds ${MAX_STDOUT_BYTES} bytes`));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => finish(new Error("effect adapter could not be started")));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const suffix = signal ? ` (signal ${signal})` : "";
        finish(new Error(`effect adapter exited with code ${code ?? "unknown"}${suffix}; inspect the adapter's own redacted logs`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function boundedCommandText(value: string, label: string): string {
  if (!value.trim() || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be non-empty, at most 4096 characters, and contain no control characters`);
  }
  return value;
}
