import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseChangeSet,
  parseExecutionReceipt,
  parseWritebackJob,
  parseWritebackResult,
  protocolVersions,
  type ChangeSet,
  type ExecutionReceipt,
  type ExecutionReceiptV2,
  type ExecutionReceiptV3,
  type WritebackJob,
  type WritebackJobV1,
  type WritebackJobV2,
  type WritebackJobV3,
  type WritebackResult,
} from "@synapsor-runner/protocol";

export type LocalProposalState =
  | "pending_review"
  | "approved"
  | "rejected"
  | "canceled"
  | "pending_worker"
  | "applied"
  | "conflict"
  | "failed"
  | "reconciliation_required";

export type StoredProposal = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: string;
  action: string;
  state: LocalProposalState;
  tenant_id: string;
  principal?: string;
  capability?: string;
  interaction_id?: string;
  tool_call_id?: string;
  business_object: string;
  object_id: string;
  source_kind: string;
  source_id: string;
  source_schema: string;
  source_table: string;
  source_database_mutated: boolean;
  change_set: ChangeSet;
  created_at: string;
  updated_at: string;
};

export type ProposalEvent = {
  event_id: number;
  proposal_id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type OperatorDecision = {
  schema_version: "synapsor.operator-decision.v1";
  action: "approve" | "reject" | "apply" | "reconcile" | "worker_requeue" | "worker_discard";
  proposal_id: string;
  proposal_version: number;
  proposal_hash: string;
  subject: string;
  issued_at: string;
  reason?: string;
};

export type OperatorIdentityProof = {
  provider: "dev_env" | "signed_key" | "jwt_oidc";
  verified: boolean;
  subject: string;
  roles: string[];
  key_id?: string;
  algorithm?: string;
  issuer?: string;
  decision: OperatorDecision;
  decision_hash: string;
  signature?: string;
  integrity_hash: string;
};

export type StoredApproval = {
  approval_id: number;
  proposal_id: string;
  proposal_version: number;
  proposal_hash: string;
  approver: string;
  status: "approved" | "rejected";
  reason?: string;
  identity?: OperatorIdentityProof;
  decision_hash?: string;
  signature?: string;
  integrity_hash?: string;
  created_at: string;
};

export type ApprovalProgress = {
  approved: number;
  required: number;
  remaining: number;
  rejected: boolean;
  complete: boolean;
};

export type StoredWritebackReceipt = {
  receipt_id: number;
  writeback_job_id: string;
  proposal_id: string;
  runner_id: string;
  status: string;
  idempotency_key: string;
  source_database_mutated: boolean;
  receipt: ExecutionReceipt;
  created_at: string;
  tenant_id?: string;
  principal?: string;
  capability?: string;
  business_object?: string;
  object_id?: string;
  source_id?: string;
  source_table?: string;
};

export type WritebackIntentStatus =
  | "intent_recorded"
  | "applying"
  | "applied"
  | "already_applied"
  | "conflict"
  | "failed"
  | "reconciliation_required";

export type StoredWritebackIntent = {
  intent_id: string;
  idempotency_key: string;
  writeback_job_id: string;
  proposal_id: string;
  proposal_hash: string;
  runner_id: string;
  operation: "single_row_update" | "single_row_insert" | "single_row_delete" | "set_update" | "set_delete" | "batch_insert";
  status: WritebackIntentStatus;
  intent: WritebackJob;
  result?: WritebackResult;
  reconciliation_reason?: string;
  created_at: string;
  updated_at: string;
};

export type WritebackIntentClaim =
  | { decision: "proceed"; intent_id: string }
  | { decision: "existing_result"; intent_id: string; result: WritebackResult }
  | { decision: "reconciliation_required"; intent_id: string; reason: string };

export type ReconcileWritebackIntentInput = {
  intent_id: string;
  receipt: ExecutionReceiptV2 | ExecutionReceiptV3;
  actor: string;
  reason: string;
  observation: Record<string, unknown>;
  identity?: OperatorIdentityProof;
  require_verified_identity?: boolean;
};

export type ProposalReplayRecord = {
  replay_id: string;
  proposal: StoredProposal;
  approvals: StoredApproval[];
  events: ProposalEvent[];
  receipts: StoredWritebackReceipt[];
  query_audit: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  generated_at: string;
};

export type StoredEvidenceBundle = {
  evidence_bundle_id: string;
  proposal_id?: string;
  tenant_id: string;
  principal?: string;
  capability?: string;
  source_id?: string;
  source_table?: string;
  business_object?: string;
  object_id?: string;
  query_fingerprint?: string;
  payload: Record<string, unknown>;
  items: Record<string, unknown>[];
  query_audit: Record<string, unknown>[];
  created_at: string;
};

export type LocalListOptions = {
  limit?: number;
  from?: string;
  to?: string;
};

export type ProposalSearchFilters = LocalListOptions & {
  proposal?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  action?: string;
  objectType?: string;
  objectId?: string;
  status?: LocalProposalState;
  state?: LocalProposalState;
  source?: string;
  table?: string;
};

export type EvidenceSearchFilters = LocalListOptions & {
  evidence?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  proposal?: string;
  objectType?: string;
  objectId?: string;
  source?: string;
  table?: string;
  queryFingerprint?: string;
};

export type QueryAuditSearchFilters = LocalListOptions & {
  tenant?: string;
  principal?: string;
  capability?: string;
  proposal?: string;
  evidence?: string;
  source?: string;
  table?: string;
  objectType?: string;
  objectId?: string;
  primaryKey?: string;
  queryFingerprint?: string;
};

export type ReceiptSearchFilters = LocalListOptions & {
  receipt?: string;
  proposal?: string;
  writebackJob?: string;
  idempotencyKey?: string;
  status?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  objectType?: string;
  objectId?: string;
  source?: string;
  table?: string;
};

export type EventSearchFilters = LocalListOptions & {
  proposal?: string;
  kind?: string;
  actor?: string;
};

export type StoredShadowHumanAction = {
  action_id: number;
  proposal_id: string;
  actor: string;
  patch: Record<string, unknown>;
  notes?: string;
  created_at: string;
};

export type ShadowComparison = {
  proposal_id: string;
  status: "exact_match" | "partial_match" | "mismatch" | "no_human_action";
  agent_patch: Record<string, unknown>;
  human_patch?: Record<string, unknown>;
  matching_columns: string[];
  differing_columns: string[];
  missing_from_human: string[];
  extra_human_columns: string[];
  notes?: string;
  compared_at: string;
};

export type ShadowReport = {
  total_shadow_proposals: number;
  with_human_action: number;
  exact_matches: number;
  partial_matches: number;
  mismatches: number;
  no_human_action: number;
  comparisons: ShadowComparison[];
};

export type StoreStats = {
  path: string;
  proposals: number;
  evidence_bundles: number;
  evidence_items: number;
  query_audit: number;
  writeback_receipts: number;
  writeback_jobs: number;
  writeback_intents: number;
  idempotency_receipts: number;
  replay_records: number;
  approvals: number;
  proposal_events: number;
  shadow_human_actions: number;
  worker_queue: number;
  page_count: number;
  page_size: number;
  approx_bytes: number;
};

export type StorePruneResult = {
  cutoff: string;
  dry_run: boolean;
  deleted: Record<string, number>;
};

export type OperationalMetricRow = {
  tenant_id: string;
  capability: string;
  proposals: number;
  approvals: number;
  rejections: number;
  applies: number;
  conflicts: number;
  failures: number;
};

export type FleetEventMetricRow = {
  tenant_id: string;
  capability: string;
  worker_retries: number;
  dead_letters: number;
  auto_approval_limit_trips: number;
};

export type WorkerQueueStatus = "queued" | "leased" | "retry_wait" | "completed" | "dead_letter" | "discarded";

export type WorkerQueueItem = {
  proposal_id: string;
  status: WorkerQueueStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner?: string;
  lease_expires_at?: string;
  last_error_code?: string;
  created_at: string;
  updated_at: string;
};

export type SharedLedgerEntry = {
  entry_key: string;
  kind: string;
  proposal_id?: string;
  tenant_id?: string;
  capability?: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type SharedLedgerImportResult = {
  imported: number;
  skipped: number;
};

export type CreateWritebackJobOptions = {
  project_id?: string;
  runner_id?: string;
  lease_seconds?: number;
  lease_id?: string;
  attempt?: number;
};

export type ActiveProposalLookup = {
  tenant_id: string;
  action: string;
  business_object: string;
  object_id: string;
};

export type PolicyApprovalLimit = {
  kind: "count" | "total";
  max: number;
  period: "day";
  field?: string;
  scope?: "tenant_policy" | "tenant_policy_object";
};

export type PolicyApprovalLimitTrip = PolicyApprovalLimit & {
  observed: number;
  proposed: number;
  projected: number;
  window_start: string;
  window_end: string;
  reason: string;
};

export type PolicyApprovalDecision = {
  proposal: StoredProposal;
  approved: boolean;
  policy: string;
  tripped_limits: PolicyApprovalLimitTrip[];
};

export type MaybePromise<T> = T | Promise<T>;

// MCP serving depends on this narrow async-capable contract instead of the
// concrete SQLite class. A primary Postgres runtime store must implement this
// surface before it can replace SQLite for live proposal/evidence/replay state.
export type ProposalRuntimeStore = {
  close(): MaybePromise<void>;
  recordEvidenceBundle(input: {
    evidence_bundle_id: string;
    proposal_id?: string;
    tenant_id: string;
    principal?: string;
    capability?: string;
    source_id?: string;
    source_table?: string;
    business_object?: string;
    object_id?: string;
    query_fingerprint?: string;
    payload: Record<string, unknown>;
    items?: Record<string, unknown>[];
    query_audit?: Record<string, unknown>[];
  }): MaybePromise<void>;
  recordQueryAudit(input: {
    proposal_id?: string;
    evidence_bundle_id?: string;
    tenant_id?: string;
    principal?: string;
    capability?: string;
    source_id: string;
    query_fingerprint: string;
    table_name: string;
    business_object?: string;
    object_id?: string;
    primary_key_value?: string;
    row_count: number;
    payload: Record<string, unknown>;
  }): MaybePromise<void>;
  findActiveProposal(input: ActiveProposalLookup): MaybePromise<StoredProposal | undefined>;
  createProposal(input: unknown): MaybePromise<StoredProposal>;
  approveProposalByPolicy(
    proposalId: string,
    options: {
      policy: string;
      proposal_hash: string;
      proposal_version: number;
      reason: string;
      limits?: PolicyApprovalLimit[];
      now?: string;
    },
  ): MaybePromise<PolicyApprovalDecision>;
  getProposal(proposalId: string): MaybePromise<StoredProposal | undefined>;
  approvalProgress?(proposalId: string): MaybePromise<ApprovalProgress>;
  operationalMetrics?(filters?: { tenant?: string; capability?: string }): MaybePromise<OperationalMetricRow[]>;
  fleetEventMetrics?(filters?: { tenant?: string; capability?: string }): MaybePromise<FleetEventMetricRow[]>;
  events(proposalId: string): MaybePromise<ProposalEvent[]>;
  receipts(proposalId: string): MaybePromise<StoredWritebackReceipt[]>;
  getEvidenceBundle(evidenceBundleId: string): MaybePromise<StoredEvidenceBundle | undefined>;
  replay(proposalId: string): MaybePromise<ProposalReplayRecord>;
  claimWritebackIntent?(job: WritebackJob, runnerId: string): MaybePromise<WritebackIntentClaim>;
  markWritebackIntentApplying?(intentId: string, runnerId: string): MaybePromise<void>;
  completeWritebackIntent?(intentId: string, result: WritebackResult): MaybePromise<void>;
  requireWritebackReconciliation?(intentId: string, reason: string): MaybePromise<void>;
};

export type PostgresRuntimeQueryResult = {
  rows: Record<string, unknown>[];
};

export type PostgresRuntimeClient = {
  query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult>;
  release(): void;
};

export type PostgresRuntimePool = {
  connect(): Promise<PostgresRuntimeClient>;
  query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult>;
  end?(): Promise<void>;
};

export type PostgresProposalRuntimeStoreOptions = {
  pool: PostgresRuntimePool;
  schema?: string;
  lockTimeoutMs?: number;
  autoMigrate?: boolean;
  closePool?: boolean;
  maxEntries?: number;
};

export type PostgresWritebackIntentStoreOptions = {
  pool: PostgresRuntimePool;
  schema?: string;
  autoMigrate?: boolean;
  closePool?: boolean;
};

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

  async approveProposalByPolicy(
    proposalId: string,
    options: Parameters<ProposalRuntimeStore["approveProposalByPolicy"]>[1],
  ): Promise<PolicyApprovalDecision> {
    return await this.withWrite("approveProposalByPolicy", (store) => store.approveProposalByPolicy(proposalId, options));
  }

  async getProposal(proposalId: string): Promise<StoredProposal | undefined> {
    return await this.withRead((store) => store.getProposal(proposalId));
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

  async events(proposalId: string): Promise<ProposalEvent[]> {
    return await this.withRead((store) => store.events(proposalId));
  }

  async receipts(proposalId: string): Promise<StoredWritebackReceipt[]> {
    return await this.withRead((store) => store.receipts(proposalId));
  }

  async getEvidenceBundle(evidenceBundleId: string): Promise<StoredEvidenceBundle | undefined> {
    return await this.withRead((store) => store.getEvidenceBundle(evidenceBundleId));
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

export type RecordHandlerWritebackJobInput = {
  writeback_job_id: string;
  proposal_id: string;
  proposal_hash: string;
  runner_id: string;
  executor: string;
  request: Record<string, unknown>;
};

export class ProposalStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

export class ProposalStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = ":memory:") {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:" && process.platform !== "win32") {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        process.stderr.write(`warning: unable to restrict Synapsor store permissions to 0600: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  stats(): StoreStats {
    const pageCount = this.numberValue("PRAGMA page_count");
    const pageSize = this.numberValue("PRAGMA page_size");
    return {
      path: this.path,
      proposals: this.countTable("proposals"),
      evidence_bundles: this.countTable("evidence_bundles"),
      evidence_items: this.countTable("evidence_items"),
      query_audit: this.countTable("query_audit"),
      writeback_receipts: this.countTable("writeback_receipts"),
      writeback_jobs: this.countTable("writeback_jobs"),
      writeback_intents: this.countTable("writeback_intents"),
      idempotency_receipts: this.countTable("idempotency_receipts"),
      replay_records: this.countTable("replay_records"),
      approvals: this.countTable("approvals"),
      proposal_events: this.countTable("proposal_events"),
      shadow_human_actions: this.countTable("shadow_human_actions"),
      worker_queue: this.countTable("worker_queue"),
      page_count: pageCount,
      page_size: pageSize,
      approx_bytes: pageCount * pageSize,
    };
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  pruneBefore(cutoffIso: string, options: { dryRun?: boolean } = {}): StorePruneResult {
    const dryRun = options.dryRun !== false;
    const proposalIds = this.stringColumn(
      "SELECT proposal_id FROM proposals WHERE created_at < ? AND state IN ('applied', 'conflict', 'rejected', 'canceled')",
      [cutoffIso],
      "proposal_id",
    );
    const evidenceIds = this.evidenceIdsForPrune(cutoffIso, proposalIds);
    const deleted: Record<string, number> = {};
    const run = (table: string, where: string, params: SQLInputValue[]) => {
      deleted[table] = this.countWhere(table, where, params);
      if (!dryRun && deleted[table] > 0) this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
    };
    const proposalWhere = inWhere("proposal_id", proposalIds);
    const evidenceWhere = inWhere("evidence_bundle_id", evidenceIds);
    this.transaction(() => {
      if (proposalWhere) {
        run("idempotency_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_jobs", proposalWhere.sql, proposalWhere.params);
        run("writeback_intents", proposalWhere.sql, proposalWhere.params);
        run("approvals", proposalWhere.sql, proposalWhere.params);
        run("proposal_events", proposalWhere.sql, proposalWhere.params);
        run("shadow_human_actions", proposalWhere.sql, proposalWhere.params);
        run("worker_queue", proposalWhere.sql, proposalWhere.params);
        run("replay_records", proposalWhere.sql, proposalWhere.params);
      } else {
        for (const table of ["idempotency_receipts", "writeback_receipts", "writeback_jobs", "writeback_intents", "approvals", "proposal_events", "shadow_human_actions", "worker_queue", "replay_records"]) {
          deleted[table] = 0;
        }
      }
      const auditClauses: string[] = [];
      const auditParams: SQLInputValue[] = [];
      if (proposalWhere) {
        auditClauses.push(proposalWhere.sql);
        auditParams.push(...proposalWhere.params);
      }
      if (evidenceWhere) {
        auditClauses.push(evidenceWhere.sql);
        auditParams.push(...evidenceWhere.params);
      }
      auditClauses.push("(proposal_id IS NULL AND evidence_bundle_id IS NULL AND created_at < ?)");
      auditParams.push(cutoffIso);
      run("query_audit", auditClauses.map((clause) => `(${clause})`).join(" OR "), auditParams);
      if (evidenceWhere) {
        run("evidence_items", evidenceWhere.sql, evidenceWhere.params);
        run("evidence_bundles", evidenceWhere.sql, evidenceWhere.params);
      } else {
        deleted.evidence_items = 0;
        deleted.evidence_bundles = 0;
      }
      if (proposalWhere) run("proposals", proposalWhere.sql, proposalWhere.params);
      else deleted.proposals = 0;
    });
    return { cutoff: cutoffIso, dry_run: dryRun, deleted };
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS proposal_store_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        proposal_version INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        state TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        business_object TEXT NOT NULL,
        object_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_schema TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_database_mutated INTEGER NOT NULL DEFAULT 0,
        change_set_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposal_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        approver TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        identity_json TEXT,
        decision_hash TEXT,
        signature TEXT,
        integrity_hash TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS writeback_receipts (
        receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        writeback_job_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_database_mutated INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (writeback_job_id, idempotency_key),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_bundles (
        evidence_bundle_id TEXT PRIMARY KEY,
        proposal_id TEXT,
        tenant_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_items (
        evidence_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_bundle_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
      );

      CREATE TABLE IF NOT EXISTS query_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT,
        evidence_bundle_id TEXT,
        source_id TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
        FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
      );

      CREATE TABLE IF NOT EXISTS writeback_jobs (
        writeback_job_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS idempotency_receipts (
        idempotency_key TEXT PRIMARY KEY,
        writeback_job_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        receipt_status TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (writeback_job_id) REFERENCES writeback_jobs(writeback_job_id),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS writeback_intents (
        intent_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        writeback_job_id TEXT UNIQUE NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        result_json TEXT,
        reconciliation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS replay_records (
        replay_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS shadow_human_actions (
        action_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS runner_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_queue (
        proposal_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_query_audit_proposal_id ON query_audit(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_proposal_id ON writeback_receipts(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_writeback_intents_proposal_id ON writeback_intents(proposal_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_writeback_intents_status_updated ON writeback_intents(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_replay_records_proposal_id ON replay_records(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_human_actions_proposal_id ON shadow_human_actions(proposal_id);

      INSERT OR IGNORE INTO proposal_store_schema(version, applied_at)
      VALUES (1, datetime('now'));
    `);
    this.ensureSearchColumns();
    this.backfillSearchColumns();
    this.ensureSearchIndexes();
  }

  private ensureSearchColumns(): void {
    this.ensureColumn("proposals", "principal", "TEXT");
    this.ensureColumn("proposals", "capability", "TEXT");
    this.ensureColumn("proposals", "interaction_id", "TEXT");
    this.ensureColumn("proposals", "tool_call_id", "TEXT");
    this.ensureColumn("evidence_bundles", "principal", "TEXT");
    this.ensureColumn("evidence_bundles", "capability", "TEXT");
    this.ensureColumn("evidence_bundles", "source_id", "TEXT");
    this.ensureColumn("evidence_bundles", "source_table", "TEXT");
    this.ensureColumn("evidence_bundles", "business_object", "TEXT");
    this.ensureColumn("evidence_bundles", "object_id", "TEXT");
    this.ensureColumn("evidence_bundles", "query_fingerprint", "TEXT");
    this.ensureColumn("query_audit", "tenant_id", "TEXT");
    this.ensureColumn("query_audit", "principal", "TEXT");
    this.ensureColumn("query_audit", "capability", "TEXT");
    this.ensureColumn("query_audit", "business_object", "TEXT");
    this.ensureColumn("query_audit", "object_id", "TEXT");
    this.ensureColumn("query_audit", "primary_key_value", "TEXT");
    this.ensureColumn("approvals", "identity_json", "TEXT");
    this.ensureColumn("approvals", "decision_hash", "TEXT");
    this.ensureColumn("approvals", "signature", "TEXT");
    this.ensureColumn("approvals", "integrity_hash", "TEXT");
  }

  private ensureSearchIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_tenant_created ON proposals(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_action_created ON proposals(action, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_capability_created ON proposals(capability, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_principal_created ON proposals(principal, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_object_created ON proposals(business_object, object_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_state_created ON proposals(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_source_table_created ON proposals(source_id, source_table, created_at);

      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_tenant_created ON evidence_bundles(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_proposal_id ON evidence_bundles(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_created ON evidence_bundles(created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_capability_created ON evidence_bundles(capability, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_principal_created ON evidence_bundles(principal, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_object_created ON evidence_bundles(business_object, object_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_source_table_created ON evidence_bundles(source_id, source_table, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_fingerprint_created ON evidence_bundles(query_fingerprint, created_at);

      CREATE INDEX IF NOT EXISTS idx_evidence_items_bundle_id ON evidence_items(evidence_bundle_id);

      CREATE INDEX IF NOT EXISTS idx_query_audit_evidence_id ON query_audit(evidence_bundle_id);
      CREATE INDEX IF NOT EXISTS idx_query_audit_source_table_created ON query_audit(source_id, table_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_fingerprint_created ON query_audit(query_fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_created ON query_audit(created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_tenant_created ON query_audit(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_capability_created ON query_audit(capability, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_principal_created ON query_audit(principal, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_object_created ON query_audit(business_object, object_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_query_audit_primary_key_created ON query_audit(primary_key_value, created_at);

      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_writeback_job ON writeback_receipts(writeback_job_id);
      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_idempotency_key ON writeback_receipts(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_status_created ON writeback_receipts(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_replay_records_created ON replay_records(created_at);

      CREATE INDEX IF NOT EXISTS idx_approvals_proposal_id ON approvals(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_proposal_events_kind_created ON proposal_events(kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_worker_queue_claim ON worker_queue(status, next_attempt_at, lease_expires_at, created_at);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => isRecord(row) && row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private backfillSearchColumns(): void {
    const proposals = this.db.prepare("SELECT proposal_id, action, change_set_json FROM proposals").all();
    for (const row of proposals) {
      if (!isRecord(row)) continue;
      try {
        const changeSet = parseChangeSet(JSON.parse(String(row.change_set_json)));
        this.db.prepare("UPDATE proposals SET principal = COALESCE(principal, ?), capability = COALESCE(capability, ?) WHERE proposal_id = ?")
          .run(changeSet.principal.id, changeSet.action, String(row.proposal_id));
      } catch {
        // Leave old malformed rows untouched; normal accessors will still validate when read.
      }
    }

    const evidenceRows = this.db.prepare("SELECT evidence_bundle_id, proposal_id, payload_json FROM evidence_bundles").all();
    for (const row of evidenceRows) {
      if (!isRecord(row)) continue;
      const proposal = row.proposal_id == null ? undefined : this.getProposal(String(row.proposal_id));
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const metadata = this.evidenceMetadata({
        proposal,
        payload,
        items: this.evidenceItems(String(row.evidence_bundle_id)).map((item) => item.item as Record<string, unknown>),
      });
      this.db.prepare(`
        UPDATE evidence_bundles
        SET principal = COALESCE(principal, ?),
            capability = COALESCE(capability, ?),
            source_id = COALESCE(source_id, ?),
            source_table = COALESCE(source_table, ?),
            business_object = COALESCE(business_object, ?),
            object_id = COALESCE(object_id, ?),
            query_fingerprint = COALESCE(query_fingerprint, ?)
        WHERE evidence_bundle_id = ?
      `).run(
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.source_id ?? null,
        metadata.source_table ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.query_fingerprint ?? null,
        String(row.evidence_bundle_id),
      );
    }

    const auditRows = this.db.prepare("SELECT audit_id, proposal_id, evidence_bundle_id, payload_json FROM query_audit").all();
    for (const row of auditRows) {
      if (!isRecord(row)) continue;
      const proposal = row.proposal_id == null ? undefined : this.getProposal(String(row.proposal_id));
      const evidence = row.evidence_bundle_id == null ? undefined : this.getEvidenceBundle(String(row.evidence_bundle_id));
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const metadata = this.queryAuditMetadata({ proposal, evidence, payload });
      this.db.prepare(`
        UPDATE query_audit
        SET tenant_id = COALESCE(tenant_id, ?),
            principal = COALESCE(principal, ?),
            capability = COALESCE(capability, ?),
            business_object = COALESCE(business_object, ?),
            object_id = COALESCE(object_id, ?),
            primary_key_value = COALESCE(primary_key_value, ?)
        WHERE audit_id = ?
      `).run(
        metadata.tenant_id ?? null,
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.primary_key_value ?? null,
        Number(row.audit_id),
      );
    }
  }

  createProposal(input: unknown): StoredProposal {
    const changeSet = parseChangeSet(input);
    assertNoSecretMaterial(changeSet, "change_set");
    const existing = this.getProposal(changeSet.proposal_id);
    if (existing) {
      if (
        existing.proposal_version !== changeSet.proposal_version ||
        existing.proposal_hash !== changeSet.integrity.proposal_hash
      ) {
        throw new ProposalStoreError(
          "PROPOSAL_IMMUTABILITY_VIOLATION",
          `proposal ${changeSet.proposal_id} already exists with a different version or hash`,
        );
      }
      return existing;
    }

    const active = this.findActiveProposal({
      tenant_id: changeSet.scope.tenant_id,
      action: changeSet.action,
      business_object: changeSet.scope.business_object,
      object_id: changeSet.scope.object_id,
    });
    if (active) {
      throw new ProposalStoreError(
        "PROPOSAL_ALREADY_EXISTS",
        `active proposal ${active.proposal_id} is ${active.state} for ${active.business_object}:${active.object_id}`,
      );
    }

    const state = stateFromChangeSet(changeSet);
    const now = changeSet.created_at || new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO proposals (
        proposal_id,
        proposal_version,
        proposal_hash,
        action,
        state,
        tenant_id,
        principal,
        capability,
        interaction_id,
        tool_call_id,
        business_object,
        object_id,
        source_kind,
        source_id,
        source_schema,
        source_table,
        source_database_mutated,
        change_set_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      insert.run(
        changeSet.proposal_id,
        changeSet.proposal_version,
        changeSet.integrity.proposal_hash,
        changeSet.action,
        state,
        changeSet.scope.tenant_id,
        changeSet.principal.id,
        changeSet.action,
        null,
        null,
        changeSet.scope.business_object,
        changeSet.scope.object_id,
        changeSet.source.kind,
        changeSet.source.source_id,
        changeSet.source.schema,
        changeSet.source.table,
        changeSet.source_database_mutated ? 1 : 0,
        JSON.stringify(changeSet),
        now,
        now,
      );
      this.appendEvent(changeSet.proposal_id, "proposal_created", changeSet.principal.id, {
        proposal_hash: changeSet.integrity.proposal_hash,
        proposal_version: changeSet.proposal_version,
        source_database_mutated: changeSet.source_database_mutated,
      });
    });
    const created = this.getProposal(changeSet.proposal_id);
    if (!created) {
      throw new ProposalStoreError("PROPOSAL_CREATE_FAILED", `proposal ${changeSet.proposal_id} was not persisted`);
    }
    return created;
  }

  getProposal(proposalId: string): StoredProposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    return rowToProposal(row);
  }

  findActiveProposal(input: ActiveProposalLookup): StoredProposal | undefined {
    const row = this.db.prepare(`
      SELECT * FROM proposals
      WHERE tenant_id = ?
        AND action = ?
        AND business_object = ?
        AND object_id = ?
        AND state IN ('pending_review', 'approved', 'pending_worker')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.tenant_id, input.action, input.business_object, input.object_id);
    return rowToProposal(row);
  }

  listProposals(filters?: LocalProposalState | ProposalSearchFilters): StoredProposal[] {
    if (typeof filters === "string") filters = { state: filters };
    const query = buildProposalQuery(filters ?? {});
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => rowToProposal(row)).filter((proposal): proposal is StoredProposal => proposal !== undefined);
  }

  listEvidenceBundles(filters: EvidenceSearchFilters = {}): StoredEvidenceBundle[] {
    const query = buildEvidenceQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => this.rowToEvidenceBundle(row)).filter((evidence): evidence is StoredEvidenceBundle => evidence !== undefined);
  }

  listQueryAudit(filters: QueryAuditSearchFilters = {}): Record<string, unknown>[] {
    const query = buildQueryAuditQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
  }

  getQueryAudit(auditId: number): Record<string, unknown> | undefined {
    return rowToQueryAudit(this.db.prepare("SELECT * FROM query_audit WHERE audit_id = ?").get(auditId));
  }

  listReceipts(filters: ReceiptSearchFilters = {}): StoredWritebackReceipt[] {
    const query = buildReceiptQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
  }

  getReceipt(receiptId: number): StoredWritebackReceipt | undefined {
    return rowToReceipt(this.db.prepare("SELECT * FROM writeback_receipts WHERE receipt_id = ?").get(receiptId));
  }

  getReplayByReplayId(replayId: string): ProposalReplayRecord {
    const prefix = "replay_";
    const proposalId = replayId.startsWith(prefix) ? replayId.slice(prefix.length) : replayId;
    return this.replay(proposalId);
  }

  proposalIdForEvidence(evidenceBundleId: string): string | undefined {
    const evidence = this.getEvidenceBundle(evidenceBundleId);
    if (evidence?.proposal_id) return evidence.proposal_id;
    const row = this.db
      .prepare("SELECT proposal_id FROM query_audit WHERE evidence_bundle_id = ? AND proposal_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
      .get(evidenceBundleId);
    return isRecord(row) && row.proposal_id != null ? String(row.proposal_id) : undefined;
  }

  approveProposal(
    proposalId: string,
    options: {
      approver: string;
      proposal_hash: string;
      proposal_version: number;
      reason?: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
    },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "approved");
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review") {
      throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
    }
    assertOperatorDecision(proposal, "approve", options.approver, options.identity, options.require_verified_identity === true);
    const now = new Date().toISOString();
    this.transaction(() => {
      const current = this.requireProposal(proposalId);
      if (current.state !== "pending_review") {
        throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${current.state}`);
      }
      const existing = this.db.prepare(`
        SELECT status FROM approvals WHERE proposal_id = ? AND approver = ? ORDER BY approval_id DESC LIMIT 1
      `).get(proposalId, options.approver);
      if (isRecord(existing)) {
        throw new ProposalStoreError("APPROVER_ALREADY_COUNTED", `operator ${options.approver} already recorded a decision for proposal ${proposalId}`);
      }
      this.db.prepare(`
        INSERT INTO approvals (
          proposal_id, proposal_version, proposal_hash, approver, status, reason,
          identity_json, decision_hash, signature, integrity_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposalId,
        options.proposal_version,
        options.proposal_hash,
        options.approver,
        "approved",
        options.reason ?? null,
        options.identity ? JSON.stringify(options.identity) : null,
        options.identity?.decision_hash ?? null,
        options.identity?.signature ?? null,
        options.identity?.integrity_hash ?? null,
        now,
      );
      const progress = this.approvalProgress(proposalId);
      const complete = progress.approved >= progress.required;
      if (complete) {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      }
      this.appendEvent(proposalId, complete ? "proposal_approved" : "proposal_approval_recorded", options.approver, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason ?? null,
        identity: publicIdentitySummary(options.identity),
        approvals: progress.approved,
        required_approvals: progress.required,
        remaining_approvals: progress.remaining,
      });
    });
    return this.requireProposal(proposalId);
  }

  approveProposalByPolicy(
    proposalId: string,
    options: {
      policy: string;
      proposal_hash: string;
      proposal_version: number;
      reason: string;
      limits?: PolicyApprovalLimit[];
      now?: string;
    },
  ): PolicyApprovalDecision {
    const actor = `policy:${options.policy}`;
    const now = options.now ?? new Date().toISOString();
    const window = utcDayWindow(now);
    const trippedLimits: PolicyApprovalLimitTrip[] = [];
    let quorumDeferred = false;
    this.transaction(() => {
      const proposal = this.requireProposal(proposalId);
      assertWritebackAllowed(proposal, "approved by policy");
      assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
      if (proposal.state !== "pending_review") {
        throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
      }
      const requiredApprovals = requiredApprovalCount(proposal);
      if (requiredApprovals > 1) {
        quorumDeferred = true;
        this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
          policy: options.policy,
          fallback: "human_review",
          reason: "multi_reviewer_quorum_requires_verified_human_approvals",
          approvals: 0,
          required_approvals: requiredApprovals,
        });
        return;
      }
      for (const limit of options.limits ?? []) {
        const scope = limit.scope ?? "tenant_policy";
        const rows = this.db.prepare(`
          SELECT p.change_set_json
          FROM approvals a
          JOIN proposals p ON p.proposal_id = a.proposal_id
          WHERE a.approver = ?
            AND a.status = 'approved'
            AND p.tenant_id = ?
            AND a.created_at >= ?
            AND a.created_at < ?
            ${scope === "tenant_policy_object" ? "AND p.business_object = ? AND p.object_id = ?" : ""}
        `).all(
          actor,
          proposal.tenant_id,
          window.start,
          window.end,
          ...(scope === "tenant_policy_object" ? [proposal.business_object, proposal.object_id] : []),
        );
        if (limit.kind === "count") {
          const projected = rows.length + 1;
          if (projected > limit.max) {
            trippedLimits.push({
              ...limit,
              scope,
              observed: rows.length,
              proposed: 1,
              projected,
              window_start: window.start,
              window_end: window.end,
              reason: `${scope} daily auto-approval count ${projected} exceeds ${limit.max}`,
            });
          }
          continue;
        }
        const field = limit.field;
        const proposed = field ? proposal.change_set.patch[field] : undefined;
        let observed = 0;
        let invalidHistory = false;
        for (const row of rows) {
          if (!isRecord(row)) {
            invalidHistory = true;
            continue;
          }
          try {
            const historical = parseChangeSet(JSON.parse(String(row.change_set_json)));
            const value = field ? historical.patch[field] : undefined;
            if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidHistory = true;
            else observed += value;
          } catch {
            invalidHistory = true;
          }
        }
        const proposedNumber = typeof proposed === "number" && Number.isSafeInteger(proposed) ? proposed : 0;
        const projected = observed + proposedNumber;
        if (!field || invalidHistory || typeof proposed !== "number" || !Number.isSafeInteger(proposed) || projected > limit.max) {
          trippedLimits.push({
            ...limit,
            scope,
            observed,
            proposed: proposedNumber,
            projected,
            window_start: window.start,
            window_end: window.end,
            reason: invalidHistory || !field || typeof proposed !== "number" || !Number.isSafeInteger(proposed)
              ? `${scope} daily auto-approval total could not be verified safely${field ? ` for ${field}` : ""}`
              : `${scope} daily auto-approval total ${projected} for ${field} exceeds ${limit.max}`,
          });
        }
      }
      if (trippedLimits.length > 0) {
        this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
          policy: options.policy,
          fallback: "human_review",
          tripped_limits: trippedLimits,
        });
        return;
      }
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (proposal_id, proposal_version, proposal_hash, approver, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proposalId, options.proposal_version, options.proposal_hash, actor, "approved", options.reason, now);
      this.appendEvent(proposalId, "proposal_approved", actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
        policy: options.policy,
        aggregate_limits: options.limits ?? [],
      });
    });
    return {
      proposal: this.requireProposal(proposalId),
      approved: !quorumDeferred && trippedLimits.length === 0,
      policy: options.policy,
      tripped_limits: trippedLimits,
    };
  }

  rejectProposal(
    proposalId: string,
    options: {
      actor: string;
      proposal_hash: string;
      proposal_version: number;
      reason: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
    },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review" && proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_REJECTABLE", `proposal ${proposalId} is ${proposal.state}`);
    }
    assertOperatorDecision(proposal, "reject", options.actor, options.identity, options.require_verified_identity === true);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("rejected", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (
          proposal_id, proposal_version, proposal_hash, approver, status, reason,
          identity_json, decision_hash, signature, integrity_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposalId,
        options.proposal_version,
        options.proposal_hash,
        options.actor,
        "rejected",
        options.reason,
        options.identity ? JSON.stringify(options.identity) : null,
        options.identity?.decision_hash ?? null,
        options.identity?.signature ?? null,
        options.identity?.integrity_hash ?? null,
        now,
      );
      this.appendEvent(proposalId, "proposal_rejected", options.actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
        identity: publicIdentitySummary(options.identity),
      });
    });
    return this.requireProposal(proposalId);
  }

  approvals(proposalId: string): StoredApproval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? ORDER BY approval_id ASC")
      .all(proposalId)
      .map(rowToApproval)
      .filter((approval): approval is StoredApproval => approval !== undefined);
  }

  approvalProgress(proposalId: string): ApprovalProgress {
    const proposal = this.requireProposal(proposalId);
    const required = requiredApprovalCount(proposal);
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN status = 'approved' THEN approver END) AS approved,
        MAX(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM approvals
      WHERE proposal_id = ?
    `).get(proposalId);
    const approved = isRecord(row) ? Number(row.approved ?? 0) : 0;
    const rejected = proposal.state === "rejected" || (isRecord(row) && Number(row.rejected ?? 0) === 1);
    return {
      approved,
      required,
      remaining: Math.max(0, required - approved),
      rejected,
      complete: !rejected && approved >= required,
    };
  }

  recordOperatorAuthorization(proposalId: string, identity: OperatorIdentityProof, requireVerifiedIdentity = false): void {
    const proposal = this.requireProposal(proposalId);
    assertOperatorDecision(proposal, "apply", identity.subject, identity, requireVerifiedIdentity);
    this.appendEvent(proposalId, "writeback_authorized", identity.subject, {
      identity: publicIdentitySummary(identity),
      decision_hash: identity.decision_hash,
      signature: identity.signature,
      integrity_hash: identity.integrity_hash,
    });
  }

  markPendingWorker(proposalId: string, proposalHash: string, proposalVersion: number): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "moved to pending worker");
    assertProposalIdentity(proposal, proposalHash, proposalVersion);
    if (proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    this.setState(proposalId, "pending_worker", "runner", { proposal_hash: proposalHash, proposal_version: proposalVersion });
    return this.requireProposal(proposalId);
  }

  recordExecutionReceipt(input: unknown): StoredProposal {
    const receipt = parseExecutionReceipt(input);
    const proposal = this.requireProposal(receipt.proposal_id);
    assertWritebackAllowed(proposal, "recorded with an execution receipt");
    this.transaction(() => {
      this.recordExecutionReceiptRows(receipt, proposal);
    });
    return this.requireProposal(receipt.proposal_id);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  getWritebackIntent(intentId: string): StoredWritebackIntent | undefined {
    return rowToWritebackIntent(this.db.prepare("SELECT * FROM writeback_intents WHERE intent_id = ?").get(intentId));
  }

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
  }

  reconcileWritebackIntent(input: ReconcileWritebackIntentInput): StoredWritebackIntent {
    const intent = this.requireWritebackIntent(input.intent_id);
    const proposal = this.requireProposal(intent.proposal_id);
    const receipt = parseExecutionReceipt(input.receipt);
    if (receipt.schema_version !== protocolVersions.executionReceiptV2 && receipt.schema_version !== protocolVersions.executionReceiptV3) throw new ProposalStoreError("RECONCILIATION_RECEIPT_VERSION_REQUIRED", "reconciliation requires an execution-receipt v2 or v3");
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
    });
    return this.requireWritebackIntent(intent.intent_id);
  }

  private requireWritebackIntent(intentId: string): StoredWritebackIntent {
    const intent = this.getWritebackIntent(intentId);
    if (!intent) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
    return intent;
  }

  private recordExecutionReceiptRows(receipt: ExecutionReceipt, proposal: StoredProposal): void {
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
    });
  }

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
  }

  createWritebackJobFromProposal(proposalId: string, options: CreateWritebackJobOptions = {}): WritebackJobV1 | WritebackJobV2 | WritebackJobV3 {
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
      allowed_columns: changeSet.guards.allowed_columns,
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      lease,
    } as const;
    const job: WritebackJobV1 | WritebackJobV2 | WritebackJobV3 = changeSet.schema_version === protocolVersions.changeSet
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
      } : {
        schema_version: protocolVersions.writebackJobV3,
        ...common,
        operation: changeSet.operation,
        target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
        patch: changeSet.patch,
        ...(changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {}),
        frozen_set: changeSet.frozen_set,
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
  }

  recordEvidenceBundle(input: {
    evidence_bundle_id: string;
    proposal_id?: string;
    tenant_id: string;
    payload: Record<string, unknown>;
    items?: Record<string, unknown>[];
  }): void {
    assertNoSecretMaterial({ payload: input.payload, items: input.items ?? [] }, "evidence_bundle");
    const now = new Date().toISOString();
    const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : undefined;
    const metadata = this.evidenceMetadata({ proposal, payload: input.payload, items: input.items ?? [] });
    this.transaction(() => {
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
    });
  }

  recordQueryAudit(input: {
    proposal_id?: string;
    evidence_bundle_id?: string;
    source_id: string;
    query_fingerprint: string;
    table_name: string;
    row_count: number;
    payload: Record<string, unknown>;
  }): void {
    assertNoSecretMaterial(input.payload, "query_audit");
    const now = new Date().toISOString();
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
      metadata.tenant_id ?? null,
      metadata.principal ?? null,
      metadata.capability ?? null,
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
  }

  getEvidenceBundle(evidenceBundleId: string): StoredEvidenceBundle | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?")
      .get(evidenceBundleId);
    return this.rowToEvidenceBundle(row);
  }

  private rowToEvidenceBundle(row: unknown): StoredEvidenceBundle | undefined {
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
  }

  events(proposalId: string): ProposalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC")
      .all(proposalId);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
  }

  listEvents(filters: EventSearchFilters = {}): ProposalEvent[] {
    const query = buildEventQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
  }

  enqueueApprovedForWorker(options: {
    capability?: string;
    tenant?: string;
    maxAttempts?: number;
    limit?: number;
    now?: string;
  } = {}): WorkerQueueItem[] {
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 100));
    const now = options.now ?? new Date().toISOString();
    const proposals = [
      ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "approved" }),
      ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "pending_worker" }),
    ]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    this.transaction(() => {
      for (const proposal of proposals) {
        this.db.prepare(`
          INSERT OR IGNORE INTO worker_queue (
            proposal_id, status, attempts, max_attempts, next_attempt_at,
            lease_owner, lease_expires_at, last_error_code, created_at, updated_at
          ) VALUES (?, 'queued', 0, ?, ?, NULL, NULL, NULL, ?, ?)
        `).run(proposal.proposal_id, maxAttempts, now, now, now);
      }
    });
    return proposals.map((proposal) => this.workerQueueItem(proposal.proposal_id)).filter((item): item is WorkerQueueItem => item !== undefined);
  }

  claimWorkerItem(options: {
    workerId: string;
    leaseSeconds?: number;
    now?: string;
  }): WorkerQueueItem | undefined {
    const now = options.now ?? new Date().toISOString();
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 3600));
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    let claimed: WorkerQueueItem | undefined;
    this.transaction(() => {
      const raw = this.db.prepare(`
        SELECT q.*
        FROM worker_queue q
        JOIN proposals p ON p.proposal_id = q.proposal_id
        WHERE (
          (q.status IN ('queued', 'retry_wait') AND q.next_attempt_at <= ?)
          OR (q.status = 'leased' AND q.lease_expires_at <= ?)
        )
          AND p.state IN ('approved', 'pending_worker', 'failed')
        ORDER BY q.next_attempt_at ASC, q.created_at ASC
        LIMIT 1
      `).get(now, now);
      const item = rowToWorkerQueueItem(raw);
      if (!item) return;
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(options.workerId, leaseExpiresAt, now, item.proposal_id);
      const proposal = this.requireProposal(item.proposal_id);
      if (proposal.state === "failed") {
        this.db.prepare("UPDATE proposals SET state = 'pending_worker', updated_at = ? WHERE proposal_id = ?").run(now, item.proposal_id);
      }
      this.appendEvent(item.proposal_id, "writeback_worker_claimed", options.workerId, {
        attempt: item.attempts + 1,
        max_attempts: item.max_attempts,
        lease_expires_at: leaseExpiresAt,
      });
      claimed = this.workerQueueItem(item.proposal_id);
    });
    return claimed;
  }

  completeWorkerItem(proposalId: string, workerId: string, outcome: "applied" | "already_applied" | "conflict", now = new Date().toISOString()): WorkerQueueItem {
    this.transaction(() => {
      this.assertWorkerLease(proposalId, workerId);
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = NULL, updated_at = ?
        WHERE proposal_id = ?
      `).run(now, proposalId);
      this.appendEvent(proposalId, "writeback_worker_completed", workerId, { outcome });
    });
    return this.requireWorkerQueueItem(proposalId);
  }

  retryWorkerItem(options: {
    proposalId: string;
    workerId: string;
    errorCode: string;
    retryAt: string;
    now?: string;
  }): WorkerQueueItem {
    const now = options.now ?? new Date().toISOString();
    this.transaction(() => {
      const item = this.assertWorkerLease(options.proposalId, options.workerId);
      const deadLetter = item.attempts >= item.max_attempts;
      this.db.prepare(`
        UPDATE worker_queue
        SET status = ?, next_attempt_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, last_error_code = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(deadLetter ? "dead_letter" : "retry_wait", options.retryAt, options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, deadLetter ? "writeback_dead_lettered" : "writeback_retry_scheduled", options.workerId, {
        attempt: item.attempts,
        max_attempts: item.max_attempts,
        error_code: options.errorCode,
        ...(deadLetter ? {} : { retry_at: options.retryAt }),
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  }

  deadLetterWorkerItem(options: {
    proposalId: string;
    workerId: string;
    errorCode: string;
    now?: string;
  }): WorkerQueueItem {
    const now = options.now ?? new Date().toISOString();
    this.transaction(() => {
      const item = this.assertWorkerLease(options.proposalId, options.workerId);
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_dead_lettered", options.workerId, {
        attempt: item.attempts,
        max_attempts: item.max_attempts,
        error_code: options.errorCode,
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  }

  listWorkerQueue(status?: WorkerQueueStatus): WorkerQueueItem[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM worker_queue WHERE status = ? ORDER BY created_at ASC").all(status)
      : this.db.prepare("SELECT * FROM worker_queue ORDER BY created_at ASC").all();
    return rows.map(rowToWorkerQueueItem).filter((item): item is WorkerQueueItem => item !== undefined);
  }

  getWorkerQueueItem(proposalId: string): WorkerQueueItem | undefined {
    return this.workerQueueItem(proposalId);
  }

  requeueDeadLetter(options: {
    proposalId: string;
    retryBudget: number;
    identity: OperatorIdentityProof;
    reason?: string;
    now?: string;
  }): WorkerQueueItem {
    const now = options.now ?? new Date().toISOString();
    const retryBudget = Math.max(1, Math.min(options.retryBudget, 100));
    const proposal = this.requireProposal(options.proposalId);
    assertOperatorDecision(proposal, "worker_requeue", options.identity.subject, options.identity, true);
    this.transaction(() => {
      const item = this.requireWorkerQueueItem(options.proposalId);
      if (item.status !== "dead_letter") {
        throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
      }
      const provenEffect = this.receipts(options.proposalId).find((receipt) =>
        receipt.source_database_mutated || receipt.status === "applied" || receipt.status === "already_applied");
      if (provenEffect) {
        throw new ProposalStoreError("DEAD_LETTER_EFFECT_ALREADY_RECORDED", `proposal ${options.proposalId} has a receipt proving the database effect already completed`);
      }
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'queued', attempts = 0, max_attempts = ?, next_attempt_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE proposal_id = ?
      `).run(retryBudget, now, now, options.proposalId);
      if (proposal.state === "failed") {
        this.db.prepare("UPDATE proposals SET state = 'approved', updated_at = ? WHERE proposal_id = ?").run(now, options.proposalId);
      }
      this.appendEvent(options.proposalId, "writeback_dead_letter_requeued", options.identity.subject, {
        retry_budget: retryBudget,
        reason: options.reason ?? null,
        identity: publicIdentitySummary(options.identity),
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  }

  discardDeadLetter(options: {
    proposalId: string;
    identity: OperatorIdentityProof;
    reason: string;
    now?: string;
  }): WorkerQueueItem {
    const now = options.now ?? new Date().toISOString();
    const proposal = this.requireProposal(options.proposalId);
    assertOperatorDecision(proposal, "worker_discard", options.identity.subject, options.identity, true);
    this.transaction(() => {
      const item = this.requireWorkerQueueItem(options.proposalId);
      if (item.status !== "dead_letter") {
        throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
      }
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'discarded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE proposal_id = ?
      `).run(now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_dead_letter_discarded", options.identity.subject, {
        reason: options.reason,
        identity: publicIdentitySummary(options.identity),
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  }

  private workerQueueItem(proposalId: string): WorkerQueueItem | undefined {
    return rowToWorkerQueueItem(this.db.prepare("SELECT * FROM worker_queue WHERE proposal_id = ?").get(proposalId));
  }

  private requireWorkerQueueItem(proposalId: string): WorkerQueueItem {
    const item = this.workerQueueItem(proposalId);
    if (!item) throw new ProposalStoreError("WORKER_ITEM_NOT_FOUND", `worker queue item not found for ${proposalId}`);
    return item;
  }

  private assertWorkerLease(proposalId: string, workerId: string): WorkerQueueItem {
    const item = this.requireWorkerQueueItem(proposalId);
    if (item.status !== "leased" || item.lease_owner !== workerId) {
      throw new ProposalStoreError("WORKER_LEASE_MISMATCH", `worker ${workerId} does not hold the lease for ${proposalId}`);
    }
    return item;
  }

  private restoreSharedLedgerEntry(table: string, payload: Record<string, unknown>): boolean {
    const spec = sharedLedgerRestoreSpecs[table];
    if (!spec) return false;
    const values = spec.columns.map((column) => sharedLedgerRestoreValue(payload, column));
    if (values.some((value, index) => value == null && spec.required.has(spec.columns[index]!))) return false;
    const assignments = spec.columns
      .filter((column) => column !== spec.conflict)
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    this.db.prepare(`
      INSERT INTO ${table} (${spec.columns.join(", ")})
      VALUES (${spec.columns.map(() => "?").join(", ")})
      ON CONFLICT(${spec.conflict}) DO UPDATE SET ${assignments}
    `).run(...values);
    return true;
  }

  operationalMetrics(filters: { tenant?: string; capability?: string } = {}): OperationalMetricRow[] {
    const rows = new Map<string, OperationalMetricRow>();
    const ensure = (tenantId: string, capability: string) => {
      const key = `${tenantId}\u0000${capability}`;
      let row = rows.get(key);
      if (!row) {
        row = { tenant_id: tenantId, capability, proposals: 0, approvals: 0, rejections: 0, applies: 0, conflicts: 0, failures: 0 };
        rows.set(key, row);
      }
      return row;
    };
    for (const proposal of this.listProposals({ tenant: filters.tenant, capability: filters.capability })) {
      ensure(proposal.tenant_id, proposal.action).proposals += 1;
    }
    const approvalRows = this.db.prepare(`
      SELECT p.tenant_id, p.action, a.status, COUNT(*) AS count
      FROM approvals a JOIN proposals p ON p.proposal_id = a.proposal_id
      WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
      GROUP BY p.tenant_id, p.action, a.status
    `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of approvalRows) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      if (raw.status === "approved") row.approvals += Number(raw.count);
      if (raw.status === "rejected") row.rejections += Number(raw.count);
    }
    const receiptRows = this.db.prepare(`
      SELECT p.tenant_id, p.action, r.status, COUNT(*) AS count
      FROM writeback_receipts r JOIN proposals p ON p.proposal_id = r.proposal_id
      WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
      GROUP BY p.tenant_id, p.action, r.status
    `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of receiptRows) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      const count = Number(raw.count);
      if (raw.status === "applied" || raw.status === "already_applied") row.applies += count;
      else if (raw.status === "conflict") row.conflicts += count;
      else if (raw.status === "failed") row.failures += count;
    }
    return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
  }

  fleetEventMetrics(filters: { tenant?: string; capability?: string } = {}): FleetEventMetricRow[] {
    const rows = new Map<string, FleetEventMetricRow>();
    const ensure = (tenantId: string, capability: string) => {
      const key = `${tenantId}\u0000${capability}`;
      let row = rows.get(key);
      if (!row) {
        row = { tenant_id: tenantId, capability, worker_retries: 0, dead_letters: 0, auto_approval_limit_trips: 0 };
        rows.set(key, row);
      }
      return row;
    };
    const events = this.db.prepare(`
      SELECT p.tenant_id, p.action, e.kind, e.payload_json
      FROM proposal_events e JOIN proposals p ON p.proposal_id = e.proposal_id
      WHERE e.kind IN ('writeback_retry_scheduled', 'writeback_dead_lettered', 'policy_auto_approval_deferred')
        AND (? IS NULL OR p.tenant_id = ?)
        AND (? IS NULL OR p.action = ?)
    `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of events) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      if (raw.kind === "writeback_retry_scheduled") row.worker_retries += 1;
      if (raw.kind === "writeback_dead_lettered") row.dead_letters += 1;
      if (raw.kind === "policy_auto_approval_deferred") {
        try {
          const payload = JSON.parse(String(raw.payload_json)) as Record<string, unknown>;
          if (Array.isArray(payload.tripped_limits) && payload.tripped_limits.length > 0) row.auto_approval_limit_trips += 1;
        } catch {
          // Malformed historical payloads are ignored instead of becoming metric labels or scrape failures.
        }
      }
    }
    return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
  }

  receipts(proposalId: string): StoredWritebackReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM writeback_receipts WHERE proposal_id = ? ORDER BY receipt_id ASC")
      .all(proposalId);
    return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
  }

  replay(proposalId: string): ProposalReplayRecord {
    const proposal = this.requireProposal(proposalId);
    const replay: ProposalReplayRecord = {
      replay_id: `replay_${proposalId}`,
      proposal,
      approvals: this.approvals(proposalId),
      events: this.events(proposalId),
      receipts: this.receipts(proposalId),
      query_audit: this.queryAudit(proposalId),
      evidence: this.evidence(proposalId),
      generated_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_records (replay_id, proposal_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(replay.replay_id, proposalId, JSON.stringify(replay), replay.generated_at);
    return replay;
  }

  setRunnerState(key: string, value: Record<string, unknown>): void {
    assertNoSecretMaterial(value, `runner_state.${key}`);
    this.db.prepare(`
      INSERT INTO runner_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getRunnerState(key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT value_json FROM runner_state WHERE key = ?").get(key);
    if (!isRecord(row)) return undefined;
    return JSON.parse(String(row.value_json)) as Record<string, unknown>;
  }

  sharedLedgerEntries(): SharedLedgerEntry[] {
    const specs: Array<{
      table: string;
      kind: string;
      key: string;
      created: string;
      proposal?: string;
      tenant?: string;
      capability?: string;
    }> = [
      { table: "proposals", kind: "proposal", key: "proposal_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "proposal_events", kind: "proposal_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
      { table: "approvals", kind: "approval", key: "approval_id", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_jobs", kind: "writeback_job", key: "writeback_job_id", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_intents", kind: "writeback_intent", key: "intent_id", created: "created_at", proposal: "proposal_id" },
      { table: "idempotency_receipts", kind: "idempotency_receipt", key: "idempotency_key", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_receipts", kind: "writeback_receipt", key: "receipt_id", created: "created_at", proposal: "proposal_id" },
      { table: "evidence_bundles", kind: "evidence_bundle", key: "evidence_bundle_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "evidence_items", kind: "evidence_item", key: "evidence_item_id", created: "created_at" },
      { table: "query_audit", kind: "query_audit", key: "audit_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "replay_records", kind: "replay_record", key: "replay_id", created: "created_at", proposal: "proposal_id" },
      { table: "shadow_human_actions", kind: "shadow_human_action", key: "action_id", created: "created_at", proposal: "proposal_id" },
      { table: "worker_queue", kind: "worker_queue_item", key: "proposal_id", created: "created_at", proposal: "proposal_id" },
      { table: "runner_state", kind: "runner_state", key: "key", created: "updated_at" },
    ];
    const entries: SharedLedgerEntry[] = [];
    for (const spec of specs) {
      const rows = this.db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.created} ASC`).all();
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const payload = sharedLedgerPayload(spec.table, row);
        assertNoSecretMaterial(payload, `shared_ledger.${spec.table}`);
        entries.push({
          entry_key: `${spec.table}:${String(row[spec.key])}`,
          kind: spec.kind,
          proposal_id: spec.proposal && row[spec.proposal] != null ? String(row[spec.proposal]) : undefined,
          tenant_id: spec.tenant && row[spec.tenant] != null ? String(row[spec.tenant]) : undefined,
          capability: spec.capability && row[spec.capability] != null ? String(row[spec.capability]) : undefined,
          payload,
          created_at: row[spec.created] == null ? new Date().toISOString() : String(row[spec.created]),
        });
      }
    }
    return entries;
  }

  importSharedLedgerEntries(entries: SharedLedgerEntry[]): SharedLedgerImportResult {
    let imported = 0;
    let skipped = 0;
    const sorted = [...entries].sort((left, right) => sharedLedgerRestoreRank(left) - sharedLedgerRestoreRank(right));
    this.transaction(() => {
      for (const entry of sorted) {
        const table = sharedLedgerTableForEntry(entry);
        if (!table) {
          skipped += 1;
          continue;
        }
        assertNoSecretMaterial(entry.payload, `shared_ledger.${table}`);
        if (this.restoreSharedLedgerEntry(table, entry.payload)) imported += 1;
        else skipped += 1;
      }
    });
    return { imported, skipped };
  }

  recordShadowHumanAction(
    proposalId: string,
    input: { actor: string; patch: Record<string, unknown>; notes?: string },
  ): StoredShadowHumanAction {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    assertNoSecretMaterial(input.patch, "shadow_human_action.patch");
    const now = new Date().toISOString();
    let actionId = 0;
    this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO shadow_human_actions (proposal_id, actor, patch_json, notes, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(proposalId, input.actor, JSON.stringify(input.patch), input.notes ?? null, now);
      actionId = Number(result.lastInsertRowid);
      this.appendEvent(proposalId, "shadow_human_action_recorded", input.actor, {
        action_id: actionId,
        patch_columns: Object.keys(input.patch),
        notes: input.notes ?? null,
      });
    });
    const action = this.shadowHumanActions(proposalId).find((item) => item.action_id === actionId);
    if (!action) throw new ProposalStoreError("SHADOW_ACTION_CREATE_FAILED", `shadow action for ${proposalId} was not persisted`);
    return action;
  }

  shadowHumanActions(proposalId: string): StoredShadowHumanAction[] {
    const rows = this.db.prepare("SELECT * FROM shadow_human_actions WHERE proposal_id = ? ORDER BY action_id ASC").all(proposalId);
    return rows.map(rowToShadowHumanAction).filter((action): action is StoredShadowHumanAction => action !== undefined);
  }

  compareShadowProposal(proposalId: string): ShadowComparison {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    const actions = this.shadowHumanActions(proposalId);
    const latest = actions.at(-1);
    return comparePatches(proposalId, proposal.change_set.patch, latest);
  }

  shadowReport(): ShadowReport {
    const proposals = this.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
    const comparisons = proposals.map((proposal) => this.compareShadowProposal(proposal.proposal_id));
    return {
      total_shadow_proposals: proposals.length,
      with_human_action: comparisons.filter((comparison) => comparison.status !== "no_human_action").length,
      exact_matches: comparisons.filter((comparison) => comparison.status === "exact_match").length,
      partial_matches: comparisons.filter((comparison) => comparison.status === "partial_match").length,
      mismatches: comparisons.filter((comparison) => comparison.status === "mismatch").length,
      no_human_action: comparisons.filter((comparison) => comparison.status === "no_human_action").length,
      comparisons,
    };
  }

  private requireProposal(proposalId: string): StoredProposal {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      throw new ProposalStoreError("PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
    }
    return proposal;
  }

  private setState(
    proposalId: string,
    state: LocalProposalState,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run(state, now, proposalId);
      this.appendEvent(proposalId, `proposal_${state}`, actor, payload);
    });
  }

  private appendEvent(
    proposalId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO proposal_events (proposal_id, kind, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(proposalId, kind, actor, JSON.stringify(payload), new Date().toISOString());
  }

  private queryAudit(proposalId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM query_audit WHERE proposal_id = ? ORDER BY audit_id ASC")
      .all(proposalId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        audit_id: Number(row.audit_id),
        proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
        evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
        source_id: String(row.source_id),
        query_fingerprint: String(row.query_fingerprint),
        table_name: String(row.table_name),
        row_count: Number(row.row_count),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private queryAuditByEvidence(evidenceBundleId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM query_audit WHERE evidence_bundle_id = ? ORDER BY audit_id ASC")
      .all(evidenceBundleId);
    return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
  }

  private evidence(proposalId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_bundles WHERE proposal_id = ? ORDER BY created_at ASC")
      .all(proposalId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_bundle_id: String(row.evidence_bundle_id),
        proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
        tenant_id: String(row.tenant_id),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        items: this.evidenceItems(String(row.evidence_bundle_id)),
        query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private evidenceItems(evidenceBundleId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_items WHERE evidence_bundle_id = ? ORDER BY evidence_item_id ASC")
      .all(evidenceBundleId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_item_id: Number(row.evidence_item_id),
        evidence_bundle_id: String(evidenceBundleId),
        item: JSON.parse(String(row.item_json)) as Record<string, unknown>,
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private evidenceMetadata(input: {
    proposal?: StoredProposal;
    payload: Record<string, unknown>;
    items: Record<string, unknown>[];
  }): {
    principal?: string;
    capability?: string;
    source_id?: string;
    source_table?: string;
    business_object?: string;
    object_id?: string;
    query_fingerprint?: string;
  } {
    if (input.proposal) {
      return {
        principal: input.proposal.change_set.principal.id,
        capability: input.proposal.action,
        source_id: input.proposal.source_id,
        source_table: `${input.proposal.source_schema}.${input.proposal.source_table}`,
        business_object: input.proposal.business_object,
        object_id: input.proposal.object_id,
        query_fingerprint: input.proposal.change_set.evidence.query_fingerprint,
      };
    }
    const firstItem = input.items.find(isRecord) as Record<string, unknown> | undefined;
    const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : undefined;
    const principal = stringFromPrincipal(input.payload.principal);
    const table = stringFromUnknown(input.payload.target) ?? stringFromUnknown(firstItem?.table);
    return {
      principal,
      capability: stringFromUnknown(input.payload.capability),
      source_id: stringFromUnknown(input.payload.source_id) ?? stringFromUnknown(firstItem?.source_id),
      source_table: table,
      business_object: table ? lastIdentifier(table) : undefined,
      object_id: primaryKey ? stringFromUnknown(primaryKey.value) : undefined,
      query_fingerprint: stringFromUnknown(input.payload.query_fingerprint),
    };
  }

  private queryAuditMetadata(input: {
    proposal?: StoredProposal;
    evidence?: StoredEvidenceBundle;
    payload: Record<string, unknown>;
  }): {
    tenant_id?: string;
    principal?: string;
    capability?: string;
    business_object?: string;
    object_id?: string;
    primary_key_value?: string;
  } {
    if (input.proposal) {
      return {
        tenant_id: input.proposal.tenant_id,
        principal: input.proposal.change_set.principal.id,
        capability: input.proposal.action,
        business_object: input.proposal.business_object,
        object_id: input.proposal.object_id,
        primary_key_value: "value" in input.proposal.change_set.source.primary_key
          ? String(input.proposal.change_set.source.primary_key.value)
          : input.proposal.object_id,
      };
    }
    const firstItem = input.evidence?.items.find((item) => isRecord(item.item))?.item as Record<string, unknown> | undefined;
    const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : undefined;
    return {
      tenant_id: input.evidence?.tenant_id ?? stringFromUnknown(input.payload.tenant_id),
      principal: input.evidence?.principal ?? stringFromPrincipal(input.payload.principal),
      capability: input.evidence?.capability ?? stringFromUnknown(input.payload.capability),
      business_object: input.evidence?.business_object ?? stringFromUnknown(input.payload.business_object),
      object_id: input.evidence?.object_id ?? stringFromUnknown(input.payload.object_id),
      primary_key_value: primaryKey ? stringFromUnknown(primaryKey.value) : input.evidence?.object_id ?? stringFromUnknown(input.payload.primary_key_value),
    };
  }

  private countTable(table: string): number {
    return this.countWhere(table, "1 = 1", []);
  }

  private countWhere(table: string, where: string, params: SQLInputValue[]): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params);
    return isRecord(row) ? Number(row.count ?? 0) : 0;
  }

  private numberValue(sql: string): number {
    const row = this.db.prepare(sql).get();
    if (!isRecord(row)) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  private stringColumn(sql: string, params: SQLInputValue[], column: string): string[] {
    return this.db.prepare(sql).all(...params)
      .map((row) => isRecord(row) ? row[column] : undefined)
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String);
  }

  private evidenceIdsForPrune(cutoffIso: string, proposalIds: string[]): string[] {
    const proposalWhere = inWhere("proposal_id", proposalIds);
    if (!proposalWhere) {
      return this.stringColumn("SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ?", [cutoffIso], "evidence_bundle_id");
    }
    return this.stringColumn(
      `SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ? OR ${proposalWhere.sql}`,
      [cutoffIso, ...proposalWhere.params],
      "evidence_bundle_id",
    );
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function stateFromChangeSet(changeSet: ChangeSet): LocalProposalState {
  if (changeSet.approval.status === "approved") return "approved";
  if (changeSet.approval.status === "rejected") return "rejected";
  if (changeSet.approval.status === "canceled") return "canceled";
  return "pending_review";
}

function requiredApprovalCount(proposal: StoredProposal): number {
  const configured = proposal.change_set.approval.required_approvals;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 1
    ? configured
    : 1;
}

function assertOperatorDecision(
  proposal: StoredProposal,
  action: OperatorDecision["action"],
  actor: string,
  identity: OperatorIdentityProof | undefined,
  requireVerified: boolean,
): void {
  if (requireVerified && (!identity || !identity.verified)) {
    throw new ProposalStoreError("VERIFIED_OPERATOR_IDENTITY_REQUIRED", `verified operator identity is required to ${action} proposal ${proposal.proposal_id}`);
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_MISMATCH", `operator identity ${identity.subject} does not match actor ${actor}`);
  }
  if (identity.decision.action !== action
    || identity.decision.proposal_id !== proposal.proposal_id
    || identity.decision.proposal_version !== proposal.proposal_version
    || identity.decision.proposal_hash !== proposal.proposal_hash) {
    throw new ProposalStoreError("OPERATOR_DECISION_MISMATCH", `operator proof is not bound to this ${action} decision`);
  }
  const requiredRole = proposal.change_set.approval.required_role;
  if ((action === "approve" || action === "reject") && requiredRole && !identity.roles.includes(requiredRole)) {
    throw new ProposalStoreError("APPROVER_ROLE_REQUIRED", `operator ${identity.subject} lacks required role ${requiredRole}`);
  }
}

function publicIdentitySummary(identity: OperatorIdentityProof | undefined): Record<string, unknown> | undefined {
  if (!identity) return undefined;
  return {
    provider: identity.provider,
    verified: identity.verified,
    subject: identity.subject,
    roles: identity.roles,
    key_id: identity.key_id,
    algorithm: identity.algorithm,
    decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash,
  };
}

function utcDayWindow(value: string): { start: string; end: string } {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new ProposalStoreError("INVALID_POLICY_CLOCK", `invalid policy evaluation time: ${value}`);
  }
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

type SqlParam = string | number | null;
type SqlQuery = { sql: string; params: SqlParam[] };

function inWhere(column: string, values: string[]): { sql: string; params: string[] } | undefined {
  if (values.length === 0) return undefined;
  return {
    sql: `${column} IN (${values.map(() => "?").join(", ")})`,
    params: values,
  };
}

function buildProposalQuery(filters: ProposalSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "state", filters.status ?? filters.state);
  addEqual(clauses, params, "action", filters.capability ?? filters.action);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposals", clauses, params, filters.limit);
}

function buildEvidenceQuery(filters: EvidenceSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM evidence_bundles", clauses, params, filters.limit);
}

function buildQueryAuditQuery(filters: QueryAuditSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "table_name", filters.table);
  addObjectFilter(clauses, params, "business_object", "table_name", "object_id", filters.objectType, filters.objectId);
  addEqual(clauses, params, "primary_key_value", filters.primaryKey);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM query_audit", clauses, params, filters.limit);
}

function buildReceiptQuery(filters: ReceiptSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "receipt_id", filters.receipt);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "writeback_job_id", filters.writebackJob);
  addEqual(clauses, params, "idempotency_key", filters.idempotencyKey);
  addEqual(clauses, params, "status", filters.status);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery(`SELECT * FROM (
    SELECT r.*, p.tenant_id, p.principal, p.action AS capability,
      p.business_object, p.object_id, p.source_id, p.source_table
    FROM writeback_receipts r
    JOIN proposals p ON p.proposal_id = r.proposal_id
  ) AS associated_receipts`, clauses, params, filters.limit);
}

function buildEventQuery(filters: EventSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "kind", filters.kind);
  addEqual(clauses, params, "actor", filters.actor);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposal_events", clauses, params, filters.limit);
}

function addEqual(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}

function addTableFilter(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  if (value.includes(".")) {
    clauses.push(`${column} = ?`);
    params.push(value);
    return;
  }
  clauses.push(`(${column} = ? OR ${column} = ?)`);
  params.push(value, `public.${value}`);
}

function addObjectFilter(
  clauses: string[],
  params: SqlParam[],
  typeColumn: string,
  tableColumn: string,
  idColumn: string,
  objectType?: string,
  objectId?: string,
): void {
  if (objectId) {
    clauses.push(`${idColumn} = ?`);
    params.push(objectId);
  }
  if (!objectType) return;
  const variants = objectTypeVariants(objectType);
  const placeholders = variants.map(() => "?").join(", ");
  clauses.push(`(${typeColumn} IN (${placeholders}) OR ${tableColumn} IN (${placeholders}))`);
  params.push(...variants, ...variants);
}

function addTimeRange(clauses: string[], params: SqlParam[], column: string, from?: string, to?: string): void {
  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
}

function finishQuery(base: string, clauses: string[], params: SqlParam[], limit?: number): SqlQuery {
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `${base}${where} ORDER BY created_at DESC${limit ? " LIMIT ?" : ""}`;
  return { sql, params: limit ? [...params, limit] : params };
}

function objectTypeVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  if (value.endsWith("s")) variants.add(value.slice(0, -1));
  else variants.add(`${value}s`);
  for (const variant of [...variants]) {
    if (!variant.includes(".")) variants.add(`public.${variant}`);
  }
  return [...variants];
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stringFromPrincipal(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringFromUnknown(value.id);
  return undefined;
}

function lastIdentifier(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

function stateFromReceipt(receipt: ExecutionReceipt): LocalProposalState {
  if (receipt.status === "applied" || receipt.status === "already_applied") return "applied";
  if (receipt.status === "conflict") return "conflict";
  if (receipt.status === "canceled") return "canceled";
  if (receipt.status === "reconciliation_required") return "reconciliation_required";
  return "failed";
}

function receiptToWritebackResult(receipt: ExecutionReceiptV2 | ExecutionReceiptV3): WritebackResult {
  if (receipt.schema_version === protocolVersions.executionReceiptV3) {
    return parseWritebackResult({
      protocol_version: protocolVersions.normalizedWritebackJobV3,
      job_id: receipt.writeback_job_id,
      runner_id: receipt.runner_id,
      operation: receipt.operation,
      receipt_authority: receipt.receipt_authority,
      status: receipt.status,
      affected_rows: receipt.rows_affected,
      target_identities: receipt.target.identities,
      set_digest: receipt.target.set_digest,
      member_effects: receipt.member_effects,
      result_hash: receipt.receipt_hash,
      completed_at: receipt.executed_at,
      error_code: receipt.safe_error_code,
      intent_id: receipt.reconciliation?.intent_id,
    });
  }
  return parseWritebackResult({
    protocol_version: protocolVersions.normalizedWritebackJobV2,
    job_id: receipt.writeback_job_id,
    runner_id: receipt.runner_id,
    operation: receipt.operation,
    receipt_authority: receipt.receipt_authority,
    status: receipt.status,
    affected_rows: receipt.rows_affected,
    target_identity: receipt.target.identity,
    before_digest: receipt.before_digest,
    after_digest: receipt.after_digest,
    tombstone_digest: receipt.tombstone_digest,
    result_hash: receipt.receipt_hash,
    completed_at: receipt.executed_at,
    error_code: receipt.safe_error_code,
    intent_id: receipt.reconciliation?.intent_id,
  });
}

function writebackMutationFromChangeSet(changeSet: Extract<ChangeSet, { schema_version: "synapsor.change-set.v2" }>): WritebackJobV2["mutation"] {
  if (changeSet.operation === "single_row_insert") {
    if (!changeSet.guards.deduplication) throw new ProposalStoreError("INSERT_DEDUPLICATION_REQUIRED", `proposal ${changeSet.proposal_id} has no resolved deduplication identity`);
    return {
      kind: "single_row_insert",
      values: changeSet.patch,
      deduplication: changeSet.guards.deduplication,
    };
  }
  const guard = changeSet.guards.expected_version;
  if (!guard) throw new ProposalStoreError("CONFLICT_GUARD_REQUIRED", `proposal ${changeSet.proposal_id} has no exact version guard`);
  if (changeSet.operation === "single_row_delete") {
    return {
      kind: "single_row_delete",
      conflict_guard: { kind: "column", column: guard.column, expected_value: guard.value },
    };
  }
  return {
    kind: "single_row_update",
    values: changeSet.patch,
    conflict_guard: { kind: "column", column: guard.column, expected_value: guard.value },
    ...(changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {}),
  };
}

function conflictGuardFromChangeSet(changeSet: ChangeSet): WritebackJobV1["conflict_guard"] {
  if (changeSet.schema_version === protocolVersions.changeSetV3) return { kind: "none" };
  const guard = changeSet.guards.expected_version;
  if (!guard) return { kind: "none" };
  if (guard.column === "__row_hash") {
    return { kind: "row_hash", expected_hash: String(guard.value) };
  }
  if (!guard.column || guard.value === null || guard.value === undefined) {
    return { kind: "none" };
  }
  return { kind: "column", column: guard.column, expected_value: guard.value };
}

function assertProposalIdentity(proposal: StoredProposal, hash: string, version: number): void {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
  }
}

function assertWritebackAllowed(proposal: StoredProposal, operation: string): void {
  if (proposal.change_set.mode === "shadow") {
    throw new ProposalStoreError(
      "SHADOW_WRITEBACK_DISABLED",
      `shadow proposal ${proposal.proposal_id} cannot be ${operation}; shadow mode stores proposals, evidence, query audit, and replay only and never mutates the source database`,
    );
  }
  if (proposal.change_set.mode === "read_only") {
    throw new ProposalStoreError(
      "READ_ONLY_WRITEBACK_DISABLED",
      `read-only proposal ${proposal.proposal_id} cannot be ${operation}; read-only mode does not allow proposal writeback`,
    );
  }
}

const secretKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url|read[_-]?url|write[_-]?url)($|[_-])/i;
const secretValuePattern = /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]+|syn_wbr_[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function assertNoSecretMaterial(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (secretKeyPattern.test(key)) {
        throw new ProposalStoreError(
          "SECRET_MATERIAL_REJECTED",
          `refusing to persist secret-like field ${entryPath}; remove it from reviewed visible/evidence/query-audit data`,
        );
      }
      assertNoSecretMaterial(entry, entryPath);
    }
    return;
  }
  if (typeof value === "string" && secretValuePattern.test(value)) {
    throw new ProposalStoreError(
      "SECRET_MATERIAL_REJECTED",
      `refusing to persist secret-like value at ${path}; remove it from reviewed visible/evidence/query-audit data`,
    );
  }
}

function rowToProposal(row: unknown): StoredProposal | undefined {
  if (!isRecord(row)) return undefined;
  return {
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    action: String(row.action),
    state: String(row.state) as LocalProposalState,
    tenant_id: String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: row.capability == null ? undefined : String(row.capability),
    interaction_id: row.interaction_id == null ? undefined : String(row.interaction_id),
    tool_call_id: row.tool_call_id == null ? undefined : String(row.tool_call_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    source_kind: String(row.source_kind),
    source_id: String(row.source_id),
    source_schema: String(row.source_schema),
    source_table: String(row.source_table),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    change_set: parseChangeSet(JSON.parse(String(row.change_set_json))),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToEvent(row: unknown): ProposalEvent | undefined {
  if (!isRecord(row)) return undefined;
  return {
    event_id: Number(row.event_id),
    proposal_id: String(row.proposal_id),
    kind: String(row.kind),
    actor: String(row.actor),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function rowToApproval(row: unknown): StoredApproval | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (status !== "approved" && status !== "rejected") return undefined;
  return {
    approval_id: Number(row.approval_id),
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    approver: String(row.approver),
    status,
    reason: row.reason == null ? undefined : String(row.reason),
    identity: row.identity_json == null ? undefined : JSON.parse(String(row.identity_json)) as OperatorIdentityProof,
    decision_hash: row.decision_hash == null ? undefined : String(row.decision_hash),
    signature: row.signature == null ? undefined : String(row.signature),
    integrity_hash: row.integrity_hash == null ? undefined : String(row.integrity_hash),
    created_at: String(row.created_at),
  };
}

function rowToWorkerQueueItem(row: unknown): WorkerQueueItem | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (!["queued", "leased", "retry_wait", "completed", "dead_letter", "discarded"].includes(status)) return undefined;
  return {
    proposal_id: String(row.proposal_id),
    status: status as WorkerQueueStatus,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    lease_owner: row.lease_owner == null ? undefined : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    last_error_code: row.last_error_code == null ? undefined : String(row.last_error_code),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToReceipt(row: unknown): StoredWritebackReceipt | undefined {
  if (!isRecord(row)) return undefined;
  return {
    receipt_id: Number(row.receipt_id),
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    runner_id: String(row.runner_id),
    status: String(row.status),
    idempotency_key: String(row.idempotency_key),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    receipt: parseExecutionReceipt(JSON.parse(String(row.receipt_json))),
    created_at: String(row.created_at),
    tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: row.capability == null ? undefined : String(row.capability),
    business_object: row.business_object == null ? undefined : String(row.business_object),
    object_id: row.object_id == null ? undefined : String(row.object_id),
    source_id: row.source_id == null ? undefined : String(row.source_id),
    source_table: row.source_table == null ? undefined : String(row.source_table),
  };
}

function rowToWritebackIntent(row: unknown): StoredWritebackIntent | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (![
    "intent_recorded",
    "applying",
    "applied",
    "already_applied",
    "conflict",
    "failed",
    "reconciliation_required",
  ].includes(status)) return undefined;
  const operation = String(row.operation);
  if (!isStoredWritebackOperation(operation)) return undefined;
  return {
    intent_id: String(row.intent_id),
    idempotency_key: String(row.idempotency_key),
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    proposal_hash: String(row.proposal_hash),
    runner_id: String(row.runner_id),
    operation: operation as StoredWritebackIntent["operation"],
    status: status as WritebackIntentStatus,
    intent: parseWritebackJob(JSON.parse(String(row.intent_json))),
    result: row.result_json == null ? undefined : parseWritebackResult(JSON.parse(String(row.result_json))),
    reconciliation_reason: row.reconciliation_reason == null ? undefined : String(row.reconciliation_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function writebackIntentPayload(intent: StoredWritebackIntent): Record<string, unknown> {
  return {
    table: "writeback_intents",
    intent_id: intent.intent_id,
    idempotency_key: intent.idempotency_key,
    writeback_job_id: intent.writeback_job_id,
    proposal_id: intent.proposal_id,
    proposal_hash: intent.proposal_hash,
    runner_id: intent.runner_id,
    operation: intent.operation,
    status: intent.status,
    intent: intent.intent,
    ...(intent.result ? { result: intent.result } : {}),
    ...(intent.reconciliation_reason ? { reconciliation_reason: intent.reconciliation_reason } : {}),
    created_at: intent.created_at,
    updated_at: intent.updated_at,
  };
}

function writebackIntentFromPayload(payload: Record<string, unknown>): StoredWritebackIntent | undefined {
  const operation = String(payload.operation ?? "");
  const status = String(payload.status ?? "");
  if (!isStoredWritebackOperation(operation)) return undefined;
  if (!["intent_recorded", "applying", "applied", "already_applied", "conflict", "failed", "reconciliation_required"].includes(status)) return undefined;
  if (!isRecord(payload.intent)) return undefined;
  return {
    intent_id: String(payload.intent_id),
    idempotency_key: String(payload.idempotency_key),
    writeback_job_id: String(payload.writeback_job_id),
    proposal_id: String(payload.proposal_id),
    proposal_hash: String(payload.proposal_hash),
    runner_id: String(payload.runner_id),
    operation: operation as StoredWritebackIntent["operation"],
    status: status as WritebackIntentStatus,
    intent: parseWritebackJob(payload.intent),
    result: isRecord(payload.result) ? parseWritebackResult(payload.result) : undefined,
    reconciliation_reason: payload.reconciliation_reason == null ? undefined : String(payload.reconciliation_reason),
    created_at: String(payload.created_at),
    updated_at: String(payload.updated_at),
  };
}

function isStoredWritebackOperation(operation: string): operation is StoredWritebackIntent["operation"] {
  return ["single_row_update", "single_row_insert", "single_row_delete", "set_update", "set_delete", "batch_insert"].includes(operation);
}

function assertIntentMatchesJob(intent: StoredWritebackIntent, job: WritebackJob): void {
  if (
    intent.idempotency_key !== job.idempotency_key
    || intent.writeback_job_id !== job.job_id
    || intent.proposal_id !== job.proposal_id
    || intent.proposal_hash !== job.approval_id
  ) throw new ProposalStoreError("WRITEBACK_INTENT_IDENTITY_MISMATCH", `writeback intent ${intent.intent_id} does not match the immutable job identity`);
}

function intentJobId(intentId: string): string {
  if (!intentId.startsWith("wbi:") || intentId.length <= 4) throw new ProposalStoreError("INVALID_WRITEBACK_INTENT_ID", "writeback intent id must use wbi:<job_id>");
  return intentId.slice(4);
}

function rowToQueryAudit(row: unknown): Record<string, unknown> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    audit_id: Number(row.audit_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
    tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: row.capability == null ? undefined : String(row.capability),
    business_object: row.business_object == null ? undefined : String(row.business_object),
    object_id: row.object_id == null ? undefined : String(row.object_id),
    primary_key_value: row.primary_key_value == null ? undefined : String(row.primary_key_value),
    source_id: String(row.source_id),
    query_fingerprint: String(row.query_fingerprint),
    table_name: String(row.table_name),
    row_count: Number(row.row_count),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function rowToShadowHumanAction(row: unknown): StoredShadowHumanAction | undefined {
  if (!isRecord(row)) return undefined;
  return {
    action_id: Number(row.action_id),
    proposal_id: String(row.proposal_id),
    actor: String(row.actor),
    patch: JSON.parse(String(row.patch_json)) as Record<string, unknown>,
    notes: row.notes == null ? undefined : String(row.notes),
    created_at: String(row.created_at),
  };
}

const sharedLedgerJsonColumns = new Set([
  "change_set_json",
  "payload_json",
  "identity_json",
  "job_json",
  "intent_json",
  "result_json",
  "receipt_json",
  "item_json",
  "value_json",
  "patch_json",
]);

const sharedLedgerKindToTable: Record<string, string> = {
  proposal: "proposals",
  proposal_event: "proposal_events",
  approval: "approvals",
  writeback_job: "writeback_jobs",
  writeback_intent: "writeback_intents",
  idempotency_receipt: "idempotency_receipts",
  writeback_receipt: "writeback_receipts",
  evidence_bundle: "evidence_bundles",
  evidence_item: "evidence_items",
  query_audit: "query_audit",
  replay_record: "replay_records",
  shadow_human_action: "shadow_human_actions",
  worker_queue_item: "worker_queue",
  runner_state: "runner_state",
};

type SharedLedgerRestoreSpec = {
  columns: string[];
  conflict: string;
  required: Set<string>;
};

const sharedLedgerRestoreSpecs: Record<string, SharedLedgerRestoreSpec> = {
  proposals: restoreSpec("proposal_id", [
    "proposal_id", "proposal_version", "proposal_hash", "action", "state",
    "tenant_id", "principal", "capability", "interaction_id", "tool_call_id",
    "business_object", "object_id", "source_kind", "source_id", "source_schema",
    "source_table", "source_database_mutated", "change_set_json", "created_at", "updated_at",
  ], ["proposal_id", "proposal_version", "proposal_hash", "action", "state", "tenant_id", "business_object", "object_id", "source_kind", "source_id", "source_schema", "source_table", "source_database_mutated", "change_set_json", "created_at", "updated_at"]),
  proposal_events: restoreSpec("event_id", ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"], ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"]),
  approvals: restoreSpec("approval_id", ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "reason", "identity_json", "decision_hash", "signature", "integrity_hash", "created_at"], ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "created_at"]),
  writeback_jobs: restoreSpec("writeback_job_id", ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"], ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"]),
  writeback_intents: restoreSpec("intent_id", ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "result_json", "reconciliation_reason", "created_at", "updated_at"], ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "created_at", "updated_at"]),
  idempotency_receipts: restoreSpec("idempotency_key", ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"], ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"]),
  writeback_receipts: restoreSpec("receipt_id", ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"], ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"]),
  evidence_bundles: restoreSpec("evidence_bundle_id", ["evidence_bundle_id", "proposal_id", "tenant_id", "principal", "capability", "source_id", "source_table", "business_object", "object_id", "query_fingerprint", "payload_json", "created_at"], ["evidence_bundle_id", "tenant_id", "payload_json", "created_at"]),
  evidence_items: restoreSpec("evidence_item_id", ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"], ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"]),
  query_audit: restoreSpec("audit_id", ["audit_id", "proposal_id", "evidence_bundle_id", "tenant_id", "principal", "capability", "business_object", "object_id", "primary_key_value", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"], ["audit_id", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"]),
  replay_records: restoreSpec("replay_id", ["replay_id", "proposal_id", "payload_json", "created_at"], ["replay_id", "proposal_id", "payload_json", "created_at"]),
  shadow_human_actions: restoreSpec("action_id", ["action_id", "proposal_id", "actor", "patch_json", "notes", "created_at"], ["action_id", "proposal_id", "actor", "patch_json", "created_at"]),
  worker_queue: restoreSpec("proposal_id", ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "created_at", "updated_at"], ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]),
  runner_state: restoreSpec("key", ["key", "value_json", "updated_at"], ["key", "value_json", "updated_at"]),
};

function sharedLedgerPayload(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { table };
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue;
    const normalizedKey = key.endsWith("_json") ? key.slice(0, -5) : key;
    if (sharedLedgerJsonColumns.has(key)) {
      try {
        payload[normalizedKey] = JSON.parse(String(value));
      } catch {
        payload[normalizedKey] = String(value);
      }
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

function restoreSpec(conflict: string, columns: string[], required: string[]): SharedLedgerRestoreSpec {
  return { conflict, columns, required: new Set(required) };
}

function sharedLedgerTableForEntry(entry: SharedLedgerEntry): string | undefined {
  const explicit = typeof entry.payload.table === "string" ? entry.payload.table : undefined;
  const table = explicit ?? sharedLedgerKindToTable[entry.kind];
  return table && sharedLedgerRestoreSpecs[table] ? table : undefined;
}

function sharedLedgerRestoreRank(entry: SharedLedgerEntry): number {
  const order = [
    "proposals",
    "evidence_bundles",
    "evidence_items",
    "query_audit",
    "approvals",
    "writeback_jobs",
    "writeback_intents",
    "idempotency_receipts",
    "writeback_receipts",
    "replay_records",
    "proposal_events",
    "shadow_human_actions",
    "worker_queue",
    "runner_state",
  ];
  const table = sharedLedgerTableForEntry(entry);
  const index = table ? order.indexOf(table) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sharedLedgerRestoreValue(payload: Record<string, unknown>, column: string): SQLInputValue {
  const key = column.endsWith("_json") ? column.slice(0, -5) : column;
  const value = payload[key] ?? payload[column];
  if (value == null) return null;
  if (sharedLedgerJsonColumns.has(column)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function comparePatches(
  proposalId: string,
  agentPatch: Record<string, unknown>,
  humanAction?: StoredShadowHumanAction,
): ShadowComparison {
  const comparedAt = new Date().toISOString();
  if (!humanAction) {
    return {
      proposal_id: proposalId,
      status: "no_human_action",
      agent_patch: agentPatch,
      matching_columns: [],
      differing_columns: [],
      missing_from_human: Object.keys(agentPatch),
      extra_human_columns: [],
      compared_at: comparedAt,
    };
  }
  const humanPatch = humanAction.patch;
  const agentColumns = Object.keys(agentPatch);
  const humanColumns = Object.keys(humanPatch);
  const matchingColumns = agentColumns.filter((column) => Object.is(agentPatch[column], humanPatch[column]));
  const differingColumns = agentColumns.filter((column) => column in humanPatch && !Object.is(agentPatch[column], humanPatch[column]));
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact = matchingColumns.length === agentColumns.length && differingColumns.length === 0 && missingFromHuman.length === 0 && extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    proposal_id: proposalId,
    status: exact ? "exact_match" : partial ? "partial_match" : "mismatch",
    agent_patch: agentPatch,
    human_patch: humanPatch,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
    notes: humanAction.notes,
    compared_at: comparedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
