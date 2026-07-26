import type {
  LocalProposalState,
} from "./domain-types.js";
import {
  parseWritebackResult,
  protocolVersions,
  type ChangeSet,
  type ExecutionReceipt,
  type ExecutionReceiptV2,
  type ExecutionReceiptV3,
  type ExecutionReceiptV4,
  type InverseDescriptorV1,
  type WritebackJobV1,
  type WritebackJobV2,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import { ProposalStoreError } from "./errors.js";

export function stateFromReceipt(receipt: ExecutionReceipt): LocalProposalState {
  if (receipt.status === "applied" || receipt.status === "already_applied") return "applied";
  if (receipt.status === "conflict") return "conflict";
  if (receipt.status === "canceled") return "canceled";
  if (receipt.status === "reconciliation_required") return "reconciliation_required";
  return "failed";
}

export function localStateFromCloudGovernance(state: string): LocalProposalState | undefined {
  if (state === "applied" || state === "already_applied") return "applied";
  if (state === "rejected") return "rejected";
  if (state === "canceled") return "canceled";
  if (state === "conflict") return "conflict";
  if (state === "failed") return "failed";
  if (state === "indeterminate" || state === "reconciliation_required") return "reconciliation_required";
  return undefined;
}

export function receiptToWritebackResult(receipt: ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4): WritebackResult {
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

export function inverseCaptureFromChangeSet(changeSet: ChangeSet, writebackJobId: string): InverseDescriptorV1 | undefined {
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

export function selectReviewedState(value: Record<string, unknown>, columns: string[]): Record<string, string | number | boolean | null> {
  const selected: Record<string, string | number | boolean | null> = {};
  for (const column of [...new Set(columns)].sort()) {
    const item = value[column];
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") selected[column] = item;
  }
  return selected;
}

export function writebackMutationFromChangeSet(changeSet: Extract<ChangeSet, { schema_version: "synapsor.change-set.v2" }>): WritebackJobV2["mutation"] {
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

export function conflictGuardFromChangeSet(changeSet: ChangeSet): WritebackJobV1["conflict_guard"] {
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
