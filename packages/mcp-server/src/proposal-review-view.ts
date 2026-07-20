import type { StoredProposal, StoredWritebackReceipt } from "@synapsor-runner/proposal-store";
import { protocolVersions } from "@synapsor-runner/protocol";

type JsonRecord = Record<string, unknown>;

export type ProposalReviewView = JsonRecord & {
  schema_version: "synapsor.proposal-review-view.v1";
  proposal: {
    id: string;
    version: number;
    action: string;
    capability: string;
    status: string;
  };
  security_boundary: {
    presentation_only: true;
    approval_tool_exposed: false;
    apply_tool_exposed: false;
    privileged_handoff_embedded: false;
  };
};

export function buildProposalReviewView(
  proposal: StoredProposal,
  receipts: StoredWritebackReceipt[] = [],
): ProposalReviewView {
  const changeSet = proposal.change_set;
  const boundedSet = changeSet.schema_version === protocolVersions.changeSetV3 ? {
    operation: changeSet.operation,
    row_count: changeSet.frozen_set.row_count,
    max_rows: changeSet.frozen_set.max_rows,
    aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    set_digest: changeSet.frozen_set.set_digest,
    members: changeSet.frozen_set.members.map((member) => ({
      primary_key: member.primary_key,
      expected_version: member.expected_version,
      before: member.before,
      after: member.after,
      before_digest: member.before_digest,
      after_digest: member.after_digest,
      tombstone_digest: member.tombstone_digest,
    })),
  } : undefined;
  const latestReceipt = receipts.at(-1);
  const appliedReceipt = [...receipts].reverse().find((stored) =>
    stored.status === "applied" || stored.status === "already_applied");
  const inverse = asRecord(asRecord(appliedReceipt?.receipt).inverse);
  const requested = changeSet.schema_version !== protocolVersions.compensationChangeSet
    && "reversibility" in changeSet
    && asRecord(changeSet.reversibility).mode === "reviewed_inverse";
  const compensation = changeSet.schema_version === protocolVersions.compensationChangeSet
    ? changeSet.compensation.descriptor
    : undefined;
  const reversibility = compensation ? {
    status: "compensation_proposal",
    message: "This is a reviewed compensation proposal. It does not change the source until separately approved and applied.",
    operation: compensation.operation,
    cardinality: compensation.cardinality,
    member_count: compensation.members.length,
    root_proposal_id: compensation.lineage.root_proposal_id,
    parent_proposal_id: compensation.lineage.parent_proposal_id,
    reverts_proposal_id: compensation.lineage.reverts_proposal_id,
    depth: compensation.lineage.depth,
  } : inverse.availability === "available" ? {
    status: "available",
    message: "A trusted apply receipt captured an allowlisted inverse. Revert creates another approval-required proposal; it does not write immediately.",
    operation: inverse.operation,
    cardinality: inverse.cardinality,
    member_count: Array.isArray(inverse.members) ? inverse.members.length : undefined,
    lineage: inverse.lineage,
    command: `synapsor-runner revert ${proposal.proposal_id}`,
  } : inverse.availability === "best_effort_unavailable" ? {
    status: "unavailable",
    message: "The trusted receipt could not produce a safe reviewed inverse for this operation.",
    reason_codes: inverse.reason_codes,
  } : requested ? {
    status: "requested",
    message: "Reviewed compensation is requested. Availability is decided only after an unambiguous trusted apply receipt captures the inverse.",
  } : {
    status: "not_configured",
    message: "This capability did not request reviewed compensation.",
  };
  const diff = Object.fromEntries(Object.keys(changeSet.patch).map((column) => [column, {
    before: changeSet.before[column],
    proposed: changeSet.after[column],
  }]));
  const expectedVersion = "expected_version" in changeSet.guards
    ? changeSet.guards.expected_version
    : undefined;
  const capability = proposal.capability ?? proposal.action;

  return {
    schema_version: "synapsor.proposal-review-view.v1",
    message: proposal.source_database_mutated
      ? "Commit executed by trusted runner."
      : "The model can propose this change. It cannot approve or commit it.",
    proposal: {
      id: proposal.proposal_id,
      version: proposal.proposal_version,
      action: proposal.action,
      capability,
      status: proposal.state,
    },
    requested_business_action: proposal.action,
    semantic_capability: capability,
    source_database_changed: proposal.source_database_mutated,
    proposed_patch: changeSet.patch,
    diff,
    trusted_context: {
      tenant_id: proposal.tenant_id,
      principal: changeSet.principal.id,
      provenance: changeSet.principal.source,
    },
    evidence_summary: {
      bundle_id: changeSet.evidence.bundle_id,
      required: true,
      item_count: Array.isArray(changeSet.evidence.items) ? changeSet.evidence.items.length : 0,
      values_included_in_summary: false,
    },
    kept_out_fields: {
      enforced_by: "reviewed visible-column allowlist",
      values_included: false,
      note: "Fields outside the reviewed capability surface are not included in this view.",
    },
    expected_source_version: expectedVersion ?? null,
    policy_and_risk: {
      approval: changeSet.approval,
      decision: proposal.state,
    },
    expiration: {
      expires_at: null,
      status: "not_configured",
    },
    receipt: latestReceipt ? {
      status: latestReceipt.status,
      receipt_id: latestReceipt.receipt_id,
      source_database_mutated: latestReceipt.source_database_mutated,
      created_at: latestReceipt.created_at,
    } : {
      status: "not_created",
      source_database_mutated: false,
    },
    guard_checklist: {
      tenant_guard: changeSet.guards.tenant,
      allowed_columns: changeSet.guards.allowed_columns,
      primary_key: changeSet.source.primary_key,
      conflict_version: expectedVersion,
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      affected_row_count_required: boundedSet?.row_count ?? 1,
      ...(boundedSet ? {
        bounded_set: true,
        max_rows: boundedSet.max_rows,
        aggregate_bounds: boundedSet.aggregate_bounds,
        exact_set_digest: boundedSet.set_digest,
      } : {}),
    },
    writeback: {
      status: proposal.state,
      mode: changeSet.writeback.mode,
      executor: (changeSet.writeback as { executor?: unknown }).executor ?? "sql_update",
    },
    evidence: changeSet.evidence,
    reversibility,
    ...(boundedSet ? { bounded_set: boundedSet } : {}),
    handoff: {
      mode: "standalone_operator",
      privileged_authority_embedded: false,
      local_ui_command: "synapsor-runner ui --config ./synapsor.runner.json --store ./.synapsor/local.db",
      terminal_review_command: `synapsor-runner proposals show ${proposal.proposal_id} --store ./.synapsor/local.db`,
      note: "Approval and apply remain outside the model-facing MCP surface.",
    },
    security_boundary: {
      presentation_only: true,
      approval_tool_exposed: false,
      apply_tool_exposed: false,
      privileged_handoff_embedded: false,
    },
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}
