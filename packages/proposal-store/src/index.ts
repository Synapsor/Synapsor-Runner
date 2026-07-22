import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalJsonDigest,
  parseChangeSet,
  parseExecutionReceipt,
  parseWritebackJob,
  parseWritebackResult,
  protocolVersions,
  type ChangeSet,
  type ExecutionReceipt,
  type ExecutionReceiptV2,
  type ExecutionReceiptV3,
  type ExecutionReceiptV4,
  type InverseDescriptorV1,
  type WritebackJob,
  type WritebackJobV1,
  type WritebackJobV2,
  type WritebackJobV3,
  type WritebackJobV4,
  type WritebackResult,
} from "@synapsor-runner/protocol";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
  action: "approve" | "reject" | "apply" | "revert" | "reconcile" | "worker_requeue" | "worker_discard";
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

export type StoredWritebackJob = {
  writeback_job_id: string;
  proposal_id: string;
  proposal_hash: string;
  status: string;
  kind: "direct_sql" | "app_handler";
  payload: Record<string, unknown>;
  normalized_job?: WritebackJob;
  created_at: string;
  updated_at: string;
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
  operation: "single_row_update" | "single_row_insert" | "single_row_delete" | "set_update" | "set_delete" | "batch_insert" | "restore_update" | "remove_insert" | "restore_insert";
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
  receipt: ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4;
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

export type CloudOutboxKind = "proposal" | "activity" | "result";
export type CloudOutboxStatus = "pending" | "leased" | "acknowledged" | "dead_letter" | "reconciliation_required";

export type CloudOutboxItem = {
  event_id: string;
  proposal_id?: string;
  sequence: number;
  kind: CloudOutboxKind;
  status: CloudOutboxStatus;
  payload_hash: `sha256:${string}`;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner?: string;
  lease_expires_at?: string;
  last_error_code?: string;
  created_at: string;
  updated_at: string;
  sent_at?: string;
  acknowledged_at?: string;
};

export type CloudGovernanceEvent = {
  event_id: string;
  proposal_id: string;
  cloud_proposal_id?: string;
  kind: string;
  state: string;
  authority: "synapsor_cloud";
  payload: Record<string, unknown>;
  integrity_hash: `sha256:${string}`;
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

export type ShadowAgentResult =
  | "proposed"
  | "policy_denied"
  | "unable_to_propose"
  | "stale_conflict"
  | "invalid_unsafe_scope_attempt";

export type ShadowOutcomeDisposition =
  | "applied"
  | "rejected_no_action"
  | "stale_conflict";

export type ShadowComparisonStatus =
  | "exact_agreement"
  | "partial_agreement"
  | "disagreement"
  | "human_rejected_no_action"
  | "agent_policy_denied"
  | "agent_unable_to_propose"
  | "stale_conflict"
  | "unmatched_no_authoritative_outcome"
  | "invalid_or_unsafe_scope_attempt";

export type StoredShadowStudy = {
  study_id: string;
  name: string;
  description?: string;
  selected_capabilities: string[];
  starts_at?: string;
  ends_at?: string;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
};

export type ShadowEffect = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  patch: Record<string, unknown>;
};

export type StoredShadowCase = {
  case_id: string;
  study_id: string;
  request_id: string;
  proposal_id?: string;
  tenant_id: string;
  principal?: string;
  capability: string;
  business_object: string;
  object_id: string;
  evidence_bundle_id?: string;
  proposed_effect?: ShadowEffect;
  agent_result: ShadowAgentResult;
  decision_reason?: string;
  risk_score?: number;
  amount_value?: number;
  created_at: string;
};

export type StoredShadowOutcome = {
  outcome_id: string;
  study_id: string;
  request_id: string;
  proposal_id?: string;
  tenant_id: string;
  business_object: string;
  object_id: string;
  actor: string;
  disposition: ShadowOutcomeDisposition;
  actual_effect?: ShadowEffect;
  occurred_at: string;
  source: string;
  reference?: string;
  reason?: string;
  created_at: string;
};

export type ShadowStudyComparison = {
  study_id: string;
  case_id: string;
  request_id: string;
  proposal_id?: string;
  tenant_id: string;
  principal?: string;
  capability: string;
  business_object: string;
  object_id: string;
  status: ShadowComparisonStatus;
  comparable: boolean;
  agent_result: ShadowAgentResult;
  proposed_effect?: ShadowEffect;
  outcome?: StoredShadowOutcome;
  matching_columns: string[];
  differing_columns: string[];
  missing_from_human: string[];
  extra_human_columns: string[];
  decision_reason?: string;
  risk_score?: number;
  amount_value?: number;
  compared_at: string;
};

export type ShadowDistribution = {
  count: number;
  minimum: number;
  maximum: number;
  mean: number;
  median: number;
  p95: number;
  total: number;
};

export type ShadowStudyReport = {
  study: StoredShadowStudy;
  total_tasks_observed: number;
  tasks_with_authoritative_outcomes: number;
  comparable_tasks: number;
  exact_agreements: number;
  exact_agreement_rate: number | null;
  partial_agreements: number;
  disagreements: number;
  human_rejections_no_action: number;
  policy_denials: number;
  stale_conflicts: number;
  unmatched_cases: number;
  invalid_or_unsafe_scope_attempts: number;
  amount_value_distribution: ShadowDistribution | null;
  by_capability: Record<string, Record<ShadowComparisonStatus, number>>;
  by_decision_reason: Record<string, number>;
  highest_risk_disagreements: ShadowStudyComparison[];
  suggested_policies: Array<{
    capability: string;
    suggestion: string;
    sample_size: number;
    active: false;
  }>;
  trust_progression: {
    current_stage: "observe" | "compare" | "manual_review" | "suggested_bounded_policy";
    minimum_policy_sample_size: 5;
    insufficient_sample_size: boolean;
    stages: Array<{
      name: "Observe" | "Compare" | "Manual review" | "Suggested bounded policy";
      status: "complete" | "current" | "locked";
      detail: string;
    }>;
    automatic_activation: false;
  };
  comparisons: ShadowStudyComparison[];
  generated_at: string;
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
  shadow_studies: number;
  shadow_study_cases: number;
  shadow_outcomes: number;
  worker_queue: number;
  policy_recommendations: number;
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
  revert_proposals: number;
  revert_applies: number;
};

export type GraduatedTrustMetrics = {
  window_start: string;
  window_end: string;
  human_reviewed: number;
  human_approved: number;
  human_rejected: number;
  conflicts: number;
  failures: number;
  reverts: number;
  auto_approved_excluded: number;
  rejection_rate: number;
  conflict_rate: number;
  failure_rate: number;
  revert_rate: number;
};

export type PolicyRecommendationStatus = "pending_review" | "approved" | "rejected" | "exported";

export type PolicyRecommendation = {
  schema_version: "synapsor.policy-recommendation.v1";
  recommendation_id: string;
  workspace_id?: string;
  project_id?: string;
  tenant_id: string;
  capability: string;
  policy: string;
  field: string;
  base_contract_digest: string;
  base_contract_version: string;
  current_threshold: number;
  proposed_threshold: number;
  maximum_increment: number;
  absolute_ceiling: number;
  criteria: Record<string, unknown>;
  metrics: GraduatedTrustMetrics;
  evidence_proposal_ids: string[];
  explanation: string[];
  status: PolicyRecommendationStatus;
  decision?: {
    actor: string;
    action: "approve" | "reject";
    reason: string;
    identity: OperatorIdentityProof;
    decided_at: string;
  };
  export?: {
    actor: string;
    artifact_digest: string;
    exported_at: string;
  };
  integrity_hash: string;
  created_at: string;
  updated_at: string;
};

export type CreatePolicyRecommendationInput = Omit<PolicyRecommendation, "schema_version" | "recommendation_id" | "status" | "decision" | "export" | "integrity_hash" | "created_at" | "updated_at"> & {
  now?: string;
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
  listProposals?(filters?: LocalProposalState | ProposalSearchFilters): MaybePromise<StoredProposal[]>;
  approvals?(proposalId: string): MaybePromise<StoredApproval[]>;
  approvalProgress?(proposalId: string): MaybePromise<ApprovalProgress>;
  operationalMetrics?(filters?: { tenant?: string; capability?: string }): MaybePromise<OperationalMetricRow[]>;
  fleetEventMetrics?(filters?: { tenant?: string; capability?: string }): MaybePromise<FleetEventMetricRow[]>;
  createPolicyRecommendation?(input: CreatePolicyRecommendationInput): MaybePromise<PolicyRecommendation>;
  getPolicyRecommendation?(recommendationId: string): MaybePromise<PolicyRecommendation | undefined>;
  listPolicyRecommendations?(filters?: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus }): MaybePromise<PolicyRecommendation[]>;
  decidePolicyRecommendation?(recommendationId: string, input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string }): MaybePromise<PolicyRecommendation>;
  markPolicyRecommendationExported?(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): MaybePromise<PolicyRecommendation>;
  events(proposalId: string): MaybePromise<ProposalEvent[]>;
  receipts(proposalId: string): MaybePromise<StoredWritebackReceipt[]>;
  getEvidenceBundle(evidenceBundleId: string): MaybePromise<StoredEvidenceBundle | undefined>;
  listEvidenceBundles?(filters?: EvidenceSearchFilters): MaybePromise<StoredEvidenceBundle[]>;
  listQueryAudit?(filters?: QueryAuditSearchFilters): MaybePromise<Record<string, unknown>[]>;
  replay(proposalId: string): MaybePromise<ProposalReplayRecord>;
  claimWritebackIntent?(job: WritebackJob, runnerId: string): MaybePromise<WritebackIntentClaim>;
  markWritebackIntentApplying?(intentId: string, runnerId: string): MaybePromise<void>;
  completeWritebackIntent?(intentId: string, result: WritebackResult): MaybePromise<void>;
  requireWritebackReconciliation?(intentId: string, reason: string): MaybePromise<void>;
  enqueueCloudOutbox?(input: {
    event_id: string;
    proposal_id?: string;
    sequence?: number;
    kind: CloudOutboxKind;
    payload: Record<string, unknown>;
    max_attempts?: number;
    now?: string;
  }): MaybePromise<CloudOutboxItem>;
  claimCloudOutbox?(input: { owner: string; limit?: number; lease_ms?: number; now?: string }): MaybePromise<CloudOutboxItem[]>;
  acknowledgeCloudOutbox?(eventId: string, owner: string, now?: string): MaybePromise<CloudOutboxItem>;
  failCloudOutbox?(input: { event_id: string; owner: string; error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean; now?: string }): MaybePromise<CloudOutboxItem>;
  requeueCloudOutbox?(eventId: string, now?: string): MaybePromise<CloudOutboxItem>;
  listCloudOutbox?(filters?: { status?: CloudOutboxStatus; proposal_id?: string; limit?: number }): MaybePromise<CloudOutboxItem[]>;
  compactCloudOutbox?(input: { acknowledged_before: string }): MaybePromise<number>;
  recordCloudGovernanceEvent?(input: Omit<CloudGovernanceEvent, "authority" | "integrity_hash" | "created_at"> & { created_at?: string }): MaybePromise<CloudGovernanceEvent>;
  listCloudGovernanceEvents?(proposalId?: string): MaybePromise<CloudGovernanceEvent[]>;
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
    // MCP servers and trusted workers may share one local spool. Wait through
    // short SQLite writer contention, while keeping persistent lock failures bounded.
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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
      shadow_studies: this.countTable("shadow_studies"),
      shadow_study_cases: this.countTable("shadow_study_cases"),
      shadow_outcomes: this.countTable("shadow_outcomes"),
      worker_queue: this.countTable("worker_queue"),
      policy_recommendations: this.countTable("policy_recommendations"),
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
      `SELECT proposal_id FROM proposals
       WHERE created_at < ? AND state IN ('applied', 'conflict', 'rejected', 'canceled')
         AND NOT EXISTS (
           SELECT 1 FROM cloud_outbox
           WHERE cloud_outbox.proposal_id = proposals.proposal_id
             AND cloud_outbox.status <> 'acknowledged'
         )`,
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
        run("cloud_outbox", `${proposalWhere.sql} AND status = 'acknowledged'`, proposalWhere.params);
        run("cloud_governance_events", proposalWhere.sql, proposalWhere.params);
        run("idempotency_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_jobs", proposalWhere.sql, proposalWhere.params);
        run("writeback_intents", proposalWhere.sql, proposalWhere.params);
        run("approvals", proposalWhere.sql, proposalWhere.params);
        run("proposal_events", proposalWhere.sql, proposalWhere.params);
        run("shadow_outcomes", proposalWhere.sql, proposalWhere.params);
        run("shadow_study_cases", proposalWhere.sql, proposalWhere.params);
        run("shadow_human_actions", proposalWhere.sql, proposalWhere.params);
        run("worker_queue", proposalWhere.sql, proposalWhere.params);
        run("replay_records", proposalWhere.sql, proposalWhere.params);
      } else {
        for (const table of ["cloud_outbox", "cloud_governance_events", "idempotency_receipts", "writeback_receipts", "writeback_jobs", "writeback_intents", "approvals", "proposal_events", "shadow_outcomes", "shadow_study_cases", "shadow_human_actions", "worker_queue", "replay_records"]) {
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

      CREATE TABLE IF NOT EXISTS shadow_studies (
        study_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        selected_capabilities_json TEXT NOT NULL,
        starts_at TEXT,
        ends_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadow_study_cases (
        case_id TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        proposal_id TEXT,
        tenant_id TEXT NOT NULL,
        principal TEXT,
        capability TEXT NOT NULL,
        business_object TEXT NOT NULL,
        object_id TEXT NOT NULL,
        evidence_bundle_id TEXT,
        proposed_effect_json TEXT,
        agent_result TEXT NOT NULL,
        decision_reason TEXT,
        risk_score REAL,
        amount_value REAL,
        created_at TEXT NOT NULL,
        UNIQUE(study_id, request_id, tenant_id, business_object, object_id),
        FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS shadow_outcomes (
        outcome_id TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        proposal_id TEXT,
        tenant_id TEXT NOT NULL,
        business_object TEXT NOT NULL,
        object_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        disposition TEXT NOT NULL,
        actual_effect_json TEXT,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        reference TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS runner_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cloud_outbox (
        event_id TEXT PRIMARY KEY,
        proposal_id TEXT,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        sent_at TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS cloud_governance_events (
        event_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        cloud_proposal_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        authority TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        integrity_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS policy_recommendations (
        recommendation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        policy TEXT NOT NULL,
        base_contract_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        integrity_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_shadow_studies_status ON shadow_studies(status, starts_at, ends_at);
      CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_study ON shadow_study_cases(study_id, created_at, case_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_proposal ON shadow_study_cases(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_study_request ON shadow_outcomes(study_id, request_id, occurred_at, outcome_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_proposal ON shadow_outcomes(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_policy_recommendations_scope ON policy_recommendations(tenant_id, capability, policy, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_outbox_due ON cloud_outbox(status, next_attempt_at, sequence, created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_outbox_proposal ON cloud_outbox(proposal_id, sequence, created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_governance_proposal ON cloud_governance_events(proposal_id, created_at);

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
      if (changeSet.mode === "shadow") {
        this.attachShadowChangeSetToActiveStudies(changeSet, now);
      }
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

  countProposals(filters: ProposalSearchFilters = {}): number {
    const query = buildProposalCountQuery(filters);
    const row = this.db.prepare(query.sql).get(...query.params);
    return isRecord(row) ? Number(row.count ?? 0) : 0;
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

  getStoredReplay(replayId: string): ProposalReplayRecord | undefined {
    const row = this.db.prepare("SELECT * FROM replay_records WHERE replay_id = ?").get(replayId);
    return rowToStoredReplay(row);
  }

  getStoredReplayForProposal(proposalId: string): ProposalReplayRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM replay_records
      WHERE proposal_id = ?
      ORDER BY created_at DESC, replay_id DESC
      LIMIT 1
    `).get(proposalId);
    return rowToStoredReplay(row);
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

  getWritebackJob(writebackJobId: string): StoredWritebackJob | undefined {
    return rowToWritebackJob(this.db.prepare("SELECT * FROM writeback_jobs WHERE writeback_job_id = ?").get(writebackJobId));
  }

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
        row = { tenant_id: tenantId, capability, proposals: 0, approvals: 0, rejections: 0, applies: 0, conflicts: 0, failures: 0, revert_proposals: 0, revert_applies: 0 };
        rows.set(key, row);
      }
      return row;
    };
    for (const proposal of this.listProposals({ tenant: filters.tenant, capability: filters.capability })) {
      const row = ensure(proposal.tenant_id, proposal.action);
      row.proposals += 1;
      if (proposal.change_set.schema_version === protocolVersions.compensationChangeSet) row.revert_proposals += 1;
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
      SELECT p.tenant_id, p.action, r.status, COUNT(*) AS count,
        SUM(CASE WHEN json_extract(p.change_set_json, '$.schema_version') = 'synapsor.compensation-change-set.v1' THEN 1 ELSE 0 END) AS revert_count
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
      if (raw.status === "applied" || raw.status === "already_applied") row.revert_applies += Number(raw.revert_count ?? 0);
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

  createPolicyRecommendation(input: CreatePolicyRecommendationInput): PolicyRecommendation {
    const now = input.now ?? new Date().toISOString();
    const identity = {
      tenant_id: input.tenant_id,
      capability: input.capability,
      policy: input.policy,
      base_contract_digest: input.base_contract_digest,
      current_threshold: input.current_threshold,
      proposed_threshold: input.proposed_threshold,
      evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
      created_at: now,
    };
    const recommendationId = `ptr_${canonicalJsonDigest(identity).slice("sha256:".length, "sha256:".length + 20)}`;
    const unsigned = {
      schema_version: "synapsor.policy-recommendation.v1" as const,
      recommendation_id: recommendationId,
      ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
      ...(input.project_id ? { project_id: input.project_id } : {}),
      tenant_id: input.tenant_id,
      capability: input.capability,
      policy: input.policy,
      field: input.field,
      base_contract_digest: input.base_contract_digest,
      base_contract_version: input.base_contract_version,
      current_threshold: input.current_threshold,
      proposed_threshold: input.proposed_threshold,
      maximum_increment: input.maximum_increment,
      absolute_ceiling: input.absolute_ceiling,
      criteria: input.criteria,
      metrics: input.metrics,
      evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
      explanation: [...input.explanation],
      status: "pending_review" as const,
      created_at: now,
      updated_at: now,
    };
    const recommendation: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    assertPolicyRecommendationShape(recommendation);
    assertNoSecretMaterial(recommendation, "policy_recommendation");
    this.db.prepare(`
      INSERT INTO policy_recommendations (
        recommendation_id, tenant_id, capability, policy, base_contract_digest,
        status, payload_json, integrity_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recommendation.recommendation_id,
      recommendation.tenant_id,
      recommendation.capability,
      recommendation.policy,
      recommendation.base_contract_digest,
      recommendation.status,
      JSON.stringify(policyRecommendationUnsigned(recommendation)),
      recommendation.integrity_hash,
      recommendation.created_at,
      recommendation.updated_at,
    );
    return recommendation;
  }

  getPolicyRecommendation(recommendationId: string): PolicyRecommendation | undefined {
    return rowToPolicyRecommendation(this.db.prepare("SELECT * FROM policy_recommendations WHERE recommendation_id = ?").get(recommendationId));
  }

  listPolicyRecommendations(filters: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus } = {}): PolicyRecommendation[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [column, value] of [["tenant_id", filters.tenant], ["capability", filters.capability], ["policy", filters.policy], ["status", filters.status]] as const) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
    const sql = `SELECT * FROM policy_recommendations${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, recommendation_id DESC`;
    return this.db.prepare(sql).all(...params).map(rowToPolicyRecommendation).filter((item): item is PolicyRecommendation => item !== undefined);
  }

  decidePolicyRecommendation(
    recommendationId: string,
    input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string },
  ): PolicyRecommendation {
    const recommendation = this.requirePolicyRecommendation(recommendationId);
    if (recommendation.status !== "pending_review") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_PENDING", `policy recommendation ${recommendationId} is ${recommendation.status}`);
    assertPolicyRecommendationIdentity(recommendation, input);
    const now = input.now ?? new Date().toISOString();
    const unsigned = {
      ...policyRecommendationUnsigned(recommendation),
      status: input.action === "approve" ? "approved" as const : "rejected" as const,
      decision: { actor: input.actor, action: input.action, reason: input.reason, identity: input.identity, decided_at: now },
      updated_at: now,
    };
    const updated: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?")
      .run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
    return updated;
  }

  markPolicyRecommendationExported(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): PolicyRecommendation {
    const recommendation = this.requirePolicyRecommendation(recommendationId);
    if (recommendation.status !== "approved") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_APPROVED", `policy recommendation ${recommendationId} is ${recommendation.status}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.artifact_digest)) throw new ProposalStoreError("POLICY_ARTIFACT_DIGEST_INVALID", "policy recommendation export requires a canonical SHA-256 artifact digest");
    const now = input.now ?? new Date().toISOString();
    const unsigned = {
      ...policyRecommendationUnsigned(recommendation),
      status: "exported" as const,
      export: { actor: input.actor, artifact_digest: input.artifact_digest, exported_at: now },
      updated_at: now,
    };
    const updated: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?")
      .run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
    return updated;
  }

  private requirePolicyRecommendation(recommendationId: string): PolicyRecommendation {
    const recommendation = this.getPolicyRecommendation(recommendationId);
    if (!recommendation) throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_FOUND", `policy recommendation not found: ${recommendationId}`);
    return recommendation;
  }

  enqueueCloudOutbox(input: {
    event_id: string;
    proposal_id?: string;
    sequence?: number;
    kind: CloudOutboxKind;
    payload: Record<string, unknown>;
    max_attempts?: number;
    now?: string;
  }): CloudOutboxItem {
    const eventId = input.event_id.trim();
    if (!eventId) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_ID_REQUIRED", "cloud outbox event_id is required");
    if (!(["proposal", "activity", "result"] as const).includes(input.kind)) throw new ProposalStoreError("CLOUD_OUTBOX_KIND_INVALID", `unsupported Cloud outbox kind: ${input.kind}`);
    if (input.proposal_id) this.requireProposal(input.proposal_id);
    assertNoSecretMaterial(input.payload, `cloud_outbox.${eventId}`);
    const payloadHash = canonicalJsonDigest(input.payload);
    const now = input.now ?? new Date().toISOString();
    const sequence = Math.max(0, Math.trunc(input.sequence ?? 0));
    const maxAttempts = Math.max(1, Math.min(100, Math.trunc(input.max_attempts ?? 12)));
    this.db.prepare(`
      INSERT OR IGNORE INTO cloud_outbox (
        event_id, proposal_id, sequence, kind, status, payload_hash, payload_json,
        attempts, max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
    `).run(eventId, input.proposal_id ?? null, sequence, input.kind, payloadHash, JSON.stringify(input.payload), maxAttempts, now, now, now);
    const item = this.requireCloudOutboxItem(eventId);
    if (item.payload_hash !== payloadHash || item.kind !== input.kind || item.proposal_id !== input.proposal_id) {
      throw new ProposalStoreError("CLOUD_OUTBOX_IDEMPOTENCY_MISMATCH", `cloud outbox event ${eventId} was already recorded with different immutable content`);
    }
    return item;
  }

  claimCloudOutbox(input: { owner: string; limit?: number; lease_ms?: number; now?: string }): CloudOutboxItem[] {
    const owner = input.owner.trim();
    if (!owner) throw new ProposalStoreError("CLOUD_OUTBOX_OWNER_REQUIRED", "cloud outbox lease owner is required");
    const now = input.now ?? new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(now) + Math.max(1_000, Math.min(300_000, input.lease_ms ?? 30_000))).toISOString();
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
    const claimed: string[] = [];
    this.transaction(() => {
      this.db.prepare(`
        UPDATE cloud_outbox
        SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at <= ?
      `).run(now, now);
      const rows = this.db.prepare(`
        SELECT candidate.event_id
        FROM cloud_outbox candidate
        WHERE candidate.status = 'pending'
          AND candidate.next_attempt_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_outbox earlier
            WHERE earlier.proposal_id = candidate.proposal_id
              AND earlier.sequence < candidate.sequence
              AND earlier.status NOT IN ('acknowledged')
          )
        ORDER BY candidate.sequence ASC, candidate.created_at ASC, candidate.event_id ASC
        LIMIT ?
      `).all(now, limit);
      for (const row of rows) {
        if (!isRecord(row) || typeof row.event_id !== "string") continue;
        const result = this.db.prepare(`
          UPDATE cloud_outbox
          SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
              sent_at = COALESCE(sent_at, ?), updated_at = ?
          WHERE event_id = ? AND status = 'pending'
        `).run(owner, leaseExpiresAt, now, now, row.event_id);
        if (Number(result.changes) === 1) claimed.push(row.event_id);
      }
    });
    return claimed.map((eventId) => this.requireCloudOutboxItem(eventId));
  }

  acknowledgeCloudOutbox(eventId: string, owner: string, now = new Date().toISOString()): CloudOutboxItem {
    const result = this.db.prepare(`
      UPDATE cloud_outbox
      SET status = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL,
          acknowledged_at = ?, last_error_code = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(now, now, eventId, owner);
    if (Number(result.changes) !== 1) throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${eventId} is not leased by ${owner}`);
    return this.requireCloudOutboxItem(eventId);
  }

  failCloudOutbox(input: { event_id: string; owner: string; error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean; now?: string }): CloudOutboxItem {
    const now = input.now ?? new Date().toISOString();
    const current = this.requireCloudOutboxItem(input.event_id);
    if (current.status !== "leased" || current.lease_owner !== input.owner) {
      throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${input.event_id} is not leased by ${input.owner}`);
    }
    const exhausted = current.attempts >= current.max_attempts;
    const status: CloudOutboxStatus = input.reconciliation
      ? "reconciliation_required"
      : input.retryable && !exhausted
        ? "pending"
        : "dead_letter";
    const fallbackDelay = Math.min(300_000, 500 * (2 ** Math.min(current.attempts, 9)));
    const delayMs = Math.max(0, Math.min(3_600_000, input.retry_after_ms ?? fallbackDelay));
    const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
    this.db.prepare(`
      UPDATE cloud_outbox
      SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?,
          next_attempt_at = ?, updated_at = ?
      WHERE event_id = ?
    `).run(status, input.error_code, nextAttemptAt, now, input.event_id);
    return this.requireCloudOutboxItem(input.event_id);
  }

  requeueCloudOutbox(eventId: string, now = new Date().toISOString()): CloudOutboxItem {
    const current = this.requireCloudOutboxItem(eventId);
    if (!(["dead_letter", "reconciliation_required"] as CloudOutboxStatus[]).includes(current.status)) {
      throw new ProposalStoreError("CLOUD_OUTBOX_NOT_REQUEUEABLE", `cloud outbox event ${eventId} is ${current.status}, not dead_letter or reconciliation_required`);
    }
    this.db.prepare(`
      UPDATE cloud_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
      WHERE event_id = ?
    `).run(now, now, eventId);
    return this.requireCloudOutboxItem(eventId);
  }

  listCloudOutbox(filters: { status?: CloudOutboxStatus; proposal_id?: string; limit?: number } = {}): CloudOutboxItem[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (filters.status) { conditions.push("status = ?"); values.push(filters.status); }
    if (filters.proposal_id) { conditions.push("proposal_id = ?"); values.push(filters.proposal_id); }
    const limit = Math.max(1, Math.min(10_000, Math.trunc(filters.limit ?? 100)));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM cloud_outbox ${where} ORDER BY sequence ASC, created_at ASC, event_id ASC LIMIT ?`)
      .all(...values, limit).map(rowToCloudOutboxItem).filter((item): item is CloudOutboxItem => item !== undefined);
  }

  compactCloudOutbox(input: { acknowledged_before: string }): number {
    const result = this.db.prepare("DELETE FROM cloud_outbox WHERE status = 'acknowledged' AND acknowledged_at < ?").run(input.acknowledged_before);
    return Number(result.changes);
  }

  recordCloudGovernanceEvent(input: Omit<CloudGovernanceEvent, "authority" | "integrity_hash" | "created_at"> & { created_at?: string }): CloudGovernanceEvent {
    this.requireProposal(input.proposal_id);
    assertNoSecretMaterial(input.payload, `cloud_governance_event.${input.event_id}`);
    const createdAt = input.created_at ?? new Date().toISOString();
    const unsigned = {
      event_id: input.event_id,
      proposal_id: input.proposal_id,
      ...(input.cloud_proposal_id ? { cloud_proposal_id: input.cloud_proposal_id } : {}),
      kind: input.kind,
      state: input.state,
      authority: "synapsor_cloud" as const,
      payload: input.payload,
      created_at: createdAt,
    };
    const event: CloudGovernanceEvent = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare(`
      INSERT OR IGNORE INTO cloud_governance_events (
        event_id, proposal_id, cloud_proposal_id, kind, state, authority, payload_json, integrity_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.event_id, event.proposal_id, event.cloud_proposal_id ?? null, event.kind, event.state, event.authority, JSON.stringify(event.payload), event.integrity_hash, event.created_at);
    const localState = localStateFromCloudGovernance(event.state);
    if (localState) {
      const sourceMutated = localState === "applied" ? 1 : 0;
      const projected = this.db.prepare(`
        UPDATE proposals
        SET state = ?, source_database_mutated = CASE WHEN ? = 1 THEN 1 ELSE source_database_mutated END, updated_at = ?
        WHERE proposal_id = ? AND state IN ('pending_review', 'approved', 'pending_worker')
      `).run(localState, sourceMutated, event.created_at, event.proposal_id);
      if (Number(projected.changes) === 1) {
        this.appendEvent(event.proposal_id, `proposal_cloud_${localState}`, "synapsor_cloud", {
          cloud_event_id: event.event_id,
          cloud_proposal_id: event.cloud_proposal_id ?? event.proposal_id,
          cloud_state: event.state,
          authority: event.authority,
        });
      }
    }
    const stored = this.listCloudGovernanceEvents(input.proposal_id).find((item) => item.event_id === input.event_id);
    if (!stored || stored.integrity_hash !== event.integrity_hash) {
      throw new ProposalStoreError("CLOUD_GOVERNANCE_EVENT_MISMATCH", `Cloud governance event ${input.event_id} conflicts with an existing immutable event`);
    }
    return stored;
  }

  listCloudGovernanceEvents(proposalId?: string): CloudGovernanceEvent[] {
    const rows = proposalId
      ? this.db.prepare("SELECT * FROM cloud_governance_events WHERE proposal_id = ? ORDER BY created_at ASC, event_id ASC").all(proposalId)
      : this.db.prepare("SELECT * FROM cloud_governance_events ORDER BY created_at ASC, event_id ASC").all();
    return rows.map(rowToCloudGovernanceEvent).filter((item): item is CloudGovernanceEvent => item !== undefined);
  }

  private requireCloudOutboxItem(eventId: string): CloudOutboxItem {
    const item = rowToCloudOutboxItem(this.db.prepare("SELECT * FROM cloud_outbox WHERE event_id = ?").get(eventId));
    if (!item) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `cloud outbox event not found: ${eventId}`);
    return item;
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
      { table: "shadow_studies", kind: "shadow_study", key: "study_id", created: "created_at" },
      { table: "shadow_study_cases", kind: "shadow_study_case", key: "case_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "shadow_outcomes", kind: "shadow_outcome", key: "outcome_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id" },
      { table: "worker_queue", kind: "worker_queue_item", key: "proposal_id", created: "created_at", proposal: "proposal_id" },
      { table: "runner_state", kind: "runner_state", key: "key", created: "updated_at" },
      { table: "policy_recommendations", kind: "policy_recommendation", key: "recommendation_id", created: "created_at", tenant: "tenant_id", capability: "capability" },
      { table: "cloud_outbox", kind: "cloud_outbox_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
      { table: "cloud_governance_events", kind: "cloud_governance_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
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

  createShadowStudy(input: {
    study_id?: string;
    name: string;
    description?: string;
    selected_capabilities?: string[];
    starts_at?: string;
    ends_at?: string;
  }): StoredShadowStudy {
    const name = requiredBoundedText(input.name, "shadow study name", 160);
    const description = optionalBoundedText(input.description, "shadow study description", 2_000);
    const selectedCapabilities = [...new Set((input.selected_capabilities ?? []).map((value) =>
      requiredBoundedText(value, "shadow study capability", 256),
    ))].sort();
    const startsAt = optionalIsoTimestamp(input.starts_at, "shadow study starts_at");
    const endsAt = optionalIsoTimestamp(input.ends_at, "shadow study ends_at");
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      throw new ProposalStoreError("SHADOW_STUDY_TIME_RANGE_INVALID", "shadow study ends_at must not precede starts_at");
    }
    assertNoSecretMaterial({ name, description, selected_capabilities: selectedCapabilities }, "shadow_study");
    const now = new Date().toISOString();
    const studyId = input.study_id
      ? safeShadowId(input.study_id, "study")
      : `sst_${canonicalJsonDigest({ name, now, ordinal: this.countTable("shadow_studies") }).slice("sha256:".length, "sha256:".length + 20)}`;
    try {
      this.db.prepare(`
        INSERT INTO shadow_studies (
          study_id, name, description, selected_capabilities_json, starts_at,
          ends_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        studyId,
        name,
        description ?? null,
        JSON.stringify(selectedCapabilities),
        startsAt ?? null,
        endsAt ?? null,
        now,
        now,
      );
    } catch (error) {
      throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", safeSqliteFailure(error, `shadow study ${studyId} could not be created`));
    }
    const study = this.getShadowStudy(studyId);
    if (!study) throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", `shadow study ${studyId} was not persisted`);
    this.syncShadowStudy(studyId);
    return this.getShadowStudy(studyId) ?? study;
  }

  getShadowStudy(studyId: string): StoredShadowStudy | undefined {
    return rowToShadowStudy(this.db.prepare("SELECT * FROM shadow_studies WHERE study_id = ?").get(studyId));
  }

  listShadowStudies(): StoredShadowStudy[] {
    return this.db.prepare("SELECT * FROM shadow_studies ORDER BY created_at DESC, study_id ASC").all()
      .map(rowToShadowStudy)
      .filter((study): study is StoredShadowStudy => study !== undefined);
  }

  closeShadowStudy(studyId: string, endsAt = new Date().toISOString()): StoredShadowStudy {
    this.requireShadowStudy(studyId);
    const normalizedEndsAt = optionalIsoTimestamp(endsAt, "shadow study ends_at")!;
    this.db.prepare(`
      UPDATE shadow_studies SET status = 'closed', ends_at = ?, updated_at = ?
      WHERE study_id = ?
    `).run(normalizedEndsAt, new Date().toISOString(), studyId);
    return this.requireShadowStudy(studyId);
  }

  syncShadowStudy(studyId: string): { attached: number; total: number } {
    const study = this.requireShadowStudy(studyId);
    let attached = 0;
    for (const proposal of this.listProposals().filter((item) => item.change_set.mode === "shadow")) {
      if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) continue;
      const before = this.shadowCases(studyId).length;
      this.addShadowProposalToStudy(studyId, proposal.proposal_id);
      if (this.shadowCases(studyId).length > before) attached += 1;
    }
    return { attached, total: this.shadowCases(studyId).length };
  }

  addShadowProposalToStudy(studyId: string, proposalId: string, requestId?: string): StoredShadowCase {
    const study = this.requireShadowStudy(studyId);
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) {
      throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `proposal ${proposalId} is outside shadow study ${studyId}`);
    }
    return this.recordShadowCase({
      study_id: studyId,
      request_id: requestId ?? proposal.interaction_id ?? proposal.tool_call_id ?? proposal.proposal_id,
      proposal_id: proposal.proposal_id,
      tenant_id: proposal.tenant_id,
      principal: proposal.principal,
      capability: proposal.capability ?? proposal.action,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      evidence_bundle_id: proposal.change_set.evidence.bundle_id,
      proposed_effect: shadowEffectFromChangeSet(proposal.change_set),
      agent_result: "proposed",
      amount_value: effectAmountValue(shadowEffectFromChangeSet(proposal.change_set)),
      created_at: proposal.created_at,
    });
  }

  recordShadowCase(input: {
    study_id: string;
    request_id: string;
    proposal_id?: string;
    tenant_id: string;
    principal?: string;
    capability: string;
    business_object: string;
    object_id: string;
    evidence_bundle_id?: string;
    proposed_effect?: ShadowEffect;
    agent_result: ShadowAgentResult;
    decision_reason?: string;
    risk_score?: number;
    amount_value?: number;
    created_at?: string;
  }): StoredShadowCase {
    const study = this.requireShadowStudy(input.study_id);
    const requestId = requiredBoundedText(input.request_id, "shadow request_id", 256);
    const tenantId = requiredBoundedText(input.tenant_id, "shadow tenant_id", 256);
    const capability = requiredBoundedText(input.capability, "shadow capability", 256);
    const businessObject = requiredBoundedText(input.business_object, "shadow business_object", 128);
    const objectId = requiredBoundedText(input.object_id, "shadow object_id", 256);
    assertShadowAgentResult(input.agent_result);
    if (!shadowStudyIncludes(study, capability, input.created_at ?? new Date().toISOString())) {
      throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `shadow case is outside study ${study.study_id}`);
    }
    if (input.proposal_id) {
      const proposal = this.requireProposal(input.proposal_id);
      if (proposal.change_set.mode !== "shadow") {
        throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${input.proposal_id} is not a shadow proposal`);
      }
      if (
        proposal.tenant_id !== tenantId ||
        proposal.business_object !== businessObject ||
        proposal.object_id !== objectId ||
        (proposal.capability ?? proposal.action) !== capability
      ) {
        throw new ProposalStoreError("SHADOW_CASE_PROPOSAL_SCOPE_MISMATCH", "shadow case does not match the proposal's trusted tenant, target, or capability");
      }
    }
    if (input.agent_result === "proposed" && !input.proposed_effect) {
      throw new ProposalStoreError("SHADOW_PROPOSED_EFFECT_REQUIRED", "a proposed shadow case requires a normalized proposed effect");
    }
    const proposedEffect = input.proposed_effect ? normalizeShadowEffect(input.proposed_effect, "shadow_case.proposed_effect") : undefined;
    const riskScore = optionalFiniteNumber(input.risk_score, "shadow risk_score", 0, 100);
    const amountValue = optionalFiniteNumber(
      input.amount_value ?? (proposedEffect ? effectAmountValue(proposedEffect) : undefined),
      "shadow amount_value",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const createdAt = optionalIsoTimestamp(input.created_at, "shadow case created_at") ?? new Date().toISOString();
    const caseId = `scase_${canonicalJsonDigest({
      study_id: study.study_id,
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId,
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    const payload = {
      request_id: requestId,
      tenant_id: tenantId,
      principal: input.principal,
      capability,
      business_object: businessObject,
      object_id: objectId,
      evidence_bundle_id: input.evidence_bundle_id,
      proposed_effect: proposedEffect,
      decision_reason: input.decision_reason,
    };
    assertNoSecretMaterial(payload, "shadow_case");
    this.db.prepare(`
      INSERT INTO shadow_study_cases (
        case_id, study_id, request_id, proposal_id, tenant_id, principal,
        capability, business_object, object_id, evidence_bundle_id,
        proposed_effect_json, agent_result, decision_reason, risk_score,
        amount_value, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(study_id, request_id, tenant_id, business_object, object_id)
      DO NOTHING
    `).run(
      caseId,
      study.study_id,
      requestId,
      input.proposal_id ?? null,
      tenantId,
      optionalBoundedText(input.principal, "shadow principal", 256) ?? null,
      capability,
      businessObject,
      objectId,
      optionalBoundedText(input.evidence_bundle_id, "shadow evidence reference", 256) ?? null,
      proposedEffect ? JSON.stringify(proposedEffect) : null,
      input.agent_result,
      optionalBoundedText(input.decision_reason, "shadow decision reason", 2_000) ?? null,
      riskScore ?? null,
      amountValue ?? null,
      createdAt,
    );
    const stored = this.getShadowCase(caseId)
      ?? this.shadowCases(study.study_id).find((item) =>
        item.request_id === requestId &&
        item.tenant_id === tenantId &&
        item.business_object === businessObject &&
        item.object_id === objectId
      );
    if (!stored) throw new ProposalStoreError("SHADOW_CASE_CREATE_FAILED", `shadow case ${caseId} was not persisted`);
    if (
      stored.agent_result !== input.agent_result ||
      stored.capability !== capability ||
      stored.proposal_id !== input.proposal_id
    ) {
      throw new ProposalStoreError("SHADOW_CASE_IDENTITY_CONFLICT", `shadow case identity already exists with different immutable intent`);
    }
    return stored;
  }

  getShadowCase(caseId: string): StoredShadowCase | undefined {
    return rowToShadowCase(this.db.prepare("SELECT * FROM shadow_study_cases WHERE case_id = ?").get(caseId));
  }

  shadowCases(studyId: string): StoredShadowCase[] {
    return this.db.prepare(`
      SELECT * FROM shadow_study_cases WHERE study_id = ?
      ORDER BY created_at ASC, case_id ASC
    `).all(studyId).map(rowToShadowCase).filter((item): item is StoredShadowCase => item !== undefined);
  }

  recordShadowOutcome(input: {
    study_id: string;
    request_id: string;
    proposal_id?: string;
    tenant_id: string;
    business_object: string;
    object_id: string;
    actor: string;
    disposition: ShadowOutcomeDisposition;
    actual_effect?: ShadowEffect;
    occurred_at?: string;
    source: string;
    reference?: string;
    reason?: string;
  }): StoredShadowOutcome {
    const study = this.requireShadowStudy(input.study_id);
    const requestId = requiredBoundedText(input.request_id, "shadow outcome request_id", 256);
    const tenantId = requiredBoundedText(input.tenant_id, "shadow outcome tenant_id", 256);
    const businessObject = requiredBoundedText(input.business_object, "shadow outcome business_object", 128);
    const objectId = requiredBoundedText(input.object_id, "shadow outcome object_id", 256);
    assertShadowOutcomeDisposition(input.disposition);
    const matchingCase = this.shadowCases(study.study_id).find((item) =>
      item.request_id === requestId &&
      item.tenant_id === tenantId &&
      item.business_object === businessObject &&
      item.object_id === objectId
    );
    if (!matchingCase) {
      throw new ProposalStoreError("SHADOW_OUTCOME_CASE_NOT_FOUND", "authoritative outcome does not match a case in this shadow study");
    }
    if (input.proposal_id !== undefined && matchingCase.proposal_id !== input.proposal_id) {
      throw new ProposalStoreError("SHADOW_OUTCOME_PROPOSAL_MISMATCH", "authoritative outcome proposal does not match the correlated shadow case");
    }
    if (input.disposition === "applied" && !input.actual_effect) {
      throw new ProposalStoreError("SHADOW_ACTUAL_EFFECT_REQUIRED", "an applied authoritative outcome requires actual before/after effect");
    }
    const actualEffect = input.actual_effect ? normalizeShadowEffect(input.actual_effect, "shadow_outcome.actual_effect") : undefined;
    const occurredAt = optionalIsoTimestamp(input.occurred_at, "shadow outcome occurred_at") ?? new Date().toISOString();
    const actor = requiredBoundedText(input.actor, "shadow outcome actor", 256);
    const source = requiredBoundedText(input.source, "shadow outcome source", 256);
    const reference = optionalBoundedText(input.reference, "shadow outcome reference", 1_024);
    const reason = optionalBoundedText(input.reason, "shadow outcome reason", 2_000);
    assertNoSecretMaterial({
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId,
      actor,
      source,
      actual_effect: actualEffect,
      reference,
      reason,
    }, "shadow_outcome");
    const outcomeId = `sout_${canonicalJsonDigest({
      study_id: study.study_id,
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId,
      actor,
      disposition: input.disposition,
      actual_effect: actualEffect ?? null,
      occurred_at: occurredAt,
      source,
      reference: reference ?? null,
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO shadow_outcomes (
        outcome_id, study_id, request_id, proposal_id, tenant_id,
        business_object, object_id, actor, disposition, actual_effect_json,
        occurred_at, source, reference, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcomeId,
      study.study_id,
      requestId,
      matchingCase.proposal_id ?? null,
      tenantId,
      businessObject,
      objectId,
      actor,
      input.disposition,
      actualEffect ? JSON.stringify(actualEffect) : null,
      occurredAt,
      source,
      reference ?? null,
      reason ?? null,
      new Date().toISOString(),
    );
    const outcome = this.getShadowOutcome(outcomeId);
    if (!outcome) throw new ProposalStoreError("SHADOW_OUTCOME_CREATE_FAILED", `shadow outcome ${outcomeId} was not persisted`);
    return outcome;
  }

  getShadowOutcome(outcomeId: string): StoredShadowOutcome | undefined {
    return rowToShadowOutcome(this.db.prepare("SELECT * FROM shadow_outcomes WHERE outcome_id = ?").get(outcomeId));
  }

  shadowOutcomes(studyId: string): StoredShadowOutcome[] {
    return this.db.prepare(`
      SELECT * FROM shadow_outcomes WHERE study_id = ?
      ORDER BY occurred_at ASC, outcome_id ASC
    `).all(studyId).map(rowToShadowOutcome).filter((item): item is StoredShadowOutcome => item !== undefined);
  }

  compareShadowStudyCase(caseId: string): ShadowStudyComparison {
    const shadowCase = this.getShadowCase(caseId);
    if (!shadowCase) throw new ProposalStoreError("SHADOW_CASE_NOT_FOUND", `shadow case not found: ${caseId}`);
    const outcome = this.latestShadowOutcomeForCase(shadowCase);
    return compareShadowStudyCase(shadowCase, outcome);
  }

  shadowStudyReport(studyId: string): ShadowStudyReport {
    const study = this.requireShadowStudy(studyId);
    const cases = this.shadowCases(studyId);
    const outcomes = this.shadowOutcomes(studyId);
    const comparisons = cases.map((item) => this.compareShadowStudyCase(item.case_id));
    const comparable = comparisons.filter((item) => item.comparable);
    const exact = countShadowStatus(comparisons, "exact_agreement");
    const byCapability: ShadowStudyReport["by_capability"] = {};
    const byDecisionReason: Record<string, number> = {};
    for (const comparison of comparisons) {
      byCapability[comparison.capability] ??= emptyShadowStatusCounts();
      byCapability[comparison.capability]![comparison.status] += 1;
      const reason = comparison.decision_reason ?? comparison.outcome?.reason ?? "(none recorded)";
      byDecisionReason[reason] = (byDecisionReason[reason] ?? 0) + 1;
    }
    const amountValues = comparisons
      .map((item) => item.amount_value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const highestRisk = comparisons
      .filter((item) => item.status === "disagreement" || item.status === "partial_agreement" || item.status === "invalid_or_unsafe_scope_attempt")
      .sort((left, right) =>
        (right.risk_score ?? 0) - (left.risk_score ?? 0) ||
        (right.amount_value ?? 0) - (left.amount_value ?? 0) ||
        left.case_id.localeCompare(right.case_id)
      )
      .slice(0, 10);
    const suggestedPolicies = suggestedShadowPolicies(comparisons);
    return {
      study,
      total_tasks_observed: comparisons.length,
      tasks_with_authoritative_outcomes: comparisons.filter((item) => item.outcome !== undefined).length,
      comparable_tasks: comparable.length,
      exact_agreements: exact,
      exact_agreement_rate: comparable.length === 0 ? null : exact / comparable.length,
      partial_agreements: countShadowStatus(comparisons, "partial_agreement"),
      disagreements: countShadowStatus(comparisons, "disagreement"),
      human_rejections_no_action: countShadowStatus(comparisons, "human_rejected_no_action"),
      policy_denials: countShadowStatus(comparisons, "agent_policy_denied"),
      stale_conflicts: countShadowStatus(comparisons, "stale_conflict"),
      unmatched_cases: countShadowStatus(comparisons, "unmatched_no_authoritative_outcome"),
      invalid_or_unsafe_scope_attempts: countShadowStatus(comparisons, "invalid_or_unsafe_scope_attempt"),
      amount_value_distribution: distribution(amountValues),
      by_capability: byCapability,
      by_decision_reason: byDecisionReason,
      highest_risk_disagreements: highestRisk,
      suggested_policies: suggestedPolicies,
      trust_progression: shadowTrustProgression(comparisons, suggestedPolicies),
      comparisons,
      generated_at: latestIsoTimestamp([
        study.updated_at,
        ...cases.map((item) => item.created_at),
        ...outcomes.map((item) => item.created_at),
      ]),
    };
  }

  private requireShadowStudy(studyId: string): StoredShadowStudy {
    const study = this.getShadowStudy(studyId);
    if (!study) throw new ProposalStoreError("SHADOW_STUDY_NOT_FOUND", `shadow study not found: ${studyId}`);
    return study;
  }

  private latestShadowOutcomeForCase(shadowCase: StoredShadowCase): StoredShadowOutcome | undefined {
    return rowToShadowOutcome(this.db.prepare(`
      SELECT * FROM shadow_outcomes
      WHERE study_id = ? AND request_id = ? AND tenant_id = ?
        AND business_object = ? AND object_id = ?
      ORDER BY occurred_at DESC, outcome_id DESC
      LIMIT 1
    `).get(
      shadowCase.study_id,
      shadowCase.request_id,
      shadowCase.tenant_id,
      shadowCase.business_object,
      shadowCase.object_id,
    ));
  }

  private attachShadowChangeSetToActiveStudies(changeSet: ChangeSet, createdAt: string): void {
    const studies = this.db.prepare("SELECT * FROM shadow_studies WHERE status = 'active'").all()
      .map(rowToShadowStudy)
      .filter((study): study is StoredShadowStudy => study !== undefined);
    for (const study of studies) {
      if (!shadowStudyIncludes(study, changeSet.action, createdAt)) continue;
      this.insertShadowCaseFromChangeSet(study.study_id, changeSet, createdAt);
    }
  }

  private insertShadowCaseFromChangeSet(studyId: string, changeSet: ChangeSet, createdAt: string): void {
    const requestId = changeSet.proposal_id;
    const caseId = `scase_${canonicalJsonDigest({
      study_id: studyId,
      request_id: requestId,
      tenant_id: changeSet.scope.tenant_id,
      business_object: changeSet.scope.business_object,
      object_id: changeSet.scope.object_id,
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    const effect = shadowEffectFromChangeSet(changeSet);
    this.db.prepare(`
      INSERT OR IGNORE INTO shadow_study_cases (
        case_id, study_id, request_id, proposal_id, tenant_id, principal,
        capability, business_object, object_id, evidence_bundle_id,
        proposed_effect_json, agent_result, decision_reason, risk_score,
        amount_value, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?)
    `).run(
      caseId,
      studyId,
      requestId,
      changeSet.proposal_id,
      changeSet.scope.tenant_id,
      changeSet.principal.id,
      changeSet.action,
      changeSet.scope.business_object,
      changeSet.scope.object_id,
      changeSet.evidence.bundle_id,
      JSON.stringify(effect),
      effectAmountValue(effect) ?? null,
      createdAt,
    );
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
    const legacyStudy = this.getShadowStudy("sst_legacy")
      ?? this.createShadowStudy({
        study_id: "sst_legacy",
        name: "Legacy shadow comparison",
        description: "Compatibility study for shadow record-human-action commands.",
      });
    const shadowCase = this.addShadowProposalToStudy(legacyStudy.study_id, proposalId);
    this.recordShadowOutcome({
      study_id: legacyStudy.study_id,
      request_id: shadowCase.request_id,
      proposal_id: proposalId,
      tenant_id: proposal.tenant_id,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      actor: input.actor,
      disposition: "applied",
      actual_effect: normalizeShadowEffect({
        before: proposal.change_set.before,
        after: { ...proposal.change_set.before, ...input.patch },
        patch: input.patch,
      }, "shadow_human_action.effect"),
      occurred_at: now,
      source: "legacy_cli",
      reference: `shadow_human_action:${actionId}`,
      reason: input.notes,
    });
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
  const { clauses, params } = proposalQueryParts(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return {
    sql: `SELECT * FROM proposals${where} ORDER BY created_at DESC, proposal_id DESC${filters.limit ? " LIMIT ?" : ""}`,
    params: filters.limit ? [...params, filters.limit] : params,
  };
}

function buildProposalCountQuery(filters: ProposalSearchFilters): SqlQuery {
  const { clauses, params } = proposalQueryParts(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { sql: `SELECT COUNT(*) AS count FROM proposals${where}`, params };
}

function proposalQueryParts(filters: ProposalSearchFilters): { clauses: string[]; params: SqlParam[] } {
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
  return { clauses, params };
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

function localStateFromCloudGovernance(state: string): LocalProposalState | undefined {
  if (state === "applied" || state === "already_applied") return "applied";
  if (state === "rejected") return "rejected";
  if (state === "canceled") return "canceled";
  if (state === "conflict") return "conflict";
  if (state === "failed") return "failed";
  if (state === "indeterminate" || state === "reconciliation_required") return "reconciliation_required";
  return undefined;
}

function receiptToWritebackResult(receipt: ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4): WritebackResult {
  if (receipt.schema_version === protocolVersions.executionReceiptV4) {
    return parseWritebackResult({
      protocol_version: protocolVersions.normalizedWritebackJobV4,
      job_id: receipt.writeback_job_id,
      runner_id: receipt.runner_id,
      operation: receipt.operation,
      receipt_authority: receipt.receipt_authority,
      status: receipt.status,
      affected_rows: receipt.rows_affected,
      target_identities: receipt.target.identities,
      member_effects: receipt.member_effects,
      inverse: receipt.inverse,
      result_hash: receipt.receipt_hash,
      completed_at: receipt.executed_at,
      error_code: receipt.safe_error_code,
      intent_id: receipt.reconciliation?.intent_id,
    });
  }
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
      inverse: receipt.inverse,
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
    inverse: receipt.inverse,
    result_hash: receipt.receipt_hash,
    completed_at: receipt.executed_at,
    error_code: receipt.safe_error_code,
    intent_id: receipt.reconciliation?.intent_id,
  });
}

function inverseCaptureFromChangeSet(changeSet: ChangeSet, writebackJobId: string): InverseDescriptorV1 | undefined {
  if (changeSet.schema_version !== protocolVersions.changeSetV2 && changeSet.schema_version !== protocolVersions.changeSetV3) return undefined;
  if (!changeSet.reversibility || changeSet.reversibility.mode !== "reviewed_inverse") return undefined;
  const base = {
    schema_version: protocolVersions.inverseDescriptor,
    cardinality: changeSet.schema_version === protocolVersions.changeSetV3 ? "set" as const : "single" as const,
    forward_proposal_id: changeSet.proposal_id,
    forward_writeback_job_id: writebackJobId,
    target: {
      source_id: changeSet.source.source_id,
      schema: changeSet.source.schema,
      table: changeSet.source.table,
      primary_key_column: changeSet.source.primary_key.column,
    },
    tenant_guard: changeSet.guards.tenant,
    ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
    allowed_columns: changeSet.guards.allowed_columns,
    lineage: changeSet.reversibility.lineage,
  } as const;
  if (changeSet.schema_version === protocolVersions.changeSetV2) {
    const primaryValue = changeSet.source.primary_key.value;
    if (primaryValue === undefined) throw new ProposalStoreError("REVERSIBILITY_PRIMARY_KEY_REQUIRED", `reversible proposal ${changeSet.proposal_id} has no deterministic primary-key identity`);
    if (changeSet.operation === "single_row_delete") {
      return {
        ...base,
        availability: "best_effort_unavailable",
        reason_codes: ["HARD_DELETE_HIDDEN_STATE_NOT_RESTORABLE", "HARD_DELETE_SIDE_EFFECTS_NOT_REVERSIBLE"],
        operation: "restore_insert",
        members: [{ primary_key: { column: changeSet.source.primary_key.column, value: primaryValue }, expected_state: {} }],
        max_rows: 1,
        aggregate_bounds: [],
      };
    }
    if (changeSet.operation === "single_row_insert") {
      return {
        ...base,
        availability: "available",
        reason_codes: [],
        operation: "remove_insert",
        members: [{
          primary_key: { column: changeSet.source.primary_key.column, value: primaryValue },
          expected_state: selectReviewedState(changeSet.after, [changeSet.source.primary_key.column, changeSet.guards.tenant.column, ...(changeSet.guards.principal_scope ? [changeSet.guards.principal_scope.column] : []), ...changeSet.guards.allowed_columns]),
        }],
        max_rows: 1,
        aggregate_bounds: [],
      };
    }
    const versionAdvance = changeSet.guards.version_advance;
    if (!versionAdvance || versionAdvance.strategy !== "integer_increment") throw new ProposalStoreError("REVERSIBILITY_INTEGER_VERSION_REQUIRED", `reversible proposal ${changeSet.proposal_id} requires integer version advancement`);
    return {
      ...base,
      availability: "available",
      reason_codes: [],
      operation: "restore_update",
      members: [{
        primary_key: { column: changeSet.source.primary_key.column, value: primaryValue },
        expected_state: selectReviewedState(changeSet.after, [...changeSet.guards.allowed_columns, versionAdvance.column]),
        restore_values: selectReviewedState(changeSet.before, changeSet.guards.allowed_columns),
      }],
      max_rows: 1,
      aggregate_bounds: [],
      version_advance: versionAdvance,
    };
  }
  if (changeSet.operation === "set_delete") {
    return {
      ...base,
      availability: "best_effort_unavailable",
      reason_codes: ["HARD_DELETE_HIDDEN_STATE_NOT_RESTORABLE", "HARD_DELETE_SIDE_EFFECTS_NOT_REVERSIBLE"],
      operation: "restore_insert",
      members: changeSet.frozen_set.members.map((member) => ({ primary_key: member.primary_key, expected_state: {} })),
      max_rows: changeSet.frozen_set.max_rows,
      aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    };
  }
  if (changeSet.operation === "batch_insert") {
    return {
      ...base,
      availability: "available",
      reason_codes: [],
      operation: "remove_insert",
      members: changeSet.frozen_set.members.map((member) => ({
        primary_key: member.primary_key,
        expected_state: selectReviewedState(member.after, [changeSet.source.primary_key.column, changeSet.guards.tenant.column, ...changeSet.guards.allowed_columns]),
      })),
      max_rows: changeSet.frozen_set.max_rows,
      aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    };
  }
  const versionAdvance = changeSet.guards.version_advance;
  if (!versionAdvance || versionAdvance.strategy !== "integer_increment") throw new ProposalStoreError("REVERSIBILITY_INTEGER_VERSION_REQUIRED", `reversible proposal ${changeSet.proposal_id} requires integer version advancement`);
  return {
    ...base,
    availability: "available",
    reason_codes: [],
    operation: "restore_update",
    members: changeSet.frozen_set.members.map((member) => ({
      primary_key: member.primary_key,
      expected_state: selectReviewedState(member.after, [...changeSet.guards.allowed_columns, versionAdvance.column]),
      restore_values: selectReviewedState(member.before, changeSet.guards.allowed_columns),
    })),
    max_rows: changeSet.frozen_set.max_rows,
    aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    version_advance: versionAdvance,
  };
}

function selectReviewedState(value: Record<string, unknown>, columns: string[]): Record<string, string | number | boolean | null> {
  const selected: Record<string, string | number | boolean | null> = {};
  for (const column of [...new Set(columns)].sort()) {
    const item = value[column];
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") selected[column] = item;
  }
  return selected;
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
  if (changeSet.schema_version === protocolVersions.changeSetV3 || changeSet.schema_version === protocolVersions.compensationChangeSet) return { kind: "none" };
  const guard = "expected_version" in changeSet.guards ? changeSet.guards.expected_version : undefined;
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

function rowToPolicyRecommendation(row: unknown): PolicyRecommendation | undefined {
  if (!isRecord(row)) return undefined;
  let unsigned: Omit<PolicyRecommendation, "integrity_hash">;
  try {
    unsigned = JSON.parse(String(row.payload_json)) as Omit<PolicyRecommendation, "integrity_hash">;
  } catch {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", "policy recommendation payload is not valid JSON");
  }
  const recommendation = { ...unsigned, integrity_hash: String(row.integrity_hash) } as PolicyRecommendation;
  assertPolicyRecommendationShape(recommendation);
  if (
    recommendation.recommendation_id !== String(row.recommendation_id)
    || recommendation.tenant_id !== String(row.tenant_id)
    || recommendation.capability !== String(row.capability)
    || recommendation.policy !== String(row.policy)
    || recommendation.base_contract_digest !== String(row.base_contract_digest)
    || recommendation.status !== String(row.status)
  ) throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", `policy recommendation ${String(row.recommendation_id)} index fields do not match its signed payload`);
  const expected = canonicalJsonDigest(policyRecommendationUnsigned(recommendation));
  if (recommendation.integrity_hash !== expected) throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", `policy recommendation ${recommendation.recommendation_id} failed its integrity check`);
  return recommendation;
}

function policyRecommendationUnsigned(recommendation: PolicyRecommendation): Omit<PolicyRecommendation, "integrity_hash"> {
  const { integrity_hash: _integrityHash, ...unsigned } = recommendation;
  return unsigned;
}

function assertPolicyRecommendationShape(recommendation: PolicyRecommendation): void {
  if (recommendation.schema_version !== "synapsor.policy-recommendation.v1") throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "unsupported policy recommendation schema version");
  if (!/^ptr_[a-f0-9]{20}$/.test(recommendation.recommendation_id)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation id is invalid");
  for (const [name, value] of [["tenant", recommendation.tenant_id], ["capability", recommendation.capability], ["policy", recommendation.policy], ["field", recommendation.field]] as const) {
    if (!value || value.length > 256) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", `policy recommendation ${name} is invalid`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(recommendation.base_contract_digest)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation base digest is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(recommendation.integrity_hash)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation integrity digest is invalid");
  if (!Number.isFinite(recommendation.current_threshold) || !Number.isFinite(recommendation.proposed_threshold) || !Number.isFinite(recommendation.maximum_increment) || !Number.isFinite(recommendation.absolute_ceiling)) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation thresholds must be finite numbers");
  }
  if (recommendation.proposed_threshold <= recommendation.current_threshold || recommendation.proposed_threshold - recommendation.current_threshold > recommendation.maximum_increment || recommendation.proposed_threshold > recommendation.absolute_ceiling) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation exceeds its reviewed increment or ceiling");
  }
  if (!Array.isArray(recommendation.evidence_proposal_ids) || recommendation.evidence_proposal_ids.length === 0 || recommendation.evidence_proposal_ids.length > 10_000) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation requires bounded proposal evidence");
  }
  if (!isRecord(recommendation.metrics) || !isRecord(recommendation.criteria)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation criteria and metrics are required");
  if (!(["pending_review", "approved", "rejected", "exported"] as string[]).includes(recommendation.status)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation status is invalid");
}

function assertPolicyRecommendationIdentity(
  recommendation: PolicyRecommendation,
  input: { action: "approve" | "reject"; actor: string; identity: OperatorIdentityProof },
): void {
  const proof = input.identity;
  if (!proof.verified || proof.provider === "dev_env") throw new ProposalStoreError("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED", "policy recommendation decisions require a cryptographically verified operator identity");
  if (proof.subject !== input.actor || proof.decision.subject !== input.actor) throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_MISMATCH", "policy recommendation actor does not match the verified identity");
  if (proof.decision.action !== input.action || proof.decision.proposal_id !== recommendation.recommendation_id || proof.decision.proposal_hash !== recommendation.integrity_hash || proof.decision.proposal_version !== 1) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_MISMATCH", "verified operator decision is not bound to this policy recommendation version");
  }
  const { integrity_hash: _integrityHash, ...core } = proof;
  const canonicalCore = JSON.parse(JSON.stringify(core)) as Record<string, unknown>;
  if (proof.integrity_hash !== canonicalJsonDigest(canonicalCore)) throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_TAMPERED", "verified operator identity proof failed its integrity check");
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

function rowToCloudOutboxItem(row: unknown): CloudOutboxItem | undefined {
  if (!isRecord(row)) return undefined;
  const kind = String(row.kind);
  const status = String(row.status);
  if (!["proposal", "activity", "result"].includes(kind) || !["pending", "leased", "acknowledged", "dead_letter", "reconciliation_required"].includes(status)) return undefined;
  return {
    event_id: String(row.event_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    sequence: Number(row.sequence),
    kind: kind as CloudOutboxKind,
    status: status as CloudOutboxStatus,
    payload_hash: String(row.payload_hash) as `sha256:${string}`,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    lease_owner: row.lease_owner == null ? undefined : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    last_error_code: row.last_error_code == null ? undefined : String(row.last_error_code),
    sent_at: row.sent_at == null ? undefined : String(row.sent_at),
    acknowledged_at: row.acknowledged_at == null ? undefined : String(row.acknowledged_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToCloudGovernanceEvent(row: unknown): CloudGovernanceEvent | undefined {
  if (!isRecord(row) || String(row.authority) !== "synapsor_cloud") return undefined;
  return {
    event_id: String(row.event_id),
    proposal_id: String(row.proposal_id),
    cloud_proposal_id: row.cloud_proposal_id == null ? undefined : String(row.cloud_proposal_id),
    kind: String(row.kind),
    state: String(row.state),
    authority: "synapsor_cloud",
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    integrity_hash: String(row.integrity_hash) as `sha256:${string}`,
    created_at: String(row.created_at),
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

function rowToWritebackJob(row: unknown): StoredWritebackJob | undefined {
  if (!isRecord(row)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.job_json));
  } catch {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not an object`);
  }
  const handler = payload.schema_version === "synapsor.handler-writeback.v1";
  let normalizedJob: WritebackJob | undefined;
  if (!handler) {
    try {
      normalizedJob = parseWritebackJob(payload);
    } catch {
      throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not a supported writeback protocol`);
    }
  }
  const payloadJobId = handler ? payload.writeback_job_id : normalizedJob?.job_id;
  const payloadProposalId = handler ? payload.proposal_id : normalizedJob?.proposal_id;
  const payloadProposalHash = handler ? payload.proposal_hash : normalizedJob?.approval_id;
  if (
    payloadJobId !== String(row.writeback_job_id)
    || payloadProposalId !== String(row.proposal_id)
    || payloadProposalHash !== String(row.proposal_hash)
  ) {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} index fields do not match its payload`);
  }
  return {
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    proposal_hash: String(row.proposal_hash),
    status: String(row.status),
    kind: handler ? "app_handler" : "direct_sql",
    payload,
    ...(normalizedJob ? { normalized_job: normalizedJob } : {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToStoredReplay(row: unknown): ProposalReplayRecord | undefined {
  if (!isRecord(row)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${String(row.replay_id)} payload is not valid JSON`);
  }
  if (!isRecord(payload) || !isRecord(payload.proposal)) {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${String(row.replay_id)} payload is not a supported replay record`);
  }
  const replayId = String(row.replay_id);
  const proposalId = String(row.proposal_id);
  if (
    payload.replay_id !== replayId
    || payload.proposal.proposal_id !== proposalId
    || !Array.isArray(payload.approvals)
    || !Array.isArray(payload.events)
    || !Array.isArray(payload.receipts)
    || !Array.isArray(payload.query_audit)
    || !Array.isArray(payload.evidence)
    || typeof payload.generated_at !== "string"
  ) {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${replayId} index fields do not match its payload`);
  }
  return payload as unknown as ProposalReplayRecord;
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

function rowToShadowStudy(row: unknown): StoredShadowStudy | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (status !== "active" && status !== "closed") return undefined;
  const capabilities = JSON.parse(String(row.selected_capabilities_json)) as unknown;
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) return undefined;
  return {
    study_id: String(row.study_id),
    name: String(row.name),
    description: row.description == null ? undefined : String(row.description),
    selected_capabilities: capabilities,
    starts_at: row.starts_at == null ? undefined : String(row.starts_at),
    ends_at: row.ends_at == null ? undefined : String(row.ends_at),
    status,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToShadowCase(row: unknown): StoredShadowCase | undefined {
  if (!isRecord(row)) return undefined;
  const agentResult = String(row.agent_result);
  if (!isShadowAgentResult(agentResult)) return undefined;
  const proposedEffect = row.proposed_effect_json == null
    ? undefined
    : JSON.parse(String(row.proposed_effect_json)) as ShadowEffect;
  return {
    case_id: String(row.case_id),
    study_id: String(row.study_id),
    request_id: String(row.request_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    tenant_id: String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: String(row.capability),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
    proposed_effect: proposedEffect,
    agent_result: agentResult,
    decision_reason: row.decision_reason == null ? undefined : String(row.decision_reason),
    risk_score: row.risk_score == null ? undefined : Number(row.risk_score),
    amount_value: row.amount_value == null ? undefined : Number(row.amount_value),
    created_at: String(row.created_at),
  };
}

function rowToShadowOutcome(row: unknown): StoredShadowOutcome | undefined {
  if (!isRecord(row)) return undefined;
  const disposition = String(row.disposition);
  if (!isShadowOutcomeDisposition(disposition)) return undefined;
  const actualEffect = row.actual_effect_json == null
    ? undefined
    : JSON.parse(String(row.actual_effect_json)) as ShadowEffect;
  return {
    outcome_id: String(row.outcome_id),
    study_id: String(row.study_id),
    request_id: String(row.request_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    tenant_id: String(row.tenant_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    actor: String(row.actor),
    disposition,
    actual_effect: actualEffect,
    occurred_at: String(row.occurred_at),
    source: String(row.source),
    reference: row.reference == null ? undefined : String(row.reference),
    reason: row.reason == null ? undefined : String(row.reason),
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
  "selected_capabilities_json",
  "proposed_effect_json",
  "actual_effect_json",
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
  shadow_study: "shadow_studies",
  shadow_study_case: "shadow_study_cases",
  shadow_outcome: "shadow_outcomes",
  worker_queue_item: "worker_queue",
  runner_state: "runner_state",
  policy_recommendation: "policy_recommendations",
  cloud_outbox_event: "cloud_outbox",
  cloud_governance_event: "cloud_governance_events",
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
  shadow_studies: restoreSpec("study_id", ["study_id", "name", "description", "selected_capabilities_json", "starts_at", "ends_at", "status", "created_at", "updated_at"], ["study_id", "name", "selected_capabilities_json", "status", "created_at", "updated_at"]),
  shadow_study_cases: restoreSpec("case_id", ["case_id", "study_id", "request_id", "proposal_id", "tenant_id", "principal", "capability", "business_object", "object_id", "evidence_bundle_id", "proposed_effect_json", "agent_result", "decision_reason", "risk_score", "amount_value", "created_at"], ["case_id", "study_id", "request_id", "tenant_id", "capability", "business_object", "object_id", "agent_result", "created_at"]),
  shadow_outcomes: restoreSpec("outcome_id", ["outcome_id", "study_id", "request_id", "proposal_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "actual_effect_json", "occurred_at", "source", "reference", "reason", "created_at"], ["outcome_id", "study_id", "request_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "occurred_at", "source", "created_at"]),
  worker_queue: restoreSpec("proposal_id", ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "created_at", "updated_at"], ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]),
  runner_state: restoreSpec("key", ["key", "value_json", "updated_at"], ["key", "value_json", "updated_at"]),
  policy_recommendations: restoreSpec("recommendation_id", ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"], ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"]),
  cloud_outbox: restoreSpec("event_id", ["event_id", "proposal_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "sent_at", "acknowledged_at", "created_at", "updated_at"], ["event_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]),
  cloud_governance_events: restoreSpec("event_id", ["event_id", "proposal_id", "cloud_proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"], ["event_id", "proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"]),
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
    "shadow_studies",
    "shadow_study_cases",
    "shadow_human_actions",
    "shadow_outcomes",
    "worker_queue",
    "runner_state",
    "policy_recommendations",
    "cloud_outbox",
    "cloud_governance_events",
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

function compareShadowStudyCase(
  shadowCase: StoredShadowCase,
  outcome?: StoredShadowOutcome,
): ShadowStudyComparison {
  const base = {
    study_id: shadowCase.study_id,
    case_id: shadowCase.case_id,
    request_id: shadowCase.request_id,
    proposal_id: shadowCase.proposal_id,
    tenant_id: shadowCase.tenant_id,
    principal: shadowCase.principal,
    capability: shadowCase.capability,
    business_object: shadowCase.business_object,
    object_id: shadowCase.object_id,
    agent_result: shadowCase.agent_result,
    proposed_effect: shadowCase.proposed_effect,
    outcome,
    matching_columns: [] as string[],
    differing_columns: [] as string[],
    missing_from_human: [] as string[],
    extra_human_columns: [] as string[],
    decision_reason: shadowCase.decision_reason,
    risk_score: shadowCase.risk_score,
    amount_value: shadowCase.amount_value,
    compared_at: outcome?.created_at ?? shadowCase.created_at,
  };
  if (shadowCase.agent_result === "invalid_unsafe_scope_attempt") {
    return { ...base, status: "invalid_or_unsafe_scope_attempt", comparable: false };
  }
  if (shadowCase.agent_result === "policy_denied") {
    return { ...base, status: "agent_policy_denied", comparable: false };
  }
  if (shadowCase.agent_result === "unable_to_propose") {
    return { ...base, status: "agent_unable_to_propose", comparable: false };
  }
  if (shadowCase.agent_result === "stale_conflict" || outcome?.disposition === "stale_conflict") {
    return { ...base, status: "stale_conflict", comparable: false };
  }
  if (!outcome) {
    return { ...base, status: "unmatched_no_authoritative_outcome", comparable: false };
  }
  if (outcome.disposition === "rejected_no_action") {
    return { ...base, status: "human_rejected_no_action", comparable: false };
  }
  const agentPatch = shadowCase.proposed_effect?.patch ?? {};
  const humanPatch = outcome.actual_effect?.patch ?? {};
  const agentColumns = Object.keys(agentPatch).sort();
  const humanColumns = Object.keys(humanPatch).sort();
  const matchingColumns = agentColumns.filter((column) =>
    column in humanPatch && shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const differingColumns = agentColumns.filter((column) =>
    column in humanPatch && !shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact =
    matchingColumns.length === agentColumns.length &&
    differingColumns.length === 0 &&
    missingFromHuman.length === 0 &&
    extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    ...base,
    status: exact ? "exact_agreement" : partial ? "partial_agreement" : "disagreement",
    comparable: true,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
  };
}

function latestIsoTimestamp(values: string[]): string {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
}

function normalizeShadowEffect(input: ShadowEffect, path: string): ShadowEffect {
  if (!isRecord(input) || !isRecord(input.before) || !isRecord(input.after) || !isRecord(input.patch)) {
    throw new ProposalStoreError("SHADOW_EFFECT_INVALID", `${path} must contain before, after, and patch objects`);
  }
  const before = structuredClone(input.before);
  const after = structuredClone(input.after);
  const patch = structuredClone(input.patch);
  for (const [column, value] of Object.entries(patch)) {
    if (!(column in after) || !shadowValuesEqual(after[column], value)) {
      throw new ProposalStoreError("SHADOW_EFFECT_PATCH_MISMATCH", `${path}.patch.${column} must equal the normalized after value`);
    }
  }
  assertNoSecretMaterial({ before, after, patch }, path);
  return { before, after, patch };
}

function shadowEffectFromChangeSet(changeSet: ChangeSet): ShadowEffect {
  return normalizeShadowEffect({
    before: changeSet.before,
    after: changeSet.after,
    patch: changeSet.patch,
  }, "shadow_proposal.effect");
}

function effectAmountValue(effect: ShadowEffect): number | undefined {
  let total = 0;
  let found = false;
  for (const column of Object.keys(effect.patch)) {
    const before = effect.before[column];
    const after = effect.after[column];
    if (typeof before === "number" && Number.isFinite(before) && typeof after === "number" && Number.isFinite(after)) {
      total += Math.abs(after - before);
      found = true;
    }
  }
  return found ? total : undefined;
}

function shadowStudyIncludes(study: StoredShadowStudy, capability: string, createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  if (study.starts_at && timestamp < Date.parse(study.starts_at)) return false;
  if (study.ends_at && timestamp > Date.parse(study.ends_at)) return false;
  return study.selected_capabilities.length === 0 || study.selected_capabilities.includes(capability);
}

function requiredBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProposalStoreError("SHADOW_FIELD_REQUIRED", `${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ProposalStoreError("SHADOW_FIELD_INVALID", `${label} exceeds its safe bound or contains control characters`);
  }
  return normalized;
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredBoundedText(value, label, maximum);
}

function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = requiredBoundedText(value, label, 64);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new ProposalStoreError("SHADOW_TIMESTAMP_INVALID", `${label} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProposalStoreError("SHADOW_NUMBER_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeShadowId(value: unknown, kind: string): string {
  const id = requiredBoundedText(value, `shadow ${kind} id`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new ProposalStoreError("SHADOW_ID_INVALID", `shadow ${kind} id contains unsupported characters`);
  }
  return id;
}

function assertShadowAgentResult(value: string): asserts value is ShadowAgentResult {
  if (!isShadowAgentResult(value)) {
    throw new ProposalStoreError("SHADOW_AGENT_RESULT_INVALID", `unsupported shadow agent result: ${value}`);
  }
}

function isShadowAgentResult(value: string): value is ShadowAgentResult {
  return [
    "proposed",
    "policy_denied",
    "unable_to_propose",
    "stale_conflict",
    "invalid_unsafe_scope_attempt",
  ].includes(value);
}

function assertShadowOutcomeDisposition(value: string): asserts value is ShadowOutcomeDisposition {
  if (!isShadowOutcomeDisposition(value)) {
    throw new ProposalStoreError("SHADOW_OUTCOME_DISPOSITION_INVALID", `unsupported shadow outcome disposition: ${value}`);
  }
}

function isShadowOutcomeDisposition(value: string): value is ShadowOutcomeDisposition {
  return ["applied", "rejected_no_action", "stale_conflict"].includes(value);
}

function shadowValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonDigest(left) === canonicalJsonDigest(right);
}

function countShadowStatus(comparisons: ShadowStudyComparison[], status: ShadowComparisonStatus): number {
  return comparisons.filter((item) => item.status === status).length;
}

function emptyShadowStatusCounts(): Record<ShadowComparisonStatus, number> {
  return {
    exact_agreement: 0,
    partial_agreement: 0,
    disagreement: 0,
    human_rejected_no_action: 0,
    agent_policy_denied: 0,
    agent_unable_to_propose: 0,
    stale_conflict: 0,
    unmatched_no_authoritative_outcome: 0,
    invalid_or_unsafe_scope_attempt: 0,
  };
}

function distribution(values: number[]): ShadowDistribution | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
  return {
    count: ordered.length,
    minimum: ordered[0]!,
    maximum: ordered.at(-1)!,
    mean: total / ordered.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    total,
  };
}

function suggestedShadowPolicies(
  comparisons: ShadowStudyComparison[],
): ShadowStudyReport["suggested_policies"] {
  const byCapability = new Map<string, ShadowStudyComparison[]>();
  for (const comparison of comparisons) {
    const items = byCapability.get(comparison.capability) ?? [];
    items.push(comparison);
    byCapability.set(comparison.capability, items);
  }
  const suggestions: ShadowStudyReport["suggested_policies"] = [];
  for (const [capability, items] of [...byCapability.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const exact = items.filter((item) => item.status === "exact_agreement");
    const values = exact.map((item) => item.amount_value).filter((value): value is number => value !== undefined);
    if (exact.length < 5 || values.length !== exact.length) continue;
    suggestions.push({
      capability,
      suggestion: `Review a bounded policy no higher than the observed exact-agreement maximum (${Math.max(...values)}).`,
      sample_size: exact.length,
      active: false,
    });
  }
  return suggestions;
}

function shadowTrustProgression(
  comparisons: ShadowStudyComparison[],
  suggestions: ShadowStudyReport["suggested_policies"],
): ShadowStudyReport["trust_progression"] {
  const outcomes = comparisons.filter((item) => item.outcome !== undefined).length;
  const comparable = comparisons.filter((item) => item.comparable).length;
  const exact = comparisons.filter((item) => item.status === "exact_agreement").length;
  const currentStage = comparisons.length === 0
    ? "observe"
    : outcomes === 0
      ? "compare"
      : suggestions.length === 0
        ? "manual_review"
        : "suggested_bounded_policy";
  const stageOrder = ["observe", "compare", "manual_review", "suggested_bounded_policy"] as const;
  const currentIndex = stageOrder.indexOf(currentStage);
  const details = {
    observe: `${comparisons.length} task${comparisons.length === 1 ? "" : "s"} observed without source mutation.`,
    compare: `${outcomes} authoritative outcome${outcomes === 1 ? "" : "s"}; ${comparisons.length - outcomes} unmatched.`,
    manual_review: `${comparable} comparable task${comparable === 1 ? "" : "s"}; ${exact} exact agreement${exact === 1 ? "" : "s"}. At least 5 exact numeric examples are required before a bounded-policy suggestion.`,
    suggested_bounded_policy: suggestions.length > 0
      ? `${suggestions.length} inactive bounded-policy suggestion${suggestions.length === 1 ? "" : "s"}; a human must review and activate any contract change separately.`
      : "No policy suggestion is available.",
  };
  const labels = ["Observe", "Compare", "Manual review", "Suggested bounded policy"] as const;
  return {
    current_stage: currentStage,
    minimum_policy_sample_size: 5,
    insufficient_sample_size: suggestions.length === 0,
    stages: stageOrder.map((stage, index) => ({
      name: labels[index]!,
      status: index < currentIndex ? "complete" : index === currentIndex ? "current" : "locked",
      detail: details[stage],
    })),
    automatic_activation: false,
  };
}

function safeSqliteFailure(_error: unknown, fallback: string): string {
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
