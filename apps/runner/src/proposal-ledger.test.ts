import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseFreshnessProof, protocolVersions } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activitySearch, evidenceBrowserCommand, evidenceBrowserFilterSummary, evidenceList, evidenceShow, queryAuditList, reusableRecordedFreshness } from "./proposal-ledger.js";


const proposalHash = canonicalJsonDigest({ proposal: "freshness-reuse" });
const authorityUnsigned = {
  schema_version: protocolVersions.freshnessAuthority,
  required: true as const,
  target: { mode: "exact_guard" as const, member_count: 1 },
  dependencies: [],
};
const freshnessAuthority = {
  ...authorityUnsigned,
  dependency_set_digest: canonicalJsonDigest(authorityUnsigned),
};
const changeSet = {
  schema_version: protocolVersions.changeSetV2,
  proposal_id: "wrp_freshness_reuse",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  operation: "single_row_update",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-REUSE" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-REUSE" },
  },
  before: { late_fee_cents: 5500, updated_at: "2026-08-03T12:00:00Z" },
  patch: { late_fee_cents: 0 },
  after: { late_fee_cents: 0, updated_at: "2026-08-03T12:00:00Z" },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents"],
    expected_version: { column: "updated_at", value: "2026-08-03T12:00:00Z" },
    max_rows: 1,
  },
  evidence: {
    bundle_id: "ev_freshness_reuse",
    query_fingerprint: canonicalJsonDigest({ query: "freshness-reuse" }),
    items: [{ type: "row", handle: "row://invoices/INV-REUSE" }],
  },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: proposalHash },
  freshness: freshnessAuthority,
  created_at: "2026-08-03T12:00:01Z",
};


function runtimeConfig(): RuntimeConfig {
  return {
    version: 1,
    mode: "review",
    sources: {
      src_pg_acme: {
        engine: "postgres",
        read_url_env: "UNUSED_READ_URL",
        write_url_env: "UNUSED_WRITE_URL",
      },
    },
    trusted_context: {
      provider: "static_dev",
      values: { tenant_id: "acme", principal: "support_agent_17" },
    },
    proposal_freshness: {
      "billing.waive_late_fee": { approval: "required", dependencies: [] },
    },
    capabilities: [{
      name: "billing.waive_late_fee",
      kind: "proposal",
      source: "src_pg_acme",
      target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
      args: { invoice_id: { type: "string", required: true } },
      lookup: { id_from_arg: "invoice_id" },
      visible_columns: ["id", "tenant_id", "late_fee_cents", "updated_at"],
      patch: { late_fee_cents: { from_arg: "late_fee_cents" } },
      allowed_columns: ["late_fee_cents"],
      conflict_guard: { column: "updated_at" },
      operation: { kind: "update" },
      approval: { mode: "human", required_role: "support_lead" },
      writeback: { mode: "direct_sql" },
    }],
  } as RuntimeConfig;
}


function recordedProof(validUntil: string) {
  const checkedAt = new Date(Date.now() - 1_000).toISOString();
  const unsigned = {
    schema_version: protocolVersions.freshnessProof,
    proposal_id: changeSet.proposal_id,
    proposal_hash: proposalHash,
    proposal_version: 1,
    dependency_set_digest: freshnessAuthority.dependency_set_digest,
    checked_at: checkedAt,
    valid_until: validUntil,
    source_adapters: [{ source_id: "src_pg_acme", engine: "postgres" as const }],
    result: "fresh" as const,
    safe_code: "FRESHNESS_FRESH",
    target_count: 1,
    supporting_count: 0,
    checks: [{ id: "target", kind: "target" as const, status: "fresh" as const, safe_code: "FRESHNESS_TARGET_FRESH" }],
  };
  return parseFreshnessProof({ ...unsigned, proof_digest: canonicalJsonDigest(unsigned) });
}


describe("proposal approval freshness reuse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses only the exact current unexpired proof without another source read", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(changeSet);
      const proof = recordedProof(new Date(Date.now() + 30_000).toISOString());
      store.recordFreshnessProof(proof);

      expect(reusableRecordedFreshness({
        proposal,
        config: runtimeConfig(),
        configPath: "/unused/synapsor.runner.json",
        store,
        proofDigest: proof.proof_digest,
      })).toEqual({
        required: true,
        status: "fresh",
        safe_code: "FRESHNESS_FRESH",
        target_count: 1,
        supporting_count: 0,
        proof,
      });
      expect(reusableRecordedFreshness({
        proposal,
        config: runtimeConfig(),
        configPath: "/unused/synapsor.runner.json",
        store,
        proofDigest: canonicalJsonDigest({ wrong: true }),
      })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not reuse an expired or already-consumed proof", () => {
    const expiredStore = new ProposalStore();
    try {
      const proposal = expiredStore.createProposal(changeSet);
      const proof = recordedProof(new Date(Date.now() - 1).toISOString());
      expiredStore.recordFreshnessProof(proof);
      expect(reusableRecordedFreshness({
        proposal,
        config: runtimeConfig(),
        configPath: "/unused/synapsor.runner.json",
        store: expiredStore,
        proofDigest: proof.proof_digest,
      })).toBeUndefined();
    } finally {
      expiredStore.close();
    }

    const usedStore = new ProposalStore();
    try {
      const proposal = usedStore.createProposal(changeSet);
      const proof = recordedProof(new Date(Date.now() + 30_000).toISOString());
      usedStore.recordFreshnessProof(proof);
      usedStore.approveProposal(proposal.proposal_id, {
        approver: "reviewer_1",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        freshness_proof_digest: proof.proof_digest,
      });
      expect(reusableRecordedFreshness({
        proposal,
        config: runtimeConfig(),
        configPath: "/unused/synapsor.runner.json",
        store: usedStore,
        proofDigest: proof.proof_digest,
      })).toBeUndefined();
    } finally {
      usedStore.close();
    }
  });

  it("fails closed when the reviewed freshness policy changed after the proof", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(changeSet);
      const proof = recordedProof(new Date(Date.now() + 30_000).toISOString());
      store.recordFreshnessProof(proof);
      const config = runtimeConfig();
      delete config.proposal_freshness?.[proposal.action];
      expect(() => reusableRecordedFreshness({
        proposal,
        config,
        configPath: "/unused/synapsor.runner.json",
        store,
        proofDigest: proof.proof_digest,
      })).toThrow(/FRESHNESS_POLICY_CHANGED_CREATE_NEW_PROPOSAL/);
    } finally {
      store.close();
    }
  });

  it("identifies the consulted local ledger in text, JSON, and empty results", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-source-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_cli_source",
      tenant_id: "keyed:fixture",
      payload: {
        schema_version: "synapsor.analytics-evidence.v1",
        capability: "app.explore_data",
        source_id: "analytics",
        source_table: "public.orders",
        query_fingerprint: "sha256:fixture",
        outcome: "ok",
        result_values_persisted: false,
      },
      query_audit: [{
        source_id: "analytics",
        query_fingerprint: "sha256:fixture",
        table_name: "public.orders",
        row_count: 2,
        payload: { scoped_explore_version: "1.7.0", status: "ok", result_values_persisted: false },
      }],
    });
    store.close();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await evidenceList(["--store", storePath, "--table", "public.orders"]);
      expect(write.mock.calls.flat().join("")).toContain(`Ledger: local SQLite ${storePath}`);
      write.mockClear();
      await queryAuditList([
        "--store", storePath,
        "--json",
        "--capability", "app.explore_data",
        "--status", "ok",
        "--since", "2020-01-01T00:00:00.000Z",
      ]);
      const json = JSON.parse(write.mock.calls.flat().join(""));
      expect(json).toMatchObject({
        ledger_source: { kind: "local_sqlite", path: storePath },
        query_audit: [expect.objectContaining({ table_name: "public.orders" })],
      });
      write.mockClear();
      await evidenceList(["--store", storePath, "--table", "public.missing"]);
      expect(write.mock.calls.flat().join("")).toContain("No evidence bundles matched this view in the consulted ledger");
    } finally {
      write.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves plaintext Explore scope filters and reports command errors as command errors", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-filter-"));
    const storePath = path.join(tempDir, "local.db");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const key = crypto.randomBytes(32);
    const tenant = `keyed:${crypto.createHmac("sha256", key).update("northgate").digest("hex")}`;
    const principal = `keyed:${crypto.createHmac("sha256", key).update("librarian@example.org").digest("hex")}`;
    await fs.mkdir(path.join(tempDir, ".synapsor"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".synapsor/explore-audit.key"), key.toString("base64url"));
    const store = new ProposalStore(storePath);
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_scope_filter",
      tenant_id: tenant,
      payload: {
        schema_version: "synapsor.analytics-evidence.v1",
        principal,
        capability: "app.explore_data",
        source_id: "library_mysql",
        source_table: "librarydb.members",
        boundary_digest: `sha256:${"a".repeat(64)}`,
        query_fingerprint: "sha256:query",
        outcome: "ok",
        result_values_persisted: false,
      },
      query_audit: [],
    });
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_scope_filter_legacy",
      tenant_id: tenant,
      payload: {
        schema_version: "synapsor.analytics-evidence.v1",
        capability: "app.explore_data",
        source_id: "library_mysql",
        source_table: "librarydb.members",
        boundary_digest: `sha256:${"a".repeat(64)}`,
        query_fingerprint: "sha256:legacy-query",
        outcome: "ok",
        trusted_scope: { principal_bound: true, values_persisted: false },
        result_values_persisted: false,
      },
      query_audit: [],
    });
    store.close();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await evidenceList([
        "--store", storePath,
        "--config", configPath,
        "--tenant", "northgate",
        "--principal", "librarian@example.org",
        "--resource", "librarydb.members",
        "--boundary", `sha256:${"a".repeat(64)}`,
        "--since", "3650d",
        "--json",
      ]);
      const output = JSON.parse(write.mock.calls.flat().join(""));
      expect(output.evidence).toEqual([expect.objectContaining({ evidence_bundle_id: "ev_scope_filter" })]);
      expect(JSON.stringify(output)).not.toContain("northgate");
      expect(JSON.stringify(output)).not.toContain("librarian@example.org");

      write.mockClear();
      await activitySearch([
        "--store", storePath,
        "--config", configPath,
        "--tenant", "northgate",
        "--principal", "librarian@example.org",
        "--resource", "librarydb.members",
        "--outcome", "ok",
        "--since", "3650d",
        "--json",
      ]);
      const activity = JSON.parse(write.mock.calls.flat().join(""));
      expect(activity.interactions).toEqual([
        expect.objectContaining({ kind: "evidence", evidence: "ev_scope_filter" }),
      ]);
      expect(JSON.stringify(activity)).not.toContain("northgate");
      expect(JSON.stringify(activity)).not.toContain("librarian@example.org");

      write.mockClear();
      await evidenceList([
        "--store", storePath,
        "--config", configPath,
        "--principal", "different-librarian@example.org",
        "--resource", "librarydb.members",
      ]);
      const principalEmpty = write.mock.calls.flat().join("");
      expect(principalEmpty).toMatch(/No keyed principal record matched/);
      expect(principalEmpty).toMatch(/legacy evidence record only states whether principal scope was bound/);
      expect(principalEmpty).toMatch(/does not rule out older activity/);
      expect(principalEmpty).not.toContain("different-librarian@example.org");

      await expect(evidenceList([
        "--store", storePath,
        "--outcome", "refused",
      ])).rejects.toThrow(/query-audit list --outcome refused/);
      await expect(evidenceShow([
        "ev_missing",
        "--store", storePath,
      ])).rejects.toThrow("evidence bundle not found: ev_missing");
      await expect(evidenceShow([
        "8",
        "--store", storePath,
      ])).rejects.toThrow(/looks like a query-audit ID.*query-audit show 8 --details/);
    } finally {
      write.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps evidence-browser filters private and supports bounded in-session navigation", () => {
    const initial = ["--config", "./synapsor.runner.json", "--principal", "private@example.org"];
    const searched = evidenceBrowserCommand(initial, 10, "/membership tier");
    expect(searched).toMatchObject({ pageNumber: 1, pageSize: 10 });
    expect(searched?.args).toContain("--search");
    expect(searched?.args).toContain("membership tier");
    expect(evidenceBrowserFilterSummary(searched?.args ?? [])).toContain("principal applied");
    expect(evidenceBrowserFilterSummary(searched?.args ?? [])).not.toContain("private@example.org");
    expect(evidenceBrowserFilterSummary([], "all query-audit records")).toBe("Filters: all query-audit records");

    const scoped = evidenceBrowserCommand(searched?.args ?? [], 10, "resource librarydb.members");
    expect(scoped?.args).toEqual(expect.arrayContaining(["--resource", "librarydb.members"]));
    expect(evidenceBrowserCommand(scoped?.args ?? [], 10, "outcome fully_suppressed")?.args)
      .toEqual(expect.arrayContaining(["--status", "fully_suppressed"]));
    expect(evidenceBrowserCommand(initial, 10, "size 25")).toMatchObject({ pageSize: 25, pageNumber: 1 });
    expect(evidenceBrowserCommand(initial, 10, "page 8")).toMatchObject({ pageSize: 10, pageNumber: 8 });
    expect(evidenceBrowserCommand(initial, 10, "size 500")).toBeUndefined();
    expect(evidenceBrowserCommand(initial, 10, "outcome refused")).toBeUndefined();
    expect(evidenceBrowserCommand(initial, 10, "outcome refused", true)?.args)
      .toEqual(expect.arrayContaining(["--outcome", "refused"]));
  });
});
