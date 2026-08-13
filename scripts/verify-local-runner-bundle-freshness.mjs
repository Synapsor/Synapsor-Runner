import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerRoot = path.join(root, "apps/runner");
const currentCli = path.join(runnerRoot, "dist/cli.js");
const currentBundle = path.join(runnerRoot, "dist/runner.mjs");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-stale-bundle-"));
const fixtureRunnerRoot = path.join(tempRoot, "apps/runner");
const fixtureCli = path.join(fixtureRunnerRoot, "dist/cli.js");

try {
  assert.equal(run(currentCli, ["--version"]).status, 0, "the repository Runner bundle is stale before the verifier starts");
  await fsp.mkdir(path.join(fixtureRunnerRoot, "dist"), { recursive: true });
  await fsp.mkdir(path.join(fixtureRunnerRoot, "src"), { recursive: true });
  await fsp.mkdir(path.join(tempRoot, "packages/config/src"), { recursive: true });
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
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
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
