import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { resolveSupervisedWorkerEligibility, type RuntimeCapabilityConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  workerControlDecisionSubject,
  type OperationalMetricRow,
  type WorkerControlAction,
  type WorkerControlTarget,
  type WorkerQueueItem
} from "@synapsor-runner/proposal-store";
import process from "node:process";
import { recordUnhealthySupervisionSinkAttention, requiredAttentionSinksHealthy, resolveHealthySupervisionSinkAttention, updateSupervisedProposalExpiryAttention, updateSupervisedWorkerBacklogAttention, workbenchAttentionPath } from "./attention-domain.js";
import { usage } from "./cli-help.js";
import { operationalLog, safeOperationalErrorCode } from "./cli-logging.js";
import { optionalArg, positional, positiveIntOption, runtimeStoreBridgeFlag, waitFor } from "./cli-options.js";
import { confirmDangerousAction, openLocalStore, openLocalStoreAt, operatorIdentityForDecision, optionalRuntimeConfig, readRuntimeConfig, requireLocalProposal, resolveProposalIdFromStore, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { runnerProcessStartedAt } from "./cli-runtime.js";
import { applyProposal } from "./guarded-apply.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { argsWithRuntimeStoreBridge, assertNoRuntimeStoreForLocalMutation, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge, withoutSharedPostgresLedgerMirror } from "./store-shared.js";
import { assertSupervisedWriterPosture, currentSupervisedApprovalPolicy, workerControlAllowsPolicy, workerControlOperatorDecisionAction, workerPolicyError } from "./worker-policy.js";
import { findProposalCapability } from "./writeback-execution.js";


export async function workerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "run") return workerRun(rest);
  if (subcommand === "status" || subcommand === "list") return workerStatus(rest);
  if (subcommand === "pause" || subcommand === "resume" || subcommand === "drain") {
    return workerControlMutate(subcommand, rest);
  }
  if (subcommand === "enable" || subcommand === "disable" || subcommand === "revoke") {
    return workerCapabilityControlMutate(subcommand, rest);
  }
  if (subcommand === "cancel") return workerCancel(rest);
  if (subcommand === "dead-letter") return workerDeadLetter(rest);
  usage(["worker"]);
  return 2;
}


async function workerStatus(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreReadBridge(args, config, "worker status", (bridgeStorePath) => workerStatus(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const store = await openLocalStore(args);
  try {
    const status = optionalArg(args, "--status") as Parameters<ProposalStore["listWorkerQueue"]>[0];
    const items = store.listWorkerQueue(status);
    const control = store.workerControlState();
    const now = Date.now();
    const summary = {
      queue_depth: items.filter((item) => item.status === "queued" || item.status === "retry_wait").length,
      active_leases: items.filter((item) => item.status === "leased" && Date.parse(item.lease_expires_at ?? "") > now).length,
      retry_wait: items.filter((item) => item.status === "retry_wait").length,
      dead_letters: items.filter((item) => item.status === "dead_letter").length,
      reconciliation_required: items.filter((item) => item.status === "reconciliation_required").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      oldest_queued_at: items
        .filter((item) => item.status === "queued" || item.status === "retry_wait")
        .map((item) => item.created_at)
        .sort()[0] ?? null,
    };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ worker_control: control, summary, worker_queue: items }, null, 2)}\n`);
    } else {
      process.stdout.write(`Supervised execution: ${control.mode} (control revision ${control.revision})\n`);
      process.stdout.write(
        `Queue: ${summary.queue_depth} waiting · ${summary.active_leases} leased · ${summary.retry_wait} retrying · ${summary.dead_letters} dead letter · ${summary.reconciliation_required} reconciliation\n`,
      );
      if (items.length === 0) process.stdout.write("Worker queue is empty.\n");
      else for (const item of items) {
        process.stdout.write(
          `${item.status.toUpperCase()} ${item.proposal_id} mode=${item.execution_mode}`
          + `${item.contract_digest ? ` digest=${item.contract_digest}` : ""}`
          + ` attempt=${item.attempts}/${item.max_attempts}`
          + `${item.lease_owner ? ` lease=${item.lease_owner} until=${item.lease_expires_at}` : ""}`
          + `${item.last_error_code ? ` error=${item.last_error_code}` : ""}\n`,
        );
      }
    }
    return 0;
  } finally {
    store.close();
  }
}


async function workerControlMutate(
  action: "pause" | "resume" | "drain",
  args: string[],
): Promise<number> {
  return workerControlMutation(action, {}, args);
}


async function workerCapabilityControlMutate(
  action: "enable" | "disable" | "revoke",
  args: string[],
): Promise<number> {
  const capability = positional(args, 0);
  const contractDigest = optionalArg(args, "--digest");
  if (!capability) throw new Error(`worker ${action} requires <capability>`);
  if (!contractDigest || !/^sha256:[a-f0-9]{64}$/.test(contractDigest)) {
    throw new Error(`worker ${action} requires --digest <exact sha256 contract digest>`);
  }
  return workerControlMutation(
    action === "enable"
      ? "capability_enable"
      : action === "disable"
        ? "capability_disable"
        : "digest_revoke",
    {
      capability,
      contract_digest: contractDigest as `sha256:${string}`,
    },
    args,
  );
}


async function workerControlMutation(
  action: WorkerControlAction,
  target: Omit<WorkerControlTarget, "action">,
  args: string[],
): Promise<number> {
  if (!args.includes("--yes")) throw new Error(`worker ${action.replaceAll("_", " ")} requires --yes`);
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `worker ${action}`,
      (bridgeStorePath) => workerControlMutation(action, target, argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, `worker ${action}`, args);
  const store = await openLocalStoreAt(resolvedLocalStorePath(args, config.storage?.sqlite_path));
  try {
    const controlTarget: WorkerControlTarget = { action, ...target };
    const current = store.workerControlState();
    const subject = workerControlDecisionSubject(current, controlTarget);
    const policies = config.supervised_worker?.capabilities.filter((policy) =>
      !target.capability
      || (policy.capability === target.capability && policy.contract_digest === target.contract_digest)) ?? [];
    if (target.capability && policies.length !== 1) {
      throw new Error("worker capability control must target one configured exact capability/digest allowlist entry");
    }
    const requiredRoles = [...new Set(policies.flatMap((policy) =>
      policy.control_role ? [policy.control_role] : []))].sort();
    await confirmDangerousAction(
      args,
      target.capability
        ? `${action.replaceAll("_", " ")} ${target.capability} at ${target.contract_digest}?`
        : `${action} supervised execution globally?`,
    );
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig | undefined,
      configPath,
      proposal: subject,
      action: workerControlOperatorDecisionAction(action),
      reason: optionalArg(args, "--reason"),
      actor: optionalArg(args, "--actor"),
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
    });
    for (const role of requiredRoles) {
      if (!identity.roles.includes(role)) {
        throw new Error(`operator ${identity.subject} lacks required supervised-worker control role ${role}`);
      }
    }
    const production = config.supervised_worker?.profile === "production";
    const updated = store.updateWorkerControl({
      ...controlTarget,
      actor: identity.subject,
      identity,
      require_verified_identity: production,
      environment: config.supervised_worker?.profile ?? "unknown",
    });
    const payload = {
      worker_control: updated,
      source_database_changed: false,
      queued_proposals_discarded: 0,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${workerControlHumanLabel(action)}. New leases now follow control revision ${updated.revision}; queued proposals were preserved.\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function workerCancel(args: string[]): Promise<number> {
  if (!args.includes("--yes")) throw new Error("worker cancel requires --yes");
  const proposalReference = positional(args, 0) ?? "latest";
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `worker cancel ${proposalReference}`,
      (bridgeStorePath) => workerCancel(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "worker cancel", args);
  const store = await openLocalStoreAt(resolvedLocalStorePath(args, config.storage?.sqlite_path));
  try {
    const proposalId = resolveProposalIdFromStore(proposalReference, store);
    const proposal = requireLocalProposal(store, proposalId);
    const queue = store.getWorkerQueueItem(proposalId);
    if (!queue) throw new Error(`worker queue item not found for ${proposalId}`);
    const policy = config.supervised_worker?.capabilities.find((candidate) =>
      candidate.capability === proposal.action
      && candidate.contract_digest === queue.contract_digest);
    await confirmDangerousAction(args, `Cancel queued proposal ${proposalId} before worker lease?`);
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig | undefined,
      configPath,
      proposal,
      action: "worker_cancel",
      reason: optionalArg(args, "--reason"),
      actor: optionalArg(args, "--actor"),
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
      requiredRole: policy?.control_role,
    });
    const cancelled = store.cancelWorkerItem({
      proposalId,
      actor: identity.subject,
      identity,
      require_verified_identity: config.supervised_worker?.profile === "production",
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ worker_queue: cancelled, source_database_changed: false }, null, 2)}\n`
      : `Cancelled queued proposal ${proposalId}. Source database changed: no.\n`);
    return 0;
  } finally {
    store.close();
  }
}


function workerControlHumanLabel(action: WorkerControlAction): string {
  if (action === "pause") return "Supervised execution paused";
  if (action === "resume") return "Supervised execution resumed";
  if (action === "drain") return "Supervised execution is draining";
  if (action === "capability_enable") return "Exact capability/digest execution enabled";
  if (action === "capability_disable") return "Exact capability/digest execution disabled";
  return "Exact capability digest revoked";
}


async function workerDeadLetter(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return workerStatus([...rest, "--status", "dead_letter"]);
  if (subcommand === "show") return workerDeadLetterShow(rest);
  if (subcommand === "requeue") return workerDeadLetterMutate("requeue", rest);
  if (subcommand === "discard") return workerDeadLetterMutate("discard", rest);
  usage(["worker"]);
  return 2;
}


async function workerDeadLetterShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("worker dead-letter show requires <proposal_id>");
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `worker dead-letter show ${proposalId}`, (bridgeStorePath) => workerDeadLetterShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const store = await openLocalStore(args);
  try {
    const item = store.getWorkerQueueItem(proposalId);
    if (!item) throw new Error(`worker queue item not found for ${proposalId}`);
    const proposal = requireLocalProposal(store, proposalId);
    const payload = { worker_queue: item, proposal, receipts: store.receipts(proposalId), events: store.events(proposalId) };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `${item.status.toUpperCase()} ${item.proposal_id}`,
      `Attempts: ${item.attempts}/${item.max_attempts}`,
      `Last safe error: ${item.last_error_code ?? "none"}`,
      `Proposal state: ${proposal.state}`,
      `Receipts retained: ${payload.receipts.length}`,
      `Events retained: ${payload.events.length}`,
      "",
    ].join("\n"));
    return 0;
  } finally {
    store.close();
  }
}


async function workerDeadLetterMutate(action: "requeue" | "discard", args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error(`worker dead-letter ${action} requires <proposal_id>`);
  const reason = optionalArg(args, "--reason");
  if (action === "discard" && !reason) throw new Error("worker dead-letter discard requires --reason <text>");
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `worker dead-letter ${action} ${proposalId}`, (bridgeStorePath) => workerDeadLetterMutate(action, argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, `worker dead-letter ${action}`, args);
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    await confirmDangerousAction(args, `${action === "requeue" ? "Requeue" : "Discard"} dead-letter item ${proposalId}?`);
    const identity = await operatorIdentityForDecision({
      args,
      config,
      configPath,
      proposal,
      action: action === "requeue" ? "worker_requeue" : "worker_discard",
      reason,
    });
    if (!identity.verified) throw new Error(`worker dead-letter ${action} requires a verified signed_key or jwt_oidc operator identity`);
    const item = action === "requeue"
      ? store.requeueDeadLetter({
        proposalId,
        retryBudget: positiveIntOption(args, "--retry-budget", 3, 1, 100),
        identity,
        reason,
      })
      : store.discardDeadLetter({ proposalId, identity, reason: reason! });
    operationalLog("warn", `worker_dead_letter_${action === "requeue" ? "requeued" : "discarded"}`, {
      proposal_id: proposalId,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      retry_budget: action === "requeue" ? item.max_attempts : undefined,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify({ worker_queue: item }, null, 2)}\n` : `${item.status} ${item.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}


function enqueueApprovedForSupervisedWorker(
  store: ProposalStore,
  config: RuntimeConfig,
  filters: { capability?: string; tenant?: string },
): void {
  const proposals = [
    ...store.listProposals({ state: "approved", capability: filters.capability, tenant: filters.tenant }),
    ...store.listProposals({ state: "pending_worker", capability: filters.capability, tenant: filters.tenant }),
  ];
  for (const proposal of proposals) {
    const existing = store.getWorkerQueueItem(proposal.proposal_id);
    if (existing) continue;
    let capability: RuntimeCapabilityConfig;
    try {
      capability = findProposalCapability(config, proposal);
    } catch {
      continue;
    }
    const eligibility = resolveSupervisedWorkerEligibility(config, capability, { phase: "queue" });
    if (
      !eligibility.eligible
      || !eligibility.policy
      || !eligibility.contract_digest
      || proposal.change_set.contract?.digest !== eligibility.contract_digest
    ) {
      continue;
    }
    try {
      store.enqueueWorkerProposal({
        proposal_id: proposal.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: eligibility.contract_digest,
        max_attempts: eligibility.policy.max_attempts,
        queue_limit: eligibility.policy.queue_limit,
      });
    } catch (error) {
      const code = safeOperationalErrorCode(error);
      if (code !== "WORKER_QUEUE_LIMIT_EXCEEDED") throw error;
      const attentionKey = [
        eligibility.profile ?? "unknown",
        "policy.limit_exceeded",
        capability.name,
        eligibility.contract_digest,
        "worker_queue",
      ].join(":");
      store.recordAttentionEvent({
        event_type: "policy.limit_exceeded",
        severity: "critical",
        environment: eligibility.profile ?? "unknown",
        capability: capability.name,
        contract_digest: eligibility.contract_digest,
        attention_key: attentionKey,
        attention_required: true,
        immediate_default: true,
        failure_class: code,
        summary: `${capability.name} supervised-execution queue reached its reviewed limit`,
        workbench_path: workbenchAttentionPath(attentionKey),
        details: {
          failure_class: code,
          source_database_changed: false,
        },
        source_event_key: `worker-queue-limit:${proposal.proposal_id}:${eligibility.contract_digest}`,
      });
    }
  }
}


async function claimSupervisedWorkerItem(
  store: ProposalStore,
  config: RuntimeConfig,
  input: { workerId: string; capability?: string; tenant?: string },
): Promise<{
  item: WorkerQueueItem;
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>;
} | undefined> {
  const workerControl = store.workerControlState();
  updateSupervisedWorkerBacklogAttention(store, config);
  updateSupervisedProposalExpiryAttention(store, config);
  if (workerControl.mode !== "active") return undefined;
  const policies = (config.supervised_worker?.capabilities ?? [])
    .filter((policy) => !input.capability || policy.capability === input.capability)
    .sort((left, right) => left.capability.localeCompare(right.capability)
      || left.contract_digest.localeCompare(right.contract_digest));
  for (const policy of policies) {
    const capability = config.capabilities?.find((candidate) => candidate.name === policy.capability);
    if (!capability) continue;
    const eligibility = resolveSupervisedWorkerEligibility(config, capability, {
      workerIdentity: input.workerId,
      phase: "execute",
    });
    if (!eligibility.eligible || !eligibility.policy || !eligibility.contract_digest) continue;
    if (!workerControlAllowsPolicy(workerControl, eligibility.policy)) continue;
    if (!requiredAttentionSinksHealthy(store, config, eligibility.policy)) {
      recordUnhealthySupervisionSinkAttention(store, config, eligibility.policy);
      continue;
    }
    resolveHealthySupervisionSinkAttention(store, config, eligibility.policy);
    try {
      await assertSupervisedWriterPosture(store, config, eligibility.policy);
    } catch {
      continue;
    }
    const approvalPolicy = currentSupervisedApprovalPolicy(config, capability);
    const item = store.claimWorkerItem({
      workerId: input.workerId,
      leaseSeconds: eligibility.policy.lease_seconds,
      executionMode: "supervised_worker",
      capability: capability.name,
      tenant: input.tenant,
      contractDigest: eligibility.contract_digest,
      maxConcurrent: eligibility.policy.concurrency,
      rateLimit: {
        executions: eligibility.policy.rate_limit.executions,
        windowSeconds: eligibility.policy.rate_limit.window_seconds,
      },
      proposalTtlSeconds: eligibility.policy.proposal_ttl_seconds,
      ...(approvalPolicy ? {
        policyExecution: {
          policy: approvalPolicy.policy,
          limits: approvalPolicy.limits,
        },
      } : {}),
    });
    if (item) return { item, policy: eligibility.policy };
  }
  return undefined;
}


async function workerRun(args: string[]): Promise<number> {
  if (!args.includes("--yes")) throw new Error("worker run requires --yes because it applies approved proposals");
  const configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath);
  const supervised = args.includes("--supervised");
  if (supervised) {
    const validation = validateRunnerCapabilityConfig(config);
    if (!validation.ok) {
      throw new Error(`cannot run supervised worker with invalid config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
    }
    if (!config.supervised_worker?.enabled) {
      if (!args.includes("--batch-quiet")) {
        process.stdout.write("Supervised execution is disabled. No proposal was leased or applied.\n");
      }
      return 0;
    }
  }
  if (config && runtimeStoreBridgeRequired(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      return workerRunSharedRuntimeStoreDaemon(args, config);
    }
    return withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => workerRun(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "worker run", args);
  const storePath = resolvedLocalStorePath(args, config.storage?.sqlite_path);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      throw new Error("shared Postgres ledger mirror for worker run requires --once or --drain. Use storage.shared_postgres.mode=runtime_store for long-running shared worker loops.");
    }
    return withSharedPostgresLedgerMirror(args, storePath, "worker run", () => workerRun(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const workerId = optionalArg(args, "--worker-id") ?? process.env.SYNAPSOR_RUNNER_ID ?? `worker_${process.pid}`;
  const maxAttempts = positiveIntOption(args, "--max-attempts", 5, 1, 100);
  const retryBaseMs = positiveIntOption(args, "--retry-base-ms", 1000, 1, 3_600_000);
  const retryMaxMs = positiveIntOption(args, "--retry-max-ms", 60_000, retryBaseMs, 86_400_000);
  const leaseSeconds = positiveIntOption(args, "--lease-seconds", 60, 15, 3600);
  const pollMs = positiveIntOption(args, "--poll-ms", 5000, 10, 3_600_000);
  const once = args.includes("--once");
  const drain = args.includes("--drain");
  const capability = optionalArg(args, "--capability");
  const tenant = optionalArg(args, "--tenant");
  const startupStore = new ProposalStore(storePath);
  try {
    const environment = supervised ? config.supervised_worker?.profile ?? "unknown" : "unknown";
    startupStore.setRunnerState("attention_context", { environment });
    startupStore.recordAttentionEvent({
      event_type: "worker.started",
      severity: "informational",
      environment,
      ...(capability ? { capability } : {}),
      attention_required: false,
      immediate_default: false,
      summary: supervised ? "Trusted supervised worker started" : "Trusted worker started",
      worker_state: drain ? "draining" : "active",
      details: {
        worker_identity: workerId,
        execution_mode: supervised ? "supervised_worker" : "legacy",
        source_database_changed: false,
      },
      source_event_key: `worker-started:${workerId}:${supervised ? "supervised_worker" : "legacy"}:${capability ?? "all"}:${runnerProcessStartedAt}`,
      now: runnerProcessStartedAt,
    });
  } finally {
    startupStore.close();
  }
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const store = new ProposalStore(storePath);
      let item;
      let supervisedPolicy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]> | undefined;
      try {
        if (supervised) {
          enqueueApprovedForSupervisedWorker(store, config, { capability, tenant });
          const claimed = await claimSupervisedWorkerItem(store, config, {
            workerId,
            capability,
            tenant,
          });
          item = claimed?.item;
          supervisedPolicy = claimed?.policy;
        } else {
          store.enqueueApprovedForWorker({ capability, tenant, maxAttempts });
          item = store.claimWorkerItem({ workerId, leaseSeconds, executionMode: "legacy" });
        }
      } finally {
        store.close();
      }
      if (!item) {
        if (once || drain) return 0;
        await waitFor(pollMs);
        continue;
      }

      let executionCode = "WORKER_EXECUTION_ERROR";
      try {
        await applyProposal([
          item.proposal_id,
          "--config", configPath,
          "--store", storePath,
          "--runner", workerId,
          "--worker-attempt", String(item.attempts),
          ...(supervised && item.lease_id ? [
            "--worker-execution-mode", "supervised_worker",
            "--worker-lease-id", item.lease_id,
          ] : []),
          ...(supervisedPolicy ? ["--lease-seconds", String(supervisedPolicy.lease_seconds)] : []),
          "--batch-quiet",
          "--yes",
          ...(args.includes("--dry-run") ? ["--dry-run"] : []),
          ...(args.includes(runtimeStoreBridgeFlag) ? [runtimeStoreBridgeFlag] : []),
          ...(optionalArg(args, "--identity") ? ["--identity", optionalArg(args, "--identity")!] : []),
          ...(optionalArg(args, "--identity-key") ? ["--identity-key", optionalArg(args, "--identity-key")!] : []),
          ...(optionalArg(args, "--actor") ? ["--actor", optionalArg(args, "--actor")!] : []),
        ], item.proposal_id);
        const afterStore = new ProposalStore(storePath);
        try {
          const proposal = requireLocalProposal(afterStore, item.proposal_id);
          const receipt = afterStore.receipts(item.proposal_id).at(-1)?.receipt;
          executionCode = receipt?.safe_error_code ?? (proposal.state === "failed" ? "WRITEBACK_FAILED" : "WORKER_STATE_INVALID");
          if (proposal.state === "applied") {
            afterStore.completeWorkerItem(
              item.proposal_id,
              workerId,
              receipt?.status === "already_applied" ? "already_applied" : "applied",
              undefined,
              item.lease_id,
            );
            operationalLog("info", "worker_item_completed", { proposal_id: item.proposal_id, worker_id: workerId, status: proposal.state, attempt: item.attempts });
          } else if (proposal.state === "conflict") {
            afterStore.completeWorkerItem(item.proposal_id, workerId, "conflict", undefined, item.lease_id);
            operationalLog("warn", "worker_item_completed", { proposal_id: item.proposal_id, worker_id: workerId, status: proposal.state, attempt: item.attempts });
          } else if (proposal.state === "reconciliation_required") {
            if (!item.lease_id) throw workerPolicyError("WORKER_LEASE_REQUIRED", "worker queue lease id is missing");
            afterStore.requireWorkerReconciliation({
              proposalId: item.proposal_id,
              workerId,
              leaseId: item.lease_id,
              errorCode: receipt?.safe_error_code ?? "RECONCILIATION_REQUIRED",
            });
            operationalLog("error", "worker_reconciliation_required", {
              proposal_id: item.proposal_id,
              worker_id: workerId,
              error_code: receipt?.safe_error_code ?? "RECONCILIATION_REQUIRED",
              attempt: item.attempts,
            });
          } else if (proposal.state === "failed") {
            finishWorkerFailure(afterStore, item, workerId, executionCode, retryBaseMs, retryMaxMs);
          } else {
            finishWorkerFailure(afterStore, item, workerId, "WORKER_STATE_INVALID", retryBaseMs, retryMaxMs);
          }
          if (supervised) {
            updateSupervisedWorkerBacklogAttention(afterStore, config);
            updateSupervisedProposalExpiryAttention(afterStore, config);
          }
        } finally {
          afterStore.close();
        }
      } catch (error) {
        executionCode = workerErrorCode(error);
        const failureStore = new ProposalStore(storePath);
        try {
          finishWorkerFailure(failureStore, item, workerId, executionCode, retryBaseMs, retryMaxMs);
          if (supervised) {
            updateSupervisedWorkerBacklogAttention(failureStore, config);
            updateSupervisedProposalExpiryAttention(failureStore, config);
          }
        } finally {
          failureStore.close();
        }
      }
      if (once) return 0;
    } while (!stopped);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}


async function workerRunSharedRuntimeStoreDaemon(args: string[], config: RuntimeConfig): Promise<number> {
  const pollMs = positiveIntOption(args, "--poll-ms", 5000, 10, 3_600_000);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => {
        return workerRun(argsWithRuntimeStoreBridge([...args, "--drain"], bridgeStorePath));
      });
      if (!stopped) await waitFor(pollMs);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}


function finishWorkerFailure(
  store: ProposalStore,
  item: WorkerQueueItem,
  workerId: string,
  errorCode: string,
  retryBaseMs: number,
  retryMaxMs: number,
): void {
  const supervised = item.execution_mode === "supervised_worker";
  if (supervised && /^(OUTCOME_UNKNOWN|RECONCILIATION_REQUIRED|RECEIPT_OUTCOME_UNKNOWN)$/.test(errorCode)) {
    if (!item.lease_id) throw workerPolicyError("WORKER_LEASE_REQUIRED", "worker queue lease id is missing");
    store.requireWorkerReconciliation({
      proposalId: item.proposal_id,
      workerId,
      leaseId: item.lease_id,
      errorCode,
    });
    operationalLog("error", "worker_reconciliation_required", {
      proposal_id: item.proposal_id,
      worker_id: workerId,
      error_code: errorCode,
      attempt: item.attempts,
    });
    return;
  }
  const retryable = isRetryableWritebackCode(errorCode, item.execution_mode);
  if (!retryable) {
    if (supervised) {
      if (!item.lease_id) throw workerPolicyError("WORKER_LEASE_REQUIRED", "worker queue lease id is missing");
      store.blockWorkerItem({
        proposalId: item.proposal_id,
        workerId,
        leaseId: item.lease_id,
        errorCode,
      });
      operationalLog("warn", "worker_item_blocked", {
        proposal_id: item.proposal_id,
        worker_id: workerId,
        error_code: errorCode,
        attempt: item.attempts,
      });
    } else {
      store.deadLetterWorkerItem({ proposalId: item.proposal_id, workerId, errorCode, leaseId: item.lease_id });
      operationalLog("error", "worker_item_dead_lettered", { proposal_id: item.proposal_id, worker_id: workerId, error_code: errorCode, attempt: item.attempts });
    }
    return;
  }
  const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, item.attempts - 1));
  const updated = store.retryWorkerItem({
    proposalId: item.proposal_id,
    workerId,
    errorCode,
    retryAt: new Date(Date.now() + delay).toISOString(),
    leaseId: item.lease_id,
  });
  operationalLog(updated.status === "dead_letter" ? "error" : "warn", updated.status === "dead_letter" ? "worker_item_dead_lettered" : "worker_retry_scheduled", {
    proposal_id: item.proposal_id,
    worker_id: workerId,
    error_code: errorCode,
    attempt: updated.attempts,
    max_attempts: updated.max_attempts,
  });
}


function isRetryableWritebackCode(code: string, mode: WorkerQueueItem["execution_mode"] = "legacy"): boolean {
  if (mode === "supervised_worker") {
    return /^(DATABASE_UNAVAILABLE|TEMPORARILY_UNAVAILABLE|TRANSACTION_FAILED|IDEMPOTENCY_RECEIPT_IN_PROGRESS)$/.test(code);
  }
  return /^(DATABASE_UNAVAILABLE|TRANSACTION_FAILED|HANDLER_TIMEOUT|HANDLER_REQUEST_FAILED|HANDLER_HTTP_(429|5\d\d)|IDEMPOTENCY_RECEIPT_IN_PROGRESS|WORKER_EXECUTION_ERROR)$/.test(code);
}


function workerErrorCode(error: unknown): string {
  const safe = safeOperationalErrorCode(error);
  if (safe !== "COMMAND_REJECTED") return safe;
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) return "HANDLER_TIMEOUT";
  return "WORKER_EXECUTION_ERROR";
}


export function formatPrometheusMetrics(rows: OperationalMetricRow[]): string {
  const definitions = [
    ["synapsor_proposals_total", "proposals", "Proposals created by trusted tenant and capability."],
    ["synapsor_approvals_total", "approvals", "Approved decisions by trusted tenant and capability."],
    ["synapsor_rejections_total", "rejections", "Rejected decisions by trusted tenant and capability."],
    ["synapsor_applies_total", "applies", "Successful or idempotently completed writebacks."],
    ["synapsor_conflicts_total", "conflicts", "Guarded writeback conflicts."],
    ["synapsor_writeback_failures_total", "failures", "Failed writeback outcomes."],
    ["synapsor_revert_proposals_total", "revert_proposals", "Reviewed compensation proposals created."],
    ["synapsor_revert_applies_total", "revert_applies", "Successfully applied reviewed compensations."],
  ] as const;
  const lines: string[] = [];
  for (const [name, field, help] of definitions) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const row of rows) {
      lines.push(`${name}{tenant="${prometheusLabel(row.tenant_id)}",capability="${prometheusLabel(row.capability)}"} ${row[field]}`);
    }
  }
  lines.push("# EOF", "");
  return lines.join("\n");
}


function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
