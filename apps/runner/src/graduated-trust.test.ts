import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProposalStore, type OperatorIdentityProof, type PolicyRecommendation } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { normalizeContract, type SynapsorContract } from "@synapsor/spec";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  decideGraduatedTrustRecommendation,
  evaluateGraduatedTrust,
  markGraduatedTrustArtifactExported,
  prepareGraduatedTrustArtifact,
} from "./graduated-trust.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("graduated trust", () => {
  it("is disabled by default and requires the reviewed human sample", async () => {
    const contract = fixtureContract();
    const store = new ProposalStore();
    try {
      expect(await evaluateGraduatedTrust({ config: config(false), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now })).toMatchObject({
        ok: false,
        code: "GRADUATED_TRUST_DISABLED",
      });
      seedHumanHistory(store, contract, 9);
      expect(await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now })).toMatchObject({
        ok: false,
        code: "INSUFFICIENT_HUMAN_REVIEWS",
        metrics: { human_reviewed: 9 },
      });
    } finally {
      store.close();
    }
  });

  it("creates a scoped pending recommendation while excluding policy auto-approvals", async () => {
    const contract = fixtureContract();
    const store = new ProposalStore();
    try {
      seedHumanHistory(store, contract, 10);
      seedProposal(store, contract, { id: "auto", tenant: "acme", auto: true });
      seedProposal(store, contract, { id: "other_tenant", tenant: "globex", rejected: true });

      const result = await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now });
      expect(result).toMatchObject({
        ok: true,
        code: "RECOMMENDATION_CREATED",
        metrics: {
          human_reviewed: 10,
          human_approved: 10,
          human_rejected: 0,
          auto_approved_excluded: 1,
        },
        recommendation: {
          status: "pending_review",
          current_threshold: 2500,
          proposed_threshold: 3000,
          absolute_ceiling: 5000,
        },
      });
      expect(result.recommendation?.tenant_id).toBe("acme");
      expect(result.recommendation?.evidence_proposal_ids).toHaveLength(10);
      expect(result.recommendation?.explanation.join(" ")).toContain("does not activate");

      const again = await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now });
      expect(again.recommendation?.recommendation_id).toBe(result.recommendation?.recommendation_id);
    } finally {
      store.close();
    }
  });

  it("fails closed on rejection-rate, contract-scope, and operator kill-switch gates", async () => {
    const contract = fixtureContract();
    const store = new ProposalStore();
    try {
      seedHumanHistory(store, contract, 9);
      seedProposal(store, contract, { id: "rejected", tenant: "acme", rejected: true });
      expect(await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now })).toMatchObject({ code: "REJECTION_RATE_EXCEEDED" });

      const killed = config(true);
      killed.graduated_trust!.kill_switch = true;
      expect(await evaluateGraduatedTrust({ config: killed, contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now })).toMatchObject({ code: "GRADUATED_TRUST_KILL_SWITCH" });

      store.db.prepare("UPDATE proposals SET change_set_json = json_set(change_set_json, '$.contract.digest', ?) WHERE proposal_id = ?")
        .run(canonicalJsonDigest({ wrong: true }), "wrp_1");
      expect(await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now })).toMatchObject({ code: "HISTORY_SCOPE_INCOMPLETE" });
    } finally {
      store.close();
    }
  });

  it("requires verified human approval, refuses stale bases, and exports without activation", async () => {
    const contract = fixtureContract();
    const store = new ProposalStore();
    try {
      seedHumanHistory(store, contract, 10);
      const evaluation = await evaluateGraduatedTrust({ config: config(true), contract, store, tenant: "acme", capability: capabilityName, policy: policyName, now });
      const pending = evaluation.recommendation!;
      await expect(decideGraduatedTrustRecommendation({
        store,
        recommendationId: pending.recommendation_id,
        action: "approve",
        actor: "policy_reviewer",
        reason: "reviewed metrics",
        identity: identity(pending, "approve", false),
      })).rejects.toThrow(/verified operator/i);

      const approved = await decideGraduatedTrustRecommendation({
        store,
        recommendationId: pending.recommendation_id,
        action: "approve",
        actor: "policy_reviewer",
        reason: "reviewed metrics and ceiling",
        identity: identity(pending, "approve", true),
      });
      expect(approved.status).toBe("approved");

      const stale = structuredClone(contract);
      stale.metadata = { ...(stale.metadata ?? {}), version: "changed" };
      await expect(prepareGraduatedTrustArtifact({ store, recommendationId: approved.recommendation_id, activeContract: stale })).rejects.toThrow(/STALE_POLICY_RECOMMENDATION_BASE/);

      const artifact = await prepareGraduatedTrustArtifact({ store, recommendationId: approved.recommendation_id, activeContract: contract });
      expect(artifact.diff).toEqual({ field: "plan_credit_cents", before: 2500, after: 3000 });
      expect(artifact.contract.policies?.[0]?.rules?.[0]?.max).toBe(3000);
      expect(contract.policies?.[0]?.rules?.[0]?.max).toBe(2500);

      const exported = await markGraduatedTrustArtifactExported({
        store,
        recommendationId: approved.recommendation_id,
        actor: "policy_reviewer",
        artifactDigest: artifact.digest,
      });
      expect(exported.status).toBe("exported");
      expect(exported.export?.artifact_digest).toBe(artifact.digest);
    } finally {
      store.close();
    }
  });
});

const capabilityName = "support.propose_plan_credit";
const policyName = "support_propose_plan_credit_auto_approval";
const now = "2026-07-14T12:00:00.000Z";

function fixtureContract(): SynapsorContract {
  return normalizeContract(JSON.parse(fs.readFileSync(path.join(root, "packages/spec/fixtures/conformance/auto-approval/contract.json"), "utf8")));
}

function config(enabled: boolean): RuntimeConfig {
  return {
    version: 1,
    mode: "review",
    graduated_trust: {
      enabled,
      workspace_id: "ws_demo",
      project_id: "prj_demo",
      criteria: [{
        capability: capabilityName,
        policy: policyName,
        field: "plan_credit_cents",
        minimum_human_reviews: 10,
        window_days: 30,
        maximum_rejection_rate: 0.05,
        maximum_conflict_rate: 0.05,
        maximum_failure_rate: 0.05,
        maximum_revert_rate: 0.05,
        maximum_threshold_increase: 500,
        absolute_ceiling: 5000,
      }],
    },
  };
}

function seedHumanHistory(store: ProposalStore, contract: SynapsorContract, count: number): void {
  for (let index = 1; index <= count; index += 1) seedProposal(store, contract, { id: String(index), tenant: "acme" });
}

function seedProposal(store: ProposalStore, contract: SynapsorContract, input: { id: string; tenant: string; rejected?: boolean; auto?: boolean }): void {
  const proposalId = `wrp_${input.id}`;
  const proposalHash = canonicalJsonDigest({ proposalId });
  const createdAt = `2026-07-${String(Math.max(1, Math.min(13, Number.parseInt(input.id, 10) || 12))).padStart(2, "0")}T12:00:00.000Z`;
  const changeSet = {
    schema_version: "synapsor.change-set.v1",
    proposal_id: proposalId,
    proposal_version: 1,
    action: capabilityName,
    contract: { digest: canonicalJsonDigest(contract), version: contract.metadata?.version ?? contract.spec_version },
    mode: "review_required",
    principal: { id: "support_agent", source: "trusted_session" },
    scope: { tenant_id: input.tenant, business_object: "customers", object_id: `CUS-${input.id}` },
    source: { kind: "external_postgres", source_id: "local_postgres", schema: "public", table: "customers", primary_key: { column: "id", value: `CUS-${input.id}` } },
    before: { plan_credit_cents: 0, updated_at: createdAt },
    patch: { plan_credit_cents: 1000 },
    after: { plan_credit_cents: 1000, updated_at: createdAt },
    guards: { tenant: { column: "tenant_id", value: input.tenant }, allowed_columns: ["plan_credit_cents"], expected_version: { column: "updated_at", value: createdAt } },
    evidence: { bundle_id: `ev_${input.id}`, query_fingerprint: canonicalJsonDigest({ evidence: input.id }), items: [] },
    approval: { status: "pending", required_role: "support_reviewer" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: proposalHash },
    created_at: createdAt,
  };
  store.createProposal(changeSet);
  if (input.auto) {
    store.approveProposalByPolicy(proposalId, { policy: policyName, proposal_hash: proposalHash, proposal_version: 1, reason: "fixture auto approval", now: createdAt });
  } else if (input.rejected) {
    store.rejectProposal(proposalId, { actor: "human_reviewer", proposal_hash: proposalHash, proposal_version: 1, reason: "fixture rejection" });
  } else {
    store.approveProposal(proposalId, { approver: "human_reviewer", proposal_hash: proposalHash, proposal_version: 1, reason: "fixture approval" });
  }
}

function identity(recommendation: PolicyRecommendation, action: "approve" | "reject", verified: boolean): OperatorIdentityProof {
  const decision = {
    schema_version: "synapsor.operator-decision.v1" as const,
    action,
    proposal_id: recommendation.recommendation_id,
    proposal_version: 1,
    proposal_hash: recommendation.integrity_hash,
    subject: "policy_reviewer",
    issued_at: "2026-07-14T12:05:00.000Z",
  };
  const core = {
    provider: "signed_key" as const,
    verified,
    subject: "policy_reviewer",
    roles: ["policy_reviewer"],
    key_id: "policy_reviewer",
    algorithm: "SHA256",
    decision,
    decision_hash: canonicalJsonDigest(decision),
    signature: "test-signature",
  };
  return { ...core, integrity_hash: canonicalJsonDigest(core) };
}
