#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = JSON.parse(await fs.readFile(path.join(root, "apps/runner/package.json"), "utf8"));
const alias = JSON.parse(await fs.readFile(path.join(root, "packages/runner-alias/package.json"), "utf8"));
const spec = JSON.parse(await fs.readFile(path.join(root, "packages/spec/package.json"), "utf8"));
if (runner.version !== alias.version) throw new Error("Runner alias version must match @synapsor/runner.");
if (alias.dependencies?.["@synapsor/runner"] !== `workspace:${runner.version}`) {
  throw new Error("Runner alias source manifest must use the exact matching workspace version.");
}
if (Object.keys(alias.bin ?? {}).length !== 1 || alias.bin["synapsor-runner"] !== "bin/synapsor-runner.mjs") {
  throw new Error("Runner alias must expose exactly one synapsor-runner binary.");
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runner-alias-pack-"));
try {
  const runnerPackRoot = path.join(temporary, "runner");
  const aliasPackRoot = path.join(temporary, "alias");
  const specPackRoot = path.join(temporary, "spec");
  await fs.mkdir(runnerPackRoot);
  await fs.mkdir(aliasPackRoot);
  await fs.mkdir(specPackRoot);
  run("corepack", ["pnpm", "build:runner-package"], root);
  run("corepack", ["pnpm", "--dir", "apps/runner", "pack", "--pack-destination", runnerPackRoot], root);
  run("corepack", ["pnpm", "--dir", "packages/runner-alias", "pack", "--pack-destination", aliasPackRoot], root);
  run("corepack", ["pnpm", "--dir", "packages/spec", "pack", "--pack-destination", specPackRoot], root);

  const scopedTarball = path.join(runnerPackRoot, `synapsor-runner-${runner.version}.tgz`);
  const aliasTarball = path.join(aliasPackRoot, `synapsor-runner-${alias.version}.tgz`);
  const specTarball = path.join(specPackRoot, `synapsor-spec-${spec.version}.tgz`);
  await fs.access(scopedTarball);
  await fs.access(aliasTarball);
  await fs.access(specTarball);

  const packedAlias = JSON.parse(run("tar", ["-xOf", aliasTarball, "package/package.json"], root));
  if (packedAlias.dependencies?.["@synapsor/runner"] !== runner.version) {
    throw new Error("Packed alias must depend on the exact matching @synapsor/runner version.");
  }
  const aliasSource = await fs.readFile(path.join(root, "packages/runner-alias/bin/synapsor-runner.mjs"), "utf8");
  if (aliasSource.length > 1_000
    || !aliasSource.includes('from "@synapsor/runner/cli"')
    || /activate|approve|apply|database|ledger|contract/i.test(aliasSource)) {
    throw new Error("Runner alias contains independent runtime or authority logic.");
  }

  const installRoot = path.join(temporary, "install");
  await fs.mkdir(installRoot);
  await fs.writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@synapsor/spec": `file:${specTarball}`,
      "@synapsor/runner": `file:${scopedTarball}`,
      "synapsor-runner": `file:${aliasTarball}`,
    },
  }, null, 2)}\n`, "utf8");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], installRoot);
  const output = run(path.join(installRoot, "node_modules/.bin/synapsor-runner"), ["--version"], installRoot).trim();
  if (output !== runner.version) throw new Error(`Packed alias returned ${output}, expected ${runner.version}.`);
  console.log(`Packed runner alias verified at ${runner.version}.`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SYNAPSOR_RUNNER_SKIP_RELEASE_ASSETS: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
