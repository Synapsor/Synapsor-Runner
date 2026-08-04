import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  capabilityWritebackExecutor,
  capabilityWritebackMode,
  validateFreshnessAuthorityAgainstCurrentConfig,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import { createPostgresPool } from "@synapsor-runner/postgres";
import {
  PostgresWritebackIntentStore,
  ProposalStore,
  type StoredProposal
} from "@synapsor-runner/proposal-store";
import { parseFreshnessAuthority, parseFreshnessProof, parseWritebackJob, protocolVersions, type ExecutionReceiptV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import {
  type RunnerConfig,
  type WritebackIntentStore
} from "@synapsor-runner/worker-core";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord } from "./cli-format.js";
import { operationalLog } from "./cli-logging.js";
import { envValue, splitCommand, trimmedEnvValue } from "./cli-options.js";
import { readRuntimeConfig, redactConfig } from "./cli-project.js";
import { adapters } from "./cli-runtime.js";
import { trustedCliContext } from "./operator-authority.js";
import { verifyJwtOperatorProof, verifySignedOperatorProof } from "./operator-identity.js";
import { hashReceipt, runnerReceiptConfig, toExecutionReceipt, writebackDatabaseScope, writebackTimeoutMs } from "./writeback-domain.js";

const handlerReceiptStatuses = new Set(["applied", "already_applied", "conflict", "failed"]);


export async function applySqlJob(job: unknown, configPath: string, storePath: string | undefined, dryRun: boolean, env: NodeJS.ProcessEnv = process.env): Promise<WritebackResult> {
  const parsedJob = parseWritebackJob(job);
  await verifyLocalWritebackAuthority(parsedJob, configPath, storePath);
  const runtimeConfig = await readRuntimeConfig(configPath);
  const databaseUrl = await resolveSqlWriteDatabaseUrl(parsedJob, configPath, env);
  const store = storePath ? new ProposalStore(storePath) : undefined;
  const config: RunnerConfig = {
    controlPlaneUrl: env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: env.SYNAPSOR_SOURCE_ID || parsedJob.source_id,
    databaseUrl,
    engine: parsedJob.engine,
    pollIntervalMs: Number(env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    statementTimeoutMs: writebackTimeoutMs(runtimeConfig.sources?.[parsedJob.source_id], env),
    logLevel: (env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: env.SYNAPSOR_STATE_DIR || "./state",
    receipts: runnerReceiptConfig(runtimeConfig.sources?.[parsedJob.source_id]),
    databaseScope: writebackDatabaseScope(
      runtimeConfig.sources?.[parsedJob.source_id],
      store?.getProposal(parsedJob.proposal_id),
      parsedJob,
    ),
  };
  const intentAuthority = createWritebackIntentAuthority(runtimeConfig, parsedJob.source_id, env, store);
  if (config.receipts?.authority === "runner_ledger" && !intentAuthority.store) throw new Error("runner_ledger receipt authority requires --store or an authoritative shared runtime store");
  if (intentAuthority.store) config.writebackIntentStore = intentAuthority.store;
  try {
    const result = await adapters[parsedJob.engine].apply(parsedJob, config);
    store?.recordExecutionReceipt(toExecutionReceipt(parsedJob, result, config.dryRun));
    return result;
  } finally {
    await intentAuthority.close();
    store?.close();
  }
}


export function createWritebackIntentAuthority(
  config: RuntimeConfig | undefined,
  sourceId: string,
  env: NodeJS.ProcessEnv,
  localStore: ProposalStore | undefined,
): { store?: WritebackIntentStore; close(): Promise<void> } {
  if (runnerReceiptConfig(config?.sources?.[sourceId])?.authority !== "runner_ledger") return { close: async () => undefined };
  const shared = config?.storage?.shared_postgres;
  if (shared?.mode === "runtime_store") {
    const databaseUrl = envValue(env, shared.url_env);
    if (!databaseUrl) throw new Error(`${shared.url_env} is required for authoritative runner_ledger intents`);
    const store = new PostgresWritebackIntentStore({
      pool: createPostgresPool(databaseUrl),
      schema: shared.schema ?? "synapsor_runner",
      autoMigrate: true,
      closePool: true,
    });
    return { store, close: () => store.close() };
  }
  return { store: localStore, close: async () => undefined };
}


export async function resolveSqlWriteDatabaseUrl(job: WritebackJob, configPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const config = await readRuntimeConfig(configPath);
  const source = config.sources?.[job.source_id];
  if (source?.credential_scope?.mode === "tenant_resolver") {
    throw new Error(
      `TENANT_CREDENTIAL_RESOLVER_REQUIRED: source ${job.source_id} requires application-supplied resolver ${source.credential_scope.resolver}; the stock CLI never loads executable resolver code. Embed the resolver or run one tenant-bound Runner process with shared credential mode.`,
    );
  }
  const writeUrlEnv = source?.write_url_env;
  if (writeUrlEnv) {
    const value = envValue(env, writeUrlEnv);
    if (value) return value;
  }
  return envValue(env, "SYNAPSOR_DATABASE_URL") || "";
}


type HttpHandlerExecutor = {
  type: "http_handler";
  url_env: string;
  method?: "POST" | "PUT" | "PATCH";
  auth?: { type: "bearer_env"; token_env: string };
  signing_secret_env?: string;
  timeout_ms?: number;
};


type CommandHandlerExecutor = {
  type: "command_handler";
  command_env: string;
  timeout_ms?: number;
};


type LocalExecutor = HttpHandlerExecutor | CommandHandlerExecutor | { type: "sql_update" };


export function findProposalCapability(config: RuntimeConfig, proposal: StoredProposal): NonNullable<RuntimeConfig["capabilities"]>[number] {
  const capability = (config.capabilities ?? []).find((candidate) => {
    if (candidate.kind !== "proposal") return false;
    if (candidate.name !== proposal.action) return false;
    if (candidate.source !== proposal.source_id) return false;
    if (candidate.target.schema !== proposal.source_schema) return false;
    if (candidate.target.table !== proposal.source_table) return false;
    if (candidate.target.primary_key !== proposal.change_set.source.primary_key.column) return false;
    return true;
  });
  if (!capability) {
    throw new Error(`proposal ${proposal.proposal_id} does not match any reviewed proposal capability in local config`);
  }
  return capability;
}


export function proposalExecutorName(proposal: StoredProposal, capability: NonNullable<RuntimeConfig["capabilities"]>[number]): string {
  const mode = capabilityWritebackMode(capability);
  if (mode === "none") return "none";
  if (mode === "cloud_worker") return "cloud_worker";
  if (mode === "direct_sql") return "sql_update";
  const writeback = proposal.change_set.writeback as { executor?: unknown };
  return capabilityWritebackExecutor(capability) ?? (typeof writeback.executor === "string" ? writeback.executor : undefined) ?? "sql_update";
}


export function executorConfig(config: RuntimeConfig, executorName: string): LocalExecutor {
  const raw = config.executors?.[executorName];
  if (!isRecord(raw)) throw new Error(`executor ${executorName} is not configured`);
  if (raw.type === "http_handler") return raw as HttpHandlerExecutor;
  if (raw.type === "command_handler") return raw as CommandHandlerExecutor;
  if (raw.type === "sql_update") return { type: "sql_update" };
  throw new Error(`executor ${executorName} has unsupported type`);
}


function signHandlerRequestBody(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}


export async function applyHttpHandlerProposal(input: {
  store: ProposalStore;
  proposalId: string;
  proposal: StoredProposal;
  executorName: string;
  executor: HttpHandlerExecutor;
  runnerId: string;
  dryRun: boolean;
  workerAttempt: number;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId, input.workerAttempt);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const url = envValue(input.env, input.executor.url_env);
  if (!url) throw new Error(`${input.executor.url_env} is not set`);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": prepared.request.idempotency_key,
  };
  if (input.executor.auth) {
    const token = envValue(input.env, input.executor.auth.token_env);
    if (!token) throw new Error(`${input.executor.auth.token_env} is not set`);
    headers.authorization = `Bearer ${token}`;
  }
  const issuedAt = new Date().toISOString();
  const requestBody = JSON.stringify({
    protocol_version: "1.0",
    ...prepared.request,
    issued_at: issuedAt,
    executor: input.executorName,
    dry_run: input.dryRun,
  });
  headers["x-synapsor-issued-at"] = issuedAt;
  headers["x-synapsor-proposal-id"] = prepared.proposal.proposal_id;
  if (input.executor.signing_secret_env) {
    const signingSecret = envValue(input.env, input.executor.signing_secret_env);
    if (!signingSecret) throw new Error(`${input.executor.signing_secret_env} is not set`);
    headers["x-synapsor-signature"] = signHandlerRequestBody(requestBody, signingSecret);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, input.executor.timeout_ms ?? 5000));
  let receipt: ExecutionReceiptV1;
  try {
    const response = await fetch(url, {
      method: input.executor.method ?? "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseOptionalJson(text);
    receipt = response.ok
      ? handlerReceiptFromBody({ proposal: prepared.proposal, request: prepared.request, body, runnerId: input.runnerId, dryRun: input.dryRun })
      : failedHandlerReceipt({ proposal: prepared.proposal, request: prepared.request, runnerId: input.runnerId, safeErrorCode: `HANDLER_HTTP_${response.status}` });
  } catch (error) {
    const code = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "HANDLER_TIMEOUT" : "HANDLER_REQUEST_FAILED";
    receipt = failedHandlerReceipt({ proposal: prepared.proposal, request: prepared.request, runnerId: input.runnerId, safeErrorCode: code });
  } finally {
    clearTimeout(timeout);
  }
  input.store.recordExecutionReceipt(receipt);
  return receipt;
}


export async function applyCommandHandlerProposal(input: {
  store: ProposalStore;
  proposalId: string;
  proposal: StoredProposal;
  executorName: string;
  executor: CommandHandlerExecutor;
  runnerId: string;
  dryRun: boolean;
  workerAttempt: number;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId, input.workerAttempt);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const commandText = envValue(input.env, input.executor.command_env);
  if (!commandText) throw new Error(`${input.executor.command_env} is not set`);
  const [command, ...commandArgs] = splitCommand(commandText);
  if (!command) throw new Error(`${input.executor.command_env} did not contain a command`);
  const body = await runCommandHandler(command, commandArgs, {
    ...prepared.request,
    executor: input.executorName,
    dry_run: input.dryRun,
  }, Math.max(1, input.executor.timeout_ms ?? 5000));
  const receipt = handlerReceiptFromBody({ proposal: prepared.proposal, request: prepared.request, body, runnerId: input.runnerId, dryRun: input.dryRun });
  input.store.recordExecutionReceipt(receipt);
  return receipt;
}


function prepareHandlerProposal(store: ProposalStore, proposal: StoredProposal, runnerId: string, workerAttempt = 1): {
  proposal: StoredProposal;
  request: Record<string, unknown> & { writeback_job_id: string; idempotency_key: string };
} {
  if (proposal.state === "applied") throw new Error(`proposal ${proposal.proposal_id} is already applied`);
  if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
    throw new Error(`proposal ${proposal.proposal_id} is ${proposal.state}, not approved for handler writeback`);
  }
  const prepared = proposal.state === "approved"
    ? store.markPendingWorker(proposal.proposal_id, proposal.proposal_hash, proposal.proposal_version)
    : proposal;
  const changeSet = prepared.change_set;
  const writebackJobId = `hwb_${prepared.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}${workerAttempt > 1 ? `_a${workerAttempt}` : ""}`;
  return {
    proposal: prepared,
    request: {
      schema_version: "synapsor.handler-writeback.v1",
      writeback_job_id: writebackJobId,
      proposal_id: prepared.proposal_id,
      proposal_version: prepared.proposal_version,
      proposal_hash: prepared.proposal_hash,
      action: prepared.action,
      runner_hint: runnerId,
      idempotency_key: `${prepared.proposal_id}:${prepared.object_id}`,
      source: changeSet.source,
      target: {
        schema: prepared.source_schema,
        table: prepared.source_table,
        primary_key: changeSet.source.primary_key,
      },
      tenant_guard: changeSet.guards.tenant,
      ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
      allowed_columns: changeSet.guards.allowed_columns,
      before: changeSet.before,
      patch: changeSet.patch,
      after: changeSet.after,
      guards: changeSet.guards,
      evidence: changeSet.evidence,
      approval: changeSet.approval,
      source_database_mutated: false,
    },
  };
}


function duplicateHandlerReceipt(store: ProposalStore, proposalId: string): { receipt: ExecutionReceiptV1 } | undefined {
  const receipts = store.receipts(proposalId);
  const existing = receipts.find((receipt) => receipt.writeback_job_id.startsWith("hwb_") && (receipt.status === "applied" || receipt.status === "already_applied"));
  if (!existing || existing.receipt.schema_version !== protocolVersions.executionReceipt) return undefined;
  return { receipt: existing.receipt };
}


function alreadyAppliedReceipt(receipt: ExecutionReceiptV1, runnerId: string): ExecutionReceiptV1 {
  if (receipt.status !== "applied" && receipt.status !== "already_applied") return receipt;
  const now = new Date().toISOString();
  return {
    ...receipt,
    runner_id: runnerId,
    status: "already_applied",
    rows_affected: 0,
    source_database_mutated: false,
    executed_at: now,
    safe_error_code: undefined,
    receipt_hash: hashReceipt({
      writeback_job_id: receipt.writeback_job_id,
      proposal_id: receipt.proposal_id,
      status: "already_applied",
      idempotency_key: receipt.idempotency_key,
      executed_at: now,
    }),
  };
}


function handlerReceiptFromBody(input: {
  proposal: StoredProposal;
  request: { writeback_job_id: string; idempotency_key: string };
  body: unknown;
  runnerId: string;
  dryRun: boolean;
}): ExecutionReceiptV1 {
  const body = isRecord(input.body) ? input.body : {};
  const rawStatus = String(body.status ?? "failed");
  const status = handlerReceiptStatuses.has(rawStatus) ? rawStatus as ExecutionReceiptV1["status"] : "failed";
  const rowsAffected = Number.isInteger(body.rows_affected) && Number(body.rows_affected) >= 0
    ? Number(body.rows_affected)
    : status === "applied" && !input.dryRun ? 1 : 0;
  const sourceDatabaseMutated = !input.dryRun && (status === "applied" || status === "already_applied")
    ? body.source_database_mutated !== false
    : false;
  return buildHandlerReceipt({
    writebackJobId: input.request.writeback_job_id,
    proposalId: input.proposal.proposal_id,
    runnerId: input.runnerId,
    status,
    rowsAffected,
    idempotencyKey: input.request.idempotency_key,
    previousVersion: scalarOrUndefined(body.previous_version),
    newVersion: scalarOrUndefined(body.new_version),
    sourceDatabaseMutated,
    safeErrorCode: typeof body.safe_error_code === "string" ? body.safe_error_code : status === "failed" ? "HANDLER_FAILED" : undefined,
    details: safeHandlerDetails(body.details),
  });
}


function failedHandlerReceipt(input: {
  proposal: StoredProposal;
  request: { writeback_job_id: string; idempotency_key: string };
  runnerId: string;
  safeErrorCode: string;
}): ExecutionReceiptV1 {
  return buildHandlerReceipt({
    writebackJobId: input.request.writeback_job_id,
    proposalId: input.proposal.proposal_id,
    runnerId: input.runnerId,
    status: "failed",
    rowsAffected: 0,
    idempotencyKey: input.request.idempotency_key,
    sourceDatabaseMutated: false,
    safeErrorCode: input.safeErrorCode,
  });
}


function buildHandlerReceipt(input: {
  writebackJobId: string;
  proposalId: string;
  runnerId: string;
  status: ExecutionReceiptV1["status"];
  rowsAffected: number;
  idempotencyKey: string;
  previousVersion?: string | number | boolean | null;
  newVersion?: string | number | boolean | null;
  sourceDatabaseMutated: boolean;
  safeErrorCode?: string;
  details?: unknown;
}): ExecutionReceiptV1 {
  const core = {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: input.writebackJobId,
    proposal_id: input.proposalId,
    runner_id: input.runnerId,
    status: input.status,
    rows_affected: input.rowsAffected,
    idempotency_key: input.idempotencyKey,
    previous_version: input.previousVersion,
    new_version: input.newVersion,
    source_database_mutated: input.sourceDatabaseMutated,
    executed_at: new Date().toISOString(),
    safe_error_code: input.safeErrorCode,
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
  return {
    ...core,
    receipt_hash: hashReceipt(core),
  };
}


export function formatApplyResult(job: WritebackJob, result: WritebackResult, dryRun: boolean, storePath: string): string {
  const status = writebackResultStatus(result);
  const affectedRows = writebackAffectedRows(result);
  const errorCode = writebackErrorCode(result);
  const receiptHash = writebackReceiptHash(result);
  const conflictGuardPassed = status === "conflict" && errorCode === "VERSION_CONFLICT" ? "no" : status === "applied" ? "yes" : "not completed";
  const title = status === "conflict"
    ? "Guarded writeback returned conflict."
    : status === "failed"
      ? "Guarded writeback failed."
      : dryRun
        ? "Guarded writeback dry run passed."
        : affectedRows === 0
          ? "Guarded writeback already applied."
          : "Guarded writeback applied.";
  const lines = [
    title,
    "",
    "Checks:",
    "* proposal approved: yes",
    `* primary key matched: ${status === "conflict" && errorCode === "ROW_NOT_FOUND" ? "no" : status === "failed" ? "not completed" : "yes"}`,
    `* tenant guard matched: ${status === "conflict" && errorCode === "ROW_NOT_FOUND" ? "no" : status === "failed" ? "not completed" : "yes"}`,
    "* allowed columns only: yes",
    `* conflict guard passed: ${conflictGuardPassed}`,
    `* affected rows: ${affectedRows}`,
    `* idempotency key: ${job.idempotency_key}`,
    "",
  ];
  if (status === "conflict") {
    lines.push(
      errorCode === "VERSION_CONFLICT" ? "The row changed after the agent saw it." : "The target row was not available under the primary-key and tenant guard.",
      "",
      "Result:",
      "conflict",
      "",
      "Source DB changed by Synapsor:",
      "no",
      "",
      "Why:",
      errorCode === "VERSION_CONFLICT" ? "conflict/version guard did not match" : errorCode || "guarded writeback returned conflict",
      "",
      "Next:",
      "Re-inspect the current source row and create a fresh proposal. The conflicted proposal and receipt remain in replay history.",
      "",
    );
  }
  if (status === "failed") {
    lines.push("Error:", errorCode || "writeback failed", "");
  }
  lines.push(
    "Receipt:",
    receiptHash || "(stored locally)",
    "",
    "Replay:",
    `${cliCommandName()} replay ${job.proposal_id} --store ${storePath}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}


export function formatHandlerApplyResult(receipt: ExecutionReceiptV1, proposalId: string, storePath: string): string {
  const title = receipt.status === "conflict"
    ? "App-owned writeback returned conflict."
    : receipt.status === "failed"
      ? "App-owned writeback failed."
      : receipt.status === "already_applied"
        ? "App-owned writeback already applied."
        : "App-owned writeback applied.";
  const lines = [
    title,
    "",
    "Checks:",
    "* proposal approved: yes",
    "* execution authority: app-owned handler outside MCP",
    `* source database changed by handler: ${receipt.source_database_mutated ? "yes" : "no"}`,
    `* affected rows: ${receipt.rows_affected}`,
    `* idempotency key: ${receipt.idempotency_key}`,
    "",
  ];
  if (receipt.status === "conflict") {
    lines.push(
      "Result:",
      "conflict",
      "",
      "Why:",
      receipt.safe_error_code || "handler returned conflict",
      "",
    );
  }
  if (receipt.status === "failed") {
    lines.push("Error:", receipt.safe_error_code || "handler writeback failed", "");
  }
  lines.push(
    "Receipt:",
    receipt.receipt_hash,
    "",
    "Replay:",
    `${cliCommandName()} replay ${proposalId} --store ${storePath}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}


export function writebackResultStatus(result: WritebackResult | ExecutionReceiptV1): string {
  return String((result as { status?: unknown }).status ?? "unknown");
}


export function writebackAffectedRows(result: WritebackResult | ExecutionReceiptV1): number {
  const value = (result as { affected_rows?: unknown; rows_affected?: unknown }).affected_rows
    ?? (result as { affected_rows?: unknown; rows_affected?: unknown }).rows_affected
    ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}


export function writebackErrorCode(result: WritebackResult | ExecutionReceiptV1): string | undefined {
  const value = (result as { error_code?: unknown; safe_error_code?: unknown }).error_code
    ?? (result as { error_code?: unknown; safe_error_code?: unknown }).safe_error_code;
  return typeof value === "string" && value ? value : undefined;
}


function writebackReceiptHash(result: WritebackResult | ExecutionReceiptV1): string | undefined {
  const value = (result as { result_hash?: unknown; receipt_hash?: unknown }).result_hash
    ?? (result as { result_hash?: unknown; receipt_hash?: unknown }).receipt_hash;
  return typeof value === "string" && value ? value : undefined;
}


export function logProposalWritebackOutcome(
  proposal: StoredProposal,
  runnerId: string,
  executor: string,
  result: WritebackResult | ExecutionReceiptV1,
  dryRun: boolean,
): void {
  const status = writebackResultStatus(result);
  const rowsAffected = writebackAffectedRows(result);
  operationalLog(status === "failed" ? "error" : status === "conflict" ? "warn" : "info", "writeback_outcome", {
    proposal_id: proposal.proposal_id,
    capability: proposal.action,
    tenant: proposal.tenant_id,
    runner_id: runnerId,
    executor,
    status,
    rows_affected: rowsAffected,
    error_code: writebackErrorCode(result),
    receipt_hash: writebackReceiptHash(result),
    dry_run: dryRun,
    source_database_changed: status === "applied" && !dryRun && rowsAffected > 0,
  });
}


function parseOptionalJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: "failed", safe_error_code: "HANDLER_INVALID_JSON" };
  }
}


function scalarOrUndefined(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}


function safeHandlerDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  return redactConfig(value);
}


async function runCommandHandler(command: string, args: string[], request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (body: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(body);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "failed", safe_error_code: "HANDLER_TIMEOUT" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish({ status: "failed", safe_error_code: "HANDLER_REQUEST_FAILED" }));
    child.on("close", (code) => {
      if (code === 0) finish(parseOptionalJson(stdout));
      else finish({ status: "failed", safe_error_code: `HANDLER_EXIT_${code ?? "UNKNOWN"}`, details: { stderr: stderr.slice(0, 500) } });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}


export async function verifyLocalWritebackAuthority(
  job: WritebackJob,
  configPath: string,
  storePath?: string,
  options: { cloudApproved?: boolean } = {},
): Promise<void> {
  const config = await readRuntimeConfig(configPath);
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`cannot apply writeback with invalid local config: ${validation.errors.map((error) => error.code).join(", ")}`);
  }
  if (config.mode !== "review") {
    throw new Error(`local writeback apply requires review mode, got ${config.mode}`);
  }
  const source = config.sources?.[job.source_id];
  if (!source) {
    throw new Error(`writeback source ${job.source_id} is not present in reviewed config`);
  }
  if (source.engine !== job.engine) {
    throw new Error(`writeback engine ${job.engine} does not match reviewed source ${job.source_id}`);
  }
  if (Date.parse(String(job.lease_expires_at)) < Date.now()) {
    throw new Error("writeback job lease has expired");
  }
  const proposalCapabilities = (config.capabilities ?? []).filter((capability) => capability.kind === "proposal" && capability.source === job.source_id && capabilityWritebackMode(capability) === "direct_sql");
  const matching = proposalCapabilities.find((capability) => capabilityMatchesJob(capability, job));
  if (!matching) {
    throw new Error("writeback job does not match any reviewed proposal capability in local config");
  }
  const reviewedPrincipalColumn = matching.target.principal_scope_key;
  const jobPrincipalScope = job.target.principal_scope;
  if (reviewedPrincipalColumn) {
    if (!jobPrincipalScope || jobPrincipalScope.column !== reviewedPrincipalColumn) {
      throw new Error("writeback job is missing or changes the reviewed principal scope");
    }
  } else if (jobPrincipalScope) {
    throw new Error("writeback job adds principal scope not present in the reviewed capability");
  }
  if (options.cloudApproved) {
    const leasedContract = "contract" in job ? job.contract : undefined;
    if (!leasedContract?.digest) throw new Error("Cloud writeback job is missing its immutable contract digest");
    if (!matching.contract_provenance || matching.contract_provenance.digest !== leasedContract.digest) {
      throw new Error("Cloud writeback job contract digest does not match the reviewed local contract");
    }
  }
  const reviewedAllowed = new Set(matching.allowed_columns ?? []);
  for (const column of job.allowed_columns) {
    if (!reviewedAllowed.has(column)) {
      throw new Error(`writeback job allowlist widens reviewed authority: ${column}`);
    }
  }
  for (const column of Object.keys(job.patch)) {
    if (!reviewedAllowed.has(column)) {
      throw new Error(`writeback patch column is not reviewed by local config: ${column}`);
    }
  }
  if (matching.conflict_guard?.column && job.conflict_guard.kind === "version_column" && matching.conflict_guard.column !== job.conflict_guard.column) {
    throw new Error("writeback conflict guard does not match reviewed capability");
  }
  const jobFreshness = "freshness" in job && job.freshness
    ? parseFreshnessAuthority(job.freshness)
    : undefined;
  // Compensation carries an exact expected-state/version guard in its inverse
  // descriptor; the v4 protocol deliberately has no generic freshness field.
  const currentFreshnessPolicy = job.protocol_version === protocolVersions.normalizedWritebackJobV4
    ? undefined
    : config.proposal_freshness?.[matching.name];
  if (Boolean(currentFreshnessPolicy) !== Boolean(jobFreshness)) {
    throw new Error(
      "FRESHNESS_POLICY_CHANGED_CREATE_NEW_PROPOSAL: the reviewed freshness policy changed after this proposal was created; create and review a new proposal",
    );
  }
  if (jobFreshness) {
    const freshnessConfigError = validateFreshnessAuthorityAgainstCurrentConfig(
      config,
      matching,
      jobFreshness,
    );
    if (freshnessConfigError) {
      throw new Error(
        `FRESHNESS_POLICY_CHANGED_CREATE_NEW_PROPOSAL: ${freshnessConfigError}; create and review a new proposal`,
      );
    }
  }
  if (storePath) {
    const store = new ProposalStore(storePath);
    try {
      const proposal = store.getProposal(job.proposal_id);
      if (!proposal) throw new Error(`local proposal not found for writeback job: ${job.proposal_id}`);
      const allowedStates = options.cloudApproved
        ? new Set(["pending_review", "approved", "pending_worker", "applied"])
        : new Set(["approved", "pending_worker", "applied"]);
      if (!allowedStates.has(proposal.state)) {
        throw new Error(`local proposal ${job.proposal_id} is ${proposal.state}, not eligible for ${options.cloudApproved ? "Cloud-approved" : "local-approved"} writeback`);
      }
      if (proposal.proposal_hash !== job.approval_id) {
        throw new Error("writeback approval/proposal digest does not match local proposal");
      }
      const proposalFreshness = "freshness" in proposal.change_set && proposal.change_set.freshness
        ? parseFreshnessAuthority(proposal.change_set.freshness)
        : undefined;
      if (Boolean(proposalFreshness) !== Boolean(jobFreshness)
        || (proposalFreshness && jobFreshness
          && proposalFreshness.dependency_set_digest !== jobFreshness.dependency_set_digest)) {
        throw new Error("writeback freshness authority does not match the immutable local proposal");
      }
      const proposalContract = proposal.change_set.contract;
      const reviewedContract = matching.contract_provenance;
      if (reviewedContract) {
        if (!proposalContract?.digest) {
          throw new Error("local proposal is missing the immutable active contract digest");
        }
        if (proposalContract.digest !== reviewedContract.digest) {
          throw new Error("local proposal contract digest does not match the active reviewed contract; create and review a new proposal");
        }
      } else if (proposalContract?.digest) {
        throw new Error("local proposal is bound to a contract digest, but the active reviewed capability has no matching contract provenance");
      }
      const proposalPrincipalScope = proposal.change_set.guards.principal_scope;
      if (reviewedPrincipalColumn) {
        if (!proposalPrincipalScope || proposalPrincipalScope.column !== reviewedPrincipalColumn || proposalPrincipalScope.value === undefined) {
          throw new Error("local proposal is missing its immutable principal scope");
        }
        if (!jobPrincipalScope || jobPrincipalScope.value_fingerprint !== proposalPrincipalScope.value_fingerprint
          || jobPrincipalScope.binding !== proposalPrincipalScope.binding
          || jobPrincipalScope.provider !== proposalPrincipalScope.provider) {
          throw new Error("writeback principal scope does not match the immutable local proposal");
        }
        if (jobPrincipalScope.value !== undefined && jobPrincipalScope.value !== proposalPrincipalScope.value) {
          throw new Error("writeback principal scope value does not match the immutable local proposal");
        }
        jobPrincipalScope.value = proposalPrincipalScope.value;
        if (!options.cloudApproved && (proposalPrincipalScope.provider === "environment" || proposalPrincipalScope.provider === "static_dev")) {
          const current = trustedCliContext(config, matching, process.env);
          if (current.tenant_id !== proposal.tenant_id || current.principal !== String(proposalPrincipalScope.value)) {
            throw new Error("current trusted tenant/principal cannot apply this proposal");
          }
        }
      } else if (proposalPrincipalScope) {
        throw new Error("local proposal carries principal scope outside the reviewed capability");
      }
      if (!options.cloudApproved) {
        verifyStoredFreshnessApprovalAuthority(store, proposal);
        await verifyStoredApprovalAuthority(config, configPath, store, proposal, matching);
      }
    } finally {
      store.close();
    }
  }
}


function verifyStoredFreshnessApprovalAuthority(
  store: ProposalStore,
  proposal: StoredProposal,
): void {
  if (!("freshness" in proposal.change_set) || !proposal.change_set.freshness) return;
  const authority = parseFreshnessAuthority(proposal.change_set.freshness);
  const approvals = store.approvals(proposal.proposal_id)
    .filter((approval) =>
      approval.status === "approved"
      && approval.proposal_hash === proposal.proposal_hash
      && approval.proposal_version === proposal.proposal_version);
  const required = proposal.change_set.approval.required_approvals ?? 1;
  if (new Set(approvals.map((approval) => approval.approver)).size < required) {
    throw new Error(`proposal ${proposal.proposal_id} does not have its required freshness-bound approvals`);
  }
  const proofEvents = store.events(proposal.proposal_id)
    .filter((event) => event.kind === "proposal_freshness_checked");
  for (const approval of approvals) {
    if (!approval.freshness_proof_digest) {
      throw new Error(`proposal ${proposal.proposal_id} has an approval without a freshness proof`);
    }
    const event = proofEvents.find((candidate) => {
      try {
        return parseFreshnessProof(candidate.payload.proof).proof_digest === approval.freshness_proof_digest;
      } catch {
        return false;
      }
    });
    if (!event) throw new Error(`proposal ${proposal.proposal_id} freshness proof is missing or failed integrity validation`);
    const proof = parseFreshnessProof(event.payload.proof);
    if (
      proof.result !== "fresh"
      || proof.proposal_hash !== proposal.proposal_hash
      || proof.proposal_version !== proposal.proposal_version
      || proof.dependency_set_digest !== authority.dependency_set_digest
    ) {
      throw new Error(`proposal ${proposal.proposal_id} approval freshness proof does not match immutable authority`);
    }
  }
}


export async function verifyStoredApprovalAuthority(
  config: RuntimeConfig,
  configPath: string,
  store: ProposalStore,
  proposal: StoredProposal,
  capability: NonNullable<RuntimeConfig["capabilities"]>[number],
): Promise<void> {
  if (!config.operator_identity || config.operator_identity.provider === "dev_env") return;
  const approval = [...store.approvals(proposal.proposal_id)]
    .reverse()
    .find((item) => item.status === "approved" && item.proposal_hash === proposal.proposal_hash && item.proposal_version === proposal.proposal_version);
  if (!approval) throw new Error(`proposal ${proposal.proposal_id} has no approval matching its immutable hash and version`);

  const reviewedPolicy = capability.approval?.mode === "policy" ? capability.approval.policy : undefined;
  if (reviewedPolicy && approval.approver === `policy:${reviewedPolicy}`) return;

  const identity = approval.identity;
  if (!identity || identity.provider !== config.operator_identity.provider || !identity.verified) {
    throw new Error(`proposal ${proposal.proposal_id} does not have a verified ${config.operator_identity.provider} human approval`);
  }
  if (
    approval.approver !== identity.subject
    || approval.decision_hash !== identity.decision_hash
    || approval.signature !== identity.signature
    || approval.integrity_hash !== identity.integrity_hash
    || identity.decision.action !== "approve"
    || identity.decision.proposal_id !== proposal.proposal_id
    || identity.decision.proposal_hash !== proposal.proposal_hash
    || identity.decision.proposal_version !== proposal.proposal_version
  ) {
    throw new Error(`proposal ${proposal.proposal_id} approval identity record failed integrity checks`);
  }
  const requiredRole = capability.approval?.required_role;
  if (requiredRole && !identity.roles.includes(requiredRole)) {
    throw new Error(`approval operator ${identity.subject} lacks required role ${requiredRole}`);
  }
  if (identity.provider === "signed_key") {
    const operator = config.operator_identity.operators?.[identity.subject];
    if (!operator) throw new Error(`approval operator ${identity.subject} is no longer registered`);
    if (requiredRole && !operator.roles.includes(requiredRole)) throw new Error(`approval operator ${identity.subject} lacks currently registered role ${requiredRole}`);
    const publicKeyPath = path.resolve(path.dirname(path.resolve(configPath)), operator.public_key_path);
    const publicKey = await fs.readFile(publicKeyPath, "utf8");
    if (!verifySignedOperatorProof(identity, publicKey)) {
      throw new Error(`proposal ${proposal.proposal_id} approval signature verification failed`);
    }
  } else {
    const secretEnv = config.operator_identity.attestation_secret_env ?? "SYNAPSOR_OPERATOR_ATTESTATION_SECRET";
    const secret = trimmedEnvValue(process.env, secretEnv);
    if (!secret || Buffer.byteLength(secret) < 32 || !verifyJwtOperatorProof(identity, secret)) {
      throw new Error(`proposal ${proposal.proposal_id} approval attestation verification failed`);
    }
  }
}


function capabilityMatchesJob(capability: NonNullable<RuntimeConfig["capabilities"]>[number], job: WritebackJob): boolean {
  if (capability.target.schema !== job.target.schema) return false;
  if (capability.target.table !== job.target.table) return false;
  if (capability.target.primary_key !== job.target.primary_key.column) return false;
  if (!capability.target.tenant_key || capability.target.tenant_key !== job.target.tenant_guard.column) return false;
  if ((capability.target.principal_scope_key ?? undefined) !== (job.target.principal_scope?.column ?? undefined)) return false;
  const reviewedOperation = capability.operation?.kind ?? "update";
  if (job.protocol_version === protocolVersions.normalizedWritebackJobV4) {
    if (capability.reversibility?.mode !== "reviewed_inverse") return false;
    const originalOperation = job.operation === "restore_update" ? "update" : "insert";
    if (reviewedOperation !== originalOperation) return false;
    if ((capability.operation?.cardinality ?? "single") !== job.compensation.cardinality) return false;
    if (job.compensation.cardinality === "set" && capability.operation?.max_rows !== job.compensation.max_rows) return false;
    if (reviewedOperation === "update" && (
      capability.operation?.version_advance?.column !== job.compensation.version_advance?.column
      || capability.operation?.version_advance?.strategy !== job.compensation.version_advance?.strategy
    )) return false;
    const reviewedAllowed = new Set(capability.allowed_columns ?? []);
    return job.allowed_columns.every((column) => reviewedAllowed.has(column));
  }
  const setJob = job.protocol_version === protocolVersions.normalizedWritebackJobV3;
  const jobOperation = (job.operation ?? "single_row_update").replace("single_row_", "").replace("set_", "").replace("batch_", "");
  if (reviewedOperation !== jobOperation) return false;
  if ((capability.operation?.cardinality === "set") !== setJob) return false;
  const reviewedAllowed = new Set(capability.allowed_columns ?? []);
  if (reviewedOperation !== "delete" && reviewedAllowed.size === 0) return false;
  if (reviewedOperation === "delete" && (reviewedAllowed.size !== 0 || Object.keys(job.patch).length !== 0)) return false;
  if (reviewedOperation === "insert") {
    const reviewedDedup = capability.operation?.deduplication?.components ?? [];
    if (setJob) {
      if (reviewedDedup.length < 1 || job.frozen_set.members.some((member) => {
        const resolved = member.deduplication?.components ?? [];
        return reviewedDedup.length !== resolved.length || reviewedDedup.some((component) => !resolved.some((item) => item.column === component.column));
      })) return false;
    } else {
      if (job.protocol_version !== protocolVersions.normalizedWritebackJobV2 || !job.deduplication) return false;
      if (reviewedDedup.length !== job.deduplication.components.length) return false;
      for (const component of reviewedDedup) {
        if (!job.deduplication.components.some((resolved) => resolved.column === component.column && resolved.source === component.source)) return false;
      }
    }
  }
  if (setJob) {
    if (capability.operation?.max_rows !== job.frozen_set.max_rows) return false;
    const reviewedBounds = capability.operation?.aggregate_bounds ?? [];
    if (reviewedBounds.length !== job.frozen_set.aggregate_bounds.length) return false;
    for (const bound of reviewedBounds) {
      if (!job.frozen_set.aggregate_bounds.some((resolved) => resolved.column === bound.column && resolved.measure === bound.measure && resolved.maximum === bound.maximum)) return false;
    }
    if (reviewedOperation === "update" && (
      capability.operation?.version_advance?.column !== job.version_advance?.column
      || capability.operation?.version_advance?.strategy !== job.version_advance?.strategy
    )) return false;
  }
  return Object.keys(job.patch).every((column) => reviewedAllowed.has(column));
}
