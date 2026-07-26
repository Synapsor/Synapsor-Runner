import {
  type SQLInputValue,
} from "node:sqlite";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  type OperatorIdentityProof,
  type AttentionSeverity,
  type AttentionEventType,
  type AttentionEvent,
  type RecordAttentionEventInput,
  type AttentionItemStatus,
  type AttentionItem,
  type NotificationDeliveryStatus,
  type NotificationDelivery,
} from "./domain-types.js";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  rowToAttentionEvent,
  rowToAttentionItem,
  rowToNotificationDelivery,
} from "./record-codecs.js";
import {
  defaultAttentionEventTypes,
  defaultImmediateAttentionEventTypes,
  attentionEventTitle,
  assertAttentionEventInput,
  boundedSafeLabel,
  boundedWorkbenchPath,
  defaultAttentionKey,
  attentionEventId,
  attentionItemId,
  boundedSinkId,
  boundedSafeErrorCode,
  notificationDeliveryId,
  notificationLeaseId,
  attentionSeverityRank,
  assertNotificationReplayOperatorDecision,
  assertAttentionOperatorDecision,
} from "./attention-domain.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreAttentionMethods,
  ProposalStoreAttentionInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreAttentionMethods: ProposalStoreAttentionMethods & ProposalStoreAttentionInternalMethods & ThisType<ProposalStoreMethodContext> = {
  recordAttentionEvent(input: RecordAttentionEventInput): AttentionEvent {
      let event: AttentionEvent | undefined;
      const record = () => {
        event = this.recordAttentionEventInternal(input);
      };
      if (this.db.isTransaction) record();
      else this.transaction(record);
      if (!event) throw new ProposalStoreError("ATTENTION_EVENT_CREATE_FAILED", "attention event was not persisted");
      return event;
    },
  
  listAttentionEvents(filters: {
      event_type?: AttentionEventType;
      severity?: AttentionSeverity;
      proposal_id?: string;
      capability?: string;
      tenant?: string;
      principal?: string;
      from?: string;
      limit?: number;
    } = {}): AttentionEvent[] {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      if (filters.event_type) {
        clauses.push("event_type = ?");
        params.push(filters.event_type);
      }
      if (filters.severity) {
        clauses.push("severity = ?");
        params.push(filters.severity);
      }
      if (filters.proposal_id) {
        clauses.push("proposal_id = ?");
        params.push(filters.proposal_id);
      }
      if (filters.capability) {
        clauses.push("capability = ?");
        params.push(filters.capability);
      }
      if (filters.tenant) {
        clauses.push("EXISTS (SELECT 1 FROM proposals p WHERE p.proposal_id = attention_events.proposal_id AND p.tenant_id = ?)");
        params.push(filters.tenant);
      }
      if (filters.principal) {
        clauses.push("EXISTS (SELECT 1 FROM proposals p WHERE p.proposal_id = attention_events.proposal_id AND p.principal = ?)");
        params.push(filters.principal);
      }
      if (filters.from) {
        clauses.push("occurred_at >= ?");
        params.push(filters.from);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 200, 1_000));
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.db.prepare(`
        SELECT *
        FROM attention_events
        ${where}
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?
      `).all(...params, limit)
        .map(rowToAttentionEvent)
        .filter((event): event is AttentionEvent => event !== undefined);
    },
  
  getAttentionEvent(eventId: string): AttentionEvent | undefined {
      return rowToAttentionEvent(
        this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId),
      );
    },
  
  listAttentionItems(filters: {
      status?: AttentionItemStatus;
      severity?: AttentionSeverity;
      capability?: string;
      tenant?: string;
      principal?: string;
      limit?: number;
    } = {}): AttentionItem[] {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      if (filters.status) {
        clauses.push("status = ?");
        params.push(filters.status);
      }
      if (filters.severity) {
        clauses.push("severity = ?");
        params.push(filters.severity);
      }
      if (filters.capability) {
        clauses.push("capability = ?");
        params.push(filters.capability);
      }
      if (filters.tenant) {
        clauses.push(`EXISTS (
          SELECT 1
          FROM attention_events ae
          JOIN proposals p ON p.proposal_id = ae.proposal_id
          WHERE ae.attention_key = attention_items.attention_key
            AND p.tenant_id = ?
        )`);
        params.push(filters.tenant);
      }
      if (filters.principal) {
        clauses.push(`EXISTS (
          SELECT 1
          FROM attention_events ae
          JOIN proposals p ON p.proposal_id = ae.proposal_id
          WHERE ae.attention_key = attention_items.attention_key
            AND p.principal = ?
        )`);
        params.push(filters.principal);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 200, 1_000));
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.db.prepare(`
        SELECT *
        FROM attention_items
        ${where}
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          last_seen_at DESC,
          attention_id DESC
        LIMIT ?
      `).all(...params, limit)
        .map(rowToAttentionItem)
        .filter((item): item is AttentionItem => item !== undefined);
    },
  
  getAttentionItem(attentionId: string): AttentionItem | undefined {
      return rowToAttentionItem(this.db.prepare("SELECT * FROM attention_items WHERE attention_id = ?").get(attentionId));
    },
  
  acknowledgeAttention(input: {
      attention_id: string;
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      now?: string;
    }): AttentionItem {
      const actor = boundedSafeLabel(input.actor, "attention acknowledgement actor", 256);
      const now = input.now ?? new Date().toISOString();
      this.transaction(() => {
        const item = this.requireAttentionItem(input.attention_id);
        if (item.status !== "open") {
          throw new ProposalStoreError("ATTENTION_ITEM_NOT_ACKNOWLEDGEABLE", `attention item ${item.attention_id} is ${item.status}`);
        }
        assertAttentionOperatorDecision(
          item,
          actor,
          input.identity,
          input.require_verified_identity === true,
        );
        this.db.prepare(`
          UPDATE attention_items
          SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?,
              acknowledgement_identity_json = ?,
              acknowledgement_decision_hash = ?,
              acknowledgement_signature = ?,
              acknowledgement_integrity_hash = ?,
              last_seen_at = MAX(last_seen_at, ?)
          WHERE attention_id = ?
        `).run(
          actor,
          now,
          input.identity ? JSON.stringify(input.identity) : null,
          input.identity?.decision_hash ?? null,
          input.identity?.signature ?? null,
          input.identity?.integrity_hash ?? null,
          now,
          item.attention_id,
        );
      });
      return this.requireAttentionItem(input.attention_id);
    },
  
  resolveAttention(input: {
      attention_id: string;
      now?: string;
    }): AttentionItem {
      const now = input.now ?? new Date().toISOString();
      this.transaction(() => {
        const item = this.requireAttentionItem(input.attention_id);
        if (item.status === "expired") {
          throw new ProposalStoreError("ATTENTION_ITEM_NOT_RESOLVABLE", `attention item ${item.attention_id} is expired`);
        }
        this.db.prepare(`
          UPDATE attention_items
          SET status = 'resolved', resolved_at = ?, last_seen_at = MAX(last_seen_at, ?)
          WHERE attention_id = ?
        `).run(now, now, item.attention_id);
      });
      return this.requireAttentionItem(input.attention_id);
    },
  
  enqueueNotificationDelivery(input: {
      sink_id: string;
      event_id: string;
      attention_id?: string;
      max_attempts?: number;
      status?: "pending" | "batched" | "suppressed";
      next_attempt_at?: string;
      now?: string;
    }): NotificationDelivery {
      const sinkId = boundedSinkId(input.sink_id);
      const event = this.requireAttentionEvent(input.event_id);
      const attention = input.attention_id ? this.requireAttentionItem(input.attention_id) : undefined;
      if (attention && event.attention_key !== attention.attention_key) {
        throw new ProposalStoreError(
          "NOTIFICATION_ATTENTION_MISMATCH",
          `attention event ${event.event_id} does not belong to attention item ${attention.attention_id}`,
        );
      }
      const maxAttempts = Math.max(1, Math.min(input.max_attempts ?? 5, 100));
      const status = input.status ?? "pending";
      const now = input.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) {
        throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification delivery time must be an ISO timestamp");
      }
      const nextAttemptAt = input.next_attempt_at ?? now;
      if (!Number.isFinite(Date.parse(nextAttemptAt))) {
        throw new ProposalStoreError(
          "NOTIFICATION_TIME_INVALID",
          "notification delivery next-attempt time must be an ISO timestamp",
        );
      }
      const deliveryId = notificationDeliveryId(sinkId, event.event_id);
      this.transaction(() => {
        const existing = this.getNotificationDelivery(deliveryId);
        if (existing) {
          if (
            existing.sink_id !== sinkId
            || existing.event_id !== event.event_id
            || existing.attention_id !== attention?.attention_id
          ) {
            throw new ProposalStoreError(
              "NOTIFICATION_DELIVERY_IDEMPOTENCY_MISMATCH",
              `notification delivery ${deliveryId} already exists with different immutable routing`,
            );
          }
          return;
        }
        this.db.prepare(`
          INSERT INTO notification_deliveries (
            delivery_id, sink_id, event_id, attention_id, status, attempts,
            max_attempts, next_attempt_at, lease_owner, lease_id,
            lease_expires_at, last_error_code, external_reference, delivered_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          deliveryId,
          sinkId,
          event.event_id,
          attention?.attention_id ?? null,
          status,
          maxAttempts,
          nextAttemptAt,
          now,
          now,
        );
      });
      return this.requireNotificationDelivery(deliveryId);
    },
  
  includeNotificationDeliveriesInDigest(input: {
      sink_id: string;
      delivery_ids: string[];
      digest_event_id: string;
      now?: string;
    }): number {
      const sinkId = boundedSinkId(input.sink_id);
      const deliveryIds = [...new Set(input.delivery_ids)];
      if (deliveryIds.length === 0 || deliveryIds.length > 1_000) {
        throw new ProposalStoreError(
          "NOTIFICATION_DIGEST_MEMBERS_INVALID",
          "a notification digest must contain from 1 through 1000 delivery ids",
        );
      }
      const digestEvent = this.requireAttentionEvent(input.digest_event_id);
      if (digestEvent.event_type !== "notification.digest") {
        throw new ProposalStoreError(
          "NOTIFICATION_DIGEST_EVENT_INVALID",
          "notification digest membership requires a notification.digest event",
        );
      }
      const now = input.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) {
        throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification digest time must be an ISO timestamp");
      }
      let included = 0;
      this.transaction(() => {
        for (const deliveryId of deliveryIds) {
          const item = this.requireNotificationDelivery(deliveryId);
          const digestReference = `digest:${digestEvent.event_id}`;
          if (
            item.status === "suppressed"
            && item.sink_id === sinkId
            && item.external_reference === digestReference
          ) {
            continue;
          }
          if (item.sink_id !== sinkId || item.status !== "batched") {
            throw new ProposalStoreError(
              "NOTIFICATION_DIGEST_MEMBER_STATE_INVALID",
              `notification delivery ${deliveryId} is not a batched member of sink ${sinkId}`,
            );
          }
          this.db.prepare(`
            UPDATE notification_deliveries
            SET status = 'suppressed', external_reference = ?, updated_at = ?
            WHERE delivery_id = ?
          `).run(digestReference, now, deliveryId);
          included += 1;
        }
      });
      return included;
    },
  
  claimNotificationDeliveries(input: {
      owner: string;
      sink_id?: string;
      limit?: number;
      lease_seconds?: number;
      now?: string;
    }): NotificationDelivery[] {
      const owner = boundedSafeLabel(input.owner, "notification dispatcher identity", 128);
      const sinkId = input.sink_id ? boundedSinkId(input.sink_id) : undefined;
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const leaseSeconds = Math.max(15, Math.min(input.lease_seconds ?? 60, 3600));
      const now = input.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) {
        throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification claim time must be an ISO timestamp");
      }
      const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      const claimed: NotificationDelivery[] = [];
      this.transaction(() => {
        const rows = this.db.prepare(`
          SELECT *
          FROM notification_deliveries
          WHERE (
            (status IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?)
          )
            AND (? IS NULL OR sink_id = ?)
          ORDER BY next_attempt_at ASC, created_at ASC, delivery_id ASC
          LIMIT ?
        `).all(now, now, sinkId ?? null, sinkId ?? null, limit);
        for (const row of rows) {
          const item = rowToNotificationDelivery(row);
          if (!item) continue;
          const leaseId = notificationLeaseId(item.delivery_id, owner, item.attempts + 1, now);
          this.db.prepare(`
            UPDATE notification_deliveries
            SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
                lease_id = ?, lease_expires_at = ?, last_error_code = NULL,
                updated_at = ?
            WHERE delivery_id = ?
          `).run(owner, leaseId, leaseExpiresAt, now, item.delivery_id);
          claimed.push(this.requireNotificationDelivery(item.delivery_id));
        }
      });
      return claimed;
    },
  
  completeNotificationDelivery(input: {
      delivery_id: string;
      owner: string;
      lease_id: string;
      external_reference?: string;
      now?: string;
    }): NotificationDelivery {
      const now = input.now ?? new Date().toISOString();
      const externalReference = input.external_reference
        ? boundedSafeLabel(input.external_reference, "notification external reference", 256)
        : undefined;
      this.transaction(() => {
        this.assertNotificationLease(input.delivery_id, input.owner, input.lease_id, now);
        this.db.prepare(`
          UPDATE notification_deliveries
          SET status = 'delivered', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = NULL,
              external_reference = COALESCE(?, external_reference),
              delivered_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(externalReference ?? null, now, now, input.delivery_id);
      });
      return this.requireNotificationDelivery(input.delivery_id);
    },
  
  failNotificationDelivery(input: {
      delivery_id: string;
      owner: string;
      lease_id: string;
      error_code: string;
      retryable: boolean;
      retry_at?: string;
      now?: string;
    }): NotificationDelivery {
      const now = input.now ?? new Date().toISOString();
      const errorCode = boundedSafeErrorCode(input.error_code);
      this.transaction(() => {
        const item = this.assertNotificationLease(input.delivery_id, input.owner, input.lease_id, now);
        const retryable = input.retryable && item.attempts < item.max_attempts;
        const retryAt = retryable
          ? input.retry_at ?? new Date(Date.parse(now) + 1_000).toISOString()
          : now;
        if (!Number.isFinite(Date.parse(retryAt))) {
          throw new ProposalStoreError("NOTIFICATION_RETRY_TIME_INVALID", "notification retry time must be an ISO timestamp");
        }
        this.db.prepare(`
          UPDATE notification_deliveries
          SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(retryable ? "retry_wait" : "dead_letter", retryAt, errorCode, now, input.delivery_id);
      });
      return this.requireNotificationDelivery(input.delivery_id);
    },
  
  listNotificationDeliveries(filters: {
      status?: NotificationDeliveryStatus;
      sink_id?: string;
      event_id?: string;
      attention_id?: string;
      limit?: number;
    } = {}): NotificationDelivery[] {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      for (const [column, value] of [
        ["status", filters.status],
        ["sink_id", filters.sink_id],
        ["event_id", filters.event_id],
        ["attention_id", filters.attention_id],
      ] as const) {
        if (!value) continue;
        clauses.push(`${column} = ?`);
        params.push(value);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 200, 1_000));
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.db.prepare(`
        SELECT *
        FROM notification_deliveries
        ${where}
        ORDER BY created_at DESC, delivery_id DESC
        LIMIT ?
      `).all(...params, limit)
        .map(rowToNotificationDelivery)
        .filter((delivery): delivery is NotificationDelivery => delivery !== undefined);
    },
  
  getNotificationDelivery(deliveryId: string): NotificationDelivery | undefined {
      return rowToNotificationDelivery(
        this.db.prepare("SELECT * FROM notification_deliveries WHERE delivery_id = ?").get(deliveryId),
      );
    },
  
  requeueNotificationDelivery(input: {
      delivery_id: string;
      identity: OperatorIdentityProof;
      reason: string;
      now?: string;
    }): NotificationDelivery {
      const now = input.now ?? new Date().toISOString();
      const reason = boundedSafeLabel(input.reason, "notification replay reason", 256);
      this.transaction(() => {
        const item = this.requireNotificationDelivery(input.delivery_id);
        if (!["dead_letter", "suppressed", "batched"].includes(item.status)) {
          throw new ProposalStoreError(
            "NOTIFICATION_DELIVERY_NOT_REQUEUEABLE",
            `notification delivery ${item.delivery_id} is ${item.status}`,
          );
        }
        assertNotificationReplayOperatorDecision(item, input.identity, reason);
        const event = this.requireAttentionEvent(item.event_id);
        this.db.prepare(`
          UPDATE notification_deliveries
          SET status = 'pending', attempts = 0, next_attempt_at = ?,
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              last_error_code = NULL, delivered_at = NULL, updated_at = ?
          WHERE delivery_id = ?
        `).run(now, now, item.delivery_id);
        this.recordAttentionEventInternal({
          event_type: "notification.replayed",
          severity: "informational",
          environment: event.environment,
          ...(event.proposal_id ? { proposal_id: event.proposal_id } : {}),
          ...(event.job_id ? { job_id: event.job_id } : {}),
          ...(event.operation_id ? { operation_id: event.operation_id } : {}),
          ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
          ...(event.capability ? { capability: event.capability } : {}),
          ...(event.contract_digest ? { contract_digest: event.contract_digest } : {}),
          attention_required: false,
          immediate_default: false,
          summary: `Notification delivery ${item.delivery_id} requeued by a verified operator`,
          ...(event.workbench_path ? { workbench_path: event.workbench_path } : {}),
          details: {
            delivery_id: item.delivery_id,
            sink_id: item.sink_id,
            replayed_event_id: item.event_id,
            operator_subject: input.identity.subject,
            identity_provider: input.identity.provider,
            operator_decision_hash: input.identity.decision_hash,
            reason,
            approval_replayed: false,
            mutation_replayed: false,
            source_database_changed: false,
          },
          source_event_key: `notification-replay:${item.delivery_id}:${input.identity.decision_hash}`,
          now,
        });
      });
      return this.requireNotificationDelivery(input.delivery_id);
    },
  
  recordAttentionEventInternal(input: RecordAttentionEventInput): AttentionEvent {
      assertAttentionEventInput(input);
      const occurredAt = input.now ?? new Date().toISOString();
      const environment = boundedSafeLabel(input.environment, "attention environment", 64);
      const capability = input.capability ? boundedSafeLabel(input.capability, "attention capability", 256) : undefined;
      const contractDigest = input.contract_digest;
      const attentionRequired = input.attention_required ?? defaultAttentionEventTypes.has(input.event_type);
      const immediateDefault = input.immediate_default ?? defaultImmediateAttentionEventTypes.has(input.event_type);
      const details = Object.fromEntries(
        Object.entries(input.details ?? {})
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      const sourceEventKey = input.source_event_key
        ? boundedSafeLabel(input.source_event_key, "attention source event key", 512)
        : canonicalJsonDigest({
          event_type: input.event_type,
          occurred_at: occurredAt,
          proposal_id: input.proposal_id ?? null,
          job_id: input.job_id ?? null,
          operation_id: input.operation_id ?? null,
          capability: capability ?? null,
          details,
        });
      const eventId = attentionEventId(sourceEventKey, input.event_type);
      const attentionKey = attentionRequired
        ? boundedSafeLabel(
          input.attention_key ?? defaultAttentionKey({
            environment,
            event_type: input.event_type,
            capability,
            contract_digest: contractDigest,
            details,
          }),
          "attention coalescing key",
          512,
        )
        : undefined;
      const unsigned = {
        schema_version: "synapsor.attention-event.v1" as const,
        event_id: eventId,
        event_type: input.event_type,
        severity: input.severity,
        occurred_at: occurredAt,
        environment,
        ...(input.proposal_id ? { proposal_id: boundedSafeLabel(input.proposal_id, "attention proposal id", 256) } : {}),
        ...(input.job_id ? { job_id: boundedSafeLabel(input.job_id, "attention job id", 256) } : {}),
        ...(input.operation_id ? { operation_id: boundedSafeLabel(input.operation_id, "attention operation id", 256) } : {}),
        ...(input.correlation_id ? { correlation_id: boundedSafeLabel(input.correlation_id, "attention correlation id", 256) } : {}),
        ...(capability ? { capability } : {}),
        ...(contractDigest ? { contract_digest: contractDigest } : {}),
        ...(attentionKey ? { attention_key: attentionKey } : {}),
        attention_required: attentionRequired,
        immediate_default: immediateDefault,
        summary: boundedSafeLabel(input.summary ?? attentionEventTitle(input.event_type), "attention summary", 512),
        ...(input.approval_source ? { approval_source: input.approval_source } : {}),
        ...(input.worker_state ? { worker_state: boundedSafeLabel(input.worker_state, "attention worker state", 128) } : {}),
        ...(input.failure_class ? { failure_class: boundedSafeLabel(input.failure_class, "attention failure class", 128) } : {}),
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
        ...(input.workbench_path ? { workbench_path: boundedWorkbenchPath(input.workbench_path) } : {}),
        details,
      };
      assertNoSecretMaterial(unsigned, `attention_event.${eventId}`);
      const event: AttentionEvent = {
        ...unsigned,
        payload_hash: canonicalJsonDigest(unsigned),
      };
      const existing = rowToAttentionEvent(this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId));
      if (existing) {
        if (existing.payload_hash !== event.payload_hash) {
          throw new ProposalStoreError(
            "ATTENTION_EVENT_IDEMPOTENCY_MISMATCH",
            `attention event ${eventId} already exists with different immutable content`,
          );
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO attention_events (
          event_id, schema_version, event_type, severity, occurred_at, environment,
          proposal_id, job_id, operation_id, correlation_id, capability,
          contract_digest, attention_key, attention_required, immediate_default,
          summary, approval_source, worker_state, failure_class, expires_at,
          workbench_path, details_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.event_id,
        event.schema_version,
        event.event_type,
        event.severity,
        event.occurred_at,
        event.environment,
        event.proposal_id ?? null,
        event.job_id ?? null,
        event.operation_id ?? null,
        event.correlation_id ?? null,
        event.capability ?? null,
        event.contract_digest ?? null,
        event.attention_key ?? null,
        event.attention_required ? 1 : 0,
        event.immediate_default ? 1 : 0,
        event.summary,
        event.approval_source ?? null,
        event.worker_state ?? null,
        event.failure_class ?? null,
        event.expires_at ?? null,
        event.workbench_path ?? null,
        JSON.stringify(event.details),
        event.payload_hash,
        event.occurred_at,
      );
      if (event.attention_required && event.attention_key) this.projectAttentionItem(event);
      if (event.proposal_id && event.event_type === "proposal.expired") {
        this.closeProposalExpiryAttention(event, "expired");
      } else if (
        event.proposal_id
        && (
          event.event_type === "proposal.applied"
          || event.event_type === "proposal.cancelled"
          || event.event_type === "proposal.refused"
        )
      ) {
        this.closeProposalExpiryAttention(event, "resolved");
      }
      return event;
    },
  
  closeProposalExpiryAttention(
      event: AttentionEvent,
      status: "resolved" | "expired",
    ): void {
      if (!event.proposal_id) return;
      this.db.prepare(`
        UPDATE attention_items
        SET status = ?,
            event_type = ?,
            title = ?,
            latest_event_id = ?,
            resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
            last_seen_at = MAX(last_seen_at, ?)
        WHERE status IN ('open', 'acknowledged')
          AND attention_key IN (
            SELECT DISTINCT attention_key
            FROM attention_events
            WHERE proposal_id = ?
              AND event_type = 'proposal.expiring'
              AND attention_key IS NOT NULL
          )
      `).run(
        status,
        event.event_type,
        event.summary,
        event.event_id,
        status,
        event.occurred_at,
        event.occurred_at,
        event.proposal_id,
      );
    },
  
  projectAttentionItem(event: AttentionEvent): void {
      const attentionKey = event.attention_key;
      if (!attentionKey) return;
      const existing = rowToAttentionItem(this.db.prepare("SELECT * FROM attention_items WHERE attention_key = ?").get(attentionKey));
      if (!existing) {
        this.db.prepare(`
          INSERT INTO attention_items (
            attention_id, attention_key, status, severity, environment, event_type,
            capability, contract_digest, title, occurrence_count, first_event_id,
            latest_event_id, first_seen_at, last_seen_at, acknowledged_by,
            acknowledged_at, resolved_at, expires_at
          ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        `).run(
          attentionItemId(attentionKey),
          attentionKey,
          event.severity,
          event.environment,
          event.event_type,
          event.capability ?? null,
          event.contract_digest ?? null,
          event.summary,
          event.event_id,
          event.event_id,
          event.occurred_at,
          event.occurred_at,
          event.expires_at ?? null,
        );
        return;
      }
      const severity = attentionSeverityRank(event.severity) > attentionSeverityRank(existing.severity)
        ? event.severity
        : existing.severity;
      this.db.prepare(`
        UPDATE attention_items
        SET status = 'open', severity = ?, event_type = ?, title = ?,
            occurrence_count = occurrence_count + 1, latest_event_id = ?,
            last_seen_at = ?, acknowledged_by = NULL, acknowledged_at = NULL,
            acknowledgement_identity_json = NULL,
            acknowledgement_decision_hash = NULL,
            acknowledgement_signature = NULL,
            acknowledgement_integrity_hash = NULL,
            resolved_at = NULL,
            expires_at = COALESCE(?, expires_at)
        WHERE attention_id = ?
      `).run(
        severity,
        event.event_type,
        event.summary,
        event.event_id,
        event.occurred_at,
        event.expires_at ?? null,
        existing.attention_id,
      );
    },
  
  requireAttentionItem(attentionId: string): AttentionItem {
      const item = this.getAttentionItem(attentionId);
      if (!item) throw new ProposalStoreError("ATTENTION_ITEM_NOT_FOUND", `attention item not found: ${attentionId}`);
      return item;
    },
  
  requireAttentionEvent(eventId: string): AttentionEvent {
      const event = rowToAttentionEvent(this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId));
      if (!event) throw new ProposalStoreError("ATTENTION_EVENT_NOT_FOUND", `attention event not found: ${eventId}`);
      return event;
    },
  
  requireNotificationDelivery(deliveryId: string): NotificationDelivery {
      const delivery = this.getNotificationDelivery(deliveryId);
      if (!delivery) {
        throw new ProposalStoreError("NOTIFICATION_DELIVERY_NOT_FOUND", `notification delivery not found: ${deliveryId}`);
      }
      return delivery;
    },
  
  assertNotificationLease(
      deliveryId: string,
      owner: string,
      leaseId: string,
      now: string,
    ): NotificationDelivery {
      const item = this.requireNotificationDelivery(deliveryId);
      if (
        item.status !== "leased"
        || item.lease_owner !== owner
        || item.lease_id !== leaseId
      ) {
        throw new ProposalStoreError(
          "NOTIFICATION_LEASE_MISMATCH",
          `dispatcher ${owner} does not hold lease ${leaseId} for ${deliveryId}`,
        );
      }
      if (!item.lease_expires_at || Date.parse(item.lease_expires_at) <= Date.parse(now)) {
        throw new ProposalStoreError("NOTIFICATION_LEASE_EXPIRED", `notification lease ${leaseId} has expired`);
      }
      return item;
    },
};
