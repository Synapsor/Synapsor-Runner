import {
  type SQLInputValue,
} from "node:sqlite";
import {
  parseExecutionReceipt,
  parseFreshnessAuthority,
  parseWritebackJob,
  parseWritebackResult,
  protocolVersions,
  type ExecutionReceipt,
  type WritebackJob,
  type WritebackJobV1,
  type WritebackJobV2,
  type WritebackJobV3,
  type WritebackJobV4,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import {
  type StoredProposal,
  type ProposalEvent,
  type StoredWritebackJob,
  type WritebackIntentStatus,
  type StoredWritebackIntent,
  type WritebackIntentClaim,
  type ReconcileWritebackIntentInput,
  type StoredEvidenceBundle,
  type EventSearchFilters,
  type WorkerQueueStatus,
  type CreateWritebackJobOptions,
  type RecordHandlerWritebackJobInput,
  type QueryAuditRecordInput,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  assertOperatorDecision,
  publicIdentitySummary,
  assertProposalIdentity,
  assertWritebackAllowed,
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  buildEventQuery,
} from "./query-builders.js";
import {
  stateFromReceipt,
  receiptToWritebackResult,
  inverseCaptureFromChangeSet,
  writebackMutationFromChangeSet,
  conflictGuardFromChangeSet,
} from "./writeback-domain.js";
import {
  rowToEvent,
  rowToWritebackJob,
  rowToWritebackIntent,
} from "./record-codecs.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreWritebackMethods,
  ProposalStoreWritebackInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

function validatedRecordedAt(value: string | undefined, label: string): string {
  const recordedAt = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new ProposalStoreError("LEDGER_TIMESTAMP_INVALID", `${label} created_at must be an ISO timestamp`);
  }
  return recordedAt;
}

export const proposalStoreWritebackMethods: ProposalStoreWritebackMethods & ProposalStoreWritebackInternalMethods & ThisType<ProposalStoreMethodContext> = {
  recordExecutionReceipt(input: unknown): StoredProposal {
      const receipt = parseExecutionReceipt(input);
      const proposal = this.requireProposal(receipt.proposal_id);
      assertWritebackAllowed(proposal, "recorded with an execution receipt");
      this.transaction(() => {
        this.recordExecutionReceiptRows(receipt, proposal);
      });
      return this.requireProposal(receipt.proposal_id);
    },
  
  recordWritebackJob(input: unknown): WritebackJob {
      const job = parseWritebackJob(input);
      const proposal = this.requireProposal(job.proposal_id);
      assertWritebackAllowed(proposal, "recorded with a writeback job");
      const proposalHash = job.approval_id;
      assertProposalIdentity(proposal, proposalHash, proposal.proposal_version);
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(job.job_id, job.proposal_id, proposalHash, "pending_worker", JSON.stringify(job), now, now);
        this.appendEvent(job.proposal_id, "writeback_job_recorded", "runner", {
          writeback_job_id: job.job_id,
          proposal_hash: proposalHash,
          source_id: job.source_id,
        });
      });
      return job;
    },
  
  getWritebackJob(writebackJobId: string): StoredWritebackJob | undefined {
      return rowToWritebackJob(this.db.prepare("SELECT * FROM writeback_jobs WHERE writeback_job_id = ?").get(writebackJobId));
    },
  
  listWritebackJobs(options: { proposal_id?: string; limit?: number } = {}): StoredWritebackJob[] {
      const clauses: string[] = [];
      const values: SQLInputValue[] = [];
      if (options.proposal_id) {
        clauses.push("proposal_id = ?");
        values.push(options.proposal_id);
      }
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
      return this.db.prepare(`SELECT * FROM writeback_jobs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC, writeback_job_id ASC LIMIT ?`)
        .all(...values, limit)
        .map(rowToWritebackJob)
        .filter((job): job is StoredWritebackJob => Boolean(job));
    },
  
  claimWritebackIntent(jobInput: unknown, runnerId: string): WritebackIntentClaim {
      const job = parseWritebackJob(jobInput);
      const proposal = this.requireProposal(job.proposal_id);
      assertWritebackAllowed(proposal, "recorded with a writeback intent");
      assertProposalIdentity(proposal, job.approval_id, proposal.proposal_version);
      const intentId = `wbi:${job.job_id}`;
      const existing = this.getWritebackIntent(intentId);
      if (existing) {
        if (
          existing.idempotency_key !== job.idempotency_key
          || existing.writeback_job_id !== job.job_id
          || existing.proposal_id !== job.proposal_id
          || existing.proposal_hash !== job.approval_id
        ) {
          throw new ProposalStoreError("WRITEBACK_INTENT_IDENTITY_MISMATCH", `writeback intent ${intentId} does not match the immutable job identity`);
        }
        if (["applied", "already_applied", "conflict", "failed"].includes(existing.status)) {
          if (!existing.result) {
            return { decision: "reconciliation_required", intent_id: intentId, reason: "terminal intent is missing its durable result" };
          }
          return { decision: "existing_result", intent_id: intentId, result: existing.result };
        }
        if (existing.status === "applying" || existing.status === "reconciliation_required") {
          return {
            decision: "reconciliation_required",
            intent_id: intentId,
            reason: existing.reconciliation_reason ?? "a previous apply crossed the source mutation boundary without a durable terminal result",
          };
        }
        return { decision: "proceed", intent_id: intentId };
      }
  
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare(`
          INSERT INTO writeback_intents (
            intent_id, idempotency_key, writeback_job_id, proposal_id, proposal_hash,
            runner_id, operation, status, intent_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent_recorded', ?, ?, ?)
        `).run(
          intentId,
          job.idempotency_key,
          job.job_id,
          job.proposal_id,
          job.approval_id,
          runnerId,
          job.operation ?? "single_row_update",
          JSON.stringify(job),
          now,
          now,
        );
        this.appendEvent(job.proposal_id, "writeback_intent_recorded", runnerId, {
          intent_id: intentId,
          writeback_job_id: job.job_id,
          operation: job.operation ?? "single_row_update",
        });
      });
      return { decision: "proceed", intent_id: intentId };
    },
  
  markWritebackIntentApplying(intentId: string, runnerId: string): void {
      const intent = this.requireWritebackIntent(intentId);
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE writeback_intents
        SET status = 'applying', runner_id = ?, reconciliation_reason = NULL, updated_at = ?
        WHERE intent_id = ? AND status = 'intent_recorded'
      `).run(runnerId, now, intentId);
      if (Number(result.changes) !== 1) {
        throw new ProposalStoreError(
          "WRITEBACK_INTENT_NOT_CLAIMABLE",
          `writeback intent ${intentId} is ${intent.status}; its source outcome must be reconciled before another apply`,
        );
      }
      this.appendEvent(intent.proposal_id, "writeback_intent_applying", runnerId, {
        intent_id: intentId,
        writeback_job_id: intent.writeback_job_id,
        operation: intent.operation,
      });
    },
  
  completeWritebackIntent(intentId: string, resultInput: WritebackResult): void {
      const result = parseWritebackResult(resultInput);
      const intent = this.requireWritebackIntent(intentId);
      if (result.job_id !== intent.writeback_job_id) {
        throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_MISMATCH", `result ${result.job_id} does not belong to intent ${intentId}`);
      }
      if (!["applied", "already_applied", "conflict", "failed", "reconciliation_required"].includes(result.status)) {
        throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_NOT_TERMINAL", `result for ${intentId} is not terminal`);
      }
      const now = new Date().toISOString();
      const reconciliationReason = result.status === "reconciliation_required"
        ? "source outcome requires operator reconciliation"
        : null;
      const updated = this.db.prepare(`
        UPDATE writeback_intents
        SET status = ?, result_json = ?, reconciliation_reason = ?, updated_at = ?
        WHERE intent_id = ? AND status IN ('applying', 'reconciliation_required')
      `).run(result.status, JSON.stringify(result), reconciliationReason, now, intentId);
      if (Number(updated.changes) !== 1) {
        const latest = this.requireWritebackIntent(intentId);
        if (latest.result && JSON.stringify(latest.result) === JSON.stringify(result)) return;
        throw new ProposalStoreError("WRITEBACK_INTENT_COMPLETION_CONFLICT", `writeback intent ${intentId} cannot move from ${latest.status} to ${result.status}`);
      }
      this.appendEvent(intent.proposal_id, `writeback_intent_${result.status}`, result.runner_id, {
        intent_id: intentId,
        writeback_job_id: intent.writeback_job_id,
        operation: intent.operation,
        result_hash: result.result_hash,
      });
    },
  
  requireWritebackReconciliation(intentId: string, reason: string): void {
      const intent = this.requireWritebackIntent(intentId);
      if (intent.status === "applied" || intent.status === "already_applied") return;
      const safeReason = String(reason || "source outcome is unknown").slice(0, 500);
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE writeback_intents
        SET status = 'reconciliation_required', reconciliation_reason = ?, updated_at = ?
        WHERE intent_id = ?
      `).run(safeReason, now, intentId);
      this.appendEvent(intent.proposal_id, "writeback_reconciliation_required", intent.runner_id, {
        intent_id: intentId,
        writeback_job_id: intent.writeback_job_id,
        operation: intent.operation,
        reason: safeReason,
      });
    },
  
  getWritebackIntent(intentId: string): StoredWritebackIntent | undefined {
      return rowToWritebackIntent(this.db.prepare("SELECT * FROM writeback_intents WHERE intent_id = ?").get(intentId));
    },
  
  listWritebackIntents(options: { status?: WritebackIntentStatus; proposal_id?: string; limit?: number } = {}): StoredWritebackIntent[] {
      const clauses: string[] = [];
      const values: SQLInputValue[] = [];
      if (options.status) { clauses.push("status = ?"); values.push(options.status); }
      if (options.proposal_id) { clauses.push("proposal_id = ?"); values.push(options.proposal_id); }
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
      return this.db.prepare(`SELECT * FROM writeback_intents${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`)
        .all(...values, limit)
        .map(rowToWritebackIntent)
        .filter((intent): intent is StoredWritebackIntent => Boolean(intent));
    },
  
  reconcileWritebackIntent(input: ReconcileWritebackIntentInput): StoredWritebackIntent {
      const intent = this.requireWritebackIntent(input.intent_id);
      const proposal = this.requireProposal(intent.proposal_id);
      const receipt = parseExecutionReceipt(input.receipt);
      if (receipt.schema_version !== protocolVersions.executionReceiptV2 && receipt.schema_version !== protocolVersions.executionReceiptV3 && receipt.schema_version !== protocolVersions.executionReceiptV4) throw new ProposalStoreError("RECONCILIATION_RECEIPT_VERSION_REQUIRED", "reconciliation requires an execution-receipt v2, v3, or v4");
      if (!input.reason.trim()) throw new ProposalStoreError("RECONCILIATION_REASON_REQUIRED", "reconciliation requires an operator reason");
      if (intent.status !== "reconciliation_required" && intent.status !== "applying") {
        throw new ProposalStoreError("WRITEBACK_INTENT_NOT_RECONCILABLE", `writeback intent ${intent.intent_id} is ${intent.status}`);
      }
      if (receipt.receipt_authority !== "runner_ledger"
        || receipt.writeback_job_id !== intent.writeback_job_id
        || receipt.proposal_id !== intent.proposal_id
        || receipt.proposal_hash !== intent.proposal_hash
        || receipt.operation !== intent.operation
        || !["applied", "conflict", "failed"].includes(receipt.status)) {
        throw new ProposalStoreError("RECONCILIATION_RECEIPT_MISMATCH", `reconciliation receipt does not match intent ${intent.intent_id}`);
      }
      assertOperatorDecision(proposal, "reconcile", input.actor, input.identity, input.require_verified_identity === true);
      assertNoSecretMaterial(input.observation, "writeback_reconciliation_observation");
      const reason = input.reason.trim().slice(0, 500);
      this.transaction(() => {
        const updated = this.db.prepare(`
          UPDATE writeback_intents
          SET status = ?, result_json = ?, reconciliation_reason = ?, updated_at = ?
          WHERE intent_id = ? AND status IN ('applying', 'reconciliation_required')
        `).run(receipt.status, JSON.stringify(receiptToWritebackResult(receipt)), reason, receipt.executed_at, intent.intent_id);
        if (Number(updated.changes) !== 1) throw new ProposalStoreError("WRITEBACK_INTENT_RECONCILIATION_CONFLICT", `writeback intent ${intent.intent_id} changed during reconciliation`);
        this.appendEvent(intent.proposal_id, "writeback_reconciled", input.actor, {
          intent_id: intent.intent_id,
          writeback_job_id: intent.writeback_job_id,
          operation: intent.operation,
          outcome: receipt.status,
          reason,
          observation: input.observation,
          identity: publicIdentitySummary(input.identity),
          decision_hash: input.identity?.decision_hash,
        });
        this.recordExecutionReceiptRows(receipt, proposal);
        const workerItem = this.workerQueueItem(intent.proposal_id);
        if (workerItem?.status === "reconciliation_required") {
          const queueStatus: WorkerQueueStatus = receipt.status === "failed" ? "dead_letter" : "completed";
          const terminalOutcome = receipt.status === "failed" ? "dead_letter" : receipt.status;
          this.db.prepare(`
            UPDATE worker_queue
            SET status = ?, lease_owner = NULL, lease_id = NULL,
                lease_expires_at = NULL, last_error_code = ?,
                terminal_outcome = ?, updated_at = ?
            WHERE proposal_id = ? AND status = 'reconciliation_required'
          `).run(
            queueStatus,
            receipt.status === "failed" ? "RECONCILED_FAILED" : null,
            terminalOutcome,
            receipt.executed_at,
            intent.proposal_id,
          );
          this.appendEvent(intent.proposal_id, "writeback_worker_reconciled", input.actor, {
            intent_id: intent.intent_id,
            outcome: receipt.status,
            queue_status: queueStatus,
            source_database_changed: false,
          });
        }
      });
      return this.requireWritebackIntent(intent.intent_id);
    },
  
  requireWritebackIntent(intentId: string): StoredWritebackIntent {
      const intent = this.getWritebackIntent(intentId);
      if (!intent) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      return intent;
    },
  
  recordExecutionReceiptRows(receipt: ExecutionReceipt, proposal: StoredProposal): void {
      const state = stateFromReceipt(receipt);
      const now = receipt.executed_at || new Date().toISOString();
      this.db.prepare(`
        INSERT OR IGNORE INTO writeback_receipts (
          writeback_job_id, proposal_id, runner_id, status, idempotency_key,
          source_database_mutated, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.writeback_job_id, receipt.proposal_id, receipt.runner_id, receipt.status,
        receipt.idempotency_key, receipt.source_database_mutated ? 1 : 0,
        JSON.stringify(receipt), now,
      );
      this.db.prepare("UPDATE proposals SET state = ?, source_database_mutated = ?, updated_at = ? WHERE proposal_id = ?")
        .run(state, receipt.source_database_mutated ? 1 : proposal.source_database_mutated ? 1 : 0, now, receipt.proposal_id);
      this.db.prepare(`
        INSERT OR REPLACE INTO idempotency_receipts (
          idempotency_key, writeback_job_id, proposal_id, receipt_status, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(receipt.idempotency_key, receipt.writeback_job_id, receipt.proposal_id, receipt.status, JSON.stringify(receipt), now);
      this.db.prepare("UPDATE writeback_jobs SET status = ?, updated_at = ? WHERE writeback_job_id = ?")
        .run(receipt.status, now, receipt.writeback_job_id);
      this.appendEvent(receipt.proposal_id, `writeback_${receipt.status}`, receipt.runner_id, {
        writeback_job_id: receipt.writeback_job_id,
        rows_affected: receipt.rows_affected,
        source_database_mutated: receipt.source_database_mutated,
        receipt_hash: receipt.receipt_hash,
        safe_error_code: "safe_error_code" in receipt ? receipt.safe_error_code ?? null : null,
      });
    },
  
  recordHandlerWritebackJob(input: RecordHandlerWritebackJobInput): void {
      const proposal = this.requireProposal(input.proposal_id);
      assertWritebackAllowed(proposal, "recorded with a handler writeback job");
      assertProposalIdentity(proposal, input.proposal_hash, proposal.proposal_version);
      assertNoSecretMaterial(input.request, "handler_writeback_job");
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(
          input.writeback_job_id,
          input.proposal_id,
          input.proposal_hash,
          "pending_worker",
          JSON.stringify({
            schema_version: "synapsor.handler-writeback.v1",
            writeback_job_id: input.writeback_job_id,
            proposal_id: input.proposal_id,
            proposal_hash: input.proposal_hash,
            runner_id: input.runner_id,
            executor: input.executor,
            request: input.request,
          }),
          now,
          now,
        );
        this.appendEvent(input.proposal_id, "handler_writeback_job_recorded", input.runner_id, {
          writeback_job_id: input.writeback_job_id,
          executor: input.executor,
        });
      });
    },
  
  createWritebackJobFromProposal(proposalId: string, options: CreateWritebackJobOptions = {}): WritebackJobV1 | WritebackJobV2 | WritebackJobV3 | WritebackJobV4 {
      const proposal = this.requireProposal(proposalId);
      assertWritebackAllowed(proposal, "converted into a writeback job");
      if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
        throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
      }
      const changeSet = proposal.change_set;
      if (changeSet.writeback.mode !== "trusted_worker_required") {
        throw new ProposalStoreError("WRITEBACK_NOT_REQUIRED", `proposal ${proposalId} uses ${changeSet.writeback.mode}`);
      }
      const writebackExecutor = (changeSet.writeback as { executor?: unknown }).executor;
      if (typeof writebackExecutor === "string" && writebackExecutor !== "sql_update" && writebackExecutor !== "trusted_worker_required") {
        throw new ProposalStoreError("WRITEBACK_NOT_DIRECT_SQL", `proposal ${proposalId} uses app-owned or non-local writeback executor ${writebackExecutor}`);
      }
      if (changeSet.source.kind !== "external_postgres" && changeSet.source.kind !== "external_mysql") {
        throw new ProposalStoreError("WRITEBACK_TARGET_NOT_EXTERNAL", `proposal ${proposalId} targets ${changeSet.source.kind}`);
      }
      const engine = changeSet.source.kind === "external_postgres" ? "postgres" : "mysql";
      const leaseSeconds = Math.max(15, Math.min(Number(options.lease_seconds ?? 300), 3600));
      const attempt = Math.max(1, Math.min(Number(options.attempt ?? 1), 100));
      const now = Date.now();
      const writebackJobId = `wbj_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}${attempt > 1 ? `_a${attempt}` : ""}`;
      const lease = {
        lease_id: options.lease_id ?? `lease_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}_a${attempt}`,
        attempt,
        expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      };
      const common = {
        writeback_job_id: writebackJobId,
        proposal_id: proposal.proposal_id,
        proposal_version: proposal.proposal_version,
        proposal_hash: proposal.proposal_hash,
        runner_scope: { project_id: options.project_id ?? "local", source_id: proposal.source_id },
        engine,
        tenant_guard: changeSet.guards.tenant,
        ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
        allowed_columns: changeSet.guards.allowed_columns,
        ...("freshness" in changeSet && changeSet.freshness
          ? { freshness: parseFreshnessAuthority(changeSet.freshness) }
          : {}),
        idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
        lease,
      } as const;
      const inverseCapture = inverseCaptureFromChangeSet(changeSet, writebackJobId);
      const job: WritebackJobV1 | WritebackJobV2 | WritebackJobV3 | WritebackJobV4 = changeSet.schema_version === protocolVersions.changeSet
        ? {
          schema_version: protocolVersions.writebackJob,
          ...common,
          operation: "single_row_update",
          target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
          patch: changeSet.patch,
          conflict_guard: conflictGuardFromChangeSet(changeSet),
        }
        : changeSet.schema_version === protocolVersions.changeSetV2 ? {
          schema_version: protocolVersions.writebackJobV2,
          ...common,
          target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
          mutation: writebackMutationFromChangeSet(changeSet),
          ...(inverseCapture ? { inverse_capture: inverseCapture } : {}),
        } : changeSet.schema_version === protocolVersions.changeSetV3 ? {
          schema_version: protocolVersions.writebackJobV3,
          ...common,
          operation: changeSet.operation,
          target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
          patch: changeSet.patch,
          ...(changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {}),
          frozen_set: changeSet.frozen_set,
          ...(inverseCapture ? { inverse_capture: inverseCapture } : {}),
        } : {
          schema_version: protocolVersions.writebackJobV4,
          writeback_job_id: writebackJobId,
          proposal_id: proposal.proposal_id,
          proposal_version: proposal.proposal_version,
          proposal_hash: proposal.proposal_hash,
          runner_scope: { project_id: options.project_id ?? "local", source_id: proposal.source_id },
          engine,
          operation: changeSet.compensation.descriptor.operation,
          target: {
            schema: proposal.source_schema,
            table: proposal.source_table,
            primary_key: {
              column: changeSet.source.primary_key.column,
              ...(changeSet.compensation.descriptor.members.length === 1 ? { value: changeSet.compensation.descriptor.members[0]!.primary_key.value } : {}),
            },
          },
          tenant_guard: changeSet.guards.tenant,
          ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
          allowed_columns: changeSet.guards.allowed_columns,
          patch: {},
          compensation: changeSet.compensation.descriptor,
          forward_receipt_hash: changeSet.compensation.forward_receipt_hash,
          idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
          lease,
        };
      this.transaction(() => {
        if (proposal.state === "approved") {
          this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("pending_worker", new Date().toISOString(), proposalId);
          this.appendEvent(proposalId, "proposal_pending_worker", options.runner_id ?? "local_runner", {
            proposal_hash: proposal.proposal_hash,
            proposal_version: proposal.proposal_version,
          });
        }
        const normalized = parseWritebackJob(job);
        this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(normalized.job_id, proposal.proposal_id, proposal.proposal_hash, "pending_worker", JSON.stringify(normalized), new Date().toISOString(), new Date().toISOString());
        this.appendEvent(proposal.proposal_id, "writeback_job_recorded", options.runner_id ?? "local_runner", {
          writeback_job_id: normalized.job_id,
          proposal_hash: proposal.proposal_hash,
          source_id: normalized.source_id,
        });
      });
      return job;
    },
  
  recordEvidenceBundle(input: {
      evidence_bundle_id: string;
      proposal_id?: string;
      tenant_id: string;
      payload: Record<string, unknown>;
      items?: Record<string, unknown>[];
      query_audit?: QueryAuditRecordInput[];
      created_at?: string;
    }): void {
      assertNoSecretMaterial({
        payload: input.payload,
        items: input.items ?? [],
        query_audit: input.query_audit ?? [],
      }, "evidence_bundle");
      const now = validatedRecordedAt(input.created_at, "evidence bundle");
      const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : undefined;
      const metadata = this.evidenceMetadata({ proposal, payload: input.payload, items: input.items ?? [] });
      const record = () => {
        this.db.prepare(`
          INSERT OR REPLACE INTO evidence_bundles (
            evidence_bundle_id,
            proposal_id,
            tenant_id,
            principal,
            capability,
            source_id,
            source_table,
            business_object,
            object_id,
            query_fingerprint,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.evidence_bundle_id,
          input.proposal_id ?? null,
          input.tenant_id,
          metadata.principal ?? null,
          metadata.capability ?? null,
          metadata.source_id ?? null,
          metadata.source_table ?? null,
          metadata.business_object ?? null,
          metadata.object_id ?? null,
          metadata.query_fingerprint ?? null,
          JSON.stringify(input.payload),
          now,
        );
        for (const item of input.items ?? []) {
          this.db.prepare(`
            INSERT INTO evidence_items (evidence_bundle_id, item_json, created_at)
            VALUES (?, ?, ?)
          `).run(input.evidence_bundle_id, JSON.stringify(item), now);
        }
        if (input.proposal_id) {
          this.appendEvent(input.proposal_id, "evidence_recorded", "runner", {
            evidence_bundle_id: input.evidence_bundle_id,
            item_count: input.items?.length ?? 0,
          });
        }
        for (const audit of input.query_audit ?? []) {
          if (audit.evidence_bundle_id && audit.evidence_bundle_id !== input.evidence_bundle_id) {
            throw new ProposalStoreError(
              "EVIDENCE_QUERY_AUDIT_MISMATCH",
              `query audit evidence bundle ${audit.evidence_bundle_id} does not match ${input.evidence_bundle_id}`,
            );
          }
          this.recordQueryAudit({
            ...audit,
            evidence_bundle_id: input.evidence_bundle_id,
            created_at: audit.created_at ?? now,
          });
        }
      };
      if (this.db.isTransaction) record();
      else this.transaction(record);
    },
  
  recordQueryAudit(input: QueryAuditRecordInput): void {
      assertNoSecretMaterial(input.payload, "query_audit");
      const now = validatedRecordedAt(input.created_at, "query audit");
      const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : undefined;
      const evidence = input.evidence_bundle_id ? this.getEvidenceBundle(input.evidence_bundle_id) : undefined;
      const metadata = this.queryAuditMetadata({ proposal, evidence, payload: input.payload });
      this.db.prepare(`
        INSERT INTO query_audit (
          proposal_id,
          evidence_bundle_id,
          tenant_id,
          principal,
          capability,
          business_object,
          object_id,
          primary_key_value,
          source_id,
          query_fingerprint,
          table_name,
          row_count,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.proposal_id ?? null,
        input.evidence_bundle_id ?? null,
        input.tenant_id ?? metadata.tenant_id ?? null,
        input.principal ?? metadata.principal ?? null,
        input.capability ?? metadata.capability ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.primary_key_value ?? null,
        input.source_id,
        input.query_fingerprint,
        input.table_name,
        input.row_count,
        JSON.stringify(input.payload),
        now,
      );
    },
  
  getEvidenceBundle(evidenceBundleId: string): StoredEvidenceBundle | undefined {
      const row = this.db
        .prepare("SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?")
        .get(evidenceBundleId);
      return this.rowToEvidenceBundle(row);
    },
  
  rowToEvidenceBundle(row: unknown): StoredEvidenceBundle | undefined {
      if (!isRecord(row)) return undefined;
      return {
        evidence_bundle_id: String(row.evidence_bundle_id),
        proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
        tenant_id: String(row.tenant_id),
        principal: row.principal == null ? undefined : String(row.principal),
        capability: row.capability == null ? undefined : String(row.capability),
        source_id: row.source_id == null ? undefined : String(row.source_id),
        source_table: row.source_table == null ? undefined : String(row.source_table),
        business_object: row.business_object == null ? undefined : String(row.business_object),
        object_id: row.object_id == null ? undefined : String(row.object_id),
        query_fingerprint: row.query_fingerprint == null ? undefined : String(row.query_fingerprint),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        items: this.evidenceItems(String(row.evidence_bundle_id)),
        query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
        created_at: String(row.created_at),
      };
    },
  
  events(proposalId: string): ProposalEvent[] {
      const rows = this.db
        .prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC")
        .all(proposalId);
      return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
    },
  
  listEvents(filters: EventSearchFilters = {}): ProposalEvent[] {
      const query = buildEventQuery(filters);
      const rows = this.db.prepare(query.sql).all(...query.params);
      return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
    },
};
