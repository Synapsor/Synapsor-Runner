import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRunner = createRequire(path.join(root, "apps", "runner", "package.json"));
const sourceExample = path.join(root, "examples", "support-plan-credit");
const outputDirectory = path.join(root, "tmp", "safe-action-team-ci");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-safe-action-team-"));
const projectRoot = path.join(temporaryRoot, "support plan credit");
const cli = process.env.SYNAPSOR_RUNNER_CLI || path.join(root, "apps", "runner", "dist", "cli.js");
const liveDatabase = {
  admin: process.env.SYNAPSOR_SAFE_ACTION_ADMIN_URL?.trim(),
  read: process.env.SYNAPSOR_SAFE_ACTION_READ_URL?.trim(),
  write: process.env.SYNAPSOR_SAFE_ACTION_WRITE_URL?.trim(),
};

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Runner command failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

function liveDatabaseRequested() {
  const configured = Object.values(liveDatabase).filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error("Safe Action live CI requires admin, read, and write database URLs together");
  }
  return configured === 3;
}

function resolveLiveManifest(manifest) {
  return {
    ...manifest,
    name: `${manifest.name || "Safe Action"} disposable PostgreSQL proof`,
    tests: manifest.tests.map((test) => {
      const args = test.args ? { ...test.args } : undefined;
      if (args && Object.prototype.hasOwnProperty.call(args, "customer_id")) {
        args.customer_id = test.id.endsWith("-other-tenant-denied") ? "CUS-9001" : "CUS-3001";
      }
      if (args && Object.prototype.hasOwnProperty.call(args, "credit_cents")) args.credit_cents = 50_000;
      if (args && Object.prototype.hasOwnProperty.call(args, "reason")) args.reason = "Safe Action team CI boundary proof";
      return {
        ...test,
        ...(args ? { args } : {}),
        ...(test.trusted_context ? {
          trusted_context: { tenant_id: "acme", principal: "safe_action_ci", provenance: "static_dev" },
        } : {}),
      };
    }),
  };
}

async function withPostgres(url, callback) {
  const { Client } = requireFromRunner("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function seedLiveDatabase() {
  const sql = fs.readFileSync(path.join(sourceExample, "seed", "001_seed.sql"), "utf8");
  await withPostgres(liveDatabase.admin, (client) => client.query(sql));
}

async function sourceState() {
  return withPostgres(liveDatabase.admin, async (client) => {
    const customer = await client.query(`
      SELECT id, tenant_id, plan_credit_cents, credit_reason, updated_at::text
      FROM public.customers
      WHERE id IN ('CUS-3001', 'CUS-9001')
      ORDER BY id
    `);
    const receipts = await client.query("SELECT count(*)::int AS count FROM public.synapsor_writeback_receipts");
    return { customers: customer.rows, receipt_count: receipts.rows[0]?.count ?? -1 };
  });
}

try {
  fs.cpSync(sourceExample, projectRoot, { recursive: true });
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  const contractPath = path.join(projectRoot, "synapsor.contract.json");
  const actionPath = "./synapsor/actions/support.propose_plan_credit.ts";
  const expectedTestsPath = path.join(sourceExample, "synapsor", "actions", "support.propose_plan_credit.contract-tests.generated.json");
  const before = {
    config: digest(configPath),
    contract: digest(contractPath),
    action: digest(path.join(projectRoot, actionPath)),
  };

  const validation = JSON.parse(run([
    "action", "validate", actionPath,
    "--project-root", projectRoot,
    "--json",
  ]).stdout);
  requireCondition(validation.ok === true && validation.state === "disabled_draft", "Safe Action did not remain a valid disabled draft");
  requireCondition(validation.active_tools_changed === false, "Safe Action validation changed active tools");
  requireCondition(validation.source_database_changed === false, "Safe Action validation changed source data");
  requireCondition(validation.blocking_lint_issues === 0, "Safe Action validation introduced a blocking lint issue");
  requireCondition(validation.static_test_summary?.failed === 0 && validation.static_test_summary?.passed >= 10, "generated static tests did not pass");
  requireCondition(Array.isArray(validation.live_tests_pending) && validation.live_tests_pending.length === 3, "expected three explicit staging-only tests");
  requireCondition(Array.isArray(validation.unresolved_authority) && validation.unresolved_authority.length === 0, "Safe Action retains unresolved authority");

  const generatedTestsPath = path.join(projectRoot, validation.generated_tests);
  requireCondition(fs.readFileSync(generatedTestsPath, "utf8") === fs.readFileSync(expectedTestsPath, "utf8"), "checked-in generated boundary tests drifted");
  requireCondition(digest(configPath) === before.config, "validation modified synapsor.runner.json");
  requireCondition(digest(contractPath) === before.contract, "validation modified the active canonical contract");
  requireCondition(digest(path.join(projectRoot, actionPath)) === before.action, "validation modified the authored action");
  requireCondition(!fs.existsSync(path.join(projectRoot, ".synapsor", "active.json")), "validation created active state");

  const draftDirectory = path.dirname(path.join(projectRoot, validation.draft_contract));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const reports = {
    text: path.join(outputDirectory, "contract-tests.txt"),
    json: path.join(outputDirectory, "contract-tests.json"),
    junit: path.join(outputDirectory, "contract-tests.xml"),
    validation: path.join(outputDirectory, "action-validation.json"),
    live_text: path.join(outputDirectory, "contract-tests.live.txt"),
    live_json: path.join(outputDirectory, "contract-tests.live.json"),
    live_junit: path.join(outputDirectory, "contract-tests.live.xml"),
  };
  fs.writeFileSync(reports.validation, `${JSON.stringify(validation, null, 2)}\n`);
  for (const format of ["text", "json", "junit"]) {
    run([
      "contract", "test",
      "--contract", path.join(projectRoot, validation.draft_contract),
      "--tests", path.join(draftDirectory, "static.contract-tests.json"),
      "--config", path.join(draftDirectory, "validation.runner.json"),
      "--format", format,
      "--out", reports[format],
    ]);
  }
  requireCondition(fs.readFileSync(reports.text, "utf8").includes("0 failed"), "text report did not prove a passing static suite");
  const jsonReport = JSON.parse(fs.readFileSync(reports.json, "utf8"));
  requireCondition(jsonReport.ok === true && jsonReport.summary?.failed === 0, "JSON report did not prove a passing static suite");
  const junit = fs.readFileSync(reports.junit, "utf8");
  requireCondition(/failures="0"/.test(junit) && /tests="10"/.test(junit), "JUnit report did not prove ten passing static tests");

  let liveTests = {
    executed: false,
    pending: validation.live_tests_pending,
  };
  if (liveDatabaseRequested()) {
    await seedLiveDatabase();
    const sourceBefore = await sourceState();
    const liveManifestPath = path.join(projectRoot, ".synapsor", "live.contract-tests.json");
    const liveManifest = resolveLiveManifest(JSON.parse(fs.readFileSync(generatedTestsPath, "utf8")));
    fs.writeFileSync(liveManifestPath, `${JSON.stringify(liveManifest, null, 2)}\n`, { mode: 0o600 });
    const liveEnv = {
      PLAN_CREDIT_POSTGRES_READ_URL: liveDatabase.read,
      PLAN_CREDIT_POSTGRES_WRITE_URL: liveDatabase.write,
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "safe_action_ci",
    };
    for (const [format, output] of [["text", reports.live_text], ["json", reports.live_json], ["junit", reports.live_junit]]) {
      run([
        "contract", "test",
        "--contract", path.join(projectRoot, validation.draft_contract),
        "--tests", liveManifestPath,
        "--config", path.join(draftDirectory, "validation.runner.json"),
        "--live",
        "--format", format,
        "--out", output,
      ], { env: liveEnv });
    }
    const liveReport = JSON.parse(fs.readFileSync(reports.live_json, "utf8"));
    requireCondition(liveReport.ok === true && liveReport.mode === "live" && liveReport.engine === "postgres", "live report did not prove the disposable PostgreSQL path");
    requireCondition(liveReport.summary?.failed === 0 && liveReport.summary?.passed === 13, "live report did not pass all generated boundary tests");
    requireCondition(/failures="0"/.test(fs.readFileSync(reports.live_junit, "utf8")) && /tests="13"/.test(fs.readFileSync(reports.live_junit, "utf8")), "live JUnit report did not prove thirteen passing tests");
    const sourceAfter = await sourceState();
    requireCondition(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "live contract tests changed source rows or source receipt state");
    liveTests = {
      executed: true,
      engine: "postgres",
      ...liveReport.summary,
      source_database_changed: false,
      approvals_performed: false,
    };
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: validation.action_name,
    state: validation.state,
    draft_digest: validation.draft_digest,
    active_tools_changed: validation.active_tools_changed,
    source_database_changed: validation.source_database_changed,
    static_tests: validation.static_test_summary,
    live_tests_pending: validation.live_tests_pending,
    live_tests: liveTests,
    reports: Object.fromEntries(Object.entries(reports)
      .filter(([key]) => liveTests.executed || !key.startsWith("live_"))
      .map(([key, value]) => [key, path.relative(root, value)])),
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
