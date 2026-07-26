import { resolveSupervisedWorkerEligibility, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type StoredProposal,
  type WorkerQueueItem
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";


export function notificationSinkHealth(
  deliveries: ReturnType<ProposalStore["listNotificationDeliveries"]>,
): "healthy" | "degraded" | "untested" {
  const latest = [...deliveries].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  if (!latest) return "untested";
  if (latest.status === "delivered") return "healthy";
  if (latest.status === "dead_letter") return "degraded";
  const delivered = deliveries.some((delivery) => delivery.status === "delivered");
  return delivered ? "healthy" : "untested";
}


export function requiredAttentionSinksHealthy(
  store: ProposalStore,
  config: RuntimeConfig,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): boolean {
  const required = policy.required_attention_sinks ?? [];
  if (required.length === 0) return true;
  if (!config.notifications?.enabled) return false;
  return required.every((sinkId) => {
    const configured = config.notifications?.sinks.find((sink) => sink.id === sinkId && sink.enabled !== false);
    if (!configured) return false;
    return notificationSinkHealth(store.listNotificationDeliveries({ sink_id: sinkId, limit: 1_000 })) === "healthy";
  });
}


export function updateSupervisedWorkerBacklogAttention(
  store: ProposalStore,
  config: RuntimeConfig,
): void {
  const environment = config.supervised_worker?.profile ?? "unknown";
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  for (const policy of config.supervised_worker?.capabilities ?? []) {
    const matchingSinks = (config.notifications?.sinks ?? []).filter((sink) =>
      sink.enabled !== false
      && (!sink.capabilities || sink.capabilities.includes(policy.capability))
      && (!sink.environments || sink.environments.includes(environment))
      && (!sink.events || sink.events.includes("worker.queue_backlog")));
    const depthThreshold = Math.min(
      ...((matchingSinks.length ? matchingSinks : [{ budgets: undefined }])
        .map((sink) => sink.budgets?.queue_depth_threshold ?? 100)),
    );
    const ageThreshold = Math.min(
      ...((matchingSinks.length ? matchingSinks : [{ budgets: undefined }])
        .map((sink) => sink.budgets?.queue_age_seconds ?? 300)),
    );
    const groups = new Map<string, {
      proposal: StoredProposal;
      items: WorkerQueueItem[];
      scope_digest: `sha256:${string}`;
    }>();
    for (const item of store.listWorkerQueue().filter((candidate) =>
      candidate.execution_mode === "supervised_worker"
      && candidate.contract_digest === policy.contract_digest
      && (candidate.status === "queued" || candidate.status === "retry_wait"))) {
      const proposal = store.getProposal(item.proposal_id);
      if (!proposal || proposal.action !== policy.capability) continue;
      const scopeDigest = canonicalJsonDigest({
        tenant_id: proposal.tenant_id,
        principal: proposal.principal ?? null,
      });
      const group = groups.get(scopeDigest) ?? { proposal, items: [], scope_digest: scopeDigest };
      group.items.push(item);
      if (item.created_at < group.proposal.created_at) group.proposal = proposal;
      groups.set(scopeDigest, group);
    }
    const activeAttentionKeys = new Set<string>();
    for (const group of groups.values()) {
      const oldest = [...group.items].sort((left, right) =>
        left.created_at.localeCompare(right.created_at))[0]!;
      const oldestAgeSeconds = Math.max(0, Math.floor((nowMs - Date.parse(oldest.created_at)) / 1_000));
      const thresholdCrossed = group.items.length >= depthThreshold || oldestAgeSeconds >= ageThreshold;
      const attentionKey = [
        environment,
        "worker.queue_backlog",
        policy.capability,
        policy.contract_digest,
        group.scope_digest,
      ].join(":");
      const stateKey = `notification_worker_backlog:${canonicalJsonDigest({ attention_key: attentionKey })}`;
      const previous = store.getRunnerState(stateKey) ?? {};
      if (!thresholdCrossed) {
        if (previous.active === true) {
          const existing = store.getAttentionItem(workbenchAttentionId(attentionKey));
          if (existing && existing.status !== "resolved" && existing.status !== "expired") {
            store.resolveAttention({ attention_id: existing.attention_id });
          }
          store.setRunnerState(stateKey, {
            active: false,
            resolved_at: now,
            last_depth: group.items.length,
            last_oldest_age_seconds: oldestAgeSeconds,
          });
        }
        continue;
      }
      activeAttentionKeys.add(attentionKey);
      const firstObservedAt = previous.active === true && typeof previous.first_observed_at === "string"
        ? previous.first_observed_at
        : now;
      store.setRunnerState(stateKey, {
        active: true,
        first_observed_at: firstObservedAt,
        last_observed_at: now,
        depth: group.items.length,
        oldest_age_seconds: oldestAgeSeconds,
      });
      if (previous.active === true) continue;
      store.recordAttentionEvent({
        event_type: "worker.queue_backlog",
        severity: "warning",
        environment,
        proposal_id: oldest.proposal_id,
        capability: policy.capability,
        contract_digest: policy.contract_digest,
        attention_key: attentionKey,
        attention_required: true,
        immediate_default: true,
        summary: `${policy.capability} trusted-execution queue needs operator attention`,
        worker_state: "backlog",
        workbench_path: workbenchAttentionPath(attentionKey),
        details: {
          queue_depth: group.items.length,
          oldest_queue_age_seconds: oldestAgeSeconds,
          queue_depth_threshold: depthThreshold,
          queue_age_threshold_seconds: ageThreshold,
          source_database_changed: false,
        },
        source_event_key: `worker-queue-backlog:${policy.contract_digest}:${group.scope_digest}:${firstObservedAt}`,
        now,
      });
    }
    for (const item of store.listAttentionItems({ capability: policy.capability, limit: 1_000 })) {
      if (item.event_type !== "worker.queue_backlog"
        || item.contract_digest !== policy.contract_digest
        || activeAttentionKeys.has(item.attention_key)
        || item.status === "resolved"
        || item.status === "expired") continue;
      store.resolveAttention({ attention_id: item.attention_id });
    }
  }
}


export function updateSupervisedProposalExpiryAttention(
  store: ProposalStore,
  config: RuntimeConfig,
  now = new Date().toISOString(),
): void {
  const environment = config.supervised_worker?.profile ?? "unknown";
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("proposal expiry scan requires a valid ISO timestamp");

  for (const policy of config.supervised_worker?.capabilities ?? []) {
    const warningSeconds = Math.min(
      3_600,
      Math.max(60, Math.floor(policy.proposal_ttl_seconds / 10)),
    );
    const activeKeys = new Set<string>();
    for (const item of store.listWorkerQueue().filter((candidate) =>
      candidate.execution_mode === "supervised_worker"
      && candidate.contract_digest === policy.contract_digest
      && (
        candidate.status === "queued"
        || candidate.status === "retry_wait"
        || (
          candidate.status === "leased"
          && Date.parse(candidate.lease_expires_at ?? "") <= nowMs
        )
      ))) {
      const proposal = store.getProposal(item.proposal_id);
      if (
        !proposal
        || proposal.action !== policy.capability
        || (proposal.state !== "approved" && proposal.state !== "pending_worker")
      ) {
        continue;
      }
      const expiresAtMs = Date.parse(proposal.created_at) + policy.proposal_ttl_seconds * 1_000;
      const remainingSeconds = Math.ceil((expiresAtMs - nowMs) / 1_000);
      if (remainingSeconds <= 0 || remainingSeconds > warningSeconds) continue;

      const attentionKey = [
        environment,
        "proposal.expiring",
        proposal.proposal_id,
        policy.capability,
        policy.contract_digest,
      ].join(":");
      activeKeys.add(attentionKey);
      const existing = store.getAttentionItem(workbenchAttentionId(attentionKey));
      if (existing && existing.status !== "resolved" && existing.status !== "expired") continue;
      store.recordAttentionEvent({
        event_type: "proposal.expiring",
        severity: "warning",
        environment,
        proposal_id: proposal.proposal_id,
        capability: policy.capability,
        contract_digest: policy.contract_digest,
        attention_key: attentionKey,
        attention_required: true,
        immediate_default: true,
        summary: `${policy.capability} proposal is approaching expiry while operator action is still possible`,
        approval_source: proposal.change_set.approval.mode === "policy" ? "policy_auto" : "human",
        worker_state: item.status,
        expires_at: new Date(expiresAtMs).toISOString(),
        workbench_path: workbenchAttentionPath(attentionKey),
        details: {
          seconds_remaining: remainingSeconds,
          warning_window_seconds: warningSeconds,
          source_database_changed: false,
        },
        source_event_key: `proposal-expiring:${proposal.proposal_id}:${policy.contract_digest}`,
        now,
      });
    }

    for (const attention of store.listAttentionItems({
      capability: policy.capability,
      limit: 1_000,
    })) {
      if (
        attention.event_type !== "proposal.expiring"
        || attention.contract_digest !== policy.contract_digest
        || activeKeys.has(attention.attention_key)
        || attention.status === "resolved"
        || attention.status === "expired"
      ) {
        continue;
      }
      store.resolveAttention({ attention_id: attention.attention_id, now });
    }
  }
}


export function recordUnhealthySupervisionSinkAttention(
  store: ProposalStore,
  config: RuntimeConfig,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): void {
  const now = new Date().toISOString();
  const sinkStates = (policy.required_attention_sinks ?? []).map((sinkId) => {
    const deliveries = store.listNotificationDeliveries({ sink_id: sinkId, limit: 1_000 });
    const latest = [...deliveries].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    const configured = config.notifications?.sinks.find((sink) => sink.id === sinkId);
    return {
      sink_id: sinkId,
      health: notificationSinkHealth(deliveries),
      latest_state: latest?.status ?? "untested",
      latest_at: latest?.updated_at ?? null,
      degraded_duration_seconds: configured?.budgets?.degraded_duration_seconds ?? 120,
    };
  });
  const unhealthy = sinkStates.filter((sink) => sink.health !== "healthy");
  if (unhealthy.length === 0) return;
  const environment = config.supervised_worker?.profile ?? "unknown";
  const attentionKey = supervisionSinkAttentionKey(environment, policy);
  const episode = canonicalJsonDigest(unhealthy);
  const healthStateKey = supervisionSinkHealthStateKey(environment, policy);
  const previous = store.getRunnerState(healthStateKey) ?? {};
  const continuingEpisode = previous.status === "unhealthy"
    && previous.fingerprint === episode
    && typeof previous.first_observed_at === "string"
    && Number.isFinite(Date.parse(previous.first_observed_at));
  const firstObservedAt = continuingEpisode
    ? String(previous.first_observed_at)
    : now;
  store.setRunnerState(healthStateKey, {
    status: "unhealthy",
    fingerprint: episode,
    first_observed_at: firstObservedAt,
    last_observed_at: now,
    sink_count: sinkStates.length,
    unhealthy_sink_count: unhealthy.length,
  });
  const degradedDurationSeconds = Math.min(...unhealthy.map((sink) => sink.degraded_duration_seconds));
  const observedDurationSeconds = Math.max(0, Math.floor(
    (Date.parse(now) - Date.parse(firstObservedAt)) / 1_000,
  ));
  if (observedDurationSeconds < degradedDurationSeconds) return;
  store.recordAttentionEvent({
    event_type: "worker.unhealthy",
    severity: "critical",
    environment,
    capability: policy.capability,
    contract_digest: policy.contract_digest,
    attention_key: attentionKey,
    attention_required: true,
    immediate_default: true,
    failure_class: "REQUIRED_ATTENTION_SINK_UNHEALTHY",
    summary: `${policy.capability} automatic execution is held because required supervision is unavailable`,
    worker_state: "paused",
    workbench_path: workbenchAttentionPath(attentionKey),
    details: {
      required_sink_count: sinkStates.length,
      unhealthy_sink_count: unhealthy.length,
      degraded_duration_seconds: observedDurationSeconds,
      source_database_changed: false,
    },
    source_event_key: `worker-sink-health:${policy.contract_digest}:${episode}:${firstObservedAt}`,
    now,
  });
}


export function resolveHealthySupervisionSinkAttention(
  store: ProposalStore,
  config: RuntimeConfig,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): void {
  const environment = config.supervised_worker?.profile ?? "unknown";
  const attentionKey = supervisionSinkAttentionKey(environment, policy);
  const healthStateKey = supervisionSinkHealthStateKey(environment, policy);
  const previous = store.getRunnerState(healthStateKey) ?? {};
  const item = store.getAttentionItem(workbenchAttentionId(attentionKey));
  if (item && item.status !== "resolved" && item.status !== "expired") {
    store.resolveAttention({ attention_id: item.attention_id });
  }
  const now = new Date().toISOString();
  store.setRunnerState(healthStateKey, {
    status: "healthy",
    recovered_at: now,
    previous_first_observed_at: typeof previous.first_observed_at === "string"
      ? previous.first_observed_at
      : null,
  });
  const recoveryEnabled = (policy.required_attention_sinks ?? []).some((sinkId) =>
    config.notifications?.sinks.some((sink) =>
      sink.id === sinkId && sink.enabled !== false && sink.recovery_notifications === true));
  if (item
    && previous.status === "unhealthy"
    && recoveryEnabled) {
    store.recordAttentionEvent({
      event_type: "worker.recovered",
      severity: "informational",
      environment,
      capability: policy.capability,
      contract_digest: policy.contract_digest,
      attention_required: false,
      immediate_default: true,
      summary: `${policy.capability} required supervision is healthy again`,
      worker_state: "active",
      workbench_path: "/",
      details: {
        resolved_attention_id: item.attention_id,
        source_database_changed: false,
      },
      source_event_key: `worker-sink-recovered:${policy.contract_digest}:${String(previous.first_observed_at ?? item.first_seen_at)}`,
      now,
    });
  }
}


function supervisionSinkAttentionKey(
  environment: string,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): string {
  return [
    environment,
    "worker.unhealthy",
    policy.capability,
    policy.contract_digest,
    "required_attention_sink",
  ].join(":");
}


function supervisionSinkHealthStateKey(
  environment: string,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): string {
  return `notification_worker_health:${canonicalJsonDigest({
    environment,
    capability: policy.capability,
    contract_digest: policy.contract_digest,
  })}`;
}


export function workbenchAttentionPath(attentionKey: string): string {
  return `/attention/${workbenchAttentionId(attentionKey)}`;
}


export function workbenchAttentionId(attentionKey: string): string {
  const digest = canonicalJsonDigest({ attention_key: attentionKey });
  return `attn_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}
