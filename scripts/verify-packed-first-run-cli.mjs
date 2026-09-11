import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withDemoComposeFixture } from "./demo-compose-fixture.mjs";
import { assertActiveStatus, assertDisabledStatus, createPackedCliSession } from "./packed-first-run-cli-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-first-run-cli-"));
const installRoot = path.join(tempRoot, "install");
const packRoot = path.join(tempRoot, "pack");
const fixtures = [
  {
    engine: "postgres",
    compose: path.join(root, "examples", "mcp-postgres-billing", "docker-compose.yml"),
    service: "postgres",
    container: "synapsor_runner_mcp_postgres_billing",
    databaseUrl: "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55433/synapsor_runner_mcp_billing",
    resource: "public.invoices",
    identity: "id",
    tenant: "tenant_id",
  },
  {
    engine: "mysql",
    compose: path.join(root, "examples", "mcp-mysql-orders", "docker-compose.yml"),
    service: "mysql",
    container: "synapsor_runner_mcp_mysql_orders",
    databaseUrl: "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53307/synapsor_runner_mcp_orders",
    resource: "synapsor_runner_mcp_orders.orders",
    identity: "id",
    tenant: "tenant_id",
  },
];

const results = [];
let completed = false;

try {
  const cli = await resolvePackedCli();
  for (const fixture of fixtures) {
    await withDemoComposeFixture({ ...fixture, exampleDir: path.dirname(fixture.compose) }, run, async () => {
    await waitForFixture(fixture);
    const before = sourceSnapshot(fixture);
    const projectRoot = await fsp.mkdtemp(path.join(tempRoot, `${fixture.engine}-project-`));
    const proof = await runFirstUseJourney({ cli, fixture, projectRoot });
    const after = sourceSnapshot(fixture);
    assert.equal(after, before, `${fixture.engine} first-run journey changed source data`);

    const status = cliJson(cli, ["boundary", "status", "--json"], projectRoot, proof.env);
    assertActiveStatus(status, fixture.resource);
    const review = cliJson(cli, ["boundary", "review", "--json"], projectRoot, proof.env);
    assert.equal(review.candidate_digest, status.active_digest);
    assert.deepEqual(review.candidate, proof.reviewedCandidate, "Activation or runtime checks changed the reviewed definition");
    assert.deepEqual(review.candidate.trusted_context, {
      provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL",
    });
    const resource = review.candidate.pack.resources.find((item) => item.id === fixture.resource);
    assert.ok(resource, `${fixture.engine} did not activate ${fixture.resource}`);
    assert.equal(resource.primary_key, fixture.identity);
    assert.equal(resource.tenant_key, fixture.tenant);
    assert.equal(review.candidate.deployment_profile, "staging");
    assertProjectHasNoCredential(projectRoot, fixture.databaseUrl);

    results.push({
      engine: fixture.engine,
      fresh_project: true,
      packed_artifact: true,
      identity_free_drafting_remains_disabled_until_explicit_activation: true,
      permission_configuration_does_not_require_concrete_identity: true,
      missing_trusted_scope_runtime_refused: true,
      write_runtime_identity_qualification: "not exercised: this first-run fixture activates Read only",
      trusted_scope_supplied_outside_model: true,
      job_first_entry: true,
      manual_controls_reachable: true,
      column_review_remained_open: true,
      boundary_activated: true,
      reached_model_choice: true,
      source_database_changed: false,
      elapsed_ms: proof.elapsedMs,
    });
    });
  }
  completed = true;
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
} finally {
  if (completed && process.env.SYNAPSOR_KEEP_PACKED_FIRST_RUN_TEMP !== "1") {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Packed first-run artifacts retained at ${tempRoot}\n`);
  }
}

async function resolvePackedCli() {
  const supplied = process.env.SYNAPSOR_PACKED_RUNNER?.trim();
  if (supplied) {
    const resolved = path.resolve(supplied);
    assert.ok(fs.existsSync(resolved), `SYNAPSOR_PACKED_RUNNER does not exist: ${resolved}`);
    return resolved;
  }
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);
  run("corepack", ["pnpm", "build:runner-package"]);
  const specTarball = packCurrent(path.join(root, "packages", "spec"));
  const runnerTarball = packCurrent(path.join(root, "apps", "runner"));
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", runnerTarball], { cwd: installRoot });
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(cli), "packed install omitted the synapsor-runner binary");
  return cli;
}

function packCurrent(packageRoot) {
  const packed = run("corepack", ["pnpm", "pack", "--pack-destination", packRoot], {
    cwd: packageRoot,
  });
  const filename = packed.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not report a tarball for ${packageRoot}`);
  return path.join(packRoot, path.basename(filename));
}

async function waitForFixture(fixture) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const ready = fixture.engine === "postgres"
      ? run("docker", [
        "exec", "-e", "PGPASSWORD=synapsor_reader_password", fixture.container,
        "psql", "-h", "127.0.0.1", "-U", "synapsor_reader",
        "-d", "synapsor_runner_mcp_billing", "-Atc", "SELECT COUNT(*) FROM public.invoices",
      ], { allowFailure: true })
      : run("docker", [
        "exec", "-e", "MYSQL_PWD=synapsor_reader_password", fixture.container,
        "mysql", "-h127.0.0.1", "-usynapsor_reader", "-N", "-B",
        "synapsor_runner_mcp_orders", "-e", "SELECT COUNT(*) FROM orders",
      ], { allowFailure: true });
    if (ready.status === 0) return;
    await delay(250);
  }
  throw new Error(`${fixture.engine} fixture did not become query-ready within 60 seconds`);
}

function cliJson(cli, args, projectRoot, env) {
  return JSON.parse(run(process.execPath, [cli, ...args], { cwd: projectRoot, env }).stdout);
}

async function runFirstUseJourney({ cli, fixture, projectRoot }) {
  const started = Date.now();
  const baseEnv = { ...process.env, DATABASE_URL: fixture.databaseUrl,
    TERM: "xterm-256color", COLUMNS: "120", LINES: "40" };
  for (const key of ["SYNAPSOR_TENANT_ID", "SYNAPSOR_PRINCIPAL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "NO_COLOR"]) delete baseEnv[key];
  const command = "stty cols 120 rows 40; " + shellQuote(process.execPath) + " " + shellQuote(cli) + " start --from-env DATABASE_URL --cli";
  const open = (env, label) => createPackedCliSession({ command, projectRoot, env,
    evidencePath: path.join(tempRoot, fixture.engine + "-" + label + "-session.json") });
  const manual = async (session) => {
    await session.waitForScreen(/START BOUNDARY DRAFTING/, "disabled drafting chooser");
    await session.choose("Open the manual Boundary editors");
    await session.waitForScreen(/EDIT ACCESS/, "manual table editor");
    session.send("\r");
    await session.waitForScreen(new RegExp("REVIEW COLUMNS - " + escapeRegExp(fixture.resource)), "column review");
    session.send("\r");
    await session.waitFor(/Agent authority (?:is unchanged|changed: no)\.[\s\S]*EDIT ACCESS/, "parent editor after column review");
    await session.waitForScreen(/EDIT ACCESS/, "visible parent editor after column review");
  };

  const missing = open(baseEnv, "missing-binding");
  try {
    await manual(missing);
    assertDisabledStatus(cliJson(cli, ["boundary", "status", "--json"], projectRoot, baseEnv));
    assert.doesNotMatch(missing.transcript(), /ACTIVATION SUCCEEDED/);
    missing.send("q");
    const paused = await missing.waitForExit();
    assert.equal(paused.code, 0, "Identity-free authoring must exit without activating authority");
  } finally { await missing.close(); }
  assertDisabledStatus(cliJson(cli, ["boundary", "status", "--json"], projectRoot, baseEnv));

  const env = { ...baseEnv, SYNAPSOR_TENANT_ID: "acme" };
  const session = open(baseEnv, "authority-review-without-identity");
  let reviewedCandidate;
  try {
    await manual(session);
    reviewedCandidate = cliJson(cli, ["boundary", "review", "--json"], projectRoot, baseEnv).candidate;
    session.send("c");
    await session.waitFor(/Activate "reviewed_staging" exactly as shown now\? You will stay in \/access\. \[y\/N\]/,
      "explicit exact activation prompt");
    assert.match(session.transcript(), /REVIEW EXACT BOUNDARY/);
    session.send("y");
    await session.waitFor(/ACTIVATION SUCCEEDED/, "persisted Read activation");
    await session.waitForScreen(/EDIT ACCESS[\s\S]*ACTIVE\s+1 table/, "access editor remains open after activation");
    session.send("q");
    await session.waitForScreen(/MORE OPTIONS[\s\S]*OpenAI/, "model continuation chooser");
    await session.choose("Back to client setup");
    await session.waitForScreen(/CONNECT YOUR CLIENT/, "client continuation chooser");
    await session.choose("Later");
    const result = await session.waitForExit();
    assert.equal(result.code, 0, "Later handoff must exit cleanly");
    assert.match(session.transcript(), /Your reviewed boundaries remain active/);
    assert.doesNotMatch(session.transcript(), /Ask did not start:/);
    assert.doesNotMatch(session.transcript(), new RegExp(escapeRegExp(fixture.databaseUrl)));
  } finally { await session.close(); }

  const active = cliJson(cli, ["boundary", "status", "--json"], projectRoot, env);
  assertActiveStatus(active, fixture.resource);
  const planPath = path.join(tempRoot, fixture.engine + "-count-plan.json");
  await fsp.writeFile(planPath, JSON.stringify({ kind: "aggregate", resource: fixture.resource,
    measures: [{ function: "count" }], order_by: { kind: "measure", index: 0, direction: "desc" }, top_n: 1 }));
  const args = [cli, "explore", "run", "--plan", planPath, "--json"];
  const refused = run(process.execPath, args, { cwd: projectRoot, env: baseEnv, allowFailure: true });
  await fsp.writeFile(path.join(tempRoot, fixture.engine + "-missing-runtime-binding.json"),
    JSON.stringify({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr }, null, 2));
  assert.notEqual(refused.status, 0, "Active authority must not execute a query without trusted identity");
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error.code, "EXPLORE_SCOPE_FORBIDDEN");
  assert.match(refusal.error.message, /trusted runtime bindings outside model arguments: SYNAPSOR_TENANT_ID/);
  assertActiveStatus(cliJson(cli, ["boundary", "status", "--json"], projectRoot, env), fixture.resource);
  const explored = run(process.execPath, args, { cwd: projectRoot, env });
  await fsp.writeFile(path.join(tempRoot, fixture.engine + "-trusted-runtime-read.json"), explored.stdout);
  const result = JSON.parse(explored.stdout);
  assert.equal(result.ok, true, "The exact same plan must work with the externally supplied trusted tenant");
  return { elapsedMs: Date.now() - started, env, reviewedCandidate };
}

function sourceSnapshot(fixture) {
  if (fixture.engine === "postgres") {
    return run("docker", [
      "exec", fixture.container,
      "psql", "-U", "synapsor_admin", "-d", "synapsor_runner_mcp_billing", "-Atc",
      "SELECT jsonb_build_object('invoices', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.invoices t), 'receipts', (SELECT jsonb_agg(to_jsonb(t) ORDER BY idempotency_key) FROM public.synapsor_writeback_receipts t))",
    ]).stdout.trim();
  }
  return run("docker", [
    "exec", "-e", "MYSQL_PWD=root_password", fixture.container,
    "mysql", "-uroot", "-N", "-B", "synapsor_runner_mcp_orders", "-e",
    "SELECT JSON_OBJECT('id', id, 'tenant_id', tenant_id, 'customer_name', customer_name, 'status', status, 'status_change_reason', status_change_reason, 'refund_review_status', refund_review_status, 'refund_note', refund_note, 'updated_at', updated_at) FROM orders ORDER BY id; SELECT * FROM synapsor_writeback_receipts ORDER BY idempotency_key",
  ]).stdout.trim();
}

function assertProjectHasNoCredential(projectRoot, databaseUrl) {
  const text = collectText(projectRoot);
  assert.doesNotMatch(text, new RegExp(escapeRegExp(databaseUrl)));
  assert.doesNotMatch(text, /synapsor_reader_password/);
}

function collectText(rootPath) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .map((entry) => {
      const resolved = path.join(rootPath, entry.name);
      if (entry.isDirectory()) return collectText(resolved);
      if (entry.name.endsWith(".db") || fs.statSync(resolved).size > 2_000_000) return "";
      return fs.readFileSync(resolved, "utf8");
    })
    .join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message})\n`
      + `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}
