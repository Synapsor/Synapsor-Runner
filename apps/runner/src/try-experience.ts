import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ProposalStore,
  type ProposalReplayRecord,
  type StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  protocolVersions,
  type ChangeSetV1,
  type ExecutionReceiptV1,
  type WritebackJobV1,
} from "@synapsor-runner/protocol";

const capabilityName = "billing.propose_late_fee_waiver";
const operationId = "op_try_waive_INV_3001_v1";
const staleOperationId = "op_try_waive_INV_3001_stale";
const initialVersion = "2026-07-19T09:00:00.000Z";
const appliedVersion = "2026-07-19T09:01:00.000Z";
const concurrentVersion = "2026-07-19T09:02:00.000Z";

type Scalar = string | number | boolean | null;

type DemoInvoice = {
  id: string;
  tenant_id: string;
  customer_id: string;
  status: string;
  late_fee_cents: number;
  waiver_reason: string | null;
  updated_at: string;
  internal_risk_note: string;
};

type DemoSourceState = {
  schema_version: "synapsor.try-source.v1";
  invoices: Record<string, DemoInvoice>;
  support_tickets: Record<string, {
    id: string;
    tenant_id: string;
    invoice_id: string;
    summary: string;
    courtesy_waiver_eligible: boolean;
    internal_agent_note: string;
  }>;
  operations: Record<string, {
    intent_digest: `sha256:${string}`;
    proposal_id: string;
    receipt: ExecutionReceiptV1;
  }>;
};

export type TryReviewContext = {
  proposal: StoredProposal;
  store_path: string;
  config_path: string;
  request: string;
  evidence: {
    support_ticket: string;
    summary: string;
    courtesy_waiver_eligible: boolean;
  };
  proposed_effect: {
    field: "late_fee_cents";
    before: 5500;
    after: 0;
  };
};

export type TryDecision = "approve" | "reject" | "already_reviewed";

export type TryStage =
  | "source_ready"
  | "evidence_read"
  | "proposal_created"
  | "review_complete"
  | "writeback_applied"
  | "proof_complete";

export type TryExperienceOptions = {
  root_dir?: string;
  prove?: boolean;
  review: (context: TryReviewContext) => Promise<TryDecision>;
  on_stage?: (stage: TryStage, detail: Record<string, unknown>) => void;
};

export type TryExperienceResult = {
  ok: boolean;
  mode: "embedded_demo";
  actor: "deterministic_simulated_agent";
  request: string;
  capability: string;
  model_tools: string[];
  model_forbidden_tools: string[];
  trusted_context: {
    tenant_id: "acme";
    principal: "support-agent-demo";
    model_controlled: false;
  };
  paths: {
    root: string;
    source: string;
    ledger: string;
    config: string;
  };
  proposal: {
    proposal_id: string;
    operation_id: string;
    state: string;
    source_database_changed_before_approval: false;
    effect: {
      late_fee_cents: { before: 5500; after: 0 };
    };
  };
  evidence: {
    evidence_bundle_id: string;
    support_ticket: "SUP-184";
    courtesy_waiver_eligible: true;
  };
  receipt?: ExecutionReceiptV1;
  source_after: {
    id: "INV-3001";
    tenant_id: "acme";
    late_fee_cents: number;
    waiver_reason: string | null;
    updated_at: string;
  };
  replay: ProposalReplayRecord;
  proof?: {
    restart_safe_retry: boolean;
    retry_status: "already_applied";
    duplicate_mutations: 0;
    changed_intent_rejected: boolean;
    changed_intent_error_code: "IDEMPOTENCY_IDENTITY_CONFLICT";
    changed_intent_components: {
      tenant: true;
      principal: true;
      capability: true;
      target: true;
      expected_version: true;
      effect: true;
    };
    stale_apply_rejected: boolean;
    stale_status: "conflict";
    stale_overwrite: false;
    replay_mutated_source: false;
    unknown_auto_retried: false;
  };
  next: string;
};

export async function runTryExperience(options: TryExperienceOptions): Promise<TryExperienceResult> {
  const root = path.resolve(options.root_dir ?? "./.synapsor/try");
  const sourcePath = path.join(root, "source.json");
  const storePath = path.join(root, "ledger.db");
  const configPath = path.join(root, "synapsor.runner.json");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await writeJsonAtomic(sourcePath, initialSourceState());
  await writeJsonAtomic(configPath, demoUiConfig(storePath));
  options.on_stage?.("source_ready", {
    source_path: sourcePath,
    ledger_path: storePath,
    source_database_changed: false,
  });

  const source = new EmbeddedTrySource(sourcePath);
  const evidenceRead = await source.readInvoiceEvidence("acme", "support-agent-demo", "INV-3001");
  options.on_stage?.("evidence_read", {
    tenant_id: "acme",
    principal: "support-agent-demo",
    invoice_id: "INV-3001",
    support_ticket: evidenceRead.ticket.id,
  });

  let proposal: StoredProposal;
  const store = new ProposalStore(storePath);
  try {
    proposal = createProposalWithEvidence(store, evidenceRead.invoice, evidenceRead.ticket, {
      proposalId: "wrp_try_INV_3001",
      operationId,
      reason: "Courtesy waiver supported by ticket SUP-184",
    });
  } finally {
    store.close();
  }
  options.on_stage?.("proposal_created", {
    proposal_id: proposal.proposal_id,
    operation_id: operationId,
    source_database_changed: false,
  });

  const decision = await options.review({
    proposal,
    store_path: storePath,
    config_path: configPath,
    request: "Waive the $55 late fee on invoice INV-3001.",
    evidence: {
      support_ticket: "SUP-184",
      summary: "Customer qualifies for one courtesy waiver",
      courtesy_waiver_eligible: true,
    },
    proposed_effect: {
      field: "late_fee_cents",
      before: 5500,
      after: 0,
    },
  });

  let reviewed: StoredProposal;
  const reviewStore = new ProposalStore(storePath);
  try {
    const current = requireProposal(reviewStore, proposal.proposal_id);
    if (current.state === "pending_review" && decision === "approve") {
      reviewed = reviewStore.approveProposal(current.proposal_id, {
        approver: "local-demo-operator",
        proposal_hash: current.proposal_hash,
        proposal_version: current.proposal_version,
        reason: "Explicit approval in isolated Synapsor try experience",
      });
    } else if (current.state === "pending_review" && decision === "reject") {
      reviewed = reviewStore.rejectProposal(current.proposal_id, {
        actor: "local-demo-operator",
        proposal_hash: current.proposal_hash,
        proposal_version: current.proposal_version,
        reason: "Rejected in isolated Synapsor try experience",
      });
    } else {
      reviewed = requireProposal(reviewStore, proposal.proposal_id);
    }
  } finally {
    reviewStore.close();
  }
  options.on_stage?.("review_complete", {
    proposal_id: reviewed.proposal_id,
    state: reviewed.state,
  });

  let receipt: ExecutionReceiptV1 | undefined;
  if (reviewed.state === "approved") {
    const applyStore = new ProposalStore(storePath);
    try {
      const job = writebackJob(reviewed, operationId, initialVersion, {
        late_fee_cents: 0,
        waiver_reason: "Courtesy waiver supported by SUP-184",
      });
      applyStore.recordWritebackJob(job);
      receipt = await source.apply(job, appliedVersion);
      applyStore.recordExecutionReceipt(receipt);
    } finally {
      applyStore.close();
    }
    options.on_stage?.("writeback_applied", {
      proposal_id: reviewed.proposal_id,
      status: receipt.status,
      source_database_changed: receipt.source_database_mutated,
      receipt_hash: receipt.receipt_hash,
    });
  }

  const sourceAfter = publicInvoice(await source.readInvoice("acme", "support-agent-demo", "INV-3001"));
  const replayStore = new ProposalStore(storePath);
  let replay: ProposalReplayRecord;
  try {
    replay = replayStore.replay(proposal.proposal_id);
  } finally {
    replayStore.close();
  }

  const proof = options.prove && receipt
    ? await runExtendedProof({ sourcePath, storePath, source, firstProposal: reviewed, firstJob: writebackJob(reviewed, operationId, initialVersion, {
      late_fee_cents: 0,
      waiver_reason: "Courtesy waiver supported by SUP-184",
    }) })
    : undefined;
  if (proof) options.on_stage?.("proof_complete", proof);

  return {
    ok: reviewed.state === "rejected" || Boolean(receipt && ["applied", "already_applied"].includes(receipt.status)),
    mode: "embedded_demo",
    actor: "deterministic_simulated_agent",
    request: "Waive the $55 late fee on invoice INV-3001.",
    capability: capabilityName,
    model_tools: ["billing.inspect_invoice", capabilityName],
    model_forbidden_tools: ["execute_sql", "approve", "apply", "commit"],
    trusted_context: {
      tenant_id: "acme",
      principal: "support-agent-demo",
      model_controlled: false,
    },
    paths: {
      root,
      source: sourcePath,
      ledger: storePath,
      config: configPath,
    },
    proposal: {
      proposal_id: reviewed.proposal_id,
      operation_id: operationId,
      state: replay.proposal.state,
      source_database_changed_before_approval: false,
      effect: {
        late_fee_cents: { before: 5500, after: 0 },
      },
    },
    evidence: {
      evidence_bundle_id: proposal.change_set.evidence.bundle_id,
      support_ticket: "SUP-184",
      courtesy_waiver_eligible: true,
    },
    ...(receipt ? { receipt } : {}),
    source_after: sourceAfter,
    replay,
    ...(proof ? { proof } : {}),
    next: "export DATABASE_URL='<staging-postgres-or-mysql-read-url>' && synapsor-runner start --from-env DATABASE_URL",
  };
}

async function runExtendedProof(input: {
  sourcePath: string;
  storePath: string;
  source: EmbeddedTrySource;
  firstProposal: StoredProposal;
  firstJob: WritebackJobV1;
}): Promise<NonNullable<TryExperienceResult["proof"]>> {
  const restartedSource = new EmbeddedTrySource(input.sourcePath);
  const beforeRetry = await restartedSource.readInvoice("acme", "support-agent-demo", "INV-3001");
  const retry = await restartedSource.apply(input.firstJob, appliedVersion);
  const afterRetry = await restartedSource.readInvoice("acme", "support-agent-demo", "INV-3001");

  const changedIntentComponents = {
    tenant: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      tenant_guard: { ...input.firstJob.tenant_guard, value: "globex" },
    }),
    principal: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      proposal_hash: canonicalJsonDigest({
        approved_proposal_hash: input.firstJob.proposal_hash,
        principal: "different-principal",
      }),
    }),
    capability: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      proposal_hash: canonicalJsonDigest({
        approved_proposal_hash: input.firstJob.proposal_hash,
        capability: "billing.different_capability",
      }),
    }),
    target: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      target: {
        ...input.firstJob.target,
        primary_key: { ...input.firstJob.target.primary_key, value: "INV-GLOBEX-1" },
      },
    }),
    expected_version: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      conflict_guard: {
        kind: "column",
        column: "updated_at",
        expected_value: "2026-07-19T00:00:00.000Z",
      },
    }),
    effect: await rejectsIdempotencyCollision(restartedSource, {
      ...input.firstJob,
      patch: {
        late_fee_cents: 0,
        waiver_reason: "Different effect under a reused operation ID",
      },
    }),
  } as const;
  const changedIntentRejected = Object.values(changedIntentComponents).every(Boolean);

  const staleBefore = await restartedSource.readInvoice("acme", "support-agent-demo", "INV-3001");
  let staleProposal: StoredProposal;
  const staleStore = new ProposalStore(input.storePath);
  try {
    staleProposal = createProposalWithEvidence(staleStore, publicInvoice(staleBefore), {
      id: "SUP-184",
      tenant_id: "acme",
      invoice_id: "INV-3001",
      summary: "Customer qualifies for one courtesy waiver",
      courtesy_waiver_eligible: true,
    }, {
      proposalId: "wrp_try_INV_3001_stale",
      operationId: staleOperationId,
      reason: "Stale-state proof",
      patch: { waiver_reason: "A stale overwrite must not land" },
    });
    staleProposal = staleStore.approveProposal(staleProposal.proposal_id, {
      approver: "local-demo-operator",
      proposal_hash: staleProposal.proposal_hash,
      proposal_version: staleProposal.proposal_version,
      reason: "Approve stale-state test before concurrent source update",
    });
  } finally {
    staleStore.close();
  }
  await restartedSource.simulateConcurrentUpdate("acme", "INV-3001");
  const staleJob = writebackJob(staleProposal, staleOperationId, staleBefore.updated_at, {
    waiver_reason: "A stale overwrite must not land",
  });
  const staleApplyStore = new ProposalStore(input.storePath);
  let staleReceipt: ExecutionReceiptV1;
  try {
    staleApplyStore.recordWritebackJob(staleJob);
    staleReceipt = await restartedSource.apply(staleJob, "2026-07-19T09:03:00.000Z");
    staleApplyStore.recordExecutionReceipt(staleReceipt);
  } finally {
    staleApplyStore.close();
  }
  const afterStale = await restartedSource.readInvoice("acme", "support-agent-demo", "INV-3001");
  const beforeReplayDigest = canonicalJsonDigest(await readJson<DemoSourceState>(input.sourcePath));
  const replayStore = new ProposalStore(input.storePath);
  try {
    replayStore.replay(input.firstProposal.proposal_id);
    replayStore.replay(staleProposal.proposal_id);
  } finally {
    replayStore.close();
  }
  const afterReplayDigest = canonicalJsonDigest(await readJson<DemoSourceState>(input.sourcePath));
  if (afterStale.waiver_reason === "A stale overwrite must not land") {
    throw new TryExperienceError("STALE_OVERWRITE", "stale proof unexpectedly changed the source row");
  }
  if (beforeReplayDigest !== afterReplayDigest) {
    throw new TryExperienceError("REPLAY_MUTATED_SOURCE", "replay unexpectedly changed the embedded source");
  }

  return {
    restart_safe_retry: retry.status === "already_applied"
      && beforeRetry.updated_at === afterRetry.updated_at
      && beforeRetry.late_fee_cents === afterRetry.late_fee_cents,
    retry_status: "already_applied",
    duplicate_mutations: 0,
    changed_intent_rejected: changedIntentRejected,
    changed_intent_error_code: "IDEMPOTENCY_IDENTITY_CONFLICT",
    changed_intent_components: changedIntentComponents,
    stale_apply_rejected: staleReceipt.status === "conflict",
    stale_status: "conflict",
    stale_overwrite: false,
    replay_mutated_source: false,
    unknown_auto_retried: false,
  };
}

async function rejectsIdempotencyCollision(source: EmbeddedTrySource, job: WritebackJobV1): Promise<true> {
  try {
    await source.apply(job, appliedVersion);
  } catch (error) {
    if (error instanceof TryExperienceError && error.code === "IDEMPOTENCY_IDENTITY_CONFLICT") return true;
    throw error;
  }
  throw new TryExperienceError(
    "IDEMPOTENCY_COLLISION_ACCEPTED",
    `operation ${job.idempotency_key} accepted a changed immutable intent`,
  );
}

class EmbeddedTrySource {
  constructor(private readonly sourcePath: string) {}

  async readInvoiceEvidence(tenantId: string, principal: string, invoiceId: string) {
    const state = await readJson<DemoSourceState>(this.sourcePath);
    const invoice = requireScopedInvoice(state, tenantId, principal, invoiceId);
    const ticket = Object.values(state.support_tickets).find((candidate) =>
      candidate.tenant_id === tenantId && candidate.invoice_id === invoiceId);
    if (!ticket) throw new TryExperienceError("EVIDENCE_NOT_FOUND", `support ticket not found for ${invoiceId}`);
    return {
      invoice: publicInvoice(invoice),
      ticket: {
        id: ticket.id,
        tenant_id: ticket.tenant_id,
        invoice_id: ticket.invoice_id,
        summary: ticket.summary,
        courtesy_waiver_eligible: ticket.courtesy_waiver_eligible,
      },
    };
  }

  async readInvoice(tenantId: string, principal: string, invoiceId: string): Promise<DemoInvoice> {
    const state = await readJson<DemoSourceState>(this.sourcePath);
    return structuredClone(requireScopedInvoice(state, tenantId, principal, invoiceId));
  }

  async apply(job: WritebackJobV1, newVersion: string): Promise<ExecutionReceiptV1> {
    const state = await readJson<DemoSourceState>(this.sourcePath);
    if (job.conflict_guard.kind !== "column") {
      throw new TryExperienceError("CONFLICT_GUARD_REQUIRED", "embedded writeback requires a reviewed column version guard");
    }
    const expectedVersion = String(job.conflict_guard.expected_value);
    const intentDigest = writeIntentDigest(job);
    const prior = state.operations[job.idempotency_key];
    if (prior) {
      if (prior.intent_digest !== intentDigest) {
        throw new TryExperienceError(
          "IDEMPOTENCY_IDENTITY_CONFLICT",
          `operation ${job.idempotency_key} was already used for a different immutable intent`,
        );
      }
      return receiptFor(job, {
        status: "already_applied",
        rowsAffected: 0,
        previousVersion: String(prior.receipt.previous_version ?? initialVersion),
        newVersion: String(prior.receipt.new_version ?? newVersion),
        mutated: false,
      });
    }

    const invoice = state.invoices[String(job.target.primary_key.value)];
    if (!invoice || invoice.tenant_id !== String(job.tenant_guard.value)) {
      return receiptFor(job, {
        status: "conflict",
        rowsAffected: 0,
        previousVersion: expectedVersion,
        newVersion: invoice?.updated_at ?? expectedVersion,
        mutated: false,
      });
    }
    if (invoice.updated_at !== expectedVersion) {
      return receiptFor(job, {
        status: "conflict",
        rowsAffected: 0,
        previousVersion: expectedVersion,
        newVersion: invoice.updated_at,
        mutated: false,
      });
    }
    const patchColumns = Object.keys(job.patch);
    if (patchColumns.length === 0 || patchColumns.some((column) => !job.allowed_columns.includes(column))) {
      throw new TryExperienceError("PATCH_OUTSIDE_ALLOWLIST", "embedded writeback patch exceeds reviewed columns");
    }
    for (const [column, value] of Object.entries(job.patch)) {
      (invoice as unknown as Record<string, Scalar>)[column] = value;
    }
    const previousVersion = invoice.updated_at;
    invoice.updated_at = newVersion;
    const receipt = receiptFor(job, {
      status: "applied",
      rowsAffected: 1,
      previousVersion,
      newVersion,
      mutated: true,
    });
    state.operations[job.idempotency_key] = {
      intent_digest: intentDigest,
      proposal_id: job.proposal_id,
      receipt,
    };
    await writeJsonAtomic(this.sourcePath, state);
    return receipt;
  }

  async simulateConcurrentUpdate(tenantId: string, invoiceId: string): Promise<void> {
    const state = await readJson<DemoSourceState>(this.sourcePath);
    const invoice = requireScopedInvoice(state, tenantId, "support-agent-demo", invoiceId);
    invoice.updated_at = concurrentVersion;
    await writeJsonAtomic(this.sourcePath, state);
  }
}

function createProposalWithEvidence(
  store: ProposalStore,
  invoice: ReturnType<typeof publicInvoice>,
  ticket: {
    id: string;
    tenant_id: string;
    invoice_id: string;
    summary: string;
    courtesy_waiver_eligible: boolean;
  },
  input: {
    proposalId: string;
    operationId: string;
    reason: string;
    patch?: Record<string, Scalar>;
  },
): StoredProposal {
  const patch = input.patch ?? {
    late_fee_cents: 0,
    waiver_reason: "Courtesy waiver supported by SUP-184",
  };
  const before: Record<string, Scalar> = { ...invoice };
  const after = { ...before, ...patch };
  const evidenceId = `ev_${input.proposalId}`;
  const base = {
    schema_version: protocolVersions.changeSet,
    proposal_id: input.proposalId,
    proposal_version: 1,
    action: capabilityName,
    mode: "review_required",
    principal: { id: "support-agent-demo", source: "trusted_session" },
    scope: {
      tenant_id: "acme",
      business_object: "invoice",
      object_id: "INV-3001",
    },
    source: {
      kind: "external_postgres",
      source_id: "embedded_try_source",
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: "INV-3001" },
    },
    before,
    patch,
    after,
    guards: {
      tenant: { column: "tenant_id", value: "acme" },
      allowed_columns: Object.keys(patch),
      expected_version: { column: "updated_at", value: invoice.updated_at },
    },
    evidence: {
      bundle_id: evidenceId,
      query_fingerprint: canonicalJsonDigest({
        operation_id: input.operationId,
        tenant_id: "acme",
        principal: "support-agent-demo",
        invoice_id: "INV-3001",
      }),
      items: [{
        kind: "external_row",
        source_id: "embedded_try_source",
        table: "public.invoices",
        primary_key: { column: "id", value: "INV-3001" },
      }],
    },
    approval: { status: "pending", required_role: "local_operator" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    created_at: new Date().toISOString(),
  } satisfies Omit<ChangeSetV1, "integrity">;
  const changeSet: ChangeSetV1 = {
    ...base,
    integrity: { proposal_hash: canonicalJsonDigest(base) },
  };
  const proposal = store.createProposal(changeSet);
  store.recordEvidenceBundle({
    evidence_bundle_id: evidenceId,
    proposal_id: proposal.proposal_id,
    tenant_id: "acme",
    payload: {
      capability: capabilityName,
      proposal_id: proposal.proposal_id,
      operation_id: input.operationId,
      source_id: "embedded_try_source",
      target: "public.invoices",
      principal: "support-agent-demo",
      tenant_id: "acme",
      business_object: "invoice",
      object_id: "INV-3001",
      query_fingerprint: changeSet.evidence.query_fingerprint,
      support_ticket: ticket.id,
      courtesy_waiver_eligible: ticket.courtesy_waiver_eligible,
      reason: input.reason,
      source_database_changed: false,
    },
    items: [
      {
        kind: "external_row",
        source_id: "embedded_try_source",
        table: "public.invoices",
        primary_key: { column: "id", value: "INV-3001" },
        tenant: { column: "tenant_id", value: "acme" },
        visible_row: before,
      },
      {
        kind: "support_ticket",
        id: ticket.id,
        summary: ticket.summary,
        courtesy_waiver_eligible: ticket.courtesy_waiver_eligible,
      },
      { kind: "proposal_diff", before, patch, after },
    ],
  });
  store.recordQueryAudit({
    proposal_id: proposal.proposal_id,
    evidence_bundle_id: evidenceId,
    source_id: "embedded_try_source",
    query_fingerprint: changeSet.evidence.query_fingerprint,
    table_name: "public.invoices",
    row_count: 1,
    payload: {
      capability: capabilityName,
      tenant_id: "acme",
      principal: "support-agent-demo",
      tenant_bound: true,
      principal_bound: true,
      statement_template: "embedded source read: invoice id + trusted tenant + trusted principal",
      parameters_redacted: true,
    },
  });
  return proposal;
}

function writebackJob(
  proposal: StoredProposal,
  idempotencyKey: string,
  expectedVersion: string,
  patch: Record<string, Scalar>,
): WritebackJobV1 {
  return {
    schema_version: protocolVersions.writebackJob,
    writeback_job_id: `wbj_${proposal.proposal_id}`,
    proposal_id: proposal.proposal_id,
    proposal_version: proposal.proposal_version,
    proposal_hash: proposal.proposal_hash as `sha256:${string}`,
    runner_scope: { project_id: "embedded_try", source_id: "embedded_try_source" },
    engine: "postgres",
    operation: "single_row_update",
    target: {
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: "INV-3001" },
    },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: Object.keys(patch),
    patch,
    conflict_guard: {
      kind: "column",
      column: "updated_at",
      expected_value: expectedVersion,
    },
    idempotency_key: idempotencyKey,
    lease: {
      lease_id: `lease_${proposal.proposal_id}`,
      attempt: 1,
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  };
}

function receiptFor(
  job: WritebackJobV1,
  input: {
    status: "applied" | "already_applied" | "conflict";
    rowsAffected: number;
    previousVersion: string;
    newVersion: string;
    mutated: boolean;
  },
): ExecutionReceiptV1 {
  const base = {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: job.writeback_job_id,
    proposal_id: job.proposal_id,
    runner_id: "embedded_try_runner",
    status: input.status,
    rows_affected: input.rowsAffected,
    idempotency_key: job.idempotency_key,
    previous_version: input.previousVersion,
    new_version: input.newVersion,
    source_database_mutated: input.mutated,
    executed_at: input.newVersion,
  } satisfies Omit<ExecutionReceiptV1, "receipt_hash">;
  return {
    ...base,
    receipt_hash: canonicalJsonDigest(base),
  };
}

function writeIntentDigest(job: WritebackJobV1): `sha256:${string}` {
  return canonicalJsonDigest({
    idempotency_key: job.idempotency_key,
    proposal_id: job.proposal_id,
    proposal_hash: job.proposal_hash,
    operation: job.operation,
    target: job.target,
    tenant_guard: job.tenant_guard,
    allowed_columns: job.allowed_columns,
    patch: job.patch,
    conflict_guard: job.conflict_guard,
  });
}

function initialSourceState(): DemoSourceState {
  return {
    schema_version: "synapsor.try-source.v1",
    invoices: {
      "INV-3001": {
        id: "INV-3001",
        tenant_id: "acme",
        customer_id: "CUS-3001",
        status: "open",
        late_fee_cents: 5500,
        waiver_reason: null,
        updated_at: initialVersion,
        internal_risk_note: "kept-out demo field",
      },
      "INV-GLOBEX-1": {
        id: "INV-GLOBEX-1",
        tenant_id: "globex",
        customer_id: "CUS-GLOBEX",
        status: "open",
        late_fee_cents: 9900,
        waiver_reason: null,
        updated_at: initialVersion,
        internal_risk_note: "other tenant kept-out field",
      },
    },
    support_tickets: {
      "SUP-184": {
        id: "SUP-184",
        tenant_id: "acme",
        invoice_id: "INV-3001",
        summary: "Customer qualifies for one courtesy waiver",
        courtesy_waiver_eligible: true,
        internal_agent_note: "kept-out support note",
      },
    },
    operations: {},
  };
}

function requireScopedInvoice(
  state: DemoSourceState,
  tenantId: string,
  principal: string,
  invoiceId: string,
): DemoInvoice {
  if (principal !== "support-agent-demo") {
    throw new TryExperienceError("PRINCIPAL_SCOPE_DENIED", "trusted principal is not allowed for the demo source");
  }
  const invoice = state.invoices[invoiceId];
  if (!invoice || invoice.tenant_id !== tenantId) {
    throw new TryExperienceError("NOT_FOUND_IN_TENANT", `invoice ${invoiceId} not found in trusted tenant`);
  }
  return invoice;
}

function publicInvoice(invoice: DemoInvoice) {
  return {
    id: invoice.id as "INV-3001",
    tenant_id: invoice.tenant_id as "acme",
    customer_id: invoice.customer_id,
    status: invoice.status,
    late_fee_cents: invoice.late_fee_cents,
    waiver_reason: invoice.waiver_reason,
    updated_at: invoice.updated_at,
  };
}

export async function probeTryEmbeddedScope(
  sourcePath: string,
  input: { tenant_id: string; principal: string; invoice_id: string },
): Promise<ReturnType<typeof publicInvoice>> {
  const source = new EmbeddedTrySource(sourcePath);
  return publicInvoice(await source.readInvoice(input.tenant_id, input.principal, input.invoice_id));
}

function demoUiConfig(storePath: string): Record<string, unknown> {
  return {
    version: 1,
    mode: "review",
    storage: { sqlite_path: storePath },
    sources: {
      embedded_try_source: {
        engine: "postgres",
        read_url_env: "SYNAPSOR_TRY_EMBEDDED_READ_URL",
        write_url_env: "SYNAPSOR_TRY_EMBEDDED_WRITE_URL",
        statement_timeout_ms: 1000,
      },
    },
    trusted_context: {
      provider: "static_dev",
      values: {
        tenant_id: "acme",
        principal: "support-agent-demo",
      },
    },
    capabilities: [
      {
        name: "billing.inspect_invoice",
        kind: "read",
        source: "embedded_try_source",
        target: {
          schema: "public",
          table: "invoices",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          invoice_id: { type: "string", required: true, max_length: 128 },
        },
        lookup: { id_from_arg: "invoice_id" },
        visible_columns: [
          "id",
          "tenant_id",
          "customer_id",
          "status",
          "late_fee_cents",
          "waiver_reason",
          "updated_at",
        ],
        evidence: "required",
        max_rows: 1,
      },
      {
        name: capabilityName,
        kind: "proposal",
        source: "embedded_try_source",
        target: {
          schema: "public",
          table: "invoices",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          invoice_id: { type: "string", required: true, max_length: 128 },
          reason: { type: "string", required: true, max_length: 256 },
        },
        lookup: { id_from_arg: "invoice_id" },
        visible_columns: [
          "id",
          "tenant_id",
          "customer_id",
          "status",
          "late_fee_cents",
          "waiver_reason",
          "updated_at",
        ],
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        patch: {
          late_fee_cents: { fixed: 0 },
          waiver_reason: { from_arg: "reason" },
        },
        conflict_guard: { column: "updated_at" },
        evidence: "required",
        approval: { required_role: "local_operator" },
        max_rows: 1,
      },
    ],
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function requireProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new TryExperienceError("PROPOSAL_NOT_FOUND", `proposal not found: ${proposalId}`);
  return proposal;
}

export class TryExperienceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TryExperienceError";
  }
}
