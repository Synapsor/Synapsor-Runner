import { describe, expect, it } from "vitest";
import { ProposalStore, type AttentionEvent } from "@synapsor-runner/proposal-store";
import type { RuntimeNotificationsConfig } from "@synapsor-runner/mcp-server";
import {
  buildNotificationEnvelope,
  decideNotificationRoute,
  dispatchNotificationDeliveries,
  planNotificationDeliveries,
  resolveNotificationWebhookTarget,
  signNotificationWebhook,
  verifyNotificationWebhook,
  verifyNotificationWebhookDurably,
} from "./notifications.js";

const now = "2026-07-24T12:00:00.000Z";

describe("human-attention notification routing", () => {
  it("keeps successful activity quiet and routes only timely attention by default", async () => {
    const store = new ProposalStore();
    try {
      store.recordAttentionEvent({
        event_type: "proposal.auto_approved",
        severity: "informational",
        environment: "production",
        proposal_id: "wrp_quiet",
        capability: "billing.propose_credit",
        approval_source: "policy_auto",
        source_event_key: "quiet-auto-approved",
        now,
      });
      store.recordAttentionEvent({
        event_type: "proposal.applied",
        severity: "informational",
        environment: "production",
        proposal_id: "wrp_quiet",
        capability: "billing.propose_credit",
        approval_source: "policy_auto",
        source_event_key: "quiet-applied",
        now: "2026-07-24T12:00:01.000Z",
      });
      store.recordAttentionEvent({
        event_type: "proposal.review_required",
        severity: "warning",
        environment: "production",
        proposal_id: "wrp_review",
        capability: "billing.propose_credit",
        attention_key: "production:billing.propose_credit:manager-review",
        source_event_key: "review-required",
        workbench_path: "/attention/manager-review",
        now: "2026-07-24T12:00:02.000Z",
      });

      const result = await planNotificationDeliveries({
        store,
        config: quietConfig(),
        now: "2026-07-24T12:00:03.000Z",
      });
      expect(result).toMatchObject({ examined_events: 3, pending: 1, suppressed: 2, batched: 0 });
      expect(store.listNotificationDeliveries({ status: "pending" })).toHaveLength(1);
      expect(store.listNotificationDeliveries({ status: "suppressed" })).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("interrupts once at the configured retry threshold and honors a non-digest escalation delay", async () => {
    const sink = quietConfig().sinks[0]!;
    sink.budgets = {
      ...sink.budgets,
      retry_attempt_threshold: 3,
      escalation_delay_seconds: 120,
    };
    const retry = (attempt: number) => attentionEvent({
      event_type: "worker.retry_scheduled",
      severity: "warning",
      immediate_default: false,
      details: {
        attempt,
        max_attempts: 5,
        failure_class: "DATABASE_TEMPORARILY_UNAVAILABLE",
      },
    });

    expect(decideNotificationRoute({ event: retry(1), sink, now }))
      .toEqual({ status: "suppressed", reason: "quiet_default" });
    expect(decideNotificationRoute({ event: retry(3), sink, now }))
      .toEqual({
        status: "pending",
        reason: "immediate",
        not_before: "2026-07-24T12:02:00.000Z",
      });
    expect(decideNotificationRoute({ event: retry(4), sink, now }))
      .toEqual({ status: "suppressed", reason: "quiet_default" });

    const store = new ProposalStore();
    try {
      for (const attempt of [1, 3, 4]) {
        store.recordAttentionEvent({
          event_type: "worker.retry_scheduled",
          severity: "warning",
          environment: "production",
          capability: "billing.propose_credit",
          failure_class: "DATABASE_TEMPORARILY_UNAVAILABLE",
          worker_state: "retry_wait",
          attention_required: false,
          immediate_default: false,
          source_event_key: `retry-${attempt}`,
          details: { attempt, max_attempts: 5 },
          now,
        });
      }
      await planNotificationDeliveries({
        store,
        config: { enabled: true, sinks: [sink] },
        now,
      });
      expect(store.listNotificationDeliveries({ status: "pending" })).toEqual([
        expect.objectContaining({ next_attempt_at: "2026-07-24T12:02:00.000Z" }),
      ]);
      expect(store.claimNotificationDeliveries({
        owner: "dispatcher",
        now: "2026-07-24T12:01:59.000Z",
      })).toEqual([]);
      expect(store.claimNotificationDeliveries({
        owner: "dispatcher",
        now: "2026-07-24T12:02:00.000Z",
      })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("coalesces related review events and budgets unrelated bursts", async () => {
    const store = new ProposalStore();
    try {
      for (let index = 0; index < 2; index += 1) {
        store.recordAttentionEvent({
          event_type: "proposal.review_required",
          severity: "warning",
          environment: "production",
          proposal_id: `wrp_group_${index}`,
          capability: "billing.propose_credit",
          attention_key: "production:billing.propose_credit:manager-review",
          source_event_key: `group-review-${index}`,
          now: `2026-07-24T12:00:0${index}.000Z`,
        });
      }
      store.recordAttentionEvent({
        event_type: "worker.queue_backlog",
        severity: "warning",
        environment: "production",
        capability: "support.propose_refund",
        attention_key: "production:support.propose_refund:backlog",
        source_event_key: "other-warning",
        now: "2026-07-24T12:00:02.000Z",
      });

      const config = quietConfig();
      config.sinks[0]!.budgets = {
        ...config.sinks[0]!.budgets,
        per_minute: 1,
      };
      const result = await planNotificationDeliveries({
        store,
        config,
        now: "2026-07-24T12:00:03.000Z",
      });
      expect(result).toMatchObject({ pending: 1, suppressed: 1, batched: 1 });
      const reviewItem = store.listAttentionItems({ capability: "billing.propose_credit" })[0];
      expect(reviewItem).toMatchObject({ occurrence_count: 2, status: "open" });
    } finally {
      store.close();
    }
  });

  it("lets critical attention bypass quiet hours but still coalesces repeats", async () => {
    const event = attentionEvent({
      event_type: "worker.unknown_outcome",
      severity: "critical",
      immediate_default: true,
    });
    const sink = quietConfig().sinks[0]!;
    sink.quiet_hours = { start_utc_hour: 0, end_utc_hour: 23 };
    sink.budgets = { per_minute: 1, per_hour: 1, cooldown_seconds: 600 };

    expect(decideNotificationRoute({
      event,
      sink,
      sinkHistory: Array.from({ length: 5 }, (_, index) => delivery(`ntd_history_${index}`, {
        created_at: "2026-07-24T11:59:30.000Z",
      })),
      now,
    })).toEqual({ status: "pending", reason: "immediate" });

    expect(decideNotificationRoute({
      event,
      sink,
      existing: [delivery("ntd_existing", {
        event_id: "ate_previous",
        attention_id: "att_unknown",
        updated_at: "2026-07-24T11:59:30.000Z",
      })],
      now,
    })).toEqual({ status: "suppressed", reason: "coalesced" });
  });

  it("keeps recovery quiet unless that destination explicitly opts in", () => {
    const event = attentionEvent({
      event_type: "worker.recovered",
      severity: "informational",
      immediate_default: true,
      attention_required: false,
      attention_key: undefined,
    });
    const sink = quietConfig().sinks[0]!;
    sink.minimum_severity = "warning";
    expect(decideNotificationRoute({ event, sink, now }))
      .toEqual({ status: "suppressed", reason: "filtered" });
    sink.recovery_notifications = true;
    expect(decideNotificationRoute({ event, sink, now }))
      .toEqual({ status: "pending", reason: "immediate" });
  });

  it("folds due informational activity into one durable redacted digest", async () => {
    const store = new ProposalStore();
    try {
      for (const [index, eventType] of [
        "proposal.created",
        "proposal.auto_approved",
        "proposal.applied",
      ].entries()) {
        store.recordAttentionEvent({
          event_type: eventType as AttentionEvent["event_type"],
          severity: "informational",
          environment: "production",
          proposal_id: `wrp_digest_${index}`,
          capability: "billing.propose_credit",
          source_event_key: `digest-source-${index}`,
          details: { source_database_changed: eventType === "proposal.applied" },
          now: `2026-07-24T12:00:0${index}.000Z`,
        });
      }
      const config = quietConfig();
      config.sinks[0]!.delivery = "digest";
      config.sinks[0]!.budgets = {
        ...config.sinks[0]!.budgets,
        digest_cadence_minutes: 1,
      };

      const initial = await planNotificationDeliveries({
        store,
        config,
        now: "2026-07-24T12:00:03.000Z",
      });
      expect(initial).toMatchObject({ batched: 3, digests: 0 });
      expect(store.listNotificationDeliveries({ status: "batched" })).toHaveLength(3);

      const due = await planNotificationDeliveries({
        store,
        config,
        now: "2026-07-24T12:01:04.000Z",
      });
      expect(due).toMatchObject({ digests: 1 });
      expect(store.listAttentionEvents({ event_type: "notification.digest" })).toHaveLength(1);
      expect(store.listNotificationDeliveries({ status: "suppressed" }))
        .toHaveLength(3);
      expect(store.listNotificationDeliveries({ status: "pending" }))
        .toHaveLength(1);

      let deliveredEnvelope: ReturnType<typeof buildNotificationEnvelope> | undefined;
      await expect(dispatchNotificationDeliveries({
        store,
        config,
        owner: "digest_dispatcher",
        now: "2026-07-24T12:01:05.000Z",
        deliver: async ({ envelope }) => {
          deliveredEnvelope = envelope;
          return { external_reference: "digest-accepted" };
        },
      })).resolves.toMatchObject({ claimed: 1, delivered: 1 });
      expect(deliveredEnvelope).toMatchObject({
        type: "ai.synapsor.notification.digest",
        data: {
          details: {
            event_count: 3,
            proposals_created: 1,
            auto_approved: 1,
            applied: 1,
            source_database_changed: true,
          },
        },
      });
      expect(JSON.stringify(deliveredEnvelope)).not.toMatch(/tenant|principal|sql|credential/i);
      expect(store.listAttentionEvents()).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it("delivers critical attention immediately even on a digest sink", () => {
    const sink = quietConfig().sinks[0]!;
    sink.delivery = "digest";
    expect(decideNotificationRoute({
      event: attentionEvent({
        event_type: "worker.reconciliation_required",
        severity: "critical",
        immediate_default: true,
      }),
      sink,
      now,
    })).toEqual({ status: "pending", reason: "immediate" });
  });

  it("signs a minimal envelope and rejects tampering, stale delivery, and replay", () => {
    const event = attentionEvent({
      event_type: "proposal.review_required",
      severity: "warning",
      immediate_default: true,
      workbench_path: "/attention/att_review",
    });
    const envelope = buildNotificationEnvelope({
      event,
      workbench_base_url: "http://127.0.0.1:8787/",
    });
    const body = JSON.stringify(envelope);
    const secret = "notification-test-secret-at-least-32-bytes";
    const headers = signNotificationWebhook({
      body,
      event_id: event.event_id,
      secret,
      timestamp_seconds: 2_000,
    });
    const seen = new Set<string>();
    expect(verifyNotificationWebhook({
      body,
      event_id: headers["x-synapsor-event-id"],
      timestamp: headers["x-synapsor-timestamp"],
      signature: headers["x-synapsor-signature"],
      signature_version: headers["x-synapsor-signature-version"],
      secret,
      now_seconds: 2_010,
      replay_window_seconds: 300,
      seen_event_ids: seen,
    })).toEqual({ ok: true, event_id: event.event_id });
    expect(verifyNotificationWebhook({
      body,
      event_id: event.event_id,
      timestamp: "2000",
      signature: headers["x-synapsor-signature"],
      signature_version: "v1",
      secret,
      now_seconds: 2_010,
      seen_event_ids: seen,
    })).toEqual({ ok: false, code: "REPLAYED_EVENT" });
    expect(verifyNotificationWebhook({
      body: `${body} `,
      event_id: event.event_id,
      timestamp: "2000",
      signature: headers["x-synapsor-signature"],
      signature_version: "v1",
      secret,
      now_seconds: 2_010,
    })).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
    expect(verifyNotificationWebhook({
      body,
      event_id: event.event_id,
      timestamp: "2000",
      signature: headers["x-synapsor-signature"],
      signature_version: "v1",
      secret,
      now_seconds: 2_400,
      replay_window_seconds: 300,
    })).toEqual({ ok: false, code: "STALE_WEBHOOK" });
    expect(body).not.toContain("tenant");
    expect(body).not.toContain("principal");
    expect(body).not.toContain("sql");
    expect(envelope.data.workbench_url).toBe("http://127.0.0.1:8787/attention/att_review");
  });

  it("blocks loopback, private, metadata, and unsafe webhook destinations unless exactly allowlisted", async () => {
    const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    await expect(resolveNotificationWebhookTarget({
      raw_url: "https://hooks.internal.example/runner",
      lookup: loopbackLookup,
    })).rejects.toThrow("NOTIFICATION_DESTINATION_BLOCKED");
    await expect(resolveNotificationWebhookTarget({
      raw_url: "https://hooks.internal.example/runner",
      allow_private_destinations: true,
      private_host_allowlist: ["different.internal.example"],
      lookup: loopbackLookup,
    })).rejects.toThrow("NOTIFICATION_DESTINATION_BLOCKED");
    await expect(resolveNotificationWebhookTarget({
      raw_url: "https://hooks.internal.example/runner",
      allow_private_destinations: true,
      private_host_allowlist: ["hooks.internal.example"],
      lookup: loopbackLookup,
    })).resolves.toMatchObject({ address: { address: "127.0.0.1", family: 4 } });
    await expect(resolveNotificationWebhookTarget({
      raw_url: "http://169.254.169.254/latest/meta-data",
      lookup: async () => [{ address: "169.254.169.254", family: 4 as const }],
    })).rejects.toThrow("NOTIFICATION_URL_UNSAFE");
  });

  it("delivers a leased event without accepting receiver authority", async () => {
    const store = new ProposalStore();
    try {
      store.recordAttentionEvent({
        event_type: "proposal.review_required",
        severity: "warning",
        environment: "production",
        proposal_id: "wrp_dispatch",
        capability: "billing.propose_credit",
        attention_key: "production:billing.propose_credit:dispatch-review",
        source_event_key: "dispatch-review",
        now,
      });
      const config = quietConfig();
      await planNotificationDeliveries({ store, config, now: "2026-07-24T12:00:01.000Z" });
      let receiverAttempts = 0;
      const result = await dispatchNotificationDeliveries({
        store,
        config,
        owner: "dispatcher_test",
        now: "2026-07-24T12:00:02.000Z",
        deliver: async () => {
          receiverAttempts += 1;
          return {
            external_reference: "receiver-accepted",
            approve: true,
            apply: true,
          } as { external_reference: string };
        },
      });
      expect(result).toEqual({ claimed: 1, delivered: 1, retry_wait: 0, dead_letter: 0, lease_lost: 0 });
      expect(receiverAttempts).toBe(1);
      expect(store.listNotificationDeliveries({ status: "delivered" })[0])
        .toMatchObject({ external_reference: "receiver-accepted", attempts: 1 });
      expect(store.stats()).toMatchObject({
        proposals: 0,
        writeback_receipts: 0,
        idempotency_receipts: 0,
      });
    } finally {
      store.close();
    }
  });

  it("claims verified webhook event IDs atomically through a durable replay store", async () => {
    const event = attentionEvent();
    const body = JSON.stringify(buildNotificationEnvelope({ event }));
    const secret = "notification-test-secret-at-least-32-bytes";
    const headers = signNotificationWebhook({
      body,
      event_id: event.event_id,
      secret,
      timestamp_seconds: 2_000,
    });
    const durableIds = new Set<string>();
    const expirations: number[] = [];
    const claim = async (input: { event_id: string; expires_at_seconds: number }) => {
      if (durableIds.has(input.event_id)) return false;
      durableIds.add(input.event_id);
      expirations.push(input.expires_at_seconds);
      return true;
    };
    const request = {
      body,
      event_id: event.event_id,
      timestamp: headers["x-synapsor-timestamp"],
      signature: headers["x-synapsor-signature"],
      signature_version: headers["x-synapsor-signature-version"],
      secret,
      now_seconds: 2_010,
      replay_window_seconds: 300,
      claim_event_id: claim,
    };

    await expect(verifyNotificationWebhookDurably(request))
      .resolves.toEqual({ ok: true, event_id: event.event_id });
    await expect(verifyNotificationWebhookDurably(request))
      .resolves.toEqual({ ok: false, code: "REPLAYED_EVENT" });
    expect(expirations).toEqual([2_300]);
    expect(durableIds).toEqual(new Set([event.event_id]));
  });

  it("continues a claimed delivery batch when one item loses its lease", async () => {
    const event = attentionEvent();
    const claimed = ["one", "two"].map((suffix) => ({
      ...baseDelivery(),
      delivery_id: `ntd_${suffix}`,
      event_id: event.event_id,
      sink_id: "operations",
      status: "leased" as const,
      lease_owner: "dispatcher_test",
      lease_id: `lease_${suffix}`,
      lease_expires_at: "2026-07-24T12:01:00.000Z",
      delivered_at: undefined,
      external_reference: undefined,
    }));
    const leaseError = Object.assign(new Error("lease changed"), {
      code: "NOTIFICATION_LEASE_MISMATCH",
    });
    const output: string[] = [];
    const store = {
      claimNotificationDeliveries: async () => claimed,
      listAttentionItems: async () => [],
      getAttentionEvent: async () => event,
      completeNotificationDelivery: async (input: { delivery_id: string }) => {
        if (input.delivery_id === "ntd_one") throw leaseError;
        return { ...claimed[1]!, status: "delivered" as const };
      },
      failNotificationDelivery: async (input: { delivery_id: string }) => {
        if (input.delivery_id === "ntd_one") throw leaseError;
        return { ...claimed[1]!, status: "dead_letter" as const };
      },
    } as any;

    await expect(dispatchNotificationDeliveries({
      store,
      config: quietConfig(),
      owner: "dispatcher_test",
      now: "2026-07-24T12:00:02.000Z",
      output: (line) => output.push(line),
      deliver: async ({ envelope }) => ({ external_reference: `accepted:${envelope.id}` }),
    })).resolves.toEqual({
      claimed: 2,
      delivered: 1,
      retry_wait: 0,
      dead_letter: 0,
      lease_lost: 1,
    });
    expect(output.join("")).toContain("ntd_one lease changed before finalization; skipped");
  });
});

function quietConfig(): RuntimeNotificationsConfig {
  return {
    enabled: true,
    workbench_url_env: "SYNAPSOR_WORKBENCH_URL",
    sinks: [{
      id: "operations",
      type: "webhook",
      url_env: "SYNAPSOR_NOTIFY_WEBHOOK_URL",
      signing_secret_env: "SYNAPSOR_NOTIFY_SIGNING_SECRET",
      minimum_severity: "informational",
      delivery: "immediate",
      max_attempts: 5,
      timeout_ms: 3000,
      max_response_bytes: 1024,
      replay_window_seconds: 300,
      budgets: {
        per_minute: 10,
        per_hour: 100,
        immediate_informational_per_hour: 0,
        cooldown_seconds: 300,
      },
    }],
  };
}

function attentionEvent(
  overrides: Partial<AttentionEvent> = {},
): AttentionEvent {
  const unsigned = {
    schema_version: "synapsor.attention-event.v1" as const,
    event_id: "ate_test",
    event_type: "proposal.review_required" as const,
    severity: "warning" as const,
    occurred_at: now,
    environment: "production",
    proposal_id: "wrp_test",
    capability: "billing.propose_credit",
    attention_key: "production:billing.propose_credit:review",
    attention_required: true,
    immediate_default: true,
    summary: "Proposal needs manager review",
    workbench_path: "/attention/att_review",
    details: { source_database_changed: false },
    payload_hash: `sha256:${"a".repeat(64)}` as const,
  };
  return { ...unsigned, ...overrides } as AttentionEvent;
}

function delivery(
  deliveryId: string,
  overrides: Partial<ReturnType<typeof baseDelivery>> = {},
): ReturnType<typeof baseDelivery> {
  return { ...baseDelivery(), delivery_id: deliveryId, ...overrides };
}

function baseDelivery() {
  return {
    delivery_id: "ntd_test",
    sink_id: "operations",
    event_id: "ate_test",
    attention_id: "att_test",
    status: "delivered" as const,
    attempts: 1,
    max_attempts: 5,
    next_attempt_at: now,
    external_reference: "http-204",
    delivered_at: now,
    created_at: "2026-07-24T11:59:30.000Z",
    updated_at: "2026-07-24T11:59:30.000Z",
  };
}
