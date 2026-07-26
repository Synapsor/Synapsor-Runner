import type {
  LocalProposalState,
  StoredProposal,
  ProposalEvent,
  OperatorIdentityProof,
  StoredApproval,
  StoredWritebackReceipt,
  StoredWritebackJob,
  WritebackIntentStatus,
  StoredWritebackIntent,
  ProposalReplayRecord,
  CloudOutboxKind,
  CloudOutboxStatus,
  CloudOutboxItem,
  CloudGovernanceEvent,
  AttentionSeverity,
  AttentionEventType,
  AttentionEvent,
  AttentionItemStatus,
  AttentionItem,
  NotificationDeliveryStatus,
  NotificationDelivery,
  StoredShadowHumanAction,
  StoredShadowStudy,
  ShadowEffect,
  StoredShadowCase,
  StoredShadowOutcome,
  PolicyRecommendation,
  WorkerQueueStatus,
  WorkerQueueItem,
} from "./domain-types.js";
import {
  canonicalJsonDigest,
  parseChangeSet,
  parseExecutionReceipt,
  parseWritebackJob,
  parseWritebackResult,
  type WritebackJob,
} from "@synapsor-runner/protocol";
import {
  attentionEventTypes,
} from "./attention-domain.js";
import {
  isRecord,
} from "./common.js";
import {
  isShadowAgentResult,
  isShadowOutcomeDisposition,
} from "./shadow-analysis.js";
import { ProposalStoreError } from "./errors.js";

export function rowToProposal(row: unknown): StoredProposal | undefined {
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

export function rowToEvent(row: unknown): ProposalEvent | undefined {
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

export function rowToApproval(row: unknown): StoredApproval | undefined {
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
    freshness_proof_digest: row.freshness_proof_digest == null ? undefined : String(row.freshness_proof_digest),
    created_at: String(row.created_at),
  };
}

export function rowToPolicyRecommendation(row: unknown): PolicyRecommendation | undefined {
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

export function policyRecommendationUnsigned(recommendation: PolicyRecommendation): Omit<PolicyRecommendation, "integrity_hash"> {
  const { integrity_hash: _integrityHash, ...unsigned } = recommendation;
  return unsigned;
}

export function assertPolicyRecommendationShape(recommendation: PolicyRecommendation): void {
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

export function assertPolicyRecommendationIdentity(
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

export function rowToAttentionEvent(row: unknown): AttentionEvent | undefined {
  if (!isRecord(row)) return undefined;
  const eventType = String(row.event_type) as AttentionEventType;
  const severity = String(row.severity) as AttentionSeverity;
  if (!attentionEventTypes.has(eventType) || !["informational", "warning", "critical"].includes(severity)) return undefined;
  let details: Record<string, string | number | boolean | null>;
  try {
    const parsed = JSON.parse(String(row.details_json)) as unknown;
    if (!isRecord(parsed)) return undefined;
    details = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
      details[key] = value;
    }
  } catch {
    return undefined;
  }
  const event: AttentionEvent = {
    schema_version: "synapsor.attention-event.v1",
    event_id: String(row.event_id),
    event_type: eventType,
    severity,
    occurred_at: String(row.occurred_at),
    environment: String(row.environment),
    ...(row.proposal_id == null ? {} : { proposal_id: String(row.proposal_id) }),
    ...(row.job_id == null ? {} : { job_id: String(row.job_id) }),
    ...(row.operation_id == null ? {} : { operation_id: String(row.operation_id) }),
    ...(row.correlation_id == null ? {} : { correlation_id: String(row.correlation_id) }),
    ...(row.capability == null ? {} : { capability: String(row.capability) }),
    ...(row.contract_digest == null ? {} : { contract_digest: String(row.contract_digest) as `sha256:${string}` }),
    ...(row.attention_key == null ? {} : { attention_key: String(row.attention_key) }),
    attention_required: Number(row.attention_required) === 1,
    immediate_default: Number(row.immediate_default) === 1,
    summary: String(row.summary),
    ...(row.approval_source === "human" || row.approval_source === "policy_auto"
      ? { approval_source: row.approval_source }
      : {}),
    ...(row.worker_state == null ? {} : { worker_state: String(row.worker_state) }),
    ...(row.failure_class == null ? {} : { failure_class: String(row.failure_class) }),
    ...(row.expires_at == null ? {} : { expires_at: String(row.expires_at) }),
    ...(row.workbench_path == null ? {} : { workbench_path: String(row.workbench_path) }),
    details,
    payload_hash: String(row.payload_hash) as `sha256:${string}`,
  };
  const { payload_hash: _payloadHash, ...unsigned } = event;
  if (event.payload_hash !== canonicalJsonDigest(unsigned)) {
    throw new ProposalStoreError("ATTENTION_EVENT_CORRUPT", `attention event ${event.event_id} failed its integrity check`);
  }
  return event;
}

export function rowToAttentionItem(row: unknown): AttentionItem | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  const severity = String(row.severity);
  const eventType = String(row.event_type) as AttentionEventType;
  if (!["open", "acknowledged", "resolved", "expired"].includes(status)) return undefined;
  if (!["informational", "warning", "critical"].includes(severity) || !attentionEventTypes.has(eventType)) return undefined;
  let acknowledgementIdentity: OperatorIdentityProof | undefined;
  if (row.acknowledgement_identity_json != null) {
    try {
      const parsed = JSON.parse(String(row.acknowledgement_identity_json)) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.decision)) return undefined;
      acknowledgementIdentity = parsed as OperatorIdentityProof;
    } catch {
      return undefined;
    }
  }
  return {
    attention_id: String(row.attention_id),
    attention_key: String(row.attention_key),
    status: status as AttentionItemStatus,
    severity: severity as AttentionSeverity,
    environment: String(row.environment),
    event_type: eventType,
    capability: row.capability == null ? undefined : String(row.capability),
    contract_digest: row.contract_digest == null ? undefined : String(row.contract_digest) as `sha256:${string}`,
    title: String(row.title),
    occurrence_count: Number(row.occurrence_count),
    first_event_id: String(row.first_event_id),
    latest_event_id: String(row.latest_event_id),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
    acknowledged_by: row.acknowledged_by == null ? undefined : String(row.acknowledged_by),
    acknowledged_at: row.acknowledged_at == null ? undefined : String(row.acknowledged_at),
    acknowledgement_identity: acknowledgementIdentity,
    resolved_at: row.resolved_at == null ? undefined : String(row.resolved_at),
    expires_at: row.expires_at == null ? undefined : String(row.expires_at),
  };
}

export function rowToNotificationDelivery(row: unknown): NotificationDelivery | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (![
    "pending",
    "leased",
    "delivered",
    "retry_wait",
    "dead_letter",
    "suppressed",
    "batched",
  ].includes(status)) return undefined;
  return {
    delivery_id: String(row.delivery_id),
    sink_id: String(row.sink_id),
    event_id: String(row.event_id),
    ...(row.attention_id == null ? {} : { attention_id: String(row.attention_id) }),
    status: status as NotificationDeliveryStatus,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    ...(row.lease_owner == null ? {} : { lease_owner: String(row.lease_owner) }),
    ...(row.lease_id == null ? {} : { lease_id: String(row.lease_id) }),
    ...(row.lease_expires_at == null ? {} : { lease_expires_at: String(row.lease_expires_at) }),
    ...(row.last_error_code == null ? {} : { last_error_code: String(row.last_error_code) }),
    ...(row.external_reference == null ? {} : { external_reference: String(row.external_reference) }),
    ...(row.delivered_at == null ? {} : { delivered_at: String(row.delivered_at) }),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function rowToWorkerQueueItem(row: unknown): WorkerQueueItem | undefined {
  if (!isRecord(row)) return undefined;
  const status = String(row.status);
  if (![
    "queued",
    "leased",
    "retry_wait",
    "completed",
    "dead_letter",
    "discarded",
    "cancelled",
    "blocked",
    "reconciliation_required",
  ].includes(status)) return undefined;
  const executionMode = row.execution_mode == null ? "legacy" : String(row.execution_mode);
  if (executionMode !== "legacy" && executionMode !== "supervised_worker") return undefined;
  return {
    proposal_id: String(row.proposal_id),
    status: status as WorkerQueueStatus,
    execution_mode: executionMode,
    contract_digest: row.contract_digest == null ? undefined : String(row.contract_digest) as `sha256:${string}`,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    lease_owner: row.lease_owner == null ? undefined : String(row.lease_owner),
    lease_id: row.lease_id == null ? undefined : String(row.lease_id),
    lease_expires_at: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    last_error_code: row.last_error_code == null ? undefined : String(row.last_error_code),
    terminal_outcome: row.terminal_outcome == null ? undefined : String(row.terminal_outcome),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function workerLeaseId(proposalId: string, workerId: string, attempt: number, now: string): string {
  const prefixLength = "sha256:".length;
  return `wlease_${canonicalJsonDigest({ proposal_id: proposalId, worker_id: workerId, attempt, now }).slice(prefixLength, prefixLength + 32)}`;
}

export function rowToCloudOutboxItem(row: unknown): CloudOutboxItem | undefined {
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

export function rowToCloudGovernanceEvent(row: unknown): CloudGovernanceEvent | undefined {
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

export function rowToReceipt(row: unknown): StoredWritebackReceipt | undefined {
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

export function rowToWritebackJob(row: unknown): StoredWritebackJob | undefined {
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

export function rowToStoredReplay(row: unknown): ProposalReplayRecord | undefined {
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

export function rowToWritebackIntent(row: unknown): StoredWritebackIntent | undefined {
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

export function writebackIntentPayload(intent: StoredWritebackIntent): Record<string, unknown> {
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

export function writebackIntentFromPayload(payload: Record<string, unknown>): StoredWritebackIntent | undefined {
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

export function isStoredWritebackOperation(operation: string): operation is StoredWritebackIntent["operation"] {
  return [
    "single_row_update",
    "single_row_insert",
    "single_row_delete",
    "set_update",
    "set_delete",
    "batch_insert",
    "restore_update",
    "remove_insert",
    "restore_insert",
  ].includes(operation);
}

export function assertIntentMatchesJob(intent: StoredWritebackIntent, job: WritebackJob): void {
  if (
    intent.idempotency_key !== job.idempotency_key
    || intent.writeback_job_id !== job.job_id
    || intent.proposal_id !== job.proposal_id
    || intent.proposal_hash !== job.approval_id
  ) throw new ProposalStoreError("WRITEBACK_INTENT_IDENTITY_MISMATCH", `writeback intent ${intent.intent_id} does not match the immutable job identity`);
}

export function intentJobId(intentId: string): string {
  if (!intentId.startsWith("wbi:") || intentId.length <= 4) throw new ProposalStoreError("INVALID_WRITEBACK_INTENT_ID", "writeback intent id must use wbi:<job_id>");
  return intentId.slice(4);
}

export function rowToQueryAudit(row: unknown): Record<string, unknown> | undefined {
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

export function rowToShadowHumanAction(row: unknown): StoredShadowHumanAction | undefined {
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

export function rowToShadowStudy(row: unknown): StoredShadowStudy | undefined {
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

export function rowToShadowCase(row: unknown): StoredShadowCase | undefined {
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

export function rowToShadowOutcome(row: unknown): StoredShadowOutcome | undefined {
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
