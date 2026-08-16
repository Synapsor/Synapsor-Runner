import type {
  ChangeSet,
  ExecutionReceipt,
  ExecutionReceiptV2,
  ExecutionReceiptV3,
  ExecutionReceiptV4,
  FreshnessProofV1,
  WritebackJob,
  WritebackResult,
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
  action:
    | "approve"
    | "reject"
    | "apply"
    | "revert"
    | "reconcile"
    | "worker_requeue"
    | "worker_discard"
    | "worker_pause"
    | "worker_resume"
    | "worker_drain"
    | "worker_capability_enable"
    | "worker_capability_disable"
    | "worker_digest_revoke"
    | "worker_cancel"
    | "attention_acknowledge"
    | "notification_replay"
    | "boundary_review"
    | "boundary_activate";
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
  freshness_proof_digest?: string;
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

export type QueryAuditRecordInput = {
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
  created_at?: string;
};

export type ProductionExploreAuditEventInput = {
  event_id: string;
  event_kind: "query_audit" | "evidence_bundle";
  payload: Record<string, unknown>;
  created_at: string;
};

export type ExplorePrivacyReleaseKind = "scalar_total" | "suppressed_grouping";

export type ExplorePrivacyReleaseInput = {
  scope_fingerprint: `sha256:${string}`;
  complement_fingerprints: `sha256:${string}`[];
  release_kind: ExplorePrivacyReleaseKind;
  query_fingerprint: `sha256:${string}`;
  boundary_digest: `sha256:${string}`;
};

export type ExplorePrivacyReleaseDecision =
  | { allowed: true }
  | { allowed: false; conflicting_release_kind: ExplorePrivacyReleaseKind };

export type ProductionExplorePrivacyReleaseInput = Omit<ExplorePrivacyReleaseInput, "scope_fingerprint"> & {
  principal_scope_fingerprint: `sha256:${string}`;
  tenant_scope_fingerprint: `sha256:${string}`;
};

export type ProductionExplorePrivacyReleaseDecision =
  | { allowed: true }
  | {
    allowed: false;
    conflicting_release_kind: ExplorePrivacyReleaseKind;
    conflicting_scope: "principal" | "tenant";
  };

export type ExploreBudgetLimits = {
  max_queries_per_session: number;
  rate_limit_per_minute: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  max_response_cells: number;
};

export type ExploreBudgetUsage = {
  query_count: number;
  queries_last_minute: number;
  extracted_cells: number;
  differencing_attempts: number;
};

export type ExploreBudgetReservationInput = {
  reservation_id: string;
  scope_fingerprint: `sha256:${string}`;
  legacy_session_fingerprints: `sha256:${string}`[];
  resource_id: string;
  variant_fingerprint: `sha256:${string}`;
  requires_differencing: boolean;
  estimated_response_cells: number;
  limits: ExploreBudgetLimits;
  now: string;
};

export type ExploreBudgetReservationDecision =
  | {
    allowed: true;
    usage_after_reservation: ExploreBudgetUsage;
    variant_already_counted: boolean;
  }
  | {
    allowed: false;
    code:
      | "QUERY_BUDGET_EXHAUSTED"
      | "RATE_LIMIT_EXHAUSTED"
      | "EXTRACTION_BUDGET_EXHAUSTED"
      | "DIFFERENCING_BUDGET_EXHAUSTED";
    message: string;
    usage: ExploreBudgetUsage;
  };

export type CompleteExploreBudgetReservationInput = {
  reservation_id: string;
  result_released: boolean;
  returned_cells: number;
  completed_at: string;
};

export type CompleteExploreBudgetReservationDecision =
  | { completed: true }
  | { completed: false; reason: "reservation_missing" | "response_exceeded_reservation" | "reservation_already_finalized" };

export type ProductionExploreBudgetReservationInput = Omit<ExploreBudgetReservationInput, "scope_fingerprint" | "legacy_session_fingerprints" | "limits"> & {
  principal_scope_fingerprint: `sha256:${string}`;
  tenant_scope_fingerprint: `sha256:${string}`;
  principal_limits: ExploreBudgetLimits;
  tenant_limits: ExploreBudgetLimits;
};

export type ProductionExploreBudgetReservationDecision =
  | {
    allowed: true;
    principal_usage_after_reservation: ExploreBudgetUsage;
    tenant_usage_after_reservation: ExploreBudgetUsage;
    principal_variant_already_counted: boolean;
    tenant_variant_already_counted: boolean;
  }
  | {
    allowed: false;
    code:
      | "QUERY_BUDGET_EXHAUSTED"
      | "RATE_LIMIT_EXHAUSTED"
      | "EXTRACTION_BUDGET_EXHAUSTED"
      | "DIFFERENCING_BUDGET_EXHAUSTED";
    message: string;
    exhausted_scope: "principal" | "tenant";
    usage: ExploreBudgetUsage;
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

export type AttentionSeverity = "informational" | "warning" | "critical";

export type AttentionEventType =
  | "proposal.created"
  | "proposal.review_required"
  | "proposal.auto_approved"
  | "proposal.approved"
  | "proposal.queued"
  | "proposal.expiring"
  | "proposal.expired"
  | "proposal.cancelled"
  | "proposal.applied"
  | "proposal.conflict"
  | "proposal.refused"
  | "worker.started"
  | "worker.paused"
  | "worker.unhealthy"
  | "worker.recovered"
  | "worker.queue_backlog"
  | "worker.retry_scheduled"
  | "worker.dead_lettered"
  | "worker.unknown_outcome"
  | "worker.reconciliation_required"
  | "capability.review_required"
  | "capability.activated"
  | "capability.revoked"
  | "contract.digest_stale"
  | "schema.drift_detected"
  | "credential.posture_changed"
  | "policy.limit_near"
  | "policy.limit_exceeded"
  | "sensitive_override_activated"
  | "notification.replayed"
  | "notification.digest";

export type AttentionEvent = {
  schema_version: "synapsor.attention-event.v1";
  event_id: string;
  event_type: AttentionEventType;
  severity: AttentionSeverity;
  occurred_at: string;
  environment: string;
  proposal_id?: string;
  job_id?: string;
  operation_id?: string;
  correlation_id?: string;
  capability?: string;
  contract_digest?: `sha256:${string}`;
  attention_key?: string;
  attention_required: boolean;
  immediate_default: boolean;
  summary: string;
  approval_source?: "human" | "policy_auto";
  worker_state?: string;
  failure_class?: string;
  expires_at?: string;
  workbench_path?: string;
  details: Record<string, string | number | boolean | null>;
  payload_hash: `sha256:${string}`;
};

export type RecordAttentionEventInput = {
  event_type: AttentionEventType;
  severity: AttentionSeverity;
  environment: string;
  proposal_id?: string;
  job_id?: string;
  operation_id?: string;
  correlation_id?: string;
  capability?: string;
  contract_digest?: `sha256:${string}`;
  attention_key?: string;
  attention_required?: boolean;
  immediate_default?: boolean;
  summary?: string;
  approval_source?: "human" | "policy_auto";
  worker_state?: string;
  failure_class?: string;
  expires_at?: string;
  workbench_path?: string;
  details?: Record<string, string | number | boolean | null>;
  source_event_key?: string;
  now?: string;
};

export type AttentionItemStatus = "open" | "acknowledged" | "resolved" | "expired";

export type AttentionItem = {
  attention_id: string;
  attention_key: string;
  status: AttentionItemStatus;
  severity: AttentionSeverity;
  environment: string;
  event_type: AttentionEventType;
  capability?: string;
  contract_digest?: `sha256:${string}`;
  title: string;
  occurrence_count: number;
  first_event_id: string;
  latest_event_id: string;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_by?: string;
  acknowledged_at?: string;
  acknowledgement_identity?: OperatorIdentityProof;
  resolved_at?: string;
  expires_at?: string;
};

export type AttentionDecisionSubject = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: `sha256:${string}`;
};

export type NotificationReplayDecisionSubject = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: `sha256:${string}`;
};

export type NotificationDeliveryStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "retry_wait"
  | "dead_letter"
  | "suppressed"
  | "batched";

export type NotificationDelivery = {
  delivery_id: string;
  sink_id: string;
  event_id: string;
  attention_id?: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner?: string;
  lease_id?: string;
  lease_expires_at?: string;
  last_error_code?: string;
  external_reference?: string;
  delivered_at?: string;
  created_at: string;
  updated_at: string;
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
  tenants?: string[];
  principal?: string;
  principals?: string[];
  capability?: string;
  proposal?: string;
  objectType?: string;
  objectId?: string;
  source?: string;
  table?: string;
  queryFingerprint?: string;
  status?: string;
  outcome?: "ok" | "refused" | "failed";
  boundary?: string;
};

export type QueryAuditSearchFilters = LocalListOptions & {
  tenant?: string;
  tenants?: string[];
  principal?: string;
  principals?: string[];
  capability?: string;
  proposal?: string;
  evidence?: string;
  source?: string;
  table?: string;
  objectType?: string;
  objectId?: string;
  primaryKey?: string;
  queryFingerprint?: string;
  status?: string;
  outcome?: "ok" | "refused" | "failed";
  boundary?: string;
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
  explore_privacy_releases: number;
  explore_budget_reservations: number;
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
  attention_events: number;
  attention_items: number;
  notification_deliveries: number;
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
  freshness_checks: number;
  freshness_fresh: number;
  freshness_stale_target: number;
  freshness_stale_supporting: number;
  freshness_unavailable: number;
  freshness_unsupported: number;
  freshness_approval_blocked: number;
  freshness_apply_blocked: number;
};

export type WorkerQueueStatus =
  | "queued"
  | "leased"
  | "retry_wait"
  | "completed"
  | "dead_letter"
  | "discarded"
  | "cancelled"
  | "blocked"
  | "reconciliation_required";

export type WorkerExecutionMode = "legacy" | "supervised_worker";

export type WorkerControlMode = "active" | "paused" | "draining";

export type WorkerCapabilityControlStatus = "enabled" | "disabled" | "revoked";

export type WorkerCapabilityControl = {
  capability: string;
  contract_digest: `sha256:${string}`;
  status: WorkerCapabilityControlStatus;
  updated_at: string;
  actor: string;
};

export type WorkerControlState = {
  schema_version: "synapsor.worker-control.v1";
  mode: WorkerControlMode;
  revision: number;
  capability_controls: WorkerCapabilityControl[];
  last_decision?: OperatorIdentityProof;
  updated_at: string;
  integrity_hash: `sha256:${string}`;
};

export type WorkerControlAction =
  | "pause"
  | "resume"
  | "drain"
  | "capability_enable"
  | "capability_disable"
  | "digest_revoke";

export type WorkerControlTarget = {
  action: WorkerControlAction;
  capability?: string;
  contract_digest?: `sha256:${string}`;
};

export type WorkerControlDecisionSubject = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: `sha256:${string}`;
};

export type WorkerQueueItem = {
  proposal_id: string;
  status: WorkerQueueStatus;
  execution_mode: WorkerExecutionMode;
  contract_digest?: `sha256:${string}`;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner?: string;
  lease_id?: string;
  lease_expires_at?: string;
  last_error_code?: string;
  terminal_outcome?: string;
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

export type WorkerPolicyExecutionLimits = {
  policy: string;
  limits: PolicyApprovalLimit[];
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
    query_audit?: QueryAuditRecordInput[];
    created_at?: string;
  }): MaybePromise<void>;
  recordQueryAudit(input: QueryAuditRecordInput): MaybePromise<void>;
  recordProductionExploreAuditEvent?(input: ProductionExploreAuditEventInput): MaybePromise<void>;
  findActiveProposal(input: ActiveProposalLookup): MaybePromise<StoredProposal | undefined>;
  createProposal(input: unknown): MaybePromise<StoredProposal>;
  recordFreshnessProof(input: unknown): MaybePromise<FreshnessProofV1>;
  latestFreshnessProof(proposalId: string): MaybePromise<FreshnessProofV1 | undefined>;
  recordFreshnessApprovalBlocked(
    proposalId: string,
    input: { proof_digest: string; safe_code: string; actor: string },
  ): MaybePromise<void>;
  approveProposalByPolicy(
    proposalId: string,
    options: {
      policy: string;
      proposal_hash: string;
      proposal_version: number;
      reason: string;
      limits?: PolicyApprovalLimit[];
      now?: string;
      freshness_proof_digest?: string;
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
  claimExplorePrivacyRelease?(input: ExplorePrivacyReleaseInput): MaybePromise<ExplorePrivacyReleaseDecision>;
  claimExploreBudgetReservation?(input: ExploreBudgetReservationInput): MaybePromise<ExploreBudgetReservationDecision>;
  completeExploreBudgetReservation?(input: CompleteExploreBudgetReservationInput): MaybePromise<CompleteExploreBudgetReservationDecision>;
  claimProductionExploreBudgetReservation?(input: ProductionExploreBudgetReservationInput): MaybePromise<ProductionExploreBudgetReservationDecision>;
  completeProductionExploreBudgetReservation?(input: CompleteExploreBudgetReservationInput): MaybePromise<CompleteExploreBudgetReservationDecision>;
  claimProductionExplorePrivacyRelease?(input: ProductionExplorePrivacyReleaseInput): MaybePromise<ProductionExplorePrivacyReleaseDecision>;
  replay(proposalId: string): MaybePromise<ProposalReplayRecord>;
  claimWritebackIntent?(job: WritebackJob, runnerId: string): MaybePromise<WritebackIntentClaim>;
  markWritebackIntentApplying?(intentId: string, runnerId: string): MaybePromise<void>;
  completeWritebackIntent?(intentId: string, result: WritebackResult): MaybePromise<void>;
  requireWritebackReconciliation?(intentId: string, reason: string): MaybePromise<void>;
  enqueueWorkerProposal?(input: {
    proposal_id: string;
    execution_mode?: WorkerExecutionMode;
    contract_digest?: `sha256:${string}`;
    max_attempts?: number;
    queue_limit?: number;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  claimWorkerItem?(input: {
    workerId: string;
    leaseSeconds?: number;
    executionMode?: WorkerExecutionMode;
    capability?: string;
    tenant?: string;
    contractDigest?: `sha256:${string}`;
    maxConcurrent?: number;
    rateLimit?: {
      executions: number;
      windowSeconds: number;
    };
    proposalTtlSeconds?: number;
    policyExecution?: WorkerPolicyExecutionLimits;
    now?: string;
  }): MaybePromise<WorkerQueueItem | undefined>;
  assertActiveWorkerLease?(input: {
    proposalId: string;
    workerId: string;
    leaseId: string;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  renewWorkerLease?(input: {
    proposalId: string;
    workerId: string;
    leaseId: string;
    leaseSeconds?: number;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  completeWorkerItem?(
    proposalId: string,
    workerId: string,
    outcome: "applied" | "already_applied" | "conflict",
    now?: string,
    leaseId?: string,
  ): MaybePromise<WorkerQueueItem>;
  blockWorkerItem?(input: {
    proposalId: string;
    workerId: string;
    leaseId: string;
    errorCode: string;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  requireWorkerReconciliation?(input: {
    proposalId: string;
    workerId: string;
    leaseId: string;
    errorCode: string;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  workerControlState?(): MaybePromise<WorkerControlState>;
  updateWorkerControl?(input: WorkerControlTarget & {
    actor: string;
    identity?: OperatorIdentityProof;
    require_verified_identity?: boolean;
    environment?: string;
    now?: string;
  }): MaybePromise<WorkerControlState>;
  cancelWorkerItem?(input: {
    proposalId: string;
    actor: string;
    identity?: OperatorIdentityProof;
    require_verified_identity?: boolean;
    now?: string;
  }): MaybePromise<WorkerQueueItem>;
  listWorkerQueue?(status?: WorkerQueueStatus): MaybePromise<WorkerQueueItem[]>;
  getWorkerQueueItem?(proposalId: string): MaybePromise<WorkerQueueItem | undefined>;
  recordAttentionEvent?(input: RecordAttentionEventInput): MaybePromise<AttentionEvent>;
  listAttentionEvents?(filters?: {
    event_type?: AttentionEventType;
    severity?: AttentionSeverity;
    proposal_id?: string;
    capability?: string;
    tenant?: string;
    principal?: string;
    from?: string;
    limit?: number;
  }): MaybePromise<AttentionEvent[]>;
  getAttentionEvent?(eventId: string): MaybePromise<AttentionEvent | undefined>;
  listAttentionItems?(filters?: {
    status?: AttentionItemStatus;
    severity?: AttentionSeverity;
    capability?: string;
    tenant?: string;
    principal?: string;
    limit?: number;
  }): MaybePromise<AttentionItem[]>;
  getAttentionItem?(attentionId: string): MaybePromise<AttentionItem | undefined>;
  acknowledgeAttention?(input: {
    attention_id: string;
    actor: string;
    identity?: OperatorIdentityProof;
    require_verified_identity?: boolean;
    now?: string;
  }): MaybePromise<AttentionItem>;
  resolveAttention?(input: {
    attention_id: string;
    now?: string;
  }): MaybePromise<AttentionItem>;
  enqueueNotificationDelivery?(input: {
    sink_id: string;
    event_id: string;
    attention_id?: string;
    max_attempts?: number;
    status?: "pending" | "batched" | "suppressed";
    next_attempt_at?: string;
    now?: string;
  }): MaybePromise<NotificationDelivery>;
  includeNotificationDeliveriesInDigest?(input: {
    sink_id: string;
    delivery_ids: string[];
    digest_event_id: string;
    now?: string;
  }): MaybePromise<number>;
  claimNotificationDeliveries?(input: {
    owner: string;
    sink_id?: string;
    limit?: number;
    lease_seconds?: number;
    now?: string;
  }): MaybePromise<NotificationDelivery[]>;
  completeNotificationDelivery?(input: {
    delivery_id: string;
    owner: string;
    lease_id: string;
    external_reference?: string;
    now?: string;
  }): MaybePromise<NotificationDelivery>;
  failNotificationDelivery?(input: {
    delivery_id: string;
    owner: string;
    lease_id: string;
    error_code: string;
    retryable: boolean;
    retry_at?: string;
    now?: string;
  }): MaybePromise<NotificationDelivery>;
  listNotificationDeliveries?(filters?: {
    status?: NotificationDeliveryStatus;
    sink_id?: string;
    event_id?: string;
    attention_id?: string;
    limit?: number;
  }): MaybePromise<NotificationDelivery[]>;
  getNotificationDelivery?(deliveryId: string): MaybePromise<NotificationDelivery | undefined>;
  requeueNotificationDelivery?(input: {
    delivery_id: string;
    identity: OperatorIdentityProof;
    reason: string;
    now?: string;
  }): MaybePromise<NotificationDelivery>;
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

export type RecordHandlerWritebackJobInput = {
  writeback_job_id: string;
  proposal_id: string;
  proposal_hash: string;
  runner_id: string;
  executor: string;
  request: Record<string, unknown>;
};
