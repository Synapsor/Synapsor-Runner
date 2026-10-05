import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerRoot = path.join(root, "apps/runner");
const currentCli = path.join(runnerRoot, "dist/cli.js");
const currentBundle = path.join(runnerRoot, "dist/runner.mjs");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-stale-bundle-"));
const fixtureRunnerRoot = path.join(tempRoot, "apps/runner");
const fixtureCli = path.join(fixtureRunnerRoot, "dist/cli.js");

try {
  assertRepositoryBundleFresh(currentCli);
  await fsp.mkdir(path.join(fixtureRunnerRoot, "dist"), { recursive: true });
  await fsp.mkdir(path.join(fixtureRunnerRoot, "src"), { recursive: true });
  await fsp.mkdir(path.join(tempRoot, "packages/config/src"), { recursive: true });
  await fsp.copyFile(path.join(runnerRoot, "package.json"), path.join(fixtureRunnerRoot, "package.json"));
  await fsp.copyFile(currentCli, fixtureCli);
  await fsp.copyFile(currentBundle, path.join(fixtureRunnerRoot, "dist/runner.mjs"));
  await fsp.symlink(path.join(runnerRoot, "node_modules"), path.join(fixtureRunnerRoot, "node_modules"), "dir");
  const runnerSource = path.join(fixtureRunnerRoot, "src/older.ts");
  const workspaceSource = path.join(tempRoot, "packages/config/src/newer.ts");
  await fsp.writeFile(runnerSource, "export const olderThanBundle = true;\n", "utf8");
  await fsp.writeFile(workspaceSource, "export const newerThanBundle = true;\n", "utf8");
  const old = new Date(Date.now() - 60_000);
  const current = new Date();
  await fsp.utimes(runnerSource, old, old);
  await fsp.utimes(path.join(fixtureRunnerRoot, "dist/runner.mjs"), old, old);
  await fsp.utimes(workspaceSource, current, current);
  assert.throws(() => assertRepositoryBundleFresh(fixtureCli), /repository Runner bundle is stale/,
    "a stale bundle diagnostic must not satisfy the repository freshness preflight");

  for (const args of [
    ["--version"],
    ["--help"],
    ["config", "validate", "--config", path.join(tempRoot, "missing.runner.json"), "--json"],
    ["inspect", "--from-env", "SYNAPSOR_INTENTIONALLY_MISSING_DATABASE_URL", "--json"],
    ["boundary", "status", "--project-root", tempRoot, "--json"],
  ]) {
    const result = run(fixtureCli, args, {
      SYNAPSOR_INTENTIONALLY_MISSING_DATABASE_URL: undefined,
    });
    assert.match(result.combined, /diagnostic command may inspect configuration, metadata, or local status only/i,
      `${args.join(" ")} did not remain available with an explicit stale diagnostic warning`);
    assert.doesNotMatch(result.combined, /bundle is older than its source\. Run:/i,
      `${args.join(" ")} was blocked instead of running diagnostically`);
  }

  for (const args of [
    ["try", "explore", "--project-root", tempRoot],
    ["mcp", "serve", "--project-root", tempRoot],
    ["boundary", "rescan", "--project-root", tempRoot],
    ["config", "init", "--output", path.join(tempRoot, "new.runner.json")],
  ]) {
    const result = run(fixtureCli, args);
    assert.equal(result.status, 1, `${args.join(" ")} did not fail closed for a stale bundle`);
    assert.match(result.combined, /bundle is older than its source\. Run: corepack pnpm build:runner-package/i,
      `${args.join(" ")} did not print the rebuild remediation`);
  }

  assert.equal(fs.existsSync(path.join(tempRoot, "new.runner.json")), false,
    "stale config init wrote a project file before the freshness refusal");
  process.stdout.write("Local Runner bundle freshness verification passed: diagnostics remain available; authority and authoring stay blocked.\n");
  await verifyLauncherShutdown(workspaceSource, old);
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

async function verifyLauncherShutdown(workspaceSource, old) {
  await fsp.utimes(workspaceSource, old, old);
  // Replace only the disposable copied bundle. The real launcher must preserve
  // the child's status and allow its asynchronous shutdown to finish.
  await fsp.writeFile(path.join(fixtureRunnerRoot, "dist/runner.mjs"), `
if (process.argv[2] === 'exit-seven') process.exit(7);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => { process.stdout.write('stopped\\n'); process.exit(0); }, 150);
});
setInterval(() => {}, 1000);
process.stdout.write('ready\\n');
`);
  const alias = path.join(fixtureRunnerRoot, "alias.mjs");
  await fsp.copyFile(path.join(root, "packages/runner-alias/bin/synapsor-runner.mjs"), alias);
  const modes = process.platform === "win32" ? ["exit-seven"] : ["group-interrupt", "parent-terminate", "exit-seven"];
  for (const cli of [fixtureCli, alias]) for (const mode of modes) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, mode], {
        cwd: tempRoot, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", sent = false, settled = false;
      const timer = setTimeout(() => finish(new Error(`${mode}: launcher did not finish shutdown`)), 10_000);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (process.platform === "win32") child.kill();
          else process.kill(-child.pid, "SIGKILL");
        } catch { /* This isolated process group may have already exited. */ }
        if (error) reject(error); else resolve(result);
      }
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (!sent && stdout.includes("ready\n")) {
          sent = true;
          process.kill(mode === "group-interrupt" ? -child.pid : child.pid,
            mode === "group-interrupt" ? "SIGINT" : "SIGTERM");
        }
      });
      child.stderr.resume();
      child.on("error", error => finish(error));
      child.on("close", (code, signal) => finish(null, { code, signal, stdout }));
    });
    assert.equal(result.code, mode === "exit-seven" ? 7 : 0, `${path.basename(cli)} ${mode}: child status changed`);
    assert.equal(result.signal, null, `${path.basename(cli)} ${mode}: launcher exited before its child`);
    if (mode !== "exit-seven") assert.equal(result.stdout, "ready\nstopped\n", `${mode}: incomplete shutdown`);
  }
  process.stdout.write(`Runner launchers verified: ${modes.length * 2} child-exit/shutdown cases passed.\n`);
}

function assertRepositoryBundleFresh(cli) {
  const result = run(cli, ["--version"]);
  const message = "the repository Runner bundle is stale before the verifier starts";
  assert.equal(result.status, 0, message);
  assert.doesNotMatch(result.combined, /bundle is older than its source/i, message);
}

function run(cli, args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: tempRoot,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}
