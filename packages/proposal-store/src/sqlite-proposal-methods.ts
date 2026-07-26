import {
  parseChangeSet,
  parseFreshnessProof,
  type FreshnessProofV1,
} from "@synapsor-runner/protocol";
import {
  type LocalProposalState,
  type StoredProposal,
  type OperatorIdentityProof,
  type StoredApproval,
  type ApprovalProgress,
  type StoredWritebackReceipt,
  type ProposalReplayRecord,
  type StoredEvidenceBundle,
  type ProposalSearchFilters,
  type EvidenceSearchFilters,
  type QueryAuditSearchFilters,
  type ReceiptSearchFilters,
  type ActiveProposalLookup,
  type PolicyApprovalLimit,
  type PolicyApprovalLimitTrip,
  type PolicyApprovalDecision,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  stateFromChangeSet,
  proposalFreshnessAuthority,
  requiredApprovalCount,
  assertOperatorDecision,
  publicIdentitySummary,
  utcDayWindow,
  assertProposalIdentity,
  assertWritebackAllowed,
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  buildProposalQuery,
  buildProposalCountQuery,
  buildEvidenceQuery,
  buildQueryAuditQuery,
  buildReceiptQuery,
} from "./query-builders.js";
import {
  rowToProposal,
  rowToApproval,
  rowToReceipt,
  rowToStoredReplay,
  rowToQueryAudit,
} from "./record-codecs.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreProposalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreProposalsMethods: ProposalStoreProposalMethods & ThisType<ProposalStoreMethodContext> = {
  createProposal(input: unknown): StoredProposal {
      const changeSet = parseChangeSet(input);
      assertNoSecretMaterial(changeSet, "change_set");
      const existing = this.getProposal(changeSet.proposal_id);
      if (existing) {
        if (
          existing.proposal_version !== changeSet.proposal_version ||
          existing.proposal_hash !== changeSet.integrity.proposal_hash
        ) {
          throw new ProposalStoreError(
            "PROPOSAL_IMMUTABILITY_VIOLATION",
            `proposal ${changeSet.proposal_id} already exists with a different version or hash`,
          );
        }
        return existing;
      }
  
      const active = this.findActiveProposal({
        tenant_id: changeSet.scope.tenant_id,
        action: changeSet.action,
        business_object: changeSet.scope.business_object,
        object_id: changeSet.scope.object_id,
      });
      if (active) {
        throw new ProposalStoreError(
          "PROPOSAL_ALREADY_EXISTS",
          `active proposal ${active.proposal_id} is ${active.state} for ${active.business_object}:${active.object_id}`,
        );
      }
  
      const state = stateFromChangeSet(changeSet);
      const now = changeSet.created_at || new Date().toISOString();
      const insert = this.db.prepare(`
        INSERT INTO proposals (
          proposal_id,
          proposal_version,
          proposal_hash,
          action,
          state,
          tenant_id,
          principal,
          capability,
          interaction_id,
          tool_call_id,
          business_object,
          object_id,
          source_kind,
          source_id,
          source_schema,
          source_table,
          source_database_mutated,
          change_set_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.transaction(() => {
        insert.run(
          changeSet.proposal_id,
          changeSet.proposal_version,
          changeSet.integrity.proposal_hash,
          changeSet.action,
          state,
          changeSet.scope.tenant_id,
          changeSet.principal.id,
          changeSet.action,
          null,
          null,
          changeSet.scope.business_object,
          changeSet.scope.object_id,
          changeSet.source.kind,
          changeSet.source.source_id,
          changeSet.source.schema,
          changeSet.source.table,
          changeSet.source_database_mutated ? 1 : 0,
          JSON.stringify(changeSet),
          now,
          now,
        );
        this.appendEvent(changeSet.proposal_id, "proposal_created", changeSet.principal.id, {
          proposal_hash: changeSet.integrity.proposal_hash,
          proposal_version: changeSet.proposal_version,
          source_database_mutated: changeSet.source_database_mutated,
        });
        if (changeSet.mode === "shadow") {
          this.attachShadowChangeSetToActiveStudies(changeSet, now);
        }
      });
      const created = this.getProposal(changeSet.proposal_id);
      if (!created) {
        throw new ProposalStoreError("PROPOSAL_CREATE_FAILED", `proposal ${changeSet.proposal_id} was not persisted`);
      }
      return created;
    },
  
  getProposal(proposalId: string): StoredProposal | undefined {
      const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
      return rowToProposal(row);
    },
  
  findActiveProposal(input: ActiveProposalLookup): StoredProposal | undefined {
      const row = this.db.prepare(`
        SELECT * FROM proposals
        WHERE tenant_id = ?
          AND action = ?
          AND business_object = ?
          AND object_id = ?
          AND state IN ('pending_review', 'approved', 'pending_worker')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(input.tenant_id, input.action, input.business_object, input.object_id);
      return rowToProposal(row);
    },
  
  listProposals(filters?: LocalProposalState | ProposalSearchFilters): StoredProposal[] {
      if (typeof filters === "string") filters = { state: filters };
      const query = buildProposalQuery(filters ?? {});
      const rows = this.db.prepare(query.sql).all(...query.params);
      return rows.map((row) => rowToProposal(row)).filter((proposal): proposal is StoredProposal => proposal !== undefined);
    },
  
  countProposals(filters: ProposalSearchFilters = {}): number {
      const query = buildProposalCountQuery(filters);
      const row = this.db.prepare(query.sql).get(...query.params);
      return isRecord(row) ? Number(row.count ?? 0) : 0;
    },
  
  listEvidenceBundles(filters: EvidenceSearchFilters = {}): StoredEvidenceBundle[] {
      const query = buildEvidenceQuery(filters);
      const rows = this.db.prepare(query.sql).all(...query.params);
      return rows.map((row) => this.rowToEvidenceBundle(row)).filter((evidence): evidence is StoredEvidenceBundle => evidence !== undefined);
    },
  
  listQueryAudit(filters: QueryAuditSearchFilters = {}): Record<string, unknown>[] {
      const query = buildQueryAuditQuery(filters);
      const rows = this.db.prepare(query.sql).all(...query.params);
      return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
    },
  
  getQueryAudit(auditId: number): Record<string, unknown> | undefined {
      return rowToQueryAudit(this.db.prepare("SELECT * FROM query_audit WHERE audit_id = ?").get(auditId));
    },
  
  listReceipts(filters: ReceiptSearchFilters = {}): StoredWritebackReceipt[] {
      const query = buildReceiptQuery(filters);
      const rows = this.db.prepare(query.sql).all(...query.params);
      return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
    },
  
  getReceipt(receiptId: number): StoredWritebackReceipt | undefined {
      return rowToReceipt(this.db.prepare("SELECT * FROM writeback_receipts WHERE receipt_id = ?").get(receiptId));
    },
  
  getReplayByReplayId(replayId: string): ProposalReplayRecord {
      const prefix = "replay_";
      const proposalId = replayId.startsWith(prefix) ? replayId.slice(prefix.length) : replayId;
      return this.replay(proposalId);
    },
  
  getStoredReplay(replayId: string): ProposalReplayRecord | undefined {
      const row = this.db.prepare("SELECT * FROM replay_records WHERE replay_id = ?").get(replayId);
      return rowToStoredReplay(row);
    },
  
  getStoredReplayForProposal(proposalId: string): ProposalReplayRecord | undefined {
      const row = this.db.prepare(`
        SELECT * FROM replay_records
        WHERE proposal_id = ?
        ORDER BY created_at DESC, replay_id DESC
        LIMIT 1
      `).get(proposalId);
      return rowToStoredReplay(row);
    },
  
  proposalIdForEvidence(evidenceBundleId: string): string | undefined {
      const evidence = this.getEvidenceBundle(evidenceBundleId);
      if (evidence?.proposal_id) return evidence.proposal_id;
      const row = this.db
        .prepare("SELECT proposal_id FROM query_audit WHERE evidence_bundle_id = ? AND proposal_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
        .get(evidenceBundleId);
      return isRecord(row) && row.proposal_id != null ? String(row.proposal_id) : undefined;
    },
  
  recordFreshnessProof(input: unknown): FreshnessProofV1 {
      const proof = parseFreshnessProof(input);
      const proposal = this.requireProposal(proof.proposal_id);
      assertProposalIdentity(proposal, proof.proposal_hash, proof.proposal_version);
      const authority = proposalFreshnessAuthority(proposal);
      if (!authority) {
        throw new ProposalStoreError(
          "FRESHNESS_NOT_REQUIRED",
          `proposal ${proof.proposal_id} has no reviewed freshness authority`,
        );
      }
      if (proof.dependency_set_digest !== authority.dependency_set_digest) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_AUTHORITY_MISMATCH",
          `freshness proof does not match proposal ${proof.proposal_id}`,
        );
      }
      const now = new Date().toISOString();
      this.transaction(() => {
        this.appendEvent(proof.proposal_id, "proposal_freshness_checked", "runner", { proof });
        if (proof.result === "stale") {
          const current = this.requireProposal(proof.proposal_id);
          if (current.state === "pending_review" || current.state === "approved" || current.state === "pending_worker") {
            this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?")
              .run("conflict", now, proof.proposal_id);
            this.appendEvent(proof.proposal_id, "proposal_conflict", "runner", {
              reason: "freshness_stale",
              safe_code: proof.safe_code,
              proof_digest: proof.proof_digest,
            });
          }
        }
      });
      return proof;
    },
  
  latestFreshnessProof(proposalId: string): FreshnessProofV1 | undefined {
      this.requireProposal(proposalId);
      const row = this.db.prepare(`
        SELECT payload_json
        FROM proposal_events
        WHERE proposal_id = ? AND kind = 'proposal_freshness_checked'
        ORDER BY event_id DESC
        LIMIT 1
      `).get(proposalId);
      if (!isRecord(row)) return undefined;
      try {
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        return parseFreshnessProof(payload.proof);
      } catch {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_TAMPERED",
          `stored freshness proof for proposal ${proposalId} failed integrity validation`,
        );
      }
    },
  
  recordFreshnessApprovalBlocked(
      proposalId: string,
      input: { proof_digest: string; safe_code: string; actor: string },
    ): void {
      this.requireProposal(proposalId);
      const proof = this.latestFreshnessProof(proposalId);
      if (!proof || proof.proof_digest !== input.proof_digest || proof.result === "fresh") {
        throw new ProposalStoreError(
          "FRESHNESS_BLOCK_RECORD_INVALID",
          `freshness block for proposal ${proposalId} does not match its latest non-fresh proof`,
        );
      }
      this.appendEvent(proposalId, "proposal_approval_blocked_freshness", input.actor, {
        proof_digest: proof.proof_digest,
        safe_code: input.safe_code,
        result: proof.result,
      });
    },
  
  approveProposal(
      proposalId: string,
      options: {
        approver: string;
        proposal_hash: string;
        proposal_version: number;
        reason?: string;
        identity?: OperatorIdentityProof;
        require_verified_identity?: boolean;
        freshness_proof_digest?: string;
      },
    ): StoredProposal {
      const proposal = this.requireProposal(proposalId);
      assertWritebackAllowed(proposal, "approved");
      assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
      if (proposal.state !== "pending_review") {
        throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
      }
      assertOperatorDecision(proposal, "approve", options.approver, options.identity, options.require_verified_identity === true);
      const now = new Date().toISOString();
      this.transaction(() => {
        const current = this.requireProposal(proposalId);
        if (current.state !== "pending_review") {
          throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${current.state}`);
        }
        const existing = this.db.prepare(`
          SELECT status FROM approvals WHERE proposal_id = ? AND approver = ? ORDER BY approval_id DESC LIMIT 1
        `).get(proposalId, options.approver);
        if (isRecord(existing)) {
          throw new ProposalStoreError("APPROVER_ALREADY_COUNTED", `operator ${options.approver} already recorded a decision for proposal ${proposalId}`);
        }
        this.assertApprovalFreshness(current, options.freshness_proof_digest, now);
        this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            identity_json, decision_hash, signature, integrity_hash, freshness_proof_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposalId,
          options.proposal_version,
          options.proposal_hash,
          options.approver,
          "approved",
          options.reason ?? null,
          options.identity ? JSON.stringify(options.identity) : null,
          options.identity?.decision_hash ?? null,
          options.identity?.signature ?? null,
          options.identity?.integrity_hash ?? null,
          options.freshness_proof_digest ?? null,
          now,
        );
        const progress = this.approvalProgress(proposalId);
        const complete = progress.approved >= progress.required;
        if (complete) {
          this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
        }
        this.appendEvent(proposalId, complete ? "proposal_approved" : "proposal_approval_recorded", options.approver, {
          proposal_hash: options.proposal_hash,
          proposal_version: options.proposal_version,
          reason: options.reason ?? null,
          identity: publicIdentitySummary(options.identity),
          freshness_proof_digest: options.freshness_proof_digest ?? null,
          approvals: progress.approved,
          required_approvals: progress.required,
          remaining_approvals: progress.remaining,
        });
      });
      return this.requireProposal(proposalId);
    },
  
  approveProposalByPolicy(
      proposalId: string,
      options: {
        policy: string;
        proposal_hash: string;
        proposal_version: number;
        reason: string;
        limits?: PolicyApprovalLimit[];
        now?: string;
        freshness_proof_digest?: string;
      },
    ): PolicyApprovalDecision {
      const actor = `policy:${options.policy}`;
      const now = options.now ?? new Date().toISOString();
      const window = utcDayWindow(now);
      const trippedLimits: PolicyApprovalLimitTrip[] = [];
      const nearLimits: PolicyApprovalLimitTrip[] = [];
      let quorumDeferred = false;
      this.transaction(() => {
        const proposal = this.requireProposal(proposalId);
        assertWritebackAllowed(proposal, "approved by policy");
        assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
        if (proposal.state !== "pending_review") {
          throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
        }
        const requiredApprovals = requiredApprovalCount(proposal);
        if (requiredApprovals > 1) {
          quorumDeferred = true;
          this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
            policy: options.policy,
            fallback: "human_review",
            reason: "multi_reviewer_quorum_requires_verified_human_approvals",
            approvals: 0,
            required_approvals: requiredApprovals,
          });
          return;
        }
        for (const limit of options.limits ?? []) {
          const scope = limit.scope ?? "tenant_policy";
          const rows = this.db.prepare(`
            SELECT p.change_set_json
            FROM approvals a
            JOIN proposals p ON p.proposal_id = a.proposal_id
            WHERE a.approver = ?
              AND a.status = 'approved'
              AND p.tenant_id = ?
              AND a.created_at >= ?
              AND a.created_at < ?
              ${scope === "tenant_policy_object" ? "AND p.business_object = ? AND p.object_id = ?" : ""}
          `).all(
            actor,
            proposal.tenant_id,
            window.start,
            window.end,
            ...(scope === "tenant_policy_object" ? [proposal.business_object, proposal.object_id] : []),
          );
          if (limit.kind === "count") {
            const projected = rows.length + 1;
            if (projected > limit.max) {
              trippedLimits.push({
                ...limit,
                scope,
                observed: rows.length,
                proposed: 1,
                projected,
                window_start: window.start,
                window_end: window.end,
                reason: `${scope} daily auto-approval count ${projected} exceeds ${limit.max}`,
              });
            } else if (projected / limit.max >= 0.8) {
              nearLimits.push({
                ...limit,
                scope,
                observed: rows.length,
                proposed: 1,
                projected,
                window_start: window.start,
                window_end: window.end,
                reason: `${scope} daily auto-approval count ${projected} is approaching ${limit.max}`,
              });
            }
            continue;
          }
          const field = limit.field;
          const proposed = field ? proposal.change_set.patch[field] : undefined;
          let observed = 0;
          let invalidHistory = false;
          for (const row of rows) {
            if (!isRecord(row)) {
              invalidHistory = true;
              continue;
            }
            try {
              const historical = parseChangeSet(JSON.parse(String(row.change_set_json)));
              const value = field ? historical.patch[field] : undefined;
              if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidHistory = true;
              else observed += value;
            } catch {
              invalidHistory = true;
            }
          }
          const proposedNumber = typeof proposed === "number" && Number.isSafeInteger(proposed) ? proposed : 0;
          const projected = observed + proposedNumber;
          if (!field || invalidHistory || typeof proposed !== "number" || !Number.isSafeInteger(proposed) || projected > limit.max) {
            trippedLimits.push({
              ...limit,
              scope,
              observed,
              proposed: proposedNumber,
              projected,
              window_start: window.start,
              window_end: window.end,
              reason: invalidHistory || !field || typeof proposed !== "number" || !Number.isSafeInteger(proposed)
                ? `${scope} daily auto-approval total could not be verified safely${field ? ` for ${field}` : ""}`
                : `${scope} daily auto-approval total ${projected} for ${field} exceeds ${limit.max}`,
            });
          } else if (projected / limit.max >= 0.8) {
            nearLimits.push({
              ...limit,
              scope,
              observed,
              proposed: proposedNumber,
              projected,
              window_start: window.start,
              window_end: window.end,
              reason: `${scope} daily auto-approval total is approaching its reviewed maximum`,
            });
          }
        }
        if (trippedLimits.length > 0) {
          this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
            policy: options.policy,
            fallback: "human_review",
            tripped_limits: trippedLimits,
          });
          return;
        }
        this.assertApprovalFreshness(proposal, options.freshness_proof_digest, now);
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
        this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            freshness_proof_digest, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposalId,
          options.proposal_version,
          options.proposal_hash,
          actor,
          "approved",
          options.reason,
          options.freshness_proof_digest ?? null,
          now,
        );
        this.appendEvent(proposalId, "proposal_approved", actor, {
          proposal_hash: options.proposal_hash,
          proposal_version: options.proposal_version,
          reason: options.reason,
          policy: options.policy,
          aggregate_limits: options.limits ?? [],
          freshness_proof_digest: options.freshness_proof_digest ?? null,
        });
        for (const near of nearLimits) {
          this.appendEvent(proposalId, "policy_limit_near", actor, {
            policy: options.policy,
            kind: near.kind,
            scope: near.scope,
            observed: near.observed,
            proposed: near.proposed,
            projected: near.projected,
            max: near.max,
            window_start: near.window_start,
            window_end: near.window_end,
          });
        }
      });
      return {
        proposal: this.requireProposal(proposalId),
        approved: !quorumDeferred && trippedLimits.length === 0,
        policy: options.policy,
        tripped_limits: trippedLimits,
      };
    },
  
  rejectProposal(
      proposalId: string,
      options: {
        actor: string;
        proposal_hash: string;
        proposal_version: number;
        reason: string;
        identity?: OperatorIdentityProof;
        require_verified_identity?: boolean;
      },
    ): StoredProposal {
      const proposal = this.requireProposal(proposalId);
      assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
      if (proposal.state !== "pending_review" && proposal.state !== "approved") {
        throw new ProposalStoreError("PROPOSAL_NOT_REJECTABLE", `proposal ${proposalId} is ${proposal.state}`);
      }
      assertOperatorDecision(proposal, "reject", options.actor, options.identity, options.require_verified_identity === true);
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("rejected", now, proposalId);
        this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            identity_json, decision_hash, signature, integrity_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposalId,
          options.proposal_version,
          options.proposal_hash,
          options.actor,
          "rejected",
          options.reason,
          options.identity ? JSON.stringify(options.identity) : null,
          options.identity?.decision_hash ?? null,
          options.identity?.signature ?? null,
          options.identity?.integrity_hash ?? null,
          now,
        );
        this.appendEvent(proposalId, "proposal_rejected", options.actor, {
          proposal_hash: options.proposal_hash,
          proposal_version: options.proposal_version,
          reason: options.reason,
          identity: publicIdentitySummary(options.identity),
        });
      });
      return this.requireProposal(proposalId);
    },
  
  approvals(proposalId: string): StoredApproval[] {
      return this.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? ORDER BY approval_id ASC")
        .all(proposalId)
        .map(rowToApproval)
        .filter((approval): approval is StoredApproval => approval !== undefined);
    },
  
  approvalProgress(proposalId: string): ApprovalProgress {
      const proposal = this.requireProposal(proposalId);
      const required = requiredApprovalCount(proposal);
      const row = this.db.prepare(`
        SELECT
          COUNT(DISTINCT CASE WHEN status = 'approved' THEN approver END) AS approved,
          MAX(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
        FROM approvals
        WHERE proposal_id = ?
      `).get(proposalId);
      const approved = isRecord(row) ? Number(row.approved ?? 0) : 0;
      const rejected = proposal.state === "rejected" || (isRecord(row) && Number(row.rejected ?? 0) === 1);
      return {
        approved,
        required,
        remaining: Math.max(0, required - approved),
        rejected,
        complete: !rejected && approved >= required,
      };
    },
  
  recordOperatorAuthorization(proposalId: string, identity: OperatorIdentityProof, requireVerifiedIdentity = false): void {
      const proposal = this.requireProposal(proposalId);
      assertOperatorDecision(proposal, "apply", identity.subject, identity, requireVerifiedIdentity);
      this.appendEvent(proposalId, "writeback_authorized", identity.subject, {
        identity: publicIdentitySummary(identity),
        decision_hash: identity.decision_hash,
        signature: identity.signature,
        integrity_hash: identity.integrity_hash,
      });
    },
  
  markPendingWorker(proposalId: string, proposalHash: string, proposalVersion: number): StoredProposal {
      const proposal = this.requireProposal(proposalId);
      assertWritebackAllowed(proposal, "moved to pending worker");
      assertProposalIdentity(proposal, proposalHash, proposalVersion);
      if (proposal.state !== "approved") {
        throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
      }
      this.setState(proposalId, "pending_worker", "runner", { proposal_hash: proposalHash, proposal_version: proposalVersion });
      return this.requireProposal(proposalId);
    },
};
