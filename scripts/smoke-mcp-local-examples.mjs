import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localDbHost = process.env.SYNAPSOR_LOCAL_DB_HOST || "localhost";
const postgresUrl = (port, database, user, password) =>
  `postgresql://${user}:${password}@${localDbHost}:${port}/${database}`;
const mysqlUrl = (port, database, user, password) =>
  `mysql://${user}:${password}@${localDbHost}:${port}/${database}`;

const scenarios = [
  {
    key: "mcp-postgres-billing",
    label: "Postgres billing",
    engine: "postgres",
    exampleDir: path.join(root, "examples", "mcp-postgres-billing"),
    configPath: path.join(root, "examples", "mcp-postgres-billing", "synapsor.runner.json"),
    tmpDir: path.join(root, "tmp", "mcp-postgres-billing"),
    storePath: path.join(root, "tmp", "mcp-postgres-billing", "local.db"),
    container: "synapsor_runner_mcp_postgres_billing",
    dbName: "synapsor_runner_mcp_billing",
    readUrl: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_reader", "synapsor_reader_password"),
    writeUrl: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_writer", "synapsor_writer_password"),
    env: {
      BILLING_POSTGRES_READ_URL: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_reader", "synapsor_reader_password"),
      BILLING_POSTGRES_WRITE_URL: postgresUrl(55433, "synapsor_runner_mcp_billing", "synapsor_writer", "synapsor_writer_password"),
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_billing_agent",
    },
    inspectTool: "billing.inspect_invoice",
    proposalTool: "billing.propose_late_fee_waiver",
    inspectArgs: { invoice_id: "INV-3001" },
    spoofArgs: { invoice_id: "INV-9001", tenant_id: "otherco" },
    proposalArgs: { invoice_id: "INV-3001", reason: "approved support waiver" },
    staleProposalArgs: { invoice_id: "INV-3001", reason: "stale-row test waiver" },
    diffColumn: "late_fee_cents",
    expectedBefore: 5500,
    expectedProposed: 0,
    unchangedSql: "SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'",
    expectedUnchanged: "5500|",
    resetSql: "UPDATE public.invoices SET late_fee_cents = 5500, waiver_reason = NULL, updated_at = '2026-06-20T14:31:08Z' WHERE id = 'INV-3001'; DELETE FROM public.synapsor_writeback_receipts;",
    staleMutateSql: "UPDATE public.invoices SET updated_at = '2026-06-20T15:00:00Z' WHERE id = 'INV-3001';",
    finalSql: "SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'",
    expectedFinal: "5500|",
    disallowedColumn: "internal_notes",
  },
  {
    key: "mcp-postgres-support",
    label: "Postgres support",
    engine: "postgres",
    exampleDir: path.join(root, "examples", "mcp-postgres-support"),
    configPath: path.join(root, "examples", "mcp-postgres-support", "synapsor.runner.json"),
    tmpDir: path.join(root, "tmp", "mcp-postgres-support"),
    storePath: path.join(root, "tmp", "mcp-postgres-support", "local.db"),
    container: "synapsor_runner_mcp_postgres_support",
    dbName: "synapsor_runner_mcp_support",
    readUrl: postgresUrl(55434, "synapsor_runner_mcp_support", "synapsor_reader", "synapsor_reader_password"),
    writeUrl: postgresUrl(55434, "synapsor_runner_mcp_support", "synapsor_writer", "synapsor_writer_password"),
    env: {
      SUPPORT_POSTGRES_READ_URL: postgresUrl(55434, "synapsor_runner_mcp_support", "synapsor_reader", "synapsor_reader_password"),
      SUPPORT_POSTGRES_WRITE_URL: postgresUrl(55434, "synapsor_runner_mcp_support", "synapsor_writer", "synapsor_writer_password"),
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_support_agent",
    },
    inspectTool: "support.inspect_ticket",
    proposalTool: "support.propose_ticket_resolution",
    inspectArgs: { ticket_id: "T-1042" },
    spoofArgs: { ticket_id: "T-9001", tenant_id: "otherco" },
    proposalArgs: { ticket_id: "T-1042", resolution_note: "Late-fee waiver requires billing approval" },
    staleProposalArgs: { ticket_id: "T-1042", resolution_note: "stale-row test resolution" },
    diffColumn: "status",
    expectedBefore: "open",
    expectedProposed: "pending_review",
    unchangedSql: "SELECT status || '|' || COALESCE(resolution_note, '') FROM public.tickets WHERE id = 'T-1042'",
    expectedUnchanged: "open|",
    resetSql: "UPDATE public.tickets SET status = 'open', resolution_note = NULL, updated_at = '2026-06-20T12:00:00Z' WHERE id = 'T-1042'; DELETE FROM public.synapsor_writeback_receipts;",
    staleMutateSql: "UPDATE public.tickets SET updated_at = '2026-06-20T15:00:00Z' WHERE id = 'T-1042';",
    finalSql: "SELECT status || '|' || COALESCE(resolution_note, '') FROM public.tickets WHERE id = 'T-1042'",
    expectedFinal: "open|",
    disallowedColumn: "internal_notes",
  },
  {
    key: "mcp-mysql-orders",
    label: "MySQL orders",
    engine: "mysql",
    exampleDir: path.join(root, "examples", "mcp-mysql-orders"),
    configPath: path.join(root, "examples", "mcp-mysql-orders", "synapsor.runner.json"),
    tmpDir: path.join(root, "tmp", "mcp-mysql-orders"),
    storePath: path.join(root, "tmp", "mcp-mysql-orders", "local.db"),
    container: "synapsor_runner_mcp_mysql_orders",
    dbName: "synapsor_runner_mcp_orders",
    readUrl: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_reader", "synapsor_reader_password"),
    writeUrl: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_writer", "synapsor_writer_password"),
    env: {
      ORDERS_MYSQL_READ_URL: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_reader", "synapsor_reader_password"),
      ORDERS_MYSQL_WRITE_URL: mysqlUrl(53307, "synapsor_runner_mcp_orders", "synapsor_writer", "synapsor_writer_password"),
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_orders_agent",
    },
    inspectTool: "orders.inspect_order",
    proposalTool: "orders.propose_refund_review",
    inspectArgs: { order_id: "O-1001" },
    spoofArgs: { order_id: "O-9001", tenant_id: "otherco" },
    proposalArgs: { order_id: "O-1001", refund_note: "Refund needs manager review" },
    staleProposalArgs: { order_id: "O-1001", refund_note: "stale-row refund review" },
    diffColumn: "refund_review_status",
    expectedBefore: "none",
    expectedProposed: "review_required",
    unchangedSql: "SELECT CONCAT(refund_review_status, '|', COALESCE(refund_note, '')) FROM orders WHERE id = 'O-1001'",
    expectedUnchanged: "none|",
    resetSql: "UPDATE orders SET refund_review_status = 'none', refund_note = NULL, updated_at = '2026-06-20 12:00:00' WHERE id = 'O-1001'; DELETE FROM synapsor_writeback_receipts;",
    staleMutateSql: "UPDATE orders SET updated_at = '2026-06-20 15:00:00' WHERE id = 'O-1001';",
    finalSql: "SELECT CONCAT(refund_review_status, '|', COALESCE(refund_note, '')) FROM orders WHERE id = 'O-1001'",
    expectedFinal: "none|",
    disallowedColumn: "credit_card_note",
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

function runner(scenario, args, env = {}, options = {}) {
  return run("corepack", ["pnpm", "runner", ...args], {
    capture: true,
    allowFailure: options.allowFailure,
    env: {
      ...scenario.env,
      SYNAPSOR_ENGINE: scenario.engine,
      SYNAPSOR_DATABASE_URL: scenario.writeUrl,
      SYNAPSOR_RUNNER_ID: `${scenario.key}_runner`,
      SYNAPSOR_SOURCE_ID: scenario.engine === "mysql" ? "app_mysql_orders" : scenario.key.includes("support") ? "app_postgres_support" : "app_postgres",
      SYNAPSOR_CONTROL_PLANE_URL: "http://127.0.0.1:0",
      SYNAPSOR_RUNNER_TOKEN: "syn_wbr_local_demo",
      ...env,
    },
  });
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
      [
        "exec",
        scenario.container,
        "psql",
        "-U",
        "synapsor_admin",
        "-d",
        scenario.dbName,
        "-tAc",
        sql,
      ],
      { capture: true },
    ).stdout.trim();
  }
  return run(
    "docker",
    [
      "exec",
      scenario.container,
      "mysql",
      "-uroot",
      "-proot_password",
      "-N",
      "-B",
      "-D",
      scenario.dbName,
      "-e",
      sql,
    ],
    { capture: true },
  ).stdout.trim();
}

async function waitForDatabase(scenario) {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = scenario.engine === "postgres"
      ? run(
        "docker",
        ["exec", scenario.container, "pg_isready", "-U", "synapsor_admin", "-d", scenario.dbName],
        { capture: true, allowFailure: true },
      )
      : run(
        "docker",
        [
          "exec",
          scenario.container,
          "mysql",
          "-usynapsor_reader",
          "-psynapsor_reader_password",
          "-N",
          "-B",
          "-D",
          scenario.dbName,
          "-e",
          "SELECT COUNT(*) FROM orders;",
        ],
        { capture: true, allowFailure: true },
    );
    if (result.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${scenario.label} database did not become ready: ${last}`);
}

async function withMcpClient(scenario, callback) {
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: [
      "apps/runner/src/cli.ts",
      "mcp",
      "serve",
      "--config",
      scenario.configPath,
      "--store",
      scenario.storePath,
    ],
    cwd: root,
    env: scenario.env,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "synapsor-runner-local-smoke", version: "0.1.0" });
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

async function exerciseMcpScenario(scenario) {
  fs.rmSync(scenario.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(scenario.tmpDir, { recursive: true });

  run("docker", ["compose", "down", "-v"], { cwd: scenario.exampleDir, allowFailure: true });
  run("docker", ["compose", "up", "-d"], { cwd: scenario.exampleDir });
  try {
    await waitForDatabase(scenario);

    console.log(`\n== ${scenario.label}: MCP stdio tools/list and tool calls ==`);
    let firstProposalId = "";
    await withMcpClient(scenario, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert(names.includes(scenario.inspectTool), `${scenario.inspectTool} missing`, names);
      assert(names.includes(scenario.proposalTool), `${scenario.proposalTool} missing`, names);
      assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "Unsafe or approval/commit tool exposed", names);

      const inspected = structured(await client.callTool({
        name: scenario.inspectTool,
        arguments: scenario.inspectArgs,
      }));
      assert(inspected.status === "ok", "Inspect tool failed", inspected);
      assert(inspected.source_database_mutated === false, "Inspect mutated source", inspected);
      assert(inspected.trusted_context?.tenant_id === "acme", "Trusted tenant context missing", inspected);

      const spoofed = structured(await client.callTool({
        name: scenario.inspectTool,
        arguments: scenario.spoofArgs,
      }));
      assert(
        spoofed.ok === false && ["MODEL_CANNOT_OVERRIDE_BINDING", "ROW_NOT_FOUND"].includes(String(spoofed.code)),
        "Tenant spoof should be rejected or safely scoped to the trusted tenant",
        spoofed,
      );

      const proposed = structured(await client.callTool({
        name: scenario.proposalTool,
        arguments: scenario.proposalArgs,
      }));
      assert(proposed.status === "review_required", "Proposal did not require review", proposed);
      assert(proposed.diff?.[scenario.diffColumn]?.before === scenario.expectedBefore, "Proposal diff before value wrong", proposed);
      assert(proposed.diff?.[scenario.diffColumn]?.proposed === scenario.expectedProposed, "Proposal diff proposed value wrong", proposed);
      assert(proposed.source_database_mutated === false, "Proposal mutated source", proposed);
      firstProposalId = String(proposed.proposal_id);

      const evidence = await client.readResource({ uri: String(proposed.evidence_resource) });
      assert(evidence.contents?.[0]?.text?.includes("external_row"), "Evidence resource did not include external row", evidence);
    });

    const unchanged = dockerSql(scenario, scenario.unchangedSql);
    assert(unchanged === scenario.expectedUnchanged, "Source database changed before approval", unchanged);

    console.log(`== ${scenario.label}: local approval -> generated writeback job -> guarded apply ==`);
    runner(scenario, ["proposals", "approve", firstProposalId, "--store", scenario.storePath, "--actor", "local_reviewer", "--yes"]);
    const jobPath = path.join(scenario.tmpDir, "first-job.json");
    runner(scenario, ["proposals", "writeback-job", firstProposalId, "--store", scenario.storePath, "--output", jobPath, "--project", "local", "--runner", "local_runner"]);
    const unsafeJobPath = path.join(scenario.tmpDir, "disallowed-column-job.json");
    const unsafeJob = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    unsafeJob.patch = { ...unsafeJob.patch, [scenario.disallowedColumn]: "should not pass" };
    fs.writeFileSync(unsafeJobPath, `${JSON.stringify(unsafeJob, null, 2)}\n`);
    console.log(`== ${scenario.label}: disallowed-column validation ==`);
    const invalid = runner(scenario, ["validate", "--job", unsafeJobPath], {}, { allowFailure: true });
    assert(invalid.status !== 0, "Disallowed-column job unexpectedly validated", unsafeJob);
    assert(
      /patch column not allowed|patch column not allowlisted/i.test(invalid.stderr || invalid.stdout || ""),
      "Disallowed-column validation did not explain the safety failure",
      { stdout: invalid.stdout, stderr: invalid.stderr },
    );
    const applied = parseCliJson(runner(scenario, ["apply", "--job", jobPath, "--store", scenario.storePath]));
    assert(applied.status === "applied" && applied.affected_rows === 1, "Expected guarded apply", applied);
    const retry = parseCliJson(runner(scenario, ["apply", "--job", jobPath, "--store", scenario.storePath]));
    assert(retry.status === "applied" && retry.affected_rows === 0, "Expected idempotent retry", retry);
    const appliedReplayPath = path.join(scenario.tmpDir, "applied-replay.json");
    runner(scenario, ["replay", "export", firstProposalId, "--store", scenario.storePath, "--output", appliedReplayPath]);
    const appliedReplay = JSON.parse(fs.readFileSync(appliedReplayPath, "utf8"));
    assert(
      appliedReplay.receipts?.some((receipt) => receipt.receipt?.status === "applied" && receipt.receipt?.source_database_mutated === true),
      "Replay should include applied execution receipt",
      appliedReplay,
    );

    console.log(`== ${scenario.label}: stale-row conflict proof ==`);
    dockerSql(scenario, scenario.resetSql);

    let staleProposalId = "";
    await withMcpClient(scenario, async (client) => {
      const proposed = structured(await client.callTool({
        name: scenario.proposalTool,
        arguments: scenario.staleProposalArgs,
      }));
      staleProposalId = String(proposed.proposal_id);
      assert(proposed.status === "review_required", "Stale proposal was not created", proposed);
    });

    dockerSql(scenario, scenario.staleMutateSql);
    runner(scenario, ["proposals", "approve", staleProposalId, "--store", scenario.storePath, "--actor", "local_reviewer", "--yes"]);
    const staleJobPath = path.join(scenario.tmpDir, "stale-job.json");
    runner(scenario, ["proposals", "writeback-job", staleProposalId, "--store", scenario.storePath, "--output", staleJobPath, "--project", "local", "--runner", "local_runner"]);
    const conflict = parseCliJson(runner(scenario, ["apply", "--job", staleJobPath, "--store", scenario.storePath]));
    assert(conflict.status === "conflict" && conflict.error_code === "VERSION_CONFLICT", "Expected stale-row conflict", conflict);
    const finalRow = dockerSql(scenario, scenario.finalSql);
    assert(finalRow === scenario.expectedFinal, "Conflict path should not apply write", finalRow);
    const conflictReplayPath = path.join(scenario.tmpDir, "conflict-replay.json");
    runner(scenario, ["replay", "export", staleProposalId, "--store", scenario.storePath, "--output", conflictReplayPath]);
    const conflictReplay = JSON.parse(fs.readFileSync(conflictReplayPath, "utf8"));
    assert(conflictReplay.proposal?.state === "conflict", "Replay proposal state should be conflict", conflictReplay);
    assert(
      conflictReplay.receipts?.some((receipt) => receipt.receipt?.status === "conflict" && receipt.receipt?.safe_error_code === "VERSION_CONFLICT"),
      "Replay should include stale-row conflict receipt",
      conflictReplay,
    );
    assert(
      conflictReplay.events?.some((event) => event.kind === "writeback_conflict"),
      "Replay should include writeback_conflict event",
      conflictReplay,
    );
  } finally {
    run("docker", ["compose", "down", "-v"], { cwd: scenario.exampleDir, allowFailure: true });
    fs.rmSync(scenario.tmpDir, { recursive: true, force: true });
  }
}

for (const scenario of scenarios) {
  await exerciseMcpScenario(scenario);
}

console.log("\nThe business state changed after the agent saw it, so Synapsor refused to commit.");
console.log("Local MCP Postgres and MySQL examples passed.");
