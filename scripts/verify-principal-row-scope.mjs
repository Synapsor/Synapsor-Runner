import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.SYNAPSOR_RUNNER_CLI
  ? path.resolve(process.env.SYNAPSOR_RUNNER_CLI)
  : path.join(root, "apps/runner/dist/cli.js");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-principal-scope-"));

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

async function waitFor(service, args, label) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (run("docker", ["compose", "-f", compose, "exec", "-T", service, ...args], { allowFailure: true }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready`);
}

function dsl(engine) {
  const schema = engine === "postgres" ? "public" : "synapsor_fleet";
  return `CREATE AGENT CONTEXT care_session
  BIND hospital_id FROM HTTP_CLAIM hospital_id REQUIRED
  BIND principal FROM HTTP_CLAIM sub REQUIRED
  TENANT BINDING hospital_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY care.inspect_assigned_invoice
  DESCRIPTION 'Inspect one invoice assigned to the authenticated case manager.'
  RETURNS HINT 'Returns reviewed invoice fields only when tenant and principal locks both match.'
  USING CONTEXT care_session
  SOURCE source
  ON ${schema}.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  PRINCIPAL SCOPE KEY assigned_to
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128
  ALLOW READ id, tenant_id, status, late_fee_cents, updated_at
  KEEP OUT assigned_to, waiver_reason
  REQUIRE EVIDENCE
  MAX ROWS 1
END
`;
}

function manifest(engine) {
  const prefix = engine === "postgres" ? "INV" : "MYSQL";
  return {
    version: 1,
    name: `${engine} trusted principal row scope`,
    tests: [
      {
        id: "case-manager-a-cannot-read-b",
        kind: "cross_principal_deny",
        capability: "care.inspect_assigned_invoice",
        args: { invoice_id: `${prefix}-PRINCIPAL-A` },
        trusted_context: { tenant_id: "hospital_a", principal: "case_manager_a", provenance: "http_claims" },
        other_trusted_context: { tenant_id: "hospital_a", principal: "case_manager_b", provenance: "http_claims" },
        expected_code: "NOT_FOUND_IN_TENANT",
      },
      {
        id: "case-manager-b-cannot-read-a",
        kind: "cross_principal_deny",
        capability: "care.inspect_assigned_invoice",
        args: { invoice_id: `${prefix}-PRINCIPAL-B` },
        trusted_context: { tenant_id: "hospital_a", principal: "case_manager_b", provenance: "http_claims" },
        other_trusted_context: { tenant_id: "hospital_a", principal: "case_manager_a", provenance: "http_claims" },
        expected_code: "NOT_FOUND_IN_TENANT",
      },
    ],
  };
}

function verify(engine, url, extension) {
  const directory = path.join(temp, engine, extension.replaceAll(".", "-"));
  fs.mkdirSync(directory, { recursive: true });
  const dslPath = path.join(directory, `principal-scope${extension}`);
  const contractPath = path.join(directory, "synapsor.contract.json");
  const configPath = path.join(directory, "synapsor.runner.json");
  const testsPath = path.join(directory, "synapsor.contract-tests.json");
  fs.writeFileSync(dslPath, dsl(engine));
  run(process.execPath, [cli, "dsl", "compile", dslPath, "--out", contractPath]);
  run(process.execPath, [cli, "contract", "validate", contractPath]);
  fs.writeFileSync(testsPath, `${JSON.stringify(manifest(engine), null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./local.db" },
    contracts: ["./synapsor.contract.json"],
    sources: { source: { engine, read_url_env: "PRINCIPAL_SCOPE_DATABASE_URL", statement_timeout_ms: 3000 } },
    session_auth: {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      issuer: "https://principal-scope.example.invalid",
      audience: "synapsor-principal-scope",
      tenant_claim: "hospital_id",
      principal_claim: "sub",
    },
  }, null, 2)}\n`);
  run(process.execPath, [cli, "config", "validate", "--config", configPath]);
  run(process.execPath, [cli, "tools", "list", "--config", configPath, "--store", path.join(directory, "local.db")]);
  const result = run(process.execPath, [
    cli, "contract", "test",
    "--contract", contractPath,
    "--tests", testsPath,
    "--config", configPath,
    "--live",
    "--format", "json",
  ], { env: { PRINCIPAL_SCOPE_DATABASE_URL: url, SYNAPSOR_SESSION_JWT_SECRET: "synthetic-principal-scope-secret-at-least-32-bytes" } });
  const report = JSON.parse(result.stdout);
  if (!report.ok || report.summary.failed !== 0) throw new Error(`${engine} principal-scope report failed\n${result.stdout}`);
  console.log(`${engine} ${extension} principal-scope conformance passed: ${report.summary.passed}/${report.summary.total}`);
}

run("docker", ["compose", "-f", compose, "up", "-d", "postgres", "mysql"]);
try {
  await waitFor("postgres", ["pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], "fleet Postgres");
  await waitFor("mysql", ["mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], "fleet MySQL");
  for (const extension of [".synapsor", ".synapsor.sql"]) {
    verify("postgres", "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet", extension);
    verify("mysql", "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet", extension);
  }
  console.log("Trusted principal row-scope conformance passed for Postgres and MySQL with generic denial and shared-ledger handle isolation.");
} finally {
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
