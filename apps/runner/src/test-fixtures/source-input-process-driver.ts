/** Reusable fresh-process mechanics only. Acceptance scenarios/assertions live
 * in their callers; this driver never imports a policy oracle or product state. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import type { PolicySourceSession } from "../authoring-policy-source.js";

export type InputProcessStop = "onset" | "unanswered" | "raw" | "proposal" | "confirmation" | "append-before-ack" | "ack-lost" | "returned" | "none";
export type InputProcessResult = { pid: number; state: string;
  counts: { requests: number; prompts: number; confirmations: number; pendingViews: number; commits: number; acknowledgements: number };
  resume: BoundaryAuthoringResumeState; sources: PolicySourceSession };
export type InputProcessRuntime = { cwd: string; tsconfig: string; captureDirectory?: string };

export async function inputProcessRuntime(cwd: string, runtimeRoot: string, captureDirectory?: string): Promise<InputProcessRuntime> {
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const tsconfig = path.join(runtimeRoot, "child-tsconfig.json"), paths: Record<string, string[]> = {};
  for (const directory of await fs.readdir(path.join(cwd, "packages"))) {
    const packageRoot = path.join(cwd, "packages", directory);
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    try { await fs.access(path.join(packageRoot, "src/index.ts")); paths[metadata.name] = [path.join(packageRoot, "src/index.ts")]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await fs.writeFile(tsconfig, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    baseUrl: cwd, paths } }), { mode: 0o600 });
  return { cwd, tsconfig, captureDirectory };
}

export async function runInputProcess(runtime: InputProcessRuntime, projectRoot: string,
  mode: "start" | "restart", stop: InputProcessStop, controlFile?: string): Promise<InputProcessResult> {
  return runAuthoringProcess<InputProcessResult>(runtime, "source-input-process.ts", projectRoot, mode, stop, controlFile);
}

/** Identical owned-child mechanics for Input and Version. No response, record,
 * assertions or scenario selection crosses this process-only seam. */
export async function runAuthoringProcess<T extends { pid: number }>(runtime: InputProcessRuntime, fixture: "source-input-process.ts" | "source-version-process.ts",
  projectRoot: string, mode: "start" | "restart", stop: string, controlFile?: string): Promise<T> {
  const child = spawn(process.execPath, ["--import", path.join(runtime.cwd, "node_modules/tsx/dist/loader.mjs"),
    path.join(runtime.cwd, "apps/runner/src/test-fixtures", fixture), projectRoot, mode, stop,
    ...(controlFile ? [controlFile] : [])], {
    cwd: runtime.cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: runtime.tsconfig }, stdio: ["ignore", "pipe", "pipe"],
  });
  // The child inherits the caller's managed process group, never detached.
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (runtime.captureDirectory) {
    await fs.mkdir(runtime.captureDirectory, { recursive: true, mode: 0o700 });
    const name = `${path.basename(projectRoot)}-${mode}-${stop}-${child.pid}`;
    await fs.writeFile(path.join(runtime.captureDirectory, `${name}.stdout.json`), stdout, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(runtime.captureDirectory, `${name}.stderr.txt`), stderr, { mode: 0o600, flag: "wx" });
  }
  if (code !== 0) throw new Error(`Fresh ${fixture} process exit ${code}: ${stderr}\n${stdout}`);
  const result = JSON.parse(stdout.trim()) as T;
  if (result.pid !== child.pid) throw new Error("Fresh-process identity mismatch.");
  try { process.kill(result.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return result; throw error; }
  throw new Error("Owned child still running after closure.");
}
