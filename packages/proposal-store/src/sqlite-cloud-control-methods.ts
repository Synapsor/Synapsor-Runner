import {
  type SQLInputValue,
} from "node:sqlite";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  type OperatorIdentityProof,
  type CloudOutboxKind,
  type CloudOutboxStatus,
  type CloudOutboxItem,
  type CloudGovernanceEvent,
  type AttentionEventType,
  type WorkerCapabilityControlStatus,
  type WorkerCapabilityControl,
  type WorkerControlState,
  type WorkerControlTarget,
  type SharedLedgerEntry,
  type SharedLedgerImportResult,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  localStateFromCloudGovernance,
} from "./writeback-domain.js";
import {
  rowToCloudOutboxItem,
  rowToCloudGovernanceEvent,
} from "./record-codecs.js";
import {
  boundedSafeLabel,
} from "./attention-domain.js";
import {
  defaultWorkerControlState,
  parseWorkerControlState,
  assertWorkerControlTarget,
  assertWorkerControlOperatorDecision,
  workerControlSummary,
} from "./worker-control-domain.js";
import {
  sharedLedgerRestoreSpecs,
  sharedLedgerPayload,
  sharedLedgerTableForEntry,
  sharedLedgerRestoreRank,
  sharedLedgerRestoreValue,
} from "./shared-ledger-domain.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreCloudControlMethods,
  ProposalStoreCloudControlInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreCloudControlMethods: ProposalStoreCloudControlMethods & ProposalStoreCloudControlInternalMethods & ThisType<ProposalStoreMethodContext> = {
  enqueueCloudOutbox(input: {
      event_id: string;
      proposal_id?: string;
      sequence?: number;
      kind: CloudOutboxKind;
      payload: Record<string, unknown>;
      max_attempts?: number;
      now?: string;
    }): CloudOutboxItem {
      const eventId = input.event_id.trim();
      if (!eventId) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_ID_REQUIRED", "cloud outbox event_id is required");
      if (!(["proposal", "activity", "result"] as const).includes(input.kind)) throw new ProposalStoreError("CLOUD_OUTBOX_KIND_INVALID", `unsupported Cloud outbox kind: ${input.kind}`);
      if (input.proposal_id) this.requireProposal(input.proposal_id);
      assertNoSecretMaterial(input.payload, `cloud_outbox.${eventId}`);
      const payloadHash = canonicalJsonDigest(input.payload);
      const now = input.now ?? new Date().toISOString();
      const sequence = Math.max(0, Math.trunc(input.sequence ?? 0));
      const maxAttempts = Math.max(1, Math.min(100, Math.trunc(input.max_attempts ?? 12)));
      this.db.prepare(`
        INSERT OR IGNORE INTO cloud_outbox (
          event_id, proposal_id, sequence, kind, status, payload_hash, payload_json,
          attempts, max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
      `).run(eventId, input.proposal_id ?? null, sequence, input.kind, payloadHash, JSON.stringify(input.payload), maxAttempts, now, now, now);
      const item = this.requireCloudOutboxItem(eventId);
      if (item.payload_hash !== payloadHash || item.kind !== input.kind || item.proposal_id !== input.proposal_id) {
        throw new ProposalStoreError("CLOUD_OUTBOX_IDEMPOTENCY_MISMATCH", `cloud outbox event ${eventId} was already recorded with different immutable content`);
      }
      return item;
    },
  
  claimCloudOutbox(input: { owner: string; limit?: number; lease_ms?: number; now?: string }): CloudOutboxItem[] {
      const owner = input.owner.trim();
      if (!owner) throw new ProposalStoreError("CLOUD_OUTBOX_OWNER_REQUIRED", "cloud outbox lease owner is required");
      const now = input.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(Date.parse(now) + Math.max(1_000, Math.min(300_000, input.lease_ms ?? 30_000))).toISOString();
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
      const claimed: string[] = [];
      this.transaction(() => {
        this.db.prepare(`
          UPDATE cloud_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE status = 'leased' AND lease_expires_at <= ?
        `).run(now, now);
        const rows = this.db.prepare(`
          SELECT candidate.event_id
          FROM cloud_outbox candidate
          WHERE candidate.status = 'pending'
            AND candidate.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM cloud_outbox earlier
              WHERE earlier.proposal_id = candidate.proposal_id
                AND earlier.sequence < candidate.sequence
                AND earlier.status NOT IN ('acknowledged')
            )
          ORDER BY candidate.sequence ASC, candidate.created_at ASC, candidate.event_id ASC
          LIMIT ?
        `).all(now, limit);
        for (const row of rows) {
          if (!isRecord(row) || typeof row.event_id !== "string") continue;
          const result = this.db.prepare(`
            UPDATE cloud_outbox
            SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                sent_at = COALESCE(sent_at, ?), updated_at = ?
            WHERE event_id = ? AND status = 'pending'
          `).run(owner, leaseExpiresAt, now, now, row.event_id);
          if (Number(result.changes) === 1) claimed.push(row.event_id);
        }
      });
      return claimed.map((eventId) => this.requireCloudOutboxItem(eventId));
    },
  
  acknowledgeCloudOutbox(eventId: string, owner: string, now = new Date().toISOString()): CloudOutboxItem {
      const result = this.db.prepare(`
        UPDATE cloud_outbox
        SET status = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL,
            acknowledged_at = ?, last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'leased' AND lease_owner = ?
      `).run(now, now, eventId, owner);
      if (Number(result.changes) !== 1) throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${eventId} is not leased by ${owner}`);
      return this.requireCloudOutboxItem(eventId);
    },
  
  failCloudOutbox(input: { event_id: string; owner: string; error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean; now?: string }): CloudOutboxItem {
      const now = input.now ?? new Date().toISOString();
      const current = this.requireCloudOutboxItem(input.event_id);
      if (current.status !== "leased" || current.lease_owner !== input.owner) {
        throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${input.event_id} is not leased by ${input.owner}`);
      }
      const exhausted = current.attempts >= current.max_attempts;
      const status: CloudOutboxStatus = input.reconciliation
        ? "reconciliation_required"
        : input.retryable && !exhausted
          ? "pending"
          : "dead_letter";
      const fallbackDelay = Math.min(300_000, 500 * (2 ** Math.min(current.attempts, 9)));
      const delayMs = Math.max(0, Math.min(3_600_000, input.retry_after_ms ?? fallbackDelay));
      const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
      this.db.prepare(`
        UPDATE cloud_outbox
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?,
            next_attempt_at = ?, updated_at = ?
        WHERE event_id = ?
      `).run(status, input.error_code, nextAttemptAt, now, input.event_id);
      return this.requireCloudOutboxItem(input.event_id);
    },
  
  requeueCloudOutbox(eventId: string, now = new Date().toISOString()): CloudOutboxItem {
      const current = this.requireCloudOutboxItem(eventId);
      if (!(["dead_letter", "reconciliation_required"] as CloudOutboxStatus[]).includes(current.status)) {
        throw new ProposalStoreError("CLOUD_OUTBOX_NOT_REQUEUEABLE", `cloud outbox event ${eventId} is ${current.status}, not dead_letter or reconciliation_required`);
      }
      this.db.prepare(`
        UPDATE cloud_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE event_id = ?
      `).run(now, now, eventId);
      return this.requireCloudOutboxItem(eventId);
    },
  
  listCloudOutbox(filters: { status?: CloudOutboxStatus; proposal_id?: string; limit?: number } = {}): CloudOutboxItem[] {
      const conditions: string[] = [];
      const values: SQLInputValue[] = [];
      if (filters.status) { conditions.push("status = ?"); values.push(filters.status); }
      if (filters.proposal_id) { conditions.push("proposal_id = ?"); values.push(filters.proposal_id); }
      const limit = Math.max(1, Math.min(10_000, Math.trunc(filters.limit ?? 100)));
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return this.db.prepare(`SELECT * FROM cloud_outbox ${where} ORDER BY sequence ASC, created_at ASC, event_id ASC LIMIT ?`)
        .all(...values, limit).map(rowToCloudOutboxItem).filter((item): item is CloudOutboxItem => item !== undefined);
    },
  
  compactCloudOutbox(input: { acknowledged_before: string }): number {
      const result = this.db.prepare("DELETE FROM cloud_outbox WHERE status = 'acknowledged' AND acknowledged_at < ?").run(input.acknowledged_before);
      return Number(result.changes);
    },
  
  recordCloudGovernanceEvent(input: Omit<CloudGovernanceEvent, "authority" | "integrity_hash" | "created_at"> & { created_at?: string }): CloudGovernanceEvent {
      this.requireProposal(input.proposal_id);
      assertNoSecretMaterial(input.payload, `cloud_governance_event.${input.event_id}`);
      const createdAt = input.created_at ?? new Date().toISOString();
      const unsigned = {
        event_id: input.event_id,
        proposal_id: input.proposal_id,
        ...(input.cloud_proposal_id ? { cloud_proposal_id: input.cloud_proposal_id } : {}),
        kind: input.kind,
        state: input.state,
        authority: "synapsor_cloud" as const,
        payload: input.payload,
        created_at: createdAt,
      };
      const event: CloudGovernanceEvent = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
      this.db.prepare(`
        INSERT OR IGNORE INTO cloud_governance_events (
          event_id, proposal_id, cloud_proposal_id, kind, state, authority, payload_json, integrity_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.event_id, event.proposal_id, event.cloud_proposal_id ?? null, event.kind, event.state, event.authority, JSON.stringify(event.payload), event.integrity_hash, event.created_at);
      const localState = localStateFromCloudGovernance(event.state);
      if (localState) {
        const sourceMutated = localState === "applied" ? 1 : 0;
        const projected = this.db.prepare(`
          UPDATE proposals
          SET state = ?, source_database_mutated = CASE WHEN ? = 1 THEN 1 ELSE source_database_mutated END, updated_at = ?
          WHERE proposal_id = ? AND state IN ('pending_review', 'approved', 'pending_worker')
        `).run(localState, sourceMutated, event.created_at, event.proposal_id);
        if (Number(projected.changes) === 1) {
          this.appendEvent(event.proposal_id, `proposal_cloud_${localState}`, "synapsor_cloud", {
            cloud_event_id: event.event_id,
            cloud_proposal_id: event.cloud_proposal_id ?? event.proposal_id,
            cloud_state: event.state,
            authority: event.authority,
          });
        }
      }
      const stored = this.listCloudGovernanceEvents(input.proposal_id).find((item) => item.event_id === input.event_id);
      if (!stored || stored.integrity_hash !== event.integrity_hash) {
        throw new ProposalStoreError("CLOUD_GOVERNANCE_EVENT_MISMATCH", `Cloud governance event ${input.event_id} conflicts with an existing immutable event`);
      }
      return stored;
    },
  
  listCloudGovernanceEvents(proposalId?: string): CloudGovernanceEvent[] {
      const rows = proposalId
        ? this.db.prepare("SELECT * FROM cloud_governance_events WHERE proposal_id = ? ORDER BY created_at ASC, event_id ASC").all(proposalId)
        : this.db.prepare("SELECT * FROM cloud_governance_events ORDER BY created_at ASC, event_id ASC").all();
      return rows.map(rowToCloudGovernanceEvent).filter((item): item is CloudGovernanceEvent => item !== undefined);
    },
  
  requireCloudOutboxItem(eventId: string): CloudOutboxItem {
      const item = rowToCloudOutboxItem(this.db.prepare("SELECT * FROM cloud_outbox WHERE event_id = ?").get(eventId));
      if (!item) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `cloud outbox event not found: ${eventId}`);
      return item;
    },
  
  workerControlState(): WorkerControlState {
      const raw = this.getRunnerState("supervised_worker_control");
      if (!raw) return defaultWorkerControlState();
      return parseWorkerControlState(raw);
    },
  
  updateWorkerControl(input: WorkerControlTarget & {
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      environment?: string;
      now?: string;
    }): WorkerControlState {
      const now = input.now ?? new Date().toISOString();
      const current = this.workerControlState();
      assertWorkerControlTarget(input);
      assertWorkerControlOperatorDecision(
        current,
        input,
        input.actor,
        input.identity,
        input.require_verified_identity === true,
      );
      let mode = current.mode;
      let controls = [...current.capability_controls];
      if (input.action === "pause") mode = "paused";
      else if (input.action === "resume") mode = "active";
      else if (input.action === "drain") mode = "draining";
      else {
        const capability = input.capability!;
        const contractDigest = input.contract_digest!;
        const keyMatches = (entry: WorkerCapabilityControl) =>
          entry.capability === capability && entry.contract_digest === contractDigest;
        const existing = controls.find(keyMatches);
        if (existing?.status === "revoked" && input.action === "capability_enable") {
          throw new ProposalStoreError(
            "WORKER_DIGEST_REVOKED",
            `revoked supervised-worker digest ${contractDigest} cannot be re-enabled`,
          );
        }
        const status: WorkerCapabilityControlStatus = input.action === "capability_enable"
          ? "enabled"
          : input.action === "capability_disable"
            ? "disabled"
            : "revoked";
        controls = [
          ...controls.filter((entry) => !keyMatches(entry)),
          {
            capability,
            contract_digest: contractDigest,
            status,
            updated_at: now,
            actor: input.actor,
          },
        ].sort((left, right) => left.capability.localeCompare(right.capability)
          || left.contract_digest.localeCompare(right.contract_digest));
      }
      const unsigned = {
        schema_version: "synapsor.worker-control.v1" as const,
        mode,
        revision: current.revision + 1,
        capability_controls: controls,
        ...(input.identity ? { last_decision: input.identity } : {}),
        updated_at: now,
      };
      const updated: WorkerControlState = {
        ...unsigned,
        integrity_hash: canonicalJsonDigest(unsigned),
      };
      assertNoSecretMaterial(updated, "runner_state.supervised_worker_control");
      this.transaction(() => {
        this.db.prepare(`
          INSERT INTO runner_state (key, value_json, updated_at)
          VALUES ('supervised_worker_control', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run(JSON.stringify(updated), now);
        const global = input.action === "pause" || input.action === "resume" || input.action === "drain";
        const eventType: AttentionEventType = input.action === "resume" || input.action === "capability_enable"
          ? "capability.activated"
          : global
            ? "worker.paused"
            : "capability.revoked";
        this.recordAttentionEventInternal({
          event_type: eventType,
          severity: "informational",
          environment: input.environment
            ? boundedSafeLabel(input.environment, "worker control environment", 64)
            : "unknown",
          ...(input.capability ? { capability: input.capability } : {}),
          ...(input.contract_digest ? { contract_digest: input.contract_digest } : {}),
          attention_required: false,
          immediate_default: false,
          summary: workerControlSummary(input),
          worker_state: mode,
          details: {
            control_action: input.action,
            control_revision: updated.revision,
            source_database_changed: false,
          },
          source_event_key: `worker-control:${updated.revision}:${updated.integrity_hash}`,
          now,
        });
      });
      return updated;
    },
  
  setRunnerState(key: string, value: Record<string, unknown>): void {
      assertNoSecretMaterial(value, `runner_state.${key}`);
      this.db.prepare(`
        INSERT INTO runner_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), new Date().toISOString());
    },
  
  getRunnerState(key: string): Record<string, unknown> | undefined {
      const row = this.db.prepare("SELECT value_json FROM runner_state WHERE key = ?").get(key);
      if (!isRecord(row)) return undefined;
      return JSON.parse(String(row.value_json)) as Record<string, unknown>;
    },
  
  sharedLedgerEntries(): SharedLedgerEntry[] {
      const specs: Array<{
        table: string;
        kind: string;
        key: string;
        created: string;
        proposal?: string;
        tenant?: string;
        capability?: string;
      }> = [
        { table: "proposals", kind: "proposal", key: "proposal_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
        { table: "proposal_events", kind: "proposal_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
        { table: "approvals", kind: "approval", key: "approval_id", created: "created_at", proposal: "proposal_id" },
        { table: "writeback_jobs", kind: "writeback_job", key: "writeback_job_id", created: "created_at", proposal: "proposal_id" },
        { table: "writeback_intents", kind: "writeback_intent", key: "intent_id", created: "created_at", proposal: "proposal_id" },
        { table: "idempotency_receipts", kind: "idempotency_receipt", key: "idempotency_key", created: "created_at", proposal: "proposal_id" },
        { table: "writeback_receipts", kind: "writeback_receipt", key: "receipt_id", created: "created_at", proposal: "proposal_id" },
        { table: "evidence_bundles", kind: "evidence_bundle", key: "evidence_bundle_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
        { table: "evidence_items", kind: "evidence_item", key: "evidence_item_id", created: "created_at" },
        { table: "query_audit", kind: "query_audit", key: "audit_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
        { table: "explore_budget_reservations", kind: "explore_budget_reservation", key: "reservation_id", created: "created_at" },
        { table: "replay_records", kind: "replay_record", key: "replay_id", created: "created_at", proposal: "proposal_id" },
        { table: "shadow_human_actions", kind: "shadow_human_action", key: "action_id", created: "created_at", proposal: "proposal_id" },
        { table: "shadow_studies", kind: "shadow_study", key: "study_id", created: "created_at" },
        { table: "shadow_study_cases", kind: "shadow_study_case", key: "case_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
        { table: "shadow_outcomes", kind: "shadow_outcome", key: "outcome_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id" },
        { table: "worker_queue", kind: "worker_queue_item", key: "proposal_id", created: "created_at", proposal: "proposal_id" },
        { table: "attention_events", kind: "attention_event", key: "event_id", created: "created_at", proposal: "proposal_id", capability: "capability" },
        { table: "attention_items", kind: "attention_item", key: "attention_id", created: "first_seen_at", capability: "capability" },
        { table: "notification_deliveries", kind: "notification_delivery", key: "delivery_id", created: "created_at" },
        { table: "runner_state", kind: "runner_state", key: "key", created: "updated_at" },
        { table: "policy_recommendations", kind: "policy_recommendation", key: "recommendation_id", created: "created_at", tenant: "tenant_id", capability: "capability" },
        { table: "cloud_outbox", kind: "cloud_outbox_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
        { table: "cloud_governance_events", kind: "cloud_governance_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
      ];
      const entries: SharedLedgerEntry[] = [];
      for (const spec of specs) {
        const rows = this.db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.created} ASC`).all();
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const payload = sharedLedgerPayload(spec.table, row);
          assertNoSecretMaterial(payload, `shared_ledger.${spec.table}`);
          entries.push({
            entry_key: `${spec.table}:${String(row[spec.key])}`,
            kind: spec.kind,
            proposal_id: spec.proposal && row[spec.proposal] != null ? String(row[spec.proposal]) : undefined,
            tenant_id: spec.tenant && row[spec.tenant] != null ? String(row[spec.tenant]) : undefined,
            capability: spec.capability && row[spec.capability] != null ? String(row[spec.capability]) : undefined,
            payload,
            created_at: row[spec.created] == null ? new Date().toISOString() : String(row[spec.created]),
          });
        }
      }
      return entries;
    },
  
  importSharedLedgerEntries(entries: SharedLedgerEntry[]): SharedLedgerImportResult {
      let imported = 0;
      let skipped = 0;
      const sorted = [...entries].sort((left, right) => sharedLedgerRestoreRank(left) - sharedLedgerRestoreRank(right));
      this.transaction(() => {
        for (const entry of sorted) {
          const table = sharedLedgerTableForEntry(entry);
          if (!table) {
            skipped += 1;
            continue;
          }
          assertNoSecretMaterial(entry.payload, `shared_ledger.${table}`);
          if (this.restoreSharedLedgerEntry(table, entry.payload)) imported += 1;
          else skipped += 1;
        }
      });
      return { imported, skipped };
    },
  
  restoreSharedLedgerEntry(table: string, payload: Record<string, unknown>): boolean {
      const spec = sharedLedgerRestoreSpecs[table];
      if (!spec) return false;
      const values = spec.columns.map((column) => sharedLedgerRestoreValue(payload, column));
      if (values.some((value, index) => value == null && spec.required.has(spec.columns[index]!))) return false;
      const assignments = spec.columns
        .filter((column) => column !== spec.conflict)
        .map((column) => `${column} = excluded.${column}`)
        .join(", ");
      this.db.prepare(`
        INSERT INTO ${table} (${spec.columns.join(", ")})
        VALUES (${spec.columns.map(() => "?").join(", ")})
        ON CONFLICT(${spec.conflict}) DO UPDATE SET ${assignments}
      `).run(...values);
      return true;
    },
};
