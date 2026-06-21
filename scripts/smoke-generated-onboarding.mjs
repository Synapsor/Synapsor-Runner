import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localDbHost = process.env.SYNAPSOR_LOCAL_DB_HOST || "localhost";
const tmpRoot = path.join(root, "tmp", "generated-onboarding");

const postgresUrl = (port, database, user, password) =>
  `postgresql://${user}:${password}@${localDbHost}:${port}/${database}`;
const mysqlUrl = (port, database, user, password) =>
  `mysql://${user}:${password}@${localDbHost}:${port}/${database}`;

const scenarios = [
  {
    key: "generated-postgres-billing",
    label: "generated Postgres billing onboarding",
    engine: "postgres",
    exampleDir: path.join(root, "examples", "mcp-postgres-billing"),
    container: "synapsor_runner_mcp_postgres_billing",
    dbName: "synapsor_runner_mcp_billing",
    schema: "public",
    table: "invoices",
    primaryKey: "id",
    tenantKey: "tenant_id",
    conflictColumn: "updated_at",
    namespace: "billing",
    objectName: "invoice",
    readUrl: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_reader", "synapsor_reader_password"),
    writeUrl: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_writer", "synapsor_writer_password"),
    visibleColumns: "id,tenant_id,customer_name,status,late_fee_cents,waiver_reason,updated_at",
    allowedColumns: "late_fee_cents,waiver_reason",
    patchFlags: ["--patch-fixed", "late_fee_cents=0", "--patch-from-arg", "waiver_reason=reason", "--numeric-bound", "late_fee_cents=0:5500"],
    expectedNumericBounds: { late_fee_cents: { minimum: 0, maximum: 5500 } },
    inspectTool: "billing.inspect_invoice",
    proposalTool: "billing.propose_invoice_update",
    inspectArgs: { invoice_id: "INV-3001" },
    proposalArgs: { invoice_id: "INV-3001", reason: "generated onboarding waiver" },
    staleProposalArgs: { invoice_id: "INV-3001", reason: "generated stale conflict" },
    diffColumn: "late_fee_cents",
    expectedBefore: 5500,
    expectedProposed: 0,
    unchangedSql: "SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'",
    expectedUnchanged: "5500|",
    resetSql: "UPDATE public.invoices SET late_fee_cents = 5500, waiver_reason = NULL, updated_at = '2026-06-20T14:31:08Z' WHERE id = 'INV-3001'; DELETE FROM public.synapsor_writeback_receipts;",
    staleMutateSql: "UPDATE public.invoices SET updated_at = '2026-06-20T15:00:00Z' WHERE id = 'INV-3001';",
    finalSql: "SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'",
    expectedFinal: "5500|",
  },
  {
    key: "generated-mysql-orders",
    label: "generated MySQL orders onboarding",
    engine: "mysql",
    exampleDir: path.join(root, "examples", "mcp-mysql-orders"),
    container: "synapsor_runner_mcp_mysql_orders",
    dbName: "synapsor_runner_mcp_orders",
    table: "orders",
    primaryKey: "id",
    tenantKey: "tenant_id",
    conflictColumn: "updated_at",
    namespace: "orders",
    objectName: "order",
    readUrl: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_reader", "synapsor_reader_password"),
    writeUrl: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_writer", "synapsor_writer_password"),
    visibleColumns: "id,tenant_id,customer_name,status,refund_review_status,refund_note,updated_at",
    allowedColumns: "refund_review_status,refund_note",
    patchFlags: ["--patch-fixed", "refund_review_status=review_required", "--patch-from-arg", "refund_note=refund_note", "--transition-guard", "refund_review_status=none:review_required"],
    expectedTransitionGuards: { refund_review_status: { allowed: { none: ["review_required"] } } },
    inspectTool: "orders.inspect_order",
    proposalTool: "orders.propose_order_update",
    inspectArgs: { order_id: "O-1001" },
    proposalArgs: { order_id: "O-1001", refund_note: "generated onboarding refund review" },
    staleProposalArgs: { order_id: "O-1001", refund_note: "generated stale conflict" },
    diffColumn: "refund_review_status",
    expectedBefore: "none",
    expectedProposed: "review_required",
    unchangedSql: "SELECT CONCAT(refund_review_status, '|', COALESCE(refund_note, '')) FROM orders WHERE id = 'O-1001'",
    expectedUnchanged: "none|",
    resetSql: "UPDATE orders SET refund_review_status = 'none', refund_note = NULL, updated_at = '2026-06-20 12:00:00' WHERE id = 'O-1001'; DELETE FROM synapsor_writeback_receipts;",
    staleMutateSql: "UPDATE orders SET updated_at = '2026-06-20 15:00:00' WHERE id = 'O-1001';",
    finalSql: "SELECT CONCAT(refund_review_status, '|', COALESCE(refund_note, '')) FROM orders WHERE id = 'O-1001'",
    expectedFinal: "none|",
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}

function runner(scenario, args, options = {}) {
  return run(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "apps", "runner", "src", "cli.ts"), ...args], {
    cwd: options.cwd || root,
    capture: true,
    allowFailure: options.allowFailure,
    env: scenarioEnv(scenario),
  });
}

function scenarioEnv(scenario) {
  return {
    SYNAPSOR_DATABASE_READ_URL: scenario.readUrl,
    SYNAPSOR_DATABASE_WRITE_URL: scenario.writeUrl,
    SYNAPSOR_DATABASE_URL: scenario.writeUrl,
    SYNAPSOR_ENGINE: scenario.engine,
    SYNAPSOR_TENANT_ID: "acme",
    SYNAPSOR_PRINCIPAL: `${scenario.key}_principal`,
    SYNAPSOR_RUNNER_ID: `${scenario.key}_runner`,
    SYNAPSOR_SOURCE_ID: scenario.engine === "postgres" ? "local_postgres" : "local_mysql",
    SYNAPSOR_CONTROL_PLANE_URL: "http://127.0.0.1:0",
    SYNAPSOR_RUNNER_TOKEN: "syn_wbr_generated_onboarding",
  };
}

function parseCliJson(result) {
  const json = result.stdout.match(/\{[\s\S]*\}\s*$/)?.[0];
  if (!json) throw new Error(`Expected JSON output, got:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(json);
}

function dockerSql(scenario, sql) {
  if (scenario.engine === "postgres") {
    return run(
      "docker",
      ["exec", scenario.container, "psql", "-U", "synapsor_admin", "-d", scenario.dbName, "-tAc", sql],
      { capture: true },
    ).stdout.trim();
  }
  return run(
    "docker",
    ["exec", scenario.container, "mysql", "-uroot", "-proot_password", "-N", "-B", "-D", scenario.dbName, "-e", sql],
    { capture: true },
  ).stdout.trim();
}

async function waitForDatabase(scenario) {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = scenario.engine === "postgres"
      ? run("docker", ["exec", scenario.container, "pg_isready", "-U", "synapsor_admin", "-d", scenario.dbName], { capture: true, allowFailure: true })
      : run("docker", ["exec", scenario.container, "mysql", "-usynapsor_reader", "-psynapsor_reader_password", "-N", "-B", "-D", scenario.dbName, "-e", "SELECT COUNT(*) FROM orders;"], { capture: true, allowFailure: true });
    if (result.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${scenario.label} database did not become ready: ${last}`);
}

async function withMcpClient(scenario, paths, callback) {
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: [
      "apps/runner/src/cli.ts",
      "mcp",
      "serve",
      "--config",
      paths.config,
      "--store",
      paths.store,
    ],
    cwd: root,
    env: scenarioEnv(scenario),
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "synapsor-runner-generated-onboarding-smoke", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await callback(client);
  } catch (error) {
    if (error instanceof Error && serverStderr.trim()) {
      error.message += `\nMCP server stderr:\n${serverStderr.trim()}`;
    }
    throw error;
  } finally {
    await client.close();
  }
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Missing structured MCP result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function assertNoSecrets(paths, scenario) {
  const needles = [
    scenario.readUrl,
    scenario.writeUrl,
    "synapsor_reader_password",
    "synapsor_writer_password",
    "root_password",
  ];
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const needle of needles) {
      assert(!text.includes(needle), `Secret value leaked into ${file}`);
    }
  }
}

async function exerciseGeneratedOnboarding(scenario) {
  const started = Date.now();
  const workDir = path.join(tmpRoot, scenario.key);
  const paths = {
    workDir,
    inspection: path.join(workDir, "schema-inspection.json"),
    config: path.join(workDir, "synapsor.runner.json"),
    store: path.join(workDir, ".synapsor", "local.db"),
    firstJob: path.join(workDir, "first-job.json"),
    staleJob: path.join(workDir, "stale-job.json"),
    appliedReplay: path.join(workDir, "applied-replay.json"),
    conflictReplay: path.join(workDir, "conflict-replay.json"),
  };
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  run("docker", ["compose", "down", "-v"], { cwd: scenario.exampleDir, allowFailure: true });
  run("docker", ["compose", "up", "-d"], { cwd: scenario.exampleDir });
  try {
    await waitForDatabase(scenario);

    console.log(`\n== ${scenario.label}: inspect schema ==`);
    const inspectArgs = ["inspect", "--database-url-env", "SYNAPSOR_DATABASE_READ_URL", "--engine", scenario.engine, "--json"];
    if (scenario.schema) inspectArgs.push("--schema", scenario.schema);
    const inspection = runner(scenario, inspectArgs);
    fs.writeFileSync(paths.inspection, `${JSON.stringify(parseCliJson(inspection), null, 2)}\n`);
    assertNoSecrets([paths.inspection], scenario);

    console.log(`== ${scenario.label}: generate config from inspection ==`);
    runner(scenario, [
      "init",
      "--inspection-json",
      paths.inspection,
      "--database-url-env",
      "SYNAPSOR_DATABASE_READ_URL",
      "--write-url-env",
      "SYNAPSOR_DATABASE_WRITE_URL",
      ...(scenario.schema ? ["--schema", scenario.schema] : []),
      "--table",
      scenario.table,
      "--primary-key",
      scenario.primaryKey,
      "--tenant-key",
      scenario.tenantKey,
      "--conflict-column",
      scenario.conflictColumn,
      "--namespace",
      scenario.namespace,
      "--object-name",
      scenario.objectName,
      "--mode",
      "review",
      "--visible-columns",
      scenario.visibleColumns,
      "--allowed-columns",
      scenario.allowedColumns,
      "--approval-role",
      "local_reviewer",
      "--output",
      paths.config,
      ...scenario.patchFlags,
    ], { cwd: workDir });

    assertNoSecrets([
      paths.config,
      path.join(workDir, ".env.example"),
      path.join(workDir, ".synapsor", "mcp", "generic-stdio.json"),
      path.join(workDir, ".synapsor", "mcp", "claude-desktop.json"),
      path.join(workDir, ".synapsor", "mcp", "cursor.json"),
      path.join(workDir, ".synapsor", "mcp", "vscode.json"),
    ], scenario);
    const generatedConfig = JSON.parse(fs.readFileSync(paths.config, "utf8"));
    const generatedProposal = generatedConfig.capabilities.find((capability) => capability.kind === "proposal");
    assert(Boolean(generatedProposal), "Generated proposal capability missing", generatedConfig);
    if (scenario.expectedNumericBounds) {
      assert(
        JSON.stringify(generatedProposal.numeric_bounds) === JSON.stringify(scenario.expectedNumericBounds),
        "Generated numeric bounds missing",
        generatedProposal,
      );
    }
    if (scenario.expectedTransitionGuards) {
      assert(
        JSON.stringify(generatedProposal.transition_guards) === JSON.stringify(scenario.expectedTransitionGuards),
        "Generated transition guards missing",
        generatedProposal,
      );
    }

    console.log(`== ${scenario.label}: validate and doctor generated config ==`);
    runner(scenario, ["config", "validate", "--config", paths.config]);
    const doctor = parseCliJson(runner(scenario, ["doctor", "--config", paths.config, "--json"]));
    assert(doctor.ok === true, "Generated config doctor failed", doctor);
    assert(doctor.tools.includes(scenario.inspectTool), "Generated inspect tool missing from doctor", doctor);
    assert(doctor.tools.includes(scenario.proposalTool), "Generated proposal tool missing from doctor", doctor);

    console.log(`== ${scenario.label}: generated MCP tools/list and tool calls ==`);
    let firstProposalId = "";
    await withMcpClient(scenario, paths, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert(names.includes(scenario.inspectTool), `${scenario.inspectTool} missing`, names);
      assert(names.includes(scenario.proposalTool), `${scenario.proposalTool} missing`, names);
      assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "Unsafe model-facing tool exposed", names);

      const inspected = structured(await client.callTool({ name: scenario.inspectTool, arguments: scenario.inspectArgs }));
      assert(inspected.status === "ok", "Inspect tool failed", inspected);
      assert(inspected.source_database_mutated === false, "Inspect mutated source", inspected);
      assert(inspected.trusted_context?.tenant_id === "acme", "Trusted tenant context missing", inspected);

      const proposed = structured(await client.callTool({ name: scenario.proposalTool, arguments: scenario.proposalArgs }));
      assert(proposed.status === "review_required", "Proposal did not require review", proposed);
      assert(proposed.diff?.[scenario.diffColumn]?.before === scenario.expectedBefore, "Proposal diff before value wrong", proposed);
      assert(proposed.diff?.[scenario.diffColumn]?.proposed === scenario.expectedProposed, "Proposal diff proposed value wrong", proposed);
      assert(proposed.source_database_mutated === false, "Proposal mutated source", proposed);
      firstProposalId = String(proposed.proposal_id);
    });

    const unchanged = dockerSql(scenario, scenario.unchangedSql);
    assert(unchanged === scenario.expectedUnchanged, "Source database changed before approval", unchanged);

    console.log(`== ${scenario.label}: local approval -> guarded apply with generated config ==`);
    runner(scenario, ["proposals", "approve", firstProposalId, "--store", paths.store, "--actor", "local_reviewer", "--yes"]);
    runner(scenario, ["proposals", "writeback-job", firstProposalId, "--store", paths.store, "--output", paths.firstJob, "--project", "local", "--runner", "local_runner"]);
    const applied = parseCliJson(runner(scenario, ["apply", "--job", paths.firstJob, "--config", paths.config, "--store", paths.store]));
    assert(applied.status === "applied" && applied.affected_rows === 1, "Expected guarded apply", applied);
    const retry = parseCliJson(runner(scenario, ["apply", "--job", paths.firstJob, "--config", paths.config, "--store", paths.store]));
    assert(retry.status === "applied" && retry.affected_rows === 0, "Expected idempotent retry", retry);
    runner(scenario, ["replay", "export", firstProposalId, "--store", paths.store, "--output", paths.appliedReplay]);
    assertNoSecrets([paths.appliedReplay], scenario);

    console.log(`== ${scenario.label}: stale-row conflict with generated config ==`);
    dockerSql(scenario, scenario.resetSql);
    let staleProposalId = "";
    await withMcpClient(scenario, paths, async (client) => {
      const proposed = structured(await client.callTool({ name: scenario.proposalTool, arguments: scenario.staleProposalArgs }));
      staleProposalId = String(proposed.proposal_id);
      assert(proposed.status === "review_required", "Stale proposal was not created", proposed);
    });
    dockerSql(scenario, scenario.staleMutateSql);
    runner(scenario, ["proposals", "approve", staleProposalId, "--store", paths.store, "--actor", "local_reviewer", "--yes"]);
    runner(scenario, ["proposals", "writeback-job", staleProposalId, "--store", paths.store, "--output", paths.staleJob, "--project", "local", "--runner", "local_runner"]);
    const conflict = parseCliJson(runner(scenario, ["apply", "--job", paths.staleJob, "--config", paths.config, "--store", paths.store]));
    assert(conflict.status === "conflict" && conflict.error_code === "VERSION_CONFLICT", "Expected stale-row conflict", conflict);
    const finalRow = dockerSql(scenario, scenario.finalSql);
    assert(finalRow === scenario.expectedFinal, "Conflict path should not apply write", finalRow);
    runner(scenario, ["replay", "export", staleProposalId, "--store", paths.store, "--output", paths.conflictReplay]);
    const conflictReplay = JSON.parse(fs.readFileSync(paths.conflictReplay, "utf8"));
    assert(conflictReplay.proposal?.state === "conflict", "Replay proposal state should be conflict", conflictReplay);
    assert(
      conflictReplay.receipts?.some((receipt) => receipt.receipt?.status === "conflict" && receipt.receipt?.safe_error_code === "VERSION_CONFLICT"),
      "Replay should include stale-row conflict receipt",
      conflictReplay,
    );
    assertNoSecrets([paths.conflictReplay], scenario);
  } finally {
    run("docker", ["compose", "down", "-v"], { cwd: scenario.exampleDir, allowFailure: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`== ${scenario.label}: completed in ${elapsedSeconds(started)}s ==`);
}

function elapsedSeconds(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

const suiteStarted = Date.now();
fs.rmSync(tmpRoot, { recursive: true, force: true });
for (const scenario of scenarios) {
  await exerciseGeneratedOnboarding(scenario);
}

console.log(`\nGenerated own-database onboarding smoke passed for Postgres and MySQL in ${elapsedSeconds(suiteStarted)}s.`);
