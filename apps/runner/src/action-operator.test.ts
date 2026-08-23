import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { describe, expect, it } from "vitest";
import { createActionOperatorService } from "./action-operator.js";

describe("Safe Action operator service", () => {
  it("reads lifecycle state, binds rejection to the exact hash, and records replay without source mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-operator-"));
    const storePath = path.join(root, "local.db");
    const store = new ProposalStore(storePath);
    let proposalHash = "";
    try {
      const proposal = store.createProposal(changeSet());
      proposalHash = proposal.proposal_hash;
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_orders_credit",
        proposal_id: proposal.proposal_id,
        tenant_id: "tenant-a",
        payload: {
          principal: "rep-1",
          capability: "orders.propose_credit",
          source_id: "local_postgres",
          source_table: "public.orders",
          business_object: "order",
          object_id: "order-1",
          source_database_changed: false,
        },
        items: [{ kind: "reviewed_effect" }],
      });
    } finally {
      store.close();
    }

    const service = createActionOperatorService({
      configPath: path.join(root, "missing.runner.json"),
      storePath,
    });
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        proposal_id: "wrp_orders_credit",
        capability: "orders.propose_credit",
        state: "pending_review",
        source_database_mutated: false,
      }),
    ]);
    await expect(service.count({ search: "orders.propose", state: "pending_review" })).resolves.toBe(1);
    await expect(service.list({ search: "does-not-exist", limit: 12, offset: 0 })).resolves.toEqual([]);
    await expect(service.detail("wrp_orders_credit")).resolves.toMatchObject({
      proposal: { state: "pending_review", proposal_hash: proposalHash },
      approval_progress: { approved: 0, required: 1, complete: false },
      evidence_item_count: 1,
    });

    await expect(service.reject("wrp_orders_credit", {
      actor: "reviewer",
      reason: "Wrong proposal revision.",
      expected_proposal_hash: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow(/PROPOSAL_CHANGED/);
    await expect(service.detail("wrp_orders_credit")).resolves.toMatchObject({
      proposal: { state: "pending_review", source_database_mutated: false },
    });

    await expect(service.reject("wrp_orders_credit", {
      actor: "reviewer",
      reason: "Business request was withdrawn.",
      expected_proposal_hash: proposalHash,
    })).resolves.toMatchObject({
      proposal: { state: "rejected", source_database_mutated: false },
    });
    const replay = await service.replay("wrp_orders_credit", proposalHash);
    expect(replay).toMatchObject({
      replay_id: "replay_wrp_orders_credit",
      proposal: { state: "rejected", source_database_mutated: false },
    });
    expect(replay.approvals).toHaveLength(1);
    expect(replay.evidence).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });
});

function changeSet() {
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: "wrp_orders_credit",
    proposal_version: 1,
    action: "orders.propose_credit",
    mode: "review_required",
    principal: { id: "rep-1", source: "trusted_session" },
    scope: { tenant_id: "tenant-a", business_object: "order", object_id: "order-1" },
    source: {
      kind: "external_postgres",
      source_id: "local_postgres",
      schema: "public",
      table: "orders",
      primary_key: { column: "id", value: "order-1" },
    },
    before: { id: "order-1", tenant_id: "tenant-a", credit_cents: 0, version: 3 },
    patch: { credit_cents: 500 },
    after: { id: "order-1", tenant_id: "tenant-a", credit_cents: 500, version: 4 },
    guards: {
      tenant: { column: "tenant_id", value: "tenant-a" },
      allowed_columns: ["credit_cents"],
      expected_version: { column: "version", value: 3 },
    },
    evidence: { bundle_id: "ev_orders_credit", query_fingerprint: `sha256:${"e".repeat(64)}`, items: [] },
    approval: { status: "pending", required_role: "finance_reviewer" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${"f".repeat(64)}` },
    created_at: "2026-08-20T00:00:00.000Z",
  };
}
