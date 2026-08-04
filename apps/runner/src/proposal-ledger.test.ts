import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseFreshnessProof, protocolVersions } from "@synapsor-runner/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reusableRecordedFreshness } from "./proposal-ledger.js";


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
});
