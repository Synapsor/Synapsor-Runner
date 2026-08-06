import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-production-explore-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");

try {
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);
  run("corepack", ["pnpm", "build:runner-package"]);
  const specTarball = packCurrent(path.join(root, "packages", "spec"));
  const runnerTarball = packCurrent(path.join(root, "apps", "runner"));
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", specTarball, runnerTarball], { cwd: installRoot });
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(cli), "Packed production Explore verification could not find the installed Runner CLI.");
  run(process.execPath, [path.join(root, "scripts", "verify-production-explore-http.mjs")], {
    inherit: true,
    env: {
      ...process.env,
      SYNAPSOR_PRODUCTION_EXPLORE_RUNNER: cli,
      SYNAPSOR_SKIP_PRODUCTION_EXPLORE_ACCOUNTING_TEST: "1",
    },
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

function packCurrent(packageRoot) {
  const packed = run("corepack", ["pnpm", "pack", "--pack-destination", packRoot], { cwd: packageRoot });
  const filename = packed.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not report a tarball for ${packageRoot}`);
  return path.join(packRoot, path.basename(filename));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}
