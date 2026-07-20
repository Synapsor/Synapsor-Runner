import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main } from "./cli.js";

describe("effect CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates, initializes, compares, and explicitly accepts a replay baseline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-effect-cli-"));
    const storePath = path.join(root, "local.db");
    seedReplayStore(storePath, "wrp_effect_cli");
    const contractPath = path.resolve(
      "packages/spec/examples/guarded-writeback.contract.json",
    );
    const fixturePath = path.join(root, "late-fee.effect.json");
    const resultPath = path.join(root, "late-fee.result.json");
    const acceptedPath = path.join(root, "late-fee.accepted.json");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await expect(main([
        "effect",
        "fixture",
        "create",
        "--from-replay",
        "replay_wrp_effect_cli",
        "--request",
        "Waive the $55 late fee on invoice INV-3001.",
        "--name",
        "late fee effect",
        "--contract",
        contractPath,
        "--store",
        storePath,
        "--output",
        fixturePath,
      ])).resolves.toBe(0);
      await expect(main([
        "effect",
        "result",
        "init",
        "--fixture",
        fixturePath,
        "--output",
        resultPath,
      ])).resolves.toBe(0);
      await expect(main([
        "effect",
        "run",
        "--fixture",
        fixturePath,
        "--result",
        resultPath,
        "--format",
        "json",
      ])).resolves.toBe(0);

      const report = JSON.parse(output.at(-1)!) as {
        ok: boolean;
        mode: string;
      };
      expect(report).toMatchObject({ ok: true, mode: "offline_import" });

      await expect(main([
        "effect",
        "accept",
        "--fixture",
        fixturePath,
        "--result",
        resultPath,
        "--actor",
        "release-engineer",
        "--reason",
        "Reviewed unchanged provider result",
        "--output",
        acceptedPath,
      ])).rejects.toThrow(/requires --yes/);
      await expect(main([
        "effect",
        "accept",
        "--fixture",
        fixturePath,
        "--result",
        resultPath,
        "--actor",
        "release-engineer",
        "--reason",
        "Reviewed unchanged provider result",
        "--output",
        acceptedPath,
        "--yes",
      ])).resolves.toBe(0);
      await expect(fs.stat(acceptedPath)).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns a failing exit code when an imported business effect changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-effect-cli-drift-"));
    const storePath = path.join(root, "local.db");
    seedReplayStore(storePath, "wrp_effect_cli_drift");
    const fixturePath = path.join(root, "effect.json");
    const resultPath = path.join(root, "result.json");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(await main([
        "effect",
        "fixture",
        "create",
        "--from-proposal",
        "wrp_effect_cli_drift",
        "--request",
        "Waive the $55 late fee on invoice INV-3001.",
        "--contract",
        path.resolve("packages/spec/examples/guarded-writeback.contract.json"),
        "--store",
        storePath,
        "--output",
        fixturePath,
      ])).toBe(0);
      expect(await main([
        "effect",
        "result",
        "init",
        "--fixture",
        fixturePath,
        "--output",
        resultPath,
      ])).toBe(0);
      const changed = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
        proposal: { diff: Record<string, { before: unknown; proposed: unknown }> };
      };
      changed.proposal.diff.late_fee_cents = { before: 5500, proposed: 1000 };
      await fs.writeFile(resultPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

      expect(await main([
        "effect",
        "compare",
        "--fixture",
        fixturePath,
        "--result",
        resultPath,
      ])).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function seedReplayStore(storePath: string, proposalId: string): void {
  const proposalHash = `sha256:${"c".repeat(64)}`;
  const queryFingerprint = `sha256:${"d".repeat(64)}`;
  const store = new ProposalStore(storePath);
  try {
    store.createProposal({
      schema_version: "synapsor.change-set.v1",
      proposal_id: proposalId,
      proposal_version: 1,
      action: "billing.propose_late_fee_waiver",
      mode: "review_required",
      principal: { id: "support-agent-demo", source: "trusted_session" },
      scope: {
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-3001",
      },
      source: {
        kind: "external_postgres",
        source_id: "billing",
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-3001" },
      },
      before: {
        late_fee_cents: 5500,
        waiver_reason: null,
        updated_at: "2026-07-19T09:00:00.000Z",
      },
      patch: {
        late_fee_cents: 0,
        waiver_reason: "Courtesy waiver supported by SUP-184",
      },
      after: {
        late_fee_cents: 0,
        waiver_reason: "Courtesy waiver supported by SUP-184",
        updated_at: "2026-07-19T09:00:00.000Z",
      },
      guards: {
        tenant: { column: "tenant_id", value: "acme" },
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        expected_version: {
          column: "updated_at",
          value: "2026-07-19T09:00:00.000Z",
        },
      },
      evidence: {
        bundle_id: `ev_${proposalId}`,
        query_fingerprint: queryFingerprint,
        items: [],
      },
      approval: { status: "pending", required_role: "billing_lead" },
      writeback: { status: "not_applied", mode: "trusted_worker_required" },
      source_database_mutated: false,
      integrity: { proposal_hash: proposalHash },
      created_at: "2026-07-19T09:00:01.000Z",
    });
    store.recordEvidenceBundle({
      evidence_bundle_id: `ev_${proposalId}`,
      proposal_id: proposalId,
      tenant_id: "acme",
      payload: {
        principal: "support-agent-demo",
        capability: "billing.propose_late_fee_waiver",
        source_id: "billing",
        business_object: "invoice",
        object_id: "INV-3001",
        support_ticket: "SUP-184",
        courtesy_waiver_eligible: true,
        query_fingerprint: queryFingerprint,
      },
      items: [{ kind: "support_ticket", id: "SUP-184" }],
    });
    store.recordQueryAudit({
      proposal_id: proposalId,
      evidence_bundle_id: `ev_${proposalId}`,
      source_id: "billing",
      query_fingerprint: queryFingerprint,
      table_name: "public.invoices",
      row_count: 1,
      payload: { parameters_redacted: true },
    });
    store.approveProposal(proposalId, {
      approver: "billing-lead",
      proposal_hash: proposalHash,
      proposal_version: 1,
      reason: "Approved reference effect",
    });
  } finally {
    store.close();
  }
}
