import {
  type SQLInputValue,
} from "node:sqlite";
import {
  canonicalJsonDigest,
  protocolVersions,
} from "@synapsor-runner/protocol";
import {
  type OperatorIdentityProof,
  type StoredWritebackReceipt,
  type ProposalReplayRecord,
  type OperationalMetricRow,
  type PolicyRecommendationStatus,
  type PolicyRecommendation,
  type CreatePolicyRecommendationInput,
  type FleetEventMetricRow,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  rowToPolicyRecommendation,
  policyRecommendationUnsigned,
  assertPolicyRecommendationShape,
  assertPolicyRecommendationIdentity,
  rowToReceipt,
} from "./record-codecs.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreMetricsPolicyMethods,
  ProposalStoreMetricsPolicyInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreMetricsPolicyMethods: ProposalStoreMetricsPolicyMethods & ProposalStoreMetricsPolicyInternalMethods & ThisType<ProposalStoreMethodContext> = {
  operationalMetrics(filters: { tenant?: string; capability?: string } = {}): OperationalMetricRow[] {
      const rows = new Map<string, OperationalMetricRow>();
      const ensure = (tenantId: string, capability: string) => {
        const key = `${tenantId}\u0000${capability}`;
        let row = rows.get(key);
        if (!row) {
          row = { tenant_id: tenantId, capability, proposals: 0, approvals: 0, rejections: 0, applies: 0, conflicts: 0, failures: 0, revert_proposals: 0, revert_applies: 0 };
          rows.set(key, row);
        }
        return row;
      };
      for (const proposal of this.listProposals({ tenant: filters.tenant, capability: filters.capability })) {
        const row = ensure(proposal.tenant_id, proposal.action);
        row.proposals += 1;
        if (proposal.change_set.schema_version === protocolVersions.compensationChangeSet) row.revert_proposals += 1;
      }
      const approvalRows = this.db.prepare(`
        SELECT p.tenant_id, p.action, a.status, COUNT(*) AS count
        FROM approvals a JOIN proposals p ON p.proposal_id = a.proposal_id
        WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
        GROUP BY p.tenant_id, p.action, a.status
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
      for (const raw of approvalRows) {
        if (!isRecord(raw)) continue;
        const row = ensure(String(raw.tenant_id), String(raw.action));
        if (raw.status === "approved") row.approvals += Number(raw.count);
        if (raw.status === "rejected") row.rejections += Number(raw.count);
      }
      const receiptRows = this.db.prepare(`
        SELECT p.tenant_id, p.action, r.status, COUNT(*) AS count,
          SUM(CASE WHEN json_extract(p.change_set_json, '$.schema_version') = 'synapsor.compensation-change-set.v1' THEN 1 ELSE 0 END) AS revert_count
        FROM writeback_receipts r JOIN proposals p ON p.proposal_id = r.proposal_id
        WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
        GROUP BY p.tenant_id, p.action, r.status
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
      for (const raw of receiptRows) {
        if (!isRecord(raw)) continue;
        const row = ensure(String(raw.tenant_id), String(raw.action));
        const count = Number(raw.count);
        if (raw.status === "applied" || raw.status === "already_applied") row.applies += count;
        else if (raw.status === "conflict") row.conflicts += count;
        else if (raw.status === "failed") row.failures += count;
        if (raw.status === "applied" || raw.status === "already_applied") row.revert_applies += Number(raw.revert_count ?? 0);
      }
      return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
    },
  
  fleetEventMetrics(filters: { tenant?: string; capability?: string } = {}): FleetEventMetricRow[] {
      const rows = new Map<string, FleetEventMetricRow>();
      const ensure = (tenantId: string, capability: string) => {
        const key = `${tenantId}\u0000${capability}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            tenant_id: tenantId,
            capability,
            worker_retries: 0,
            dead_letters: 0,
            auto_approval_limit_trips: 0,
            freshness_checks: 0,
            freshness_fresh: 0,
            freshness_stale_target: 0,
            freshness_stale_supporting: 0,
            freshness_unavailable: 0,
            freshness_unsupported: 0,
            freshness_approval_blocked: 0,
            freshness_apply_blocked: 0,
          };
          rows.set(key, row);
        }
        return row;
      };
      const events = this.db.prepare(`
        SELECT p.tenant_id, p.action, e.kind, e.payload_json
        FROM proposal_events e JOIN proposals p ON p.proposal_id = e.proposal_id
        WHERE e.kind IN (
          'writeback_retry_scheduled',
          'writeback_dead_lettered',
          'policy_auto_approval_deferred',
          'proposal_freshness_checked',
          'proposal_approval_blocked_freshness',
          'writeback_conflict'
        )
          AND (? IS NULL OR p.tenant_id = ?)
          AND (? IS NULL OR p.action = ?)
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
      for (const raw of events) {
        if (!isRecord(raw)) continue;
        const row = ensure(String(raw.tenant_id), String(raw.action));
        if (raw.kind === "writeback_retry_scheduled") row.worker_retries += 1;
        if (raw.kind === "writeback_dead_lettered") row.dead_letters += 1;
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(raw.payload_json)) as unknown;
          if (isRecord(parsed)) payload = parsed;
        } catch {
          // Malformed historical payloads are ignored instead of becoming metric labels or scrape failures.
        }
        if (raw.kind === "proposal_freshness_checked") {
          row.freshness_checks += 1;
          const proof = isRecord(payload.proof) ? payload.proof : {};
          if (proof.result === "fresh") row.freshness_fresh += 1;
          if (proof.result === "unavailable") row.freshness_unavailable += 1;
          if (proof.result === "unsupported") row.freshness_unsupported += 1;
          if (proof.result === "stale") {
            const checks = Array.isArray(proof.checks) ? proof.checks.filter(isRecord) : [];
            if (checks.some((check) => check.kind === "target" && check.status === "stale")) row.freshness_stale_target += 1;
            if (checks.some((check) => check.kind === "supporting" && check.status === "stale")) row.freshness_stale_supporting += 1;
          }
        }
        if (raw.kind === "proposal_approval_blocked_freshness") row.freshness_approval_blocked += 1;
        if (raw.kind === "writeback_conflict" && /^FRESHNESS_/.test(String(payload.safe_error_code ?? ""))) row.freshness_apply_blocked += 1;
        if (raw.kind === "policy_auto_approval_deferred") {
          if (Array.isArray(payload.tripped_limits) && payload.tripped_limits.length > 0) row.auto_approval_limit_trips += 1;
        }
      }
      return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
    },
  
  receipts(proposalId: string): StoredWritebackReceipt[] {
      const rows = this.db
        .prepare("SELECT * FROM writeback_receipts WHERE proposal_id = ? ORDER BY receipt_id ASC")
        .all(proposalId);
      return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
    },
  
  replay(proposalId: string): ProposalReplayRecord {
      const proposal = this.requireProposal(proposalId);
      const replay: ProposalReplayRecord = {
        replay_id: `replay_${proposalId}`,
        proposal,
        approvals: this.approvals(proposalId),
        events: this.events(proposalId),
        receipts: this.receipts(proposalId),
        query_audit: this.queryAudit(proposalId),
        evidence: this.evidence(proposalId),
        generated_at: new Date().toISOString(),
      };
      this.db.prepare(`
        INSERT OR REPLACE INTO replay_records (replay_id, proposal_id, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(replay.replay_id, proposalId, JSON.stringify(replay), replay.generated_at);
      return replay;
    },
  
  createPolicyRecommendation(input: CreatePolicyRecommendationInput): PolicyRecommendation {
      const now = input.now ?? new Date().toISOString();
      const identity = {
        tenant_id: input.tenant_id,
        capability: input.capability,
        policy: input.policy,
        base_contract_digest: input.base_contract_digest,
        current_threshold: input.current_threshold,
        proposed_threshold: input.proposed_threshold,
        evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
        created_at: now,
      };
      const recommendationId = `ptr_${canonicalJsonDigest(identity).slice("sha256:".length, "sha256:".length + 20)}`;
      const unsigned = {
        schema_version: "synapsor.policy-recommendation.v1" as const,
        recommendation_id: recommendationId,
        ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
        ...(input.project_id ? { project_id: input.project_id } : {}),
        tenant_id: input.tenant_id,
        capability: input.capability,
        policy: input.policy,
        field: input.field,
        base_contract_digest: input.base_contract_digest,
        base_contract_version: input.base_contract_version,
        current_threshold: input.current_threshold,
        proposed_threshold: input.proposed_threshold,
        maximum_increment: input.maximum_increment,
        absolute_ceiling: input.absolute_ceiling,
        criteria: input.criteria,
        metrics: input.metrics,
        evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
        explanation: [...input.explanation],
        status: "pending_review" as const,
        created_at: now,
        updated_at: now,
      };
      const recommendation: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
      assertPolicyRecommendationShape(recommendation);
      assertNoSecretMaterial(recommendation, "policy_recommendation");
      this.db.prepare(`
        INSERT INTO policy_recommendations (
          recommendation_id, tenant_id, capability, policy, base_contract_digest,
          status, payload_json, integrity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recommendation.recommendation_id,
        recommendation.tenant_id,
        recommendation.capability,
        recommendation.policy,
        recommendation.base_contract_digest,
        recommendation.status,
        JSON.stringify(policyRecommendationUnsigned(recommendation)),
        recommendation.integrity_hash,
        recommendation.created_at,
        recommendation.updated_at,
      );
      return recommendation;
    },
  
  getPolicyRecommendation(recommendationId: string): PolicyRecommendation | undefined {
      return rowToPolicyRecommendation(this.db.prepare("SELECT * FROM policy_recommendations WHERE recommendation_id = ?").get(recommendationId));
    },
  
  listPolicyRecommendations(filters: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus } = {}): PolicyRecommendation[] {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      for (const [column, value] of [["tenant_id", filters.tenant], ["capability", filters.capability], ["policy", filters.policy], ["status", filters.status]] as const) {
        if (!value) continue;
        clauses.push(`${column} = ?`);
        params.push(value);
      }
      const sql = `SELECT * FROM policy_recommendations${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, recommendation_id DESC`;
      return this.db.prepare(sql).all(...params).map(rowToPolicyRecommendation).filter((item): item is PolicyRecommendation => item !== undefined);
    },
  
  decidePolicyRecommendation(
      recommendationId: string,
      input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string },
    ): PolicyRecommendation {
      const recommendation = this.requirePolicyRecommendation(recommendationId);
      if (recommendation.status !== "pending_review") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_PENDING", `policy recommendation ${recommendationId} is ${recommendation.status}`);
      assertPolicyRecommendationIdentity(recommendation, input);
      const now = input.now ?? new Date().toISOString();
      const unsigned = {
        ...policyRecommendationUnsigned(recommendation),
        status: input.action === "approve" ? "approved" as const : "rejected" as const,
        decision: { actor: input.actor, action: input.action, reason: input.reason, identity: input.identity, decided_at: now },
        updated_at: now,
      };
      const updated: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
      this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?")
        .run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
      return updated;
    },
  
  markPolicyRecommendationExported(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): PolicyRecommendation {
      const recommendation = this.requirePolicyRecommendation(recommendationId);
      if (recommendation.status !== "approved") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_APPROVED", `policy recommendation ${recommendationId} is ${recommendation.status}`);
      if (!/^sha256:[a-f0-9]{64}$/.test(input.artifact_digest)) throw new ProposalStoreError("POLICY_ARTIFACT_DIGEST_INVALID", "policy recommendation export requires a canonical SHA-256 artifact digest");
      const now = input.now ?? new Date().toISOString();
      const unsigned = {
        ...policyRecommendationUnsigned(recommendation),
        status: "exported" as const,
        export: { actor: input.actor, artifact_digest: input.artifact_digest, exported_at: now },
        updated_at: now,
      };
      const updated: PolicyRecommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
      this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?")
        .run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
      return updated;
    },
  
  requirePolicyRecommendation(recommendationId: string): PolicyRecommendation {
      const recommendation = this.getPolicyRecommendation(recommendationId);
      if (!recommendation) throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_FOUND", `policy recommendation not found: ${recommendationId}`);
      return recommendation;
    },
};
