import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  attentionDecisionSubject,
  notificationReplayDecisionSubject,
  ProposalStore,
  type AttentionItem,
  type AttentionItemStatus,
  type AttentionSeverity,
  type NotificationDeliveryStatus
} from "@synapsor-runner/proposal-store";
import process from "node:process";
import { notificationSinkHealth, recordUnhealthySupervisionSinkAttention, requiredAttentionSinksHealthy, resolveHealthySupervisionSinkAttention, updateSupervisedProposalExpiryAttention, updateSupervisedWorkerBacklogAttention } from "./attention-domain.js";
import { cliCommandName } from "./cli-command-meta.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg, positional, positiveIntOption, runtimeStoreBridgeFlag } from "./cli-options.js";
import { openLocalStore, openLocalStoreAt, optionalRuntimeConfig, readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import {
  dispatchNotificationDeliveries,
  planNotificationDeliveries,
} from "./notifications.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { argsWithRuntimeStoreBridge, assertNoRuntimeStoreForLocalMutation, maybeSharedPostgresRuntimeStoreRead, runtimeStoreBridgeRequired, withSharedPostgresRuntimeStoreBridge } from "./store-shared.js";


export async function attentionCommand(args: string[]): Promise<number> {
  const [requested, ...rest] = args;
  const subcommand = requested && !requested.startsWith("-") ? requested : "list";
  const commandArgs = requested === subcommand ? rest : args;
  if (subcommand === "list") return attentionList(commandArgs);
  if (subcommand === "show") return attentionShow(commandArgs);
  if (subcommand === "acknowledge" || subcommand === "ack") return attentionAcknowledge(commandArgs);
  usage(["attention"]);
  return 2;
}


async function attentionList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "attention list",
    (bridgeStorePath) => attentionList(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
  );
  if (bridged !== undefined) return bridged;
  assertKnownOptions(
    args,
    new Set(["--config", "--store", "--status", "--severity", "--capability", "--limit", "--json", runtimeStoreBridgeFlag]),
    "attention list",
  );
  const store = await openLocalStore(args);
  try {
    const filters = attentionFilters(args);
    const items = store.listAttentionItems(filters);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ attention: items }, null, 2)}\n`);
      return 0;
    }
    if (items.length === 0) {
      process.stdout.write("No human-attention items match these filters.\n");
      return 0;
    }
    process.stdout.write(`${items.length} human-attention item${items.length === 1 ? "" : "s"}:\n\n`);
    for (const [index, item] of items.entries()) {
      process.stdout.write([
        `${index + 1}. ${item.title}`,
        `   ${item.severity.toUpperCase()} · ${item.status} · occurrences ${item.occurrence_count}`,
        `   ${item.capability ?? "Runner operations"} · last seen ${item.last_seen_at}`,
      ].join("\n"));
      process.stdout.write("\n");
    }
    process.stdout.write(`\nNext: ${cliCommandName()} attention show\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function attentionShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "attention show",
    (bridgeStorePath) => attentionShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
  );
  if (bridged !== undefined) return bridged;
  assertKnownOptions(
    args,
    new Set(["--config", "--store", "--status", "--severity", "--capability", "--json", runtimeStoreBridgeFlag]),
    "attention show",
  );
  const store = await openLocalStore(args);
  try {
    const item = resolveAttentionItem(store, positional(args, 0), attentionFilters(args));
    const latestEvent = store.getAttentionEvent(item.latest_event_id);
    const payload = {
      attention: item,
      latest_event: latestEvent ?? null,
      source_database_changed: attentionSourceChanged(latestEvent),
      acknowledgement_is_approval: false,
    };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    process.stdout.write([
      item.title,
      "",
      `Severity: ${item.severity}`,
      `Status: ${item.status}`,
      `Capability: ${item.capability ?? "Runner operations"}`,
      `Occurrences: ${item.occurrence_count}`,
      `First seen: ${item.first_seen_at}`,
      `Last seen: ${item.last_seen_at}`,
      `Source database changed: ${payload.source_database_changed ? "yes" : "no or not reported"}`,
      `Why attention is required: ${latestEvent?.summary ?? item.title}`,
      "Acknowledging this item does not approve a proposal or apply a write.",
      "",
      attentionNextAction(item, latestEvent),
      "",
    ].join("\n"));
    return 0;
  } finally {
    store.close();
  }
}


async function attentionAcknowledge(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      "attention acknowledge",
      (bridgeStorePath) => attentionAcknowledge(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "attention acknowledge", args);
  assertKnownOptions(
    args,
    new Set(["--config", "--store", "--actor", "--identity", "--identity-key", "--json", runtimeStoreBridgeFlag]),
    "attention acknowledge",
  );
  const store = await openLocalStore(args);
  try {
    const item = resolveAttentionItem(store, positional(args, 0), { status: "open" });
    const requiresVerifiedIdentity = item.environment === "production" || item.environment === "unknown";
    let actor = optionalArg(args, "--actor") ?? process.env.USER ?? "local_operator";
    let identity;
    if (requiresVerifiedIdentity) {
      const operatorIdentityConfig = config?.operator_identity;
      const provider = operatorIdentityConfig?.provider;
      if (provider !== "signed_key" && provider !== "jwt_oidc") {
        throw new Error(`${item.environment} attention acknowledgement requires a configured signed_key or jwt_oidc operator identity`);
      }
      identity = await resolveOperatorIdentity({
        config: operatorIdentityConfig as OperatorIdentityConfig,
        configPath,
        proposal: attentionDecisionSubject(item),
        action: "attention_acknowledge",
        actor: optionalArg(args, "--actor"),
        identity: optionalArg(args, "--identity"),
        privateKeyPath: optionalArg(args, "--identity-key"),
      });
      actor = identity.subject;
    }
    const acknowledged = store.acknowledgeAttention({
      attention_id: item.attention_id,
      actor,
      identity,
      require_verified_identity: requiresVerifiedIdentity,
    });
    const payload = {
      attention: acknowledged,
      approval_created: false,
      source_database_changed: false,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `Acknowledged: ${acknowledged.title}\nNo proposal was approved and the source database was not changed.\n`);
    return 0;
  } finally {
    store.close();
  }
}


function attentionFilters(args: string[]): {
  status?: AttentionItemStatus;
  severity?: AttentionSeverity;
  capability?: string;
  limit?: number;
} {
  const status = optionalArg(args, "--status");
  if (status && !["open", "acknowledged", "resolved", "expired"].includes(status)) {
    throw new Error("--status must be open, acknowledged, resolved, or expired");
  }
  const severity = optionalArg(args, "--severity");
  if (severity && !["informational", "warning", "critical"].includes(severity)) {
    throw new Error("--severity must be informational, warning, or critical");
  }
  return {
    ...(status ? { status: status as AttentionItemStatus } : {}),
    ...(severity ? { severity: severity as AttentionSeverity } : {}),
    ...(optionalArg(args, "--capability") ? { capability: optionalArg(args, "--capability") } : {}),
    ...(optionalArg(args, "--limit") ? {
      limit: positiveIntOption(args, "--limit", 50, 1, 1_000),
    } : {}),
  };
}


function resolveAttentionItem(
  store: ProposalStore,
  requested: string | undefined,
  filters: Parameters<ProposalStore["listAttentionItems"]>[0] = {},
): AttentionItem {
  if (requested && requested !== "latest") {
    const exact = store.getAttentionItem(requested);
    if (!exact) throw new Error(`attention item not found: ${requested}`);
    return exact;
  }
  const items = store.listAttentionItems({ ...filters, limit: 1 });
  if (items[0]) return items[0];
  if (filters.status === "open") {
    const acknowledged = store.listAttentionItems({ ...filters, status: "acknowledged", limit: 1 });
    if (acknowledged[0]) return acknowledged[0];
  }
  throw new Error("no human-attention item matches these filters");
}


function attentionSourceChanged(event: Awaited<ReturnType<ProposalStore["getAttentionEvent"]>>): boolean {
  return event?.details.source_database_changed === true;
}


function attentionNextAction(
  item: AttentionItem,
  event: Awaited<ReturnType<ProposalStore["getAttentionEvent"]>>,
): string {
  if (event?.event_type === "proposal.review_required" && event.proposal_id) {
    return `Next: review the exact proposal in Workbench or run ${cliCommandName()} proposals show ${event.proposal_id}`;
  }
  if (event?.event_type === "worker.reconciliation_required" || event?.event_type === "worker.unknown_outcome") {
    return `Next: inspect reconciliation state with ${cliCommandName()} writeback reconcile list`;
  }
  if (event?.event_type === "worker.dead_lettered") {
    return `Next: inspect the dead letter with ${cliCommandName()} worker dead-letter list`;
  }
  return item.status === "open"
    ? `Next: open Workbench or run ${cliCommandName()} attention acknowledge after inspecting the underlying state`
    : "Next: no action is required unless the underlying condition remains unresolved";
}


export async function notificationsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return notificationsStatus(rest);
  if (subcommand === "test") return notificationsTest(rest);
  if (subcommand === "dispatch") return notificationsDispatch(rest);
  if (subcommand === "replay") return notificationsReplay(rest);
  usage(["notifications"]);
  return 2;
}


async function notificationsStatus(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "notifications status",
    (bridgeStorePath) => notificationsStatus(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
  );
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, new Set(["--config", "--store", "--json", runtimeStoreBridgeFlag]), "notifications status");
  const config = await readRuntimeConfig(runnerConfigPath(args));
  const notificationConfig = config.notifications;
  const store = await openLocalStore(args);
  try {
    const deliveries = store.listNotificationDeliveries({ limit: 1_000 });
    const sinks = (notificationConfig?.sinks ?? []).map((sink) => {
      const sinkDeliveries = deliveries.filter((delivery) => delivery.sink_id === sink.id);
      const counts = notificationDeliveryCounts(sinkDeliveries);
      const lastDelivered = sinkDeliveries
        .filter((delivery) => delivery.status === "delivered" && delivery.delivered_at)
        .sort((left, right) => String(right.delivered_at).localeCompare(String(left.delivered_at)))[0];
      return {
        id: sink.id,
        type: sink.type,
        enabled: notificationConfig?.enabled === true && sink.enabled !== false,
        minimum_severity: sink.minimum_severity ?? "warning",
        delivery: sink.delivery ?? "immediate",
        counts,
        last_delivered_at: lastDelivered?.delivered_at ?? null,
        health: notificationSinkHealth(sinkDeliveries),
      };
    });
    const payload = {
      enabled: notificationConfig?.enabled === true,
      configured: notificationConfig !== undefined,
      sinks,
      open_attention: store.listAttentionItems({ status: "open", limit: 1_000 }).length,
      source_database_changed: false,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`Notifications: ${payload.enabled ? "enabled" : "disabled"}\n`);
      if (sinks.length === 0) process.stdout.write("No external sinks configured. Workbench and the ledger remain authoritative.\n");
      for (const sink of sinks) {
        process.stdout.write(
          `${sink.id}: ${sink.enabled ? "enabled" : "disabled"} · ${sink.health} · delivered ${sink.counts.delivered} · retry ${sink.counts.retry_wait} · dead letter ${sink.counts.dead_letter}\n`,
        );
      }
      process.stdout.write(`Open attention items: ${payload.open_attention}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}


async function notificationsTest(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      "notifications test",
      (bridgeStorePath) => notificationsTest(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "notifications test", args);
  assertKnownOptions(
    args,
    new Set(["--config", "--store", "--sink", "--environment", "--json", runtimeStoreBridgeFlag]),
    "notifications test",
  );
  if (!config.notifications?.enabled) throw new Error("notifications are disabled; configure and enable a sink before testing");
  const sink = selectNotificationSink(config.notifications.sinks, optionalArg(args, "--sink"));
  const environment = optionalArg(args, "--environment")
    ?? config.supervised_worker?.profile
    ?? "development";
  const createdAt = new Date().toISOString();
  const store = await openLocalStoreAt(resolvedLocalStorePath(args, config.storage?.sqlite_path));
  try {
    const event = store.recordAttentionEvent({
      event_type: "proposal.created",
      severity: "informational",
      environment,
      attention_required: false,
      immediate_default: true,
      summary: "Synapsor notification test. No database information is included.",
      details: {
        synthetic_test: true,
        source_database_changed: false,
      },
      source_event_key: `notification-test:${sink.id}:${createdAt}`,
      now: createdAt,
    });
    store.enqueueNotificationDelivery({
      sink_id: sink.id,
      event_id: event.event_id,
      max_attempts: sink.max_attempts,
      status: "pending",
      now: createdAt,
    });
    const dispatch = await dispatchNotificationDeliveries({
      store,
      config: { ...config.notifications, sinks: [sink] },
      owner: `notification_test_${process.pid}`,
      limit: 1,
      env: process.env,
      output: (line) => process.stdout.write(line),
    });
    const delivery = store.listNotificationDeliveries({
      sink_id: sink.id,
      event_id: event.event_id,
      limit: 1,
    })[0];
    if (dispatch.delivered !== 1 || delivery?.status !== "delivered") {
      throw new Error(`synthetic notification delivery failed safely with status ${delivery?.status ?? "unknown"}`);
    }
    const payload = {
      ok: true,
      sink: sink.id,
      event_id: event.event_id,
      external_reference: delivery.external_reference ?? null,
      synthetic: true,
      source_database_changed: false,
    };
    const output = args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `Synthetic notification delivered to ${sink.id}. No database information was sent.\n`;
    if (sink.type === "jsonl") process.stderr.write(output);
    else process.stdout.write(output);
    return 0;
  } finally {
    store.close();
  }
}


async function notificationsDispatch(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      "notifications dispatch",
      (bridgeStorePath) => notificationsDispatch(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "notifications dispatch", args);
  assertKnownOptions(
    args,
    new Set(["--config", "--store", "--sink", "--owner", "--limit", "--json", runtimeStoreBridgeFlag]),
    "notifications dispatch",
  );
  if (!config.notifications?.enabled) throw new Error("notifications are disabled; no external delivery was attempted");
  const selectedSink = optionalArg(args, "--sink");
  const notificationConfig = {
    ...config.notifications,
    sinks: selectedSink
      ? [selectNotificationSink(config.notifications.sinks, selectedSink)]
      : config.notifications.sinks,
  };
  const store = await openLocalStore(args);
  try {
    updateSupervisedWorkerBacklogAttention(store, config);
    updateSupervisedProposalExpiryAttention(store, config);
    for (const policy of config.supervised_worker?.capabilities ?? []) {
      if ((policy.required_attention_sinks ?? []).length === 0) continue;
      if (!requiredAttentionSinksHealthy(store, config, policy)) {
        recordUnhealthySupervisionSinkAttention(store, config, policy);
      } else {
        resolveHealthySupervisionSinkAttention(store, config, policy);
      }
    }
    const plan = await planNotificationDeliveries({ store, config: notificationConfig });
    const dispatch = await dispatchNotificationDeliveries({
      store,
      config: notificationConfig,
      owner: optionalArg(args, "--owner") ?? `notification_dispatcher_${process.pid}`,
      limit: positiveIntOption(args, "--limit", 20, 1, 100),
      env: process.env,
      output: (line) => process.stdout.write(line),
    });
    const payload = {
      planned: plan,
      dispatched: dispatch,
      approval_created: false,
      source_database_changed: false,
    };
    const rendered = args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `Notifications: ${dispatch.delivered} delivered, ${dispatch.retry_wait} retrying, ${dispatch.dead_letter} dead-lettered; ${plan.batched} batched and ${plan.suppressed} kept quiet.\n`;
    if (notificationConfig.sinks.some((sink) => sink.type === "jsonl")) process.stderr.write(rendered);
    else process.stdout.write(rendered);
    return dispatch.dead_letter > 0 ? 3 : 0;
  } finally {
    store.close();
  }
}


async function notificationsReplay(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      "notifications replay",
      (bridgeStorePath) => notificationsReplay(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "notifications replay", args);
  assertKnownOptions(
    args,
    new Set([
      "--config",
      "--store",
      "--yes",
      "--reason",
      "--actor",
      "--identity",
      "--identity-key",
      "--json",
      runtimeStoreBridgeFlag,
    ]),
    "notifications replay",
  );
  if (!args.includes("--yes")) throw new Error("notifications replay requires --yes; it re-sends one redacted notification but never replays approval or mutation");
  const reason = optionalArg(args, "--reason")?.trim();
  if (!reason) throw new Error("notifications replay requires --reason <operator recovery reason>");
  if (config.operator_identity?.provider !== "signed_key" && config.operator_identity?.provider !== "jwt_oidc") {
    throw new Error("notifications replay requires a configured signed_key or jwt_oidc operator identity");
  }
  const store = await openLocalStore(args);
  try {
    const requested = positional(args, 0);
    const delivery = requested && requested !== "latest"
      ? store.getNotificationDelivery(requested)
      : store.listNotificationDeliveries({ status: "dead_letter", limit: 1 })[0];
    if (!delivery) {
      throw new Error(
        requested && requested !== "latest"
          ? `notification delivery not found: ${requested}`
          : "no dead-letter notification delivery found",
      );
    }
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig,
      configPath,
      proposal: notificationReplayDecisionSubject(delivery),
      action: "notification_replay",
      reason,
      actor: optionalArg(args, "--actor"),
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
    });
    const requeued = store.requeueNotificationDelivery({
      delivery_id: delivery.delivery_id,
      identity,
      reason,
    });
    const payload = {
      delivery: requeued,
      operator: {
        subject: identity.subject,
        provider: identity.provider,
        decision_hash: identity.decision_hash,
      },
      approval_replayed: false,
      mutation_replayed: false,
      source_database_changed: false,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `Requeued notification delivery ${requeued.delivery_id}. No approval or database mutation was replayed.\n`);
    return 0;
  } finally {
    store.close();
  }
}


function selectNotificationSink(
  sinks: NonNullable<RuntimeConfig["notifications"]>["sinks"],
  requested: string | undefined,
) {
  const enabled = sinks.filter((sink) => sink.enabled !== false);
  if (requested) {
    const selected = enabled.find((sink) => sink.id === requested);
    if (!selected) throw new Error(`enabled notification sink not found: ${requested}`);
    return selected;
  }
  if (enabled.length !== 1) throw new Error("select one enabled notification sink with --sink <id>");
  return enabled[0]!;
}


function notificationDeliveryCounts(deliveries: ReturnType<ProposalStore["listNotificationDeliveries"]>) {
  const counts: Record<NotificationDeliveryStatus, number> = {
    pending: 0,
    leased: 0,
    delivered: 0,
    retry_wait: 0,
    dead_letter: 0,
    suppressed: 0,
    batched: 0,
  };
  for (const delivery of deliveries) counts[delivery.status] += 1;
  return counts;
}
