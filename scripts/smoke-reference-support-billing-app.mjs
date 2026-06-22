import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(root, "examples", "reference-support-billing-app");
const configPath = path.join(exampleDir, "synapsor.runner.json");
const tmpDir = path.join(root, "tmp", "reference-support-billing");
const storePath = path.join(tmpDir, "local.db");
const container = "synapsor_runner_reference_support_billing";
const dbName = "synapsor_reference_support_billing";
const env = {
  REFERENCE_POSTGRES_READ_URL: "postgresql://synapsor_reader:synapsor_reader_password@localhost:55435/synapsor_reference_support_billing",
  REFERENCE_POSTGRES_WRITE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "reference_operator",
  SYNAPSOR_ENGINE: "postgres",
  SYNAPSOR_DATABASE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
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
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`reference database did not become ready: ${last}`);
}

async function withMcpClient(callback) {
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: ["apps/runner/src/cli.ts", "mcp", "serve", "--config", configPath, "--store", storePath],
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

  let firstProposalId = "";
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of ["support.inspect_ticket", "support.propose_ticket_resolution", "billing.inspect_invoice", "billing.propose_late_fee_waiver"]) {
      assert(names.includes(expected), `${expected} missing`, names);
    }
    assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "unsafe or approval/commit tool exposed", names);

    const inspected = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-3001" } }));
    assert(inspected.status === "ok", "inspect failed", inspected);
    assert(inspected.trusted_context?.tenant_id === "acme", "trusted tenant missing", inspected);

    const support = structured(await client.callTool({ name: "support.inspect_ticket", arguments: { ticket_id: "T-1042" } }));
    assert(support.status === "ok", "support inspect failed", support);

    const spoofed = structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-9001", tenant_id: "otherco" } }));
    assert(spoofed.ok === false, "tenant spoof should not return other tenant row", spoofed);

    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "approved support waiver" },
    }));
    assert(proposed.status === "review_required", "proposal did not require review", proposed);
    assert(proposed.diff?.late_fee_cents?.before === 5500, "diff before wrong", proposed);
    assert(proposed.diff?.late_fee_cents?.proposed === 0, "diff proposed wrong", proposed);
    assert(proposed.source_database_mutated === false, "proposal mutated source", proposed);
    firstProposalId = String(proposed.proposal_id);
  });

  assert(sql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'") === "5500|", "source changed before approval");

  runner(["proposals", "approve", firstProposalId, "--store", storePath, "--actor", "local_reviewer", "--yes"]);
  const jobPath = path.join(tmpDir, "success-job.json");
  runner(["proposals", "writeback-job", firstProposalId, "--store", storePath, "--output", jobPath, "--project", "local", "--runner", "local_runner"]);
  const applied = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert(applied.status === "applied" && applied.affected_rows === 1, "expected applied writeback", applied);
  const retry = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert(retry.status === "applied" && retry.affected_rows === 0, "expected idempotent retry", retry);
  const replayPath = path.join(tmpDir, "success-replay.json");
  runner(["replay", "export", firstProposalId, "--store", storePath, "--output", replayPath]);
  const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
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

  console.log("Reference support/billing app smoke passed.");
} finally {
  run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
}
