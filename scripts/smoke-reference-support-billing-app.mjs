import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = process.env.SYNAPSOR_REFERENCE_EXAMPLE_DIR
  ? path.resolve(root, process.env.SYNAPSOR_REFERENCE_EXAMPLE_DIR)
  : path.join(root, "examples", "reference-support-billing-app");
const configPath = process.env.SYNAPSOR_REFERENCE_CONFIG_PATH
  ? path.resolve(root, process.env.SYNAPSOR_REFERENCE_CONFIG_PATH)
  : path.join(exampleDir, "synapsor.runner.json");
const tmpDir = process.env.SYNAPSOR_REFERENCE_TMP_DIR
  ? path.resolve(root, process.env.SYNAPSOR_REFERENCE_TMP_DIR)
  : path.join(root, "tmp", "reference-support-billing");
const storePath = path.join(tmpDir, "local.db");
const container = process.env.SYNAPSOR_REFERENCE_CONTAINER || "synapsor_runner_reference_support_billing";
const dbName = process.env.SYNAPSOR_REFERENCE_DB || "synapsor_reference_support_billing";
const dbPort = process.env.SYNAPSOR_REFERENCE_PORT || "55435";
const readUrl = `postgresql://synapsor_reader:synapsor_reader_password@localhost:${dbPort}/${dbName}`;
const writeUrl = `postgresql://synapsor_writer:synapsor_writer_password@localhost:${dbPort}/${dbName}`;
const expectedTools = (process.env.SYNAPSOR_REFERENCE_EXPECTED_TOOLS || [
  "support.inspect_ticket",
  "support.propose_ticket_resolution",
  "support.inspect_customer_account",
  "support.propose_plan_credit",
  "billing.inspect_invoice",
  "billing.propose_late_fee_waiver",
  "orders.inspect_order",
  "orders.propose_status_change",
].join(","))
  .split(",")
  .map((tool) => tool.trim())
  .filter(Boolean);
const requireExactTools = process.env.SYNAPSOR_REFERENCE_EXACT_TOOLS === "1";
const supportTicketId = process.env.SYNAPSOR_REFERENCE_TICKET_ID || "T-1042";
const requirePrincipalScope = process.env.SYNAPSOR_REFERENCE_REQUIRE_PRINCIPAL_SCOPE === "1";
const env = {
  REFERENCE_POSTGRES_READ_URL: readUrl,
  REFERENCE_POSTGRES_WRITE_URL: writeUrl,
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "reference_operator",
  SYNAPSOR_ENGINE: "postgres",
  SYNAPSOR_DATABASE_URL: writeUrl,
  SYNAPSOR_RUNNER_ID: "reference_support_billing_runner",
  SYNAPSOR_SOURCE_ID: "app_postgres",
  SYNAPSOR_CONTROL_PLANE_URL: "http://127.0.0.1:0",
  SYNAPSOR_RUNNER_TOKEN: "syn_wbr_reference_local",
};

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

function runner(args, options = {}) {
  return run("corepack", ["pnpm", "runner", ...args], { ...options, capture: true, env });
}

function sql(statement) {
  return run("docker", [
    "exec",
    container,
    "psql",
    "-U",
    "synapsor_admin",
    "-d",
    dbName,
    "-tAc",
    statement,
  ], { capture: true }).stdout.trim();
}

async function waitForDatabase() {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = run("docker", ["exec", container, "pg_isready", "-U", "synapsor_admin", "-d", dbName], { capture: true, allowFailure: true });
    if (result.status === 0) {
      const hostReady = await canConnectToHostPort(Number(dbPort));
      if (hostReady) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return;
      }
      last = `container is ready, but localhost:${dbPort} is not accepting connections yet`;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`reference database did not become ready: ${last}`);
}

async function canConnectToHostPort(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function withMcpClient(callback, options = {}) {
  const activeConfigPath = options.configPath || configPath;
  const activeStorePath = options.storePath || storePath;
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: ["apps/runner/src/cli.ts", "mcp", "serve", "--config", activeConfigPath, "--store", activeStorePath],
    cwd: root,
    env,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "reference-support-billing-smoke", version: "0.2.0" });
  await client.connect(transport);
  try {
    return await callback(client);
  } catch (error) {
    if (error instanceof Error && serverStderr.trim()) error.message += `\nMCP server stderr:\n${serverStderr.trim()}`;
    throw error;
  } finally {
    await client.close();
  }
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  if (!text) throw new Error(`missing structured MCP result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function parseCliJson(result) {
  const json = result.stdout.match(/\{[\s\S]*\}\s*$/)?.[0];
  if (!json) throw new Error(`expected JSON output, got:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(json);
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
run("docker", ["compose", "up", "-d"], { cwd: exampleDir });

try {
  await waitForDatabase();
  runner(["config", "validate", "--config", configPath]);
  if (process.env.SYNAPSOR_REFERENCE_REQUIRE_RLS === "1") {
    const doctor = parseCliJson(runner(["doctor", "--config", configPath, "--store", storePath, "--check-rls", "--json"]));
    assert(doctor.ok === true, "PostgreSQL RLS doctor did not pass", doctor);
    assert(doctor.checks?.some((check) =>
      check.name === "source:app_postgres:postgres-rls-live-canary"
      && check.level === "pass"), "PostgreSQL RLS live canary missing", doctor);
  }

  let firstProposalId = "";
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of expectedTools) {
      assert(names.includes(expected), `${expected} missing`, names);
    }
    if (requireExactTools) {
      assert(names.length === expectedTools.length && names.every((name) => expectedTools.includes(name)), "unexpected model-facing tool exposed", names);
    }
    assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "unsafe or approval/commit tool exposed", names);

    const inspected = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-3001" } }));
    assert(inspected.status === "ok", "inspect failed", inspected);
    assert(inspected.trusted_context?.tenant_id === "acme", "trusted tenant missing", inspected);
    assert(inspected.trusted_context?.principal === "reference_operator", "trusted principal missing", inspected);
    assert(typeof inspected.evidence_bundle_id === "string", "invoice evidence bundle id missing", inspected);
    assert(typeof inspected.evidence_resource === "string", "invoice evidence resource missing", inspected);
    const inspectedText = JSON.stringify(inspected);
    for (const forbidden of ["card_token", "internal_risk_note", "tok_acme_must_stay_hidden", "manual risk note must stay hidden"]) {
      assert(!inspectedText.includes(forbidden), `kept-out invoice field leaked: ${forbidden}`, inspected);
    }

    if (names.includes("support.inspect_ticket")) {
      const support = structured(await client.callTool({ name: "support.inspect_ticket", arguments: { ticket_id: supportTicketId } }));
      assert(support.status === "ok", "support inspect failed", support);
      assert(typeof support.evidence_bundle_id === "string", "support evidence bundle id missing", support);
      assert(typeof support.evidence_resource === "string", "support evidence resource missing", support);
    }

    if (names.includes("support.propose_plan_credit")) {
      const supportCredit = structured(await client.callTool({
        name: "support.propose_plan_credit",
        arguments: { customer_id: "cust_acme_1", credit_cents: 1000, reason: "support goodwill credit" },
      }));
      assert(supportCredit.status === "review_required", "support credit proposal did not require review", supportCredit);
      assert(supportCredit.source_database_mutated === false, "support credit proposal mutated source", supportCredit);
    }

    if (names.includes("orders.inspect_order")) {
      const order = structured(await client.callTool({ name: "orders.inspect_order", arguments: { order_id: "O-1001" } }));
      assert(order.status === "ok", "order inspect failed", order);
    }

    if (names.includes("orders.propose_status_change")) {
      const orderStatus = structured(await client.callTool({
        name: "orders.propose_status_change",
        arguments: { order_id: "O-1001", status: "ready_to_ship", reason: "payment cleared" },
      }));
      assert(orderStatus.status === "review_required", "order status proposal did not require review", orderStatus);
      assert(orderStatus.source_database_mutated === false, "order status proposal mutated source", orderStatus);
    }

    const spoofed = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-9001", tenant_id: "otherco" } }));
    assert(spoofed.ok === false, "tenant spoof should not return other tenant row", spoofed);
    const crossTenant = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-9001" } }));
    assert(crossTenant.ok === false, "other tenant row should remain unavailable without a spoofed argument", crossTenant);
    if (requirePrincipalScope) {
      const crossPrincipal = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-3002" } }));
      assert(crossPrincipal.ok === false, "same-tenant other-principal row should remain unavailable", crossPrincipal);
    }

    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "approved support waiver" },
    }));
    assert(proposed.status === "review_required", "proposal did not require review", proposed);
    assert(proposed.diff?.late_fee_cents?.before === 5500, "diff before wrong", proposed);
    assert(proposed.diff?.late_fee_cents?.proposed === 0, "diff proposed wrong", proposed);
    assert(proposed.source_database_mutated === false, "proposal mutated source", proposed);
    assert(typeof proposed.evidence_bundle_id === "string", "proposal evidence bundle id missing", proposed);
    assert(typeof proposed.evidence_resource === "string", "proposal evidence resource missing", proposed);
    firstProposalId = String(proposed.proposal_id);
  });

  assert(sql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'") === "5500|", "source changed before approval");
  if (expectedTools.includes("support.propose_plan_credit")) {
    assert(sql("SELECT plan_credit_cents || '|' || COALESCE(credit_reason, '') FROM public.customers WHERE id = 'cust_acme_1'") === "0|", "support credit source changed before approval");
  }
  if (expectedTools.includes("orders.propose_status_change")) {
    assert(sql("SELECT status || '|' || COALESCE(status_change_reason, '') FROM public.orders WHERE id = 'O-1001'") === "paid|", "order source changed before approval");
  }

  runner(["proposals", "approve", firstProposalId, "--store", storePath, "--actor", "local_reviewer", "--yes"]);
  const jobPath = path.join(tmpDir, "success-job.json");
  runner(["proposals", "writeback-job", firstProposalId, "--store", storePath, "--output", jobPath, "--project", "local", "--runner", "local_runner"]);
  const applied = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert(applied.status === "applied" && applied.affected_rows === 1, "expected applied writeback", applied);
  const retry = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert((retry.status === "applied" || retry.status === "already_applied") && retry.affected_rows === 0, "expected idempotent retry", retry);
  const replayPath = path.join(tmpDir, "success-replay.json");
  runner(["replay", "export", firstProposalId, "--store", storePath, "--output", replayPath]);
  const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
  assert(replay.proposal?.proposal_id === firstProposalId, "success replay missing proposal", replay);
  assert(replay.approvals?.some((approval) => approval.status === "approved"), "success replay missing approval", replay);
  assert(replay.evidence?.length > 0, "success replay missing evidence", replay);
  assert(replay.query_audit?.length > 0, "success replay missing query audit", replay);
  assert(replay.events?.some((event) => event.kind === "writeback_applied"), "success replay missing writeback event", replay);
  assert(replay.receipts?.some((receipt) => receipt.receipt?.status === "applied"), "success replay missing receipt", replay);

  sql("UPDATE public.invoices SET late_fee_cents = 5500, waiver_reason = NULL, updated_at = '2026-06-20T14:31:08Z' WHERE id = 'INV-3001'; DELETE FROM public.synapsor_writeback_receipts;");
  let staleProposalId = "";
  await withMcpClient(async (client) => {
    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "stale-row proof" },
    }));
    staleProposalId = String(proposed.proposal_id);
  });
  sql("UPDATE public.invoices SET updated_at = '2026-06-20T15:00:00Z' WHERE id = 'INV-3001';");
  runner(["proposals", "approve", staleProposalId, "--store", storePath, "--actor", "local_reviewer", "--yes"]);
  const staleJobPath = path.join(tmpDir, "stale-job.json");
  runner(["proposals", "writeback-job", staleProposalId, "--store", storePath, "--output", staleJobPath, "--project", "local", "--runner", "local_runner"]);
  const conflict = parseCliJson(runner(["apply", "--job", staleJobPath, "--config", configPath, "--store", storePath]));
  assert(conflict.status === "conflict" && conflict.error_code === "VERSION_CONFLICT", "expected stale-row conflict", conflict);

  if (process.env.SYNAPSOR_REFERENCE_SHADOW_PROOF === "1") {
    const shadowConfigPath = path.join(tmpDir, "synapsor.shadow.runner.json");
    const shadowStorePath = path.join(tmpDir, "shadow.db");
    const shadowConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    shadowConfig.mode = "shadow";
    shadowConfig.storage = { sqlite_path: shadowStorePath };
    fs.writeFileSync(shadowConfigPath, `${JSON.stringify(shadowConfig, null, 2)}\n`, "utf8");
    runner(["config", "validate", "--config", shadowConfigPath]);
    let shadowProposalId = "";
    await withMcpClient(async (client) => {
      const proposed = structured(await client.callTool({
        name: "billing.propose_late_fee_waiver",
        arguments: { invoice_id: "INV-3001", reason: "strict shadow comparison" },
      }));
      assert(proposed.status === "shadow_proposal_created", "strict Shadow Mode did not return a shadow proposal", proposed);
      assert(proposed.source_database_mutated === false, "strict Shadow Mode mutated the source", proposed);
      shadowProposalId = String(proposed.proposal_id);
    }, { configPath: shadowConfigPath, storePath: shadowStorePath });
    const approval = runner([
      "proposals", "approve", shadowProposalId,
      "--store", shadowStorePath,
      "--actor", "local_reviewer",
      "--yes",
    ], { allowFailure: true });
    assert(approval.status !== 0, "strict Shadow Mode proposal unexpectedly became approvable", {
      stdout: approval.stdout,
      stderr: approval.stderr,
    });
    assert(sql("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-3001'") === "5500", "strict Shadow Mode changed the source");
  }

  console.log("Reference support/billing app smoke passed.");
} finally {
  run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
}
