import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (!flag("SYNAPSOR_HOSTED_E2E") || !flag("SYNAPSOR_E2E_DISPOSABLE_PROJECT")) {
  console.error("refusing hosted mutation: set SYNAPSOR_HOSTED_E2E=1 and SYNAPSOR_E2E_DISPOSABLE_PROJECT=1");
  process.exit(2);
}

const required = [
  "SYNAPSOR_CLOUD_BASE_URL",
  "SYNAPSOR_CLOUD_ACCESS_TOKEN",
  "SYNAPSOR_PROJECT_ID",
  "SYNAPSOR_SOURCE_ID",
  "SYNAPSOR_E2E_CONTRACT_PATH",
  "SYNAPSOR_E2E_READ_TOOL",
  "SYNAPSOR_E2E_READ_INPUT_JSON",
  "SYNAPSOR_E2E_CROSS_TENANT_READ_INPUT_JSON",
  "SYNAPSOR_E2E_PROPOSAL_TOOL",
  "SYNAPSOR_E2E_PROPOSAL_INPUT_JSON",
  "SYNAPSOR_E2E_REJECT_PROPOSAL_INPUT_JSON",
  "SYNAPSOR_E2E_STALE_PROPOSAL_INPUT_JSON",
  "SYNAPSOR_E2E_STALE_MUTATION_SQL",
  "SYNAPSOR_E2E_SOURCE_CHECK_SQL",
  "SYNAPSOR_E2E_SOURCE_BEFORE_JSON",
  "SYNAPSOR_E2E_SOURCE_AFTER_JSON",
  "SYNAPSOR_DATABASE_READ_URL",
  "SYNAPSOR_DATABASE_WRITE_URL",
  "SYNAPSOR_TENANT_ID",
  "SYNAPSOR_PRINCIPAL",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const baseUrl = env("SYNAPSOR_CLOUD_BASE_URL").replace(/\/+$/, "");
const humanAccessToken = env("SYNAPSOR_CLOUD_ACCESS_TOKEN");
const projectId = env("SYNAPSOR_PROJECT_ID");
const sourceId = env("SYNAPSOR_SOURCE_ID");
const contractPath = path.resolve(env("SYNAPSOR_E2E_CONTRACT_PATH"));
const engine = String(process.env.SYNAPSOR_ENGINE || "postgres").trim().toLowerCase();
if (!new URL(baseUrl).protocol.startsWith("https") && !flag("SYNAPSOR_E2E_ALLOW_HTTP")) {
  throw new Error("hosted verifier requires HTTPS; set SYNAPSOR_E2E_ALLOW_HTTP=1 only for a local control-plane test");
}
if (!['postgres', 'mysql'].includes(engine)) throw new Error("SYNAPSOR_ENGINE must be postgres or mysql");

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const packageSpec = process.env.SYNAPSOR_RUNNER_PACKAGE_SPEC || "@synapsor/runner";
const cliPackageSpec = process.env.SYNAPSOR_CLI_PACKAGE_SPEC || "@synapsor/cli";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-hosted-control-plane-"));
const installDir = path.join(tempDir, "install");
const bundleDir = path.join(tempDir, "bundle");
const storePath = path.join(bundleDir, ".synapsor", "local.db");
const stateDir = path.join(bundleDir, ".synapsor", "worker-state");
fs.mkdirSync(installDir, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });

let runnerToken = "";
let tokenId = "";
let runnerBin = "";
let cliBin = "";
let serviceApiKey = "";
let serviceApiKeyId = "";
let humanCliEnv = {};
let serviceCliEnv = {};
const runnerTokens = [];
const summary = {
  protocol: false,
  packed_cli: cliPackageSpec,
  packed_runner: packageSpec,
  human_whoami: false,
  service_api_key: false,
  service_api_key_revoked: false,
  cloud_push_parity: false,
  contract: false,
  bundle: false,
  token_rotated: false,
  registration: false,
  registration_idempotent: false,
  registration_heartbeat: false,
  scoped_read: false,
  cross_tenant_denied: false,
  proposal_source_unchanged: false,
  proposal_reviewed_metadata: false,
  cloud_approval: false,
  guarded_apply: false,
  two_runner_exclusive_claim: false,
  duplicate_claim_safe: false,
  rejection_no_write: false,
  stale_conflict: false,
  activity_linked: false,
  receipt_replay_linked: false,
  activity_exported: false,
  contract_governance: false,
  token_revoked: false,
  revoked_operations_blocked: false,
};

try {
  const discovery = await publicJson("/v1/runner/protocol");
  assert(discovery.ok === true && discovery.protocol_version === "synapsor.runner-control.v1", "hosted Runner protocol discovery failed");
  summary.protocol = true;

  run("npm", ["init", "-y"], { cwd: installDir, capture: true });
  run("npm", ["install", "--no-audit", "--no-fund", packageSpec, cliPackageSpec], { cwd: installDir, capture: true });
  runnerBin = path.join(installDir, "node_modules", ".bin", "synapsor-runner");
  cliBin = path.join(installDir, "node_modules", ".bin", "synapsor");
  assert(fs.existsSync(runnerBin), "packed/published Runner binary was not installed");
  assert(fs.existsSync(cliBin), "packed/published Cloud CLI binary was not installed");
  run(runnerBin, ["contract", "validate", contractPath], { capture: true });
  humanCliEnv = {
    ...process.env,
    SYNAPSOR_CONFIG_HOME: path.join(tempDir, "human-cli-config"),
    SYNAPSOR_CLOUD_BASE_URL: baseUrl,
    SYNAPSOR_CLOUD_ACCESS_TOKEN: humanAccessToken,
    SYNAPSOR_API_KEY: "",
  };
  const whoami = runJson(cliBin, ["auth", "whoami", "--project", projectId, "--api-url", baseUrl, "--json"], { cwd: installDir, env: humanCliEnv });
  assert(whoami.ok === true && whoami.credential_kind === "human", "packed Cloud CLI did not authenticate the human session");
  summary.human_whoami = true;

  const serviceKeyFile = path.join(tempDir, "contract-ci.key");
  const serviceKeyCreated = runJson(cliBin, [
    "api-keys", "create", "--project", projectId, "--api-url", baseUrl,
    "--name", "hosted-e2e-contract-ci",
    "--scopes", "project:read,contracts:read,contracts:write,contracts:activate,runners:read,proposals:read,activity:read,exports:read",
    "--expires-at", new Date(Date.now() + 3_600_000).toISOString(), "--secret-file", serviceKeyFile,
    "--idempotency-key", `hosted-e2e-key-${Date.now()}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  serviceApiKey = fs.readFileSync(serviceKeyFile, "utf8").trim();
  serviceApiKeyId = String(serviceKeyCreated.api_key?.key_id || "");
  assert(serviceApiKey && serviceApiKeyId, "packed Cloud CLI did not create a scoped service API key");
  serviceCliEnv = {
    ...process.env,
    SYNAPSOR_CONFIG_HOME: path.join(tempDir, "service-cli-config"),
    SYNAPSOR_CLOUD_BASE_URL: baseUrl,
    SYNAPSOR_API_KEY: serviceApiKey,
    SYNAPSOR_CLOUD_ACCESS_TOKEN: "",
  };
  runJson(cliBin, [
    "auth", "configure-service", "--profile", "ci", "--api-url", baseUrl,
    "--project", projectId, "--credential-env", "SYNAPSOR_API_KEY", "--json",
  ], { cwd: installDir, env: serviceCliEnv });
  const serviceWhoami = runJson(cliBin, ["auth", "whoami", "--profile", "ci", "--json"], { cwd: installDir, env: serviceCliEnv });
  assert(serviceWhoami.ok === true && serviceWhoami.credential_kind === "service", "scoped service API key was not usable by the packed CLI");
  summary.service_api_key = true;

  const contractName = String(contract?.metadata?.name || "hosted-runner-e2e");
  const pushed = runJson(cliBin, [
    "contracts", "push", contractPath, "--profile", "ci", "--project", projectId,
    "--api-url", baseUrl, "--name", contractName, "--activate",
    "--idempotency-key", `hosted-e2e-${digest(contract).slice(7, 23)}`, "--json",
  ], { cwd: installDir, env: serviceCliEnv });
  const contractId = String(pushed.contract_id || pushed.contract?.contract_id || "");
  const versionId = String(pushed.contract_version_id || pushed.version?.contract_version_id || "");
  const contractDigest = String(pushed.digest || pushed.version?.digest || "");
  assert(contractId && versionId && /^sha256:[0-9a-f]{64}$/i.test(contractDigest), "Cloud contract push did not return immutable identity");
  summary.contract = true;

  const runnerPush = runJson(runnerBin, [
    "cloud", "push", contractPath, "--api-url", baseUrl, "--workspace", projectId,
    "--name", contractName, "--json",
  ], { cwd: installDir, env: serviceCliEnv });
  assert(runnerPush.digest === contractDigest && runnerPush.contract_version_id === versionId, "Runner and Cloud CLI contract push diverged");
  summary.cloud_push_parity = true;

  const runnerTokenFile = path.join(tempDir, "runner.token");
  const tokenResponse = runJson(cliBin, [
    "runners", "create", "--project", projectId, "--api-url", baseUrl,
    "--name", "hosted-e2e disposable Runner", "--sources", sourceId,
    "--permissions", "runner:doctor,runner:register,runner:heartbeat,proposal:submit,activity:ingest,writeback:claim,writeback:heartbeat,writeback:result",
    "--secret-file", runnerTokenFile, "--idempotency-key", `hosted-e2e-runner-${Date.now()}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  runnerToken = fs.readFileSync(runnerTokenFile, "utf8").trim();
  tokenId = String(tokenResponse.token?.token_id || "");
  assert(runnerToken.startsWith("syn_run_") && tokenId, "Runner token creation failed");
  runnerTokens.push(runnerToken);
  const originalRunnerToken = runnerToken;
  const rotatedTokenFile = path.join(tempDir, "runner.rotated.token");
  const rotatedTokenResponse = runJson(cliBin, [
    "runners", "rotate-token", tokenId, "--project", projectId, "--api-url", baseUrl,
    "--secret-file", rotatedTokenFile, "--idempotency-key", `hosted-e2e-runner-rotate-${Date.now()}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  runnerToken = fs.readFileSync(rotatedTokenFile, "utf8").trim();
  tokenId = String(rotatedTokenResponse.token?.token_id || "");
  assert(runnerToken.startsWith("syn_run_") && tokenId, "Runner token rotation did not return a replacement token");
  runnerTokens.push(runnerToken);
  const oldDoctor = await runnerDoctor(originalRunnerToken);
  const replacementDoctor = await runnerDoctor(runnerToken);
  assert(!oldDoctor.ok, "rotated Runner token remained usable");
  assert(replacementDoctor.ok && replacementDoctor.payload?.authenticated === true, "replacement Runner token is not usable");
  summary.token_rotated = true;

  const archivePath = path.join(tempDir, "runner-bundle.zip");
  run(cliBin, [
    "runners", "bundle", "download", `${contractId}/${versionId}`,
    "--source", sourceId, "--out", archivePath, "--project", projectId,
    "--api-url", baseUrl, "--json",
  ], { cwd: installDir, env: humanCliEnv, capture: true });
  run("unzip", ["-q", archivePath, "-d", bundleDir], { capture: true });
  for (const expected of ["synapsor.contract.json", "synapsor.runner.json", "synapsor.cloud.json", ".env.example", "README.md", "mcp-client-examples"]) {
    assert(fs.existsSync(path.join(bundleDir, expected)), `Runner bundle is missing ${expected}`);
  }
  assertBundleIsCredentialFree(bundleDir, [humanAccessToken, serviceApiKey, ...runnerTokens, process.env.SYNAPSOR_DATABASE_READ_URL, process.env.SYNAPSOR_DATABASE_WRITE_URL]);
  const runnerConfig = JSON.parse(fs.readFileSync(path.join(bundleDir, "synapsor.runner.json"), "utf8"));
  const cloudConfig = JSON.parse(fs.readFileSync(path.join(bundleDir, "synapsor.cloud.json"), "utf8"));
  assert(cloudConfig.cloud?.source_id === sourceId && cloudConfig.cloud?.contract_digest === contractDigest, "Runner bundle identity mismatch");
  summary.bundle = true;

  const runnerId = String(cloudConfig.cloud?.runner_id || `runner_hosted_${Date.now()}`);
  const runnerEnv = {
    ...process.env,
    SYNAPSOR_CLOUD_BASE_URL: baseUrl,
    SYNAPSOR_CONTROL_PLANE_URL: baseUrl,
    SYNAPSOR_RUNNER_TOKEN: runnerToken,
    SYNAPSOR_RUNNER_ID: runnerId,
    SYNAPSOR_SOURCE_ID: sourceId,
    SYNAPSOR_ENGINE: engine,
    SYNAPSOR_STATE_DIR: stateDir,
  };
  bindBundleDatabaseEnvironment(runnerEnv, runnerConfig);
  run(runnerBin, ["config", "validate", "--config", "./synapsor.runner.json"], { cwd: bundleDir, env: runnerEnv, capture: true });
  run(runnerBin, ["tools", "preview", "--config", "./synapsor.runner.json", "--store", storePath], { cwd: bundleDir, env: runnerEnv, capture: true });
  run(runnerBin, ["cloud", "connect", "--config", "./synapsor.cloud.json"], { cwd: bundleDir, env: runnerEnv, capture: true });
  run(runnerBin, ["cloud", "connect", "--config", "./synapsor.cloud.json"], { cwd: bundleDir, env: runnerEnv, capture: true });
  summary.registration = true;
  summary.registration_idempotent = true;

  const secondRunnerId = `${runnerId}_second`;
  const secondCloudConfig = structuredClone(cloudConfig);
  secondCloudConfig.cloud.runner_id = secondRunnerId;
  fs.writeFileSync(path.join(bundleDir, "synapsor.cloud.second.json"), `${JSON.stringify(secondCloudConfig, null, 2)}\n`);
  const runnerEnv2 = {
    ...runnerEnv,
    SYNAPSOR_RUNNER_ID: secondRunnerId,
    SYNAPSOR_STATE_DIR: path.join(bundleDir, ".synapsor", "worker-state-second"),
  };
  run(runnerBin, ["cloud", "connect", "--config", "./synapsor.cloud.second.json"], { cwd: bundleDir, env: runnerEnv2, capture: true });
  const runners = await controlJson(`/v1/control/projects/${encodeURIComponent(projectId)}/runners?limit=100`);
  const registeredRunners = runners.runners || [];
  const registeredRunnerIds = new Set(registeredRunners.map((runner) => runner.runner_id));
  assert(registeredRunnerIds.has(runnerId) && registeredRunnerIds.has(secondRunnerId), "both hosted E2E Runners were not durably registered");
  const connectedRunner = registeredRunners.find((runner) => runner.runner_id === runnerId);
  assert(connectedRunner?.last_seen_at && connectedRunner?.status === "online", "packed Runner registration did not produce a durable online heartbeat");
  summary.registration_heartbeat = true;

  await drainDisposableStaleJobs(runnerEnv);

  const before = await sourceSnapshot(env("SYNAPSOR_E2E_SOURCE_CHECK_SQL"));
  assertJsonEqual(before, jsonEnv("SYNAPSOR_E2E_SOURCE_BEFORE_JSON"), "synthetic source did not start in the expected state");

  const toolRun = await withMcpClient(runnerBin, bundleDir, storePath, runnerEnv, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert(!names.some((name) => /(^|[._-])(execute_sql|run_sql|raw_sql)([._-]|$)/i.test(name)), "raw SQL tool exposed through MCP");
    const read = structured(await client.callTool({ name: env("SYNAPSOR_E2E_READ_TOOL"), arguments: jsonEnv("SYNAPSOR_E2E_READ_INPUT_JSON") }));
    assert(read.ok !== false, "tenant-scoped read failed");
    rejectForbiddenValues(read);
    const denied = await deniedToolResult(client, env("SYNAPSOR_E2E_READ_TOOL"), jsonEnv("SYNAPSOR_E2E_CROSS_TENANT_READ_INPUT_JSON"));
    assert(denied.ok === false || denied.error || !hasBusinessData(denied), "cross-tenant read unexpectedly returned business data");
    rejectForbiddenValues(denied);
    const proposal = structured(await client.callTool({ name: env("SYNAPSOR_E2E_PROPOSAL_TOOL"), arguments: jsonEnv("SYNAPSOR_E2E_PROPOSAL_INPUT_JSON") }));
    assertSourceDatabaseUnchanged(proposal, "proposal did not prove the source remained unchanged before approval");
    rejectForbiddenValues(proposal);
    const proposalId = proposalIdFromResult(proposal);
    assert(proposalId, "proposal tool did not return a proposal id");
    const cloudProposal = await findCloudProposal(proposalId);
    return { proposalId, cloudProposal };
  });
  summary.scoped_read = true;
  summary.cross_tenant_denied = true;
  assertJsonEqual(await sourceSnapshot(env("SYNAPSOR_E2E_SOURCE_CHECK_SQL")), before, "proposal mutated the source before approval");
  summary.proposal_source_unchanged = true;

  const cloudProposal = toolRun.cloudProposal;
  assert(cloudProposal.source_database_mutated === false, "Cloud proposal incorrectly reports pre-approval mutation");
  assert(cloudProposal.contract_digest === contractDigest, "Cloud proposal lost the reviewed contract digest");
  assert(Array.isArray(cloudProposal.allowed_columns) && cloudProposal.allowed_columns.length > 0, "Cloud proposal has no reviewed allowed-column guard");
  assert(cloudProposal.conflict && typeof cloudProposal.conflict === "object", "Cloud proposal has no reviewed conflict guard");
  assert(cloudProposal.evidence_metadata?.payload_uploaded === false, "Cloud proposal did not preserve safe evidence metadata policy");
  assert(cloudProposal.query_audit?.payload_uploaded === false, "Cloud proposal did not preserve safe query-audit metadata policy");
  summary.proposal_reviewed_metadata = true;
  const serviceApproval = await controlFetch(`/v1/control/external-writebacks/proposals/${encodeURIComponent(toolRun.proposalId)}/approve`, {
    method: "POST",
    body: { reason: "service keys must not approve", project_id: projectId },
  });
  assert(serviceApproval.status === 403, "scoped service API key was able to record a human proposal decision");
  runJson(cliBin, [
    "proposals", "approve", toolRun.proposalId, "--project", projectId, "--api-url", baseUrl,
    "--reason", "hosted synthetic E2E review", "--yes", "--idempotency-key", `approve-${toolRun.proposalId}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  summary.cloud_approval = true;

  const competingWorkers = await Promise.all([
    runPackedWorkerOnce(runnerEnv),
    runPackedWorkerOnce(runnerEnv2),
  ]);
  assert(competingWorkers.reduce((total, completed) => total + completed, 0) === 1, "two installed Runner processes did not claim exactly one approved job");
  assert(competingWorkers.includes(0) && competingWorkers.includes(1), "exclusive claim did not produce one winner and one empty worker");
  summary.two_runner_exclusive_claim = true;
  assertJsonEqual(await sourceSnapshot(env("SYNAPSOR_E2E_SOURCE_CHECK_SQL")), jsonEnv("SYNAPSOR_E2E_SOURCE_AFTER_JSON"), "approved source result mismatch");
  summary.guarded_apply = true;
  assert(await runPackedWorkerOnce(runnerEnv) === 0, "duplicate claim produced a second source effect");
  summary.duplicate_claim_safe = true;

  const rejected = await createAndSyncProposal(runnerBin, bundleDir, storePath, runnerEnv, "SYNAPSOR_E2E_REJECT_PROPOSAL_INPUT_JSON");
  const beforeReject = await sourceSnapshot(env("SYNAPSOR_E2E_SOURCE_CHECK_SQL"));
  runJson(cliBin, [
    "proposals", "reject", rejected, "--project", projectId, "--api-url", baseUrl,
    "--reason", "hosted synthetic rejection", "--yes", "--idempotency-key", `reject-${rejected}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  assert(await runPackedWorkerOnce(runnerEnv) === 0, "rejected proposal created a claimable job");
  assertJsonEqual(await sourceSnapshot(env("SYNAPSOR_E2E_SOURCE_CHECK_SQL")), beforeReject, "rejected proposal mutated the source");
  summary.rejection_no_write = true;

  const stale = await createAndSyncProposal(runnerBin, bundleDir, storePath, runnerEnv, "SYNAPSOR_E2E_STALE_PROPOSAL_INPUT_JSON");
  await executeSourceSql(env("SYNAPSOR_E2E_STALE_MUTATION_SQL"));
  runJson(cliBin, [
    "proposals", "approve", stale, "--project", projectId, "--api-url", baseUrl,
    "--reason", "hosted synthetic stale-guard test", "--yes", "--idempotency-key", `approve-${stale}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  await runPackedWorkerUntilOne(runnerEnv, "stale-conflict proposal");
  await waitForCloudProposalStatus(stale, "conflict");
  summary.stale_conflict = true;

  const chronology = await waitForChronology(toolRun.proposalId, ["proposal.submitted", "proposal.approved", "writeback.result", "evidence.recorded", "query_audit.recorded"]);
  const eventTypes = new Set((chronology.events || []).map((event) => event.event_type));
  assert(
    ["proposal.submitted", "proposal.approved", "writeback.result", "evidence.recorded", "query_audit.recorded"].every((name) => eventTypes.has(name)),
    "Cloud chronology is missing proposal/evidence/query/decision/result linkage",
  );
  assert(chronology.integrity?.ok === true, "Cloud activity integrity chain did not verify");
  summary.activity_linked = true;
  const terminalEvent = (chronology.events || []).find((event) => event.event_type === "writeback.result");
  assert(/^sha256:[0-9a-f]{64}$/i.test(String(terminalEvent?.receipt_id || "")), "Cloud chronology has no writeback receipt hash");
  assert(String(terminalEvent?.replay_id || "").includes(toolRun.proposalId), "Cloud chronology has no proposal-linked replay reference");
  assert((chronology.events || []).some((event) => (event.evidence_ids || []).length > 0), "Cloud chronology has no evidence linkage");
  assert((chronology.events || []).some((event) => (event.query_audit_ids || []).length > 0), "Cloud chronology has no query-audit linkage");
  summary.receipt_replay_linked = true;

  const activityExport = await controlJson(`/v1/control/projects/${encodeURIComponent(projectId)}/runner-activity/${encodeURIComponent(toolRun.proposalId)}/export`);
  assert(/^sha256:[0-9a-f]{64}$/i.test(String(activityExport.export_digest || "")), "Cloud activity export has no canonical digest");
  assert(activityExport.export?.integrity?.ok === true, "Cloud activity export did not preserve integrity verification");
  rejectForbiddenValues(activityExport);
  summary.activity_exported = true;

  const widenedContract = structuredClone(contract);
  const widenedCapability = (widenedContract.capabilities || []).find((capability) => Array.isArray(capability.visible_fields));
  assert(widenedCapability, "hosted E2E contract has no capability suitable for semantic-diff verification");
  widenedCapability.visible_fields = [...new Set([...widenedCapability.visible_fields, "hosted_e2e_review_marker"])];
  const staged = await controlJson(`/v1/control/projects/${encodeURIComponent(projectId)}/agent-contracts`, {
    method: "POST",
    body: {
      schema_version: "synapsor.cloud-contract-push.v0.1",
      contract: widenedContract,
      workspace: projectId,
      name: String(contract?.metadata?.name || "hosted-runner-e2e"),
      source: "hosted-e2e-governance",
      source_versions: { "@synapsor/runner": "packed-e2e" },
      activate: false,
      idempotency_key: `hosted-e2e-governance-${digest(widenedContract).slice(7, 23)}`,
      pushed_at: new Date().toISOString(),
    },
  });
  const stagedVersionId = String(staged.contract_version_id || staged.version?.contract_version_id || "");
  assert(staged.contract_id === contractId && stagedVersionId, "staged contract version did not stay in the original registry lineage");
  assert(staged.version?.risk_increasing === true, "visible-field widening was not classified as risk-increasing");
  assert((staged.version?.semantic_diff?.changes || []).some((change) => change.change === "visible_fields_widened"), "semantic diff omitted visible-field widening");
  const missingReason = await controlFetch(
    `/v1/control/projects/${encodeURIComponent(projectId)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(stagedVersionId)}/activate`,
    { method: "POST", body: {} },
  );
  const missingReasonPayload = await missingReason.json().catch(() => ({}));
  assert(missingReason.status === 400 && missingReasonPayload.error === "agent_contract_activation_reason_required", "risk-increasing activation did not require a human reason");
  const activated = runJson(cliBin, [
    "contracts", "activate", `${contractId}/${stagedVersionId}`, "--project", projectId, "--api-url", baseUrl,
    "--reason", "hosted synthetic semantic-diff review", "--yes", "--idempotency-key", `activate-${stagedVersionId}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  assert(activated.contract?.active_version_id === stagedVersionId, "reviewed contract version was not activated");
  const rolledBack = runJson(cliBin, [
    "contracts", "rollback", `${contractId}/${versionId}`, "--project", projectId, "--api-url", baseUrl,
    "--reason", "hosted synthetic rollback proof", "--yes", "--idempotency-key", `rollback-${versionId}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
  assert(rolledBack.contract?.active_version_id === versionId, "contract rollback did not restore the original version");
  summary.contract_governance = true;

  await revokeToken();
  const revokedDoctor = await new (await import("../packages/control-plane-client/dist/index.js")).ControlPlaneClient({ baseUrl, runnerToken, sourceId, runnerId }).doctor();
  assert(!revokedDoctor.ok, "revoked Runner token remained usable");
  const terminalJobId = String(chronology.job?.job_id || cloudProposal.writeback_job_id || "");
  assert(terminalJobId, "hosted E2E could not identify the terminal writeback job for revocation checks");
  const revokedRequests = await Promise.all([
    runnerJson("/v1/runner/register", runnerToken, {
      schema_version: "synapsor.runner-registration.v1",
      protocol_version: "synapsor.runner-control.v1",
      runner_id: runnerId,
      runner_version: "hosted-e2e",
      engines: [engine],
      capabilities: ["writeback-v2"],
      scope: { project_id: projectId, source_ids: [sourceId] },
      registered_at: new Date().toISOString(),
    }),
    runnerJson("/v1/writeback/jobs/claim", runnerToken, { runner_id: runnerId, source_id: sourceId, limit: 1 }),
    runnerJson(`/v1/writeback/jobs/${encodeURIComponent(terminalJobId)}/result`, runnerToken, {}),
  ]);
  assert(revokedRequests.every((response) => !response.ok && [401, 403].includes(response.status)), "revoked Runner token could still register, claim, or submit a result");
  summary.token_revoked = true;
  summary.revoked_operations_blocked = true;

  await revokeServiceApiKey();
  summary.service_api_key_revoked = true;

  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (runnerToken && tokenId && !summary.token_revoked) await revokeToken().catch(() => undefined);
  if (serviceApiKey && serviceApiKeyId && !summary.service_api_key_revoked) await revokeServiceApiKey().catch(() => undefined);
  if (!flag("SYNAPSOR_E2E_KEEP_TEMP")) fs.rmSync(tempDir, { recursive: true, force: true });
}

async function createAndSyncProposal(bin, cwd, localStore, runnerEnv, inputEnvName) {
  return withMcpClient(bin, cwd, localStore, runnerEnv, async (client) => {
    const result = structured(await client.callTool({
      name: env("SYNAPSOR_E2E_PROPOSAL_TOOL"),
      arguments: jsonEnv(inputEnvName),
    }));
    const proposalId = proposalIdFromResult(result);
    assert(proposalId, `${inputEnvName} did not produce a proposal id: ${redact(JSON.stringify(result)).slice(0, 800)}`);
    assertSourceDatabaseUnchanged(result, `${proposalId} did not prove the source remained unchanged before approval`);
    await findCloudProposal(proposalId);
    return proposalId;
  });
}

async function withMcpClient(bin, cwd, localStore, runnerEnv, callback) {
  const transport = new StdioClientTransport({
    command: bin,
    args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", localStore],
    cwd,
    env: runnerEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "synapsor-hosted-e2e", version: "1.0.0" });
  await client.connect(transport);
  transport.stderr?.on("data", () => undefined);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function deniedToolResult(client, name, input) {
  try {
    return structured(await client.callTool({ name, arguments: input }));
  } catch (error) {
    return { error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

function bindBundleDatabaseEnvironment(target, config) {
  const sources = config?.sources && typeof config.sources === "object" ? Object.values(config.sources) : [];
  assert(sources.length > 0, "Runner bundle contains no source configuration");
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const readEnv = String(source.read_url_env || "").trim();
    const writeEnv = String(source.write_url_env || "").trim();
    assert(/^[A-Z_][A-Z0-9_]*$/.test(readEnv), "Runner bundle contains an invalid read_url_env");
    target[readEnv] = env("SYNAPSOR_DATABASE_READ_URL");
    if (writeEnv) {
      assert(/^[A-Z_][A-Z0-9_]*$/.test(writeEnv), "Runner bundle contains an invalid write_url_env");
      target[writeEnv] = env("SYNAPSOR_DATABASE_WRITE_URL");
    }
  }
}

async function findCloudProposal(proposalId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await controlJson(`/v1/control/external-writebacks/proposals?project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&limit=100`);
    const proposal = (response.proposals || []).find((item) => item.proposal_id === proposalId);
    if (proposal) {
      rejectForbiddenValues(proposal);
      return proposal;
    }
    await sleep(250);
  }
  throw new Error(`Cloud proposal ${proposalId} was not delivered by the durable outbox`);
}

async function waitForCloudProposalStatus(proposalId, expectedStatus) {
  let lastStatus = "not_found";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await controlJson(`/v1/control/external-writebacks/proposals?project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&limit=100`);
    const proposal = (response.proposals || []).find((item) => item.proposal_id === proposalId);
    if (proposal) {
      rejectForbiddenValues(proposal);
      lastStatus = String(proposal.status || "unknown");
      if (lastStatus === expectedStatus) return proposal;
    }
    await sleep(250);
  }
  throw new Error(`Cloud proposal ${proposalId} did not reach ${expectedStatus}; last status was ${lastStatus}`);
}

async function waitForChronology(proposalId, requiredEvents) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const chronology = await controlJson(`/v1/control/projects/${encodeURIComponent(projectId)}/runner-activity/${encodeURIComponent(proposalId)}`);
    const eventTypes = new Set((chronology.events || []).map((event) => event.event_type));
    if (requiredEvents.every((event) => eventTypes.has(event))) return chronology;
    await sleep(250);
  }
  throw new Error(`Cloud chronology ${proposalId} did not receive all automatic activity/result events`);
}

async function revokeToken() {
  runJson(cliBin, [
    "runners", "revoke-token", tokenId, "--project", projectId, "--api-url", baseUrl,
    "--yes", "--idempotency-key", `revoke-runner-${tokenId}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
}

async function revokeServiceApiKey() {
  runJson(cliBin, [
    "api-keys", "revoke", serviceApiKeyId, "--project", projectId, "--api-url", baseUrl,
    "--yes", "--idempotency-key", `revoke-service-${serviceApiKeyId}`, "--json",
  ], { cwd: installDir, env: humanCliEnv });
}

async function runnerDoctor(token) {
  const response = await fetch(`${baseUrl}/v1/writeback/runner/doctor`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({})),
  };
}

async function runnerJson(route, token, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({})),
  };
}

async function runPackedWorkerOnce(workerEnv) {
  const result = await spawnCapture(
    runnerBin,
    ["runner", "start", "--once", "--config", "./synapsor.runner.json", "--store", storePath],
    { cwd: bundleDir, env: workerEnv },
  );
  const match = result.stdout.match(/Cloud worker completed (\d+) job\(s\)\./);
  assert(match, "installed Runner worker did not report its bounded completion count");
  const completed = Number(match[1]);
  assert(Number.isSafeInteger(completed) && completed >= 0 && completed <= 1, "installed Runner worker reported an invalid completion count");
  return completed;
}

async function runPackedWorkerUntilOne(workerEnv, label) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const completed = await runPackedWorkerOnce(workerEnv);
    if (completed === 1) return;
    await sleep(250);
  }
  throw new Error(`installed Runner worker did not claim the ${label} within the bounded retry window`);
}

async function drainDisposableStaleJobs(workerEnv) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await spawnCapture(
      runnerBin,
      ["runner", "start", "--once", "--config", "./synapsor.runner.json", "--store", storePath],
      { cwd: bundleDir, env: workerEnv },
    );
    const match = result.stdout.match(/Cloud worker completed (\d+) job\(s\)\./);
    assert(match, "disposable-project stale-job drain did not report its bounded completion count");
    const completed = Number(match[1]);
    const rejectedWithoutLocalAuthority = result.stderr.includes("LOCAL_AUTHORITY_REJECTED");
    if (!rejectedWithoutLocalAuthority) {
      assert(completed === 0, "disposable-project stale-job drain unexpectedly applied a source effect");
      return;
    }
    assert(completed === 0, "a stale Cloud job without local reviewed authority reported a source effect");
  }
  throw new Error("disposable-project stale-job drain exceeded its 20-job safety bound");
}

async function sourceSnapshot(sql) {
  return executeSourceSql(sql, { returnRows: true, connectionUrl: env("SYNAPSOR_DATABASE_READ_URL") });
}

async function executeSourceSql(sql, options = {}) {
  const connectionUrl = options.connectionUrl || env("SYNAPSOR_DATABASE_WRITE_URL");
  if (engine === "postgres") {
    const { Client: PgClient } = require(path.join(root, "packages", "postgres", "node_modules", "pg"));
    const client = new PgClient({ connectionString: connectionUrl });
    await client.connect();
    try {
      const result = await client.query(sql);
      return options.returnRows ? result.rows : undefined;
    } finally {
      await client.end();
    }
  }
  const mysql = require(path.join(root, "packages", "mysql", "node_modules", "mysql2", "promise"));
  const connection = await mysql.createConnection({ uri: connectionUrl, dateStrings: true });
  try {
    const [rows] = await connection.query(sql);
    return options.returnRows ? rows : undefined;
  } finally {
    await connection.end();
  }
}

async function publicJson(route) {
  const response = await fetch(`${baseUrl}${route}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`public request ${route} failed with HTTP ${response.status}`);
  return payload;
}

async function controlFetch(route, init = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${serviceApiKey}`,
      "X-Synapsor-Credential-Kind": "service",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function controlJson(route, init = {}) {
  const response = await controlFetch(route, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(`control request ${route} failed: ${String(payload.error || `http_${response.status}`)}`);
  return payload;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const output = redact(`${result.stdout || ""}\n${result.stderr || ""}`);
    throw new Error(`${path.basename(command)} failed with code ${result.status}: ${output.slice(0, 1200)}`);
  }
  return result;
}

function runJson(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  const stdout = String(result.stdout || "").trim();
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(stdout.slice(start, end + 1));
    throw new Error(`${path.basename(command)} did not emit JSON: ${redact(stdout).slice(0, 600)}`);
  }
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} failed with code ${code}: ${redact(`${stdout}\n${stderr}`).slice(0, 1200)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no structured result");
  return JSON.parse(text);
}

function rejectForbiddenValues(value) {
  const serialized = JSON.stringify(value);
  const forbidden = jsonEnv("SYNAPSOR_E2E_FORBIDDEN_VALUES_JSON", []);
  for (const item of forbidden) {
    if (typeof item === "string" && item && serialized.includes(item)) throw new Error("kept-out/cross-tenant fixture value appeared in a Cloud or MCP response");
  }
  for (const secret of [humanAccessToken, serviceApiKey, ...runnerTokens, process.env.SYNAPSOR_DATABASE_READ_URL, process.env.SYNAPSOR_DATABASE_WRITE_URL]) {
    if (secret && serialized.includes(secret)) throw new Error("secret appeared in a response payload");
  }
}

function assertBundleIsCredentialFree(directory, secrets) {
  for (const file of walk(directory)) {
    if (!fs.statSync(file).isFile()) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const secret of secrets) if (secret && content.includes(secret)) throw new Error(`bundle leaked a credential into ${path.relative(directory, file)}`);
    if (/(?:postgres(?:ql)?|mysql):\/\/[^\s:@]+:[^\s@]+@/i.test(content)) throw new Error(`bundle contains an embedded database credential in ${path.relative(directory, file)}`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) throw new Error(`bundle contains a private key in ${path.relative(directory, file)}`);
  }
}

function* walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    yield file;
    if (fs.statSync(file).isDirectory()) yield* walk(file);
  }
}

function recursiveFind(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = recursiveFind(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function proposalIdFromResult(value) {
  const legacyId = recursiveFind(value, "proposal_id");
  if (legacyId !== undefined) return String(legacyId);
  const proposal = value?.proposal;
  return proposal && typeof proposal === "object" && typeof proposal.id === "string" ? proposal.id : "";
}

function assertSourceDatabaseUnchanged(value, message) {
  const signals = [
    recursiveFind(value, "source_database_changed"),
    recursiveFind(value, "source_database_mutated"),
  ].filter((candidate) => typeof candidate === "boolean");
  assert(signals.length > 0 && signals.every((candidate) => candidate === false), message);
}

function hasBusinessData(value) {
  const data = recursiveFind(value, "data");
  return Boolean(data && typeof data === "object" && Object.keys(data).length);
}

function assertJsonEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function jsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function flag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function redact(value) {
  let output = String(value || "");
  for (const secret of [humanAccessToken, serviceApiKey, ...runnerTokens, process.env.SYNAPSOR_DATABASE_READ_URL, process.env.SYNAPSOR_DATABASE_WRITE_URL]) {
    if (secret) output = output.split(secret).join("<redacted>");
  }
  return output.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "<redacted-database-url>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Opt-in hosted OSS Runner <-> Synapsor Cloud release gate.

This verifier installs packed/published Cloud CLI and Runner packages in a
clean temp directory and uses only a disposable project and synthetic
Postgres/MySQL data. It verifies human whoami, creates a scoped service key,
proves CLI/Runner push parity, rotates a source-scoped token, downloads a bundle,
registers two Runners, invokes scoped MCP read/proposal tools, exercises Cloud
approval/rejection, runs the packed Runner worker against an exclusive job
lease, proves duplicate/stale safety, verifies activity export and contract
activation/rollback, and revokes the token. It never prints tokens or database
URLs.

Safety switches (both required):
  SYNAPSOR_HOSTED_E2E=1
  SYNAPSOR_E2E_DISPOSABLE_PROJECT=1

Identity and package:
  SYNAPSOR_CLOUD_BASE_URL=https://dev-api.synapsor.ai
  SYNAPSOR_CLOUD_ACCESS_TOKEN=<signed-in human session; read from a secret prompt>
  SYNAPSOR_PROJECT_ID=<disposable project>
  SYNAPSOR_SOURCE_ID=<synthetic imported source>
  SYNAPSOR_RUNNER_PACKAGE_SPEC=/absolute/path/to/runner.tgz   # preferred prepublish
  SYNAPSOR_CLI_PACKAGE_SPEC=/absolute/path/to/cli.tgz         # preferred prepublish

Contract/MCP fixture:
  SYNAPSOR_E2E_CONTRACT_PATH
  SYNAPSOR_E2E_READ_TOOL
  SYNAPSOR_E2E_READ_INPUT_JSON
  SYNAPSOR_E2E_CROSS_TENANT_READ_INPUT_JSON
  SYNAPSOR_E2E_PROPOSAL_TOOL
  SYNAPSOR_E2E_PROPOSAL_INPUT_JSON
  SYNAPSOR_E2E_REJECT_PROPOSAL_INPUT_JSON
  SYNAPSOR_E2E_STALE_PROPOSAL_INPUT_JSON
  SYNAPSOR_E2E_FORBIDDEN_VALUES_JSON=<JSON string array>

Synthetic source assertions:
  SYNAPSOR_DATABASE_READ_URL
  SYNAPSOR_DATABASE_WRITE_URL
  SYNAPSOR_TENANT_ID
  SYNAPSOR_PRINCIPAL
  SYNAPSOR_E2E_SOURCE_CHECK_SQL=<single SELECT returning the reviewed row(s)>
  SYNAPSOR_E2E_SOURCE_BEFORE_JSON=<exact JSON row array>
  SYNAPSOR_E2E_SOURCE_AFTER_JSON=<exact JSON row array after first approval>
  SYNAPSOR_E2E_STALE_MUTATION_SQL=<synthetic out-of-band version change>

Use a shell prompt or secret manager for token/URL values. Do not put them in
Git, command-line arguments, or the generated bundle.`);
}
