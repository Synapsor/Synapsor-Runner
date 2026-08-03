import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type {
  AttentionEvent,
  AttentionItem,
  NotificationDelivery,
  NotificationDeliveryStatus,
  RecordAttentionEventInput,
} from "@synapsor-runner/proposal-store";
import type {
  RuntimeNotificationSinkConfig,
  RuntimeNotificationsConfig,
} from "@synapsor-runner/mcp-server";

type Awaitable<T> = T | Promise<T>;

export type NotificationStore = {
  recordAttentionEvent(input: RecordAttentionEventInput): Awaitable<AttentionEvent>;
  listAttentionEvents(filters?: {
    from?: string;
    limit?: number;
  }): Awaitable<AttentionEvent[]>;
  getAttentionEvent(eventId: string): Awaitable<AttentionEvent | undefined>;
  listAttentionItems(filters?: {
    limit?: number;
  }): Awaitable<AttentionItem[]>;
  enqueueNotificationDelivery(input: {
    sink_id: string;
    event_id: string;
    attention_id?: string;
    max_attempts?: number;
    status?: "pending" | "batched" | "suppressed";
    next_attempt_at?: string;
    now?: string;
  }): Awaitable<NotificationDelivery>;
  includeNotificationDeliveriesInDigest(input: {
    sink_id: string;
    delivery_ids: string[];
    digest_event_id: string;
    now?: string;
  }): Awaitable<number>;
  claimNotificationDeliveries(input: {
    owner: string;
    sink_id?: string;
    limit?: number;
    lease_seconds?: number;
    now?: string;
  }): Awaitable<NotificationDelivery[]>;
  completeNotificationDelivery(input: {
    delivery_id: string;
    owner: string;
    lease_id: string;
    external_reference?: string;
    now?: string;
  }): Awaitable<NotificationDelivery>;
  failNotificationDelivery(input: {
    delivery_id: string;
    owner: string;
    lease_id: string;
    error_code: string;
    retryable: boolean;
    retry_at?: string;
    now?: string;
  }): Awaitable<NotificationDelivery>;
  listNotificationDeliveries(filters?: {
    status?: NotificationDeliveryStatus;
    sink_id?: string;
    event_id?: string;
    attention_id?: string;
    limit?: number;
  }): Awaitable<NotificationDelivery[]>;
};

export type NotificationRouteDecision = {
  status: "pending" | "batched" | "suppressed";
  not_before?: string;
  reason:
    | "immediate"
    | "digest"
    | "quiet_default"
    | "quiet_hours"
    | "coalesced"
    | "reminder_budget"
    | "informational_budget"
    | "rate_budget"
    | "emergency_budget"
    | "filtered";
};

export type NotificationEnvelope = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  datacontenttype: "application/json";
  data: {
    schema_version: "synapsor.notification.v1";
    severity: AttentionEvent["severity"];
    environment: string;
    summary: string;
    proposal_id?: string;
    job_id?: string;
    operation_id?: string;
    correlation_id?: string;
    capability?: string;
    contract_digest?: string;
    attention_id?: string;
    occurrence_count?: number;
    approval_source?: AttentionEvent["approval_source"];
    worker_state?: string;
    failure_class?: string;
    expires_at?: string;
    workbench_url?: string;
    details: AttentionEvent["details"];
  };
};

export type NotificationWebhookHeaders = {
  "content-type": "application/cloudevents+json";
  "content-length": string;
  "user-agent": "synapsor-runner-notifications/1";
  "x-synapsor-event-id": string;
  "x-synapsor-signature": string;
  "x-synapsor-signature-version": "v1";
  "x-synapsor-timestamp": string;
};

export type NotificationPlanResult = {
  examined_events: number;
  pending: number;
  batched: number;
  suppressed: number;
  digests: number;
};

export type NotificationDispatchResult = {
  claimed: number;
  delivered: number;
  retry_wait: number;
  dead_letter: number;
  lease_lost: number;
};

export type NotificationWebhookReplayClaim = (input: {
  event_id: string;
  expires_at_seconds: number;
}) => Awaitable<boolean>;

type Address = {
  address: string;
  family: 4 | 6;
};

type DeliveryResult = {
  external_reference?: string;
};

const severityRank = {
  informational: 0,
  warning: 1,
  critical: 2,
} as const;

const defaultPerMinute = 10;
const defaultPerHour = 100;
const criticalEmergencyPerHour = 100;
const defaultCooldownSeconds = 300;
const defaultAggregationWindowSeconds = 300;
const defaultDigestCadenceMinutes = 1_440;
const maximumEnvelopeBytes = 65_536;

export async function planNotificationDeliveries(input: {
  store: NotificationStore;
  config?: RuntimeNotificationsConfig;
  now?: string;
  event_limit?: number;
}): Promise<NotificationPlanResult> {
  const result: NotificationPlanResult = {
    examined_events: 0,
    pending: 0,
    batched: 0,
    suppressed: 0,
    digests: 0,
  };
  if (!input.config?.enabled) return result;

  const now = input.now ?? new Date().toISOString();
  assertIsoTime(now, "notification planning time");
  const [events, attentionItems] = await Promise.all([
    input.store.listAttentionEvents({ limit: Math.max(1, Math.min(input.event_limit ?? 1_000, 1_000)) }),
    input.store.listAttentionItems({ limit: 1_000 }),
  ]);
  const attentionByKey = new Map(attentionItems.map((item) => [item.attention_key, item]));
  const orderedEvents = [...events].sort((left, right) =>
    left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));

  for (const event of orderedEvents) {
    if (event.event_type === "notification.digest") continue;
    result.examined_events += 1;
    const attention = event.attention_key ? attentionByKey.get(event.attention_key) : undefined;
    for (const sink of input.config.sinks) {
      if (sink.enabled === false) continue;
      const existing = await input.store.listNotificationDeliveries({
        sink_id: sink.id,
        ...(attention ? { attention_id: attention.attention_id } : { event_id: event.event_id }),
        limit: 1_000,
      });
      if (existing.some((delivery) => delivery.event_id === event.event_id)) continue;
      const sinkHistory = await input.store.listNotificationDeliveries({
        sink_id: sink.id,
        limit: 1_000,
      });
      const decision = decideNotificationRoute({ event, sink, existing, sinkHistory, now });
      await input.store.enqueueNotificationDelivery({
        sink_id: sink.id,
        event_id: event.event_id,
        ...(attention ? { attention_id: attention.attention_id } : {}),
        max_attempts: sink.max_attempts,
        status: decision.status,
        ...(decision.not_before
          ? { next_attempt_at: decision.not_before }
          : decision.status === "batched"
            ? { next_attempt_at: notificationBatchDueAt(sink, decision.reason, now) }
            : {}),
        now,
      });
      result[decision.status] += 1;
    }
  }
  result.digests = await materializeDueNotificationDigests({
    store: input.store,
    config: input.config,
    now,
  });
  return result;
}

export function decideNotificationRoute(input: {
  event: AttentionEvent;
  sink: RuntimeNotificationSinkConfig;
  existing?: NotificationDelivery[];
  sinkHistory?: NotificationDelivery[];
  now?: string;
}): NotificationRouteDecision {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("notification route time must be an ISO timestamp");
  const { event, sink } = input;
  if (!matchesSinkFilters(event, sink)) return { status: "suppressed", reason: "filtered" };

  const delivery = sink.delivery ?? "immediate";
  if (delivery === "digest" && !(event.severity === "critical" && event.immediate_default)) {
    return { status: "batched", reason: "digest" };
  }
  const retryEscalation = retryEscalationDecision(event, sink, nowMs);
  const immediateDefault = event.immediate_default || retryEscalation !== undefined;
  if (delivery !== "all" && !immediateDefault) {
    return { status: "suppressed", reason: "quiet_default" };
  }

  const existing = input.existing ?? [];
  const cooldownMs = (sink.budgets?.cooldown_seconds ?? defaultCooldownSeconds) * 1_000;
  const recentIncidentDelivery = existing.some((item) =>
    item.event_id !== event.event_id
    && item.status !== "suppressed"
    && item.status !== "batched"
    && item.status !== "dead_letter"
    && nowMs - Date.parse(item.updated_at) <= cooldownMs);
  if (recentIncidentDelivery) return { status: "suppressed", reason: "coalesced" };
  const priorInterruptions = existing.filter((item) =>
    !["suppressed", "batched"].includes(item.status)).length;
  if (priorInterruptions >= 1 + (sink.budgets?.max_unresolved_reminders ?? 0)) {
    return { status: "suppressed", reason: "reminder_budget" };
  }

  if (event.severity !== "critical" && isQuietHour(sink, new Date(nowMs))) {
    return { status: "batched", reason: "quiet_hours" };
  }

  const history = (input.sinkHistory ?? []).filter((item) =>
    item.status !== "suppressed" && item.status !== "batched");
  const pastMinute = history.filter((item) => nowMs - Date.parse(item.created_at) < 60_000).length;
  const pastHour = history.filter((item) => nowMs - Date.parse(item.created_at) < 3_600_000).length;
  if (event.severity === "critical") {
    if (pastHour >= criticalEmergencyPerHour) {
      return { status: "suppressed", reason: "emergency_budget" };
    }
  } else if (
    event.severity === "informational"
    && event.event_type !== "worker.recovered"
    && pastHour >= (sink.budgets?.immediate_informational_per_hour ?? 0)
  ) {
    return { status: "batched", reason: "informational_budget" };
  } else if (
    pastMinute >= (sink.budgets?.per_minute ?? defaultPerMinute)
    || pastHour >= (sink.budgets?.per_hour ?? defaultPerHour)
  ) {
    return { status: "batched", reason: "rate_budget" };
  }

  return {
    status: "pending",
    reason: "immediate",
    ...(retryEscalation?.not_before ? { not_before: retryEscalation.not_before } : {}),
  };
}

function retryEscalationDecision(
  event: AttentionEvent,
  sink: RuntimeNotificationSinkConfig,
  nowMs: number,
): { not_before?: string } | undefined {
  if (event.event_type !== "worker.retry_scheduled") return undefined;
  const attempt = Number(event.details.attempt);
  const threshold = sink.budgets?.retry_attempt_threshold ?? 3;
  // One threshold crossing creates one interruption. Later attempts remain in
  // the ledger until either recovery or the terminal dead-letter event.
  if (!Number.isSafeInteger(attempt) || attempt !== threshold) return undefined;
  const delayMs = (sink.budgets?.escalation_delay_seconds ?? 0) * 1_000;
  const notBeforeMs = Date.parse(event.occurred_at) + delayMs;
  if (!Number.isFinite(notBeforeMs) || notBeforeMs <= nowMs) return {};
  return { not_before: new Date(notBeforeMs).toISOString() };
}

async function materializeDueNotificationDigests(input: {
  store: NotificationStore;
  config: RuntimeNotificationsConfig;
  now: string;
}): Promise<number> {
  const nowMs = Date.parse(input.now);
  let digests = 0;
  for (const sink of input.config.sinks) {
    if (sink.enabled === false || isQuietHour(sink, new Date(nowMs))) continue;
    const due = (await input.store.listNotificationDeliveries({
      status: "batched",
      sink_id: sink.id,
      limit: 1_000,
    }))
      .filter((delivery) => Date.parse(delivery.next_attempt_at) <= nowMs)
      .sort((left, right) =>
        left.created_at.localeCompare(right.created_at)
        || left.delivery_id.localeCompare(right.delivery_id));
    if (due.length === 0) continue;
    const events = (await Promise.all(
      due.map((delivery) => input.store.getAttentionEvent(delivery.event_id)),
    )).filter((event): event is AttentionEvent =>
      event !== undefined && event.event_type !== "notification.digest");
    if (events.length === 0) continue;

    const digestIdentity = crypto.createHash("sha256")
      .update(JSON.stringify({
        sink_id: sink.id,
        event_ids: events.map((event) => event.event_id).sort(),
      }))
      .digest("hex");
    const details = notificationDigestDetails(events);
    const environment = new Set(events.map((event) => event.environment)).size === 1
      ? events[0]!.environment
      : "unknown";
    const digestEvent = await input.store.recordAttentionEvent({
      event_type: "notification.digest",
      severity: "informational",
      environment,
      attention_required: false,
      immediate_default: true,
      summary: notificationDigestSummary(details),
      workbench_path: "/",
      details,
      source_event_key: `notification-digest:${sink.id}:${digestIdentity}`,
      now: input.now,
    });
    await input.store.enqueueNotificationDelivery({
      sink_id: sink.id,
      event_id: digestEvent.event_id,
      max_attempts: sink.max_attempts,
      status: "pending",
      now: input.now,
    });
    await input.store.includeNotificationDeliveriesInDigest({
      sink_id: sink.id,
      delivery_ids: due.map((delivery) => delivery.delivery_id),
      digest_event_id: digestEvent.event_id,
      now: input.now,
    });
    digests += 1;
  }
  return digests;
}

function notificationBatchDueAt(
  sink: RuntimeNotificationSinkConfig,
  reason: NotificationRouteDecision["reason"],
  now: string,
): string {
  const delayMs = reason === "digest"
    ? (sink.budgets?.digest_cadence_minutes ?? defaultDigestCadenceMinutes) * 60_000
    : (sink.budgets?.aggregation_window_seconds ?? defaultAggregationWindowSeconds) * 1_000;
  return new Date(Date.parse(now) + delayMs).toISOString();
}

function notificationDigestDetails(
  events: AttentionEvent[],
): Record<string, string | number | boolean | null> {
  const count = (...types: AttentionEvent["event_type"][]) =>
    events.filter((event) => types.includes(event.event_type)).length;
  return {
    event_count: events.length,
    from: events[0]!.occurred_at,
    through: events.at(-1)!.occurred_at,
    proposals_created: count("proposal.created"),
    auto_approved: count("proposal.auto_approved"),
    applied: count("proposal.applied"),
    review_required: count("proposal.review_required", "capability.review_required"),
    conflicts: count("proposal.conflict"),
    retries: count("worker.retry_scheduled"),
    dead_letters: count("worker.dead_lettered"),
    limits: count("policy.limit_near", "policy.limit_exceeded"),
    unresolved_critical: events.filter((event) => event.severity === "critical").length,
    source_database_changed: events.some((event) => event.details.source_database_changed === true),
  };
}

function notificationDigestSummary(
  details: Record<string, string | number | boolean | null>,
): string {
  return [
    `Runner digest: ${details.event_count} recorded event${details.event_count === 1 ? "" : "s"}`,
    `${details.review_required} need review`,
    `${details.applied} applied`,
    `${details.dead_letters} dead-lettered`,
  ].join(", ");
}

export function buildNotificationEnvelope(input: {
  event: AttentionEvent;
  attention?: AttentionItem;
  workbench_base_url?: string;
}): NotificationEnvelope {
  const workbenchUrl = safeWorkbenchUrl(input.workbench_base_url, input.event.workbench_path);
  return {
    specversion: "1.0",
    id: input.event.event_id,
    source: `urn:synapsor:runner:${safeUrnSegment(input.event.environment)}`,
    type: `ai.synapsor.${input.event.event_type}`,
    time: input.event.occurred_at,
    ...(input.event.capability ? { subject: input.event.capability } : {}),
    datacontenttype: "application/json",
    data: {
      schema_version: "synapsor.notification.v1",
      severity: input.event.severity,
      environment: input.event.environment,
      summary: input.event.summary,
      ...(input.event.proposal_id ? { proposal_id: input.event.proposal_id } : {}),
      ...(input.event.job_id ? { job_id: input.event.job_id } : {}),
      ...(input.event.operation_id ? { operation_id: input.event.operation_id } : {}),
      ...(input.event.correlation_id ? { correlation_id: input.event.correlation_id } : {}),
      ...(input.event.capability ? { capability: input.event.capability } : {}),
      ...(input.event.contract_digest ? { contract_digest: input.event.contract_digest } : {}),
      ...(input.attention ? {
        attention_id: input.attention.attention_id,
        occurrence_count: input.attention.occurrence_count,
      } : {}),
      ...(input.event.approval_source ? { approval_source: input.event.approval_source } : {}),
      ...(input.event.worker_state ? { worker_state: input.event.worker_state } : {}),
      ...(input.event.failure_class ? { failure_class: input.event.failure_class } : {}),
      ...(input.event.expires_at ? { expires_at: input.event.expires_at } : {}),
      ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
      details: input.event.details,
    },
  };
}

export function signNotificationWebhook(input: {
  body: string;
  event_id: string;
  secret: string;
  timestamp_seconds?: number;
}): NotificationWebhookHeaders {
  if (Buffer.byteLength(input.secret) < 32) {
    throw new Error("notification webhook signing secret must contain at least 32 bytes");
  }
  const timestamp = String(input.timestamp_seconds ?? Math.floor(Date.now() / 1_000));
  const signature = webhookSignature(input.secret, timestamp, input.event_id, input.body);
  return {
    "content-type": "application/cloudevents+json",
    "content-length": String(Buffer.byteLength(input.body)),
    "user-agent": "synapsor-runner-notifications/1",
    "x-synapsor-event-id": input.event_id,
    "x-synapsor-signature": `sha256=${signature}`,
    "x-synapsor-signature-version": "v1",
    "x-synapsor-timestamp": timestamp,
  };
}

export function verifyNotificationWebhook(input: {
  body: string;
  event_id: string;
  timestamp: string;
  signature: string;
  signature_version: string;
  secret: string;
  now_seconds?: number;
  replay_window_seconds?: number;
  seen_event_ids?: Set<string>;
}): { ok: true; event_id: string } | { ok: false; code: string } {
  if (input.signature_version !== "v1") return { ok: false, code: "UNSUPPORTED_SIGNATURE_VERSION" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, code: "INVALID_TIMESTAMP" };
  const timestamp = Number(input.timestamp);
  const now = input.now_seconds ?? Math.floor(Date.now() / 1_000);
  const window = Math.max(30, Math.min(input.replay_window_seconds ?? 300, 3_600));
  if (Math.abs(now - timestamp) > window) return { ok: false, code: "STALE_WEBHOOK" };
  if (!input.signature.startsWith("sha256=")) return { ok: false, code: "INVALID_SIGNATURE" };
  const supplied = Buffer.from(input.signature.slice("sha256=".length), "hex");
  const expected = Buffer.from(
    webhookSignature(input.secret, input.timestamp, input.event_id, input.body),
    "hex",
  );
  if (
    supplied.length !== expected.length
    || !crypto.timingSafeEqual(supplied, expected)
  ) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
  if (input.seen_event_ids?.has(input.event_id)) return { ok: false, code: "REPLAYED_EVENT" };
  input.seen_event_ids?.add(input.event_id);
  return { ok: true, event_id: input.event_id };
}

export async function verifyNotificationWebhookDurably(input: {
  body: string;
  event_id: string;
  timestamp: string;
  signature: string;
  signature_version: string;
  secret: string;
  claim_event_id: NotificationWebhookReplayClaim;
  now_seconds?: number;
  replay_window_seconds?: number;
}): Promise<{ ok: true; event_id: string } | { ok: false; code: string }> {
  const verified = verifyNotificationWebhook(input);
  if (!verified.ok) return verified;
  const window = Math.max(30, Math.min(input.replay_window_seconds ?? 300, 3_600));
  const claimed = await input.claim_event_id({
    event_id: input.event_id,
    expires_at_seconds: Number(input.timestamp) + window,
  });
  return claimed ? verified : { ok: false, code: "REPLAYED_EVENT" };
}

export async function dispatchNotificationDeliveries(input: {
  store: NotificationStore;
  config?: RuntimeNotificationsConfig;
  owner: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  limit?: number;
  output?: (line: string) => void;
  deliver?: (input: {
    sink: RuntimeNotificationSinkConfig;
    envelope: NotificationEnvelope;
    env: NodeJS.ProcessEnv;
    output: (line: string) => void;
  }) => Promise<DeliveryResult>;
}): Promise<NotificationDispatchResult> {
  const result: NotificationDispatchResult = {
    claimed: 0,
    delivered: 0,
    retry_wait: 0,
    dead_letter: 0,
    lease_lost: 0,
  };
  if (!input.config?.enabled) return result;
  const now = input.now ?? new Date().toISOString();
  assertIsoTime(now, "notification dispatch time");
  const sinks = new Map(input.config.sinks.filter((sink) => sink.enabled !== false).map((sink) => [sink.id, sink]));
  const claimed = await input.store.claimNotificationDeliveries({
    owner: input.owner,
    limit: input.limit,
    lease_seconds: 60,
    now,
  });
  result.claimed = claimed.length;
  const output = input.output ?? ((line) => process.stdout.write(line));
  const deliver = input.deliver ?? deliverNotification;
  const attentionItems = await input.store.listAttentionItems({ limit: 1_000 });
  const attentionById = new Map(attentionItems.map((item) => [item.attention_id, item]));

  for (const item of claimed) {
    if (!item.lease_id) {
      result.lease_lost += 1;
      output(`Notification delivery ${item.delivery_id} has no active lease; skipped.\n`);
      continue;
    }
    const sink = sinks.get(item.sink_id);
    try {
      if (!sink) throw new NotificationDeliveryError("NOTIFICATION_SINK_DISABLED", false);
      const event = await input.store.getAttentionEvent(item.event_id);
      if (!event) throw new NotificationDeliveryError("NOTIFICATION_EVENT_MISSING", false);
      const workbenchBase = input.config.workbench_url_env
        ? input.env?.[input.config.workbench_url_env] ?? process.env[input.config.workbench_url_env]
        : undefined;
      const envelope = buildNotificationEnvelope({
        event,
        ...(item.attention_id ? { attention: attentionById.get(item.attention_id) } : {}),
        workbench_base_url: workbenchBase,
      });
      const deliveryResult = await deliver({
        sink,
        envelope,
        env: input.env ?? process.env,
        output,
      });
      await input.store.completeNotificationDelivery({
        delivery_id: item.delivery_id,
        owner: input.owner,
        lease_id: item.lease_id,
        external_reference: deliveryResult.external_reference,
        now,
      });
      result.delivered += 1;
    } catch (error) {
      const classified = classifyDeliveryError(error);
      const retryAt = new Date(
        Date.parse(now) + boundedRetryDelayMs(item.attempts, item.delivery_id),
      ).toISOString();
      let failed: NotificationDelivery;
      try {
        failed = await input.store.failNotificationDelivery({
          delivery_id: item.delivery_id,
          owner: input.owner,
          lease_id: item.lease_id,
          error_code: classified.code,
          retryable: classified.retryable,
          retry_at: retryAt,
          now,
        });
      } catch (finalizationError) {
        if (!isNotificationLeaseLoss(finalizationError)) throw finalizationError;
        result.lease_lost += 1;
        output(`Notification delivery ${item.delivery_id} lease changed before finalization; skipped.\n`);
        continue;
      }
      if (failed.status === "retry_wait") result.retry_wait += 1;
      else result.dead_letter += 1;
    }
  }
  return result;
}

function isNotificationLeaseLoss(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "NOTIFICATION_LEASE_MISMATCH" || code === "NOTIFICATION_LEASE_EXPIRED";
}

export async function deliverNotification(input: {
  sink: RuntimeNotificationSinkConfig;
  envelope: NotificationEnvelope;
  env: NodeJS.ProcessEnv;
  output: (line: string) => void;
}): Promise<DeliveryResult> {
  if (input.sink.type === "jsonl") {
    input.output(`${JSON.stringify(input.envelope)}\n`);
    return { external_reference: `stdout:${input.envelope.id}` };
  }
  return await deliverWebhook(input.sink, input.envelope, input.env);
}

export async function resolveNotificationWebhookTarget(input: {
  raw_url: string;
  allow_private_destinations?: boolean;
  private_host_allowlist?: string[];
  lookup?: (hostname: string) => Promise<Address[]>;
}): Promise<{ url: URL; address: Address }> {
  let url: URL;
  try {
    url = new URL(input.raw_url);
  } catch {
    throw new NotificationDeliveryError("NOTIFICATION_URL_INVALID", false);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || !url.hostname
  ) {
    throw new NotificationDeliveryError("NOTIFICATION_URL_UNSAFE", false);
  }
  const lookup = input.lookup ?? (async (hostname: string) => {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.map((item) => ({
      address: item.address,
      family: item.family === 6 ? 6 as const : 4 as const,
    }));
  });
  let addresses: Address[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    throw new NotificationDeliveryError("NOTIFICATION_DNS_FAILED", true);
  }
  if (addresses.length === 0) throw new NotificationDeliveryError("NOTIFICATION_DNS_EMPTY", true);
  const allowlisted = (input.private_host_allowlist ?? [])
    .some((host) => host.toLowerCase() === url.hostname.toLowerCase());
  for (const address of addresses) {
    if (isUnsafeNotificationAddress(address.address) && !(input.allow_private_destinations && allowlisted)) {
      throw new NotificationDeliveryError("NOTIFICATION_DESTINATION_BLOCKED", false);
    }
  }
  return { url, address: addresses[0]! };
}

export function isUnsafeNotificationAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    const first = octets[0]!;
    const second = octets[1]!;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isUnsafeNotificationAddress(normalized.slice("::ffff:".length));
    }
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("ff");
  }
  return true;
}

class NotificationDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "NotificationDeliveryError";
  }
}

function matchesSinkFilters(event: AttentionEvent, sink: RuntimeNotificationSinkConfig): boolean {
  if (event.event_type === "worker.recovered" && sink.recovery_notifications !== true) return false;
  const minimum = sink.minimum_severity ?? "warning";
  if (event.event_type !== "worker.recovered"
    && severityRank[event.severity] < severityRank[minimum]) return false;
  if (sink.events && !sink.events.includes(event.event_type)) return false;
  if (sink.capabilities && (!event.capability || !sink.capabilities.includes(event.capability))) return false;
  if (sink.environments && !sink.environments.includes(normalizedEnvironment(event.environment))) return false;
  return true;
}

function normalizedEnvironment(value: string): "development" | "staging" | "production" | "unknown" {
  if (value === "development" || value === "staging" || value === "production") return value;
  return "unknown";
}

function isQuietHour(sink: RuntimeNotificationSinkConfig, now: Date): boolean {
  if (!sink.quiet_hours) return false;
  const hour = now.getUTCHours();
  const { start_utc_hour: start, end_utc_hour: end } = sink.quiet_hours;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function safeWorkbenchUrl(base: string | undefined, relativePath: string | undefined): string | undefined {
  if (!base || !relativePath || !relativePath.startsWith("/")) return undefined;
  try {
    const baseUrl = new URL(base);
    if (
      (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && isLoopbackHost(baseUrl.hostname)))
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
    ) return undefined;
    const result = new URL(relativePath, baseUrl);
    if (result.origin !== baseUrl.origin || result.username || result.password) return undefined;
    return result.toString();
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function safeUrnSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64) || "unknown";
}

function webhookSignature(secret: string, timestamp: string, eventId: string, body: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`v1.${timestamp}.${eventId}.${body}`)
    .digest("hex");
}

async function deliverWebhook(
  sink: RuntimeNotificationSinkConfig,
  envelope: NotificationEnvelope,
  env: NodeJS.ProcessEnv,
): Promise<DeliveryResult> {
  const rawUrl = sink.url_env ? env[sink.url_env]?.trim() : undefined;
  const secret = sink.signing_secret_env ? env[sink.signing_secret_env] : undefined;
  if (!rawUrl) throw new NotificationDeliveryError("NOTIFICATION_URL_MISSING", false);
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new NotificationDeliveryError("NOTIFICATION_SIGNING_SECRET_MISSING", false);
  }
  const target = await resolveNotificationWebhookTarget({
    raw_url: rawUrl,
    allow_private_destinations: sink.allow_private_destinations,
    private_host_allowlist: sink.private_host_allowlist,
  });
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > maximumEnvelopeBytes) {
    throw new NotificationDeliveryError("NOTIFICATION_PAYLOAD_TOO_LARGE", false);
  }
  const headers = signNotificationWebhook({
    body,
    event_id: envelope.id,
    secret,
  });
  const timeout = sink.timeout_ms ?? 3_000;
  const maxResponseBytes = sink.max_response_bytes ?? 1_024;
  const status = await new Promise<number>((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: target.url.hostname,
      port: target.url.port ? Number(target.url.port) : 443,
      method: "POST",
      path: `${target.url.pathname}${target.url.search}`,
      servername: target.url.hostname,
      headers,
      timeout,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address.address, target.address.family);
      },
    }, (response) => {
      let responseBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > maxResponseBytes) {
          request.destroy(new NotificationDeliveryError("NOTIFICATION_RESPONSE_TOO_LARGE", false));
        }
      });
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("timeout", () => request.destroy(new NotificationDeliveryError("NOTIFICATION_TIMEOUT", true)));
    request.on("error", reject);
    request.end(body);
  });
  if (status >= 200 && status < 300) return { external_reference: `http-${status}` };
  if (status >= 300 && status < 400) throw new NotificationDeliveryError("NOTIFICATION_REDIRECT_REFUSED", false);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    throw new NotificationDeliveryError(`NOTIFICATION_HTTP_${status}`, true);
  }
  throw new NotificationDeliveryError(`NOTIFICATION_HTTP_${status}`, false);
}

function classifyDeliveryError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof NotificationDeliveryError) {
    return { code: error.code, retryable: error.retryable };
  }
  const code = error instanceof Error && /timeout|reset|unavailable|temporary/i.test(error.message)
    ? "NOTIFICATION_TRANSPORT_TRANSIENT"
    : "NOTIFICATION_TRANSPORT_FAILED";
  return { code, retryable: code === "NOTIFICATION_TRANSPORT_TRANSIENT" };
}

function boundedRetryDelayMs(attempt: number, deliveryId: string): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 8));
  const base = Math.min(1_000 * 2 ** exponent, 300_000);
  const digest = crypto.createHash("sha256").update(`${deliveryId}:${attempt}`).digest();
  const jitter = digest.readUInt16BE(0) % Math.max(1, Math.floor(base / 4));
  return base + jitter;
}

function assertIsoTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}
