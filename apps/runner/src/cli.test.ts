import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main } from "./cli.js";

const changeSet = {
  schema_version: "synapsor.change-set.v1",
  proposal_id: "wrp_cli",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-CLI" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-CLI" }
  },
  before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-06-20T14:31:08Z" },
  patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
  after: { late_fee_cents: 0, waiver_reason: "customer requested review", updated_at: "2026-06-20T14:31:08Z" },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    expected_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" }
  },
  evidence: { bundle_id: "ev_cli", query_fingerprint: "sha256:evidence", items: [] },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: "sha256:proposal" },
  created_at: "2026-06-20T14:31:09Z"
};

describe("runner cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists, shows, approves, and exports local proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["proposals", "list", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrp_cli");

    output.length = 0;
    await expect(main(["proposals", "show", "wrp_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("source database changed: no");
    expect(output.join("")).toContain("late_fee_cents");

    output.length = 0;
    await expect(main(["proposals", "approve", "wrp_cli", "--store", storePath, "--actor", "support_lead_1", "--yes"])).resolves.toBe(0);
    expect(output.join("")).toContain("approved wrp_cli");

    output.length = 0;
    const replayPath = path.join(tempDir, "replay.json");
    await expect(main(["replay", "export", "wrp_cli", "--store", storePath, "--output", replayPath])).resolves.toBe(0);
    const replay = JSON.parse(await fs.readFile(replayPath, "utf8"));
    expect(replay.replay_id).toBe("replay_wrp_cli");
    expect(replay.events.map((event: { kind: string }) => event.kind)).toContain("proposal_approved");
  });
});
