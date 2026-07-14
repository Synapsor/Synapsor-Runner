import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { SignJWT, importPKCS8 } from "../packages/mcp-server/node_modules/jose/dist/webapi/index.js";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import { checkRunnerReadiness, createMcpRuntime } from "../packages/mcp-server/dist/index.js";
import { ProposalStore, sharedPostgresRuntimeStoreMigration } from "../packages/proposal-store/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(root, "examples", "runner-fleet");
const composeFile = path.join(exampleDir, "docker-compose.yml");
const runnerSource = path.join(root, "apps", "runner", "src", "cli.ts");
const postgresUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const postgresReadUrl = "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet";
const postgresWriteUrl = "postgresql://synapsor_writer:synapsor_writer_password@127.0.0.1:55439/synapsor_fleet";
const mysqlReadUrl = "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet";
const metricsToken = "synthetic-fleet-metrics-token";
const handlerToken = "synthetic-fleet-handler-token";
const handlerSigningSecret = "synthetic-fleet-handler-signing-secret-32-bytes";
const { Pool } = pg;

let tempDir;
let handler;
let databasePool;
const children = new Set();

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function runnerEnv(extra = {}) {
  return {
    FLEET_POSTGRES_READ_URL: postgresReadUrl,
    FLEET_POSTGRES_WRITE_URL: postgresWriteUrl,
    SYNAPSOR_LEDGER_DATABASE_URL: postgresUrl,
    SYNAPSOR_METRICS_TOKEN: metricsToken,
    FLEET_HANDLER_URL: handler?.url ?? "http://127.0.0.1:1/synapsor/writeback",
    FLEET_HANDLER_TOKEN: handlerToken,
    FLEET_HANDLER_SIGNING_SECRET: handlerSigningSecret,
    ...extra,
  };
}

function runner(args, options = {}) {
  return run(process.execPath, ["--import", "tsx", runnerSource, ...args], {
    env: runnerEnv(options.env),
    allowFailure: options.allowFailure,
  });
}

function startRunner(port, configPath, name) {
  const child = spawn(process.execPath, ["--import", "tsx", runnerSource, "mcp", "serve", "--transport", "streamable-http", "--host", "127.0.0.1", "--port", String(port), "--config", configPath], {
    cwd: root,
    env: { ...process.env, ...runnerEnv(), SYNAPSOR_RUNNER_ID: name },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output += String(chunk); });
  child.stderr.on("data", (chunk) => { child.output += String(chunk); });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function startRunnerCommand(args, name) {
  const child = spawn(process.execPath, ["--import", "tsx", runnerSource, ...args], {
    cwd: root,
    env: { ...process.env, ...runnerEnv(), SYNAPSOR_RUNNER_ID: name },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output += String(chunk); });
  child.stderr.on("data", (chunk) => { child.output += String(chunk); });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function startWorker(configPath, proposalId, identity, suffix = "one") {
  const workerId = `worker_${proposalId}_${suffix}`;
  return startRunnerCommand([
    "worker", "run", "--once", "--yes",
    "--config", configPath, "--worker-id", workerId,
    "--identity", identity.name, "--identity-key", identity.privatePath,
  ], workerId);
}

function startApproval(configPath, proposalId, identity) {
  return startRunnerCommand([
    "proposals", "approve", proposalId, "--yes", "--config", configPath,
    "--identity", identity.name, "--identity-key", identity.privatePath,
  ], `reviewer_${identity.name}_${proposalId}`);
}

async function waitForChild(child, timeoutMs = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode, output: child.output };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child process timed out\n${child.output}`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output: child.output });
    });
  });
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

async function waitForJson(url, expectedStatus = 200, headers = {}) {
  let last = "not attempted";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      const text = await response.text();
      if (response.status === expectedStatus) return text ? JSON.parse(text) : {};
      last = `${response.status}: ${text}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function waitForDatabases() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const pgReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], { allowFailure: true });
    const mysqlReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "mysql", "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], { allowFailure: true });
    if (pgReady.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Synthetic Postgres/MySQL did not become ready");
}

async function makeKeyPair(prefix) {
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicPath = path.join(tempDir, `${prefix}.public.pem`);
  const privatePath = path.join(tempDir, `${prefix}.private.pem`);
  await fsp.writeFile(publicPath, pair.publicKey, { mode: 0o600 });
  await fsp.writeFile(privatePath, pair.privateKey, { mode: 0o600 });
  return { name: prefix, ...pair, publicPath, privatePath };
}

async function sessionToken(session, tenant, subject) {
  const key = await importPKCS8(session.privateKey, "RS256");
  return new SignJWT({ tenant_id: tenant })
    .setProtectedHeader({ alg: "RS256", kid: "fleet-session-1" })
    .setSubject(subject)
    .setIssuer("https://fleet.example.invalid")
    .setAudience("synapsor-runner-fleet")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

async function writeRuntimeConfig(session, alice, bob) {
  const config = JSON.parse(await fsp.readFile(path.join(exampleDir, "synapsor.runner.json"), "utf8"));
  config.storage.shared_postgres.lock_timeout_ms = 15000;
  config.session_auth = {
    provider: "jwt_asymmetric",
    algorithms: ["RS256"],
    public_key_path: session.publicPath,
    issuer: "https://fleet.example.invalid",
    audience: "synapsor-runner-fleet",
    tenant_claim: "tenant_id",
    principal_claim: "sub",
    clock_skew_seconds: 10,
  };
  config.operator_identity = {
    provider: "signed_key",
    apply_roles: ["writeback_operator"],
    operators: {
      alice: { public_key_path: alice.publicPath, roles: ["billing_lead", "writeback_operator"] },
      bob: { public_key_path: bob.publicPath, roles: ["billing_lead", "writeback_operator"] },
    },
  };
  config.executors = {
    fleet_handler: {
      type: "http_handler",
      url_env: "FLEET_HANDLER_URL",
      method: "POST",
      auth: { type: "bearer_env", token_env: "FLEET_HANDLER_TOKEN" },
      signing_secret_env: "FLEET_HANDLER_SIGNING_SECRET",
      timeout_ms: 5000,
    },
  };
  const direct = config.capabilities.find((item) => item.name === "billing.propose_late_fee_waiver");
  config.capabilities.push({
    ...structuredClone(direct),
    name: "billing.propose_handler_waiver",
    executor: "fleet_handler",
    approval: { mode: "human", required_role: "billing_lead", required_approvals: 1 },
  });
  const configPath = path.join(tempDir, "synapsor.runner.json");
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

async function writeSmokeRuntimeConfig(configPath) {
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  config.result_format = 2;
  config.trusted_context = {
    provider: "static_dev",
    values: { tenant_id: "acme", principal: "smoke-cli-owner" },
  };
  delete config.rate_limits;
  delete config.metrics;
  config.capabilities = config.capabilities
    .filter((capability) => capability.name !== "billing.propose_handler_waiver")
    .map((capability) => capability.name === "billing.propose_late_fee_waiver"
      ? { ...capability, approval: { mode: "human", required_role: "billing_lead", required_approvals: 1 } }
      : capability);
  const smokeConfigPath = path.join(tempDir, "synapsor.smoke.runner.json");
  await fsp.writeFile(smokeConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return smokeConfigPath;
}

async function connectClient(port, token, name) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: "1.1.0-test" });
  await client.connect(transport);
  return { client, transport, close: () => client.close().catch(() => undefined) };
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

function parseCliJson(result) {
  const match = result.stdout?.match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error(`Expected CLI JSON\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return JSON.parse(match[0]);
}

async function approve(configPath, proposalId, identity) {
  runner(["proposals", "approve", proposalId, "--yes", "--config", configPath, "--identity", identity.name, "--identity-key", identity.privatePath]);
  return parseCliJson(runner(["proposals", "show", proposalId, "--config", configPath, "--json"]));
}

async function proposalFrom(client, capability, invoiceId, reason) {
  return structured(await client.callTool({ name: capability, arguments: { invoice_id: invoiceId, reason } }));
}

async function verifyRuntimeStoreSmokeCall(configPath, pool, identity) {
  const bridgeA = path.join(tempDir, "smoke-runner-a.db");
  const bridgeB = path.join(tempDir, "smoke-runner-b.db");
  const statusBefore = parseCliJson(runner([
    "store", "shared-postgres", "status", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL",
    "--schema", "synapsor_runner", "--json",
  ]));
  const sourceBefore = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-SMOKE-CALL'");
  assert(Number(sourceBefore.rows[0]?.late_fee_cents) === 2100, "runtime-store smoke fixture did not start unchanged", sourceBefore.rows);

  const smokeProcess = runner([
    "smoke", "call", "billing.propose_late_fee_waiver",
    "--json", JSON.stringify({ invoice_id: "INV-SMOKE-CALL", reason: "runtime-store smoke call" }),
    "--config", configPath,
    "--store", bridgeA,
  ]);
  const smoke = parseCliJson(smokeProcess);
  const proposalId = smoke.result?.proposal?.id;
  const evidenceId = smoke.result?.evidence?.bundle_id;
  assert(smoke.ok === true && smoke.store_authority === "shared_postgres" && typeof proposalId === "string" && typeof evidenceId === "string",
    "runtime-store smoke call did not return the authoritative proposal/evidence envelope", smoke);
  assert(!fs.existsSync(bridgeA), "runtime-store smoke call created an orphan local SQLite bridge", { bridgeA });

  const listed = parseCliJson(runner(["proposals", "list", "--config", configPath, "--store", bridgeB, "--json"]));
  assert(listed.proposals.some((proposal) => proposal.proposal_id === proposalId), "Runner B could not list the smoke-call proposal", listed);
  const shown = parseCliJson(runner(["proposals", "show", proposalId, "--config", configPath, "--store", bridgeB, "--json"]));
  assert(shown.proposal?.proposal_id === proposalId && shown.evidence?.evidence_bundle_id === evidenceId && shown.events?.length > 0,
    "Runner B could not show the smoke-call proposal, evidence, and events", shown);
  const evidence = parseCliJson(runner(["evidence", "show", evidenceId, "--config", configPath, "--store", bridgeB, "--json"]));
  assert(evidence.evidence_bundle_id === evidenceId && evidence.proposal_id === proposalId, "Runner B could not read smoke-call evidence", evidence);
  const queryAudit = parseCliJson(runner(["query-audit", "list", "--proposal", proposalId, "--config", configPath, "--store", bridgeB, "--json"]));
  assert(queryAudit.query_audit?.length > 0 && queryAudit.query_audit.every((entry) => entry.proposal_id === proposalId),
    "Runner B could not read smoke-call query audit", queryAudit);
  const replay = parseCliJson(runner(["replay", "show", "--proposal", proposalId, "--config", configPath, "--store", bridgeB, "--json"]));
  assert(replay.proposal?.proposal_id === proposalId && replay.evidence?.some((entry) => entry.evidence_bundle_id === evidenceId),
    "Runner B could not replay the smoke-call proposal", replay);
  assert(!fs.existsSync(bridgeB), "runtime-store read commands persisted an authoritative local bridge", { bridgeB });

  const statusAfter = parseCliJson(runner([
    "store", "shared-postgres", "status", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL",
    "--schema", "synapsor_runner", "--json",
  ]));
  assert(statusAfter.tables?.ledger_entries > statusBefore.tables?.ledger_entries,
    "shared-ledger status did not reflect smoke-call records", { statusBefore, statusAfter });
  const sourceStillUnchanged = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-SMOKE-CALL'");
  assert(Number(sourceStillUnchanged.rows[0]?.late_fee_cents) === 2100,
    "smoke call changed the source before external approval/apply", sourceStillUnchanged.rows);

  const claimsConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
  claimsConfig.trusted_context = { provider: "http_claims", values: { tenant_id_key: "tenant_id", principal_key: "sub" } };
  const resources = [
    `synapsor://proposals/${proposalId}`,
    `synapsor://evidence/${evidenceId}`,
    `synapsor://replay/replay_${proposalId}`,
  ];
  const owner = createMcpRuntime(claimsConfig, {
    env: runnerEnv(),
    trustedContext: { tenant_id: "acme", principal: "smoke-cli-owner", provenance: "http_claims" },
  });
  const wrongTenant = createMcpRuntime(claimsConfig, {
    env: runnerEnv(),
    trustedContext: { tenant_id: "globex", principal: "smoke-cli-owner", provenance: "http_claims" },
  });
  const wrongPrincipal = createMcpRuntime(claimsConfig, {
    env: runnerEnv(),
    trustedContext: { tenant_id: "acme", principal: "other-principal", provenance: "http_claims" },
  });
  try {
    for (const uri of resources) {
      await owner.readResource(uri);
      for (const unauthorized of [wrongTenant, wrongPrincipal]) {
        let rejected;
        try { await unauthorized.readResource(uri); } catch (error) { rejected = error; }
        assert(rejected?.code === "RESOURCE_NOT_FOUND" && rejected?.message === "Synapsor resource not found.",
          "runtime-store resource ownership leaked existence", { uri, code: rejected?.code, message: rejected?.message });
      }
    }
  } finally {
    await owner.close();
    await wrongTenant.close();
    await wrongPrincipal.close();
  }

  const approved = await approve(configPath, proposalId, identity);
  assert(approved.proposal?.state === "approved", "smoke-call proposal was not externally approved", approved);
  const applied = parseCliJson(runner([
    "apply", proposalId, "--yes", "--json", "--config", configPath,
    "--identity", identity.name, "--identity-key", identity.privatePath,
  ]));
  assert(applied.status === "applied" && applied.affected_rows === 1, "smoke-call proposal did not apply exactly once", applied);
  const retry = runner([
    "apply", proposalId, "--yes", "--json", "--config", configPath,
    "--identity", identity.name, "--identity-key", identity.privatePath,
  ], { allowFailure: true });
  assert(retry.status === 1 && `${retry.stdout}\n${retry.stderr}`.includes(`proposal ${proposalId} is applied`),
    "smoke-call apply retry was not rejected as an already-applied proposal", { status: retry.status, stdout: retry.stdout, stderr: retry.stderr });
  const sourceAfter = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-SMOKE-CALL'");
  const sourceReceipts = await pool.query("SELECT count(*)::int AS count FROM public.synapsor_writeback_receipts WHERE proposal_id = $1", [proposalId]);
  assert(Number(sourceAfter.rows[0]?.late_fee_cents) === 0 && Number(sourceReceipts.rows[0]?.count) === 1,
    "smoke-call writeback duplicated or missed the guarded source effect", { sourceAfter: sourceAfter.rows, sourceReceipts: sourceReceipts.rows });
  const appliedState = parseCliJson(runner(["proposals", "show", proposalId, "--config", configPath, "--store", bridgeB, "--json"]));
  assert(appliedState.proposal?.state === "applied" && appliedState.receipts?.length === 1,
    "smoke-call receipt/replay state was not durable in the shared ledger", appliedState);

  const unavailableConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
  unavailableConfig.storage.shared_postgres.url_env = "SYNAPSOR_UNAVAILABLE_LEDGER_URL";
  unavailableConfig.storage.shared_postgres.schema = "synapsor_unavailable";
  const unavailableConfigPath = path.join(tempDir, "synapsor.smoke.unavailable.runner.json");
  const unavailableBridge = path.join(tempDir, "smoke-unavailable.db");
  await fsp.writeFile(unavailableConfigPath, `${JSON.stringify(unavailableConfig, null, 2)}\n`, { mode: 0o600 });
  const unavailable = runner([
    "smoke", "call", "billing.propose_late_fee_waiver",
    "--json", JSON.stringify({ invoice_id: "INV-SMOKE-CALL", reason: "ledger unavailable" }),
    "--config", unavailableConfigPath,
    "--store", unavailableBridge,
  ], {
    allowFailure: true,
    env: { SYNAPSOR_UNAVAILABLE_LEDGER_URL: "postgresql://unavailable:never-print-this-password@127.0.0.1:1/unavailable?connect_timeout=1" },
  });
  const unavailablePayload = parseCliJson(unavailable);
  assert(unavailable.status === 1 && unavailablePayload.ok === false
    && unavailablePayload.result?.error?.code === "TEMPORARILY_UNAVAILABLE"
    && unavailablePayload.result?.error?.retryable === true,
  "unavailable shared ledger did not fail smoke call with a retryable safe envelope", unavailablePayload);
  assert(!fs.existsSync(unavailableBridge), "unavailable shared ledger left a local orphan proposal store", { unavailableBridge });
  assert(!`${unavailable.stdout}\n${unavailable.stderr}`.match(/never-print-this-password|postgres(?:ql)?:\/\//i),
    "unavailable shared-ledger smoke output leaked a connection secret");
}

async function verifyReadinessFailureModes(configPath) {
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  const env = runnerEnv();
  const healthy = await checkRunnerReadiness(config, env, 1000);
  assert(healthy.ok
    && healthy.components.some((item) => item.name === "writeback:fleet_postgres" && item.code === "WRITEBACK_READY")
    && healthy.components.some((item) => item.name === "executor:fleet_handler" && item.code === "EXECUTOR_READY"), "healthy fleet dependencies did not report source writeback and executor readiness", healthy);

  const sourceDown = await checkRunnerReadiness(config, {
    ...env,
    FLEET_POSTGRES_READ_URL: "postgresql://reader:redacted@127.0.0.1:1/unavailable",
  }, 250);
  assert(!sourceDown.ok && sourceDown.components.some((item) => item.name === "source:fleet_postgres" && item.code === "SOURCE_UNAVAILABLE"), "source-down readiness did not fail closed", sourceDown);

  const ledgerReadOnly = await checkRunnerReadiness(config, {
    ...env,
    SYNAPSOR_LEDGER_DATABASE_URL: postgresReadUrl,
  }, 1000);
  assert(!ledgerReadOnly.ok && ledgerReadOnly.components.some((item) => item.name === "ledger" && item.code === "LEDGER_UNAVAILABLE"), "read-only authoritative ledger did not fail readiness", ledgerReadOnly);

  const sockets = new Set();
  const hanging = net.createServer((socket) => sockets.add(socket));
  await new Promise((resolve, reject) => {
    hanging.once("error", reject);
    hanging.listen(0, "127.0.0.1", () => { hanging.off("error", reject); resolve(); });
  });
  const address = hanging.address();
  if (!address || typeof address === "string") throw new Error("hanging readiness server did not bind");
  try {
    const started = Date.now();
    const timedOut = await checkRunnerReadiness(config, {
      ...env,
      FLEET_POSTGRES_READ_URL: `postgresql://reader:redacted@127.0.0.1:${address.port}/hanging`,
    }, 150);
    const elapsed = Date.now() - started;
    assert(!timedOut.ok && elapsed < 1500 && timedOut.components.some((item) => item.name === "source:fleet_postgres" && item.code === "SOURCE_UNAVAILABLE"), "readiness timeout was not bounded", { elapsed, timedOut });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => hanging.close(() => resolve()));
  }

  const recovered = await checkRunnerReadiness(config, env, 1000);
  assert(recovered.ok, "readiness did not recover without process restart", recovered);
}

function createControlledHandler(pool) {
  const firstAttempt = new Set();
  const signals = new Map();
  const occurredSignals = new Set();
  const signal = (name) => {
    const pending = signals.get(name);
    if (pending) { signals.delete(name); pending.resolve(); }
    else occurredSignals.add(name);
  };
  const waitSignal = (name) => {
    if (occurredSignals.delete(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { signals.delete(name); reject(new Error(`handler signal ${name} timed out`)); }, 15000);
    signals.set(name, { resolve: () => { clearTimeout(timeout); resolve(); } });
    });
  };
  const server = http.createServer(async (request, response) => {
    if (request.method === "HEAD" && request.url === "/synapsor/writeback") {
      response.writeHead(request.headers.authorization === `Bearer ${handlerToken}` ? 200 : 401).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/synapsor/writeback") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${crypto.createHmac("sha256", handlerSigningSecret).update(raw).digest("hex")}`;
    if (request.headers.authorization !== `Bearer ${handlerToken}` || request.headers["x-synapsor-signature"] !== expected) {
      response.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw);
    const objectId = String(body.target?.primary_key?.value ?? "");
    const tenant = String(body.tenant_guard?.value ?? "");
    const idempotencyKey = String(body.idempotency_key ?? "");
    const proposalId = String(body.proposal_id ?? "");
    const mode = objectId === "INV-KILL-BEFORE"
      ? "before"
      : objectId === "INV-KILL-DURING"
        ? "during"
        : objectId === "INV-KILL-AFTER"
          ? "after"
          : "normal";
    const attemptKey = `${mode}:${idempotencyKey}`;
    console.log(`synthetic handler: object=${objectId} mode=${mode} first_attempt=${!firstAttempt.has(attemptKey)}`);
    if (!firstAttempt.has(attemptKey) && mode === "before") {
      firstAttempt.add(attemptKey);
      signal("before-write");
      await Promise.race([
        new Promise((resolve) => response.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 750)),
      ]);
      response.destroy();
      return;
    }
    const connection = await pool.connect();
    let outcome = "applied";
    try {
      await connection.query("BEGIN");
      const inserted = await connection.query(
        "INSERT INTO public.synthetic_handler_receipts (idempotency_key, proposal_id, object_id, status) VALUES ($1, $2, $3, 'applied') ON CONFLICT DO NOTHING RETURNING idempotency_key",
        [idempotencyKey, proposalId, objectId],
      );
      if (inserted.rowCount === 0) {
        outcome = "already_applied";
        await connection.query("ROLLBACK");
      } else {
        if (!firstAttempt.has(attemptKey) && mode === "during") {
          firstAttempt.add(attemptKey);
          signal("during-write");
          await Promise.race([
            new Promise((resolve) => response.once("close", resolve)),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
          await connection.query("ROLLBACK");
          response.destroy();
          return;
        }
        const updated = await connection.query(
          "UPDATE public.invoices SET late_fee_cents = $1, waiver_reason = $2, updated_at = now() WHERE id = $3 AND tenant_id = $4 AND updated_at = $5::timestamptz",
          [Number(body.patch?.late_fee_cents), String(body.patch?.waiver_reason ?? ""), objectId, tenant, String(body.guards?.expected_version?.value ?? "")],
        );
        if (updated.rowCount !== 1) {
          await connection.query("ROLLBACK");
          writeJson(response, { status: "conflict", rows_affected: 0, source_database_mutated: false, safe_error_code: "VERSION_CONFLICT" });
          return;
        }
        await connection.query("COMMIT");
      }
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    if (!firstAttempt.has(attemptKey) && mode === "after" && outcome === "applied") {
      firstAttempt.add(attemptKey);
      signal("after-commit");
      await Promise.race([
        new Promise((resolve) => response.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 750)),
      ]);
      response.destroy();
      return;
    }
    writeJson(response, {
      status: outcome,
      rows_affected: outcome === "applied" ? 1 : 0,
      source_database_mutated: outcome === "applied",
    });
  });
  return {
    server,
    waitSignal,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      this.url = `http://127.0.0.1:${address.port}/synapsor/writeback`;
      return this;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function writeJson(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function verifyPoolPressure(engine, databaseUrl, table, invoiceId) {
  const config = {
    version: 1,
    mode: "read_only",
    result_format: 2,
    sources: {
      source: {
        engine,
        read_url_env: "FLEET_POOL_TEST_URL",
        statement_timeout_ms: 2000,
        pool: {
          max_connections: 1,
          connection_timeout_ms: 1000,
          idle_timeout_ms: 5000,
          queue_timeout_ms: 100,
          queue_limit: 2,
        },
      },
    },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "pool-test" } },
    capabilities: [{
      name: `fleet.inspect_${engine}_pool`,
      kind: "read",
      source: "source",
      target: { schema: engine === "postgres" ? "public" : "synapsor_fleet", table, primary_key: "id", tenant_key: "tenant_id" },
      args: { invoice_id: { type: "string", required: true } },
      lookup: { id_from_arg: "invoice_id" },
      visible_columns: ["id", "tenant_id", "status", "late_fee_cents", "updated_at", "synthetic_delay"],
      evidence: "required",
      max_rows: 1,
    }],
  };
  const runtime = createMcpRuntime(config, { env: { FLEET_POOL_TEST_URL: databaseUrl } });
  try {
    await runtime.callTool(`fleet.inspect_${engine}_pool`, { invoice_id: invoiceId });
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => runtime.callTool(`fleet.inspect_${engine}_pool`, { invoice_id: invoiceId })));
    const values = results.map((result) => result.status === "fulfilled"
      ? result.value
      : { ok: false, error: { code: result.reason?.code ?? "UNCLASSIFIED", retryable: false } });
    assert(values.filter((value) => value.ok === true).length === 1, `${engine} pool should run one request at a time`, values);
    const unavailable = values.filter((value) => value.error?.code === "TEMPORARILY_UNAVAILABLE");
    assert(unavailable.length === 2 && unavailable.every((value) => value.error.retryable === true && Number(value.error.retry_after_ms) > 0),
      `${engine} pool pressure should return bounded retryable unavailable envelopes`, values);
    assert(JSON.stringify(values).match(/SOURCE_POOL_QUEUE_FULL|SOURCE_POOL_TIMEOUT|postgres(?:ql)?:\/\/|mysql:\/\//i) === null,
      `${engine} pool pressure leaked internal codes or connection details to the model-facing envelope`, values);
  } finally {
    await runtime.close();
  }
}

function oldChangeSet(id, state = "pending") {
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: id,
    proposal_version: 1,
    action: "billing.propose_late_fee_waiver",
    mode: "review_required",
    principal: { id: "retention-test", source: "trusted_session" },
    scope: { tenant_id: "acme", business_object: "invoices", object_id: id },
    source: { kind: "external_postgres", source_id: "fleet_postgres", schema: "public", table: "invoices", primary_key: { column: "id", value: id } },
    before: { late_fee_cents: 1, waiver_reason: null, updated_at: "2020-01-01T00:00:00.000Z" },
    patch: { late_fee_cents: 0, waiver_reason: "retention fixture" },
    after: { late_fee_cents: 0, waiver_reason: "retention fixture", updated_at: "2020-01-01T00:00:00.000Z" },
    guards: { tenant: { column: "tenant_id", value: "acme" }, allowed_columns: ["late_fee_cents", "waiver_reason"], expected_version: { column: "updated_at", value: "2020-01-01T00:00:00.000Z" } },
    evidence: { bundle_id: `ev_${id}`, query_fingerprint: `sha256:${id}`, items: [{ kind: "external_row", source_id: "fleet_postgres", table: "public.invoices", primary_key: { column: "id", value: id } }] },
    approval: { status: state, required_role: "billing_lead" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${id}` },
    created_at: "2020-01-01T00:00:00.000Z",
  };
}

async function verifyBackupRestoreRetention(configPath, pool) {
  const backup = path.join(tempDir, "ledger-backup.json");
  const restoredBackup = path.join(tempDir, "ledger-restored.json");
  runner(["store", "shared-postgres", "backup", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", "synapsor_runner", "--output", backup]);
  runner(["store", "shared-postgres", "verify-backup", "--input", backup]);
  runner(["store", "shared-postgres", "restore-backup", "--input", backup, "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", "synapsor_runner_restore", "--yes"]);
  runner(["store", "shared-postgres", "backup", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", "synapsor_runner_restore", "--output", restoredBackup]);
  const original = JSON.parse(await fsp.readFile(backup, "utf8"));
  const restored = JSON.parse(await fsp.readFile(restoredBackup, "utf8"));
  assert(original.manifest.digest === restored.manifest.digest, "restored ledger digest differs from backup");

  const schema = "synapsor_runner_retention";
  await pool.query(sharedPostgresRuntimeStoreMigration(schema));
  const store = new ProposalStore();
  store.createProposal(oldChangeSet("OLD-TERMINAL"));
  store.rejectProposal("OLD-TERMINAL", { actor: "retention-reviewer", proposal_hash: "sha256:OLD-TERMINAL", proposal_version: 1, reason: "terminal fixture" });
  store.createProposal(oldChangeSet("OLD-ACTIVE"));
  const entries = store.sharedLedgerEntries();
  store.close();
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO ${schema}.ledger_entries (entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
      [entry.entry_key, entry.kind, entry.proposal_id ?? null, entry.tenant_id ?? null, entry.capability ?? null, JSON.stringify(entry.payload), entry.created_at],
    );
  }
  const archive = path.join(tempDir, "retention-archive.json");
  const dry = parseCliJson(runner(["store", "shared-postgres", "retention", "--older-than", "1d", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", schema, "--dry-run", "--json"]));
  assert(dry.archive_entries > 0, "retention dry-run should identify old terminal records", dry);
  runner(["store", "shared-postgres", "retention", "--older-than", "1d", "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", schema, "--output", archive, "--yes"]);
  runner(["store", "shared-postgres", "verify-backup", "--input", archive]);
  const remaining = await pool.query(`SELECT payload_json->>'proposal_id' AS proposal_id FROM ${schema}.ledger_entries WHERE kind = 'proposal' ORDER BY proposal_id`);
  assert(remaining.rows.some((row) => row.proposal_id === "OLD-ACTIVE"), "retention deleted an active proposal", remaining.rows);
  assert(!remaining.rows.some((row) => row.proposal_id === "OLD-TERMINAL"), "retention kept the archived terminal proposal", remaining.rows);
}

async function main() {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-runner-fleet-"));
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { capture: false });
  await waitForDatabases();

  console.log("== start synthetic databases and two Runners ==");
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  databasePool = pool;
  pool.on("error", (error) => {
    if (!databasePool) return;
    process.stderr.write(`fleet verifier database pool error: ${error.code ?? "CONNECTION_ERROR"}\n`);
  });
  handler = await createControlledHandler(pool).start();
  const session = await makeKeyPair("session");
  const alice = await makeKeyPair("alice");
  const bob = await makeKeyPair("bob");
  const configPath = await writeRuntimeConfig(session, alice, bob);
  const smokeConfigPath = await writeSmokeRuntimeConfig(configPath);
  const validate = runner(["config", "validate", "--config", configPath]);
  assert(validate.status === 0, "fleet config validation failed", validate.stderr);
  const smokeValidate = runner(["config", "validate", "--config", smokeConfigPath]);
  assert(smokeValidate.status === 0, "runtime-store smoke config validation failed", smokeValidate.stderr);
  runner([
    "store", "shared-postgres", "apply-migration", "--yes",
    "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL", "--schema", "synapsor_runner",
  ]);
  console.log("== prove dependency readiness failure modes and recovery ==");
  await verifyReadinessFailureModes(configPath);
  console.log("== prove smoke call uses the authoritative shared runtime store ==");
  await verifyRuntimeStoreSmokeCall(smokeConfigPath, pool, alice);

  const runnerA = startRunner(8871, configPath, "fleet-a");
  const runnerB = startRunner(8872, configPath, "fleet-b");
  await Promise.all([
    waitForJson("http://127.0.0.1:8871/readyz"),
    waitForJson("http://127.0.0.1:8872/readyz"),
  ]);
  const health = await waitForJson("http://127.0.0.1:8871/healthz");
  assert(health.status === "live" && !JSON.stringify(health).match(/postgresql:|password|capabilities/i), "healthz leaked deployment detail", health);

  const [acmeToken, globexToken, rateToken] = await Promise.all([
    sessionToken(session, "acme", "agent-acme"),
    sessionToken(session, "globex", "agent-globex"),
    sessionToken(session, "rateco", "agent-rateco"),
  ]);
  const acmeA = await connectClient(8871, acmeToken, "acme-a");
  const acmeB = await connectClient(8872, acmeToken, "acme-b");
  const globexB = await connectClient(8872, globexToken, "globex-b");
  const rateA = await connectClient(8871, rateToken, "rate-a");
  const rateB = await connectClient(8872, rateToken, "rate-b");
  try {
    console.log("== prove claim isolation, shared proposal locking, and fleet rate limits ==");
    const acmeOwn = structured(await acmeA.client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-ACME" } }));
    const acmeCross = structured(await acmeA.client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-GLOBEX" } }));
    const globexOwn = structured(await globexB.client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-GLOBEX" } }));
    assert(acmeOwn.status === "ok" && acmeOwn.trusted_context?.tenant_id === "acme", "acme claim binding failed", acmeOwn);
    assert(acmeCross.code === "ROW_NOT_FOUND", "cross-tenant read was not isolated", acmeCross);
    assert(globexOwn.status === "ok" && globexOwn.trusted_context?.tenant_id === "globex", "globex claim binding failed", globexOwn);

    const duplicateResults = await Promise.all([
      proposalFrom(acmeA.client, "billing.propose_late_fee_waiver", "INV-ACME", "fleet duplicate lock"),
      proposalFrom(acmeB.client, "billing.propose_late_fee_waiver", "INV-ACME", "fleet duplicate lock"),
    ]);
    const created = duplicateResults.find((result) => result.status === "review_required");
    const blocked = duplicateResults.find((result) => result.code === "PROPOSAL_ALREADY_EXISTS");
    assert(created && blocked, "two Runners did not enforce one active proposal", duplicateResults);

    const rateResults = [];
    for (const client of [rateA.client, rateB.client, rateA.client, rateB.client]) {
      rateResults.push(structured(await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-RATECO" } })));
    }
    assert(rateResults.slice(0, 3).every((result) => result.status === "ok"), "fleet rate limit rejected too early", rateResults);
    assert(rateResults[3]?.code === "RATE_LIMITED" && Number(rateResults[3]?.retry_after_ms) > 0, "fleet-wide rate limit did not reject across instances", rateResults);

    const noMetricsAuth = await fetch("http://127.0.0.1:8872/metrics");
    assert(noMetricsAuth.status === 401, "metrics endpoint did not require separate authorization");
    const metrics = await fetch("http://127.0.0.1:8872/metrics", { headers: { authorization: `Bearer ${metricsToken}` } }).then((response) => response.text());
    assert(metrics.includes("synapsor_rate_limit_rejections_total") && !metrics.match(/INV-|agent-|password|postgresql:/), "metrics missing safe fleet counters or leaked high-cardinality data", metrics);

    await stopChild(runnerA, "SIGKILL");
    const stillReady = await waitForJson("http://127.0.0.1:8872/readyz");
    assert(stillReady.status === "ready", "surviving Runner did not remain ready", stillReady);

    console.log("== prove verified two-person quorum and guarded direct writeback ==");
    const first = await approve(configPath, created.proposal_id, alice);
    assert(first.proposal?.state === "pending_review" && first.approval_progress?.approved === 1, "first quorum approval should not permit apply", first);
    const earlyApply = runner(["apply", created.proposal_id, "--yes", "--config", configPath, "--identity", alice.name, "--identity-key", alice.privatePath, "--json"], { allowFailure: true });
    assert(earlyApply.status !== 0, "apply succeeded before quorum", earlyApply.stdout);
    const second = await approve(configPath, created.proposal_id, bob);
    assert(second.proposal?.state === "approved" && second.approval_progress?.approved === 2, "second distinct reviewer did not satisfy quorum", second);
    const applied = parseCliJson(runner(["apply", created.proposal_id, "--yes", "--config", configPath, "--identity", alice.name, "--identity-key", alice.privatePath, "--json"]));
    assert(applied.status === "applied" && applied.affected_rows === 1, "quorum-approved direct writeback failed", applied);
    const appliedRow = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-ACME'");
    assert(Number(appliedRow.rows[0]?.late_fee_cents) === 0, "guarded writeback did not change the expected row once", appliedRow.rows);
    const activity = parseCliJson(runner(["activity", "search", "--object", "invoices:INV-ACME", "--config", configPath, "--json"]));
    assert(activity.interactions.length > 0 && activity.interactions.every((item) => item.object === "invoices:INV-ACME"), "shared activity search included another business object", activity);
    const replay = parseCliJson(runner(["replay", "show", created.proposal_id, "--config", configPath, "--json"]));
    assert(replay.proposal?.proposal_id === created.proposal_id, "shared replay command did not read the fleet ledger", replay);

    console.log("== prove shared runtime-store batch apply preserves one authoritative bridge ==");
    const batchProposals = await Promise.all([
      proposalFrom(acmeB.client, "billing.propose_late_fee_waiver", "INV-BATCH-A", "shared batch apply a"),
      proposalFrom(acmeB.client, "billing.propose_late_fee_waiver", "INV-BATCH-B", "shared batch apply b"),
    ]);
    assert(batchProposals.every((proposal) => proposal.status === "review_required"), "shared batch proposals were not created", batchProposals);
    for (const proposal of batchProposals) {
      await approve(configPath, proposal.proposal_id, alice);
      const approved = await approve(configPath, proposal.proposal_id, bob);
      assert(approved.proposal?.state === "approved", "shared batch proposal did not reach approved state", approved);
    }
    const batchApplied = parseCliJson(runner([
      "apply", "--all-approved", "--yes", "--json",
      "--config", configPath,
      "--tenant", "acme",
      "--capability", "billing.propose_late_fee_waiver",
      "--max", "2",
      "--identity", alice.name,
      "--identity-key", alice.privatePath,
    ]));
    assert(batchApplied.selected === 2 && batchApplied.applied === 2 && batchApplied.conflict === 0 && batchApplied.skipped === 0,
      "shared runtime-store batch apply did not apply every selected proposal", batchApplied);
    const batchRows = await pool.query("SELECT id, late_fee_cents FROM public.invoices WHERE id IN ('INV-BATCH-A', 'INV-BATCH-B') ORDER BY id");
    assert(batchRows.rows.length === 2 && batchRows.rows.every((row) => Number(row.late_fee_cents) === 0),
      "shared runtime-store batch apply did not produce both guarded database effects", batchRows.rows);
    for (const proposal of batchProposals) {
      const state = parseCliJson(runner(["proposals", "show", proposal.proposal_id, "--config", configPath, "--json"]));
      assert(state.proposal?.state === "applied" && state.receipts?.length === 1,
        "shared runtime-store batch result was not durable in the authoritative ledger", state);
    }

    console.log("== prove concurrent reviewers preserve both quorum decisions ==");
    const quorumRace = await proposalFrom(acmeB.client, "billing.propose_late_fee_waiver", "INV-QUORUM-RACE", "concurrent reviewer decisions");
    assert(quorumRace.status === "review_required", "concurrent quorum proposal was not created", quorumRace);
    const reviewProcesses = [
      startApproval(configPath, quorumRace.proposal_id, alice),
      startApproval(configPath, quorumRace.proposal_id, bob),
    ];
    const reviewResults = await Promise.all(reviewProcesses.map((child) => waitForChild(child)));
    assert(reviewResults.every((result) => result.code === 0), "a concurrent reviewer command failed", reviewResults);
    const quorumState = parseCliJson(runner(["proposals", "show", quorumRace.proposal_id, "--config", configPath, "--json"]));
    assert(quorumState.proposal?.state === "approved" && quorumState.approval_progress?.approved === 2, "concurrent approvals were lost or overwritten", quorumState);
    const quorumApply = parseCliJson(runner(["apply", quorumRace.proposal_id, "--yes", "--config", configPath, "--identity", alice.name, "--identity-key", alice.privatePath, "--json"]));
    assert(quorumApply.status === "applied", "concurrently approved proposal did not apply", quorumApply);

    console.log("== prove concurrent workers claim one approved proposal once ==");
    const workerRace = await proposalFrom(acmeB.client, "billing.propose_handler_waiver", "INV-WORKER-RACE", "competing worker claim");
    assert(workerRace.status === "review_required", "worker-race proposal was not created", workerRace);
    await approve(configPath, workerRace.proposal_id, alice);
    const competingWorkers = [
      startWorker(configPath, workerRace.proposal_id, alice, "a"),
      startWorker(configPath, workerRace.proposal_id, alice, "b"),
    ];
    const workerResults = await Promise.all(competingWorkers.map((child) => waitForChild(child)));
    assert(workerResults.every((result) => result.code === 0), "a competing worker command failed", workerResults);
    const workerRaceRow = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = 'INV-WORKER-RACE'");
    const workerRaceReceipts = await pool.query("SELECT count(*)::int AS count FROM public.synthetic_handler_receipts WHERE object_id = 'INV-WORKER-RACE'");
    assert(Number(workerRaceRow.rows[0]?.late_fee_cents) === 0 && Number(workerRaceReceipts.rows[0]?.count) === 1, "competing workers duplicated or lost the database effect", {
      row: workerRaceRow.rows,
      receipts: workerRaceReceipts.rows,
      workers: workerResults,
    });

    for (const scenario of [
      { objectId: "INV-KILL-BEFORE", signal: "before-write" },
      { objectId: "INV-KILL-DURING", signal: "during-write" },
      { objectId: "INV-KILL-AFTER", signal: "after-commit" },
    ]) {
      console.log(`== prove worker recovery at ${scenario.signal} ==`);
      const proposal = await proposalFrom(acmeB.client, "billing.propose_handler_waiver", scenario.objectId, `controlled ${scenario.signal} recovery`);
      assert(proposal.status === "review_required", `handler proposal failed for ${scenario.objectId}`, proposal);
      await approve(configPath, proposal.proposal_id, alice);
      const worker = startWorker(configPath, proposal.proposal_id, alice);
      await Promise.race([
        handler.waitSignal(scenario.signal),
        new Promise((_, reject) => worker.once("exit", (code, signal) => reject(new Error(`worker exited before ${scenario.signal}: code=${code} signal=${signal}\n${worker.output}`)))),
      ]);
      await stopChild(worker, "SIGKILL");
      const recoveryWorker = startWorker(configPath, proposal.proposal_id, alice);
      const recovery = await waitForChild(recoveryWorker);
      assert(recovery.code === 0, `recovery worker failed for ${scenario.objectId}`, recovery.output);
      const row = await pool.query("SELECT late_fee_cents FROM public.invoices WHERE id = $1", [scenario.objectId]);
      const receipts = await pool.query("SELECT count(*)::int AS count FROM public.synthetic_handler_receipts WHERE object_id = $1", [scenario.objectId]);
      assert(Number(row.rows[0]?.late_fee_cents) === 0 && Number(receipts.rows[0]?.count) === 1, `worker recovery duplicated or lost ${scenario.objectId}`, {
        row: row.rows,
        receipts: receipts.rows,
        recovery_output: recovery.output,
      });
    }

    console.log("== prove shared dead-letter requeue, recovery, and discard ==");
    const deadLetter = async (objectId) => {
      const proposal = await proposalFrom(acmeB.client, "billing.propose_handler_waiver", objectId, `dead-letter fixture ${objectId}`);
      assert(proposal.status === "review_required", `dead-letter proposal failed for ${objectId}`, proposal);
      await approve(configPath, proposal.proposal_id, alice);
      const failedWorker = runner([
        "worker", "run", "--once", "--yes", "--config", configPath,
        "--worker-id", `dead_${objectId}`, "--max-attempts", "1",
        "--retry-base-ms", "1", "--retry-max-ms", "1",
        "--identity", alice.name, "--identity-key", alice.privatePath,
      ], { allowFailure: true, env: { FLEET_HANDLER_URL: "http://127.0.0.1:1/unavailable" } });
      assert(failedWorker.status === 0, `dead-letter worker command failed for ${objectId}`, failedWorker.stderr);
      const deadLetters = parseCliJson(runner(["worker", "dead-letter", "list", "--config", configPath, "--json"]));
      assert(deadLetters.worker_queue.some((item) => item.proposal_id === proposal.proposal_id && item.status === "dead_letter"), `shared dead-letter item missing for ${objectId}`, deadLetters);
      return proposal;
    };

    const requeued = await deadLetter("INV-DEAD-REQUEUE");
    runner([
      "worker", "dead-letter", "requeue", requeued.proposal_id, "--retry-budget", "2", "--yes",
      "--config", configPath, "--identity", alice.name, "--identity-key", alice.privatePath,
    ]);
    const requeueWorker = startWorker(configPath, requeued.proposal_id, alice, "requeue");
    const requeueResult = await waitForChild(requeueWorker);
    assert(requeueResult.code === 0, "requeued shared worker did not recover", requeueResult.output);
    const requeueReceipts = await pool.query("SELECT count(*)::int AS count FROM public.synthetic_handler_receipts WHERE object_id = 'INV-DEAD-REQUEUE'");
    assert(Number(requeueReceipts.rows[0]?.count) === 1, "requeued worker did not create exactly one durable effect", requeueReceipts.rows);

    const discarded = await deadLetter("INV-DEAD-DISCARD");
    runner([
      "worker", "dead-letter", "discard", discarded.proposal_id, "--reason", "synthetic operator closure", "--yes",
      "--config", configPath, "--identity", alice.name, "--identity-key", alice.privatePath,
    ]);
    const discardedState = parseCliJson(runner(["worker", "dead-letter", "show", discarded.proposal_id, "--config", configPath, "--json"]));
    assert(discardedState.worker_queue?.status === "discarded" && discardedState.receipts.length > 0 && discardedState.events.some((item) => item.kind === "writeback_dead_letter_discarded"), "discard did not preserve shared history", discardedState);
  } finally {
    await Promise.all([acmeA.close(), acmeB.close(), globexB.close(), rateA.close(), rateB.close()]);
    await stopChild(runnerB);
  }

  console.log("== prove bounded Postgres/MySQL connection pressure ==");
  await verifyPoolPressure("postgres", postgresReadUrl, "slow_invoices", "INV-ACME");
  await verifyPoolPressure("mysql", mysqlReadUrl, "slow_invoices", "MYSQL-ACME");
  console.log("== prove shared-ledger backup, restore, and retention ==");
  await verifyBackupRestoreRetention(configPath, pool);
  await pool.end();
  databasePool = undefined;
  console.log("Runner fleet verification passed:");
  console.log("- two claim-bound Runners shared one bounded Postgres ledger");
  console.log("- tenant isolation, fleet-wide rate limits, and one-active-proposal locking held");
  console.log("- two-person quorum blocked early apply; concurrent reviewer decisions were preserved");
  console.log("- shared runtime-store batch apply committed every selected proposal through one authoritative bridge");
  console.log("- competing workers produced one effect; termination before, during, and after commit recovered safely");
  console.log("- readiness failed for source, read-only ledger, and timeout, then recovered; dead letters requeued/discarded with history");
  console.log("- Postgres/MySQL pool pressure failed fast within configured bounds");
  console.log("- backup digest, clean restore, and archive-before-retention were verified");
}

try {
  await main();
} finally {
  for (const child of [...children]) await stopChild(child, "SIGKILL");
  if (handler) await handler.close().catch(() => undefined);
  if (databasePool) {
    await databasePool.end().catch(() => undefined);
    databasePool = undefined;
  }
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
}
