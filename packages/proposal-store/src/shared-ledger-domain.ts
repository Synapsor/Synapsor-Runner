import type {
  SharedLedgerEntry,
} from "./domain-types.js";
import type { SQLInputValue } from "node:sqlite";

export const sharedLedgerJsonColumns = new Set([
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
  "details_json",
  "acknowledgement_identity_json",
]);

export const sharedLedgerKindToTable: Record<string, string> = {
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
  explore_budget_reservation: "explore_budget_reservations",
  replay_record: "replay_records",
  shadow_human_action: "shadow_human_actions",
  shadow_study: "shadow_studies",
  shadow_study_case: "shadow_study_cases",
  shadow_outcome: "shadow_outcomes",
  worker_queue_item: "worker_queue",
  attention_event: "attention_events",
  attention_item: "attention_items",
  notification_delivery: "notification_deliveries",
  runner_state: "runner_state",
  policy_recommendation: "policy_recommendations",
  cloud_outbox_event: "cloud_outbox",
  cloud_governance_event: "cloud_governance_events",
};

export type SharedLedgerRestoreSpec = {
  columns: string[];
  conflict: string;
  required: Set<string>;
};

export const sharedLedgerRestoreSpecs: Record<string, SharedLedgerRestoreSpec> = {
  proposals: restoreSpec("proposal_id", [
    "proposal_id", "proposal_version", "proposal_hash", "action", "state",
    "tenant_id", "principal", "capability", "interaction_id", "tool_call_id",
    "business_object", "object_id", "source_kind", "source_id", "source_schema",
    "source_table", "source_database_mutated", "change_set_json", "created_at", "updated_at",
  ], ["proposal_id", "proposal_version", "proposal_hash", "action", "state", "tenant_id", "business_object", "object_id", "source_kind", "source_id", "source_schema", "source_table", "source_database_mutated", "change_set_json", "created_at", "updated_at"]),
  proposal_events: restoreSpec("event_id", ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"], ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"]),
  approvals: restoreSpec("approval_id", ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "reason", "identity_json", "decision_hash", "signature", "integrity_hash", "freshness_proof_digest", "created_at"], ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "created_at"]),
  writeback_jobs: restoreSpec("writeback_job_id", ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"], ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"]),
  writeback_intents: restoreSpec("intent_id", ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "result_json", "reconciliation_reason", "created_at", "updated_at"], ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "created_at", "updated_at"]),
  idempotency_receipts: restoreSpec("idempotency_key", ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"], ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"]),
  writeback_receipts: restoreSpec("receipt_id", ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"], ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"]),
  evidence_bundles: restoreSpec("evidence_bundle_id", ["evidence_bundle_id", "proposal_id", "tenant_id", "principal", "capability", "source_id", "source_table", "business_object", "object_id", "query_fingerprint", "payload_json", "created_at"], ["evidence_bundle_id", "tenant_id", "payload_json", "created_at"]),
  evidence_items: restoreSpec("evidence_item_id", ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"], ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"]),
  query_audit: restoreSpec("audit_id", ["audit_id", "proposal_id", "evidence_bundle_id", "tenant_id", "principal", "capability", "business_object", "object_id", "primary_key_value", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"], ["audit_id", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"]),
  explore_budget_reservations: restoreSpec("reservation_id", ["reservation_id", "scope_fingerprint", "resource_id", "variant_fingerprint", "requires_differencing", "differencing_counted", "reserved_cells", "accounted_cells", "status", "created_at", "completed_at"], ["reservation_id", "scope_fingerprint", "resource_id", "variant_fingerprint", "requires_differencing", "differencing_counted", "reserved_cells", "accounted_cells", "status", "created_at"]),
  replay_records: restoreSpec("replay_id", ["replay_id", "proposal_id", "payload_json", "created_at"], ["replay_id", "proposal_id", "payload_json", "created_at"]),
  shadow_human_actions: restoreSpec("action_id", ["action_id", "proposal_id", "actor", "patch_json", "notes", "created_at"], ["action_id", "proposal_id", "actor", "patch_json", "created_at"]),
  shadow_studies: restoreSpec("study_id", ["study_id", "name", "description", "selected_capabilities_json", "starts_at", "ends_at", "status", "created_at", "updated_at"], ["study_id", "name", "selected_capabilities_json", "status", "created_at", "updated_at"]),
  shadow_study_cases: restoreSpec("case_id", ["case_id", "study_id", "request_id", "proposal_id", "tenant_id", "principal", "capability", "business_object", "object_id", "evidence_bundle_id", "proposed_effect_json", "agent_result", "decision_reason", "risk_score", "amount_value", "created_at"], ["case_id", "study_id", "request_id", "tenant_id", "capability", "business_object", "object_id", "agent_result", "created_at"]),
  shadow_outcomes: restoreSpec("outcome_id", ["outcome_id", "study_id", "request_id", "proposal_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "actual_effect_json", "occurred_at", "source", "reference", "reason", "created_at"], ["outcome_id", "study_id", "request_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "occurred_at", "source", "created_at"]),
  worker_queue: restoreSpec(
    "proposal_id",
    [
      "proposal_id",
      "status",
      "execution_mode",
      "contract_digest",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "lease_owner",
      "lease_id",
      "lease_expires_at",
      "last_error_code",
      "terminal_outcome",
      "created_at",
      "updated_at",
    ],
    ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"],
  ),
  attention_events: restoreSpec(
    "event_id",
    [
      "event_id",
      "schema_version",
      "event_type",
      "severity",
      "occurred_at",
      "environment",
      "proposal_id",
      "job_id",
      "operation_id",
      "correlation_id",
      "capability",
      "contract_digest",
      "attention_key",
      "attention_required",
      "immediate_default",
      "summary",
      "approval_source",
      "worker_state",
      "failure_class",
      "expires_at",
      "workbench_path",
      "details_json",
      "payload_hash",
      "created_at",
    ],
    [
      "event_id",
      "schema_version",
      "event_type",
      "severity",
      "occurred_at",
      "environment",
      "attention_required",
      "immediate_default",
      "summary",
      "details_json",
      "payload_hash",
      "created_at",
    ],
  ),
  attention_items: restoreSpec(
    "attention_id",
    [
      "attention_id",
      "attention_key",
      "status",
      "severity",
      "environment",
      "event_type",
      "capability",
      "contract_digest",
      "title",
      "occurrence_count",
      "first_event_id",
      "latest_event_id",
      "first_seen_at",
      "last_seen_at",
      "acknowledged_by",
      "acknowledged_at",
      "acknowledgement_identity_json",
      "acknowledgement_decision_hash",
      "acknowledgement_signature",
      "acknowledgement_integrity_hash",
      "resolved_at",
      "expires_at",
    ],
    [
      "attention_id",
      "attention_key",
      "status",
      "severity",
      "environment",
      "event_type",
      "title",
      "occurrence_count",
      "first_event_id",
      "latest_event_id",
      "first_seen_at",
      "last_seen_at",
    ],
  ),
  notification_deliveries: restoreSpec(
    "delivery_id",
    [
      "delivery_id",
      "sink_id",
      "event_id",
      "attention_id",
      "status",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "lease_owner",
      "lease_id",
      "lease_expires_at",
      "last_error_code",
      "external_reference",
      "delivered_at",
      "created_at",
      "updated_at",
    ],
    [
      "delivery_id",
      "sink_id",
      "event_id",
      "status",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "created_at",
      "updated_at",
    ],
  ),
  runner_state: restoreSpec("key", ["key", "value_json", "updated_at"], ["key", "value_json", "updated_at"]),
  policy_recommendations: restoreSpec("recommendation_id", ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"], ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"]),
  cloud_outbox: restoreSpec("event_id", ["event_id", "proposal_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "sent_at", "acknowledged_at", "created_at", "updated_at"], ["event_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]),
  cloud_governance_events: restoreSpec("event_id", ["event_id", "proposal_id", "cloud_proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"], ["event_id", "proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"]),
};

export function sharedLedgerPayload(table: string, row: Record<string, unknown>): Record<string, unknown> {
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

export function restoreSpec(conflict: string, columns: string[], required: string[]): SharedLedgerRestoreSpec {
  return { conflict, columns, required: new Set(required) };
}

export function sharedLedgerTableForEntry(entry: SharedLedgerEntry): string | undefined {
  const explicit = typeof entry.payload.table === "string" ? entry.payload.table : undefined;
  const table = explicit ?? sharedLedgerKindToTable[entry.kind];
  return table && sharedLedgerRestoreSpecs[table] ? table : undefined;
}

export function sharedLedgerRestoreRank(entry: SharedLedgerEntry): number {
  const order = [
    "proposals",
    "evidence_bundles",
    "evidence_items",
    "query_audit",
    "explore_budget_reservations",
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
    "attention_events",
    "attention_items",
    "notification_deliveries",
    "runner_state",
    "policy_recommendations",
    "cloud_outbox",
    "cloud_governance_events",
  ];
  const table = sharedLedgerTableForEntry(entry);
  const index = table ? order.indexOf(table) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sharedLedgerRestoreValue(payload: Record<string, unknown>, column: string): SQLInputValue {
  const key = column.endsWith("_json") ? column.slice(0, -5) : column;
  const value = payload[key] ?? payload[column];
  if (value == null) return null;
  if (sharedLedgerJsonColumns.has(column)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}
