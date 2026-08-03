import { resolve } from "node:path";
import {
  parseWritebackJob,
  parseWritebackResult,
  type FreshnessProofV1,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import type {
  LocalProposalState,
  StoredProposal,
  ProposalEvent,
  OperatorIdentityProof,
  StoredApproval,
  ApprovalProgress,
  StoredWritebackReceipt,
  WritebackIntentStatus,
  StoredWritebackIntent,
  WritebackIntentClaim,
  ProposalReplayRecord,
  StoredEvidenceBundle,
  CloudOutboxItem,
  CloudGovernanceEvent,
  AttentionEvent,
  AttentionItem,
  NotificationDelivery,
  ProposalSearchFilters,
  EvidenceSearchFilters,
  QueryAuditSearchFilters,
  OperationalMetricRow,
  PolicyRecommendationStatus,
  PolicyRecommendation,
  CreatePolicyRecommendationInput,
  FleetEventMetricRow,
  WorkerQueueStatus,
  WorkerControlState,
  WorkerQueueItem,
  SharedLedgerEntry,
  ActiveProposalLookup,
  PolicyApprovalDecision,
  ProposalRuntimeStore,
  PostgresRuntimeClient,
  PostgresRuntimePool,
  PostgresProposalRuntimeStoreOptions,
  PostgresWritebackIntentStoreOptions,
} from "./domain-types.js";
import { isRecord } from "./common.js";
import { assertNoSecretMaterial } from "./proposal-integrity.js";
import {
  writebackIntentPayload,
  writebackIntentFromPayload,
  assertIntentMatchesJob,
  intentJobId,
} from "./record-codecs.js";
import { ProposalStoreError } from "./errors.js";
import { ProposalStore } from "./sqlite-store.js";

/**
 * Durable intent authority for fleet applies. It writes the intent ledger entry
 * before touching the source database and does not depend on the CLI's final
 * runtime-store bridge sync.
 */
export class PostgresWritebackIntentStore {
  private readonly pool: PostgresRuntimePool;
  private readonly schema: string;
  private readonly autoMigrate: boolean;
  private readonly closePool: boolean;
  private migrationPromise?: Promise<void>;

  constructor(options: PostgresWritebackIntentStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? "synapsor_runner";
    assertSafePostgresIdentifier(this.schema, "schema");
    this.autoMigrate = options.autoMigrate === true;
    this.closePool = options.closePool === true;
  }

  async close(): Promise<void> {
    if (this.closePool) await this.pool.end?.();
  }

  async claimWritebackIntent(jobInput: unknown, runnerId: string): Promise<WritebackIntentClaim> {
    const job = parseWritebackJob(jobInput);
    return await this.withIntent(job.job_id, async (client, existing) => {
      const intentId = `wbi:${job.job_id}`;
      if (existing) {
        assertIntentMatchesJob(existing, job);
        if (["applied", "already_applied", "conflict", "failed"].includes(existing.status)) {
          if (!existing.result) return { decision: "reconciliation_required", intent_id: intentId, reason: "terminal intent is missing its durable result" };
          return { decision: "existing_result", intent_id: intentId, result: existing.result };
        }
        if (existing.status === "applying" || existing.status === "reconciliation_required") {
          return { decision: "reconciliation_required", intent_id: intentId, reason: existing.reconciliation_reason ?? "a previous apply crossed the source mutation boundary without a durable terminal result" };
        }
        return { decision: "proceed", intent_id: intentId };
      }
      const now = new Date().toISOString();
      await this.writeIntent(client, {
        intent_id: intentId,
        idempotency_key: job.idempotency_key,
        writeback_job_id: job.job_id,
        proposal_id: job.proposal_id,
        proposal_hash: job.approval_id,
        runner_id: runnerId,
        operation: job.operation ?? "single_row_update",
        status: "intent_recorded",
        intent: job,
        created_at: now,
        updated_at: now,
      });
      return { decision: "proceed", intent_id: intentId };
    });
  }

  async markWritebackIntentApplying(intentId: string, runnerId: string): Promise<void> {
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.status !== "intent_recorded") throw new ProposalStoreError("WRITEBACK_INTENT_NOT_CLAIMABLE", `writeback intent ${intentId} is ${existing.status}`);
      await this.writeIntent(client, { ...existing, runner_id: runnerId, status: "applying", reconciliation_reason: undefined, updated_at: new Date().toISOString() });
    });
  }

  async completeWritebackIntent(intentId: string, resultInput: WritebackResult): Promise<void> {
    const result = parseWritebackResult(resultInput);
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.writeback_job_id !== result.job_id) throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_MISMATCH", `result ${result.job_id} does not belong to ${intentId}`);
      if (existing.result && JSON.stringify(existing.result) === JSON.stringify(result)) return;
      if (existing.status !== "applying" && existing.status !== "reconciliation_required") throw new ProposalStoreError("WRITEBACK_INTENT_COMPLETION_CONFLICT", `writeback intent ${intentId} is ${existing.status}`);
      await this.writeIntent(client, {
        ...existing,
        status: result.status as WritebackIntentStatus,
        result,
        reconciliation_reason: result.status === "reconciliation_required" ? "source outcome requires operator reconciliation" : undefined,
        updated_at: new Date().toISOString(),
      });
    });
  }

  async requireWritebackReconciliation(intentId: string, reason: string): Promise<void> {
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.status === "applied" || existing.status === "already_applied") return;
      await this.writeIntent(client, { ...existing, status: "reconciliation_required", reconciliation_reason: String(reason).slice(0, 500), updated_at: new Date().toISOString() });
    });
  }

  private async withIntent<T>(jobId: string, callback: (client: PostgresRuntimeClient, intent: StoredWritebackIntent | undefined) => Promise<T>): Promise<T> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-writeback-intent:${this.schema}:${jobId}`]);
      const qualified = `${quotePostgresIdentifier(this.schema)}.ledger_entries`;
      const selected = await client.query(`SELECT payload_json FROM ${qualified} WHERE entry_key = $1 FOR UPDATE`, [`writeback_intents:wbi:${jobId}`]);
      const intent = selected.rows[0] ? writebackIntentFromPayload(parseJsonRecord(selected.rows[0].payload_json)) : undefined;
      const result = await callback(client, intent);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.autoMigrate) return;
    if (!this.migrationPromise) {
      const attempt = this.migrateUnderLock();
      this.migrationPromise = attempt.catch((error) => {
        this.migrationPromise = undefined;
        throw error;
      });
    }
    await this.migrationPromise;
  }

  private async migrateUnderLock(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-writeback-intent:${this.schema}:migration`]);
      await client.query(sharedPostgresRuntimeStoreMigration(this.schema));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeIntent(client: PostgresRuntimeClient, intent: StoredWritebackIntent): Promise<void> {
    const payload = writebackIntentPayload(intent);
    assertNoSecretMaterial(payload, "shared_ledger.writeback_intent");
    const qualified = `${quotePostgresIdentifier(this.schema)}.ledger_entries`;
    await client.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, payload_json, created_at)
VALUES ($1, 'writeback_intent', $2, $3::jsonb, $4::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET kind = EXCLUDED.kind, proposal_id = EXCLUDED.proposal_id, payload_json = EXCLUDED.payload_json, created_at = EXCLUDED.created_at`,
      [`writeback_intents:${intent.intent_id}`, intent.proposal_id, JSON.stringify(payload), intent.created_at],
    );
  }
}

export class PostgresProposalRuntimeStore implements ProposalRuntimeStore {
  private readonly pool: PostgresRuntimePool;
  private readonly schema: string;
  private readonly lockTimeoutMs: number;
  private readonly autoMigrate: boolean;
  private readonly closePool: boolean;
  private readonly maxEntries: number;

  constructor(options: PostgresProposalRuntimeStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? "synapsor_runner";
    assertSafePostgresIdentifier(this.schema, "schema");
    this.lockTimeoutMs = Math.max(0, options.lockTimeoutMs ?? 10_000);
    this.autoMigrate = options.autoMigrate === true;
    this.closePool = options.closePool === true;
    this.maxEntries = Math.max(100, Math.min(options.maxEntries ?? 10_000, 100_000));
  }

  async close(): Promise<void> {
    if (this.closePool) await this.pool.end?.();
  }

  async recordEvidenceBundle(input: Parameters<ProposalRuntimeStore["recordEvidenceBundle"]>[0]): Promise<void> {
    await this.withWrite("recordEvidenceBundle", (store) => store.recordEvidenceBundle(input));
  }

  async recordQueryAudit(input: Parameters<ProposalRuntimeStore["recordQueryAudit"]>[0]): Promise<void> {
    await this.withWrite("recordQueryAudit", (store) => store.recordQueryAudit(input));
  }

  async findActiveProposal(input: ActiveProposalLookup): Promise<StoredProposal | undefined> {
    return await this.withRead((store) => store.findActiveProposal(input));
  }

  async createProposal(input: unknown): Promise<StoredProposal> {
    return await this.withWrite("createProposal", (store) => store.createProposal(input));
  }

  async recordFreshnessProof(input: unknown): Promise<FreshnessProofV1> {
    return await this.withWrite("recordFreshnessProof", (store) => store.recordFreshnessProof(input));
  }

  async latestFreshnessProof(proposalId: string): Promise<FreshnessProofV1 | undefined> {
    return await this.withRead((store) => store.latestFreshnessProof(proposalId));
  }

  async recordFreshnessApprovalBlocked(
    proposalId: string,
    input: Parameters<ProposalRuntimeStore["recordFreshnessApprovalBlocked"]>[1],
  ): Promise<void> {
    await this.withWrite("recordFreshnessApprovalBlocked", (store) => store.recordFreshnessApprovalBlocked(proposalId, input));
  }

  async approveProposalByPolicy(
    proposalId: string,
    options: Parameters<ProposalRuntimeStore["approveProposalByPolicy"]>[1],
  ): Promise<PolicyApprovalDecision> {
    return await this.withWrite("approveProposalByPolicy", (store) => store.approveProposalByPolicy(proposalId, options));
  }

  async getProposal(proposalId: string): Promise<StoredProposal | undefined> {
    return await this.withRead((store) => store.getProposal(proposalId));
  }

  async listProposals(filters?: LocalProposalState | ProposalSearchFilters): Promise<StoredProposal[]> {
    return await this.withRead((store) => store.listProposals(filters));
  }

  async approvals(proposalId: string): Promise<StoredApproval[]> {
    return await this.withRead((store) => store.approvals(proposalId));
  }

  async approvalProgress(proposalId: string): Promise<ApprovalProgress> {
    return await this.withRead((store) => store.approvalProgress(proposalId));
  }

  async operationalMetrics(filters: { tenant?: string; capability?: string } = {}): Promise<OperationalMetricRow[]> {
    return await this.withRead((store) => store.operationalMetrics(filters));
  }

  async fleetEventMetrics(filters: { tenant?: string; capability?: string } = {}): Promise<FleetEventMetricRow[]> {
    return await this.withRead((store) => store.fleetEventMetrics(filters));
  }

  async createPolicyRecommendation(input: CreatePolicyRecommendationInput): Promise<PolicyRecommendation> {
    return await this.withWrite("createPolicyRecommendation", (store) => store.createPolicyRecommendation(input));
  }

  async getPolicyRecommendation(recommendationId: string): Promise<PolicyRecommendation | undefined> {
    return await this.withRead((store) => store.getPolicyRecommendation(recommendationId));
  }

  async listPolicyRecommendations(filters: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus } = {}): Promise<PolicyRecommendation[]> {
    return await this.withRead((store) => store.listPolicyRecommendations(filters));
  }

  async decidePolicyRecommendation(recommendationId: string, input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string }): Promise<PolicyRecommendation> {
    return await this.withWrite("decidePolicyRecommendation", (store) => store.decidePolicyRecommendation(recommendationId, input));
  }

  async markPolicyRecommendationExported(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): Promise<PolicyRecommendation> {
    return await this.withWrite("markPolicyRecommendationExported", (store) => store.markPolicyRecommendationExported(recommendationId, input));
  }

  async events(proposalId: string): Promise<ProposalEvent[]> {
    return await this.withRead((store) => store.events(proposalId));
  }

  async receipts(proposalId: string): Promise<StoredWritebackReceipt[]> {
    return await this.withRead((store) => store.receipts(proposalId));
  }

  async getEvidenceBundle(evidenceBundleId: string): Promise<StoredEvidenceBundle | undefined> {
    return await this.withRead((store) => store.getEvidenceBundle(evidenceBundleId));
  }

  async listEvidenceBundles(filters: EvidenceSearchFilters = {}): Promise<StoredEvidenceBundle[]> {
    return await this.withRead((store) => store.listEvidenceBundles(filters));
  }

  async listQueryAudit(filters: QueryAuditSearchFilters = {}): Promise<Record<string, unknown>[]> {
    return await this.withRead((store) => store.listQueryAudit(filters));
  }

  async claimExploreBudgetReservation(
    input: Parameters<NonNullable<ProposalRuntimeStore["claimExploreBudgetReservation"]>>[0],
  ): Promise<ReturnType<ProposalStore["claimExploreBudgetReservation"]>> {
    return await this.withWrite(
      "claimExploreBudgetReservation",
      (store) => store.claimExploreBudgetReservation(input),
    );
  }

  async completeExploreBudgetReservation(
    input: Parameters<NonNullable<ProposalRuntimeStore["completeExploreBudgetReservation"]>>[0],
  ): Promise<ReturnType<ProposalStore["completeExploreBudgetReservation"]>> {
    return await this.withWrite(
      "completeExploreBudgetReservation",
      (store) => store.completeExploreBudgetReservation(input),
    );
  }

  async replay(proposalId: string): Promise<ProposalReplayRecord> {
    return await this.withWrite("replay", (store) => store.replay(proposalId));
  }

  async claimWritebackIntent(job: unknown, runnerId: string): Promise<WritebackIntentClaim> {
    return await this.withWrite("claimWritebackIntent", (store) => store.claimWritebackIntent(job, runnerId));
  }

  async markWritebackIntentApplying(intentId: string, runnerId: string): Promise<void> {
    await this.withWrite("markWritebackIntentApplying", (store) => store.markWritebackIntentApplying(intentId, runnerId));
  }

  async completeWritebackIntent(intentId: string, result: WritebackResult): Promise<void> {
    await this.withWrite("completeWritebackIntent", (store) => store.completeWritebackIntent(intentId, result));
  }

  async requireWritebackReconciliation(intentId: string, reason: string): Promise<void> {
    await this.withWrite("requireWritebackReconciliation", (store) => store.requireWritebackReconciliation(intentId, reason));
  }

  async enqueueWorkerProposal(input: Parameters<NonNullable<ProposalRuntimeStore["enqueueWorkerProposal"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("enqueueWorkerProposal", (store) => store.enqueueWorkerProposal(input));
  }

  async claimWorkerItem(input: Parameters<NonNullable<ProposalRuntimeStore["claimWorkerItem"]>>[0]): Promise<WorkerQueueItem | undefined> {
    return await this.withWrite("claimWorkerItem", (store) => store.claimWorkerItem(input));
  }

  async assertActiveWorkerLease(input: Parameters<NonNullable<ProposalRuntimeStore["assertActiveWorkerLease"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withRead((store) => store.assertActiveWorkerLease(input));
  }

  async renewWorkerLease(input: Parameters<NonNullable<ProposalRuntimeStore["renewWorkerLease"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("renewWorkerLease", (store) => store.renewWorkerLease(input));
  }

  async completeWorkerItem(
    proposalId: string,
    workerId: string,
    outcome: "applied" | "already_applied" | "conflict",
    now?: string,
    leaseId?: string,
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("completeWorkerItem", (store) =>
      store.completeWorkerItem(proposalId, workerId, outcome, now, leaseId));
  }

  async blockWorkerItem(input: Parameters<NonNullable<ProposalRuntimeStore["blockWorkerItem"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("blockWorkerItem", (store) => store.blockWorkerItem(input));
  }

  async requireWorkerReconciliation(
    input: Parameters<NonNullable<ProposalRuntimeStore["requireWorkerReconciliation"]>>[0],
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("requireWorkerReconciliation", (store) => store.requireWorkerReconciliation(input));
  }

  async workerControlState(): Promise<WorkerControlState> {
    return await this.withRead((store) => store.workerControlState());
  }

  async updateWorkerControl(
    input: Parameters<NonNullable<ProposalRuntimeStore["updateWorkerControl"]>>[0],
  ): Promise<WorkerControlState> {
    return await this.withWrite("updateWorkerControl", (store) => store.updateWorkerControl(input));
  }

  async cancelWorkerItem(
    input: Parameters<NonNullable<ProposalRuntimeStore["cancelWorkerItem"]>>[0],
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("cancelWorkerItem", (store) => store.cancelWorkerItem(input));
  }

  async listWorkerQueue(status?: WorkerQueueStatus): Promise<WorkerQueueItem[]> {
    return await this.withRead((store) => store.listWorkerQueue(status));
  }

  async getWorkerQueueItem(proposalId: string): Promise<WorkerQueueItem | undefined> {
    return await this.withRead((store) => store.getWorkerQueueItem(proposalId));
  }

  async recordAttentionEvent(input: Parameters<NonNullable<ProposalRuntimeStore["recordAttentionEvent"]>>[0]): Promise<AttentionEvent> {
    return await this.withWrite("recordAttentionEvent", (store) => store.recordAttentionEvent(input));
  }

  async listAttentionEvents(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listAttentionEvents"]>>[0] = {},
  ): Promise<AttentionEvent[]> {
    return await this.withRead((store) => store.listAttentionEvents(filters));
  }

  async getAttentionEvent(eventId: string): Promise<AttentionEvent | undefined> {
    return await this.withRead((store) => store.getAttentionEvent(eventId));
  }

  async listAttentionItems(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listAttentionItems"]>>[0] = {},
  ): Promise<AttentionItem[]> {
    return await this.withRead((store) => store.listAttentionItems(filters));
  }

  async getAttentionItem(attentionId: string): Promise<AttentionItem | undefined> {
    return await this.withRead((store) => store.getAttentionItem(attentionId));
  }

  async acknowledgeAttention(input: Parameters<NonNullable<ProposalRuntimeStore["acknowledgeAttention"]>>[0]): Promise<AttentionItem> {
    return await this.withWrite("acknowledgeAttention", (store) => store.acknowledgeAttention(input));
  }

  async resolveAttention(input: Parameters<NonNullable<ProposalRuntimeStore["resolveAttention"]>>[0]): Promise<AttentionItem> {
    return await this.withWrite("resolveAttention", (store) => store.resolveAttention(input));
  }

  async enqueueNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["enqueueNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("enqueueNotificationDelivery", (store) => store.enqueueNotificationDelivery(input));
  }

  async includeNotificationDeliveriesInDigest(
    input: Parameters<NonNullable<ProposalRuntimeStore["includeNotificationDeliveriesInDigest"]>>[0],
  ): Promise<number> {
    return await this.withWrite(
      "includeNotificationDeliveriesInDigest",
      (store) => store.includeNotificationDeliveriesInDigest(input),
    );
  }

  async claimNotificationDeliveries(
    input: Parameters<NonNullable<ProposalRuntimeStore["claimNotificationDeliveries"]>>[0],
  ): Promise<NotificationDelivery[]> {
    return await this.withWrite("claimNotificationDeliveries", (store) => store.claimNotificationDeliveries(input));
  }

  async completeNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["completeNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("completeNotificationDelivery", (store) => store.completeNotificationDelivery(input));
  }

  async failNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["failNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("failNotificationDelivery", (store) => store.failNotificationDelivery(input));
  }

  async listNotificationDeliveries(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listNotificationDeliveries"]>>[0] = {},
  ): Promise<NotificationDelivery[]> {
    return await this.withRead((store) => store.listNotificationDeliveries(filters));
  }

  async getNotificationDelivery(deliveryId: string): Promise<NotificationDelivery | undefined> {
    return await this.withRead((store) => store.getNotificationDelivery(deliveryId));
  }

  async requeueNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["requeueNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("requeueNotificationDelivery", (store) => store.requeueNotificationDelivery(input));
  }

  async enqueueCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["enqueueCloudOutbox"]>>[0]): Promise<CloudOutboxItem> {
    return await this.withWrite("enqueueCloudOutbox", (store) => store.enqueueCloudOutbox(input));
  }

  async claimCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["claimCloudOutbox"]>>[0]): Promise<CloudOutboxItem[]> {
    return await this.withWrite("claimCloudOutbox", (store) => store.claimCloudOutbox(input));
  }

  async acknowledgeCloudOutbox(eventId: string, owner: string, now?: string): Promise<CloudOutboxItem> {
    return await this.withWrite("acknowledgeCloudOutbox", (store) => store.acknowledgeCloudOutbox(eventId, owner, now));
  }

  async failCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["failCloudOutbox"]>>[0]): Promise<CloudOutboxItem> {
    return await this.withWrite("failCloudOutbox", (store) => store.failCloudOutbox(input));
  }

  async requeueCloudOutbox(eventId: string, now?: string): Promise<CloudOutboxItem> {
    return await this.withWrite("requeueCloudOutbox", (store) => store.requeueCloudOutbox(eventId, now));
  }

  async listCloudOutbox(filters: Parameters<NonNullable<ProposalRuntimeStore["listCloudOutbox"]>>[0] = {}): Promise<CloudOutboxItem[]> {
    return await this.withRead((store) => store.listCloudOutbox(filters));
  }

  async compactCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["compactCloudOutbox"]>>[0]): Promise<number> {
    return await this.withWrite("compactCloudOutbox", (store) => store.compactCloudOutbox(input));
  }

  async recordCloudGovernanceEvent(input: Parameters<NonNullable<ProposalRuntimeStore["recordCloudGovernanceEvent"]>>[0]): Promise<CloudGovernanceEvent> {
    return await this.withWrite("recordCloudGovernanceEvent", (store) => store.recordCloudGovernanceEvent(input));
  }

  async listCloudGovernanceEvents(proposalId?: string): Promise<CloudGovernanceEvent[]> {
    return await this.withRead((store) => store.listCloudGovernanceEvents(proposalId));
  }

  private async withRead<T>(callback: (store: ProposalStore) => T): Promise<T> {
    const store = await this.transientStoreFromPostgres(this.pool);
    try {
      return callback(store);
    } finally {
      store.close();
    }
  }

  private async withWrite<T>(operation: string, callback: (store: ProposalStore) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await acquirePostgresRuntimeStoreLock(client, `synapsor-runner:${this.schema}:runtime-store`, this.lockTimeoutMs);
      if (!locked) throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_LOCK_TIMEOUT", `Postgres runtime store lock is held for schema ${this.schema} while running ${operation}`);
      if (this.autoMigrate) await client.query(sharedPostgresRuntimeStoreMigration(this.schema));
      const store = await this.transientStoreFromPostgres(client);
      let result: T;
      try {
        result = callback(store);
        const entries = store.sharedLedgerEntries();
        if (entries.length > this.maxEntries) {
          throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED", `Postgres runtime store reached its configured ${this.maxEntries}-entry safety bound`);
        }
        await upsertSharedLedgerEntries(client, this.schema, entries);
      } finally {
        store.close();
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async transientStoreFromPostgres(connection: Pick<PostgresRuntimePool, "query">): Promise<ProposalStore> {
    const entries = await fetchSharedLedgerEntries(connection, this.schema, this.maxEntries);
    const store = new ProposalStore();
    store.importSharedLedgerEntries(entries);
    return store;
  }
}

export async function migrateSharedPostgresRuntimeStore(
  pool: PostgresRuntimePool,
  schema = "synapsor_runner",
  lockTimeoutMs = 10_000,
): Promise<void> {
  assertSafePostgresIdentifier(schema, "schema");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await acquirePostgresRuntimeStoreLock(client, `synapsor-runner:${schema}:runtime-store`, Math.max(0, lockTimeoutMs));
    if (!locked) throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_LOCK_TIMEOUT", `Postgres runtime store migration lock timed out for schema ${schema}`);
    await client.query(sharedPostgresRuntimeStoreMigration(schema));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function sharedPostgresRuntimeStoreMigration(schema = "synapsor_runner"): string {
  assertSafePostgresIdentifier(schema, "schema");
  const s = quotePostgresIdentifier(schema);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s};`,
    `CREATE TABLE IF NOT EXISTS ${s}.ledger_entries (`,
    "  entry_id bigserial PRIMARY KEY,",
    "  entry_key text UNIQUE NOT NULL,",
    "  kind text NOT NULL,",
    "  proposal_id text,",
    "  tenant_id text,",
    "  capability text,",
    "  payload_json jsonb NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_proposal ON ${s}.ledger_entries(proposal_id, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_tenant_capability ON ${s}.ledger_entries(tenant_id, capability, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_kind_created ON ${s}.ledger_entries(kind, created_at);`,
    `CREATE TABLE IF NOT EXISTS ${s}.proposal_locks (`,
    "  proposal_id text PRIMARY KEY,",
    "  proposal_hash text NOT NULL,",
    "  state text NOT NULL,",
    "  tenant_id text NOT NULL,",
    "  capability text NOT NULL,",
    "  updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE TABLE IF NOT EXISTS ${s}.worker_leases (`,
    "  proposal_id text PRIMARY KEY,",
    "  worker_id text NOT NULL,",
    "  lease_expires_at timestamptz NOT NULL,",
    "  attempt integer NOT NULL DEFAULT 1,",
    "  updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE TABLE IF NOT EXISTS ${s}.rate_limit_buckets (`,
    "  bucket_key text NOT NULL,",
    "  window_start bigint NOT NULL,",
    "  request_count bigint NOT NULL DEFAULT 0,",
    "  rejected_count bigint NOT NULL DEFAULT 0,",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  PRIMARY KEY (bucket_key, window_start)",
    ");",
  ].join("\n");
}

async function fetchSharedLedgerEntries(connection: Pick<PostgresRuntimePool, "query">, schema: string, maxEntries: number): Promise<SharedLedgerEntry[]> {
  const qualified = `${quotePostgresIdentifier(schema)}.ledger_entries`;
  const result = await connection.query(`
    SELECT entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at::text AS created_at
    FROM ${qualified}
    ORDER BY entry_id ASC
    LIMIT $1
  `, [maxEntries + 1]);
  if (result.rows.length > maxEntries) {
    throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED", `Postgres runtime store exceeds its configured ${maxEntries}-entry safety bound`);
  }
  return result.rows.map((row) => {
    const payload = parseJsonRecord(row.payload_json);
    return {
      entry_key: String(row.entry_key),
      kind: String(row.kind),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
      capability: row.capability == null ? undefined : String(row.capability),
      payload,
      created_at: String(row.created_at),
    };
  });
}

async function upsertSharedLedgerEntries(connection: Pick<PostgresRuntimePool, "query">, schema: string, entries: SharedLedgerEntry[]): Promise<void> {
  const qualified = `${quotePostgresIdentifier(schema)}.ledger_entries`;
  for (const entry of entries) {
    assertNoSecretMaterial(entry.payload, `shared_ledger.${entry.kind}`);
    await connection.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET
  kind = EXCLUDED.kind,
  proposal_id = EXCLUDED.proposal_id,
  tenant_id = EXCLUDED.tenant_id,
  capability = EXCLUDED.capability,
  payload_json = EXCLUDED.payload_json,
  created_at = EXCLUDED.created_at`,
      [
        entry.entry_key,
        entry.kind,
        entry.proposal_id ?? null,
        entry.tenant_id ?? null,
        entry.capability ?? null,
        JSON.stringify(entry.payload),
        entry.created_at,
      ],
    );
  }
}

async function acquirePostgresRuntimeStoreLock(client: PostgresRuntimeClient, lockKey: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [lockKey]);
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await waitFor(Math.min(250, Math.max(25, timeoutMs - (Date.now() - started))));
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  const parsed = JSON.parse(String(value ?? "{}")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function assertSafePostgresIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ProposalStoreError("INVALID_POSTGRES_IDENTIFIER", `${label} must be a simple PostgreSQL identifier`);
  }
}

function quotePostgresIdentifier(value: string): string {
  assertSafePostgresIdentifier(value, "identifier");
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function waitFor(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
