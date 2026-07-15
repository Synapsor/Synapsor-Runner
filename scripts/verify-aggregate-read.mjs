import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMcpRuntime, loadRuntimeConfigFromFile } from "../packages/mcp-server/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-aggregate-read-"));

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
}

async function waitFor(service, args) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (run("docker", ["compose", "-f", compose, "exec", "-T", service, ...args], { allowFailure: true }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${service} did not become ready`);
}

function seed() {
  const rows = [
    "('A1','acme','overdue',100)", "('A2','acme','overdue',200)", "('A3','acme','overdue',300)", "('A4','acme','overdue',400)", "('A5','acme','overdue',500)",
    "('P1','acme','paid',1000)", "('P2','acme','paid',2000)", "('P3','acme','paid',3000)",
    "('T1','acme','tiny',777)",
    "('O1','otherco','overdue',7000)", "('O2','otherco','overdue',8000)", "('O3','otherco','overdue',9000)", "('O4','otherco','overdue',10000)", "('O5','otherco','overdue',11000)"
  ].join(",\n");
  const postgres = `
DROP VIEW IF EXISTS public.slow_aggregate_invoices;
DROP TABLE IF EXISTS public.aggregate_invoices;
CREATE TABLE public.aggregate_invoices (id text PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL, balance_cents integer NOT NULL);
INSERT INTO public.aggregate_invoices (id, tenant_id, status, balance_cents) VALUES ${rows};
CREATE VIEW public.slow_aggregate_invoices AS
  SELECT id, tenant_id, status || repeat('', public.synthetic_pool_delay()) AS status, balance_cents FROM public.aggregate_invoices;
GRANT SELECT ON public.aggregate_invoices, public.slow_aggregate_invoices TO synapsor_reader;
`;
  run("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "synapsor_admin", "-d", "synapsor_fleet"], { input: postgres });
  const mysqlRows = rows.replaceAll("'", "'");
  const mysql = `
DROP VIEW IF EXISTS slow_aggregate_invoices;
DROP TABLE IF EXISTS aggregate_invoices;
CREATE TABLE aggregate_invoices (id varchar(32) PRIMARY KEY, tenant_id varchar(64) NOT NULL, status varchar(32) NOT NULL, balance_cents integer NOT NULL);
INSERT INTO aggregate_invoices (id, tenant_id, status, balance_cents) VALUES ${mysqlRows};
CREATE VIEW slow_aggregate_invoices AS
  SELECT id, tenant_id, CONCAT(status, IF(SLEEP(0.10)=0, '', '')) AS status, balance_cents FROM aggregate_invoices;
GRANT SELECT ON synapsor_fleet.aggregate_invoices TO 'synapsor_reader'@'%';
GRANT SELECT ON synapsor_fleet.slow_aggregate_invoices TO 'synapsor_reader'@'%';
FLUSH PRIVILEGES;
`;
  run("docker", ["compose", "-f", compose, "exec", "-T", "mysql", "mysql", "-uroot", "-proot_password", "synapsor_fleet"], { input: mysql });
}

function aggregateCapability(name, functionName, options = {}) {
  return {
    name,
    kind: "aggregate_read",
    description: `Return one reviewed ${functionName} scalar without member rows.`,
    context: "trusted_operator",
    source: "source",
    subject: { resource: options.slow ? "slow_invoices" : "invoices" },
    args: {},
    visible_fields: [],
    kept_out_fields: ["id"],
    evidence: { required: true, query_audit: true },
    aggregate: {
      function: functionName,
      ...(functionName === "count" ? { count_mode: "rows" } : { column: "balance_cents" }),
      selection: { all: [{ column: "status", operator: "eq", value: options.status ?? "overdue" }] },
      minimum_group_size: options.minimum ?? 5,
    },
  };
}

function contract(engine) {
  const schema = engine === "postgres" ? "public" : "synapsor_fleet";
  return {
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: { name: `${engine} aggregate conformance`, version: "1" },
    contexts: [{
      name: "trusted_operator",
      tenant_binding: "tenant_id",
      principal_binding: "principal",
      bindings: [
        { name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true },
        { name: "principal", source: "environment", key: "SYNAPSOR_PRINCIPAL", required: true },
      ],
    }],
    resources: [
      { name: "invoices", engine, type: "table", schema, table: "aggregate_invoices", primary_key: "id", tenant_key: "tenant_id" },
      { name: "slow_invoices", engine, type: "view", schema, table: "slow_aggregate_invoices", primary_key: "id", tenant_key: "tenant_id" },
    ],
    capabilities: [
      aggregateCapability("billing.count_overdue_invoices", "count"),
      aggregateCapability("billing.sum_overdue_balance", "sum"),
      aggregateCapability("billing.average_overdue_balance", "avg"),
      aggregateCapability("billing.sum_tiny_balance", "sum", { status: "tiny", minimum: 2 }),
      aggregateCapability("billing.slow_overdue_balance", "sum", { slow: true }),
    ],
    workflows: [],
    policies: [],
  };
}

function writeConfig(engine, timeout = 3000) {
  const directory = path.join(temp, engine, String(timeout));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "synapsor.contract.json"), `${JSON.stringify(contract(engine), null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "synapsor.runner.json"), `${JSON.stringify({
    version: 1,
    mode: "read_only",
    result_format: 2,
    storage: { sqlite_path: "./ledger.db" },
    contracts: ["./synapsor.contract.json"],
    sources: { source: { engine, read_url_env: "AGGREGATE_DATABASE_URL", statement_timeout_ms: timeout } },
  }, null, 2)}\n`);
  return path.join(directory, "synapsor.runner.json");
}

async function verifyEngine(engine, databaseUrl) {
  const config = loadRuntimeConfigFromFile(writeConfig(engine));
  const env = { AGGREGATE_DATABASE_URL: databaseUrl, SYNAPSOR_TENANT_ID: "acme", SYNAPSOR_PRINCIPAL: "aggregate_verifier" };
  const runtime = createMcpRuntime(config, { env, storePath: path.join(temp, engine, "ledger.db"), resultFormat: 2 });
  try {
    const expected = new Map([
      ["billing.count_overdue_invoices", 5],
      ["billing.sum_overdue_balance", 1500],
      ["billing.average_overdue_balance", 300],
    ]);
    for (const [name, value] of expected) {
      const result = await runtime.callTool(name, {});
      assert(result.ok === true && result.kind === "aggregate_read", `${engine} ${name} failed`, result);
      assert(result.data?.value === value && result.data?.member_rows_included === false, `${engine} ${name} returned the wrong scalar or row boundary`, result);
      const evidence = await runtime.readResource(`synapsor://evidence/${result.evidence.bundle_id}`);
      assert(Array.isArray(evidence.items) && evidence.items.length === 0, `${engine} aggregate evidence included member rows`, evidence);
      const serialized = JSON.stringify({ result, evidence });
      assert(!/\b(?:A1|O1|P1)\b|member_ids|source_rows/i.test(serialized), `${engine} aggregate leaked a member identity`, serialized);
    }
    const suppressed = await runtime.callTool("billing.sum_tiny_balance", {});
    assert(suppressed.ok === true && suppressed.data?.suppressed === true && suppressed.data?.value === null, `${engine} minimum-group suppression failed`, suppressed);
    assert(!JSON.stringify(suppressed).includes("777"), `${engine} suppressed aggregate leaked its scalar`, suppressed);
    const audits = await runtime.store.listQueryAudit({ tenant: "acme", principal: "aggregate_verifier", limit: 100 });
    assert(audits.length === 4, `${engine} did not record aggregate query audit entries`, audits);
    assert(audits.every((audit) => audit.payload?.raw_sql_included === false && audit.payload?.source_member_count_recorded === false), `${engine} query audit exposed raw SQL/member counts`, audits);
  } finally {
    await runtime.close();
  }

  const other = createMcpRuntime(config, {
    env: { AGGREGATE_DATABASE_URL: databaseUrl, SYNAPSOR_TENANT_ID: "otherco", SYNAPSOR_PRINCIPAL: "aggregate_verifier" },
    storePath: path.join(temp, engine, "other-ledger.db"),
    resultFormat: 2,
  });
  try {
    const result = await other.callTool("billing.sum_overdue_balance", {});
    assert(result.ok === true && result.data?.value === 45000, `${engine} trusted tenant scope was not applied independently`, result);
  } finally {
    await other.close();
  }

  const missing = createMcpRuntime(config, { env: { SYNAPSOR_TENANT_ID: "acme", SYNAPSOR_PRINCIPAL: "aggregate_verifier" }, storePath: ":memory:", resultFormat: 2 });
  try {
    const result = await missing.callTool("billing.sum_overdue_balance", {});
    assert(result.ok === false && result.error?.code === "TEMPORARILY_UNAVAILABLE" && result.error?.retryable === true, `${engine} missing dependency was not safely retryable`, result);
  } finally {
    await missing.close();
  }

  const timeoutConfig = loadRuntimeConfigFromFile(writeConfig(engine, 20));
  const timeout = createMcpRuntime(timeoutConfig, { env, storePath: ":memory:", resultFormat: 2 });
  try {
    const result = await timeout.callTool("billing.slow_overdue_balance", {});
    assert(result.ok === false && result.error?.code === "TEMPORARILY_UNAVAILABLE" && result.error?.retryable === true, `${engine} statement timeout was not safely retryable`, result);
  } finally {
    await timeout.close();
  }
  console.log(`${engine} aggregate-read verification passed: trusted tenant + fixed selection + count/sum/avg + suppression + evidence/audit + timeout.`);
}

run("docker", ["compose", "-f", compose, "up", "-d", "postgres", "mysql"]);
try {
  await waitFor("postgres", ["pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"]);
  await waitFor("mysql", ["mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"]);
  seed();
  await verifyEngine("postgres", "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet");
  await verifyEngine("mysql", "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet");
  console.log("Aggregate-read PostgreSQL/MySQL verification passed without member-row leakage.");
} finally {
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
