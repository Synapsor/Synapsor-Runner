#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { serveStdio } from "@synapsor-runner/mcp-server";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";
import { parseWritebackJob, protocolVersions, type RunnerRegistrationV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import {
  auditMcpManifest,
  createLogger,
  doctorChecks,
  formatMcpAuditReport,
  loadConfig,
  startPolling,
  type RunnerConfig,
} from "@synapsor-runner/worker-core";

const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "init") return init(rest);
  if (command === "doctor") return doctor();
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "start") return start();
  if (command === "runner") return runnerCommand(rest);
  if (command === "cloud") return cloud(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "proposals") return proposals(rest);
  if (command === "replay") return replay(rest);
  usage();
  return 2;
}

async function init(args: string[]): Promise<number> {
  const output = optionalArg(args, "--output") ?? "synapsor.runner.json";
  const engine = optionalArg(args, "--engine") ?? "postgres";
  const mode = optionalArg(args, "--mode") ?? "review";
  if (engine !== "postgres" && engine !== "mysql") {
    throw new Error("init --engine must be postgres or mysql");
  }
  if (!["read_only", "shadow", "review", "cloud"].includes(mode)) {
    throw new Error("init --mode must be read_only, shadow, review, or cloud");
  }
  const resolved = path.resolve(output);
  if (!args.includes("--force")) {
    try {
      await fs.access(resolved);
      throw new Error(`${output} already exists. Use --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const config = mode === "cloud" ? starterCloudConfig() : starterLocalConfig(engine, mode);
  await fs.writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stdout.write(`created ${output}\n`);
  process.stdout.write("Edit table/column names and set the referenced environment variables before serving MCP tools.\n");
  return 0;
}

async function doctor(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);
  const report = await doctorChecks(config, adapters[config.engine]);
  logger.info("doctor checks", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

async function validate(args: string[]): Promise<number> {
  const job = await readJob(args);
  parseWritebackJob(job);
  process.stdout.write("job valid\n");
  return 0;
}

async function apply(args: string[]): Promise<number> {
  const raw = await readJob(args);
  const job = parseWritebackJob(raw);
  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const config: RunnerConfig = {
    controlPlaneUrl: process.env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: process.env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: process.env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: process.env.SYNAPSOR_SOURCE_ID || job.source_id,
    databaseUrl: process.env.SYNAPSOR_DATABASE_URL || "",
    engine: job.engine,
    pollIntervalMs: Number(process.env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    logLevel: (process.env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: process.env.SYNAPSOR_STATE_DIR || "./state"
  };
  const result = await adapters[job.engine].apply(job, config);
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  if (storePath) {
    if (storePath !== ":memory:") {
      await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
    }
    const store = new ProposalStore(storePath);
    try {
      store.recordExecutionReceipt(toExecutionReceipt(job, result, config.dryRun));
    } finally {
      store.close();
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "failed" ? 1 : 0;
}

async function start(): Promise<number> {
  const config = loadConfig();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await startPolling(config, adapters, controller.signal);
  return 0;
}

async function runnerCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "start") return start();
  if (subcommand === "doctor") return doctor();
  usage();
  return 2;
}

async function cloud(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "connect") return cloudConnect(rest);
  usage();
  return 2;
}

async function cloudConnect(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG ?? "synapsor.cloud.json";
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    cloud?: {
      base_url_env?: string;
      runner_token_env?: string;
      runner_id?: string;
      runner_version?: string;
      project_id?: string;
      source_id?: string;
      engines?: string[];
      capabilities?: string[];
    };
  };
  if (!parsed.cloud) {
    process.stdout.write(`cloud config missing in ${configPath}\n`);
    return 1;
  }
  const baseUrlEnv = parsed.cloud.base_url_env || "SYNAPSOR_CLOUD_BASE_URL";
  const tokenEnv = parsed.cloud.runner_token_env || "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = process.env[baseUrlEnv];
  const runnerToken = process.env[tokenEnv];
  const missing = [baseUrl ? "" : baseUrlEnv, runnerToken ? "" : tokenEnv].filter(Boolean);
  if (missing.length > 0) {
    process.stdout.write(`missing environment variables: ${missing.join(", ")}\n`);
    return 1;
  }
  if (!baseUrl || !runnerToken) {
    process.stdout.write("missing Cloud connection settings\n");
    return 1;
  }
  const sourceId = String(parsed.cloud.source_id || process.env.SYNAPSOR_SOURCE_ID || "").trim();
  if (!sourceId || sourceId === "src_replace_me") {
    process.stdout.write("cloud.source_id is required before registering a runner. It must match the scoped Cloud runner token source.\n");
    return 1;
  }
  const runnerId = String(parsed.cloud.runner_id || process.env.SYNAPSOR_RUNNER_ID || "synapsor_runner_local").trim();
  const runnerVersion = String(parsed.cloud.runner_version || process.env.npm_package_version || "0.1.0-alpha.0").trim();
  const engines = normalizeEngines(parsed.cloud.engines);
  const capabilities = normalizeCapabilities(parsed.cloud.capabilities);
  const client = new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId,
  });
  const report = await client.doctor();
  if (!report.ok) {
    process.stdout.write(`cloud connection failed: status ${report.status}\n`);
    return 1;
  }
  const registration: RunnerRegistrationV1 = {
    schema_version: protocolVersions.runnerRegistration,
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    capabilities,
    scope: {
      project_id: String(parsed.cloud.project_id || "token_scope"),
      source_ids: [sourceId],
    },
    registered_at: new Date().toISOString(),
  };
  await client.register(registration);
  await client.runnerHeartbeat({
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    source_ids: [sourceId],
    status: "online",
    details: {
      mode: "cloud_connect",
      database_credentials_sent: false,
      adapter_catalog_supported: true,
      writeback_supported: true,
    },
  });
  process.stdout.write(`cloud connection ok for ${sourceId}\n`);
  process.stdout.write(`registered runner ${runnerId}\n`);
  process.stdout.write("sent metadata: runner id/version, engines, capabilities, and source id. Database URLs and credentials were not sent.\n");
  return 0;
}

async function mcp(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "serve") return mcpServe(rest);
  if (subcommand === "audit") return mcpAudit(rest);
  usage();
  return 2;
}

async function mcpServe(args: string[]): Promise<number> {
  await serveStdio({
    configPath: optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG,
    storePath: optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE,
  });
  return 0;
}

async function mcpAudit(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    throw new Error("mcp audit requires <target>");
  }
  const manifest = JSON.parse(await fs.readFile(target, "utf8"));
  const report = auditMcpManifest(manifest, { target });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatMcpAuditReport(report));
  return 0;
}

async function proposals(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return proposalsList(rest);
  if (subcommand === "show") return proposalsShow(rest);
  if (subcommand === "approve") return proposalsApprove(rest);
  if (subcommand === "reject") return proposalsReject(rest);
  if (subcommand === "writeback-job") return proposalsWritebackJob(rest);
  usage();
  return 2;
}

async function replay(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "show") return replayShow(rest);
  if (subcommand === "export") return replayExport(rest);
  usage();
  return 2;
}

async function proposalsList(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const state = optionalArg(args, "--state") as LocalProposalState | undefined;
    const rows = store.listProposals(state);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ proposals: rows }, null, 2)}\n`);
      return 0;
    }
    if (rows.length === 0) {
      process.stdout.write("No proposals found.\n");
      return 0;
    }
    for (const proposal of rows) {
      process.stdout.write(formatProposalSummary(proposal));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const payload = { proposal, events: store.events(proposalId), receipts: store.receipts(proposalId) };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(formatProposalDetail(proposal));
      for (const event of payload.events) {
        process.stdout.write(`event ${event.event_id}: ${event.kind} by ${event.actor} at ${event.created_at}\n`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsApprove(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals approve requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Approve proposal ${proposalId} for guarded writeback?`);
    const updated = store.approveProposal(proposalId, {
      approver: optionalArg(args, "--actor") ?? process.env.USER ?? "local_operator",
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason: optionalArg(args, "--reason") ?? undefined,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : `approved ${updated.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsReject(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals reject requires <proposal_id>");
  const reason = optionalArg(args, "--reason");
  if (!reason) throw new Error("proposals reject requires --reason <text>");
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Reject proposal ${proposalId}?`);
    const updated = store.rejectProposal(proposalId, {
      actor: optionalArg(args, "--actor") ?? process.env.USER ?? "local_operator",
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : `rejected ${updated.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsWritebackJob(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals writeback-job requires <proposal_id>");
  const output = optionalArg(args, "--output");
  const store = await openLocalStore(args);
  try {
    const job = store.createWritebackJobFromProposal(proposalId, {
      project_id: optionalArg(args, "--project") ?? "local",
      runner_id: optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner",
      lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
    });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    if (output) {
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, text, "utf8");
      process.stdout.write(`created writeback job ${job.writeback_job_id} for ${proposalId} at ${output}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function replayShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("replay show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const replayRecord = store.replay(proposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(replayRecord, null, 2)}\n`);
    } else {
      process.stdout.write(`Replay ${replayRecord.replay_id}\n`);
      process.stdout.write(formatProposalDetail(replayRecord.proposal));
      process.stdout.write(`events: ${replayRecord.events.length}\n`);
      process.stdout.write(`receipts: ${replayRecord.receipts.length}\n`);
      process.stdout.write(`evidence bundles: ${replayRecord.evidence.length}\n`);
      process.stdout.write(`query audit records: ${replayRecord.query_audit.length}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function replayExport(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("replay export requires <proposal_id>");
  const output = optionalArg(args, "--output");
  if (!output) throw new Error("replay export requires --output <path>");
  const store = await openLocalStore(args);
  try {
    const replayRecord = store.replay(proposalId);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(replayRecord, null, 2)}\n`, "utf8");
    process.stdout.write(`exported ${replayRecord.replay_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function openLocalStore(args: string[]): Promise<ProposalStore> {
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  if (storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  return new ProposalStore(storePath);
}

function requireLocalProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}

async function confirmDangerousAction(args: string[], question: string): Promise<void> {
  if (args.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    throw new Error("approval/rejection requires --yes in noninteractive mode");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("confirmation declined");
    }
  } finally {
    rl.close();
  }
}

function optionalArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[], index: number): string | undefined {
  return args.filter((arg, argIndex) => {
    if (arg.startsWith("--")) return false;
    const previous = args[argIndex - 1];
    return previous === undefined || !previous.startsWith("--");
  })[index];
}

function formatProposalSummary(proposal: StoredProposal): string {
  return [
    `${proposal.proposal_id}  ${proposal.state}  ${proposal.action}`,
    `  target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `  tenant: ${proposal.tenant_id}  source changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}

function formatProposalDetail(proposal: StoredProposal): string {
  const changeSet = proposal.change_set;
  const conflictGuard = changeSet.guards.expected_version;
  const evidenceItems = changeSet.evidence.items?.length ?? 0;
  return [
    `proposal: ${proposal.proposal_id}`,
    `state: ${proposal.state}`,
    `action: ${proposal.action}`,
    `principal: ${changeSet.principal.id} (${changeSet.principal.source})`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `primary key: ${changeSet.source.primary_key.column}=${formatScalar(changeSet.source.primary_key.value)}`,
    `approval: ${changeSet.approval.status}${changeSet.approval.required_role ? ` required role ${changeSet.approval.required_role}` : ""}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `allowed columns: ${changeSet.guards.allowed_columns.join(", ")}`,
    `conflict guard: ${conflictGuard.column || "none"}=${formatScalar(conflictGuard.value)}`,
    `evidence: ${changeSet.evidence.bundle_id}  query ${changeSet.evidence.query_fingerprint}  items ${evidenceItems}`,
    `writeback: ${changeSet.writeback.status} via ${changeSet.writeback.mode}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    "diff:",
    ...Object.keys(changeSet.patch).map((column) => {
      const before = changeSet.before[column as keyof typeof changeSet.before];
      const proposed = changeSet.after[column as keyof typeof changeSet.after];
      return `  ${column}: ${JSON.stringify(before)} -> ${JSON.stringify(proposed)}`;
    }),
  ].join("\n") + "\n";
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function toExecutionReceipt(job: WritebackJob, result: WritebackResult, dryRun: boolean): Record<string, unknown> {
  const affectedRows = result.affected_rows ?? 0;
  const terminalStatus = result.status === "applied" && !dryRun && affectedRows === 0 ? "already_applied" : result.status;
  const previousVersion = job.conflict_guard.kind === "version_column" ? job.conflict_guard.expected_value : undefined;
  const receiptHash = typeof result.result_hash === "string" && result.result_hash.startsWith("sha256:")
    ? result.result_hash
    : `sha256:${crypto.createHash("sha256").update(JSON.stringify({
      job_id: job.job_id,
      status: terminalStatus,
      affected_rows: affectedRows,
      error_code: result.error_code ?? null,
    })).digest("hex")}`;
  return {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: job.job_id,
    proposal_id: job.proposal_id,
    runner_id: result.runner_id,
    status: terminalStatus,
    rows_affected: affectedRows,
    idempotency_key: job.idempotency_key,
    previous_version: previousVersion,
    new_version: result.result_version,
    source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
    executed_at: result.completed_at ?? new Date().toISOString(),
    safe_error_code: result.error_code,
    receipt_hash: receiptHash,
  };
}

async function readJob(args: string[]): Promise<unknown> {
  const index = args.indexOf("--job");
  const jobPath = index >= 0 ? args[index + 1] : undefined;
  if (!jobPath) {
    throw new Error("--job <path> is required");
  }
  return JSON.parse(await fs.readFile(jobPath, "utf8"));
}

function starterLocalConfig(engine: "postgres" | "mysql", mode: string): Record<string, unknown> {
  const sourceName = engine === "postgres" ? "app_postgres" : "app_mysql";
  const readUrlEnv = engine === "postgres" ? "APP_POSTGRES_READ_URL" : "APP_MYSQL_READ_URL";
  const writeUrlEnv = engine === "postgres" ? "APP_POSTGRES_WRITE_URL" : "APP_MYSQL_WRITE_URL";
  return {
    version: 1,
    mode,
    storage: {
      sqlite_path: "./.synapsor/local.db",
    },
    sources: {
      [sourceName]: {
        engine,
        read_url_env: readUrlEnv,
        write_url_env: writeUrlEnv,
        statement_timeout_ms: 3000,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
    },
    capabilities: [
      {
        name: "records.inspect_record",
        kind: "read",
        source: sourceName,
        target: {
          schema: engine === "postgres" ? "public" : "app",
          table: "records",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          record_id: {
            type: "string",
            required: true,
            max_length: 128,
          },
        },
        lookup: {
          id_from_arg: "record_id",
        },
        visible_columns: ["id", "tenant_id", "updated_at"],
        evidence: "required",
        max_rows: 1,
      },
    ],
  };
}

function starterCloudConfig(): Record<string, unknown> {
  return {
    version: 1,
    mode: "cloud",
    storage: {
      sqlite_path: "./.synapsor/local.db",
    },
    trusted_context: {
      provider: "cloud_session",
    },
    cloud: {
      base_url_env: "SYNAPSOR_CLOUD_BASE_URL",
      runner_token_env: "SYNAPSOR_RUNNER_TOKEN",
      runner_id: "synapsor_runner_local",
      runner_version: "0.1.0-alpha.0",
      project_id: "token_scope",
      adapter_id: "mcp.billing",
      source_id: "src_replace_me",
      engines: ["postgres", "mysql"],
      capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
      session: {},
    },
  };
}

function normalizeEngines(value: unknown): Array<"postgres" | "mysql"> {
  const requested = Array.isArray(value) ? value.map((engine) => String(engine).trim().toLowerCase()) : [];
  const engines = requested.filter((engine): engine is "postgres" | "mysql" => engine === "postgres" || engine === "mysql");
  return engines.length > 0 ? engines : ["postgres", "mysql"];
}

function normalizeCapabilities(value: unknown): string[] {
  const defaults = ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"];
  const capabilities = Array.isArray(value) ? value.map((capability) => String(capability).trim()).filter(Boolean) : [];
  return capabilities.length > 0 ? capabilities : defaults;
}

function usage(): void {
  process.stdout.write(`synapsor-runner

Commands:
  init [--engine postgres|mysql] [--mode read_only|shadow|review|cloud] [--output synapsor.runner.json] [--force]
  doctor
  validate --job ./job.json
  apply --job ./job.json [--dry-run] [--store ./.synapsor/local.db]
  start
  runner start
  runner doctor
  cloud connect [--config ./synapsor.cloud.json]
  mcp serve [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  mcp audit ./tools-list.json [--json]
  proposals list [--store ./.synapsor/local.db] [--state pending_review] [--json]
  proposals show <proposal_id> [--store ./.synapsor/local.db] [--json]
  proposals approve <proposal_id> [--store ./.synapsor/local.db] [--actor local_user] [--yes]
  proposals reject <proposal_id> --reason "..." [--store ./.synapsor/local.db] [--yes]
  proposals writeback-job <proposal_id> [--store ./.synapsor/local.db] [--project local] [--runner local_runner] [--output job.json]
  replay show <proposal_id> [--store ./.synapsor/local.db] [--json]
  replay export <proposal_id> --output replay.json [--store ./.synapsor/local.db]
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
