import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  spawnSync,
} from "node:child_process";
import {
  fileURLToPath,
} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-host-client-"));

try {
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const packRoot = path.join(tempRoot, "packs");
  const installRoot = path.join(tempRoot, "consumer");
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);

  const specTarball = pack(path.join(root, "packages", "spec"), packRoot);
  const dslTarball = pack(path.join(root, "packages", "dsl"), packRoot);
  const runnerTarball = pack(path.join(root, "apps", "runner"), packRoot);
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", [
    "install",
    "--ignore-scripts",
    specTarball,
    dslTarball,
    runnerTarball,
  ], { cwd: installRoot });

  const packageRoot = path.join(installRoot, "node_modules", "@synapsor", "runner");
  const clientSource = path.join(
    packageRoot,
    "examples",
    "host-neutral-typescript-client",
    "client.ts",
  );
  const client = path.join(
    packageRoot,
    "examples",
    "host-neutral-typescript-client",
    "client.mjs",
  );
  const readme = path.join(
    packageRoot,
    "examples",
    "host-neutral-typescript-client",
    "README.md",
  );
  assert.equal(fs.existsSync(clientSource), true, "packed TypeScript client source is missing");
  assert.equal(fs.existsSync(client), true, "packed TypeScript client executable is missing");
  assert.equal(fs.existsSync(readme), true, "packed TypeScript client README is missing");
  assert.match(run(process.execPath, [client, "--help"], { cwd: installRoot }).stdout, /Local Stdio|Stdio:/);

  const exampleRoot = path.join(packageRoot, "examples", "support-plan-credit");
  const discovery = run(process.execPath, [
    client,
    "--config",
    path.join(exampleRoot, "synapsor.runner.json"),
    "--store",
    path.join(tempRoot, "example.db"),
  ], {
    cwd: installRoot,
    env: {
      ...process.env,
      PLAN_CREDIT_POSTGRES_READ_URL: "postgresql://reader:unused@127.0.0.1:1/unused",
      PLAN_CREDIT_POSTGRES_WRITE_URL: "postgresql://writer:unused@127.0.0.1:1/unused",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "packed-host-client",
    },
  });
  const result = JSON.parse(discovery.stdout);
  assert.equal(result.connected, true);
  assert.equal(result.transport, "stdio");
  assert.equal(result.source_database_changed, false);
  assert.deepEqual(
    result.reviewed_tools.map((tool) => tool.name),
    [
      "support.inspect_customer",
      "support.propose_plan_credit",
      "support.propose_plan_credit_record",
    ],
  );
  assert.equal(
    result.reviewed_tools.some((tool) => /sql|approve|apply|commit/i.test(tool.name)),
    false,
  );
  assert.equal(
    result.reviewed_tools.every((tool) => /^sha256:[a-f0-9]{64}$/.test(tool.contract_digest)),
    true,
  );
  process.stdout.write(
    "Packed host-neutral TypeScript MCP client verified: official SDK, reviewed schemas, " +
    "digest pins, no operator tools, and no source mutation.\n",
  );
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

function pack(packageRoot, destination) {
  const result = run("corepack", ["pnpm", "pack", "--pack-destination", destination], {
    cwd: packageRoot,
  });
  const filename = result.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not return a tarball for ${packageRoot}`);
  return path.join(destination, path.basename(filename));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}
