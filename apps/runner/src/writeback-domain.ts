import { capabilityWritebackMode, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  type StoredProposal
} from "@synapsor-runner/proposal-store";
import { protocolVersions, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import {
  type RunnerConfig
} from "@synapsor-runner/worker-core";
import crypto from "node:crypto";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { envValue } from "./cli-options.js";
import { RunnerCapabilityConfig, RunnerSourceConfig } from "./cli-runtime.js";


export function receiptTableGuidance(engine: "postgres" | "mysql", source?: RunnerSourceConfig): string {
  if (source?.receipts?.authority === "runner_ledger") {
    return "Verify the authoritative Runner ledger and minimum business-table writer grants; runner_ledger never creates or writes a receipt table in the source database.";
  }
  const schema = source?.receipts?.schema ?? (engine === "postgres" ? "synapsor" : "<database_name>");
  const table = source?.receipts?.table ?? "synapsor_writeback_receipts";
  if (engine === "postgres") {
    return `Prepare ${schema}.${table} with "${cliCommandName()} writeback migration --engine postgres --schema ${schema} --table ${table}" and grant it with "${cliCommandName()} writeback grants --engine postgres --schema ${schema} --table ${table} --writer-role <writer_role>", or use runner_ledger/app-owned writeback.`;
  }
  return `Prepare ${schema}.${table} with "${cliCommandName()} writeback migration --engine mysql --schema ${schema} --table ${table}" and grant it with "${cliCommandName()} writeback grants --engine mysql --schema ${schema} --table ${table} --writer-role \\"'<writer>'@'%'\\"", or use runner_ledger/app-owned writeback.`;
}


export function capabilityOperation(capability: RunnerCapabilityConfig): "update" | "insert" | "delete" {
  return capability.operation?.kind ?? "update";
}


export function formatSourceReceiptMode(source: RunnerSourceConfig | undefined): string {
  const receipts = runnerReceiptConfig(source);
  if (receipts?.authority === "runner_ledger") return "runner_ledger (zero source receipt schema)";
  const provisioning = receipts?.provisioning ?? "precreated";
  const schema = receipts?.schema;
  const table = receipts?.table ?? "synapsor_writeback_receipts";
  return `source_db/${provisioning} (${schema ? `${schema}.` : ""}${table})`;
}


export function runnerReceiptConfig(source: RunnerSourceConfig | undefined): RunnerConfig["receipts"] {
  const receipts = source?.receipts;
  if (!receipts) return { authority: "source_db", provisioning: "precreated" };
  return receipts.authority === "runner_ledger"
    ? { authority: "runner_ledger" }
    : {
      authority: "source_db",
      provisioning: receipts.provisioning ?? "precreated",
      schema: receipts.schema,
      table: receipts.table,
    };
}


export function writebackDatabaseScope(
  source: RunnerSourceConfig | undefined,
  proposal: StoredProposal | undefined,
  job: WritebackJob,
): RunnerConfig["databaseScope"] {
  const scope = source?.database_scope;
  if (!scope || scope.mode === "application") return undefined;
  if (source?.engine !== "postgres" || job.engine !== "postgres") {
    throw new Error("postgres_rls database scope is valid only for PostgreSQL writeback");
  }
  if (!proposal) {
    throw new Error(`POSTGRES_RLS_TRUSTED_CONTEXT_MISSING: proposal ${job.proposal_id} is required to bind hardened writeback scope`);
  }
  const tenantId = String(proposal.change_set.scope.tenant_id);
  const principal = String(proposal.change_set.principal.id);
  if (tenantId !== String(job.target.tenant_guard.value)) {
    throw new Error("POSTGRES_RLS_TENANT_CONTEXT_MISMATCH");
  }
  if (job.target.principal_scope?.value !== undefined && principal !== String(job.target.principal_scope.value)) {
    throw new Error("POSTGRES_RLS_PRINCIPAL_CONTEXT_MISMATCH");
  }
  if (!scope.principal_setting) {
    throw new Error("POSTGRES_RLS_PRINCIPAL_SETTING_REQUIRED_FOR_WRITEBACK");
  }
  return {
    mode: "postgres_rls",
    tenantSetting: scope.tenant_setting,
    principalSetting: scope.principal_setting,
    tenantId,
    principal,
  };
}


export function writebackTimeoutMs(source: RunnerSourceConfig | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (source?.statement_timeout_ms !== undefined) return source.statement_timeout_ms;
  const raw = envValue(env, "SYNAPSOR_WRITEBACK_TIMEOUT_MS");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("SYNAPSOR_WRITEBACK_TIMEOUT_MS must be a positive integer");
  return parsed;
}


export function sourceNeedsSqlWriteback(config: RuntimeConfig, sourceName: string): boolean {
  return (config.capabilities ?? []).some((capability) => {
    if (capability.kind !== "proposal" || capability.source !== sourceName) return false;
    return capabilityWritebackMode(capability) === "direct_sql";
  });
}


export function hashReceipt(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}


export function toExecutionReceipt(job: WritebackJob, result: WritebackResult, dryRun: boolean): Record<string, unknown> {
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
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV4) {
    if (job.protocol_version !== protocolVersions.normalizedWritebackJobV4) throw new Error("compensation result does not match writeback job v4");
    const compensationStatus = dryRun ? "canceled" : terminalStatus;
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : compensationStatus === "applied" ? "APPLIED"
        : compensationStatus === "already_applied" ? "ALREADY_APPLIED"
          : compensationStatus === "conflict" ? "CONFLICT"
            : compensationStatus === "reconciliation_required" ? "RECONCILIATION_REQUIRED" : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV4,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: compensationStatus,
      target: { source_id: job.source_id, schema: job.target.schema, table: job.target.table, identities: result.target_identities },
      rows_affected: dryRun ? 0 : affectedRows,
      idempotency_key: job.idempotency_key,
      forward_receipt_hash: job.forward_receipt_hash,
      member_effects: dryRun ? [] : result.member_effects,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? { reconciliation: { intent_id: result.intent_id, reason: "source outcome requires operator reconciliation" } } : {}),
    };
  }
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV3) {
    const setStatus = dryRun ? "canceled" : terminalStatus;
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : setStatus === "applied" ? "APPLIED"
        : setStatus === "already_applied" ? "ALREADY_APPLIED"
          : setStatus === "conflict" ? "CONFLICT"
            : setStatus === "reconciliation_required" ? "RECONCILIATION_REQUIRED" : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV3,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: setStatus,
      target: {
        source_id: job.source_id,
        schema: job.target.schema,
        table: job.target.table,
        identities: result.target_identities,
        set_digest: result.set_digest,
      },
      rows_affected: dryRun ? 0 : affectedRows,
      idempotency_key: job.idempotency_key,
      member_effects: dryRun ? [] : result.member_effects,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? {
        reconciliation: { intent_id: result.intent_id, reason: "source outcome requires operator reconciliation" },
      } : {}),
    };
  }
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV2) {
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : terminalStatus === "applied"
        ? "APPLIED"
        : terminalStatus === "already_applied"
          ? "ALREADY_APPLIED"
          : terminalStatus === "conflict"
            ? "CONFLICT"
            : terminalStatus === "reconciliation_required"
              ? "RECONCILIATION_REQUIRED"
              : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV2,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: terminalStatus,
      target: {
        source_id: job.source_id,
        schema: job.target.schema,
        table: job.target.table,
        identity: result.target_identity,
      },
      rows_affected: affectedRows,
      idempotency_key: job.idempotency_key,
      before_digest: result.before_digest,
      after_digest: result.after_digest,
      tombstone_digest: result.tombstone_digest,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? {
        reconciliation: {
          intent_id: result.intent_id,
          reason: "source outcome requires operator reconciliation",
        },
      } : {}),
    };
  }
  return {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: job.job_id,
    proposal_id: job.proposal_id,
    runner_id: result.runner_id,
    status: terminalStatus,
    rows_affected: affectedRows,
    idempotency_key: job.idempotency_key,
    previous_version: previousVersion,
    new_version: "result_version" in result ? result.result_version : undefined,
    source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
    executed_at: result.completed_at ?? new Date().toISOString(),
    safe_error_code: result.error_code,
    receipt_hash: receiptHash,
  };
}
