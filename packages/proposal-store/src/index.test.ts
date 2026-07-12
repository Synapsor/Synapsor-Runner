import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PostgresProposalRuntimeStore,
  ProposalStore,
  ProposalStoreError,
  sharedPostgresRuntimeStoreMigration,
  type PostgresRuntimeClient,
  type PostgresRuntimePool,
  type PostgresRuntimeQueryResult,
} from "./index.js";

const changeSet = {
  schema_version: "synapsor.change-set.v1",
  proposal_id: "wrp_123",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-3001" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-3001" }
  },
  before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-06-20T14:31:08Z" },
  patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
  after: { late_fee_cents: 0, waiver_reason: "customer requested review", updated_at: "2026-06-20T14:31:08Z" },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    expected_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" }
  },
  evidence: { bundle_id: "ev_456", query_fingerprint: "sha256:evidence", items: [] },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: "sha256:proposal" },
  created_at: "2026-06-20T14:31:09Z"
};

const appliedReceipt = {
  schema_version: "synapsor.execution-receipt.v1",
  writeback_job_id: "wbj_123",
  proposal_id: "wrp_123",
  runner_id: "runner_123",
  status: "applied",
  rows_affected: 1,
  idempotency_key: "wrp_123:INV-3001",
  previous_version: "2026-06-20T14:31:08Z",
  new_version: "2026-06-20T14:34:19Z",
  source_database_mutated: true,
  executed_at: "2026-06-20T14:34:19Z",
  receipt_hash: "sha256:receipt"
};

const writebackJob = {
  schema_version: "synapsor.writeback-job.v1",
  writeback_job_id: "wbj_123",
  proposal_id: "wrp_123",
  proposal_version: 1,
  proposal_hash: "sha256:proposal",
  runner_scope: { project_id: "acme-support", source_id: "src_pg_acme" },
  engine: "postgres",
  operation: "single_row_update",
  target: {
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-3001" }
  },
  tenant_guard: { column: "tenant_id", value: "acme" },
  allowed_columns: ["late_fee_cents", "waiver_reason"],
  patch: { late_fee_cents: 0, waiver_reason: "approved support waiver" },
  conflict_guard: { kind: "column", column: "updated_at", expected_value: "2026-06-20T14:31:08Z" },
  idempotency_key: "wrp_123:INV-3001",
  lease: { lease_id: "lease_123", attempt: 1, expires_at: "2026-06-20T14:36:00Z" }
};

function shadowChangeSet() {
  return {
    ...structuredClone(changeSet),
    proposal_id: "wrp_shadow",
    mode: "shadow",
    integrity: { proposal_hash: "sha256:shadow" },
  };
}

describe("proposal store", () => {
  it("creates the parent directory for file-backed stores", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-parent-"));
    const storePath = path.join(tempDir, ".synapsor", "nested", "local.db");
    const store = new ProposalStore(storePath);
    try {
      expect(await fs.stat(storePath)).toBeTruthy();
      if (process.platform !== "win32") {
        expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tightens an existing POSIX store to owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-mode-"));
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(storePath, "");
    await fs.chmod(storePath, 0o644);
    const store = new ProposalStore(storePath);
    try {
      expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks active duplicates but permits a successor after conflict", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      const duplicate = structuredClone(changeSet);
      duplicate.proposal_id = "wrp_duplicate";
      duplicate.integrity.proposal_hash = "sha256:duplicate";
      expect(() => store.createProposal(duplicate)).toThrowError(expect.objectContaining({
        code: "PROPOSAL_ALREADY_EXISTS",
      }));

      store.db.prepare("UPDATE proposals SET state = 'conflict' WHERE proposal_id = ?").run("wrp_123");
      const successor = structuredClone(changeSet);
      successor.proposal_id = "wrp_successor";
      successor.integrity.proposal_hash = "sha256:successor";
      successor.created_at = "2026-06-20T14:32:09Z";
      expect(store.createProposal(successor).proposal_id).toBe("wrp_successor");
      expect(store.getProposal("wrp_123")?.state).toBe("conflict");
      expect(store.findActiveProposal({
        tenant_id: "acme",
        action: "billing.waive_late_fee",
        business_object: "invoice",
        object_id: "INV-3001",
      })?.proposal_id).toBe("wrp_successor");
    } finally {
      store.close();
    }
  });

  it("exports a stable shared-ledger snapshot without raw JSON strings", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_shared",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { rows: 1 },
        items: [{ type: "row", id: "INV-3001" }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_shared",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:query",
        table_name: "public.invoices",
        row_count: 1,
        payload: { redacted_params: ["tenant_id", "id"] },
      });

      const entries = store.sharedLedgerEntries();
      const proposal = entries.find((entry) => entry.entry_key === "proposals:wrp_123");
      const evidence = entries.find((entry) => entry.entry_key === "evidence_bundles:ev_shared");
      const audit = entries.find((entry) => entry.kind === "query_audit");

      expect(proposal).toMatchObject({
        kind: "proposal",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
      });
      expect(proposal?.payload.change_set).toMatchObject({ proposal_id: "wrp_123" });
      expect(evidence?.payload.payload).toEqual({ rows: 1 });
      expect(audit?.payload.payload).toEqual({ redacted_params: ["tenant_id", "id"] });

      const restored = new ProposalStore();
      try {
        expect(restored.importSharedLedgerEntries(entries)).toMatchObject({ imported: entries.length, skipped: 0 });
        expect(restored.getProposal("wrp_123")?.proposal_hash).toBe("sha256:proposal");
        expect(restored.getEvidenceBundle("ev_shared")?.payload).toEqual({ rows: 1 });
        expect(restored.listQueryAudit({ evidence: "ev_shared" })[0]?.payload).toEqual({ redacted_params: ["tenant_id", "id"] });
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });

  it("prints a safe shared Postgres runtime-store migration", () => {
    expect(sharedPostgresRuntimeStoreMigration("synapsor_runner")).toContain("\"synapsor_runner\".ledger_entries");
    expect(sharedPostgresRuntimeStoreMigration("tenant_runtime")).toContain("\"tenant_runtime\".worker_leases");
    expect(() => sharedPostgresRuntimeStoreMigration("bad-schema")).toThrowError(expect.objectContaining({
      code: "INVALID_POSTGRES_IDENTIFIER",
    }));
  });

  it("persists runtime proposal state through a shared Postgres ledger store", async () => {
    const pool = new FakePostgresRuntimePool();
    const first = new PostgresProposalRuntimeStore({
      pool,
      autoMigrate: true,
      lockTimeoutMs: 0,
    });
    const proposal = await first.createProposal(changeSet);
    expect(proposal).toMatchObject({
      proposal_id: "wrp_123",
      state: "pending_review",
      tenant_id: "acme",
      capability: "billing.waive_late_fee",
    });

    await first.recordEvidenceBundle({
      evidence_bundle_id: "ev_pg_runtime",
      proposal_id: "wrp_123",
      tenant_id: "acme",
      capability: "billing.waive_late_fee",
      payload: { capability: "billing.waive_late_fee", source_database_changed: false },
      items: [{ kind: "external_row", visible_row: { id: "INV-3001", late_fee_cents: 5500 } }],
    });
    await first.recordQueryAudit({
      proposal_id: "wrp_123",
      evidence_bundle_id: "ev_pg_runtime",
      source_id: "src_pg_acme",
      query_fingerprint: "sha256:pg-runtime",
      table_name: "public.invoices",
      row_count: 1,
      payload: { statement_template: "SELECT id FROM public.invoices WHERE id = $1 AND tenant_id = $2" },
    });

    const second = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    expect(await second.getProposal("wrp_123")).toMatchObject({
      proposal_id: "wrp_123",
      state: "pending_review",
    });
    expect(await second.getEvidenceBundle("ev_pg_runtime")).toMatchObject({
      evidence_bundle_id: "ev_pg_runtime",
      proposal_id: "wrp_123",
      tenant_id: "acme",
    });

    const decision = await second.approveProposalByPolicy("wrp_123", {
      policy: "billing_small_auto",
      proposal_hash: "sha256:proposal",
      proposal_version: 1,
      reason: "within aggregate policy",
    });
    expect(decision).toMatchObject({
      approved: true,
      policy: "billing_small_auto",
      proposal: { proposal_id: "wrp_123", state: "approved" },
    });

    const third = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0, closePool: true });
    expect(await third.getProposal("wrp_123")).toMatchObject({
      proposal_id: "wrp_123",
      state: "approved",
    });
    expect(await third.events("wrp_123")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "proposal_created" }),
      expect.objectContaining({ kind: "evidence_recorded" }),
      expect.objectContaining({ kind: "proposal_approved", actor: "policy:billing_small_auto" }),
    ]));
    const replay = await third.replay("wrp_123");
    expect(replay.proposal.state).toBe("approved");
    expect(replay.query_audit).toHaveLength(1);
    await third.close();
    expect(pool.ended).toBe(true);
  });

  it("enforces aggregate policy limits atomically and records human-review fallback", () => {
    const store = new ProposalStore();
    const limits = [
      { kind: "count" as const, max: 2, period: "day" as const, scope: "tenant_policy" as const },
      { kind: "total" as const, field: "credit_cents", max: 5000, period: "day" as const, scope: "tenant_policy" as const },
    ];
    const create = (id: string, objectId: string, credit: number) => {
      const proposal = structuredClone(changeSet) as any;
      proposal.proposal_id = id;
      proposal.scope.object_id = objectId;
      proposal.source.primary_key.value = objectId;
      proposal.patch = { credit_cents: credit };
      proposal.after = { ...proposal.before, credit_cents: credit };
      proposal.guards.allowed_columns = ["credit_cents"];
      proposal.integrity.proposal_hash = `sha256:${id}`;
      store.createProposal(proposal);
      return proposal;
    };
    try {
      const first = create("wrp_limit_1", "INV-LIMIT-1", 2000);
      const second = create("wrp_limit_2", "INV-LIMIT-2", 2500);
      const third = create("wrp_limit_3", "INV-LIMIT-3", 1000);
      expect(store.approveProposalByPolicy(first.proposal_id, {
        policy: "small_credit",
        proposal_hash: first.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T01:00:00.000Z",
      }).approved).toBe(true);
      expect(store.approveProposalByPolicy(second.proposal_id, {
        policy: "small_credit",
        proposal_hash: second.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T02:00:00.000Z",
      }).approved).toBe(true);

      const deferred = store.approveProposalByPolicy(third.proposal_id, {
        policy: "small_credit",
        proposal_hash: third.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T03:00:00.000Z",
      });

      expect(deferred.approved).toBe(false);
      expect(deferred.proposal.state).toBe("pending_review");
      expect(deferred.tripped_limits.map((limit) => limit.kind)).toEqual(["count", "total"]);
      expect(deferred.tripped_limits[0]).toMatchObject({ observed: 2, proposed: 1, projected: 3 });
      expect(deferred.tripped_limits[1]).toMatchObject({ observed: 4500, proposed: 1000, projected: 5500 });
      expect(store.events(third.proposal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "policy_auto_approval_deferred",
          actor: "policy:small_credit",
          payload: expect.objectContaining({ fallback: "human_review" }),
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("persists immutable proposals and append-only events", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(changeSet);
      expect(proposal.state).toBe("pending_review");
      expect(proposal.source_database_mutated).toBe(false);
      expect(store.createProposal(changeSet).proposal_hash).toBe("sha256:proposal");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual(["proposal_created"]);
    } finally {
      store.close();
    }
  });

  it("derives tenant and capability operational counters from durable records", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      const job = store.createWritebackJobFromProposal("wrp_123");
      store.recordExecutionReceipt({
        ...appliedReceipt,
        writeback_job_id: job.writeback_job_id,
        idempotency_key: job.idempotency_key,
      });

      expect(store.operationalMetrics()).toEqual([{
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        proposals: 1,
        approvals: 1,
        rejections: 0,
        applies: 1,
        conflicts: 0,
        failures: 0,
      }]);
      expect(store.operationalMetrics({ tenant: "other" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("leases supervised worker items and dead-letters after the retry budget", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      expect(store.enqueueApprovedForWorker({ maxAttempts: 2, now: "2026-07-12T00:00:00.000Z" })).toEqual([
        expect.objectContaining({ proposal_id: "wrp_123", status: "queued", attempts: 0, max_attempts: 2 }),
      ]);

      const first = store.claimWorkerItem({ workerId: "worker_a", leaseSeconds: 30, now: "2026-07-12T00:00:01.000Z" });
      expect(first).toMatchObject({ status: "leased", attempts: 1, lease_owner: "worker_a" });
      expect(() => store.completeWorkerItem("wrp_123", "worker_b", "applied")).toThrow(/does not hold the lease/);
      expect(store.retryWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_a",
        errorCode: "HANDLER_TIMEOUT",
        retryAt: "2026-07-12T00:00:02.000Z",
        now: "2026-07-12T00:00:01.500Z",
      })).toMatchObject({ status: "retry_wait", attempts: 1 });

      const second = store.claimWorkerItem({ workerId: "worker_b", leaseSeconds: 30, now: "2026-07-12T00:00:02.000Z" });
      expect(second).toMatchObject({ status: "leased", attempts: 2, lease_owner: "worker_b" });
      expect(store.retryWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_b",
        errorCode: "HANDLER_TIMEOUT",
        retryAt: "2026-07-12T00:00:04.000Z",
        now: "2026-07-12T00:00:02.500Z",
      })).toMatchObject({ status: "dead_letter", attempts: 2, last_error_code: "HANDLER_TIMEOUT" });
      expect(store.claimWorkerItem({ workerId: "worker_c", now: "2026-07-12T00:01:00.000Z" })).toBeUndefined();
      expect(store.events("wrp_123")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "writeback_retry_scheduled" }),
        expect.objectContaining({ kind: "writeback_dead_lettered" }),
      ]));
    } finally {
      store.close();
    }
  });

  it("rejects duplicate proposal ids with a different hash", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      const modified = structuredClone(changeSet);
      modified.integrity.proposal_hash = "sha256:different";
      expect(() => store.createProposal(modified)).toThrowError(ProposalStoreError);
    } finally {
      store.close();
    }
  });

  it("rejects obvious secret material before it reaches local replay storage", () => {
    const store = new ProposalStore();
    try {
      const secretProposal = structuredClone(changeSet) as typeof changeSet & { before: Record<string, unknown> };
      secretProposal.before = {
        ...secretProposal.before,
        database_url: "postgresql://reader:reader_secret@localhost:5432/app",
      };
      expectSecretRejection(() => store.createProposal(secretProposal));

      store.createProposal(changeSet);
      expectSecretRejection(() => store.recordEvidenceBundle({
        evidence_bundle_id: "ev_secret",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { bearer: "Bearer should_not_persist" },
      }));
      expectSecretRejection(() => store.recordQueryAudit({
        proposal_id: "wrp_123",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "invoices",
        row_count: 1,
        payload: { api_key: "should_not_persist" },
      }));
      expectSecretRejection(() => store.setRunnerState("bad", {
        runner_token: "syn_wbr_should_not_persist",
      }));
    } finally {
      store.close();
    }
  });

  it("approves only the exact proposal hash and version", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      expect(() => store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:wrong",
        proposal_version: 1
      })).toThrowError(ProposalStoreError);
      const approved = store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
        reason: "within policy"
      });
      expect(approved.state).toBe("approved");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved"
      ]);
    } finally {
      store.close();
    }
  });

  it("records execution receipts and terminal state", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1
      });
      store.markPendingWorker("wrp_123", "sha256:proposal", 1);
      store.recordWritebackJob(writebackJob);
      const applied = store.recordExecutionReceipt(appliedReceipt);
      expect(applied.state).toBe("applied");
      expect(applied.source_database_mutated).toBe(true);
      expect(store.receipts("wrp_123")).toHaveLength(1);
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved",
        "proposal_pending_worker",
        "writeback_job_recorded",
        "writeback_applied"
      ]);
    } finally {
      store.close();
    }
  });

  it("preserves proposal, evidence, pending writeback, receipt, and replay across restarts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-restart-"));
    const storePath = path.join(tempDir, "local.db");
    const restartedReceipt = { ...appliedReceipt, writeback_job_id: "wbj_wrp_123" };
    let store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: {
          capability: "billing.waive_late_fee",
          source_id: "src_pg_acme",
          query_fingerprint: "sha256:evidence",
        },
        items: [{ row: "invoices/INV-3001", visible_row: { id: "INV-3001", late_fee_cents: 5500 } }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "public.invoices",
        row_count: 1,
        payload: { parameters_redacted: true, primary_key: "INV-3001" },
      });
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.getProposal("wrp_123")?.state).toBe("approved");
      const job = store.createWritebackJobFromProposal("wrp_123", {
        project_id: "acme-support",
        runner_id: "runner_123",
        lease_id: "lease_restart",
      });
      expect(job.writeback_job_id).toBe("wbj_wrp_123");
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      const replay = store.replay("wrp_123");
      expect(replay.evidence).toHaveLength(1);
      expect(replay.query_audit).toHaveLength(1);
      expect(replay.receipts).toHaveLength(0);
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      store.recordExecutionReceipt(restartedReceipt);
      expect(store.getProposal("wrp_123")?.state).toBe("applied");
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.listReceipts({ proposal: "wrp_123", status: "applied" })).toHaveLength(1);
      expect(store.replay("wrp_123").receipts).toHaveLength(1);
      store.recordExecutionReceipt(restartedReceipt);
      expect(store.listReceipts({ proposal: "wrp_123", status: "applied" })).toHaveLength(1);
      expect(store.stats().idempotency_receipts).toBe(1);
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a public writeback job from an approved immutable proposal", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      expect(() => store.createWritebackJobFromProposal("wrp_123")).toThrowError(ProposalStoreError);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1
      });
      const job = store.createWritebackJobFromProposal("wrp_123", {
        project_id: "acme-support",
        runner_id: "runner_123",
        lease_id: "lease_123"
      });
      expect(job.schema_version).toBe("synapsor.writeback-job.v1");
      expect(job.writeback_job_id).toBe("wbj_wrp_123");
      expect(job.proposal_hash).toBe("sha256:proposal");
      expect(job.runner_scope).toEqual({ project_id: "acme-support", source_id: "src_pg_acme" });
      expect(job.target.primary_key).toEqual({ column: "id", value: "INV-3001" });
      expect(job.tenant_guard).toEqual({ column: "tenant_id", value: "acme" });
      expect(job.conflict_guard).toEqual({
        kind: "column",
        column: "updated_at",
        expected_value: "2026-06-20T14:31:08Z"
      });
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved",
        "proposal_pending_worker",
        "writeback_job_recorded"
      ]);
    } finally {
      store.close();
    }
  });

  it("does not create direct SQL writeback jobs for app-owned executor proposals", () => {
    const store = new ProposalStore();
    try {
      const handlerChangeSet = structuredClone(changeSet) as typeof changeSet & { writeback: { status: string; mode: string; executor?: string } };
      handlerChangeSet.writeback = {
        status: "not_applied",
        mode: "trusted_worker_required",
        executor: "billing_handler",
      };
      store.createProposal(handlerChangeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      expect(() => store.createWritebackJobFromProposal("wrp_123")).toThrowError(/non-local writeback executor billing_handler/);
    } finally {
      store.close();
    }
  });

  it("keeps shadow proposals inspectable but blocks approval and writeback", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(shadowChangeSet());
      expect(proposal.state).toBe("pending_review");
      expect(proposal.change_set.mode).toBe("shadow");
      expect(store.replay("wrp_shadow").proposal.change_set.mode).toBe("shadow");

      expect(() => store.approveProposal("wrp_shadow", {
        approver: "support_lead_1",
        proposal_hash: "sha256:shadow",
        proposal_version: 1,
      })).toThrowError(/shadow proposal wrp_shadow cannot be approved/);

      expect(() => store.createWritebackJobFromProposal("wrp_shadow")).toThrowError(/shadow proposal wrp_shadow cannot be converted into a writeback job/);

      expect(store.getProposal("wrp_shadow")?.source_database_mutated).toBe(false);
    } finally {
      store.close();
    }
  });

  it("records evidence, query audit, replay, and runner state", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { source_database_changed: false },
        items: [{ row: "invoices/INV-3001" }]
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "invoices",
        row_count: 1,
        payload: { columns: ["id", "late_fee_cents", "updated_at"] }
      });
      store.setRunnerState("last_seen", { source_id: "src_pg_acme", lsn: "local" });
      const replay = store.replay("wrp_123");
      expect(replay.replay_id).toBe("replay_wrp_123");
      expect(replay.evidence).toHaveLength(1);
      expect(replay.query_audit).toHaveLength(1);
      expect(replay.events.map((event) => event.kind)).toContain("evidence_recorded");
      expect(store.getRunnerState("last_seen")).toEqual({ source_id: "src_pg_acme", lsn: "local" });
    } finally {
      store.close();
    }
  });

  it("indexes and searches local evidence, audit, receipts, and replay metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-search-"));
    const storePath = path.join(tempDir, "local.db");
    let store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: {
          capability: "billing.waive_late_fee",
          source_id: "src_pg_acme",
          target: "public.invoices",
          principal: { id: "support_agent_17" },
          query_fingerprint: "sha256:evidence",
        },
        items: [{
          kind: "external_row",
          source_id: "src_pg_acme",
          table: "public.invoices",
          primary_key: { column: "id", value: "INV-3001" },
          visible_row: {
            id: "INV-3001",
            tenant_id: "acme",
            late_fee_cents: 5500,
            updated_at: "2026-06-20T14:31:08Z",
          },
        }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "public.invoices",
        row_count: 1,
        payload: {
          capability: "billing.waive_late_fee",
          statement_template: "SELECT id FROM public.invoices WHERE id = ? AND tenant_id = ? LIMIT 1",
          parameters_redacted: true,
        },
      });
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      store.markPendingWorker("wrp_123", "sha256:proposal", 1);
      store.recordWritebackJob(writebackJob);
      store.recordExecutionReceipt(appliedReceipt);

      expect(store.listProposals({
        tenant: "acme",
        principal: "support_agent_17",
        capability: "billing.waive_late_fee",
        objectType: "invoice",
        objectId: "INV-3001",
        source: "src_pg_acme",
        table: "invoices",
        status: "applied",
        limit: 20,
      }).map((proposal) => proposal.proposal_id)).toEqual(["wrp_123"]);
      expect(store.listProposals({ tenant: "otherco" })).toHaveLength(0);

      const evidence = store.listEvidenceBundles({
        tenant: "acme",
        principal: "support_agent_17",
        capability: "billing.waive_late_fee",
        proposal: "wrp_123",
        objectType: "invoice",
        objectId: "INV-3001",
        source: "src_pg_acme",
        table: "invoices",
        queryFingerprint: "sha256:evidence",
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        evidence_bundle_id: "ev_456",
        source_table: "public.invoices",
        object_id: "INV-3001",
      });

      const queryAudit = store.listQueryAudit({
        tenant: "acme",
        proposal: "wrp_123",
        evidence: "ev_456",
        source: "src_pg_acme",
        table: "invoices",
        primaryKey: "INV-3001",
        queryFingerprint: "sha256:evidence",
      });
      expect(queryAudit).toHaveLength(1);
      expect(queryAudit[0]).toMatchObject({
        audit_id: 1,
        evidence_bundle_id: "ev_456",
        primary_key_value: "INV-3001",
      });
      expect(store.getQueryAudit(1)).toMatchObject({ table_name: "public.invoices" });

      const receipts = store.listReceipts({
        proposal: "wrp_123",
        writebackJob: "wbj_123",
        idempotencyKey: "wrp_123:INV-3001",
        status: "applied",
      });
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt).toBeDefined();
      expect(receipt?.receipt_id).toBe(1);
      expect(store.getReceipt(1)?.idempotency_key).toBe("wrp_123:INV-3001");

      expect(store.getReplayByReplayId("replay_wrp_123").proposal.proposal_id).toBe("wrp_123");
      expect(store.proposalIdForEvidence("ev_456")).toBe("wrp_123");

      const proposalIndexes = indexNames(store, "proposals");
      expect(proposalIndexes).toContain("idx_proposals_tenant_created");
      expect(proposalIndexes).toContain("idx_proposals_object_created");
      const evidenceIndexes = indexNames(store, "evidence_bundles");
      expect(evidenceIndexes).toContain("idx_evidence_bundles_tenant_created");
      expect(evidenceIndexes).toContain("idx_evidence_bundles_object_created");
      const auditIndexes = indexNames(store, "query_audit");
      expect(auditIndexes).toContain("idx_query_audit_evidence_id");
      expect(auditIndexes).toContain("idx_query_audit_primary_key_created");
      const receiptIndexes = indexNames(store, "writeback_receipts");
      expect(receiptIndexes).toContain("idx_writeback_receipts_idempotency_key");

      store.migrate();
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.listEvidenceBundles({ tenant: "acme" }).map((bundle) => bundle.evidence_bundle_id)).toEqual(["ev_456"]);
      expect(store.listReceipts({ status: "applied" }).map((receipt) => receipt.receipt_id)).toEqual([1]);
    } finally {
      store.close();
    }
  });
});

function expectSecretRejection(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected secret rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalStoreError);
    expect((error as ProposalStoreError).code).toBe("SECRET_MATERIAL_REJECTED");
  }
}

function indexNames(store: ProposalStore, table: string): string[] {
  return store.db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((row) => {
      if (row && typeof row === "object" && "name" in row) return String(row.name);
      return "";
    })
    .filter(Boolean);
}

type FakeLedgerRow = {
  entry_id: number;
  entry_key: string;
  kind: string;
  proposal_id: string | null;
  tenant_id: string | null;
  capability: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
};

class FakePostgresRuntimePool implements PostgresRuntimePool {
  readonly rows = new Map<string, FakeLedgerRow>();
  private nextEntryId = 1;
  ended = false;

  async connect(): Promise<PostgresRuntimeClient> {
    return new FakePostgresRuntimeClient(this);
  }

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    return await this.execute(sql, values);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async execute(sql: string, values: unknown[] = []): Promise<PostgresRuntimeQueryResult> {
    const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback" ||
      normalized.startsWith("create schema") ||
      normalized.startsWith("create table") ||
      normalized.startsWith("create index") ||
      normalized.startsWith("alter table")
    ) {
      return { rows: [] };
    }
    if (normalized.startsWith("select pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (normalized.startsWith("select entry_key")) {
      return {
        rows: [...this.rows.values()]
          .sort((left, right) => left.entry_id - right.entry_id)
          .map((row) => ({
            entry_key: row.entry_key,
            kind: row.kind,
            proposal_id: row.proposal_id,
            tenant_id: row.tenant_id,
            capability: row.capability,
            payload_json: row.payload_json,
            created_at: row.created_at,
          })),
      };
    }
    if (normalized.startsWith("insert into") && normalized.includes("ledger_entries")) {
      const [entryKey, kind, proposalId, tenantId, capability, payloadJson, createdAt] = values;
      const key = String(entryKey);
      const existing = this.rows.get(key);
      this.rows.set(key, {
        entry_id: existing?.entry_id ?? this.nextEntryId++,
        entry_key: key,
        kind: String(kind),
        proposal_id: proposalId == null ? null : String(proposalId),
        tenant_id: tenantId == null ? null : String(tenantId),
        capability: capability == null ? null : String(capability),
        payload_json: parseFakePayloadJson(payloadJson),
        created_at: String(createdAt),
      });
      return { rows: [] };
    }
    throw new Error(`unexpected fake Postgres query: ${sql}`);
  }
}

class FakePostgresRuntimeClient implements PostgresRuntimeClient {
  constructor(private readonly pool: FakePostgresRuntimePool) {}

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    return await this.pool.execute(sql, values);
  }

  release(): void {}
}

function parseFakePayloadJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const parsed = JSON.parse(String(value ?? "{}")) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return {};
}
