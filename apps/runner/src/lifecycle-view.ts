import {
  ProposalStore,
  type ApprovalProgress,
  type CloudGovernanceEvent,
  type CloudOutboxItem,
  type LocalProposalState,
  type ProposalEvent,
  type ProposalReplayRecord,
  type ProposalSearchFilters,
  type StoredApproval,
  type StoredEvidenceBundle,
  type StoredProposal,
  type StoredWritebackIntent,
  type StoredWritebackJob,
  type StoredWritebackReceipt,
  type WorkerQueueItem,
} from "@synapsor-runner/proposal-store";

export const lifecycleViewSchemaVersion = "synapsor.lifecycle-view.v1" as const;
export const lifecycleListSchemaVersion = "synapsor.lifecycle-list.v1" as const;

export type LifecycleHandleKind = "proposal" | "evidence" | "replay" | "job" | "intent" | "receipt" | "audit";

export type LifecycleSelection = {
  mode: "latest" | "filtered" | "handle";
  requested_handle: string | null;
  handle_kind: LifecycleHandleKind | null;
  filters: ProposalSearchFilters;
  match_count: number;
};

export type LifecycleSummary = {
  proposal_id: string;
  created_at: string;
  updated_at: string;
  state: LocalProposalState;
  tenant_id: string;
  principal: string;
  capability: string;
  operation: string;
  business_object: string;
  object_id: string;
  source_database_mutated: boolean;
};

export type LifecycleListV1 = {
  schema_version: typeof lifecycleListSchemaVersion;
  filters: ProposalSearchFilters;
  total_matches: number;
  returned: number;
  lifecycles: LifecycleSummary[];
};

export type LifecycleViewV1 = {
  schema_version: typeof lifecycleViewSchemaVersion;
  selection: LifecycleSelection;
  proposal: {
    proposal_id: string;
    proposal_version: number;
    proposal_hash: string;
    change_set_schema: string;
    state: LocalProposalState;
    created_at: string;
    updated_at: string;
    contract: { digest: string; version: string } | null;
    capability: string;
    operation: string;
    scope: {
      tenant_id: string;
      principal: string;
      principal_source: string;
      business_object: string;
      object_id: string;
    };
    target: {
      source_kind: string;
      source_id: string;
      schema: string;
      table: string;
      primary_key: unknown;
    };
    change: {
      before: unknown;
      patch: unknown;
      after: unknown;
      frozen_set: unknown | null;
    };
    guards: unknown;
    source_database_mutated: boolean;
  };
  approval: {
    status: "pending" | "approved" | "rejected" | "canceled" | "incomplete";
    source: "none" | "policy" | "human" | "mixed";
    required_role: string | null;
    policy: string | null;
    progress: ApprovalProgress;
    decisions: Array<Record<string, unknown>>;
    tripped_policy_limits: unknown[];
  };
  freshness: {
    required: boolean;
    target_count: number;
    supporting_count: number;
    latest_status: string;
    latest_checked_at: string | null;
    latest_proof_digest: string | null;
    latest_safe_code: string | null;
    approval_proofs: Array<{ approval_id: number; approver: string; proof_digest: string | null }>;
    next_action: string;
  };
  evidence: {
    bundles: Array<Record<string, unknown>>;
    count: number;
  };
  query_audit: {
    records: Array<Record<string, unknown>>;
    count: number;
  };
  writeback: {
    jobs: Array<Record<string, unknown>>;
    intents: Array<Record<string, unknown>>;
    worker_queue: Record<string, unknown> | null;
    receipts: Array<Record<string, unknown>>;
    latest_outcome: Record<string, unknown> | null;
  };
  replay: {
    replay_id: string | null;
    state: LocalProposalState | null;
    generated_at: string | null;
  };
  compensation: {
    requested: boolean;
    lineage: unknown | null;
    inverse_receipts: unknown[];
  };
  cloud: {
    synchronized: boolean;
    outbox: Array<Record<string, unknown>>;
    governance_events: Array<Record<string, unknown>>;
  };
  timeline: Array<Record<string, unknown>>;
  next: {
    read_only: string;
    operator: string | null;
  };
};

export class LifecycleViewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LifecycleViewError";
  }
}

export function listLifecycleSummaries(
  store: ProposalStore,
  filters: ProposalSearchFilters,
): LifecycleListV1 {
  return lifecycleRead("stored proposal lifecycles could not be decoded safely", () => {
    const totalMatches = store.countProposals(withoutLimit(filters));
    const proposals = store.listProposals(filters);
    return {
      schema_version: lifecycleListSchemaVersion,
      filters: stableFilters(filters),
      total_matches: totalMatches,
      returned: proposals.length,
      lifecycles: proposals.map(lifecycleSummary),
    };
  });
}

export function resolveLifecycleProposal(
  store: ProposalStore,
  input: { handle?: string; filters?: ProposalSearchFilters },
): { proposal: StoredProposal; selection: LifecycleSelection } {
  return lifecycleRead("the requested lifecycle record could not be decoded safely", () => resolveLifecycleProposalUnchecked(store, input));
}

function resolveLifecycleProposalUnchecked(
  store: ProposalStore,
  input: { handle?: string; filters?: ProposalSearchFilters },
): { proposal: StoredProposal; selection: LifecycleSelection } {
  const filters = input.filters ?? {};
  const handle = input.handle?.trim();
  if (handle && handle !== "latest") {
    if (hasSelectionFilters(filters)) {
      throw new LifecycleViewError("LIFECYCLE_SELECTION_CONFLICT", "a lifecycle handle cannot be combined with list/show filters");
    }
    const resolved = proposalFromLifecycleHandle(store, handle);
    return {
      proposal: resolved.proposal,
      selection: {
        mode: "handle",
        requested_handle: handle,
        handle_kind: resolved.kind,
        filters: {},
        match_count: 1,
      },
    };
  }

  const count = store.countProposals(withoutLimit(filters));
  if (count === 0) {
    throw new LifecycleViewError(
      "LIFECYCLE_NOT_FOUND",
      hasSelectionFilters(filters) ? "no proposal lifecycle matches the supplied filters" : "the ledger contains no proposal lifecycle",
    );
  }
  const proposal = store.listProposals({ ...withoutLimit(filters), limit: 1 })[0];
  if (!proposal) throw new LifecycleViewError("LIFECYCLE_NOT_FOUND", "the newest matching proposal could not be read");
  return {
    proposal,
    selection: {
      mode: hasSelectionFilters(filters) ? "filtered" : "latest",
      requested_handle: null,
      handle_kind: null,
      filters: stableFilters(filters),
      match_count: count,
    },
  };
}

export function buildLifecycleView(
  store: ProposalStore,
  proposal: StoredProposal,
  selection: LifecycleSelection,
  commandName = "synapsor-runner",
): LifecycleViewV1 {
  return lifecycleRead(
    `linked records for proposal ${proposal.proposal_id} could not be decoded safely`,
    () => buildLifecycleViewUnchecked(store, proposal, selection, commandName),
  );
}

function buildLifecycleViewUnchecked(
  store: ProposalStore,
  proposal: StoredProposal,
  selection: LifecycleSelection,
  commandName: string,
): LifecycleViewV1 {
  const proposalId = proposal.proposal_id;
  const approvals = stableBy(store.approvals(proposalId), (item) => `${item.created_at}:${String(item.approval_id).padStart(20, "0")}`);
  const events = stableBy(store.events(proposalId), (item) => `${item.created_at}:${String(item.event_id).padStart(20, "0")}`);
  const evidence = stableBy(store.listEvidenceBundles({ proposal: proposalId }), (item) => `${item.created_at}:${item.evidence_bundle_id}`);
  const audit = stableBy(store.listQueryAudit({ proposal: proposalId }), queryAuditSortKey);
  const jobs = store.listWritebackJobs({ proposal_id: proposalId, limit: 1000 });
  const intents = stableBy(store.listWritebackIntents({ proposal_id: proposalId, limit: 1000 }), (item) => `${item.created_at}:${item.intent_id}`);
  const receipts = stableBy(store.listReceipts({ proposal: proposalId }), (item) => `${item.created_at}:${String(item.receipt_id).padStart(20, "0")}`);
  const worker = store.getWorkerQueueItem(proposalId);
  const outbox = stableBy(store.listCloudOutbox({ proposal_id: proposalId, limit: 1000 }), (item) => `${item.created_at}:${item.event_id}`);
  const governance = stableBy(store.listCloudGovernanceEvents(proposalId), (item) => `${item.created_at}:${item.event_id}`);
  const replay = store.getStoredReplayForProposal(proposalId);
  const latestFreshness = store.latestFreshnessProof(proposalId);

  assertLifecycleLinks(proposal, evidence, audit, jobs, intents, receipts, worker, governance, replay);

  const changeSet = asRecord(proposal.change_set);
  if (!changeSet) {
    throw new LifecycleViewError(
      "LIFECYCLE_RECORD_CORRUPT",
      `proposal ${proposalId} does not contain a valid change-set object`,
    );
  }
  const approval = asRecord(changeSet.approval);
  const source = asRecord(changeSet.source);
  const scope = asRecord(changeSet.scope);
  const principal = asRecord(changeSet.principal);
  const contract = asRecord(changeSet.contract);
  const approvalProgress = store.approvalProgress(proposalId);
  const approvalSource = lifecycleApprovalSource(approvals);
  const latestReceipt = receipts.at(-1);
  const lineage = compensationLineage(changeSet);
  const inverseReceipts = receipts
    .map((item) => asRecord(item.receipt)?.inverse)
    .filter((item) => item !== undefined)
    .map((item) => safeDomainValue(item));
  const freshnessAuthority = asRecord(changeSet.freshness);
  const freshnessTarget = asRecord(freshnessAuthority?.target);
  const freshnessDependencies = Array.isArray(freshnessAuthority?.dependencies) ? freshnessAuthority.dependencies : [];

  return {
    schema_version: lifecycleViewSchemaVersion,
    selection,
    proposal: {
      proposal_id: proposalId,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      change_set_schema: stringValue(changeSet.schema_version) ?? "unknown",
      state: proposal.state,
      created_at: proposal.created_at,
      updated_at: proposal.updated_at,
      contract: contract
        ? { digest: stringValue(contract.digest) ?? "unknown", version: stringValue(contract.version) ?? "unknown" }
        : null,
      capability: proposal.capability ?? proposal.action,
      operation: lifecycleOperation(changeSet),
      scope: {
        tenant_id: proposal.tenant_id,
        principal: proposal.principal ?? stringValue(principal?.id) ?? "unknown",
        principal_source: stringValue(principal?.source) ?? "unknown",
        business_object: proposal.business_object,
        object_id: proposal.object_id,
      },
      target: {
        source_kind: proposal.source_kind,
        source_id: proposal.source_id,
        schema: proposal.source_schema,
        table: proposal.source_table,
        primary_key: safeDomainValue(source?.primary_key ?? null),
      },
      change: {
        before: safeDomainValue(changeSet.before ?? {}),
        patch: safeDomainValue(changeSet.patch ?? {}),
        after: safeDomainValue(changeSet.after ?? {}),
        frozen_set: changeSet.frozen_set === undefined ? null : safeDomainValue(changeSet.frozen_set),
      },
      guards: safeDomainValue(changeSet.guards ?? {}),
      source_database_mutated: proposal.source_database_mutated,
    },
    approval: {
      status: lifecycleApprovalStatus(proposal.state, approvalProgress),
      source: approvalSource,
      required_role: stringValue(approval?.required_role) ?? null,
      policy: stringValue(approval?.policy) ?? policyNameFromApprovals(approvals),
      progress: approvalProgress,
      decisions: approvals.map(publicApproval),
      tripped_policy_limits: policyLimitTrips(events),
    },
    freshness: {
      required: freshnessAuthority !== undefined,
      target_count: latestFreshness?.target_count ?? numberValue(freshnessTarget?.member_count) ?? 0,
      supporting_count: latestFreshness?.supporting_count ?? freshnessDependencies.length,
      latest_status: latestFreshness?.result ?? (freshnessAuthority ? "not_checked" : "not_required"),
      latest_checked_at: latestFreshness?.checked_at ?? null,
      latest_proof_digest: latestFreshness?.proof_digest ?? null,
      latest_safe_code: latestFreshness?.safe_code ?? null,
      approval_proofs: approvals.map((item) => ({
        approval_id: item.approval_id,
        approver: item.approver,
        proof_digest: item.freshness_proof_digest ?? null,
      })),
      next_action: latestFreshness?.result === "stale"
        ? "Create a new source read and proposal."
        : latestFreshness?.result === "unavailable"
          ? "Retry the live freshness check when the source is available."
          : freshnessAuthority && !latestFreshness
            ? "Run proposals check-freshness before approval."
            : "Apply still revalidates target and supporting dependencies.",
    },
    evidence: {
      bundles: evidence.map(publicEvidence),
      count: evidence.length,
    },
    query_audit: {
      records: audit.map((item) => safeDomainValue(item) as Record<string, unknown>),
      count: audit.length,
    },
    writeback: {
      jobs: jobs.map(publicWritebackJob),
      intents: intents.map(publicWritebackIntent),
      worker_queue: worker ? publicWorkerQueue(worker) : null,
      receipts: receipts.map(publicReceipt),
      latest_outcome: latestReceipt ? publicReceipt(latestReceipt) : null,
    },
    replay: {
      replay_id: replay?.replay_id ?? null,
      state: replay?.proposal.state ?? null,
      generated_at: replay?.generated_at ?? null,
    },
    compensation: {
      requested: lineage !== null || inverseReceipts.length > 0,
      lineage,
      inverse_receipts: inverseReceipts,
    },
    cloud: {
      synchronized: outbox.some((item) => item.status === "acknowledged") || governance.length > 0,
      outbox: outbox.map(publicCloudOutbox),
      governance_events: governance.map(publicGovernanceEvent),
    },
    timeline: lifecycleTimeline(events, audit, replay, outbox, governance),
    next: lifecycleNext(proposal, intents, jobs, commandName),
  };
}

export function formatLifecycleList(payload: LifecycleListV1): string {
  if (payload.returned === 0) return "No proposal lifecycles found.\n";
  const lines = [`Proposal lifecycles (${payload.returned} shown, ${payload.total_matches} matched)`];
  payload.lifecycles.forEach((item, index) => {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${item.state.toUpperCase()} ${item.capability} ${item.business_object}:${item.object_id}`,
      `    ${item.proposal_id} tenant=${item.tenant_id} principal=${item.principal} operation=${item.operation} created=${item.created_at}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

export function formatLifecycleFirstLook(view: LifecycleViewV1): string {
  const latest = view.writeback.latest_outcome;
  const lines = [
    `Lifecycle: ${view.proposal.proposal_id}`,
    `State: ${view.proposal.state}`,
    `Request: ${view.proposal.capability} (${view.proposal.operation})`,
    `Object: ${view.proposal.scope.business_object}:${view.proposal.scope.object_id}`,
    `Trusted scope: tenant=${view.proposal.scope.tenant_id} principal=${view.proposal.scope.principal}`,
    `Approval: ${view.approval.status} via ${view.approval.source} (${view.approval.progress.approved}/${view.approval.progress.required})`,
    `Freshness: ${view.freshness.latest_status}; target=${view.freshness.target_count} supporting=${view.freshness.supporting_count}; proof=${view.freshness.latest_proof_digest ?? "none"}`,
    `Evidence: ${view.evidence.count} bundle${view.evidence.count === 1 ? "" : "s"}; query audit: ${view.query_audit.count}`,
    `Writeback: ${view.writeback.jobs.length ? `${view.writeback.jobs.length} job(s)` : "not created"}; ${view.writeback.intents.length ? `${view.writeback.intents.length} intent(s)` : "no intent"}`,
    `Latest outcome: ${latest ? `${String(latest.status)} rows=${String(latest.rows_affected)} source_changed=${String(latest.source_database_mutated)}` : "not applied"}`,
    `Replay: ${view.replay.replay_id ?? "not created"}`,
    `Cloud: ${view.cloud.synchronized ? "synchronized reference recorded" : "not synchronized"}`,
    `Source database changed: ${view.proposal.source_database_mutated}`,
  ];
  if (view.selection.match_count > 1) {
    lines.push(`Showing newest of ${view.selection.match_count} matching lifecycles. Use lifecycle list with the same filters to browse all matches.`);
  }
  lines.push(`Read next: ${view.next.read_only}`);
  if (view.next.operator) lines.push(`Operator next: ${view.next.operator}`);
  return `${lines.join("\n")}\n`;
}

export function formatLifecycleDetails(view: LifecycleViewV1): string {
  const sections: Array<[string, unknown]> = [
    ["Proposal", view.proposal],
    ["Approval", view.approval],
    ["Freshness", view.freshness],
    ["Evidence", view.evidence],
    ["Query audit", view.query_audit],
    ["Writeback", view.writeback],
    ["Replay", view.replay],
    ["Compensation", view.compensation],
    ["Cloud references", view.cloud],
    ["Ordered timeline", view.timeline],
  ];
  const lines = [
    `Lifecycle ${view.proposal.proposal_id}`,
    `Selection: ${view.selection.mode}; matches=${view.selection.match_count}`,
  ];
  for (const [label, value] of sections) {
    lines.push("", `${label}:`, indent(JSON.stringify(value, null, 2), 2));
  }
  lines.push("", `Read next: ${view.next.read_only}`);
  if (view.next.operator) lines.push(`Operator next: ${view.next.operator}`);
  return `${lines.join("\n")}\n`;
}

function proposalFromLifecycleHandle(
  store: ProposalStore,
  handle: string,
): { proposal: StoredProposal; kind: LifecycleHandleKind } {
  const namespaced = parseNamespacedHandle(handle);
  if (namespaced) return proposalFromTypedHandle(store, namespaced.kind, namespaced.value);
  if (/^\d+$/.test(handle)) {
    throw new LifecycleViewError("LIFECYCLE_HANDLE_AMBIGUOUS", `numeric handle ${handle} requires receipt:${handle} or audit:${handle}`);
  }

  const matches = new Map<string, LifecycleHandleKind>();
  const proposal = store.getProposal(handle);
  if (proposal) matches.set(proposal.proposal_id, "proposal");
  const evidence = store.getEvidenceBundle(handle);
  const evidenceProposal = evidence?.proposal_id ?? store.proposalIdForEvidence(handle);
  if (evidenceProposal) matches.set(evidenceProposal, "evidence");
  const job = store.getWritebackJob(handle);
  if (job) matches.set(job.proposal_id, "job");
  const intent = store.getWritebackIntent(handle);
  if (intent) matches.set(intent.proposal_id, "intent");
  const replay = store.getStoredReplay(handle);
  if (replay) matches.set(replay.proposal.proposal_id, "replay");
  if (matches.size === 0) throw new LifecycleViewError("LIFECYCLE_HANDLE_NOT_FOUND", `no lifecycle record matches ${handle}`);
  if (matches.size > 1) throw new LifecycleViewError("LIFECYCLE_HANDLE_AMBIGUOUS", `handle ${handle} resolves to more than one proposal lifecycle; use an explicit namespace`);
  const [proposalId, kind] = [...matches.entries()][0]!;
  return { proposal: requireProposal(store, proposalId), kind };
}

function proposalFromTypedHandle(
  store: ProposalStore,
  kind: LifecycleHandleKind,
  value: string,
): { proposal: StoredProposal; kind: LifecycleHandleKind } {
  let proposalId: string | undefined;
  if (kind === "proposal") proposalId = store.getProposal(value)?.proposal_id;
  if (kind === "evidence") proposalId = store.getEvidenceBundle(value)?.proposal_id ?? store.proposalIdForEvidence(value);
  if (kind === "replay") {
    const replayId = value.startsWith("replay_") ? value : `replay_${value}`;
    proposalId = store.getStoredReplay(replayId)?.proposal.proposal_id;
  }
  if (kind === "job") proposalId = store.getWritebackJob(value)?.proposal_id;
  if (kind === "intent") proposalId = store.getWritebackIntent(value)?.proposal_id;
  if (kind === "receipt") {
    const id = positiveIntegerHandle(value, "receipt");
    proposalId = store.getReceipt(id)?.proposal_id;
  }
  if (kind === "audit") {
    const id = positiveIntegerHandle(value, "audit");
    const audit = store.getQueryAudit(id);
    proposalId = stringValue(audit?.proposal_id);
    const evidenceId = stringValue(audit?.evidence_bundle_id);
    if (!proposalId && evidenceId) proposalId = store.proposalIdForEvidence(evidenceId);
  }
  if (!proposalId) throw new LifecycleViewError("LIFECYCLE_HANDLE_NOT_FOUND", `${kind} handle ${value} is not linked to a proposal lifecycle`);
  return { proposal: requireProposal(store, proposalId), kind };
}

function parseNamespacedHandle(handle: string): { kind: LifecycleHandleKind; value: string } | undefined {
  const match = handle.match(/^(proposal|evidence|replay|job|intent|receipt|audit):(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { kind: match[1] as LifecycleHandleKind, value: match[2] };
}

function positiveIntegerHandle(value: string, kind: "receipt" | "audit"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new LifecycleViewError("LIFECYCLE_HANDLE_INVALID", `${kind} handle must be a positive integer`);
  return id;
}

function requireProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new LifecycleViewError("LIFECYCLE_LINK_CORRUPT", `linked proposal ${proposalId} does not exist`);
  return proposal;
}

function lifecycleSummary(proposal: StoredProposal): LifecycleSummary {
  return {
    proposal_id: proposal.proposal_id,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    state: proposal.state,
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? proposal.change_set.principal.id,
    capability: proposal.capability ?? proposal.action,
    operation: lifecycleOperation(asRecord(proposal.change_set)),
    business_object: proposal.business_object,
    object_id: proposal.object_id,
    source_database_mutated: proposal.source_database_mutated,
  };
}

function publicApproval(approval: StoredApproval): Record<string, unknown> {
  const identity = approval.identity;
  return {
    approval_id: approval.approval_id,
    proposal_id: approval.proposal_id,
    proposal_version: approval.proposal_version,
    proposal_hash: approval.proposal_hash,
    approver: approval.approver,
    status: approval.status,
    reason: approval.reason ?? null,
    identity: identity ? {
      provider: identity.provider,
      verified: identity.verified,
      subject: identity.subject,
      roles: [...identity.roles].sort(),
      key_id: identity.key_id ?? null,
      algorithm: identity.algorithm ?? null,
      issuer: identity.issuer ?? null,
      decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash,
    } : null,
    freshness_proof_digest: approval.freshness_proof_digest ?? null,
    created_at: approval.created_at,
  };
}

function publicEvidence(evidence: StoredEvidenceBundle): Record<string, unknown> {
  return {
    evidence_bundle_id: evidence.evidence_bundle_id,
    proposal_id: evidence.proposal_id ?? null,
    tenant_id: evidence.tenant_id,
    principal: evidence.principal ?? null,
    capability: evidence.capability ?? null,
    source_id: evidence.source_id ?? null,
    source_table: evidence.source_table ?? null,
    business_object: evidence.business_object ?? null,
    object_id: evidence.object_id ?? null,
    query_fingerprint: evidence.query_fingerprint ?? null,
    payload: safeDomainValue(evidence.payload),
    items: safeDomainValue(evidence.items),
    created_at: evidence.created_at,
  };
}

function publicWritebackJob(job: StoredWritebackJob): Record<string, unknown> {
  if (job.kind === "app_handler") {
    return {
      writeback_job_id: job.writeback_job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.proposal_hash,
      kind: job.kind,
      status: job.status,
      schema_version: stringValue(job.payload.schema_version) ?? "synapsor.handler-writeback.v1",
      runner_id: stringValue(job.payload.runner_id) ?? null,
      executor: stringValue(job.payload.executor) ?? null,
      request: safeDomainValue(job.payload.request ?? {}),
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  }
  const normalized = job.normalized_job!;
  return {
    writeback_job_id: job.writeback_job_id,
    proposal_id: job.proposal_id,
    proposal_hash: job.proposal_hash,
    kind: job.kind,
    status: job.status,
    protocol_version: normalized.protocol_version,
    operation: normalized.operation ?? "single_row_update",
    source_id: normalized.source_id,
    engine: normalized.engine,
    target: safeDomainValue(normalized.target),
    allowed_columns: [...normalized.allowed_columns],
    patch: safeDomainValue(normalized.patch),
    conflict_guard: safeDomainValue(normalized.conflict_guard),
    version_advance: safeDomainValue("version_advance" in normalized ? normalized.version_advance ?? null : null),
    deduplication: safeDomainValue("deduplication" in normalized ? normalized.deduplication ?? null : null),
    frozen_set: safeDomainValue("frozen_set" in normalized ? normalized.frozen_set ?? null : null),
    idempotency_key: normalized.idempotency_key,
    lease_expires_at: normalized.lease_expires_at,
    attempt_count: normalized.attempt_count ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function publicWritebackIntent(intent: StoredWritebackIntent): Record<string, unknown> {
  return {
    intent_id: intent.intent_id,
    idempotency_key: intent.idempotency_key,
    writeback_job_id: intent.writeback_job_id,
    proposal_id: intent.proposal_id,
    proposal_hash: intent.proposal_hash,
    runner_id: intent.runner_id,
    operation: intent.operation,
    status: intent.status,
    result: safeDomainValue(intent.result ?? null),
    reconciliation_reason: intent.reconciliation_reason ?? null,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
  };
}

function publicReceipt(receipt: StoredWritebackReceipt): Record<string, unknown> {
  const body = asRecord(receipt.receipt)!;
  return {
    receipt_id: receipt.receipt_id,
    writeback_job_id: receipt.writeback_job_id,
    proposal_id: receipt.proposal_id,
    runner_id: receipt.runner_id,
    status: receipt.status,
    idempotency_key: receipt.idempotency_key,
    receipt_authority: stringValue(body.receipt_authority) ?? "source_db",
    operation: stringValue(body.operation) ?? "single_row_update",
    rows_affected: numberValue(body.rows_affected) ?? 0,
    source_database_mutated: receipt.source_database_mutated,
    safe_outcome_code: stringValue(body.safe_outcome_code) ?? null,
    safe_error_code: stringValue(body.safe_error_code) ?? null,
    receipt_hash: stringValue(body.receipt_hash) ?? null,
    executed_at: stringValue(body.executed_at) ?? receipt.created_at,
    receipt: safeDomainValue(receipt.receipt),
    created_at: receipt.created_at,
  };
}

function publicWorkerQueue(item: WorkerQueueItem): Record<string, unknown> {
  return {
    proposal_id: item.proposal_id,
    status: item.status,
    attempts: item.attempts,
    max_attempts: item.max_attempts,
    next_attempt_at: item.next_attempt_at,
    lease_owner: item.lease_owner ?? null,
    lease_expires_at: item.lease_expires_at ?? null,
    last_error_code: item.last_error_code ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function publicCloudOutbox(item: CloudOutboxItem): Record<string, unknown> {
  return {
    event_id: item.event_id,
    proposal_id: item.proposal_id ?? null,
    sequence: item.sequence,
    kind: item.kind,
    status: item.status,
    payload_hash: item.payload_hash,
    attempts: item.attempts,
    max_attempts: item.max_attempts,
    last_error_code: item.last_error_code ?? null,
    sent_at: item.sent_at ?? null,
    acknowledged_at: item.acknowledged_at ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function publicGovernanceEvent(item: CloudGovernanceEvent): Record<string, unknown> {
  return {
    event_id: item.event_id,
    proposal_id: item.proposal_id,
    cloud_proposal_id: item.cloud_proposal_id ?? null,
    kind: item.kind,
    state: item.state,
    authority: item.authority,
    payload: safeDomainValue(item.payload),
    integrity_hash: item.integrity_hash,
    created_at: item.created_at,
  };
}

function publicTimelineEvent(item: ProposalEvent): Record<string, unknown> {
  return {
    sequence: item.event_id,
    occurred_at: item.created_at,
    kind: item.kind,
    actor: item.actor,
    payload: safeDomainValue(item.payload),
  };
}

function lifecycleTimeline(
  events: ProposalEvent[],
  audit: Record<string, unknown>[],
  replay: ProposalReplayRecord | undefined,
  outbox: CloudOutboxItem[],
  governance: CloudGovernanceEvent[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = events.map(publicTimelineEvent);
  for (const record of audit) {
    items.push({
      sequence: `audit:${String(record.audit_id ?? "unknown")}`,
      occurred_at: stringValue(record.created_at) ?? "",
      kind: "query_audit_recorded",
      actor: "runner",
      payload: safeDomainValue({
        audit_id: record.audit_id ?? null,
        evidence_bundle_id: record.evidence_bundle_id ?? null,
        query_fingerprint: record.query_fingerprint ?? null,
        row_count: record.row_count ?? null,
      }),
    });
  }
  if (replay) {
    items.push({
      sequence: `replay:${replay.replay_id}`,
      occurred_at: replay.generated_at,
      kind: "replay_snapshot_stored",
      actor: "runner",
      payload: { replay_id: replay.replay_id, proposal_state: replay.proposal.state },
    });
  }
  for (const item of outbox) {
    items.push({
      sequence: `cloud-outbox:${item.sequence}:${item.event_id}`,
      occurred_at: item.created_at,
      kind: `cloud_outbox_${item.status}`,
      actor: "runner",
      payload: { event_id: item.event_id, outbox_kind: item.kind, status: item.status },
    });
  }
  for (const item of governance) {
    items.push({
      sequence: `cloud-governance:${item.event_id}`,
      occurred_at: item.created_at,
      kind: item.kind,
      actor: item.authority,
      payload: { event_id: item.event_id, state: item.state, cloud_proposal_id: item.cloud_proposal_id ?? null },
    });
  }
  return items.sort((left, right) => {
    const occurred = String(left.occurred_at ?? "").localeCompare(String(right.occurred_at ?? ""));
    return occurred || String(left.sequence ?? "").localeCompare(String(right.sequence ?? ""));
  });
}

function assertLifecycleLinks(
  proposal: StoredProposal,
  evidence: StoredEvidenceBundle[],
  audit: Record<string, unknown>[],
  jobs: StoredWritebackJob[],
  intents: StoredWritebackIntent[],
  receipts: StoredWritebackReceipt[],
  worker: WorkerQueueItem | undefined,
  governance: CloudGovernanceEvent[],
  replay: ProposalReplayRecord | undefined,
): void {
  const proposalId = proposal.proposal_id;
  const fail = (kind: string, id: string): never => {
    throw new LifecycleViewError("LIFECYCLE_LINK_CORRUPT", `${kind} ${id} is indexed under ${proposalId} but links to another proposal or scope`);
  };
  for (const item of evidence) {
    if (item.proposal_id !== proposalId || item.tenant_id !== proposal.tenant_id) fail("evidence", item.evidence_bundle_id);
    if (item.principal && proposal.principal && item.principal !== proposal.principal) fail("evidence", item.evidence_bundle_id);
  }
  for (const item of audit) if (stringValue(item.proposal_id) !== proposalId) fail("query audit", String(item.audit_id ?? "unknown"));
  for (const item of jobs) if (item.proposal_id !== proposalId || item.proposal_hash !== proposal.proposal_hash) fail("writeback job", item.writeback_job_id);
  for (const item of intents) if (item.proposal_id !== proposalId || item.proposal_hash !== proposal.proposal_hash) fail("writeback intent", item.intent_id);
  for (const item of receipts) if (item.proposal_id !== proposalId) fail("receipt", String(item.receipt_id));
  if (worker && worker.proposal_id !== proposalId) fail("worker queue", worker.proposal_id);
  for (const item of governance) if (item.proposal_id !== proposalId) fail("Cloud governance event", item.event_id);
  if (replay && replay.proposal.proposal_id !== proposalId) fail("replay", replay.replay_id);
}

function lifecycleApprovalSource(approvals: StoredApproval[]): "none" | "policy" | "human" | "mixed" {
  const policy = approvals.some((item) => item.approver.startsWith("policy:"));
  const human = approvals.some((item) => !item.approver.startsWith("policy:"));
  if (policy && human) return "mixed";
  if (policy) return "policy";
  if (human) return "human";
  return "none";
}

function lifecycleApprovalStatus(state: LocalProposalState, progress: ApprovalProgress): LifecycleViewV1["approval"]["status"] {
  if (state === "rejected") return "rejected";
  if (state === "canceled") return "canceled";
  if (["approved", "pending_worker", "applied", "conflict", "failed", "reconciliation_required"].includes(state)) {
    return progress.complete ? "approved" : "incomplete";
  }
  return progress.approved > 0 ? "incomplete" : "pending";
}

function policyNameFromApprovals(approvals: StoredApproval[]): string | null {
  const policy = approvals.find((item) => item.approver.startsWith("policy:"));
  return policy ? policy.approver.slice("policy:".length) : null;
}

function policyLimitTrips(events: ProposalEvent[]): unknown[] {
  return events
    .filter((event) => event.kind === "policy_auto_approval_deferred")
    .flatMap((event) => Array.isArray(event.payload.tripped_limits) ? event.payload.tripped_limits : [])
    .map((item) => safeDomainValue(item));
}

function compensationLineage(changeSet: Record<string, unknown>): unknown | null {
  const reversibility = asRecord(changeSet.reversibility);
  if (reversibility?.lineage !== undefined) return safeDomainValue(reversibility.lineage);
  const compensation = asRecord(changeSet.compensation);
  if (compensation) return safeDomainValue(compensation);
  return null;
}

function lifecycleNext(
  proposal: StoredProposal,
  intents: StoredWritebackIntent[],
  jobs: StoredWritebackJob[],
  commandName: string,
): LifecycleViewV1["next"] {
  const exact = `${commandName} lifecycle show proposal:${proposal.proposal_id} --details`;
  const reconcilable = intents.some((item) => item.status === "applying" || item.status === "reconciliation_required");
  if (reconcilable) return { read_only: exact, operator: `${commandName} writeback reconcile inspect latest --config ./synapsor.runner.json --store ./.synapsor/local.db` };
  if (proposal.state === "pending_review") return { read_only: exact, operator: `${commandName} proposals approve ${proposal.proposal_id} --config ./synapsor.runner.json --store ./.synapsor/local.db` };
  if (proposal.state === "approved" || proposal.state === "pending_worker") {
    return { read_only: exact, operator: `${commandName} apply ${proposal.proposal_id} --yes --config ./synapsor.runner.json --store ./.synapsor/local.db` };
  }
  if (proposal.state === "failed" && jobs.length > 0) return { read_only: exact, operator: `${commandName} worker dead-letter show ${proposal.proposal_id} --store ./.synapsor/local.db` };
  return { read_only: exact, operator: null };
}

function lifecycleOperation(changeSet: Record<string, unknown> | undefined): string {
  return stringValue(changeSet?.operation) ?? (changeSet?.compensation ? "compensation" : "single_row_update");
}

function queryAuditSortKey(item: Record<string, unknown>): string {
  const createdAt = stringValue(item.created_at) ?? "";
  const id = numberValue(item.audit_id) ?? 0;
  return `${createdAt}:${String(id).padStart(20, "0")}`;
}

function stableBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}

function lifecycleRead<T>(message: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof LifecycleViewError) throw error;
    throw new LifecycleViewError("LIFECYCLE_RECORD_CORRUPT", message);
  }
}

function stableFilters(filters: ProposalSearchFilters): ProposalSearchFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as ProposalSearchFilters;
}

function withoutLimit(filters: ProposalSearchFilters): ProposalSearchFilters {
  const { limit: _limit, ...rest } = filters;
  return rest;
}

function hasSelectionFilters(filters: ProposalSearchFilters): boolean {
  return Object.entries(withoutLimit(filters)).some(([, value]) => value !== undefined);
}

function safeDomainValue(value: unknown, key = ""): unknown {
  if (secretKeyPattern.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => safeDomainValue(item));
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [entryKey, safeDomainValue(entryValue, entryKey)]));
  }
  if (typeof value === "string" && secretValuePattern.test(value)) return "<redacted>";
  return value;
}

const secretKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url|read[_-]?url|write[_-]?url)($|[_-])/i;
const secretValuePattern = /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]+|syn_wbr_[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
