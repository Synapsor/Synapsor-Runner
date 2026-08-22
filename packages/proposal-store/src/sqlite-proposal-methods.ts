import {
  enforcePrivacyBudgets,
  parseChangeSet,
  parseFreshnessProof,
  PrivacyBoundaryError,
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
  type ExplorePrivacyReleaseInput,
  type ExplorePrivacyReleaseDecision,
  type ExploreBudgetReservationInput,
  type ExploreBudgetReservationDecision,
  type ExploreBudgetUsage,
  type CompleteExploreBudgetReservationInput,
  type CompleteExploreBudgetReservationDecision,
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
import {
  normalizedExplorePrivacyReleaseClaims,
} from "./privacy-release.js";

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

  claimExplorePrivacyRelease(input: ExplorePrivacyReleaseInput): ExplorePrivacyReleaseDecision {
      const claims = normalizedExplorePrivacyReleaseClaims(input);
      if (claims.length === 0) return { allowed: true };
      return this.transaction(() => {
        for (const claim of claims) {
          const opposite = claim.release_kind === "scalar_total"
            ? "suppressed_grouping"
            : "scalar_total";
          const placeholders = claim.complement_fingerprints.map(() => "?").join(", ");
          const conflict = this.db.prepare(`
            SELECT release_kind
            FROM explore_privacy_releases
            WHERE scope_fingerprint = ?
              AND release_kind = ?
              AND complement_fingerprint IN (${placeholders})
            LIMIT 1
          `).get(input.scope_fingerprint, opposite, ...claim.complement_fingerprints);
          if (isRecord(conflict)) {
            return {
              allowed: false,
              conflicting_release_kind: opposite,
              ...(claim.conflict_reason
                ? { conflicting_release_reason: claim.conflict_reason }
                : {}),
            };
          }
        }
        const insert = this.db.prepare(`
          INSERT OR IGNORE INTO explore_privacy_releases (
            scope_fingerprint,
            complement_fingerprint,
            release_kind,
            query_fingerprint,
            boundary_digest,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        const now = new Date().toISOString();
        for (const claim of claims) {
          for (const fingerprint of claim.complement_fingerprints) {
            insert.run(
              input.scope_fingerprint,
              fingerprint,
              claim.release_kind,
              input.query_fingerprint,
              input.boundary_digest,
              now,
            );
          }
        }
        return { allowed: true };
      });
    },

  claimExploreBudgetReservation(input: ExploreBudgetReservationInput): ExploreBudgetReservationDecision {
      const now = parseBudgetTimestamp(input.now, "reservation time");
      assertBudgetReservationInput(input);
      return this.transaction(() => {
        this.db.prepare("DELETE FROM explore_budget_reservations WHERE created_at < ?")
          .run(new Date(now - EXPLORE_BUDGET_RETENTION_MS).toISOString());
        const usage = exploreBudgetUsage(this.db, input, now);
        const variants = exploreDifferencingVariants(this.db, input, now);
        const variantAlreadyCounted = variants.has(input.variant_fingerprint);
        try {
          enforcePrivacyBudgets({
            limits: input.limits,
            snapshot: {
              query_count: usage.query_count,
              queries_last_minute: usage.queries_last_minute,
              extracted_cells: usage.extracted_cells,
              differencing_attempts: variantAlreadyCounted
                ? Math.max(0, variants.size - 1)
                : variants.size,
            },
            estimated_response_cells: input.estimated_response_cells,
            aggregate: input.requires_differencing,
          });
        } catch (error) {
          if (!(error instanceof PrivacyBoundaryError)
            || !isExploreBudgetErrorCode(error.code)) {
            throw error;
          }
          return {
            allowed: false,
            code: error.code,
            message: error.message,
            usage: {
              ...usage,
              differencing_attempts: variants.size,
            },
          };
        }
        this.db.prepare(`
          INSERT INTO explore_budget_reservations (
            reservation_id,
            scope_fingerprint,
            resource_id,
            variant_fingerprint,
            requires_differencing,
            differencing_counted,
            reserved_cells,
            accounted_cells,
            status,
            created_at,
            completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
        `).run(
          input.reservation_id,
          input.scope_fingerprint,
          input.resource_id,
          input.variant_fingerprint,
          input.requires_differencing ? 1 : 0,
          input.requires_differencing ? 1 : 0,
          input.estimated_response_cells,
          input.estimated_response_cells,
          input.now,
        );
        return {
          allowed: true,
          usage_after_reservation: {
            query_count: usage.query_count + 1,
            queries_last_minute: usage.queries_last_minute + 1,
            extracted_cells: usage.extracted_cells + input.estimated_response_cells,
            differencing_attempts: variants.size
              + (input.requires_differencing && !variantAlreadyCounted ? 1 : 0),
          },
          variant_already_counted: variantAlreadyCounted,
        };
      });
    },

  completeExploreBudgetReservation(
    input: CompleteExploreBudgetReservationInput,
  ): CompleteExploreBudgetReservationDecision {
      parseBudgetTimestamp(input.completed_at, "completion time");
      if (!Number.isSafeInteger(input.returned_cells) || input.returned_cells < 0) {
        throw new ProposalStoreError(
          "EXPLORE_BUDGET_RESERVATION_INVALID",
          "Explore returned-cell accounting must be a non-negative safe integer.",
        );
      }
      return this.transaction(() => {
        const row = this.db.prepare(`
          SELECT status, requires_differencing, reserved_cells, accounted_cells
          FROM explore_budget_reservations
          WHERE reservation_id = ?
        `).get(input.reservation_id);
        if (!isRecord(row)) return { completed: false, reason: "reservation_missing" };
        const status = String(row.status);
        if (status !== "pending") {
          const sameOutcome = (status === "released") === input.result_released;
          const sameCells = Number(row.accounted_cells) === (input.result_released ? input.returned_cells : 0);
          return sameOutcome && sameCells
            ? { completed: true }
            : { completed: false, reason: "reservation_already_finalized" };
        }
        const reservedCells = Number(row.reserved_cells);
        if (input.result_released && input.returned_cells > reservedCells) {
          this.db.prepare(`
            UPDATE explore_budget_reservations
            SET status = 'not_released', differencing_counted = 0,
                accounted_cells = 0, completed_at = ?
            WHERE reservation_id = ? AND status = 'pending'
          `).run(input.completed_at, input.reservation_id);
          return { completed: false, reason: "response_exceeded_reservation" };
        }
        this.db.prepare(`
          UPDATE explore_budget_reservations
          SET status = ?, differencing_counted = ?, accounted_cells = ?, completed_at = ?
          WHERE reservation_id = ? AND status = 'pending'
        `).run(
          input.result_released ? "released" : "not_released",
          input.result_released && Number(row.requires_differencing) === 1 ? 1 : 0,
          input.result_released ? input.returned_cells : 0,
          input.completed_at,
          input.reservation_id,
        );
        return { completed: true };
      });
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

const EXPLORE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPLORE_BUDGET_RETENTION_MS = 30 * EXPLORE_BUDGET_WINDOW_MS;

function parseBudgetTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProposalStoreError(
      "EXPLORE_BUDGET_RESERVATION_INVALID",
      `Explore ${label} must be a valid ISO timestamp.`,
    );
  }
  return parsed;
}

function assertBudgetReservationInput(input: ExploreBudgetReservationInput): void {
  const limits = Object.values(input.limits);
  if (!input.reservation_id
    || !input.scope_fingerprint.startsWith("sha256:")
    || !input.variant_fingerprint.startsWith("sha256:")
    || !input.resource_id
    || !Number.isSafeInteger(input.estimated_response_cells)
    || input.estimated_response_cells < 0
    || limits.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new ProposalStoreError(
      "EXPLORE_BUDGET_RESERVATION_INVALID",
      "Explore budget reservation input is malformed.",
    );
  }
}

function isExploreBudgetErrorCode(
  code: string,
): code is "QUERY_BUDGET_EXHAUSTED" | "RATE_LIMIT_EXHAUSTED" | "EXTRACTION_BUDGET_EXHAUSTED" | "DIFFERENCING_BUDGET_EXHAUSTED" {
  return code === "QUERY_BUDGET_EXHAUSTED"
    || code === "RATE_LIMIT_EXHAUSTED"
    || code === "EXTRACTION_BUDGET_EXHAUSTED"
    || code === "DIFFERENCING_BUDGET_EXHAUSTED";
}

function exploreBudgetUsage(
  db: ProposalStoreMethodContext["db"],
  input: ExploreBudgetReservationInput,
  now: number,
): ExploreBudgetUsage {
  const windowStart = now - EXPLORE_BUDGET_WINDOW_MS;
  const minuteStart = now - 60_000;
  let queryCount = 0;
  let queriesLastMinute = 0;
  let extractedCells = 0;
  const reservations = db.prepare(`
    SELECT accounted_cells, created_at
    FROM explore_budget_reservations
    WHERE scope_fingerprint = ? AND created_at >= ? AND created_at <= ?
  `).all(input.scope_fingerprint, new Date(windowStart).toISOString(), input.now);
  for (const row of reservations) {
    if (!isRecord(row)) continue;
    queryCount += 1;
    if (Date.parse(String(row.created_at)) >= minuteStart) queriesLastMinute += 1;
    extractedCells += Math.max(0, Number(row.accounted_cells) || 0);
  }
  for (const audit of legacyExploreBudgetAudits(db, input, windowStart, now)) {
    queryCount += 1;
    if (audit.recordedAt >= minuteStart) queriesLastMinute += 1;
    extractedCells += audit.returnedCells;
  }
  return {
    query_count: queryCount,
    queries_last_minute: queriesLastMinute,
    extracted_cells: extractedCells,
    differencing_attempts: 0,
  };
}

function exploreDifferencingVariants(
  db: ProposalStoreMethodContext["db"],
  input: ExploreBudgetReservationInput,
  now: number,
): Set<string> {
  const windowStart = now - EXPLORE_BUDGET_WINDOW_MS;
  const variants = new Set<string>();
  const rows = db.prepare(`
    SELECT variant_fingerprint
    FROM explore_budget_reservations
    WHERE scope_fingerprint = ? AND resource_id = ?
      AND created_at >= ? AND created_at <= ? AND differencing_counted = 1
  `).all(
    input.scope_fingerprint,
    input.resource_id,
    new Date(windowStart).toISOString(),
    input.now,
  );
  for (const row of rows) {
    if (isRecord(row) && typeof row.variant_fingerprint === "string") {
      variants.add(row.variant_fingerprint);
    }
  }
  for (const audit of legacyExploreBudgetAudits(db, input, windowStart, now)) {
    if (audit.informationBearingAggregate && audit.resourceId === input.resource_id) {
      variants.add(audit.variantFingerprint);
    }
  }
  return variants;
}

function legacyExploreBudgetAudits(
  db: ProposalStoreMethodContext["db"],
  input: ExploreBudgetReservationInput,
  windowStart: number,
  now: number,
): Array<{
  queryFingerprint: string;
  variantFingerprint: string;
  recordedAt: number;
  returnedCells: number;
  resourceId?: string;
  informationBearingAggregate: boolean;
}> {
  const legacyFingerprints = new Set(input.legacy_session_fingerprints);
  const results: Array<{
    queryFingerprint: string;
    variantFingerprint: string;
    recordedAt: number;
    returnedCells: number;
    resourceId?: string;
    informationBearingAggregate: boolean;
  }> = [];
  const rows = db.prepare("SELECT query_fingerprint, payload_json, created_at FROM query_audit").all();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.payload_json !== "string") continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json);
      if (!isRecord(parsed)) continue;
      payload = parsed;
    } catch {
      continue;
    }
    if (typeof payload.budget_reservation_id === "string") continue;
    const inScope = payload.budget_scope_fingerprint === input.scope_fingerprint
      || (typeof payload.session_fingerprint === "string"
        && legacyFingerprints.has(payload.session_fingerprint as `sha256:${string}`));
    if (!inScope) continue;
    const recordedAt = Date.parse(
      typeof payload.recorded_at === "string" ? payload.recorded_at : String(row.created_at),
    );
    if (!Number.isFinite(recordedAt) || recordedAt < windowStart || recordedAt > now) continue;
    if (payload.source_execution_started === false || payload.source_query_executed === false) continue;
    const normalizedPlan = isRecord(payload.normalized_plan) ? payload.normalized_plan : undefined;
    const status = payload.status;
    results.push({
      queryFingerprint: String(row.query_fingerprint),
      variantFingerprint: typeof payload.differencing_variant === "string"
        ? payload.differencing_variant
        : typeof payload.argument_fingerprint === "string"
          ? payload.argument_fingerprint
          : String(row.query_fingerprint),
      recordedAt,
      returnedCells: typeof payload.returned_cells === "number"
        ? Math.max(0, payload.returned_cells)
        : 0,
      ...(typeof normalizedPlan?.resource === "string"
        ? { resourceId: normalizedPlan.resource }
        : typeof payload.capability === "string"
          ? { resourceId: payload.capability }
          : {}),
      informationBearingAggregate: (normalizedPlan?.kind === "aggregate"
        && (status === "ok"
          || status === "empty"
          || status === "fully_suppressed"
          || status === "incomplete_comparison"))
        || (payload.protected_read_version === "synapsor.protected-read.v1"
          && payload.mode === "aggregate"
          && status === "returned"),
    });
  }
  return results;
}
