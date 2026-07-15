import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "apps/runner/dist/cli.js");
const supportCompose = path.join(root, "examples/support-plan-credit/docker-compose.yml");
const fleetCompose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-contract-conformance-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function waitFor(compose, service, args, label) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (run("docker", ["compose", "-f", compose, "exec", "-T", service, ...args], { allowFailure: true }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready`);
}

function contractTest(args, env) {
  const result = run(process.execPath, [cli, "contract", "test", ...args, "--format", "json"], { env });
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok || parsed.summary.failed !== 0) throw new Error(`contract tests failed\n${result.stdout}`);
  return parsed;
}

async function verifyPostgres() {
  run("docker", ["compose", "-f", supportCompose, "up", "-d"]);
  try {
    await waitFor(supportCompose, "postgres", ["pg_isready", "-U", "synapsor_admin", "-d", "synapsor_runner_plan_credit"], "support-plan-credit Postgres");
    const env = {
      PLAN_CREDIT_POSTGRES_READ_URL: "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55438/synapsor_runner_plan_credit",
      PLAN_CREDIT_POSTGRES_WRITE_URL: "postgresql://synapsor_writer:synapsor_writer_password@127.0.0.1:55438/synapsor_runner_plan_credit",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "contract_test",
    };
    const report = contractTest([
      "--contract", path.join(root, "examples/support-plan-credit/synapsor.contract.json"),
      "--tests", path.join(root, "examples/support-plan-credit/synapsor.contract-tests.json"),
      "--config", path.join(root, "examples/support-plan-credit/synapsor.runner.json"),
      "--live",
    ], env);
    const source = run("docker", ["compose", "-f", supportCompose, "exec", "-T", "postgres", "psql", "-U", "synapsor_admin", "-d", "synapsor_runner_plan_credit", "-Atc", "SELECT plan_credit_cents FROM public.customers WHERE id = 'CUS-3001'" ]).stdout.trim();
    if (source !== "0") throw new Error(`proposal conformance test changed source row: ${source}`);
    console.log(`PostgreSQL contract conformance passed: ${report.summary.passed}/${report.summary.total}`);
  } finally {
    run("docker", ["compose", "-f", supportCompose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}

function mysqlContract() {
  return {
    spec_version: "0.1",
    kind: "SynapsorContract",
    contexts: [{
      name: "trusted_operator",
      tenant_binding: "tenant_id",
      principal_binding: "principal",
      bindings: [
        { name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true },
        { name: "principal", source: "environment", key: "SYNAPSOR_PRINCIPAL", required: true },
      ],
    }],
    resources: [],
    capabilities: [{
      name: "billing.inspect_invoice",
      kind: "read",
      description: "Inspect one reviewed invoice in the trusted tenant.",
      context: "trusted_operator",
      source: "mysql",
      subject: { schema: "synapsor_fleet", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
      args: { invoice_id: { type: "string", required: true, max_length: 128 } },
      lookup: { id_from_arg: "invoice_id" },
      visible_fields: ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
      kept_out_fields: ["waiver_reason"],
      evidence: { required: true, query_audit: true },
      max_rows: 1,
    }],
    workflows: [],
    policies: [],
  };
}

async function verifyMysql() {
  run("docker", ["compose", "-f", fleetCompose, "up", "-d", "mysql"]);
  try {
    await waitFor(fleetCompose, "mysql", ["mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], "fleet MySQL");
    run("docker", ["compose", "-f", fleetCompose, "exec", "-T", "mysql", "mysql", "-uroot", "-proot_password", "synapsor_fleet", "-e", "INSERT INTO invoices (id, tenant_id, status, late_fee_cents, waiver_reason, updated_at) VALUES ('MYSQL-OTHER', 'otherco', 'overdue', 9900, 'hidden', '2026-07-12 12:00:00.000000') ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id)"]);
    const directory = path.join(temp, "mysql");
    fs.mkdirSync(directory, { recursive: true });
    const contractPath = path.join(directory, "synapsor.contract.json");
    const configPath = path.join(directory, "synapsor.runner.json");
    const testsPath = path.join(directory, "synapsor.contract-tests.json");
    fs.writeFileSync(contractPath, `${JSON.stringify(mysqlContract(), null, 2)}\n`);
    fs.writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./local.db" },
      contracts: ["./synapsor.contract.json"],
      sources: { mysql: { engine: "mysql", read_url_env: "MYSQL_TEST_URL", statement_timeout_ms: 3000 } },
    }, null, 2)}\n`);
    fs.writeFileSync(testsPath, `${JSON.stringify({ version: 1, tests: [
      { id: "operator-boundary", kind: "operator_boundary", capability: "billing.inspect_invoice" },
      { id: "allow-own", kind: "tool_allow", capability: "billing.inspect_invoice", args: { invoice_id: "MYSQL-ACME" }, trusted_context: { tenant_id: "acme", principal: "contract_test" } },
      { id: "deny-other", kind: "tool_deny", capability: "billing.inspect_invoice", args: { invoice_id: "MYSQL-OTHER" }, trusted_context: { tenant_id: "acme", principal: "contract_test" }, expected_code: "NOT_FOUND_IN_TENANT" },
      { id: "hide-waiver", kind: "hide_fields", capability: "billing.inspect_invoice", args: { invoice_id: "MYSQL-ACME" }, trusted_context: { tenant_id: "acme", principal: "contract_test" }, fields: ["waiver_reason"] },
    ] }, null, 2)}\n`);
    const report = contractTest(["--contract", contractPath, "--tests", testsPath, "--config", configPath, "--live"], {
      MYSQL_TEST_URL: "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "contract_test",
    });
    console.log(`MySQL contract conformance passed: ${report.summary.passed}/${report.summary.total}`);
  } finally {
    run("docker", ["compose", "-f", fleetCompose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}

try {
  await verifyPostgres();
  await verifyMysql();
  console.log("Adopter contract conformance verification passed with trusted-context tenant isolation on PostgreSQL and MySQL.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
