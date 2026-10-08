import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AttentionEvent, NotificationDelivery } from "@synapsor-runner/proposal-store";
import { formatCliErrorHint } from "./cli-logging.js";
import { dispatchNotificationDeliveries, type NotificationStore } from "./notifications.js";

describe("B64 NEW9 typed operational projections", () => {
  it("I03556 does not turn certificate prose into TLS cause or weaker verification advice", () => {
    expect(formatCliErrorHint("self-signed certificate unable to verify certificate chain")).toBe("");
  });

  it("I03556 uses an actual TLS error code without asserting database reachability or no-verify", () => {
    const error = Object.assign(new Error("opaque 漢字"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    // The cast preserves the current public signature until the typed consumer is implemented.
    const hint = formatCliErrorHint(error as unknown as string);
    expect(hint).toContain("TLS certificate verification failed");
    expect(hint).not.toMatch(/database is reachable|no-verify/iu);
  });

  it.each([
    { error: new Error("temporary timeout reset unavailable"), retryable: false, code: "NOTIFICATION_TRANSPORT_FAILED" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "ECONNRESET" }), retryable: true, code: "NOTIFICATION_TRANSPORT_TRANSIENT" },
    { error: Object.assign(new Error("temporary timeout reset"), { code: "EINVAL" }), retryable: false, code: "NOTIFICATION_TRANSPORT_FAILED" },
  ])("I03553 actual dispatch retry state uses typed transport facts ($code, $retryable)", async ({ error, retryable, code }) => {
    const event: AttentionEvent = { schema_version: "synapsor.attention-event.v1", event_id: "ate_new9",
      event_type: "proposal.review_required", severity: "warning", occurred_at: "2026-10-08T00:00:00Z",
      environment: "production", attention_required: true, immediate_default: true, summary: "Review pending",
      details: {}, payload_hash: canonicalJsonDigest("new9 event") };
    const delivery = { delivery_id: "ntd_new9", sink_id: "operations", event_id: event.event_id,
      status: "leased", attempts: 1, max_attempts: 5, lease_id: "lease-new9", lease_owner: "new9",
      next_attempt_at: event.occurred_at, created_at: event.occurred_at, updated_at: event.occurred_at } as NotificationDelivery;
    const fail = vi.fn(async (input: { retryable: boolean }) => ({ ...delivery,
      status: input.retryable ? "retry_wait" as const : "dead_letter" as const }));
    const complete = vi.fn();
    const store = { claimNotificationDeliveries: async () => [delivery], listAttentionItems: async () => [],
      getAttentionEvent: async () => event, failNotificationDelivery: fail, completeNotificationDelivery: complete } as unknown as NotificationStore;
    const result = await dispatchNotificationDeliveries({ store, owner: "new9", now: event.occurred_at,
      config: { enabled: true, sinks: [{ id: "operations", type: "console" }] },
      deliver: async () => { throw error; }, output: () => {} });
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0]![0]).toMatchObject({ retryable, error_code: code });
    expect(result).toMatchObject({ claimed: 1, delivered: 0, retry_wait: retryable ? 1 : 0, dead_letter: retryable ? 0 : 1 });
    expect(complete).not.toHaveBeenCalled();
  });
});
