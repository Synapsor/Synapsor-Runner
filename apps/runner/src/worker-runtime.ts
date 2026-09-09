import { resolveActivatedActionRule } from "@synapsor-runner/action-rules";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  resolveSemanticSupervisedWorkerEligibility,
  resolveSupervisedWorkerEligibility,
  supervisedWorkerPolicies,
  supervisedWorkerPolicyDigest,
  supervisedWorkerPolicyName,
  type RuntimeCapabilityConfig,
  type RuntimeConfig,
  type RuntimeSupervisedWorkerPolicy,
} from "@synapsor-runner/mcp-server";
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
import { confirmDangerousAction, openLocalStoreAt, operatorIdentityForDecision, optionalRuntimeConfig, readRuntimeConfig, requireLocalProposal, resolveProposalIdFromStore, resolvedRuntimeStorePath, runnerConfigPath } from "./cli-project.js";
import { runnerProcessStartedAt } from "./cli-runtime.js";
import { applyProposal } from "./guarded-apply.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { argsWithRuntimeStoreBridge, assertGovernedLocalRuntimeStore, assertNoRuntimeStoreForLocalMutation, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge, withoutSharedPostgresLedgerMirror } from "./store-shared.js";
import { assertSemanticSupervisedWriterPosture, assertSupervisedWriterPosture, currentSupervisedApprovalPolicy, workerControlAllowsPolicy, workerControlOperatorDecisionAction, workerPolicyError } from "./worker-policy.js";
import { findProposalCapability, loadSemanticProposalAuthority, loadSemanticRuntimeAuthority } from "./writeback-execution.js";
import { executionBindingDigest } from "./control-policy-execution.js";


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
  const storePath = resolvedRuntimeStorePath(args, configPath, config?.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, readOnly: true });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath: store.path, store, readOnly: true });
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
      process.stdout.write(`${JSON.stringify({ worker_control: control, worker_health: "unknown", summary,
        worker_queue: items.map((item) => ({ ...item, recovery: workerFailureRecovery(item.last_error_code, item.status) })) }, null, 2)}\n`);
    } else {
      process.stdout.write(`Supervised execution: ${control.mode} (control revision ${control.revision})\n`);
      process.stdout.write("Worker health: unknown. Queue state and lease counts do not prove that a worker process is running.\n");
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
        const recovery = workerFailureRecovery(item.last_error_code, item.status);
        if (recovery) process.stdout.write(`  Next: ${recovery}\n`);
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
  const storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, store });
    const controlTarget: WorkerControlTarget = { action, ...target };
    const current = store.workerControlState();
    const subject = workerControlDecisionSubject(current, controlTarget);
    const policies = supervisedWorkerPolicies(config).filter((policy) =>
      !target.capability
      || (supervisedWorkerPolicyName(policy) === target.capability
        && supervisedWorkerPolicyDigest(policy) === target.contract_digest));
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
  const storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, store });
    const proposalId = resolveProposalIdFromStore(proposalReference, store);
    const proposal = requireLocalProposal(store, proposalId);
    const queue = store.getWorkerQueueItem(proposalId);
    if (!queue) throw new Error(`worker queue item not found for ${proposalId}`);
    const policy = supervisedWorkerPolicies(config).find((candidate) =>
      supervisedWorkerPolicyName(candidate) === proposal.action
      && supervisedWorkerPolicyDigest(candidate) === queue.contract_digest);
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
  const storePath = resolvedRuntimeStorePath(args, configPath, config?.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, readOnly: true });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath: store.path, store, readOnly: true });
    const item = store.getWorkerQueueItem(proposalId);
    if (!item) throw new Error(`worker queue item not found for ${proposalId}`);
    const proposal = requireLocalProposal(store, proposalId);
    const recovery = workerFailureRecovery(item.last_error_code, item.status);
    const payload = { worker_queue: item, proposal, receipts: store.receipts(proposalId), events: store.events(proposalId), recovery };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `${item.status.toUpperCase()} ${item.proposal_id}`,
      `Attempts: ${item.attempts}/${item.max_attempts}`,
      `Last safe error: ${item.last_error_code ?? "none"}`,
      `Proposal state: ${proposal.state}`,
      `Receipts retained: ${payload.receipts.length}`,
      `Events retained: ${payload.events.length}`,
      ...(recovery ? [`Next: ${recovery}`] : []),
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
  const storePath = resolvedRuntimeStorePath(args, configPath, config?.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath: store.path, store });
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


export async function enqueueApprovedForSupervisedWorker(
  store: ProposalStore,
  config: RuntimeConfig,
  configPath: string,
  filters: { capability?: string; tenant?: string },
): Promise<void> {
  const proposals = [
    ...store.listProposals({ state: "approved", capability: filters.capability, tenant: filters.tenant }),
    ...store.listProposals({ state: "pending_worker", capability: filters.capability, tenant: filters.tenant }),
  ];
  for (const proposal of proposals) {
    const existing = store.getWorkerQueueItem(proposal.proposal_id);
    if (existing) continue;
    let policy: RuntimeSupervisedWorkerPolicy;
    let authorityDigest: `sha256:${string}`;
    if (proposal.change_set.schema_version === "synapsor.change-set.v4") {
      try {
        const authority = await loadSemanticProposalAuthority(config, configPath, proposal);
        const eligibility = resolveSemanticSupervisedWorkerEligibility(config, authority.activated, { phase: "queue" });
        if (!eligibility.eligible || !eligibility.policy || !eligibility.action_boundary_digest) continue;
        policy = eligibility.policy;
        authorityDigest = eligibility.action_boundary_digest;
      } catch {
        continue;
      }
    } else {
      let capability: RuntimeCapabilityConfig;
      try {
        capability = findProposalCapability(config, proposal);
      } catch {
        continue;
      }
      const eligibility = resolveSupervisedWorkerEligibility(config, capability, { phase: "queue" });
      if (!eligibility.eligible
        || !eligibility.policy
        || !eligibility.contract_digest
        || proposal.change_set.contract?.digest !== eligibility.contract_digest) continue;
      policy = eligibility.policy;
      authorityDigest = eligibility.contract_digest;
    }
    try {
      store.enqueueWorkerProposal({
        proposal_id: proposal.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: authorityDigest,
        max_attempts: policy.max_attempts,
        queue_limit: policy.queue_limit,
      });
    } catch (error) {
      const code = safeOperationalErrorCode(error);
      if (code !== "WORKER_QUEUE_LIMIT_EXCEEDED") throw error;
      const attentionKey = [
        config.supervised_worker?.profile ?? "unknown",
        "policy.limit_exceeded",
        proposal.action,
        authorityDigest,
        "worker_queue",
      ].join(":");
      store.recordAttentionEvent({
        event_type: "policy.limit_exceeded",
        severity: "critical",
        environment: config.supervised_worker?.profile ?? "unknown",
        capability: proposal.action,
        contract_digest: authorityDigest,
        attention_key: attentionKey,
        attention_required: true,
        immediate_default: true,
        failure_class: code,
        summary: `${proposal.action} supervised-execution queue reached its reviewed limit`,
        workbench_path: workbenchAttentionPath(attentionKey),
        details: {
          failure_class: code,
          source_database_changed: false,
        },
        source_event_key: `worker-queue-limit:${proposal.proposal_id}:${authorityDigest}`,
      });
    }
  }
}


export async function claimSupervisedWorkerItem(
  store: ProposalStore,
  config: RuntimeConfig,
  configPath: string,
  input: { workerId: string; capability?: string; tenant?: string },
): Promise<{
  item: WorkerQueueItem;
  policy: RuntimeSupervisedWorkerPolicy;
} | undefined> {
  const workerControl = store.workerControlState();
  updateSupervisedWorkerBacklogAttention(store, config);
  updateSupervisedProposalExpiryAttention(store, config);
  if (workerControl.mode !== "active") return undefined;
  const policies = supervisedWorkerPolicies(config)
    .filter((policy) => !input.capability || supervisedWorkerPolicyName(policy) === input.capability)
    .sort((left, right) => supervisedWorkerPolicyName(left).localeCompare(supervisedWorkerPolicyName(right))
      || supervisedWorkerPolicyDigest(left).localeCompare(supervisedWorkerPolicyDigest(right)));
  let semanticAuthority: Awaited<ReturnType<typeof loadSemanticRuntimeAuthority>> | undefined;
  for (const policy of policies) {
    if ("outcome" in policy) {
      try {
        semanticAuthority ??= await loadSemanticRuntimeAuthority(config, configPath);
        const activated = resolveActivatedActionRule(semanticAuthority.registry, policy.outcome);
        const eligibility = resolveSemanticSupervisedWorkerEligibility(config, activated, {
          workerIdentity: input.workerId,
          phase: "execute",
        });
        if (!eligibility.eligible || !eligibility.policy || !eligibility.action_boundary_digest) continue;
        if (!workerControlAllowsPolicy(workerControl, eligibility.policy)) continue;
        if (!requiredAttentionSinksHealthy(store, config, eligibility.policy)) {
          recordUnhealthySupervisionSinkAttention(store, config, eligibility.policy);
          continue;
        }
        resolveHealthySupervisionSinkAttention(store, config, eligibility.policy);
        await assertSemanticSupervisedWriterPosture(store, config, eligibility.policy, semanticAuthority.registry);
        const item = store.claimWorkerItem({
          workerId: input.workerId,
          leaseSeconds: eligibility.policy.lease_seconds,
          executionMode: "supervised_worker",
          capability: policy.outcome,
          tenant: input.tenant,
          contractDigest: eligibility.action_boundary_digest,
          maxConcurrent: eligibility.policy.concurrency,
          rateLimit: {
            executions: eligibility.policy.rate_limit.executions,
            windowSeconds: eligibility.policy.rate_limit.window_seconds,
          },
          proposalTtlSeconds: eligibility.policy.proposal_ttl_seconds,
        });
        if (item) return { item, policy: eligibility.policy };
      } catch {
        continue;
      }
      continue;
    }
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


function resolveSupervisedWorkerIdentity(config: RuntimeConfig, selected: string | undefined, capability?: string): string {
  const policies = supervisedWorkerPolicies(config).filter((policy) => policy.mode === "supervised_worker"
    && (!capability || supervisedWorkerPolicyName(policy) === capability));
  const identities = [...new Set(policies.flatMap((policy) => policy.worker_identity ? [policy.worker_identity] : []))].sort();
  if (selected !== undefined) {
    if (policies.length && !policies.some((policy) => !policy.worker_identity || policy.worker_identity === selected)) {
      throw workerPolicyError("SUPERVISED_WORKER_IDENTITY_MISMATCH",
        `Worker identity does not match the selected execution policies. Restart with --worker-id set to a reviewed identity (${identities.join(", ")}); use --capability to select an outcome. No proposal was claimed.`);
    }
    return selected;
  }
  if (identities.length > 1) {
    throw workerPolicyError("SUPERVISED_WORKER_IDENTITY_AMBIGUOUS",
      `Selected execution policies require different worker identities (${identities.join(", ")}). Select an outcome with --capability or a reviewed --worker-id. No proposal was claimed.`);
  }
  return identities[0] ?? `worker_${process.pid}`;
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
  const capability = optionalArg(args, "--capability");
  const selectedWorkerId = optionalArg(args, "--worker-id") ?? process.env.SYNAPSOR_RUNNER_ID;
  const workerId = supervised ? resolveSupervisedWorkerIdentity(config, selectedWorkerId, capability)
    : selectedWorkerId ?? `worker_${process.pid}`;
  // Pin the startup identity across shared-store bridge batches as well.
  const boundArgs = optionalArg(args, "--worker-id") === undefined ? [...args, "--worker-id", workerId] : args;
  if (config && runtimeStoreBridgeRequired(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      return workerRunSharedRuntimeStoreDaemon(boundArgs, config);
    }
    return withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => workerRun(argsWithRuntimeStoreBridge(boundArgs, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "worker run", args);
  const storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath });
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      throw new Error("shared Postgres ledger mirror for worker run requires --once or --drain. Use storage.shared_postgres.mode=runtime_store for long-running shared worker loops.");
    }
    return withSharedPostgresLedgerMirror(args, storePath, "worker run", () => workerRun(withoutSharedPostgresLedgerMirror(boundArgs)), config);
  }
  const maxAttempts = positiveIntOption(args, "--max-attempts", 5, 1, 100);
  const retryBaseMs = positiveIntOption(args, "--retry-base-ms", 1000, 1, 3_600_000);
  const retryMaxMs = positiveIntOption(args, "--retry-max-ms", 60_000, retryBaseMs, 86_400_000);
  const leaseSeconds = positiveIntOption(args, "--lease-seconds", 60, 15, 3600);
  const pollMs = positiveIntOption(args, "--poll-ms", 5000, 10, 3_600_000);
  const once = args.includes("--once");
  const drain = args.includes("--drain");
  const tenant = optionalArg(args, "--tenant");
  const startupStore = new ProposalStore(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, store: startupStore });
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
  // A foreground process group and its launcher can deliver the same signal.
  // Keep shutdown idempotent until the current guarded operation finishes.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    reportWorkerStarted(args);
    do {
      // Refresh before both enqueue and claim. A changed source, identity or
      // store binding requires a restart, not a hot switch of this worker.
      const currentExecutionConfig = async () => {
        const current = await readRuntimeConfig(configPath);
        if (executionBindingDigest(current) !== executionBindingDigest(config)) {
          throw workerPolicyError("WORKER_RUNTIME_BINDING_CHANGED", "Runtime bindings changed; restart the worker after review. No further proposal was claimed.");
        }
        if (current.supervised_worker?.enabled) resolveSupervisedWorkerIdentity(current, workerId, capability);
        return current;
      };
      const queueConfig = supervised ? await currentExecutionConfig() : config;
      if (supervised && !queueConfig.supervised_worker?.enabled) return 0;
      const store = new ProposalStore(storePath);
      let item;
      let supervisedPolicy: RuntimeSupervisedWorkerPolicy | undefined;
      try {
        await assertGovernedLocalRuntimeStore({ args, config: queueConfig, configPath, storePath, store });
        if (supervised) {
          await enqueueApprovedForSupervisedWorker(store, queueConfig, configPath, { capability, tenant });
          const claimConfig = await currentExecutionConfig();
          if (!claimConfig.supervised_worker?.enabled) return 0;
          const claimed = await claimSupervisedWorkerItem(store, claimConfig, configPath, {
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
              recovery: workerFailureRecovery(receipt?.safe_error_code ?? "RECONCILIATION_REQUIRED", "reconciliation_required"),
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
  let announced = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopped) {
      await withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => {
        return workerRun(argsWithRuntimeStoreBridge([...args, "--drain"], bridgeStorePath));
      });
      if (!announced) { reportWorkerStarted(args); announced = true; }
      if (!stopped) await waitFor(pollMs);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}


function reportWorkerStarted(args: string[]): void {
  if (args.some((arg) => ["--once", "--drain", "--batch-quiet", "--json"].includes(arg))) return;
  process.stdout.write("Worker started. Watching for approved requests; each execution still requires current authority.\n"
    + "Keep this terminal open. Ctrl-C stops the worker; saved rules and queued requests remain.\n");
}


function finishWorkerFailure(
  store: ProposalStore,
  item: WorkerQueueItem,
  workerId: string,
  errorCode: string,
  retryBaseMs: number,
  retryMaxMs: number,
): void {
  const leaseId = item.lease_id;
  if (!leaseId) throw workerPolicyError("WORKER_LEASE_REQUIRED", "worker queue lease id is missing");
  const supervised = item.execution_mode === "supervised_worker";
  if (supervised && /^(OUTCOME_UNKNOWN|RECONCILIATION_REQUIRED|RECEIPT_OUTCOME_UNKNOWN)$/.test(errorCode)) {
    store.requireWorkerReconciliation({
      proposalId: item.proposal_id,
      workerId,
      leaseId,
      errorCode,
    });
    operationalLog("error", "worker_reconciliation_required", {
      proposal_id: item.proposal_id,
      worker_id: workerId,
      error_code: errorCode,
      recovery: workerFailureRecovery(errorCode, "reconciliation_required"),
      attempt: item.attempts,
    });
    return;
  }
  const retryable = isRetryableWritebackCode(errorCode, item.execution_mode);
  if (!retryable) {
    if (supervised) {
      store.blockWorkerItem({
        proposalId: item.proposal_id,
        workerId,
        leaseId,
        errorCode,
      });
      operationalLog("warn", "worker_item_blocked", {
        proposal_id: item.proposal_id,
        worker_id: workerId,
        error_code: errorCode,
        recovery: workerFailureRecovery(errorCode),
        attempt: item.attempts,
      });
    } else {
      store.deadLetterWorkerItem({ proposalId: item.proposal_id, workerId, errorCode, leaseId });
      operationalLog("error", "worker_item_dead_lettered", { proposal_id: item.proposal_id, worker_id: workerId,
        error_code: errorCode, recovery: workerFailureRecovery(errorCode), attempt: item.attempts });
    }
    return;
  }
  const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, item.attempts - 1));
  const updated = store.retryWorkerItem({
    proposalId: item.proposal_id,
    workerId,
    errorCode,
    retryAt: new Date(Date.now() + delay).toISOString(),
    leaseId,
  });
  operationalLog(updated.status === "dead_letter" ? "error" : "warn", updated.status === "dead_letter" ? "worker_item_dead_lettered" : "worker_retry_scheduled", {
    proposal_id: item.proposal_id,
    worker_id: workerId,
    error_code: errorCode,
    attempt: updated.attempts,
    max_attempts: updated.max_attempts,
  });
}


export function workerFailureRecovery(code: string | null | undefined, state?: WorkerQueueItem["status"]): string | undefined {
  if (state === "reconciliation_required" || code === "OUTCOME_UNKNOWN" || code === "RECONCILIATION_REQUIRED"
    || code === "RECEIPT_OUTCOME_UNKNOWN" || code === "DELEGATION_EFFECT_RECONCILIATION_REQUIRED") {
    return "Reconcile the exact proposal's dispatch record, durable receipt and source outcome with a verified operator. Do not retry or requeue; completion is not proven.";
  }
  // Exact public codes only. Never include the exception message, proof or identity in recovery/log fields.
  switch (code) {
    case "DELEGATION_JOB_CHANGED":
    case "DELEGATION_CHANGED":
    case "DELEGATION_PARENT_CHANGED":
      return "Delegated authority or the sealed job changed. Review current authority and create a fresh request; do not retry this proposal.";
    case "DELEGATION_SOURCE_SCOPE_UNSUPPORTED":
      return "Source scope could not be verified. Check the approved proposal and reviewed source-scope configuration; do not change worker identity or widen grants.";
    case "DELEGATION_PROOF_REQUIRED":
    case "DELEGATION_PROOF_INVALID":
    case "DELEGATION_CONFIGURATION_INVALID":
      return "Verify the approved proposal and reviewed delegation configuration. Obtain valid proof through a fresh authorized request; do not inject worker identity or requeue this proposal.";
    case "DELEGATION_AUTHENTICATION_FAILED":
      return "Verify the approved proposal and reviewed authentication configuration. Use a fresh authenticated request, not a worker identity override; do not retry this proposal.";
    case "RUNTIME_PROOF_EXPIRED":
      return "Stored runtime proof expired. Create a fresh authenticated request under current reviewed authority; do not reuse this proposal or override worker identity.";
    case "RUNTIME_PROOF_UNAVAILABLE":
    case "RUNTIME_PROOF_INTEGRITY_INVALID":
      return "Verify the approved proposal's reviewed delegation binding and stored proof integrity. Do not retry or requeue this proposal, inject identity, or edit proof records.";
    case "DELEGATION_REQUEST_REFUSED":
    case "DELEGATION_NOT_AVAILABLE":
      return "Review current parent/owner authority and current eligibility. Submit a fresh request only when authorized; do not requeue this proposal or widen grants.";
    case "DELEGATION_BUDGET_UNAVAILABLE":
    case "DELEGATION_BUDGET_CHARGE_NOT_PROVEN":
    case "DELEGATION_BUDGET_INCOMPATIBLE":
    case "DELEGATION_BUDGET_LIMIT":
      return "Verify reviewed parent/owner budget definitions and exact effect charges. Do not raise caps or blindly retry; this code alone does not establish that a budget window is exhausted.";
    default:
      return undefined;
  }
}

export function isRetryableWritebackCode(code: string, mode: WorkerQueueItem["execution_mode"] = "legacy"): boolean {
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
