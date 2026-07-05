import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { ControlPlaneClient } from "../packages/control-plane-client/dist/index.js";
import { runOnce } from "../packages/worker-core/dist/index.js";
import { postgresAdapter } from "../packages/postgres/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(root, "examples", "mcp-postgres-billing");
const tmpDir = path.join(root, "tmp", "mcp-cloud-linked");
const configPath = path.join(tmpDir, "synapsor.cloud.json");
const storePath = path.join(tmpDir, "cloud-local.db");
const container = "synapsor_runner_mcp_postgres_billing";
const database = "synapsor_runner_mcp_billing";
const localDbHost = process.env.SYNAPSOR_LOCAL_DB_HOST || "localhost";
const readUrl = `postgresql://synapsor_reader:synapsor_reader_password@${localDbHost}:55433/${database}`;
const writeUrl = `postgresql://synapsor_writer:synapsor_writer_password@${localDbHost}:55433/${database}`;

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

function dockerSql(sql) {
  return run(
    "docker",
    ["exec", container, "psql", "-U", "synapsor_admin", "-d", database, "-tAc", sql],
    { capture: true },
  ).stdout.trim();
}

async function waitForPostgres() {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = run(
      "docker",
      ["exec", container, "pg_isready", "-U", "synapsor_admin", "-d", database],
      { capture: true, allowFailure: true },
    );
    if (ready.status === 0) {
      const query = run(
        "docker",
        ["exec", container, "psql", "-U", "synapsor_admin", "-d", database, "-tAc", "SELECT 1"],
        { capture: true, allowFailure: true },
      );
      if (query.status === 0 && query.stdout.trim() === "1") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return;
      }
      last = query.stderr || query.stdout || `psql exit ${query.status}`;
    } else {
      last = ready.stderr || ready.stdout || `pg_isready exit ${ready.status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Postgres billing database did not become ready: ${last}`);
}

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  if (!text) throw new Error(`Missing structured MCP result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function startMockCloud() {
  const state = {
    approved: false,
    claimed: false,
    completed: false,
    registered: undefined,
    heartbeat: undefined,
    adapterCall: undefined,
    claimBody: undefined,
    resultBody: undefined,
    resultPath: undefined,
  };
  const job = {
    schema_version: "synapsor.writeback-job.v1",
    writeback_job_id: "wbj_cloud_1",
    proposal_id: "wrp_cloud_1",
    proposal_version: 1,
    proposal_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    runner_scope: {
      project_id: "proj_cloud_smoke",
      source_id: "src_pg_cloud",
    },
    engine: "postgres",
    operation: "single_row_update",
    target: {
      schema: "public",
      table: "invoices",
      primary_key: {
        column: "id",
        value: "INV-3001",
      },
    },
    tenant_guard: {
      column: "tenant_id",
      value: "acme",
    },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    patch: {
      late_fee_cents: 0,
      waiver_reason: "approved support waiver",
    },
    conflict_guard: {
      kind: "column",
      column: "updated_at",
      expected_value: "2026-06-20T14:31:08Z",
    },
    idempotency_key: "wrp_cloud_1:INV-3001",
    lease: {
      lease_id: "lease_cloud_1",
      attempt: 1,
      expires_at: "2026-06-20T14:36:00Z",
    },
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const body = request.method === "GET" ? {} : await readBody(request);
      if (request.headers.authorization !== "Bearer syn_wbr_cloud_smoke") {
        writeJson(response, 401, { ok: false, error: "invalid_writeback_runner_token" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/writeback/runner/doctor") {
        writeJson(response, 200, { ok: true, authenticated: true, source_id: "src_pg_cloud" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runner/register") {
        state.registered = body;
        writeJson(response, 200, { ok: true, runner: { runner_id: body.runner_id } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runner/heartbeat") {
        state.heartbeat = body;
        writeJson(response, 200, { ok: true, runner: { runner_id: body.runner_id, status: body.status } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/agent/adapters/tools") {
        assert(body.adapter === "mcp.billing", "Cloud tools/list used the wrong adapter", body);
        writeJson(response, 200, {
          ok: true,
          adapter_id: "mcp.billing",
          tools: [
            {
              name: "billing.propose_late_fee_waiver",
              title: "Propose late-fee waiver",
              description: "Create an evidence-backed proposal for a trusted runner to apply after approval.",
              input_schema: {
                type: "object",
                required: ["invoice_id", "reason"],
                additionalProperties: false,
                properties: {
                  invoice_id: { type: "string" },
                  reason: { type: "string" },
                },
              },
              output_schema: {
                type: "object",
                required: ["status", "proposal_id", "source_database_mutated"],
                properties: {
                  status: { type: "string" },
                  proposal_id: { type: "string" },
                  source_database_mutated: { type: "boolean" },
                },
              },
              annotations: {
                readOnlyHint: false,
                raw_sql_exposed: false,
                model_may_approve_or_commit: false,
              },
            },
          ],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/agent/adapters/call-tool") {
        state.adapterCall = body;
        assert(body.adapter === "mcp.billing", "Cloud tool call used the wrong adapter", body);
        assert(body.tool === "billing.propose_late_fee_waiver", "Cloud tool call used the wrong tool", body);
        assert(body.session?.tenant_id === "acme", "Cloud trusted session was not bound", body);
        assert(!("tenant_id" in (body.input || {})), "Model input attempted to supply trusted tenant context", body);
        writeJson(response, 200, {
          ok: true,
          result: {
            status: "review_required",
            proposal_id: "wrp_cloud_1",
            proposal_version: 1,
            proposal_hash: job.proposal_hash,
            evidence_bundle_id: "ev_cloud_1",
            replay_id: "replay_cloud_1",
            source_database_mutated: false,
            trusted_context: {
              tenant_id: "acme",
              principal: "cloud_session_runner",
            },
            diff: {
              late_fee_cents: { before: 5500, proposed: 0 },
              waiver_reason: { before: null, proposed: "approved support waiver" },
            },
            writeback_status: "approved_for_writeback_pending_runner",
          },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/writeback/jobs/claim") {
        state.claimBody = body;
        assert(body.source_id === "src_pg_cloud", "Runner claimed the wrong source", body);
        const jobs = state.approved && !state.claimed ? [job] : [];
        state.claimed = state.claimed || jobs.length > 0;
        writeJson(response, 200, { ok: true, jobs });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/writeback/jobs/wbj_cloud_1/heartbeat") {
        writeJson(response, 200, { ok: true, job_id: "wbj_cloud_1", lease_expires_at: "2026-06-20T14:37:00Z" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/writeback/jobs/wbj_cloud_1/result") {
        state.resultBody = body;
        state.resultPath = url.pathname;
        state.completed = true;
        writeJson(response, 200, { ok: true, accepted: true });
        return;
      }
      writeJson(response, 404, { ok: false, error: "not_found", path: url.pathname });
    } catch (error) {
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock Cloud server did not bind to a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withCloudMcpClient(baseUrl, callback) {
  const env = {
    ...process.env,
    SYNAPSOR_CLOUD_BASE_URL: baseUrl,
    SYNAPSOR_RUNNER_TOKEN: "syn_wbr_cloud_smoke",
  };
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
    env,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "synapsor-runner-cloud-linked-smoke", version: "0.1.0" });
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

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify({
  version: 1,
  mode: "cloud",
  storage: { sqlite_path: storePath },
  trusted_context: { provider: "cloud_session" },
  cloud: {
    base_url_env: "SYNAPSOR_CLOUD_BASE_URL",
    runner_token_env: "SYNAPSOR_RUNNER_TOKEN",
    runner_id: "runner_cloud_smoke",
    runner_version: "0.1.0-alpha.7",
    project_id: "proj_cloud_smoke",
    adapter_id: "mcp.billing",
    source_id: "src_pg_cloud",
    engines: ["postgres"],
    capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
    session: { tenant_id: "acme" },
  },
}, null, 2)}\n`);

const cloud = await startMockCloud();
run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
run("docker", ["compose", "up", "-d"], { cwd: exampleDir });
try {
  await waitForPostgres();
  dockerSql("UPDATE public.invoices SET late_fee_cents = 5500, waiver_reason = NULL, updated_at = '2026-06-20T14:31:08Z' WHERE id = 'INV-3001'; DROP TABLE IF EXISTS public.synapsor_writeback_receipts;");

  console.log("== Cloud-linked runner registration and heartbeat ==");
  const cloudClient = new ControlPlaneClient({
    baseUrl: cloud.baseUrl,
    runnerToken: "syn_wbr_cloud_smoke",
    sourceId: "src_pg_cloud",
  });
  const doctor = await cloudClient.doctor();
  assert(doctor.ok && doctor.authenticated, "Runner token doctor check failed", doctor);
  await cloudClient.register({
    schema_version: "synapsor.runner-registration.v1",
    runner_id: "runner_cloud_smoke",
    runner_version: "0.1.0-alpha.7",
    engines: ["postgres"],
    capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
    scope: { project_id: "proj_cloud_smoke", source_ids: ["src_pg_cloud"] },
    registered_at: "2026-06-20T00:00:00Z",
  });
  await cloudClient.runnerHeartbeat({
    runner_id: "runner_cloud_smoke",
    runner_version: "0.1.0-alpha.7",
    engines: ["postgres"],
    source_ids: ["src_pg_cloud"],
    status: "online",
  });
  assert(cloud.state.registered?.runner_id === "runner_cloud_smoke", "Runner registration did not reach Cloud", cloud.state);
  assert(cloud.state.heartbeat?.status === "online", "Runner heartbeat did not reach Cloud", cloud.state);
  assert(JSON.stringify(cloud.state.registered).includes("postgres://") === false, "Registration leaked a database URL", cloud.state.registered);

  console.log("== Cloud-linked MCP tools/list and proposal call ==");
  await withCloudMcpClient(cloud.baseUrl, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert(names.includes("billing.propose_late_fee_waiver"), "Cloud adapter tool was not listed", names);
    assert(!names.some((name) => /execute_sql|run_query|approve|commit/i.test(name)), "Cloud adapter exposed unsafe or approval/commit tool", names);
    const proposed = structured(await client.callTool({
      name: "billing.propose_late_fee_waiver",
      arguments: { invoice_id: "INV-3001", reason: "approved support waiver" },
    }));
    assert(proposed.mode === "cloud", "Proposal call was not delegated through Cloud mode", proposed);
    assert(proposed.status === "review_required", "Cloud proposal did not require review", proposed);
    assert(proposed.source_database_mutated === false, "Cloud proposal mutated the source database", proposed);
    assert(proposed.trusted_context?.tenant_id === "acme", "Cloud proposal did not expose trusted context", proposed);
  });
  const unchanged = dockerSql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'");
  assert(unchanged === "5500|", "Source database changed before Cloud approval/writeback", unchanged);

  console.log("== Cloud approval -> job lease -> guarded local write -> Cloud receipt ==");
  cloud.state.approved = true;
  const completed = await runOnce({
    controlPlaneUrl: cloud.baseUrl,
    runnerToken: "syn_wbr_cloud_smoke",
    runnerId: "runner_cloud_smoke",
    sourceId: "src_pg_cloud",
    databaseUrl: writeUrl,
    engine: "postgres",
    pollIntervalMs: 5000,
    logLevel: "error",
    dryRun: false,
    stateDir: tmpDir,
  }, { postgres: postgresAdapter });
  assert(completed === 1, "Runner did not complete the claimed Cloud writeback job", { completed, state: cloud.state });
  assert(cloud.state.completed === true, "Runner did not submit the Cloud receipt", cloud.state);
  assert(cloud.state.resultPath === "/v1/writeback/jobs/wbj_cloud_1/result", "Runner submitted the receipt to the wrong Cloud path", cloud.state);
  assert(cloud.state.resultBody?.status === "applied", "Cloud receipt was not applied", cloud.state.resultBody);
  assert(cloud.state.resultBody?.affected_rows === 1, "Cloud receipt did not report one affected row", cloud.state.resultBody);
  assert(!JSON.stringify(cloud.state.resultBody).match(/postgres(?:ql)?:\/\/|synapsor_writer_password/), "Receipt leaked database credentials", cloud.state.resultBody);
  const finalRow = dockerSql("SELECT late_fee_cents || '|' || COALESCE(waiver_reason, '') FROM public.invoices WHERE id = 'INV-3001'");
  assert(finalRow === "0|approved support waiver", "Guarded Cloud-linked writeback did not update the expected row", finalRow);

  console.log("Cloud-linked MCP runner flow passed: token, registration, tools/list, proposal, approval, lease, guarded writeback, receipt.");
} finally {
  await cloud.close();
  run("docker", ["compose", "down", "-v"], { cwd: exampleDir, allowFailure: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
