import { ControlPlaneClient } from "../packages/control-plane-client/dist/index.js";
import { runOnce } from "../packages/worker-core/dist/index.js";
import { postgresAdapter } from "../packages/postgres/dist/index.js";
import { mysqlAdapter } from "../packages/mysql/dist/index.js";

const REQUIRED_ENV = [
  "SYNAPSOR_CLOUD_BASE_URL",
  "SYNAPSOR_RUNNER_TOKEN",
  "SYNAPSOR_SOURCE_ID",
  "SYNAPSOR_ADAPTER_ID",
  "SYNAPSOR_MCP_TOOL_NAME",
  "SYNAPSOR_MCP_TOOL_INPUT_JSON",
];

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`missing required environment variables: ${missing.join(", ")}`);
  console.error("Run with --help for the hosted Cloud-linked verification contract.");
  process.exit(2);
}

const baseUrl = requireEnv("SYNAPSOR_CLOUD_BASE_URL").replace(/\/+$/, "");
const runnerToken = requireEnv("SYNAPSOR_RUNNER_TOKEN");
const sourceId = requireEnv("SYNAPSOR_SOURCE_ID");
const adapterId = requireEnv("SYNAPSOR_ADAPTER_ID");
const toolName = requireEnv("SYNAPSOR_MCP_TOOL_NAME");
const toolInput = parseJsonEnv("SYNAPSOR_MCP_TOOL_INPUT_JSON");
const session = parseJsonEnv("SYNAPSOR_MCP_SESSION_JSON", {});
const runnerId = process.env.SYNAPSOR_RUNNER_ID || "synapsor-hosted-cloud-e2e";
const runnerVersion = process.env.SYNAPSOR_RUNNER_VERSION || "0.1.0-alpha.0";
const engine = (process.env.SYNAPSOR_ENGINE || "postgres").toLowerCase();
const applyJob = flag("SYNAPSOR_HOSTED_E2E_APPLY_JOB");

if (applyJob && engine !== "postgres" && engine !== "mysql") {
  throw new Error("SYNAPSOR_ENGINE must be postgres or mysql when SYNAPSOR_HOSTED_E2E_APPLY_JOB=1");
}
if (applyJob && !process.env.SYNAPSOR_DATABASE_URL) {
  throw new Error("SYNAPSOR_DATABASE_URL is required when SYNAPSOR_HOSTED_E2E_APPLY_JOB=1");
}

const client = new ControlPlaneClient({ baseUrl, runnerToken, sourceId });
const summary = {
  base_url: redactUrl(baseUrl),
  source_id: sourceId,
  adapter_id: adapterId,
  tool_name: toolName,
  runner_id: runnerId,
  doctor: "not_run",
  registered: false,
  heartbeat: false,
  tools_listed: 0,
  generic_sql_tool_exposed: false,
  tool_call: "not_run",
  proposal_linked: false,
  evidence_linked: false,
  replay_linked: false,
  source_database_mutated_before_approval: "unknown",
  writeback_applied: false,
};

const doctor = await client.doctor();
if (!doctor.ok || !doctor.authenticated) {
  throw new Error(`runner token doctor failed: status=${doctor.status}`);
}
summary.doctor = "ok";

await client.register({
  schema_version: "synapsor.runner-registration.v1",
  runner_id: runnerId,
  runner_version: runnerVersion,
  engines: [engine],
  capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
  scope: { project_id: process.env.SYNAPSOR_PROJECT_ID || "token_scope", source_ids: [sourceId] },
  registered_at: new Date().toISOString(),
});
summary.registered = true;

await client.runnerHeartbeat({
  runner_id: runnerId,
  runner_version: runnerVersion,
  engines: [engine],
  source_ids: [sourceId],
  status: "online",
  details: {
    mode: "hosted_cloud_linked_e2e",
    database_credentials_sent: false,
    adapter_catalog_supported: true,
    writeback_supported: true,
  },
});
summary.heartbeat = true;

const catalog = await client.adapterTools(adapterId, { session });
summary.tools_listed = catalog.tools.length;
summary.generic_sql_tool_exposed = catalog.tools.some((tool) => /(^|[._-])(execute_sql|run_sql|query_sql|raw_sql)([._-]|$)/i.test(tool.name));
if (summary.generic_sql_tool_exposed) {
  throw new Error("adapter catalog exposes a generic SQL tool");
}
if (!catalog.tools.some((tool) => tool.name === toolName)) {
  throw new Error(`adapter catalog did not include expected tool ${toolName}`);
}

const call = await client.callAdapterTool(adapterId, toolName, toolInput, {
  session,
  runId: process.env.SYNAPSOR_RUN_ID,
  stepKey: process.env.SYNAPSOR_STEP_KEY,
});
summary.tool_call = call.ok ? "ok" : "failed";
const combined = { response: call.response, raw: call.raw };
summary.proposal_linked = recursiveHasKey(combined, ["proposal_id", "proposal", "write_proposal_id"]);
summary.evidence_linked = recursiveHasKey(combined, ["evidence_bundle_id", "evidence_id", "evidence_handle", "evidence"]);
summary.replay_linked = recursiveHasKey(combined, ["replay_id", "replay_handle", "run_id"]);
const sourceMutated = recursiveFindKey(combined, "source_database_mutated");
if (typeof sourceMutated === "boolean") {
  summary.source_database_mutated_before_approval = sourceMutated;
  if (sourceMutated) throw new Error("tool call reported source_database_mutated=true before trusted writeback");
}

if (applyJob) {
  const completed = await runOnce({
    controlPlaneUrl: baseUrl,
    runnerToken,
    runnerId,
    sourceId,
    databaseUrl: requireEnv("SYNAPSOR_DATABASE_URL"),
    engine,
    pollIntervalMs: 5000,
    logLevel: "info",
    dryRun: flag("SYNAPSOR_DRY_RUN"),
    stateDir: process.env.SYNAPSOR_STATE_DIR || "./state",
  }, {
    postgres: postgresAdapter,
    mysql: mysqlAdapter,
  });
  summary.writeback_applied = completed > 0;
  if (completed === 0) {
    throw new Error("no approved writeback job was available to apply");
  }
}

console.log(JSON.stringify(summary, null, 2));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseJsonEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function flag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function recursiveHasKey(value, keys) {
  return keys.some((key) => recursiveFindKey(value, key) !== undefined);
}

function recursiveFindKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = recursiveFindKey(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function redactUrl(value) {
  return String(value || "").replace(/:\/\/([^/@:]+):([^/@]+)@/, "://<user>:<redacted>@");
}

function printHelp() {
  console.log(`Verify a real hosted Cloud-linked Synapsor runner flow without creating credentials.

Required:
  SYNAPSOR_CLOUD_BASE_URL          Hosted control-plane base URL, for example https://synapsor.ai
  SYNAPSOR_RUNNER_TOKEN            Existing scoped writeback runner token
  SYNAPSOR_SOURCE_ID               Source id covered by the runner token
  SYNAPSOR_ADAPTER_ID              Adapter id to list/invoke, for example mcp.billing
  SYNAPSOR_MCP_TOOL_NAME           Semantic tool name to invoke
  SYNAPSOR_MCP_TOOL_INPUT_JSON     JSON object for model-controlled tool args

Optional:
  SYNAPSOR_MCP_SESSION_JSON        Trusted session JSON object, if the token/config requires it
  SYNAPSOR_RUNNER_ID               Runner id to register
  SYNAPSOR_ENGINE                  postgres or mysql, defaults to postgres
  SYNAPSOR_HOSTED_E2E_APPLY_JOB=1  Claim and apply one approved job through the guarded adapter
  SYNAPSOR_DATABASE_URL            Required only when applying an approved job

This script never creates runner tokens, never prints token values, and never sends database URLs to Cloud.
Database mutation only happens when SYNAPSOR_HOSTED_E2E_APPLY_JOB=1 is explicitly set.`);
}
