import { describe, expect, it } from "vitest";
import { ProposalStore, ProposalStoreError } from "./index.js";

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
});
