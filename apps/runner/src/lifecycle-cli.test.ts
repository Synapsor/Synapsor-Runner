import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main } from "./cli.js";

function changeSet(proposalId: string, objectId: string, createdAt: string) {
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: proposalId,
    proposal_version: 1,
    action: "billing.waive_late_fee",
    mode: "review_required",
    principal: { id: "support_agent_17", source: "trusted_session" },
    scope: { tenant_id: "acme", business_object: "invoice", object_id: objectId },
    source: {
      kind: "external_postgres",
      source_id: "src_pg_acme",
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: objectId },
    },
    before: { id: objectId, tenant_id: "acme", late_fee_cents: 500, updated_at: "2026-07-20T00:00:00.000Z" },
    patch: { late_fee_cents: 0 },
    after: { id: objectId, tenant_id: "acme", late_fee_cents: 0, updated_at: "2026-07-20T00:00:00.000Z" },
    guards: {
      tenant: { column: "tenant_id", value: "acme" },
      allowed_columns: ["late_fee_cents"],
      expected_version: { column: "updated_at", value: "2026-07-20T00:00:00.000Z" },
    },
    evidence: { bundle_id: `ev_${proposalId}`, query_fingerprint: `sha256:${proposalId}`, items: [] },
    approval: { status: "pending", required_role: "support_lead" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${proposalId}` },
    created_at: createdAt,
  };
}

describe("lifecycle CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes bare/show/latest equivalent and supports no-id browsing and handle drill-down", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-lifecycle-cli-"));
    const storePath = path.join(tempDir, "local.db");
    let store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet("wrp_first", "INV-1", "2026-07-20T00:00:01.000Z"));
      store.createProposal(changeSet("wrp_latest", "INV-2", "2026-07-20T00:00:02.000Z"));
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_latest",
        proposal_id: "wrp_latest",
        tenant_id: "acme",
        payload: { capability: "billing.waive_late_fee", proposal_id: "wrp_latest" },
        items: [{ visible_row: { id: "INV-2", late_fee_cents: 500 } }],
      });
    } finally {
      store.close();
    }

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    const runJson = async (args: string[]) => {
      output.length = 0;
      await expect(main(args)).resolves.toBe(0);
      return JSON.parse(output.join(""));
    };
    const bare = await runJson(["lifecycle", "--json", "--store", storePath]);
    const show = await runJson(["lifecycle", "show", "--json", "--store", storePath]);
    const latest = await runJson(["lifecycle", "show", "latest", "--json", "--store", storePath]);
    expect(bare).toEqual(show);
    expect(show).toEqual(latest);
    expect(bare).toMatchObject({
      schema_version: "synapsor.lifecycle-view.v1",
      selection: { mode: "latest", requested_handle: null, handle_kind: null, match_count: 2 },
      proposal: { proposal_id: "wrp_latest", scope: { object_id: "INV-2" } },
      evidence: { count: 1 },
      replay: { replay_id: null },
    });

    output.length = 0;
    await expect(main(["lifecycle", "list", "--tenant", "acme", "--limit", "1", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("1 shown, 2 matched");
    expect(output.join("")).toContain("wrp_latest");
    expect(output.join("")).not.toContain("wrp_first");

    output.length = 0;
    await expect(main(["lifecycle", "show", "--object", "invoice:INV-1", "--details", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Lifecycle wrp_first");
    expect(output.join("")).toContain("Ordered timeline:");

    const fromEvidence = await runJson(["lifecycle", "show", "ev_latest", "--json", "--store", storePath]);
    expect(fromEvidence).toMatchObject({ selection: { mode: "handle", handle_kind: "evidence" }, proposal: { proposal_id: "wrp_latest" } });

    store = new ProposalStore(storePath);
    const before = JSON.stringify(store.sharedLedgerEntries());
    store.close();
    await runJson(["lifecycle", "--json", "--store", storePath]);
    store = new ProposalStore(storePath);
    try {
      expect(JSON.stringify(store.sharedLedgerEntries())).toBe(before);
    } finally {
      store.close();
    }

    await expect(main(["lifecycle", "show", "--limit", "1", "--store", storePath])).rejects.toThrow(/Unknown option for lifecycle show: --limit/);
    await fs.rm(tempDir, { recursive: true, force: true });
  }, 15_000);

  it("does not create a missing store and prints dedicated help", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-lifecycle-missing-"));
    const storePath = path.join(tempDir, "missing", "local.db");
    await expect(main(["lifecycle", "--store", storePath])).rejects.toThrow(/No local Synapsor proposal store was found/);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["lifecycle", "--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("Bare lifecycle, lifecycle show, and lifecycle show latest");
    expect(output.join("")).toContain("receipt:<numeric-id>");
    expect(output.join("")).toContain("does not materialize replay records");
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
