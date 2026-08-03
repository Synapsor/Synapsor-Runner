import {
  parseChangeSet,
  type ChangeSet,
} from "@synapsor-runner/protocol";
import {
  type StoredProposal,
  type OperatorIdentityProof,
  type WorkerQueueStatus,
  type WorkerExecutionMode,
  type WorkerQueueItem,
  type PolicyApprovalLimit,
  type PolicyApprovalLimitTrip,
  type WorkerPolicyExecutionLimits,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  assertOperatorDecision,
  publicIdentitySummary,
  utcDayWindow,
} from "./proposal-integrity.js";
import {
  rowToWorkerQueueItem,
  workerLeaseId,
} from "./record-codecs.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreWorkerMethods,
  ProposalStoreWorkerInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreWorkersMethods: ProposalStoreWorkerMethods & ProposalStoreWorkerInternalMethods & ThisType<ProposalStoreMethodContext> = {
  enqueueWorkerProposal(options: {
      proposal_id: string;
      execution_mode?: WorkerExecutionMode;
      contract_digest?: `sha256:${string}`;
      max_attempts?: number;
      queue_limit?: number;
      now?: string;
    }): WorkerQueueItem {
      const proposal = this.requireProposal(options.proposal_id);
      if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
        throw new ProposalStoreError(
          "WORKER_PROPOSAL_NOT_APPROVED",
          `proposal ${proposal.proposal_id} is ${proposal.state}, not approved for worker execution`,
        );
      }
      const executionMode = options.execution_mode ?? "legacy";
      const contractDigest = options.contract_digest;
      if (executionMode === "supervised_worker" && !contractDigest) {
        throw new ProposalStoreError(
          "SUPERVISED_WORKER_DIGEST_REQUIRED",
          `supervised worker queue item ${proposal.proposal_id} requires an exact contract digest`,
        );
      }
      if (contractDigest && !/^sha256:[a-f0-9]{64}$/.test(contractDigest)) {
        throw new ProposalStoreError("WORKER_CONTRACT_DIGEST_INVALID", "worker queue contract digest must be a full lowercase sha256 digest");
      }
      const maxAttempts = Math.max(1, Math.min(options.max_attempts ?? 5, 100));
      const queueLimit = Math.max(1, Math.min(options.queue_limit ?? 10_000, 100_000));
      const now = options.now ?? new Date().toISOString();
      this.transaction(() => {
        const existing = this.workerQueueItem(proposal.proposal_id);
        if (existing) {
          if (existing.execution_mode !== executionMode || existing.contract_digest !== contractDigest) {
            throw new ProposalStoreError(
              "WORKER_QUEUE_AUTHORITY_MISMATCH",
              `worker queue item ${proposal.proposal_id} already exists under different execution authority`,
            );
          }
          return;
        }
        const active = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM worker_queue q
          JOIN proposals p ON p.proposal_id = q.proposal_id
          WHERE q.execution_mode = ?
            AND (? IS NULL OR q.contract_digest = ?)
            AND p.action = ?
            AND q.status IN ('queued', 'leased', 'retry_wait', 'blocked', 'reconciliation_required')
        `).get(executionMode, contractDigest ?? null, contractDigest ?? null, proposal.action);
        if (isRecord(active) && Number(active.count ?? 0) >= queueLimit) {
          throw new ProposalStoreError(
            "WORKER_QUEUE_LIMIT_EXCEEDED",
            `worker queue limit ${queueLimit} reached for ${proposal.action}`,
          );
        }
        this.db.prepare(`
          INSERT INTO worker_queue (
            proposal_id, status, execution_mode, contract_digest, attempts,
            max_attempts, next_attempt_at, lease_owner, lease_id,
            lease_expires_at, last_error_code, terminal_outcome, created_at,
            updated_at
          ) VALUES (?, 'queued', ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          proposal.proposal_id,
          executionMode,
          contractDigest ?? null,
          maxAttempts,
          now,
          now,
          now,
        );
        this.appendEvent(proposal.proposal_id, "writeback_worker_queued", "runner", {
          execution_mode: executionMode,
          contract_digest: contractDigest ?? null,
          max_attempts: maxAttempts,
        });
      });
      return this.requireWorkerQueueItem(proposal.proposal_id);
    },
  
  enqueueApprovedForWorker(options: {
      capability?: string;
      tenant?: string;
      maxAttempts?: number;
      limit?: number;
      now?: string;
    } = {}): WorkerQueueItem[] {
      const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 100));
      const now = options.now ?? new Date().toISOString();
      const proposals = [
        ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "approved" }),
        ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "pending_worker" }),
      ]
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
      this.transaction(() => {
        for (const proposal of proposals) {
          this.db.prepare(`
            INSERT OR IGNORE INTO worker_queue (
              proposal_id, status, execution_mode, contract_digest, attempts,
              max_attempts, next_attempt_at, lease_owner, lease_id,
              lease_expires_at, last_error_code, terminal_outcome, created_at,
              updated_at
            ) VALUES (?, 'queued', 'legacy', NULL, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
          `).run(proposal.proposal_id, maxAttempts, now, now, now);
        }
      });
      return proposals.map((proposal) => this.workerQueueItem(proposal.proposal_id)).filter((item): item is WorkerQueueItem => item !== undefined);
    },
  
  claimWorkerItem(options: {
      workerId: string;
      leaseSeconds?: number;
      executionMode?: WorkerExecutionMode;
      capability?: string;
      tenant?: string;
      contractDigest?: `sha256:${string}`;
      maxConcurrent?: number;
      rateLimit?: {
        executions: number;
        windowSeconds: number;
      };
      proposalTtlSeconds?: number;
      policyExecution?: WorkerPolicyExecutionLimits;
      now?: string;
    }): WorkerQueueItem | undefined {
      const now = options.now ?? new Date().toISOString();
      const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 3600));
      const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      let claimed: WorkerQueueItem | undefined;
      this.transaction(() => {
        if (options.maxConcurrent !== undefined) {
          const maximum = Math.max(1, Math.min(options.maxConcurrent, 32));
          const active = this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM worker_queue q
            JOIN proposals p ON p.proposal_id = q.proposal_id
            WHERE q.status = 'leased'
              AND q.lease_expires_at > ?
              AND (? IS NULL OR q.execution_mode = ?)
              AND (? IS NULL OR p.action = ?)
              AND (? IS NULL OR p.tenant_id = ?)
              AND (? IS NULL OR q.contract_digest = ?)
          `).get(
            now,
            options.executionMode ?? null,
            options.executionMode ?? null,
            options.capability ?? null,
            options.capability ?? null,
            options.tenant ?? null,
            options.tenant ?? null,
            options.contractDigest ?? null,
            options.contractDigest ?? null,
          );
          if (isRecord(active) && Number(active.count ?? 0) >= maximum) return;
        }
        if (options.rateLimit) {
          const executions = Math.max(1, Math.min(options.rateLimit.executions, 100_000));
          const windowSeconds = Math.max(1, Math.min(options.rateLimit.windowSeconds, 86_400));
          const windowStart = new Date(Date.parse(now) - windowSeconds * 1_000).toISOString();
          const recent = this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM worker_queue q
            JOIN proposals p ON p.proposal_id = q.proposal_id
            WHERE q.status = 'completed'
              AND q.updated_at >= ?
              AND (? IS NULL OR q.execution_mode = ?)
              AND (? IS NULL OR p.action = ?)
              AND (? IS NULL OR p.tenant_id = ?)
              AND (? IS NULL OR q.contract_digest = ?)
          `).get(
            windowStart,
            options.executionMode ?? null,
            options.executionMode ?? null,
            options.capability ?? null,
            options.capability ?? null,
            options.tenant ?? null,
            options.tenant ?? null,
            options.contractDigest ?? null,
            options.contractDigest ?? null,
          );
          if (isRecord(recent) && Number(recent.count ?? 0) >= executions) return;
        }
        const raw = this.db.prepare(`
          SELECT q.*
          FROM worker_queue q
          JOIN proposals p ON p.proposal_id = q.proposal_id
          WHERE (
            (q.status IN ('queued', 'retry_wait') AND q.next_attempt_at <= ?)
            OR (q.status = 'leased' AND q.lease_expires_at <= ?)
          )
            AND p.state IN ('approved', 'pending_worker', 'failed')
            AND (? IS NULL OR q.execution_mode = ?)
            AND (? IS NULL OR p.action = ?)
            AND (? IS NULL OR p.tenant_id = ?)
            AND (? IS NULL OR q.contract_digest = ?)
          ORDER BY q.next_attempt_at ASC, q.created_at ASC
          LIMIT 1
        `).get(
          now,
          now,
          options.executionMode ?? null,
          options.executionMode ?? null,
          options.capability ?? null,
          options.capability ?? null,
          options.tenant ?? null,
          options.tenant ?? null,
          options.contractDigest ?? null,
          options.contractDigest ?? null,
        );
        const item = rowToWorkerQueueItem(raw);
        if (!item) return;
        const proposal = this.requireProposal(item.proposal_id);
        if (options.proposalTtlSeconds !== undefined) {
          const ttlSeconds = Math.max(60, Math.min(options.proposalTtlSeconds, 2_592_000));
          const expiresAt = Date.parse(proposal.created_at) + ttlSeconds * 1_000;
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now)) {
            this.blockQueuedWorkerItem(item, options.workerId, "SUPERVISED_WORKER_PROPOSAL_EXPIRED", now);
            return;
          }
        }
        if (options.policyExecution) {
          const trips = this.workerPolicyExecutionLimitTrips({
            proposal,
            policy: options.policyExecution.policy,
            limits: options.policyExecution.limits,
            now,
          });
          if (trips.length > 0) {
            this.blockQueuedWorkerItem(
              item,
              options.workerId,
              "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
              now,
              { policy: options.policyExecution.policy, tripped_limits: trips },
            );
            return;
          }
        }
        const leaseId = workerLeaseId(item.proposal_id, options.workerId, item.attempts + 1, now);
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
              lease_id = ?, lease_expires_at = ?, last_error_code = NULL,
              terminal_outcome = NULL, updated_at = ?
          WHERE proposal_id = ?
        `).run(options.workerId, leaseId, leaseExpiresAt, now, item.proposal_id);
        if (proposal.state === "failed") {
          this.db.prepare("UPDATE proposals SET state = 'pending_worker', updated_at = ? WHERE proposal_id = ?").run(now, item.proposal_id);
        }
        this.appendEvent(item.proposal_id, "writeback_worker_claimed", options.workerId, {
          attempt: item.attempts + 1,
          max_attempts: item.max_attempts,
          execution_mode: item.execution_mode,
          contract_digest: item.contract_digest ?? null,
          lease_id: leaseId,
          lease_expires_at: leaseExpiresAt,
        });
        claimed = this.workerQueueItem(item.proposal_id);
      });
      return claimed;
    },
  
  assertWorkerPolicyExecutionLimits(input: {
      proposalId: string;
      policy: string;
      limits: PolicyApprovalLimit[];
      now?: string;
    }): void {
      const proposal = this.requireProposal(input.proposalId);
      const trips = this.workerPolicyExecutionLimitTrips({
        proposal,
        policy: input.policy,
        limits: input.limits,
        now: input.now ?? new Date().toISOString(),
      });
      if (trips.length > 0) {
        throw new ProposalStoreError(
          "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
          `execution-time policy limit no longer permits proposal ${proposal.proposal_id}`,
        );
      }
    },
  
  blockQueuedWorkerItem(
      item: WorkerQueueItem,
      actor: string,
      errorCode: string,
      now: string,
      payload: Record<string, unknown> = {},
    ): void {
      this.db.prepare(`
        UPDATE worker_queue
        SET status = 'blocked', lease_owner = NULL, lease_id = NULL,
            lease_expires_at = NULL, last_error_code = ?,
            terminal_outcome = NULL, updated_at = ?
        WHERE proposal_id = ?
      `).run(errorCode, now, item.proposal_id);
      this.appendEvent(item.proposal_id, "writeback_worker_blocked", actor, {
        error_code: errorCode,
        execution_mode: item.execution_mode,
        contract_digest: item.contract_digest ?? null,
        ...payload,
      });
    },
  
  workerPolicyExecutionLimitTrips(input: {
      proposal: StoredProposal;
      policy: string;
      limits: PolicyApprovalLimit[];
      now: string;
    }): PolicyApprovalLimitTrip[] {
      if (input.limits.length === 0) return [];
      const actor = `policy:${input.policy}`;
      const candidateApproval = this.db.prepare(`
        SELECT approval_id
        FROM approvals
        WHERE proposal_id = ?
          AND approver = ?
          AND status = 'approved'
          AND proposal_hash = ?
          AND proposal_version = ?
        LIMIT 1
      `).get(
        input.proposal.proposal_id,
        actor,
        input.proposal.proposal_hash,
        input.proposal.proposal_version,
      );
      if (!isRecord(candidateApproval)) return [];
  
      const window = utcDayWindow(input.now);
      const rows = this.db.prepare(`
        SELECT DISTINCT
          p.proposal_id,
          p.business_object,
          p.object_id,
          p.change_set_json
        FROM worker_queue q
        JOIN proposals p ON p.proposal_id = q.proposal_id
        JOIN approvals a ON a.proposal_id = p.proposal_id
        WHERE a.approver = ?
          AND a.status = 'approved'
          AND p.tenant_id = ?
          AND (
            (q.status = 'leased' AND q.lease_expires_at > ?)
            OR (
              q.status = 'completed'
              AND q.terminal_outcome IN ('applied', 'already_applied')
              AND q.updated_at >= ?
              AND q.updated_at < ?
            )
            OR (
              q.status = 'reconciliation_required'
              AND q.updated_at >= ?
              AND q.updated_at < ?
            )
            OR (
              p.state = 'applied'
              AND p.updated_at >= ?
              AND p.updated_at < ?
            )
          )
      `).all(
        actor,
        input.proposal.tenant_id,
        input.now,
        window.start,
        window.end,
        window.start,
        window.end,
        window.start,
        window.end,
      );
      const active = new Map<string, {
        proposal_id: string;
        business_object: string;
        object_id: string;
        change_set: ChangeSet;
      }>();
      let invalidHistory = false;
      for (const row of rows) {
        if (!isRecord(row)) continue;
        try {
          const proposalId = String(row.proposal_id);
          active.set(proposalId, {
            proposal_id: proposalId,
            business_object: String(row.business_object),
            object_id: String(row.object_id),
            change_set: parseChangeSet(JSON.parse(String(row.change_set_json))),
          });
        } catch {
          // A malformed historical row must fail a value limit closed below.
          invalidHistory = true;
          active.set(String(row.proposal_id), {
            proposal_id: String(row.proposal_id),
            business_object: String(row.business_object),
            object_id: String(row.object_id),
            change_set: input.proposal.change_set,
          });
        }
      }
      active.set(input.proposal.proposal_id, {
        proposal_id: input.proposal.proposal_id,
        business_object: input.proposal.business_object,
        object_id: input.proposal.object_id,
        change_set: input.proposal.change_set,
      });
  
      const trips: PolicyApprovalLimitTrip[] = [];
      for (const limit of input.limits) {
        const scope = limit.scope ?? "tenant_policy";
        const scoped = [...active.values()].filter((proposal) =>
          scope !== "tenant_policy_object"
          || (
            proposal.business_object === input.proposal.business_object
            && proposal.object_id === input.proposal.object_id
          ));
        if (limit.kind === "count") {
          const projected = scoped.length;
          if (projected > limit.max) {
            trips.push({
              ...limit,
              scope,
              observed: Math.max(0, projected - 1),
              proposed: 1,
              projected,
              window_start: window.start,
              window_end: window.end,
              reason: `${scope} execution count ${projected} exceeds ${limit.max}`,
            });
          }
          continue;
        }
  
        const field = limit.field;
        let projected = 0;
        let proposed = 0;
        let invalid = !field || invalidHistory;
        for (const proposal of scoped) {
          const value = field ? proposal.change_set.patch[field] : undefined;
          if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            invalid = true;
            continue;
          }
          projected += value;
          if (proposal.proposal_id === input.proposal.proposal_id) proposed = value;
        }
        if (invalid || projected > limit.max) {
          trips.push({
            ...limit,
            scope,
            observed: projected - proposed,
            proposed,
            projected,
            window_start: window.start,
            window_end: window.end,
            reason: invalid
              ? `${scope} execution total could not be verified safely${field ? ` for ${field}` : ""}`
              : `${scope} execution total ${projected} for ${field} exceeds ${limit.max}`,
          });
        }
      }
      return trips;
    },
  
  assertActiveWorkerLease(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
      if (!item.lease_expires_at || Date.parse(item.lease_expires_at) <= Date.parse(now)) {
        throw new ProposalStoreError("WORKER_LEASE_EXPIRED", `worker lease ${options.leaseId} for ${options.proposalId} has expired`);
      }
      return item;
    },
  
  renewWorkerLease(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      leaseSeconds?: number;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 3600));
      const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      this.transaction(() => {
        this.assertActiveWorkerLease({ ...options, now });
        this.db.prepare(`
          UPDATE worker_queue
          SET lease_expires_at = ?, updated_at = ?
          WHERE proposal_id = ? AND status = 'leased' AND lease_owner = ? AND lease_id = ?
        `).run(leaseExpiresAt, now, options.proposalId, options.workerId, options.leaseId);
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  completeWorkerItem(
      proposalId: string,
      workerId: string,
      outcome: "applied" | "already_applied" | "conflict",
      now = new Date().toISOString(),
      leaseId?: string,
    ): WorkerQueueItem {
      this.transaction(() => {
        this.assertWorkerLease(proposalId, workerId, leaseId);
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'completed', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = NULL,
              terminal_outcome = ?, updated_at = ?
          WHERE proposal_id = ?
        `).run(outcome, now, proposalId);
        this.appendEvent(proposalId, "writeback_worker_completed", workerId, { outcome, lease_id: leaseId ?? null });
      });
      return this.requireWorkerQueueItem(proposalId);
    },
  
  retryWorkerItem(options: {
      proposalId: string;
      workerId: string;
      errorCode: string;
      retryAt: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      this.transaction(() => {
        const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
        const deadLetter = item.attempts >= item.max_attempts;
        this.db.prepare(`
          UPDATE worker_queue
          SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?, terminal_outcome = NULL,
              updated_at = ?
          WHERE proposal_id = ?
        `).run(deadLetter ? "dead_letter" : "retry_wait", options.retryAt, options.errorCode, now, options.proposalId);
        this.appendEvent(options.proposalId, deadLetter ? "writeback_dead_lettered" : "writeback_retry_scheduled", options.workerId, {
          attempt: item.attempts,
          max_attempts: item.max_attempts,
          error_code: options.errorCode,
          lease_id: options.leaseId ?? null,
          ...(deadLetter ? {} : { retry_at: options.retryAt }),
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  deadLetterWorkerItem(options: {
      proposalId: string;
      workerId: string;
      errorCode: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      this.transaction(() => {
        const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'dead_letter', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'dead_letter', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
        this.appendEvent(options.proposalId, "writeback_dead_lettered", options.workerId, {
          attempt: item.attempts,
          max_attempts: item.max_attempts,
          error_code: options.errorCode,
          lease_id: options.leaseId ?? null,
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  blockWorkerItem(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      errorCode: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      this.transaction(() => {
        this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'blocked', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'blocked', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
        this.appendEvent(options.proposalId, "writeback_worker_blocked", options.workerId, {
          error_code: options.errorCode,
          lease_id: options.leaseId,
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  requireWorkerReconciliation(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      errorCode: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      this.transaction(() => {
        this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'reconciliation_required', lease_owner = NULL,
              lease_id = NULL, lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'reconciliation_required', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
        this.appendEvent(options.proposalId, "writeback_reconciliation_required", options.workerId, {
          safe_error_code: options.errorCode,
          lease_id: options.leaseId,
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  cancelWorkerItem(options: {
      proposalId: string;
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      const proposal = this.requireProposal(options.proposalId);
      assertOperatorDecision(
        proposal,
        "worker_cancel",
        options.actor,
        options.identity,
        options.require_verified_identity === true,
      );
      this.transaction(() => {
        const item = this.requireWorkerQueueItem(options.proposalId);
        if (item.status !== "queued" && item.status !== "retry_wait") {
          throw new ProposalStoreError(
            "WORKER_ITEM_NOT_CANCELLABLE",
            `worker queue item ${options.proposalId} is ${item.status}, not safely cancellable before lease`,
          );
        }
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'cancelled', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, terminal_outcome = 'cancelled',
              updated_at = ?
          WHERE proposal_id = ?
        `).run(now, options.proposalId);
        if (proposal.state === "approved" || proposal.state === "pending_worker") {
          this.db.prepare(`
            UPDATE proposals
            SET state = 'canceled', updated_at = ?
            WHERE proposal_id = ?
          `).run(now, options.proposalId);
        }
        this.appendEvent(options.proposalId, "writeback_canceled", options.actor, {
          execution_mode: item.execution_mode,
          contract_digest: item.contract_digest ?? null,
          identity: options.identity ? publicIdentitySummary(options.identity) : null,
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  listWorkerQueue(status?: WorkerQueueStatus): WorkerQueueItem[] {
      const rows = status
        ? this.db.prepare("SELECT * FROM worker_queue WHERE status = ? ORDER BY created_at ASC").all(status)
        : this.db.prepare("SELECT * FROM worker_queue ORDER BY created_at ASC").all();
      return rows.map(rowToWorkerQueueItem).filter((item): item is WorkerQueueItem => item !== undefined);
    },
  
  getWorkerQueueItem(proposalId: string): WorkerQueueItem | undefined {
      return this.workerQueueItem(proposalId);
    },
  
  requeueDeadLetter(options: {
      proposalId: string;
      retryBudget: number;
      identity: OperatorIdentityProof;
      reason?: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      const retryBudget = Math.max(1, Math.min(options.retryBudget, 100));
      const proposal = this.requireProposal(options.proposalId);
      assertOperatorDecision(proposal, "worker_requeue", options.identity.subject, options.identity, true);
      this.transaction(() => {
        const item = this.requireWorkerQueueItem(options.proposalId);
        if (item.status !== "dead_letter") {
          throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
        }
        const provenEffect = this.receipts(options.proposalId).find((receipt) =>
          receipt.source_database_mutated || receipt.status === "applied" || receipt.status === "already_applied");
        if (provenEffect) {
          throw new ProposalStoreError("DEAD_LETTER_EFFECT_ALREADY_RECORDED", `proposal ${options.proposalId} has a receipt proving the database effect already completed`);
        }
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'queued', attempts = 0, max_attempts = ?, next_attempt_at = ?,
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              last_error_code = NULL, terminal_outcome = NULL, updated_at = ?
          WHERE proposal_id = ?
        `).run(retryBudget, now, now, options.proposalId);
        if (proposal.state === "failed") {
          this.db.prepare("UPDATE proposals SET state = 'approved', updated_at = ? WHERE proposal_id = ?").run(now, options.proposalId);
        }
        this.appendEvent(options.proposalId, "writeback_dead_letter_requeued", options.identity.subject, {
          retry_budget: retryBudget,
          reason: options.reason ?? null,
          identity: publicIdentitySummary(options.identity),
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  discardDeadLetter(options: {
      proposalId: string;
      identity: OperatorIdentityProof;
      reason: string;
      now?: string;
    }): WorkerQueueItem {
      const now = options.now ?? new Date().toISOString();
      const proposal = this.requireProposal(options.proposalId);
      assertOperatorDecision(proposal, "worker_discard", options.identity.subject, options.identity, true);
      this.transaction(() => {
        const item = this.requireWorkerQueueItem(options.proposalId);
        if (item.status !== "dead_letter") {
          throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
        }
        this.db.prepare(`
          UPDATE worker_queue
          SET status = 'discarded', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, terminal_outcome = 'discarded', updated_at = ?
          WHERE proposal_id = ?
        `).run(now, options.proposalId);
        this.appendEvent(options.proposalId, "writeback_dead_letter_discarded", options.identity.subject, {
          reason: options.reason,
          identity: publicIdentitySummary(options.identity),
        });
      });
      return this.requireWorkerQueueItem(options.proposalId);
    },
  
  workerQueueItem(proposalId: string): WorkerQueueItem | undefined {
      return rowToWorkerQueueItem(this.db.prepare("SELECT * FROM worker_queue WHERE proposal_id = ?").get(proposalId));
    },
  
  requireWorkerQueueItem(proposalId: string): WorkerQueueItem {
      const item = this.workerQueueItem(proposalId);
      if (!item) throw new ProposalStoreError("WORKER_ITEM_NOT_FOUND", `worker queue item not found for ${proposalId}`);
      return item;
    },
  
  assertWorkerLease(proposalId: string, workerId: string, leaseId?: string): WorkerQueueItem {
      if (!leaseId) {
        throw new ProposalStoreError(
          "WORKER_LEASE_ID_REQUIRED",
          `worker ${workerId} must present the exact lease id for ${proposalId}`,
        );
      }
      const item = this.requireWorkerQueueItem(proposalId);
      if (
        item.status !== "leased"
        || item.lease_owner !== workerId
        || item.lease_id !== leaseId
      ) {
        throw new ProposalStoreError("WORKER_LEASE_MISMATCH", `worker ${workerId} does not hold the lease for ${proposalId}`);
      }
      return item;
    },
};
