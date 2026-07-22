import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { parseWritebackJob } from "@synapsor-runner/protocol";
import {
  LifecycleViewError,
  buildLifecycleView,
  formatLifecycleDetails,
  formatLifecycleFirstLook,
  formatLifecycleList,
  lifecycleListSchemaVersion,
  lifecycleViewSchemaVersion,
  listLifecycleSummaries,
  resolveLifecycleProposal,
} from "./lifecycle-view.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function protocolFixture(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "fixtures/protocol", name), "utf8"));
}

function proposalChangeSet(input: {
  proposalId?: string;
  objectId?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  createdAt?: string;
  requiredApprovals?: number;
} = {}) {
  const proposalId = input.proposalId ?? "wrp_lifecycle";
  const objectId = input.objectId ?? "INV-LIFECYCLE";
  const tenant = input.tenant ?? "acme";
  const principal = input.principal ?? "support_agent_17";
  const capability = input.capability ?? "billing.waive_late_fee";
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: proposalId,
    proposal_version: 1,
    action: capability,
    contract: { digest: `sha256:${proposalId}`, version: "1.0.0" },
    mode: "review_required",
    principal: { id: principal, source: "trusted_session" },
    scope: { tenant_id: tenant, business_object: "invoice", object_id: objectId },
    source: {
      kind: "external_postgres",
      source_id: "src_pg_acme",
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: objectId },
    },
    before: { id: objectId, tenant_id: tenant, late_fee_cents: 5500, updated_at: "2026-07-20T00:00:00.000Z" },
    patch: { late_fee_cents: 0 },
    after: { id: objectId, tenant_id: tenant, late_fee_cents: 0, updated_at: "2026-07-20T00:00:00.000Z" },
    guards: {
      tenant: { column: "tenant_id", value: tenant },
      allowed_columns: ["late_fee_cents"],
      expected_version: { column: "updated_at", value: "2026-07-20T00:00:00.000Z" },
    },
    evidence: { bundle_id: `ev_${proposalId}`, query_fingerprint: `sha256:evidence-${proposalId}`, items: [] },
    approval: {
      status: "pending",
      required_role: "support_lead",
      ...(input.requiredApprovals ? { required_approvals: input.requiredApprovals } : {}),
    },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${proposalId}` },
    created_at: input.createdAt ?? "2026-07-20T00:00:01.000Z",
  };
}

function seedCompleteLifecycle(store: ProposalStore) {
  const changeSet = proposalChangeSet();
  store.createProposal(changeSet);
  store.recordEvidenceBundle({
    evidence_bundle_id: "ev_lifecycle",
    proposal_id: "wrp_lifecycle",
    tenant_id: "acme",
    payload: {
      capability: "billing.waive_late_fee",
      proposal_id: "wrp_lifecycle",
      source_id: "src_pg_acme",
      target: "public.invoices",
      tenant_id: "acme",
      principal: "support_agent_17",
      query_fingerprint: "sha256:evidence-lifecycle",
      parameters_redacted: true,
    },
    items: [{
      kind: "proposal_evidence",
      visible_row: { id: "INV-LIFECYCLE", late_fee_cents: 5500 },
      before: { late_fee_cents: 5500 },
      patch: { late_fee_cents: 0 },
      after: { late_fee_cents: 0 },
    }],
  });
  store.recordQueryAudit({
    proposal_id: "wrp_lifecycle",
    evidence_bundle_id: "ev_lifecycle",
    source_id: "src_pg_acme",
    query_fingerprint: "sha256:evidence-lifecycle",
    table_name: "public.invoices",
    row_count: 1,
    payload: {
      capability: "billing.waive_late_fee",
      statement_template: "SELECT reviewed columns WHERE id = ? AND tenant_id = ? LIMIT 1",
      parameters_redacted: true,
    },
  });
  store.approveProposal("wrp_lifecycle", {
    approver: "support_lead_1",
    proposal_hash: "sha256:wrp_lifecycle",
    proposal_version: 1,
    reason: "reviewed exact diff",
  });
  const job = store.createWritebackJobFromProposal("wrp_lifecycle", {
    project_id: "local",
    runner_id: "runner_test",
    lease_id: "lease_test",
  });
  const normalized = parseWritebackJob(job);
  store.claimWritebackIntent(job, "runner_test");
  store.recordExecutionReceipt({
    schema_version: "synapsor.execution-receipt.v1",
    writeback_job_id: normalized.job_id,
    proposal_id: "wrp_lifecycle",
    runner_id: "runner_test",
    status: "applied",
    rows_affected: 1,
    idempotency_key: normalized.idempotency_key,
    previous_version: "2026-07-20T00:00:00.000Z",
    new_version: "2026-07-20T00:00:02.000Z",
    source_database_mutated: true,
    executed_at: "2026-07-20T00:00:02.000Z",
    receipt_hash: "sha256:receipt-lifecycle",
  });
  const replay = store.replay("wrp_lifecycle");
  const auditId = Number(store.listQueryAudit({ proposal: "wrp_lifecycle" })[0]?.audit_id);
  const receiptId = store.listReceipts({ proposal: "wrp_lifecycle" })[0]?.receipt_id;
  if (!Number.isSafeInteger(auditId) || !receiptId) throw new Error("lifecycle fixture ids were not persisted");
  return {
    proposalId: "wrp_lifecycle",
    evidenceId: "ev_lifecycle",
    replayId: replay.replay_id,
    jobId: normalized.job_id,
    intentId: `wbi:${normalized.job_id}`,
    receiptId,
    auditId,
  };
}

describe("typed lifecycle inspection", () => {
  it("uses deterministic no-id selection, filters, and bounded list output", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(proposalChangeSet({ proposalId: "wrp_a", objectId: "INV-A", createdAt: "2026-07-20T00:00:01.000Z" }));
      const approved = proposalChangeSet({ proposalId: "wrp_b", objectId: "INV-B", createdAt: "2026-07-20T00:00:02.000Z" });
      store.createProposal(approved);
      store.approveProposal(approved.proposal_id, {
        approver: "support_lead_1",
        proposal_hash: approved.integrity.proposal_hash,
        proposal_version: approved.proposal_version,
      });
      store.createProposal(proposalChangeSet({ proposalId: "wrp_c", objectId: "INV-C", tenant: "globex", principal: "agent_globex", capability: "billing.inspect_credit", createdAt: "2026-07-20T00:00:02.000Z" }));

      const latest = resolveLifecycleProposal(store, {});
      expect(latest.proposal.proposal_id).toBe("wrp_c");
      expect(latest.selection).toMatchObject({ mode: "latest", match_count: 3 });
      expect(resolveLifecycleProposal(store, { handle: "latest" }).proposal.proposal_id).toBe("wrp_c");

      const filtered = resolveLifecycleProposal(store, { filters: { tenant: "acme" } });
      expect(filtered.proposal.proposal_id).toBe("wrp_b");
      expect(filtered.selection).toMatchObject({ mode: "filtered", match_count: 2, filters: { tenant: "acme" } });
      expect(resolveLifecycleProposal(store, { filters: { objectType: "invoice", objectId: "INV-A" } }).proposal.proposal_id).toBe("wrp_a");
      expect(resolveLifecycleProposal(store, { filters: { principal: "agent_globex", capability: "billing.inspect_credit" } }).proposal.proposal_id).toBe("wrp_c");
      expect(resolveLifecycleProposal(store, { filters: { status: "approved" } }).proposal.proposal_id).toBe("wrp_b");
      expect(resolveLifecycleProposal(store, {
        filters: { from: "2026-07-20T00:00:02.000Z", to: "2026-07-20T00:00:02.000Z" },
      }).proposal.proposal_id).toBe("wrp_c");

      const list = listLifecycleSummaries(store, { tenant: "acme", limit: 1 });
      expect(list).toMatchObject({ schema_version: lifecycleListSchemaVersion, total_matches: 2, returned: 1 });
      expect(list.lifecycles.map((item) => item.proposal_id)).toEqual(["wrp_b"]);
      expect(formatLifecycleList(list)).toContain("1 shown, 2 matched");
    } finally {
      store.close();
    }
  });

  it("resolves every linked handle and proves the complete view is side-effect free", () => {
    const store = new ProposalStore();
    try {
      const handles = seedCompleteLifecycle(store);
      const before = JSON.stringify(store.sharedLedgerEntries());
      const cases: Array<[string, string]> = [
        [handles.proposalId, "proposal"],
        [handles.evidenceId, "evidence"],
        [handles.replayId, "replay"],
        [handles.jobId, "job"],
        [handles.intentId, "intent"],
        [`receipt:${handles.receiptId}`, "receipt"],
        [`audit:${handles.auditId}`, "audit"],
      ];

      for (const [handle, kind] of cases) {
        const resolved = resolveLifecycleProposal(store, { handle });
        expect(resolved.proposal.proposal_id).toBe(handles.proposalId);
        expect(resolved.selection).toMatchObject({ mode: "handle", requested_handle: handle, handle_kind: kind, match_count: 1 });
        const view = buildLifecycleView(store, resolved.proposal, resolved.selection);
        expect(view).toMatchObject({
          schema_version: lifecycleViewSchemaVersion,
          proposal: {
            proposal_id: handles.proposalId,
            proposal_version: 1,
            proposal_hash: "sha256:wrp_lifecycle",
            scope: { tenant_id: "acme", principal: "support_agent_17", business_object: "invoice", object_id: "INV-LIFECYCLE" },
            source_database_mutated: true,
          },
          approval: { status: "approved", source: "human", progress: { approved: 1, required: 1, complete: true } },
          evidence: { count: 1 },
          query_audit: { count: 1 },
          writeback: { latest_outcome: { status: "applied", rows_affected: 1, source_database_mutated: true } },
          replay: { replay_id: handles.replayId, state: "applied" },
        });
        expect(view.writeback.jobs).toHaveLength(1);
        expect(view.writeback.intents).toHaveLength(1);
        expect(view.writeback.receipts).toHaveLength(1);
        expect(view.timeline.map((item) => item.kind)).toEqual(expect.arrayContaining([
          "proposal_created",
          "query_audit_recorded",
          "proposal_approved",
          "writeback_job_recorded",
          "writeback_intent_recorded",
          "writeback_applied",
          "replay_snapshot_stored",
        ]));
        expect(view.timeline.map((item) => String(item.occurred_at))).toEqual(
          [...view.timeline.map((item) => String(item.occurred_at))].sort(),
        );
        expect(formatLifecycleFirstLook(view)).toContain("Source database changed: true");
        expect(formatLifecycleDetails(view)).toContain("Ordered timeline:");
      }

      expect(JSON.stringify(store.sharedLedgerEntries())).toBe(before);
    } finally {
      store.close();
    }
  });

  it("does not fabricate absent lifecycle stages and returns stable selection errors", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(proposalChangeSet());
      const resolved = resolveLifecycleProposal(store, {});
      const view = buildLifecycleView(store, resolved.proposal, resolved.selection);
      expect(view.writeback).toMatchObject({ jobs: [], intents: [], receipts: [], latest_outcome: null });
      expect(view.replay).toEqual({ replay_id: null, state: null, generated_at: null });
      expect(view.cloud).toMatchObject({ synchronized: false, outbox: [], governance_events: [] });
      expect(formatLifecycleFirstLook(view)).toContain("Writeback: not created; no intent");
      expect(formatLifecycleFirstLook(view)).toContain("Latest outcome: not applied");
      expect(formatLifecycleFirstLook(view)).toContain("Replay: not created");
      expect(formatLifecycleFirstLook(view)).toContain("Cloud: not synchronized");

      expect(() => resolveLifecycleProposal(store, { handle: "77" })).toThrowError(expect.objectContaining({ code: "LIFECYCLE_HANDLE_AMBIGUOUS" }));
      expect(() => resolveLifecycleProposal(store, { handle: "receipt:not-a-number" })).toThrowError(expect.objectContaining({ code: "LIFECYCLE_HANDLE_INVALID" }));
      expect(() => resolveLifecycleProposal(store, { handle: "ev_missing" })).toThrowError(expect.objectContaining({ code: "LIFECYCLE_HANDLE_NOT_FOUND" }));
      expect(() => resolveLifecycleProposal(store, { handle: "wrp_lifecycle", filters: { tenant: "acme" } })).toThrowError(expect.objectContaining({ code: "LIFECYCLE_SELECTION_CONFLICT" }));
      expect(() => resolveLifecycleProposal(store, { filters: { tenant: "globex" } })).toThrowError(expect.objectContaining({ code: "LIFECYCLE_NOT_FOUND" }));
    } finally {
      store.close();
    }

    const empty = new ProposalStore();
    try {
      expect(() => resolveLifecycleProposal(empty, {})).toThrowError(expect.objectContaining({ code: "LIFECYCLE_NOT_FOUND" }));
    } finally {
      empty.close();
    }
  });

  it("returns stable non-leaking errors for orphaned and corrupt lifecycle records", () => {
    const orphaned = new ProposalStore();
    try {
      orphaned.createProposal(proposalChangeSet({ proposalId: "wrp_orphaned" }));
      orphaned.recordEvidenceBundle({
        evidence_bundle_id: "ev_orphaned",
        proposal_id: "wrp_orphaned",
        tenant_id: "acme",
        payload: { capability: "billing.waive_late_fee", proposal_id: "wrp_orphaned" },
        items: [],
      });
      orphaned.db.exec("PRAGMA foreign_keys = OFF");
      orphaned.db.prepare("DELETE FROM proposals WHERE proposal_id = ?").run("wrp_orphaned");
      expect(() => resolveLifecycleProposal(orphaned, { handle: "ev_orphaned" })).toThrowError(expect.objectContaining({
        code: "LIFECYCLE_LINK_CORRUPT",
        message: expect.not.stringContaining("evidence_bundles"),
      }));
    } finally {
      orphaned.close();
    }

    const corrupt = new ProposalStore();
    try {
      corrupt.createProposal(proposalChangeSet({ proposalId: "wrp_corrupt" }));
      const resolved = resolveLifecycleProposal(corrupt, { handle: "wrp_corrupt" });
      corrupt.db.prepare("UPDATE proposal_events SET payload_json = ? WHERE proposal_id = ?").run("{not-json", "wrp_corrupt");
      expect(() => buildLifecycleView(corrupt, resolved.proposal, resolved.selection)).toThrowError(expect.objectContaining({
        code: "LIFECYCLE_RECORD_CORRUPT",
        message: expect.not.stringContaining("not-json"),
      }));

      corrupt.db.prepare("UPDATE proposals SET change_set_json = ? WHERE proposal_id = ?").run("{also-not-json", "wrp_corrupt");
      expect(() => resolveLifecycleProposal(corrupt, { handle: "wrp_corrupt" })).toThrowError(expect.objectContaining({
        code: "LIFECYCLE_RECORD_CORRUPT",
        message: expect.not.stringContaining("also-not-json"),
      }));
    } finally {
      corrupt.close();
    }
  });

  it("distinguishes human, policy, quorum, and approved-without-job states", () => {
    const store = new ProposalStore();
    try {
      const pending = proposalChangeSet({ proposalId: "wrp_pending", objectId: "INV-PENDING" });
      store.createProposal(pending);
      let resolved = resolveLifecycleProposal(store, { handle: pending.proposal_id });
      expect(buildLifecycleView(store, resolved.proposal, resolved.selection).approval).toMatchObject({
        status: "pending",
        source: "none",
        progress: { approved: 0, required: 1, complete: false },
      });

      const policy = proposalChangeSet({ proposalId: "wrp_policy", objectId: "INV-POLICY" });
      store.createProposal(policy);
      store.approveProposalByPolicy(policy.proposal_id, {
        policy: "small_credit",
        proposal_hash: policy.integrity.proposal_hash,
        proposal_version: 1,
        reason: "reviewed bounded policy",
      });
      resolved = resolveLifecycleProposal(store, { handle: policy.proposal_id });
      expect(buildLifecycleView(store, resolved.proposal, resolved.selection).approval).toMatchObject({
        status: "approved",
        source: "policy",
        policy: "small_credit",
      });

      const quorum = proposalChangeSet({ proposalId: "wrp_quorum", objectId: "INV-QUORUM", requiredApprovals: 2 });
      store.createProposal(quorum);
      store.approveProposal(quorum.proposal_id, {
        approver: "reviewer_one",
        proposal_hash: quorum.integrity.proposal_hash,
        proposal_version: 1,
      });
      resolved = resolveLifecycleProposal(store, { handle: quorum.proposal_id });
      expect(buildLifecycleView(store, resolved.proposal, resolved.selection).approval).toMatchObject({
        status: "incomplete",
        source: "human",
        progress: { approved: 1, required: 2, remaining: 1, complete: false },
      });
      store.approveProposal(quorum.proposal_id, {
        approver: "reviewer_two",
        proposal_hash: quorum.integrity.proposal_hash,
        proposal_version: 1,
      });
      resolved = resolveLifecycleProposal(store, { handle: quorum.proposal_id });
      const approved = buildLifecycleView(store, resolved.proposal, resolved.selection);
      expect(approved.proposal.state).toBe("approved");
      expect(approved.approval).toMatchObject({ status: "approved", progress: { approved: 2, required: 2, complete: true } });
      expect(approved.writeback.jobs).toEqual([]);
      expect(formatLifecycleFirstLook(approved)).toContain("Writeback: not created");
    } finally {
      store.close();
    }
  });

  it("reports applying intents and every terminal writeback outcome without creating effects", () => {
    const statuses = ["applied", "already_applied", "conflict", "failed"] as const;
    for (const status of statuses) {
      const store = new ProposalStore();
      try {
        const proposal = proposalChangeSet({ proposalId: `wrp_${status}`, objectId: `INV-${status}` });
        store.createProposal(proposal);
        store.approveProposal(proposal.proposal_id, {
          approver: "reviewer",
          proposal_hash: proposal.integrity.proposal_hash,
          proposal_version: 1,
        });
        const job = store.createWritebackJobFromProposal(proposal.proposal_id, { runner_id: "runner_lifecycle" });
        const normalized = parseWritebackJob(job);
        const claim = store.claimWritebackIntent(job, "runner_lifecycle");
        expect(claim.decision).toBe("proceed");
        store.markWritebackIntentApplying(`wbi:${normalized.job_id}`, "runner_lifecycle");

        let resolved = resolveLifecycleProposal(store, { handle: proposal.proposal_id });
        let view = buildLifecycleView(store, resolved.proposal, resolved.selection);
        expect(view.writeback.intents[0]).toMatchObject({ status: "applying" });
        expect(view.next.operator).toContain("writeback reconcile inspect");

        store.completeWritebackIntent(`wbi:${normalized.job_id}`, {
          protocol_version: "1.0",
          job_id: normalized.job_id,
          runner_id: "runner_lifecycle",
          status,
          affected_rows: status === "applied" ? 1 : 0,
          result_hash: `sha256:result-${status}`,
          completed_at: "2026-07-20T00:00:03.000Z",
        });
        store.recordExecutionReceipt({
          schema_version: "synapsor.execution-receipt.v1",
          writeback_job_id: normalized.job_id,
          proposal_id: proposal.proposal_id,
          runner_id: "runner_lifecycle",
          status,
          rows_affected: status === "applied" ? 1 : 0,
          idempotency_key: normalized.idempotency_key,
          source_database_mutated: status === "applied",
          executed_at: "2026-07-20T00:00:03.000Z",
          ...(status === "conflict" ? { safe_error_code: "VERSION_CONFLICT" } : {}),
          ...(status === "failed" ? { safe_error_code: "DATABASE_UNAVAILABLE" } : {}),
          receipt_hash: `sha256:receipt-${status}`,
        });
        resolved = resolveLifecycleProposal(store, { handle: proposal.proposal_id });
        view = buildLifecycleView(store, resolved.proposal, resolved.selection);
        expect(view.writeback.latest_outcome).toMatchObject({ status, source_database_mutated: status === "applied" });
        expect(view.proposal.state).toBe(status === "already_applied" ? "applied" : status);
      } finally {
        store.close();
      }
    }

    const store = new ProposalStore();
    try {
      const proposal = proposalChangeSet({ proposalId: "wrp_reconciliation_required", objectId: "INV-RECONCILE" });
      store.createProposal(proposal);
      store.approveProposal(proposal.proposal_id, {
        approver: "reviewer",
        proposal_hash: proposal.integrity.proposal_hash,
        proposal_version: proposal.proposal_version,
      });
      const job = store.createWritebackJobFromProposal(proposal.proposal_id, { runner_id: "runner_lifecycle" });
      const normalized = parseWritebackJob(job);
      const claim = store.claimWritebackIntent(job, "runner_lifecycle");
      expect(claim.decision).toBe("proceed");
      const intentId = `wbi:${normalized.job_id}`;
      store.markWritebackIntentApplying(intentId, "runner_lifecycle");
      store.requireWritebackReconciliation(intentId, "source commit acknowledgement is missing");
      store.recordExecutionReceipt({
        schema_version: "synapsor.execution-receipt.v2",
        writeback_job_id: normalized.job_id,
        proposal_id: proposal.proposal_id,
        proposal_hash: proposal.integrity.proposal_hash,
        approval_id: "approval_reconciliation_required",
        runner_id: "runner_lifecycle",
        operation: "single_row_update",
        receipt_authority: "runner_ledger",
        status: "reconciliation_required",
        target: {
          source_id: "src_pg_acme",
          schema: "public",
          table: "invoices",
          identity: [
            { column: "id", value: "INV-RECONCILE" },
            { column: "tenant_id", value: "acme" },
          ],
        },
        rows_affected: 0,
        idempotency_key: normalized.idempotency_key,
        source_database_mutated: false,
        safe_outcome_code: "OUTCOME_UNKNOWN",
        safe_error_code: "RECONCILIATION_REQUIRED",
        executed_at: "2026-07-20T00:00:03.000Z",
        receipt_hash: "sha256:receipt-reconciliation-required",
        reconciliation: { intent_id: intentId, reason: "source_commit_not_proven" },
      });
      const resolved = resolveLifecycleProposal(store, { handle: proposal.proposal_id });
      const view = buildLifecycleView(store, resolved.proposal, resolved.selection);
      expect(view.proposal.state).toBe("reconciliation_required");
      expect(view.writeback.latest_outcome).toMatchObject({ status: "reconciliation_required", source_database_mutated: false });
      expect(view.writeback.intents[0]).toMatchObject({ status: "reconciliation_required" });
      expect(view.next.operator).toContain("writeback reconcile inspect");
    } finally {
      store.close();
    }
  });

  it("renders canonical CRUD, bounded-set, and compensation operation shapes", () => {
    const cases = [
      ["change-set.update.v2.json", "single_row_update", false],
      ["change-set.insert.v2.json", "single_row_insert", false],
      ["change-set.delete.v2.json", "single_row_delete", false],
      ["change-set.bounded-update.v3.json", "set_update", false],
      ["compensation-change-set.update.v1.json", "compensation", true],
    ] as const;
    for (const [fixtureName, operation, compensation] of cases) {
      const store = new ProposalStore();
      try {
        const changeSet = protocolFixture(fixtureName);
        store.createProposal(changeSet);
        const resolved = resolveLifecycleProposal(store, { handle: changeSet.proposal_id });
        const view = buildLifecycleView(store, resolved.proposal, resolved.selection);
        expect(view.proposal.operation).toBe(operation);
        expect(view.proposal.change.frozen_set === null).toBe(operation !== "set_update");
        expect(view.compensation.requested).toBe(compensation);
      } finally {
        store.close();
      }
    }
  });

  it("redacts secret-like historical values in every rendered representation", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(proposalChangeSet());
      const now = "2026-07-20T00:00:03.000Z";
      store.db.prepare(`
        INSERT INTO evidence_bundles (
          evidence_bundle_id, proposal_id, tenant_id, principal, capability,
          source_id, source_table, business_object, object_id, query_fingerprint,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "ev_tampered",
        "wrp_lifecycle",
        "acme",
        "support_agent_17",
        "billing.waive_late_fee",
        "src_pg_acme",
        "public.invoices",
        "invoice",
        "INV-LIFECYCLE",
        "sha256:evidence-tampered",
        JSON.stringify({ auth_token: "Bearer should-never-render", nested: { database_url: "postgresql://reader:secret@example/app" } }),
        now,
      );
      const resolved = resolveLifecycleProposal(store, {});
      const view = buildLifecycleView(store, resolved.proposal, resolved.selection);
      const json = JSON.stringify(view);
      const text = `${formatLifecycleFirstLook(view)}${formatLifecycleDetails(view)}`;
      expect(json).not.toContain("should-never-render");
      expect(json).not.toContain("postgresql://");
      expect(json).toContain("<redacted>");
      expect(text).not.toContain("should-never-render");
      expect(text).not.toContain("postgresql://");
      expect(json).not.toContain("internal_risk_score");
      expect(json).not.toContain("internal_agent_note");
    } finally {
      store.close();
    }
  });
});
