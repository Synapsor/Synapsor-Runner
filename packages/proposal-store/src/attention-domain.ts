import type {
  StoredProposal,
  OperatorIdentityProof,
  AttentionSeverity,
  AttentionEventType,
  RecordAttentionEventInput,
  AttentionItem,
  AttentionDecisionSubject,
  NotificationReplayDecisionSubject,
  NotificationDelivery,
} from "./domain-types.js";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import { ProposalStoreError } from "./errors.js";

export type ProposalEventAttentionInput = {
  proposal: StoredProposal;
  proposal_event_id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  environment: string;
  occurred_at: string;
};

export function attentionEventsForProposalEvent(input: ProposalEventAttentionInput): RecordAttentionEventInput[] {
  const proposal = input.proposal;
  const contractDigest = proposal.change_set.contract?.digest as `sha256:${string}` | undefined;
  const scopeDigest = canonicalJsonDigest({
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? null,
  });
  const sourceKey = (eventType: AttentionEventType) =>
    `proposal:${proposal.proposal_id}:event:${input.proposal_event_id}:${eventType}`;
  const base = (eventType: AttentionEventType, severity: AttentionSeverity): RecordAttentionEventInput => ({
    event_type: eventType,
    severity,
    environment: input.environment,
    proposal_id: proposal.proposal_id,
    capability: proposal.capability ?? proposal.action,
    ...(contractDigest ? { contract_digest: contractDigest } : {}),
    source_event_key: sourceKey(eventType),
    now: input.occurred_at,
  });
  const safeCode = safeAttentionPayloadString(input.payload, "safe_error_code")
    ?? safeAttentionPayloadString(input.payload, "error_code")
    ?? safeAttentionPayloadString(input.payload, "reason_code");
  const workerDetails = safeAttentionDetails(input.payload, [
    "attempt",
    "max_attempts",
    "execution_mode",
    "outcome",
  ]);
  const requiredRole = typeof proposal.change_set.approval.required_role === "string"
    ? proposal.change_set.approval.required_role
    : "reviewer";
  const reviewAttention = (summary?: string): RecordAttentionEventInput => {
    const attentionKey = proposalReviewAttentionKey(proposal, input.environment);
    return {
      ...base("proposal.review_required", "warning"),
      attention_required: true,
      immediate_default: true,
      attention_key: attentionKey,
      summary: summary ?? `${proposal.capability ?? proposal.action} proposals need ${requiredRole} review`,
      workbench_path: `/attention/${attentionItemId(attentionKey)}`,
      details: {
        required_role: requiredRole,
        ...(safeCode ? { failure_class: safeCode } : {}),
      },
      ...(safeCode ? { failure_class: safeCode } : {}),
    };
  };
  const criticalWorkerAttention = (
    eventType: "worker.dead_lettered" | "worker.unknown_outcome" | "worker.reconciliation_required",
    summary?: string,
  ): RecordAttentionEventInput => {
    const failureClass = safeCode ?? (
      eventType === "worker.dead_lettered"
        ? "RETRY_BUDGET_EXHAUSTED"
        : eventType === "worker.unknown_outcome"
          ? "OUTCOME_UNKNOWN"
          : "RECONCILIATION_REQUIRED"
    );
    const attentionKey = [
      input.environment,
      eventType,
      proposal.capability ?? proposal.action,
      contractDigest ?? "no_digest",
      failureClass,
      scopeDigest,
    ].join(":");
    return {
      ...base(eventType, "critical"),
      attention_required: true,
      immediate_default: true,
      attention_key: attentionKey,
      summary,
      workbench_path: `/attention/${attentionItemId(attentionKey)}`,
      worker_state: eventType.slice("worker.".length),
      failure_class: failureClass,
      details: {
        ...workerDetails,
        failure_class: failureClass,
      },
    };
  };

  if (input.kind === "proposal_created") {
    const events: RecordAttentionEventInput[] = [{
      ...base("proposal.created", "informational"),
      attention_required: false,
      immediate_default: false,
      details: { source_database_changed: false },
    }];
    const approvalMode = proposal.change_set.approval.mode;
    // Policy evaluation happens immediately after persistence. Delay the human
    // interruption until that deterministic evaluation actually falls back to
    // review, so a normal auto-approved request stays quiet.
    if (proposal.state === "pending_review" && approvalMode !== "policy") events.push(reviewAttention());
    return events;
  }

  if (input.kind === "proposal_approved") {
    const policyApproved = input.actor.startsWith("policy:");
    return [{
      ...base(policyApproved ? "proposal.auto_approved" : "proposal.approved", "informational"),
      attention_required: false,
      immediate_default: false,
      approval_source: policyApproved ? "policy_auto" : "human",
      details: safeAttentionDetails(input.payload, ["approvals", "required_approvals", "remaining_approvals"]),
    }];
  }

  if (input.kind === "policy_auto_approval_deferred" || input.kind === "proposal_approval_blocked_freshness") {
    return [reviewAttention(
      input.kind === "proposal_approval_blocked_freshness"
        ? `${proposal.capability ?? proposal.action} needs review because its source freshness check failed`
        : `${proposal.capability ?? proposal.action} exceeded automatic-approval policy and needs human review`,
    )];
  }

  if (input.kind === "proposal_rejected" || input.kind === "proposal_failed") {
    return [{
      ...base("proposal.refused", "warning"),
      attention_required: false,
      immediate_default: false,
      ...(safeCode ? { failure_class: safeCode, details: { failure_class: safeCode } } : {}),
    }];
  }

  if (input.kind === "proposal_canceled" || input.kind === "writeback_canceled") {
    return [{
      ...base("proposal.cancelled", "informational"),
      attention_required: false,
      immediate_default: false,
    }];
  }

  if (input.kind === "proposal_conflict" || input.kind === "writeback_conflict" || input.kind === "writeback_intent_conflict") {
    return [{
      ...base("proposal.conflict", "warning"),
      attention_required: false,
      immediate_default: false,
      ...(safeCode ? { failure_class: safeCode, details: { failure_class: safeCode } } : {}),
    }];
  }

  if (input.kind === "proposal_pending_worker" || input.kind === "writeback_worker_queued") {
    return [{
      ...base("proposal.queued", "informational"),
      attention_required: false,
      immediate_default: false,
      worker_state: "queued",
      details: safeAttentionDetails(input.payload, ["execution_mode", "max_attempts"]),
    }];
  }

  if (input.kind === "writeback_retry_scheduled") {
    return [{
      ...base("worker.retry_scheduled", "warning"),
      attention_required: false,
      immediate_default: false,
      worker_state: "retry_wait",
      ...(safeCode ? { failure_class: safeCode } : {}),
      details: {
        ...workerDetails,
        ...(safeCode ? { failure_class: safeCode } : {}),
      },
    }];
  }

  if (input.kind === "writeback_dead_lettered") {
    return [criticalWorkerAttention("worker.dead_lettered")];
  }

  if (input.kind === "writeback_worker_blocked") {
    const failureClass = safeCode ?? "WORKER_POLICY_BLOCKED";
    if (/PROPOSAL_.*EXPIRED|PROPOSAL_EXPIRED/i.test(failureClass)) {
      return [{
        ...base("proposal.expired", "warning"),
        attention_required: false,
        immediate_default: false,
        worker_state: "blocked",
        failure_class: failureClass,
        details: {
          ...workerDetails,
          failure_class: failureClass,
        },
      }];
    }
    const digestStale = /(?:CONTRACT|DIGEST|GENERATION_LOCK|SCHEMA|POLICY)_.*(?:STALE|MISMATCH|CHANGED)|ACTIVE_CONTRACT_DIGEST/i.test(failureClass);
    const limitExceeded = /(?:LIMIT|RATE|QUEUE|BUDGET)_.*(?:EXCEEDED|STALE|MISMATCH)|POLICY_LIMIT/i.test(failureClass);
    const eventType: AttentionEventType = digestStale
      ? "contract.digest_stale"
      : limitExceeded
        ? "policy.limit_exceeded"
        : "proposal.refused";
    const severity: AttentionSeverity = digestStale || limitExceeded ? "critical" : "warning";
    const attentionRequired = digestStale || limitExceeded;
    const attentionKey = [
      input.environment,
      eventType,
      proposal.capability ?? proposal.action,
      contractDigest ?? "no_digest",
      failureClass,
      scopeDigest,
    ].join(":");
    return [{
      ...base(eventType, severity),
      attention_required: attentionRequired,
      immediate_default: attentionRequired,
      ...(attentionRequired ? {
        attention_key: attentionKey,
        workbench_path: `/attention/${attentionItemId(attentionKey)}`,
      } : {}),
      worker_state: "blocked",
      failure_class: failureClass,
      details: {
        ...workerDetails,
        failure_class: failureClass,
      },
    }];
  }

  if (input.kind === "policy_limit_near") {
    return [{
      ...base("policy.limit_near", "warning"),
      attention_required: false,
      immediate_default: false,
      summary: `${proposal.capability ?? proposal.action} is approaching a reviewed policy limit`,
      details: safeAttentionDetails(input.payload, [
        "kind",
        "scope",
        "observed",
        "proposed",
        "projected",
        "max",
        "window_start",
        "window_end",
      ]),
    }];
  }

  if (input.kind === "writeback_reconciliation_required" || input.kind === "writeback_intent_reconciliation_required") {
    return [criticalWorkerAttention("worker.reconciliation_required")];
  }

  if (
    (input.kind === "writeback_failed" || input.kind === "writeback_intent_failed")
    && (safeCode === "OUTCOME_UNKNOWN" || safeCode === "RECONCILIATION_REQUIRED")
  ) {
    return [criticalWorkerAttention("worker.unknown_outcome")];
  }

  if (input.kind === "writeback_applied" || input.kind === "writeback_already_applied"
    || input.kind === "writeback_intent_applied" || input.kind === "writeback_intent_already_applied") {
    return [{
      ...base("proposal.applied", "informational"),
      attention_required: false,
      immediate_default: false,
      worker_state: "completed",
      details: safeAttentionDetails(input.payload, ["rows_affected", "source_database_mutated"]),
    }];
  }

  if (input.kind === "writeback_worker_completed") {
    const outcome = safeAttentionPayloadString(input.payload, "outcome");
    if (outcome === "conflict") {
      return [{
        ...base("proposal.conflict", "warning"),
        attention_required: false,
        immediate_default: false,
        worker_state: "completed",
        details: { outcome },
      }];
    }
    if (outcome === "applied" || outcome === "already_applied") {
      return [{
        ...base("proposal.applied", "informational"),
        attention_required: false,
        immediate_default: false,
        worker_state: "completed",
        details: { outcome },
      }];
    }
  }

  if (input.kind === "proposal_reconciliation_required") {
    return [criticalWorkerAttention("worker.reconciliation_required")];
  }

  return [];
}

export function proposalReviewAttentionKey(
  proposal: StoredProposal,
  environment: string,
): string {
  const contractDigest = proposal.change_set.contract?.digest as `sha256:${string}` | undefined;
  const requiredRole = typeof proposal.change_set.approval.required_role === "string"
    ? proposal.change_set.approval.required_role
    : "reviewer";
  const scopeDigest = canonicalJsonDigest({
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? null,
  });
  return [
    environment,
    "proposal.review_required",
    proposal.capability ?? proposal.action,
    contractDigest ?? "no_digest",
    requiredRole,
    scopeDigest,
  ].join(":");
}

export function safeAttentionPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, 128);
}

export function safeAttentionDetails(
  payload: Record<string, unknown>,
  keys: string[],
): Record<string, string | number | boolean | null> {
  const details: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value === null || typeof value === "boolean") details[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
    else if (typeof value === "string" && value.trim()) details[key] = value.trim().slice(0, 128);
  }
  return details;
}

export const attentionEventTypes = new Set<AttentionEventType>([
  "proposal.created",
  "proposal.review_required",
  "proposal.auto_approved",
  "proposal.approved",
  "proposal.queued",
  "proposal.expiring",
  "proposal.expired",
  "proposal.cancelled",
  "proposal.applied",
  "proposal.conflict",
  "proposal.refused",
  "worker.started",
  "worker.paused",
  "worker.unhealthy",
  "worker.recovered",
  "worker.queue_backlog",
  "worker.retry_scheduled",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "capability.review_required",
  "capability.activated",
  "capability.revoked",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_near",
  "policy.limit_exceeded",
  "sensitive_override_activated",
  "notification.replayed",
  "notification.digest",
]);

export const defaultAttentionEventTypes = new Set<AttentionEventType>([
  "proposal.review_required",
  "proposal.expiring",
  "proposal.expired",
  "worker.unhealthy",
  "worker.queue_backlog",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "capability.review_required",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_exceeded",
  "sensitive_override_activated",
]);

export const defaultImmediateAttentionEventTypes = new Set<AttentionEventType>([
  "proposal.review_required",
  "proposal.expiring",
  "worker.unhealthy",
  "worker.queue_backlog",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_exceeded",
]);

export function attentionEventTitle(eventType: AttentionEventType): string {
  const titles: Record<AttentionEventType, string> = {
    "proposal.created": "Proposal created",
    "proposal.review_required": "Proposal needs human review",
    "proposal.auto_approved": "Proposal approved by reviewed policy",
    "proposal.approved": "Proposal approved",
    "proposal.queued": "Proposal queued for trusted execution",
    "proposal.expiring": "Approved proposal is approaching expiry",
    "proposal.expired": "Approved proposal expired without execution",
    "proposal.cancelled": "Proposal cancelled",
    "proposal.applied": "Proposal applied",
    "proposal.conflict": "Guarded writeback conflict",
    "proposal.refused": "Proposal refused",
    "worker.started": "Trusted worker started",
    "worker.paused": "Trusted worker paused",
    "worker.unhealthy": "Trusted worker needs attention",
    "worker.recovered": "Trusted worker supervision recovered",
    "worker.queue_backlog": "Trusted worker queue backlog",
    "worker.retry_scheduled": "Trusted worker retry scheduled",
    "worker.dead_lettered": "Trusted worker job dead-lettered",
    "worker.unknown_outcome": "Database transaction outcome is unknown",
    "worker.reconciliation_required": "Operator reconciliation is required",
    "capability.review_required": "Capability needs human review",
    "capability.activated": "Capability activated",
    "capability.revoked": "Capability revoked",
    "contract.digest_stale": "Active contract or policy authority is stale",
    "schema.drift_detected": "Schema drift blocks active authority",
    "credential.posture_changed": "Credential posture changed",
    "policy.limit_near": "Policy limit is approaching",
    "policy.limit_exceeded": "Policy limit exceeded",
    "sensitive_override_activated": "Sensitive-field override activated",
    "notification.replayed": "Notification delivery requeued by a verified operator",
    "notification.digest": "Runner activity digest",
  };
  return titles[eventType];
}

export function assertAttentionEventInput(input: RecordAttentionEventInput): void {
  if (!attentionEventTypes.has(input.event_type)) {
    throw new ProposalStoreError("ATTENTION_EVENT_TYPE_INVALID", `unsupported attention event type: ${String(input.event_type)}`);
  }
  if (!["informational", "warning", "critical"].includes(input.severity)) {
    throw new ProposalStoreError("ATTENTION_EVENT_SEVERITY_INVALID", `unsupported attention severity: ${String(input.severity)}`);
  }
  if (input.contract_digest && !/^sha256:[a-f0-9]{64}$/.test(input.contract_digest)) {
    throw new ProposalStoreError("ATTENTION_EVENT_DIGEST_INVALID", "attention event contract digest must be a lowercase sha256 digest");
  }
  for (const [label, value] of [["now", input.now], ["expires_at", input.expires_at]] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new ProposalStoreError("ATTENTION_EVENT_TIME_INVALID", `attention event ${label} must be an ISO timestamp`);
    }
  }
  const entries = Object.entries(input.details ?? {});
  if (entries.length > 32) {
    throw new ProposalStoreError("ATTENTION_EVENT_DETAILS_TOO_LARGE", "attention event details may contain at most 32 safe fields");
  }
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_KEY_INVALID", `attention event detail key is invalid: ${key}`);
    }
    if (typeof value === "string") boundedSafeLabel(value, `attention detail ${key}`, 256);
    else if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_VALUE_INVALID", `attention event detail ${key} must be finite`);
    } else if (value !== null && typeof value !== "number" && typeof value !== "boolean") {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_VALUE_INVALID", `attention event detail ${key} must be scalar`);
    }
  }
  assertNoSecretMaterial(input.details ?? {}, "attention_event.details");
}

export function boundedSafeLabel(value: string, label: string, maximum: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProposalStoreError("ATTENTION_EVENT_FIELD_INVALID", `${label} must be a non-empty bounded single-line value`);
  }
  assertNoSecretMaterial({ value: trimmed }, label);
  return trimmed;
}

export function boundedWorkbenchPath(value: string): string {
  const path = boundedSafeLabel(value, "attention Workbench path", 512);
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("://") || path.includes("..")) {
    throw new ProposalStoreError(
      "ATTENTION_WORKBENCH_PATH_INVALID",
      "attention Workbench path must be a local absolute path without query, fragment, traversal, or authority",
    );
  }
  return path;
}

export function defaultAttentionKey(input: {
  environment: string;
  event_type: AttentionEventType;
  capability?: string;
  contract_digest?: string;
  details: Record<string, string | number | boolean | null>;
}): string {
  const failureClass = typeof input.details.failure_class === "string"
    ? input.details.failure_class
    : typeof input.details.reason_code === "string"
      ? input.details.reason_code
      : "none";
  return [
    input.environment,
    input.event_type,
    input.capability ?? "global",
    input.contract_digest ?? "no_digest",
    failureClass,
  ].join(":");
}

export function attentionEventId(sourceEventKey: string, eventType: AttentionEventType): string {
  const digest = canonicalJsonDigest({ source_event_key: sourceEventKey, event_type: eventType });
  return `aev_${digest.slice("sha256:".length)}`;
}

export function attentionItemId(attentionKey: string): string {
  const digest = canonicalJsonDigest({ attention_key: attentionKey });
  return `attn_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function boundedSinkId(value: string): string {
  const sinkId = boundedSafeLabel(value, "notification sink id", 128);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(sinkId)) {
    throw new ProposalStoreError(
      "NOTIFICATION_SINK_ID_INVALID",
      "notification sink id must use letters, numbers, underscore, period, or hyphen",
    );
  }
  return sinkId;
}

export function boundedSafeErrorCode(value: string): string {
  const errorCode = boundedSafeLabel(value, "notification error code", 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(errorCode)) {
    throw new ProposalStoreError(
      "NOTIFICATION_ERROR_CODE_INVALID",
      "notification error code must be an uppercase safe code",
    );
  }
  return errorCode;
}

export function notificationDeliveryId(sinkId: string, eventId: string): string {
  const digest = canonicalJsonDigest({ sink_id: sinkId, event_id: eventId });
  return `ndl_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function notificationLeaseId(deliveryId: string, owner: string, attempt: number, now: string): string {
  const digest = canonicalJsonDigest({
    delivery_id: deliveryId,
    owner,
    attempt,
    now,
  });
  return `nlease_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function attentionSeverityRank(severity: AttentionSeverity): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

export function attentionDecisionSubject(item: AttentionItem): AttentionDecisionSubject {
  return {
    proposal_id: item.attention_id,
    proposal_version: item.occurrence_count,
    proposal_hash: canonicalJsonDigest({
      schema_version: "synapsor.attention-decision-subject.v1",
      attention_id: item.attention_id,
      attention_key: item.attention_key,
      status: item.status,
      severity: item.severity,
      environment: item.environment,
      event_type: item.event_type,
      capability: item.capability ?? null,
      contract_digest: item.contract_digest ?? null,
      occurrence_count: item.occurrence_count,
      latest_event_id: item.latest_event_id,
      last_seen_at: item.last_seen_at,
    }),
  };
}

export function notificationReplayDecisionSubject(
  delivery: NotificationDelivery,
): NotificationReplayDecisionSubject {
  return {
    proposal_id: delivery.delivery_id,
    proposal_version: Math.max(1, delivery.attempts),
    proposal_hash: canonicalJsonDigest({
      schema_version: "synapsor.notification-replay-decision-subject.v1",
      delivery_id: delivery.delivery_id,
      sink_id: delivery.sink_id,
      event_id: delivery.event_id,
      attention_id: delivery.attention_id ?? null,
      status: delivery.status,
      attempts: delivery.attempts,
      max_attempts: delivery.max_attempts,
      last_error_code: delivery.last_error_code ?? null,
      updated_at: delivery.updated_at,
    }),
  };
}

export function assertNotificationReplayOperatorDecision(
  delivery: NotificationDelivery,
  identity: OperatorIdentityProof,
  reason: string,
): void {
  if (!identity.verified || identity.provider === "dev_env") {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to replay notification delivery ${delivery.delivery_id}`,
    );
  }
  if (identity.subject !== identity.decision.subject) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_MISMATCH",
      "notification replay identity does not match its signed decision subject",
    );
  }
  const subject = notificationReplayDecisionSubject(delivery);
  if (
    identity.decision.action !== "notification_replay"
    || identity.decision.proposal_id !== subject.proposal_id
    || identity.decision.proposal_version !== subject.proposal_version
    || identity.decision.proposal_hash !== subject.proposal_hash
    || identity.decision.reason !== reason
  ) {
    throw new ProposalStoreError(
      "OPERATOR_DECISION_MISMATCH",
      "operator proof is not bound to this exact notification delivery revision and replay reason",
    );
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "notification replay decision hash failed its integrity check",
    );
  }
  const { integrity_hash: _integrityHash, ...core } = identity;
  const canonicalCore = JSON.parse(JSON.stringify(core)) as Record<string, unknown>;
  if (identity.integrity_hash !== canonicalJsonDigest(canonicalCore)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "notification replay identity proof failed its integrity check",
    );
  }
}

export function assertAttentionOperatorDecision(
  item: AttentionItem,
  actor: string,
  identity: OperatorIdentityProof | undefined,
  requireVerified: boolean,
): void {
  if (requireVerified && (!identity || !identity.verified || identity.provider === "dev_env")) {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to acknowledge attention item ${item.attention_id}`,
    );
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_MISMATCH",
      `operator identity ${identity.subject} does not match attention acknowledgement actor ${actor}`,
    );
  }
  const subject = attentionDecisionSubject(item);
  if (
    identity.decision.action !== "attention_acknowledge"
    || identity.decision.proposal_id !== subject.proposal_id
    || identity.decision.proposal_version !== subject.proposal_version
    || identity.decision.proposal_hash !== subject.proposal_hash
  ) {
    throw new ProposalStoreError(
      "OPERATOR_DECISION_MISMATCH",
      "operator proof is not bound to this exact attention item version",
    );
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "attention acknowledgement decision hash failed its integrity check",
    );
  }
  const { integrity_hash: _integrityHash, ...core } = identity;
  const canonicalCore = JSON.parse(JSON.stringify(core)) as Record<string, unknown>;
  if (identity.integrity_hash !== canonicalJsonDigest(canonicalCore)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "attention acknowledgement identity proof failed its integrity check",
    );
  }
}
