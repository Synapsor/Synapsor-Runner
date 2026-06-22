import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(root, "examples", "mcp-postgres-billing");
const configPath = path.join(exampleDir, "synapsor.runner.json");
const tmpDir = path.join(root, "tmp", "mcp-postgres-billing");
const storePath = path.join(tmpDir, "local.db");
const readUrl = "postgresql://synapsor_reader:synapsor_reader_password@localhost:55433/synapsor_runner_mcp_billing";
const writeUrl = "postgresql://synapsor_writer:synapsor_writer_password@localhost:55433/synapsor_runner_mcp_billing";

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

function runner(args, env = {}, options = {}) {
  return run("corepack", ["pnpm", "runner", ...args], {
    ...options,
    capture: true,
    env: {
      BILLING_POSTGRES_READ_URL: readUrl,
      BILLING_POSTGRES_WRITE_URL: writeUrl,
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_billing_agent",
      SYNAPSOR_ENGINE: "postgres",
      SYNAPSOR_DATABASE_URL: writeUrl,
      SYNAPSOR_RUNNER_ID: "local_runner",
      SYNAPSOR_SOURCE_ID: "app_postgres",
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

function dockerSql(sql) {
  return run(
    "docker",
    [
      "exec",
      "synapsor_runner_mcp_postgres_billing",
      "psql",
      "-U",
      "synapsor_admin",
      "-d",
      "synapsor_runner_mcp_billing",
      "-tAc",
      sql,
    ],
    { capture: true },
  ).stdout.trim();
}

async function waitForPostgres() {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = run(
      "docker",
      ["exec", "synapsor_runner_mcp_postgres_billing", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_runner_mcp_billing"],
      { capture: true, allowFailure: true },
    );
    if (result.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Postgres did not become ready: ${last}`);
}

async function withMcpClient(callback) {
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: [
      "apps/runner/src/cli.ts",
      "mcp",
      "serve",
      "--config",
      configPath,
      "--store",
      storePath,
    ],
    cwd: root,
    env: {
      BILLING_POSTGRES_READ_URL: readUrl,
      BILLING_POSTGRES_WRITE_URL: writeUrl,
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_billing_agent",
    },
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

async function main() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  run("docker", ["compose", "down", "-v"], { cwd: exampleDir });
  run("docker", ["compose", "up", "-d"], { cwd: exampleDir });
  await waitForPostgres();

  console.log("== MCP stdio tools/list and tool calls ==");
  let firstProposalId = "";
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert(names.includes("billing.inspect_invoice"), "billing.inspect_invoice missing", names);
    assert(names.includes("billing.propose_late_fee_waiver"), "billing.propose_late_fee_waiver missing", names);
    assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "Unsafe or approval/commit tool exposed", names);

    const inspected = structured(await client.callTool({
      name: "billing.inspect_invoice",
      arguments: { invoice_id: "INV-3001" },
    }));
    assert(inspected.status === "ok", "Inspect tool failed", inspected);
    assert(inspected.source_database_mutated === false, "Inspect mutated source", inspected);
    assert(inspected.trusted_context?.tenant_id === "acme", "Trusted tenant context missing", inspected);

    const spoofed = structured(await client.callTool({
      name: "billing.inspect_invoice",
      arguments: { invoice_id: "INV-9001", tenant_id: "otherco" },
    }));
    assert(
      spoofed.ok === false && ["MODEL_CANNOT_OVERRIDE_BINDING", "ROW_NOT_FOUND"].includes(String(spoofed.code)),
      "Tenant spoof should be rejected or safely scoped to the trusted tenant",
      spoofed,
    );

    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "approved support waiver" },
    }));
    assert(proposed.status === "review_required", "Proposal did not require review", proposed);
    assert(proposed.diff?.late_fee_cents?.before === 5500, "Proposal diff before value wrong", proposed);
    assert(proposed.diff?.late_fee_cents?.proposed === 0, "Proposal diff proposed value wrong", proposed);
    assert(proposed.source_database_mutated === false, "Proposal mutated source", proposed);
    firstProposalId = String(proposed.proposal_id);

    const evidence = await client.readResource({ uri: String(proposed.evidence_resource) });
    assert(evidence.contents?.[0]?.text?.includes("external_row"), "Evidence resource did not include external row", evidence);
  });

  const unchanged = dockerSql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'");
  assert(unchanged === "5500|", "Source database changed before approval", unchanged);

  console.log("== local approval -> generated writeback job -> guarded apply ==");
  runner(["proposals", "approve", firstProposalId, "--store", storePath, "--actor", "billing_lead", "--yes"]);
  const jobPath = path.join(tmpDir, "first-job.json");
  runner(["proposals", "writeback-job", firstProposalId, "--store", storePath, "--output", jobPath, "--project", "local", "--runner", "local_runner"]);
  const applied = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert(applied.status === "applied" && applied.affected_rows === 1, "Expected guarded apply", applied);
  const retry = parseCliJson(runner(["apply", "--job", jobPath, "--config", configPath, "--store", storePath]));
  assert(retry.status === "applied" && retry.affected_rows === 0, "Expected idempotent retry", retry);

  console.log("== stale-row conflict proof ==");
  dockerSql("UPDATE public.invoices SET late_fee_cents = 5500, waiver_reason = NULL, updated_at = '2026-06-20T14:31:08Z' WHERE id = 'INV-3001'; DELETE FROM public.synapsor_writeback_receipts;");

  let staleProposalId = "";
  await withMcpClient(async (client) => {
    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "stale-row test waiver" },
    }));
    staleProposalId = String(proposed.proposal_id);
    assert(proposed.status === "review_required", "Stale proposal was not created", proposed);
  });

  dockerSql("UPDATE public.invoices SET updated_at = '2026-06-20T15:00:00Z' WHERE id = 'INV-3001';");
  runner(["proposals", "approve", staleProposalId, "--store", storePath, "--actor", "billing_lead", "--yes"]);
  const staleJobPath = path.join(tmpDir, "stale-job.json");
  runner(["proposals", "writeback-job", staleProposalId, "--store", storePath, "--output", staleJobPath, "--project", "local", "--runner", "local_runner"]);
  const conflict = parseCliJson(runner(["apply", "--job", staleJobPath, "--config", configPath, "--store", storePath]));
  assert(conflict.status === "conflict" && conflict.error_code === "VERSION_CONFLICT", "Expected stale-row conflict", conflict);
  const finalRow = dockerSql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'");
  assert(finalRow === "5500|", "Conflict path should not apply write", finalRow);

  console.log("The business state changed after the agent saw it, so Synapsor refused to commit.");
  console.log("Local MCP Postgres billing smoke passed.");
}

try {
  await main();
} finally {
  run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
