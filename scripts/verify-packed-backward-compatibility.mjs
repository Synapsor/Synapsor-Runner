import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPackageDir = path.join(root, "apps", "runner");
const specPackageDir = path.join(root, "packages", "spec");
const manifest = JSON.parse(await fsp.readFile(
  path.join(root, "fixtures", "compatibility", "published-1.5.4", "manifest.json"),
  "utf8",
));
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-compat-"));

try {
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });

  const baselinePackDir = path.join(tempRoot, "baseline-pack");
  const currentPackDir = path.join(tempRoot, "current-pack");
  await fsp.mkdir(baselinePackDir);
  await fsp.mkdir(currentPackDir);
  const baselineTarball = packPublishedBaseline(baselinePackDir);
  const currentSpecTarball = packCurrentPackage(specPackageDir, currentPackDir);
  const currentTarball = packCurrentPackage(runnerPackageDir, currentPackDir);

  const expectedBaseline = manifest.published_packages["@synapsor/runner"];
  assert.equal(
    sha1(fs.readFileSync(baselineTarball)),
    expectedBaseline.npm_shasum,
    "downloaded Runner baseline tarball does not match the pinned npm shasum",
  );

  const baseline = installTarball("baseline", baselineTarball);
  const current = installTarball("current", currentTarball, [currentSpecTarball]);
  assert.equal(readPackageVersion(baseline.packageRoot), expectedBaseline.version);

  verifyPackedCanonicalCompatibility(current);
  await verifyLegacyToolSurface(baseline, current);
  verifyCliRouting(baseline, current);
  await verifyTypeScriptAuthoring(baseline, current);

  process.stdout.write(
    `Packed backward compatibility verified against ` +
    `@synapsor/runner@${expectedBaseline.version}, ` +
    `@synapsor/dsl@${manifest.published_packages["@synapsor/dsl"].version}, and ` +
    `@synapsor/spec@${manifest.published_packages["@synapsor/spec"].version}.\n`,
  );
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

function packPublishedBaseline(destination) {
  const result = run("npm", [
    "pack",
    `@synapsor/runner@${manifest.published_packages["@synapsor/runner"].version}`,
    "--silent",
    "--pack-destination",
    destination,
  ], { cwd: tempRoot });
  return resolvePackedFilename(destination, result.stdout);
}

function packCurrentPackage(packageDirectory, destination) {
  const result = run("corepack", [
    "pnpm",
    "pack",
    "--pack-destination",
    destination,
  ], { cwd: packageDirectory });
  return resolvePackedFilename(destination, result.stdout);
}

function resolvePackedFilename(destination, stdout) {
  const filename = stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `npm pack did not report a tarball filename:\n${stdout}`);
  return path.join(destination, path.basename(filename));
}

function installTarball(label, tarball, localDependencies = []) {
  const installRoot = path.join(tempRoot, label);
  fs.mkdirSync(installRoot);
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", tarball, ...localDependencies], { cwd: installRoot });
  const packageRoot = path.join(installRoot, "node_modules", "@synapsor", "runner");
  return {
    label,
    installRoot,
    packageRoot,
    cli: path.join(packageRoot, "dist", "cli.js"),
  };
}

function verifyPackedCanonicalCompatibility(current) {
  const packedManifestPath = path.join(
    current.packageRoot,
    "fixtures",
    "compatibility",
    "published-1.5.4",
    "manifest.json",
  );
  const packedManifest = JSON.parse(fs.readFileSync(packedManifestPath, "utf8"));
  assert.deepEqual(packedManifest, manifest, "packed compatibility manifest changed");

  for (const fixture of manifest.contracts) {
    const source = packedCompatibilitySource(current.packageRoot, fixture.path);
    assert.equal(sha256(fs.readFileSync(source)), fixture.source_sha256, `${fixture.path} packed source changed`);
    const output = path.join(tempRoot, `normalized-${sha256(fixture.path).slice(0, 12)}.json`);
    run(process.execPath, [current.cli, "contract", "normalize", source, "--out", output], { cwd: current.installRoot });
    const normalized = JSON.parse(fs.readFileSync(output, "utf8"));
    assertLegacyContract(normalized, fixture.path);
    assert.equal(
      sha256(JSON.stringify(normalized)),
      fixture.canonical_sha256,
      `${fixture.path} packed canonical digest changed`,
    );
  }

  for (const fixture of manifest.dsl_sources) {
    const source = packedCompatibilitySource(current.packageRoot, fixture.path);
    assert.equal(sha256(fs.readFileSync(source)), fixture.source_sha256, `${fixture.path} packed DSL source changed`);
    const output = path.join(tempRoot, `compiled-${sha256(fixture.path).slice(0, 12)}.json`);
    run(process.execPath, [current.cli, "dsl", "compile", source, "--out", output], { cwd: current.installRoot });
    const normalized = JSON.parse(fs.readFileSync(output, "utf8"));
    assertLegacyContract(normalized, fixture.path);
    assert.equal(
      sha256(JSON.stringify(normalized)),
      fixture.canonical_sha256,
      `${fixture.path} packed DSL canonical digest changed`,
    );
  }
}

async function verifyLegacyToolSurface(baseline, current) {
  const baselineTools = await listLegacyTools(baseline);
  const currentTools = await listLegacyTools(current);
  assert.deepEqual(
    currentTools,
    baselineTools,
    "an existing active deployment changed tools/list without adopting new authority",
  );
  assert.deepEqual(
    currentTools.map((tool) => tool.name),
    [
      "support.inspect_customer",
      "support.propose_plan_credit",
      "support.propose_plan_credit_record",
    ],
  );
  assert.equal(fs.existsSync(path.join(current.installRoot, ".synapsor", "generation-lock.json")), false);
}

async function listLegacyTools(installed) {
  const example = path.join(installed.packageRoot, "examples", "support-plan-credit");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      installed.cli,
      "mcp",
      "serve",
      "--config",
      path.join(example, "synapsor.runner.json"),
      "--store",
      path.join(installed.installRoot, "legacy.db"),
    ],
    cwd: example,
    env: {
      ...process.env,
      PLAN_CREDIT_POSTGRES_READ_URL: "postgresql://reader:unused@127.0.0.1:1/unused",
      PLAN_CREDIT_POSTGRES_WRITE_URL: "postgresql://writer:unused@127.0.0.1:1/unused",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "compatibility-verifier",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `packed-${installed.label}-compatibility`, version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return canonicalize(result.tools).sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function verifyCliRouting(baseline, current) {
  const fixtureRoot = path.join(tempRoot, "cli-routing");
  fs.mkdirSync(fixtureRoot);
  const answersPath = path.join(fixtureRoot, "answers.json");
  const inspectionPath = path.join(fixtureRoot, "inspection.json");
  fs.writeFileSync(answersPath, `${JSON.stringify(legacyAnswers(), null, 2)}\n`);
  fs.writeFileSync(inspectionPath, `${JSON.stringify(legacyInspection(), null, 2)}\n`);

  const commonEnv = { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" };
  const routes = [
    ["init", "--answers", answersPath, "--yes", "--dry-run"],
    ["onboard", "db", "--answers", answersPath, "--yes", "--dry-run"],
    ["start", "--from-env", "DATABASE_URL", "--answers", answersPath, "--yes", "--dry-run", "--no-open"],
    [
      "start", "--from-env", "DATABASE_URL", "--inspection-json", inspectionPath,
      "--table", "support_tickets", "--mode", "read_only", "--yes", "--dry-run", "--no-open",
    ],
  ];

  for (const args of routes) {
    const baselineResult = runCli(baseline, args, { cwd: fixtureRoot, env: commonEnv });
    const currentResult = runCli(current, args, { cwd: fixtureRoot, env: commonEnv });
    assert.equal(currentResult.status, baselineResult.status, `${args.join(" ")} exit code changed`);
    assert.equal(currentResult.status, 0, `${args.join(" ")} failed`);
    assert.doesNotMatch(currentResult.stdout, /Opening the local first-safe-action workbench|https?:\/\/127\.0\.0\.1:/);
  }

  for (const args of [["start", "--help"], ["init", "--help"], ["onboard", "--help"]]) {
    assert.equal(runCli(current, args, { cwd: fixtureRoot, env: commonEnv }).status, 0);
  }
  const unsupportedBaseline = runCli(baseline, ["onboard", "unknown"], { cwd: fixtureRoot, env: commonEnv });
  const unsupportedCurrent = runCli(current, ["onboard", "unknown"], { cwd: fixtureRoot, env: commonEnv });
  assert.equal(unsupportedCurrent.status, unsupportedBaseline.status);
  assert.equal(unsupportedCurrent.status, 2);

  const selectorFree = runCli(current, ["start", "--from-env", "DATABASE_URL"], {
    cwd: fixtureRoot,
    env: commonEnv,
    timeout: 5000,
  });
  assert.notEqual(selectorFree.status, 0);
  assert.match(selectorFree.stderr, /Fresh Auto Boundary onboarding requires an interactive terminal/);
  assert.equal(fs.existsSync(path.join(fixtureRoot, ".synapsor", "generation-lock.json")), false);
}

async function verifyTypeScriptAuthoring(baseline, current) {
  const baselineAuthoring = await import(pathToFileURL(path.join(baseline.packageRoot, "dist", "authoring.mjs")).href);
  const currentAuthoring = await import(pathToFileURL(path.join(current.packageRoot, "dist", "authoring.mjs")).href);
  const legacyContract = JSON.parse(fs.readFileSync(
    path.join(root, manifest.contracts[0].path),
    "utf8",
  ));
  const { spec_version: _specVersion, kind: _kind, ...definition } = legacyContract;
  const baselineContract = baselineAuthoring.compileContract(definition);
  const currentContract = currentAuthoring.compileContract(definition);
  assert.deepEqual(currentContract, baselineContract, "legacy TypeScript authoring changed canonical output");
  assertLegacyContract(currentContract, "TypeScript authoring");
}

function legacyAnswers() {
  return {
    engine: "postgres",
    read_url_env: "DATABASE_URL",
    schema: "public",
    table: "support_tickets",
    primary_key: "id",
    tenant_column: "tenant_id",
    visible_columns: ["id", "tenant_id", "status", "updated_at"],
    mode: "read_only",
    namespace: "support",
    object_name: "support_ticket",
    id_arg: "ticket_id",
  };
}

function legacyInspection() {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16 compatibility fixture",
    current_user: "synapsor_reader",
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [{
      schema: "public",
      name: "support_tickets",
      type: "table",
      writable: false,
      columns: [
        legacyColumn("id", "text", { immutable: true }),
        legacyColumn("tenant_id", "text", { tenant: true, immutable: true }),
        legacyColumn("status", "text"),
        legacyColumn("updated_at", "timestamp", { conflict: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [],
      foreign_keys: [],
      indexes: [],
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: ["updated_at"],
        sensitive_columns: [],
        default_visible_columns: ["id", "tenant_id", "status", "updated_at"],
      },
    }],
  };
}

function legacyColumn(name, dataType, flags = {}) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: flags.tenant ?? false,
      conflict: flags.conflict ?? false,
      sensitive: false,
      immutable: flags.immutable ?? false,
      large_or_binary: false,
    },
  };
}

function packedCompatibilitySource(packageRoot, repositoryPath) {
  return path.join(
    packageRoot,
    "fixtures",
    "compatibility",
    "published-1.5.4",
    "sources",
    repositoryPath,
  );
}

function runCli(installed, args, options) {
  return spawnSync(process.execPath, [installed.cli, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout ?? 15000,
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function readPackageVersion(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

function assertLegacyContract(contract, label) {
  for (const capability of contract.capabilities ?? []) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(capability, "protected_read"),
      false,
      `${label} gained protected_read`,
    );
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}
