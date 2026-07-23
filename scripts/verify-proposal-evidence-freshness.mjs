import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import {
  main as runnerMain,
  verifyLocalWritebackAuthority,
} from "../apps/runner/dist/cli.js";
import { createMcpRuntime } from "../packages/mcp-server/dist/index.js";
import {
  PostgresProposalRuntimeStore,
  ProposalStore,
} from "../packages/proposal-store/dist/index.js";
import { applyMysqlJob } from "../packages/mysql/dist/index.js";
import { applyPostgresJob } from "../packages/postgres/dist/index.js";
import { parseWritebackJob } from "../packages/protocol/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const pgAdminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309/synapsor_fleet";
const { Pool } = pg;

const engines = {
  postgres: {
    schema: "public",
    readEnv: "FRESHNESS_POSTGRES_READ_URL",
    writeEnv: "FRESHNESS_POSTGRES_WRITE_URL",
    readUrl: "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet",
    sourceWriteUrl: "postgresql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:55439/synapsor_fleet",
    ledgerWriteUrl: "postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:55439/synapsor_fleet",
    unavailableUrl: "postgresql://unavailable:unavailable@127.0.0.1:1/unavailable?connect_timeout=1",
    receipt: {
      authority: "source_db",
      provisioning: "precreated",
      schema: "synapsor_precreated",
      table: "receipts",
    },
    apply: applyPostgresJob,
  },
  mysql: {
    schema: "synapsor_fleet",
    readEnv: "FRESHNESS_MYSQL_READ_URL",
    writeEnv: "FRESHNESS_MYSQL_WRITE_URL",
    readUrl: "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet",
    sourceWriteUrl: "mysql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:53309/synapsor_fleet",
    ledgerWriteUrl: "mysql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:53309/synapsor_fleet",
    unavailableUrl: "mysql://unavailable:unavailable@127.0.0.1:1/unavailable?connectTimeout=500",
    receipt: {
      authority: "source_db",
      provisioning: "precreated",
      schema: "synapsor_fleet",
      table: "synapsor_receipts_precreated",
    },
    apply: applyMysqlJob,
  },
};

const scenarioIds = [
  "fresh-source",
  "fresh-ledger",
  "target-before",
  "support-before",
  "unavailable",
  "support-after",
  "target-after",
  "delete-fresh",
  "quorum",
  "shared-runtime",
  "cloud-approved",
];

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function waitForDatabases() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const pgReady = run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "postgres",
      "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet",
    ], { allowFailure: true });
    const mysqlReady = run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "mysql",
      "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password",
    ], { allowFailure: true });
    if (pgReady.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("proposal freshness databases did not become ready");
}

function targetId(engine, scenario) {
  return `${engine}-${scenario}`;
}

function dependencyIds(engine, scenario) {
  const target = targetId(engine, scenario);
  return {
    eligibility: `${target}-a-eligibility`,
    policy: `${target}-z-policy`,
  };
}

async function setupPostgres(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS public.freshness_batch_targets;
    DROP TABLE IF EXISTS public.freshness_dependencies;
    DROP TABLE IF EXISTS public.freshness_targets;

    CREATE TABLE public.freshness_targets (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      status text NOT NULL,
      amount_cents integer NOT NULL,
      internal_note text NOT NULL,
      version integer NOT NULL
    );
    CREATE TABLE public.freshness_dependencies (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      eligible boolean NOT NULL,
      secret_risk text NOT NULL,
      version integer NOT NULL
    );
    CREATE TABLE public.freshness_batch_targets (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      status text NOT NULL,
      amount_cents integer NOT NULL,
      internal_note text NOT NULL,
      version integer NOT NULL
    );

    GRANT SELECT ON public.freshness_targets, public.freshness_dependencies, public.freshness_batch_targets TO synapsor_reader;
    GRANT SELECT, UPDATE, DELETE ON public.freshness_targets, public.freshness_batch_targets TO synapsor_crud_precreated, synapsor_crud_ledger;
    GRANT SELECT ON public.freshness_dependencies TO synapsor_crud_precreated, synapsor_crud_ledger;
    GRANT UPDATE (version) ON public.freshness_dependencies TO synapsor_crud_precreated, synapsor_crud_ledger;
  `);
  for (const scenario of scenarioIds) {
    const id = targetId("postgres", scenario);
    const dependencies = dependencyIds("postgres", scenario);
    await pool.query(
      "INSERT INTO public.freshness_targets (id, tenant_id, status, amount_cents, internal_note, version) VALUES ($1, 'acme', 'open', 100, 'target-secret', 1)",
      [id],
    );
    for (const dependencyId of Object.values(dependencies)) {
      await pool.query(
        "INSERT INTO public.freshness_dependencies (id, tenant_id, eligible, secret_risk, version) VALUES ($1, 'acme', true, 'must-never-be-persisted', 1)",
        [dependencyId],
      );
    }
  }
  await pool.query(`
    INSERT INTO public.freshness_batch_targets (id, tenant_id, status, amount_cents, internal_note, version) VALUES
      ('postgres-batch-1', 'acme', 'pending_freshness_batch', 10, 'batch-secret-1', 1),
      ('postgres-batch-2', 'acme', 'pending_freshness_batch', 20, 'batch-secret-2', 1);
  `);
  for (const dependencyId of Object.values(dependencyIds("postgres", "batch"))) {
    await pool.query(
      "INSERT INTO public.freshness_dependencies (id, tenant_id, eligible, secret_risk, version) VALUES ($1, 'acme', true, 'must-never-be-persisted', 1)",
      [dependencyId],
    );
  }
}

async function setupMysql(connection) {
  for (const statement of [
    "DROP TABLE IF EXISTS freshness_batch_targets",
    "DROP TABLE IF EXISTS freshness_dependencies",
    "DROP TABLE IF EXISTS freshness_targets",
    `CREATE TABLE freshness_targets (
      id varchar(191) PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      status varchar(64) NOT NULL,
      amount_cents integer NOT NULL,
      internal_note varchar(255) NOT NULL,
      version integer NOT NULL
    )`,
    `CREATE TABLE freshness_dependencies (
      id varchar(191) PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      eligible boolean NOT NULL,
      secret_risk varchar(255) NOT NULL,
      version integer NOT NULL
    )`,
    `CREATE TABLE freshness_batch_targets (
      id varchar(191) PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      status varchar(64) NOT NULL,
      amount_cents integer NOT NULL,
      internal_note varchar(255) NOT NULL,
      version integer NOT NULL
    )`,
    "GRANT SELECT ON synapsor_fleet.freshness_targets TO 'synapsor_reader'@'%'",
    "GRANT SELECT ON synapsor_fleet.freshness_dependencies TO 'synapsor_reader'@'%'",
    "GRANT SELECT ON synapsor_fleet.freshness_batch_targets TO 'synapsor_reader'@'%'",
    "GRANT SELECT, UPDATE, DELETE ON synapsor_fleet.freshness_targets TO 'synapsor_crud_precreated'@'%', 'synapsor_crud_ledger'@'%'",
    "GRANT SELECT, UPDATE, DELETE ON synapsor_fleet.freshness_batch_targets TO 'synapsor_crud_precreated'@'%', 'synapsor_crud_ledger'@'%'",
    "GRANT SELECT ON synapsor_fleet.freshness_dependencies TO 'synapsor_crud_precreated'@'%', 'synapsor_crud_ledger'@'%'",
    "GRANT UPDATE (version) ON synapsor_fleet.freshness_dependencies TO 'synapsor_crud_precreated'@'%', 'synapsor_crud_ledger'@'%'",
    "GRANT TRIGGER ON synapsor_fleet.freshness_targets TO 'synapsor_crud_precreated'@'%', 'synapsor_crud_ledger'@'%'",
    "FLUSH PRIVILEGES",
  ]) {
    await connection.query(statement);
  }
  for (const scenario of scenarioIds) {
    const id = targetId("mysql", scenario);
    const dependencies = dependencyIds("mysql", scenario);
    await connection.query(
      "INSERT INTO freshness_targets (id, tenant_id, status, amount_cents, internal_note, version) VALUES (?, 'acme', 'open', 100, 'target-secret', 1)",
      [id],
    );
    for (const dependencyId of Object.values(dependencies)) {
      await connection.query(
        "INSERT INTO freshness_dependencies (id, tenant_id, eligible, secret_risk, version) VALUES (?, 'acme', true, 'must-never-be-persisted', 1)",
        [dependencyId],
      );
    }
  }
  await connection.query(`
    INSERT INTO freshness_batch_targets (id, tenant_id, status, amount_cents, internal_note, version) VALUES
      ('mysql-batch-1', 'acme', 'pending_freshness_batch', 10, 'batch-secret-1', 1),
      ('mysql-batch-2', 'acme', 'pending_freshness_batch', 20, 'batch-secret-2', 1)
  `);
  for (const dependencyId of Object.values(dependencyIds("mysql", "batch"))) {
    await connection.query(
      "INSERT INTO freshness_dependencies (id, tenant_id, eligible, secret_risk, version) VALUES (?, 'acme', true, 'must-never-be-persisted', 1)",
      [dependencyId],
    );
  }
}

function sourceConfig(engine, receiptMode) {
  const descriptor = engines[engine];
  return {
    engine,
    read_url_env: descriptor.readEnv,
    write_url_env: descriptor.writeEnv,
    statement_timeout_ms: 3000,
    receipts: receiptMode === "runner_ledger"
      ? { authority: "runner_ledger" }
      : descriptor.receipt,
  };
}

function dependencyCapabilities(engine) {
  const schema = engines[engine].schema;
  return [
    {
      name: "orders.inspect_policy_state",
      kind: "read",
      source: "app_db",
      target: {
        schema,
        table: "freshness_dependencies",
        primary_key: "id",
        tenant_key: "tenant_id",
      },
      args: { policy_id: { type: "string", required: true, max_length: 191 } },
      lookup: { id_from_arg: "policy_id" },
      visible_columns: ["id", "eligible", "version"],
      kept_out_fields: ["secret_risk"],
      evidence: "required",
      max_rows: 1,
    },
    {
      name: "orders.inspect_eligibility",
      kind: "read",
      source: "app_db",
      target: {
        schema,
        table: "freshness_dependencies",
        primary_key: "id",
        tenant_key: "tenant_id",
      },
      args: { eligibility_id: { type: "string", required: true, max_length: 191 } },
      lookup: { id_from_arg: "eligibility_id" },
      visible_columns: ["id", "eligible", "version"],
      kept_out_fields: ["secret_risk"],
      evidence: "required",
      max_rows: 1,
    },
  ];
}

function commonProposalFields(engine, table = "freshness_targets") {
  return {
    source: "app_db",
    target: {
      schema: engines[engine].schema,
      table,
      primary_key: "id",
      tenant_key: "tenant_id",
    },
    evidence: "required",
    approval: { mode: "human", required_role: "operations_reviewer" },
    writeback: { mode: "direct_sql" },
  };
}

function freshnessDependencies() {
  // Intentionally reverse lexical identity order. Capture must normalize the
  // resolved descriptors before hashing and apply must preserve that order.
  return [
    {
      id: "policy_state",
      capability: "orders.inspect_policy_state",
      identity_from_arg: "policy_id",
      version_column: "version",
    },
    {
      id: "eligibility",
      capability: "orders.inspect_eligibility",
      identity_from_arg: "eligibility_id",
      version_column: "version",
    },
  ];
}

function runtimeConfig(engine, receiptMode, options = {}) {
  const updateApproval = options.quorum
    ? { mode: "human", required_role: "operations_reviewer", required_approvals: 2 }
    : options.policy
      ? {
          mode: "policy",
          required_role: "operations_reviewer",
          policy: "orders_small_adjustment_auto_approval",
        }
      : { mode: "human", required_role: "operations_reviewer" };
  const update = {
    name: "orders.propose_adjustment",
    kind: "proposal",
    ...commonProposalFields(engine),
    args: {
      order_id: { type: "string", required: true, max_length: 191 },
      eligibility_id: { type: "string", required: true, max_length: 191 },
      policy_id: { type: "string", required: true, max_length: 191 },
      amount_cents: { type: "number", required: true, minimum: 1, maximum: 1000 },
    },
    lookup: { id_from_arg: "order_id" },
    visible_columns: ["id", "tenant_id", "status", "amount_cents", "version"],
    kept_out_fields: ["internal_note"],
    max_rows: 1,
    patch: { amount_cents: { from_arg: "amount_cents" } },
    allowed_columns: ["amount_cents"],
    numeric_bounds: { amount_cents: { minimum: 1, maximum: 1000 } },
    conflict_guard: { column: "version" },
    operation: {
      kind: "update",
      version_advance: { column: "version", strategy: "integer_increment" },
    },
    ...(options.policy ? {} : { reversibility: { mode: "reviewed_inverse" } }),
    approval: updateApproval,
    ...(options.contractProvenance
      ? { contract_provenance: options.contractProvenance }
      : {}),
  };
  const deletion = {
    name: "orders.propose_delete",
    kind: "proposal",
    ...commonProposalFields(engine),
    args: {
      order_id: { type: "string", required: true, max_length: 191 },
      eligibility_id: { type: "string", required: true, max_length: 191 },
      policy_id: { type: "string", required: true, max_length: 191 },
    },
    lookup: { id_from_arg: "order_id" },
    visible_columns: ["id", "tenant_id", "status", "amount_cents", "version"],
    kept_out_fields: ["internal_note"],
    max_rows: 1,
    patch: {},
    allowed_columns: [],
    conflict_guard: { column: "version" },
    operation: { kind: "delete" },
  };
  const setUpdate = {
    name: "orders.propose_close_batch",
    kind: "proposal",
    ...commonProposalFields(engine, "freshness_batch_targets"),
    args: {
      eligibility_id: { type: "string", required: true, max_length: 191 },
      policy_id: { type: "string", required: true, max_length: 191 },
    },
    lookup: { id_from_arg: "eligibility_id" },
    visible_columns: ["id", "tenant_id", "status", "amount_cents", "version"],
    kept_out_fields: ["internal_note"],
    patch: { status: { fixed: "closed" } },
    allowed_columns: ["status"],
    conflict_guard: { column: "version" },
    operation: {
      kind: "update",
      cardinality: "set",
      selection: {
        all: [{ column: "status", operator: "eq", value: "pending_freshness_batch" }],
      },
      max_rows: 2,
      aggregate_bounds: [{ column: "amount_cents", measure: "before", maximum: 100 }],
      version_advance: { column: "version", strategy: "integer_increment" },
    },
  };
  return {
    version: 1,
    mode: "review",
    storage: { sqlite_path: ":memory:" },
    sources: { app_db: sourceConfig(engine, receiptMode) },
    trusted_context: {
      provider: "static_dev",
      values: { tenant_id: "acme", principal: "freshness_verifier" },
    },
    capabilities: [
      ...dependencyCapabilities(engine),
      update,
      deletion,
      setUpdate,
    ],
    proposal_freshness: {
      "orders.propose_adjustment": {
        approval: "required",
        dependencies: freshnessDependencies(),
      },
      "orders.propose_delete": {
        approval: "required",
        dependencies: freshnessDependencies(),
      },
      "orders.propose_close_batch": {
        approval: "required",
        dependencies: freshnessDependencies(),
      },
    },
    ...(options.policy
      ? {
          policies: [{
            name: "orders_small_adjustment_auto_approval",
            kind: "approval",
            mode: "green",
            rules: [{ field: "amount_cents", max: 1000 }],
          }],
        }
      : {}),
  };
}

function proposalArgs(engine, scenario, operation = "update") {
  const id = targetId(engine, scenario);
  const dependencies = dependencyIds(engine, scenario);
  return {
    capability: operation === "delete" ? "orders.propose_delete" : "orders.propose_adjustment",
    args: {
      order_id: id,
      eligibility_id: dependencies.eligibility,
      policy_id: dependencies.policy,
      ...(operation === "delete" ? {} : { amount_cents: 777 }),
    },
  };
}

async function writeConfig(tempDir, name, config) {
  const configPath = path.join(tempDir, `${name}.runner.json`);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

async function createProposal({ config, configPath, storePath, capability, args }) {
  const store = new ProposalStore(storePath);
  const runtime = createMcpRuntime(config, { store, env: process.env });
  try {
    const result = await runtime.callTool(capability, args);
    assert(typeof result.proposal_id === "string", "runtime did not create a proposal", result);
    assert(result.source_database_mutated === false, "proposal creation mutated the source", result);
    return result.proposal_id;
  } finally {
    await runtime.close();
  }
}

async function scenarioFiles(tempDir, engine, scenario, receiptMode = "source_db", options = {}) {
  const config = runtimeConfig(engine, receiptMode, options);
  const configPath = await writeConfig(tempDir, `${engine}-${scenario}-${receiptMode}`, config);
  const storePath = path.join(tempDir, `${engine}-${scenario}-${receiptMode}.db`);
  return { config, configPath, storePath };
}

async function runCli(args) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let output = "";
  let errorOutput = "";
  const captureOutput = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  const captureError = (chunk, encoding, callback) => {
    errorOutput += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  process.stdout.write = captureOutput;
  process.stderr.write = captureError;
  try {
    return { code: await runnerMain(args), output, errorOutput };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

async function cliDoctorFreshness(configPath) {
  const result = await runCli([
    "doctor",
    "--check-writeback",
    "--json",
    "--config",
    configPath,
  ]);
  assert(result.code === 0, `freshness doctor returned ${result.code}`, {
    stdout: result.output,
    stderr: result.errorOutput,
  });
  const report = JSON.parse(result.output);
  const probes = report.checks.filter((check) =>
    String(check.name).includes(":freshness-dependency:")
      && String(check.name).endsWith(":lock-probe"));
  assert(probes.length > 0, "freshness doctor did not emit dependency lock probes", report.checks);
  assert(probes.every((check) => check.level === "pass"), "freshness dependency lock probe failed", probes);
}

async function cliCheck(configPath, storePath, expectedCode) {
  const result = await runCli([
    "proposals", "check-freshness", "latest",
    "--json", "--config", configPath, "--store", storePath,
  ]);
  assert(result.code === expectedCode, `freshness CLI returned ${result.code}, expected ${expectedCode}`, result.output);
}

async function cliApprove(configPath, storePath, actor, expectedCode = 0) {
  const result = await runCli([
    "proposals", "approve", "latest",
    "--yes", "--json", "--actor", actor,
    "--config", configPath, "--store", storePath,
  ]);
  assert(result.code === expectedCode, `approval CLI returned ${result.code}, expected ${expectedCode}`, result.output);
}

async function cliApply(proposalId, configPath, storePath) {
  const result = await runCli([
    "apply", proposalId,
    "--yes", "--json",
    "--config", configPath,
    "--store", storePath,
  ]);
  assert(result.code === 0, `apply CLI returned ${result.code}`, result.output);
}

async function queryTarget(engine, admin, id) {
  if (engine === "postgres") {
    const result = await admin.query(
      "SELECT id, tenant_id, status, amount_cents, version FROM public.freshness_targets WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }
  const [rows] = await admin.query(
    "SELECT id, tenant_id, status, amount_cents, version FROM freshness_targets WHERE id = ?",
    [id],
  );
  return rows[0];
}

async function changeTargetVersion(engine, admin, id) {
  if (engine === "postgres") {
    await admin.query("UPDATE public.freshness_targets SET version = version + 1 WHERE id = $1", [id]);
  } else {
    await admin.query("UPDATE freshness_targets SET version = version + 1 WHERE id = ?", [id]);
  }
}

async function changeDependency(engine, admin, id, options = {}) {
  if (engine === "postgres") {
    await admin.query(
      options.moveTenant
        ? "UPDATE public.freshness_dependencies SET tenant_id = 'globex', version = version + 1 WHERE id = $1"
        : "UPDATE public.freshness_dependencies SET eligible = NOT eligible, version = version + 1 WHERE id = $1",
      [id],
    );
  } else {
    await admin.query(
      options.moveTenant
        ? "UPDATE freshness_dependencies SET tenant_id = 'globex', version = version + 1 WHERE id = ?"
        : "UPDATE freshness_dependencies SET eligible = NOT eligible, version = version + 1 WHERE id = ?",
      [id],
    );
  }
}

async function batchRows(engine, admin) {
  if (engine === "postgres") {
    const result = await admin.query(
      "SELECT id, status, amount_cents, version FROM public.freshness_batch_targets ORDER BY id",
    );
    return result.rows;
  }
  const [rows] = await admin.query(
    "SELECT id, status, amount_cents, version FROM freshness_batch_targets ORDER BY id",
  );
  return rows;
}

function inspectStore(storePath, proposalId) {
  const store = new ProposalStore(storePath);
  try {
    const proposal = store.getProposal(proposalId);
    const approvals = store.approvals(proposalId);
    const receipts = store.receipts(proposalId);
    const jobs = store.listWritebackJobs({ proposal_id: proposalId });
    const ledger = JSON.stringify(store.sharedLedgerEntries());
    return { proposal, approvals, receipts, jobs, ledger };
  } finally {
    store.close();
  }
}

function applyConfig(engine, receiptMode, storePath) {
  const descriptor = engines[engine];
  const config = {
    controlPlaneUrl: "http://127.0.0.1:1",
    runnerToken: "synthetic-local-token",
    runnerId: `freshness-${engine}-${receiptMode}`,
    sourceId: "app_db",
    databaseUrl: receiptMode === "runner_ledger"
      ? descriptor.ledgerWriteUrl
      : descriptor.sourceWriteUrl,
    engine,
    pollIntervalMs: 1000,
    statementTimeoutMs: 3000,
    logLevel: "error",
    dryRun: false,
    stateDir: ".synapsor/test-state",
    receipts: receiptMode === "runner_ledger"
      ? { authority: "runner_ledger" }
      : descriptor.receipt,
  };
  if (receiptMode === "runner_ledger") {
    config.writebackIntentStore = new ProposalStore(storePath);
  }
  return config;
}

async function closeApplyConfig(config) {
  if (config.writebackIntentStore instanceof ProposalStore) {
    config.writebackIntentStore.close();
  }
}

async function verifyFreshSourceApply(engine, admin, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "fresh-source");
  await cliDoctorFreshness(files.configPath);
  const request = proposalArgs(engine, "fresh-source");
  const proposalId = await createProposal({ ...files, ...request });
  let snapshot = inspectStore(files.storePath, proposalId);
  const dependencyValues = snapshot.proposal.change_set.freshness.dependencies
    .map((dependency) => dependency.target.primary_key.value);
  assert(
    JSON.stringify(dependencyValues) === JSON.stringify([...dependencyValues].sort()),
    `${engine} dependency descriptors were not normalized before hashing`,
    dependencyValues,
  );

  await cliCheck(files.configPath, files.storePath, 0);
  await cliApprove(files.configPath, files.storePath, `${engine}_reviewer`);
  await cliApply(proposalId, files.configPath, files.storePath);

  const row = await queryTarget(engine, admin, targetId(engine, "fresh-source"));
  assert(Number(row?.amount_cents) === 777 && Number(row?.version) === 2, `${engine} fresh source-db update did not apply exactly`, row);
  snapshot = inspectStore(files.storePath, proposalId);
  assert(snapshot.proposal?.state === "applied", `${engine} applied proposal did not become applied`, snapshot.proposal);
  assert(snapshot.approvals.length === 1 && snapshot.approvals[0]?.freshness_proof_digest, `${engine} approval did not bind a freshness proof`, snapshot.approvals);
  assert(snapshot.receipts[0]?.receipt.inverse?.availability === "available", `${engine} reversible update did not preserve inverse authority`, snapshot.receipts);
  assert(!snapshot.ledger.includes("must-never-be-persisted"), `${engine} persisted a kept-out supporting value`);
  assert(!snapshot.ledger.includes("target-secret"), `${engine} persisted a kept-out target value`);

  const job = parseWritebackJob(snapshot.jobs[0]?.payload);
  const retryConfig = applyConfig(engine, "source_db", files.storePath);
  try {
    const retry = await engines[engine].apply(job, retryConfig);
    assert(retry.status === "already_applied" && retry.affected_rows === 0, `${engine} source-db retry was not idempotent`, retry);
  } finally {
    await closeApplyConfig(retryConfig);
  }
}

async function verifyStaleBeforeApproval(engine, admin, tempDir) {
  const targetFiles = await scenarioFiles(tempDir, engine, "target-before");
  const targetRequest = proposalArgs(engine, "target-before");
  const targetProposalId = await createProposal({ ...targetFiles, ...targetRequest });
  await changeTargetVersion(engine, admin, targetId(engine, "target-before"));
  await cliCheck(targetFiles.configPath, targetFiles.storePath, 3);
  let snapshot = inspectStore(targetFiles.storePath, targetProposalId);
  assert(snapshot.proposal?.state === "conflict" && snapshot.approvals.length === 0, `${engine} stale target was approveable`, snapshot);

  const supportFiles = await scenarioFiles(tempDir, engine, "support-before");
  const supportRequest = proposalArgs(engine, "support-before");
  const supportProposalId = await createProposal({ ...supportFiles, ...supportRequest });
  await changeDependency(engine, admin, dependencyIds(engine, "support-before").eligibility, { moveTenant: true });
  await cliApprove(supportFiles.configPath, supportFiles.storePath, `${engine}_reviewer`, 3);
  snapshot = inspectStore(supportFiles.storePath, supportProposalId);
  const target = await queryTarget(engine, admin, targetId(engine, "support-before"));
  assert(snapshot.proposal?.state === "conflict" && snapshot.approvals.length === 0, `${engine} stale supporting evidence was approveable`, snapshot);
  assert(Number(target?.amount_cents) === 100 && Number(target?.version) === 1, `${engine} stale preflight mutated its target`, target);
  assert(!snapshot.ledger.includes("globex"), `${engine} stale/out-of-scope proof disclosed the moved tenant`);
}

async function verifyUnavailable(engine, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "unavailable");
  const request = proposalArgs(engine, "unavailable");
  const proposalId = await createProposal({ ...files, ...request });
  const descriptor = engines[engine];
  const original = process.env[descriptor.readEnv];
  process.env[descriptor.readEnv] = descriptor.unavailableUrl;
  try {
    await cliCheck(files.configPath, files.storePath, 4);
  } finally {
    process.env[descriptor.readEnv] = original;
  }
  const snapshot = inspectStore(files.storePath, proposalId);
  assert(snapshot.proposal?.state === "pending_review" && snapshot.approvals.length === 0, `${engine} unavailable source changed approval state`, snapshot);
  assert(!snapshot.ledger.includes("unavailable@"), `${engine} persisted unavailable-source credentials`);
}

async function verifyDriftAfterApproval(engine, admin, tempDir) {
  const supportFiles = await scenarioFiles(tempDir, engine, "support-after");
  const supportRequest = proposalArgs(engine, "support-after");
  const supportProposalId = await createProposal({ ...supportFiles, ...supportRequest });
  await cliApprove(supportFiles.configPath, supportFiles.storePath, `${engine}_reviewer`);
  await changeDependency(engine, admin, dependencyIds(engine, "support-after").policy);
  await cliApply(supportProposalId, supportFiles.configPath, supportFiles.storePath);
  let snapshot = inspectStore(supportFiles.storePath, supportProposalId);
  let target = await queryTarget(engine, admin, targetId(engine, "support-after"));
  assert(snapshot.proposal?.state === "conflict", `${engine} post-approval supporting drift did not become conflict`, snapshot.proposal);
  assert(snapshot.receipts[0]?.receipt.safe_error_code === "FRESHNESS_DEPENDENCY_STALE", `${engine} supporting conflict lost its safe code`, snapshot.receipts);
  assert(Number(target?.amount_cents) === 100 && Number(target?.version) === 1, `${engine} supporting drift mutated the target`, target);

  const staleJob = parseWritebackJob(snapshot.jobs[0]?.payload);
  const retryConfig = applyConfig(engine, "source_db", supportFiles.storePath);
  try {
    const retry = await engines[engine].apply(staleJob, retryConfig);
    assert(retry.status === "conflict" && retry.status !== "already_applied", `${engine} stale conflict became already_applied`, retry);
  } finally {
    await closeApplyConfig(retryConfig);
  }

  const targetFiles = await scenarioFiles(tempDir, engine, "target-after");
  const targetRequest = proposalArgs(engine, "target-after");
  const targetProposalId = await createProposal({ ...targetFiles, ...targetRequest });
  await cliApprove(targetFiles.configPath, targetFiles.storePath, `${engine}_reviewer`);
  await changeTargetVersion(engine, admin, targetId(engine, "target-after"));
  await cliApply(targetProposalId, targetFiles.configPath, targetFiles.storePath);
  snapshot = inspectStore(targetFiles.storePath, targetProposalId);
  target = await queryTarget(engine, admin, targetId(engine, "target-after"));
  assert(snapshot.proposal?.state === "conflict", `${engine} post-approval target drift did not conflict`, snapshot.proposal);
  assert(Number(target?.amount_cents) === 100 && Number(target?.version) === 2, `${engine} target drift was overwritten`, target);
}

async function verifyDelete(engine, admin, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "delete-fresh");
  const request = proposalArgs(engine, "delete-fresh", "delete");
  const proposalId = await createProposal({ ...files, ...request });
  await cliApprove(files.configPath, files.storePath, `${engine}_reviewer`);
  await cliApply(proposalId, files.configPath, files.storePath);
  const row = await queryTarget(engine, admin, targetId(engine, "delete-fresh"));
  assert(row === undefined, `${engine} freshness-guarded DELETE left the row behind`, row);
}

async function verifyRunnerLedger(engine, admin, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "fresh-ledger", "runner_ledger");
  const writeEnv = engines[engine].writeEnv;
  const originalWriteUrl = process.env[writeEnv];
  process.env[writeEnv] = engines[engine].ledgerWriteUrl;
  try {
    const request = proposalArgs(engine, "fresh-ledger");
    const proposalId = await createProposal({ ...files, ...request });
    await cliApprove(files.configPath, files.storePath, `${engine}_reviewer`);
    await cliApply(proposalId, files.configPath, files.storePath);
    const row = await queryTarget(engine, admin, targetId(engine, "fresh-ledger"));
    assert(Number(row?.amount_cents) === 777 && Number(row?.version) === 2, `${engine} runner-ledger update did not apply`, row);
    const snapshot = inspectStore(files.storePath, proposalId);
    const job = parseWritebackJob(snapshot.jobs[0]?.payload);
    const retryConfig = applyConfig(engine, "runner_ledger", files.storePath);
    try {
      const retry = await engines[engine].apply(job, retryConfig);
      assert(retry.status === "already_applied", `${engine} runner-ledger retry was not idempotent`, retry);
    } finally {
      await closeApplyConfig(retryConfig);
    }
  } finally {
    process.env[writeEnv] = originalWriteUrl;
  }
}

async function verifyBoundedSetRollback(engine, admin, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "batch");
  const dependencies = dependencyIds(engine, "batch");
  const proposalId = await createProposal({
    ...files,
    capability: "orders.propose_close_batch",
    args: {
      eligibility_id: dependencies.eligibility,
      policy_id: dependencies.policy,
    },
  });
  await cliApprove(files.configPath, files.storePath, `${engine}_reviewer`);
  await changeDependency(engine, admin, dependencies.eligibility);
  await cliApply(proposalId, files.configPath, files.storePath);
  const rows = await batchRows(engine, admin);
  assert(
    rows.length === 2 && rows.every((row) => row.status === "pending_freshness_batch" && Number(row.version) === 1),
    `${engine} bounded set partially applied after dependency drift`,
    rows,
  );
  const snapshot = inspectStore(files.storePath, proposalId);
  assert(snapshot.receipts[0]?.receipt.safe_error_code === "FRESHNESS_DEPENDENCY_STALE", `${engine} bounded-set freshness conflict was not explicit`, snapshot.receipts);
}

async function verifyQuorum(engine, admin, tempDir) {
  const files = await scenarioFiles(tempDir, engine, "quorum", "source_db", { quorum: true });
  const request = proposalArgs(engine, "quorum");
  const proposalId = await createProposal({ ...files, ...request });
  await cliApprove(files.configPath, files.storePath, `${engine}_reviewer_a`);
  await changeDependency(engine, admin, dependencyIds(engine, "quorum").eligibility);
  await cliApprove(files.configPath, files.storePath, `${engine}_reviewer_b`, 3);
  const snapshot = inspectStore(files.storePath, proposalId);
  assert(snapshot.proposal?.state === "conflict" && snapshot.approvals.length === 1, `${engine} quorum crossed stale evidence`, snapshot);
}

async function verifyCloudApprovedLocalDrift(engine, admin, tempDir) {
  const contractDigest = `sha256:${"c".repeat(64)}`;
  const contractProvenance = { digest: contractDigest, version: "1.6.1-live-fixture" };
  const files = await scenarioFiles(
    tempDir,
    engine,
    "cloud-approved",
    "source_db",
    { contractProvenance },
  );
  const request = proposalArgs(engine, "cloud-approved");
  const proposalId = await createProposal({ ...files, ...request });
  const snapshot = inspectStore(files.storePath, proposalId);
  const proposal = snapshot.proposal;
  assert(proposal?.state === "pending_review", `${engine} Cloud fixture proposal was not pending local review`, proposal);
  assert(proposal.change_set.contract?.digest === contractDigest, `${engine} Cloud fixture lost contract provenance`, proposal.change_set.contract);
  const change = proposal.change_set;
  const job = parseWritebackJob({
    protocol_version: "2.0",
    job_id: `wbj_cloud_${engine}`,
    proposal_id: proposal.proposal_id,
    approval_id: proposal.proposal_hash,
    contract: {
      contract_id: "agct_freshness_live",
      contract_version_id: "agcv_freshness_live",
      digest: contractDigest,
    },
    source_id: "app_db",
    engine,
    operation: "single_row_update",
    target: {
      schema: engines[engine].schema,
      table: "freshness_targets",
      primary_key: change.source.primary_key,
      tenant_guard: change.guards.tenant,
    },
    allowed_columns: change.guards.allowed_columns,
    patch: change.patch,
    conflict_guard: {
      kind: "version_column",
      column: change.guards.expected_version.column,
      expected_value: change.guards.expected_version.value,
    },
    freshness: change.freshness,
    version_advance: change.guards.version_advance,
    idempotency_key: `cloud:${proposal.proposal_id}`,
    lease_expires_at: "2099-07-23T00:00:00.000Z",
    attempt_count: 1,
  });

  await verifyLocalWritebackAuthority(job, files.configPath, files.storePath, {
    cloudApproved: true,
  });
  await changeDependency(engine, admin, dependencyIds(engine, "cloud-approved").policy);
  const writer = applyConfig(engine, "source_db", files.storePath);
  try {
    const result = await engines[engine].apply(job, writer);
    assert(
      result.status === "conflict"
        && result.affected_rows === 0
        && result.error_code === "FRESHNESS_DEPENDENCY_STALE",
      `${engine} Cloud-approved local lease did not fail closed on source drift`,
      result,
    );
  } finally {
    await closeApplyConfig(writer);
  }
  const target = await queryTarget(engine, admin, targetId(engine, "cloud-approved"));
  assert(
    Number(target?.amount_cents) === 100 && Number(target?.version) === 1,
    `${engine} Cloud-approved stale lease mutated the source`,
    target,
  );
}

async function verifySharedRuntimeStore(engine, tempDir) {
  const schema = `freshness_${engine}_runtime`;
  const config = runtimeConfig(engine, "source_db", { policy: true });
  const id = targetId(engine, "shared-runtime");
  const dependencies = dependencyIds(engine, "shared-runtime");
  const pool = new Pool({ connectionString: pgAdminUrl, max: 4 });
  const store = new PostgresProposalRuntimeStore({
    pool,
    schema,
    autoMigrate: true,
    closePool: true,
  });
  const runtime = createMcpRuntime(config, { store, env: process.env });
  let proposalId;
  try {
    const result = await runtime.callTool("orders.propose_adjustment", {
      order_id: id,
      eligibility_id: dependencies.eligibility,
      policy_id: dependencies.policy,
      amount_cents: 500,
    });
    proposalId = String(result.proposal_id);
    assert(result.status === "approved", `${engine} shared runtime-store policy did not pass freshness`, result);
  } finally {
    await runtime.close();
    await store.close();
  }

  const reader = new PostgresProposalRuntimeStore({
    pool: new Pool({ connectionString: pgAdminUrl, max: 2 }),
    schema,
    autoMigrate: false,
    closePool: true,
  });
  try {
    const proposal = await reader.getProposal(proposalId);
    const approvals = await reader.approvals(proposalId);
    const proof = await reader.latestFreshnessProof(proposalId);
    assert(proposal?.state === "approved", `${engine} shared runtime proposal was not durable`, proposal);
    assert(proof?.result === "fresh" && approvals[0]?.freshness_proof_digest === proof.proof_digest, `${engine} shared runtime proof binding was not durable`, { proof, approvals });
  } finally {
    await reader.close();
  }
}

async function verifyEngine(engine, admin, tempDir) {
  console.log(`== ${engine}: live approval and source-db apply ==`);
  await verifyFreshSourceApply(engine, admin, tempDir);
  console.log(`== ${engine}: stale and unavailable pre-approval checks ==`);
  await verifyStaleBeforeApproval(engine, admin, tempDir);
  await verifyUnavailable(engine, tempDir);
  console.log(`== ${engine}: post-approval target/supporting drift ==`);
  await verifyDriftAfterApproval(engine, admin, tempDir);
  console.log(`== ${engine}: DELETE, runner-ledger, and bounded-set atomicity ==`);
  await verifyDelete(engine, admin, tempDir);
  await verifyRunnerLedger(engine, admin, tempDir);
  await verifyBoundedSetRollback(engine, admin, tempDir);
  console.log(`== ${engine}: quorum and shared runtime-store proof chain ==`);
  await verifyQuorum(engine, admin, tempDir);
  await verifySharedRuntimeStore(engine, tempDir);
  console.log(`== ${engine}: Cloud-approved local freshness revalidation ==`);
  await verifyCloudApprovedLocalDrift(engine, admin, tempDir);
}

async function main() {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { inherit: true });
  await waitForDatabases();

  process.env[engines.postgres.readEnv] = engines.postgres.readUrl;
  process.env[engines.postgres.writeEnv] = engines.postgres.sourceWriteUrl;
  process.env[engines.mysql.readEnv] = engines.mysql.readUrl;
  process.env[engines.mysql.writeEnv] = engines.mysql.sourceWriteUrl;
  process.env.SYNAPSOR_TENANT_ID = "acme";
  process.env.SYNAPSOR_PRINCIPAL = "freshness_verifier";
  process.env.SYNAPSOR_OPERATOR = "freshness_verifier";
  process.env.SYNAPSOR_OPERATOR_ROLES = "operations_reviewer";

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-proposal-freshness-"));
  const pgAdmin = new Pool({ connectionString: pgAdminUrl, max: 8 });
  const mysqlAdmin = await mysql.createConnection(mysqlAdminUrl);
  try {
    await setupPostgres(pgAdmin);
    await setupMysql(mysqlAdmin);
    await verifyEngine("postgres", pgAdmin, tempDir);
    await verifyEngine("mysql", mysqlAdmin, tempDir);
    console.log("Proposal/evidence freshness live verification passed: PostgreSQL + MySQL approval preflight, proof binding, source-db and runner-ledger apply, target/supporting drift, DELETE, bounded-set rollback, quorum, shared runtime store, Cloud-approved local revalidation, doctor lock probes, idempotency, and kept-out-value checks.");
  } finally {
    await mysqlAdmin.end().catch(() => undefined);
    await pgAdmin.end().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
    run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  process.exitCode = 1;
});
