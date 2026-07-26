import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { preflightGeneratedAuthority, resolveSupervisedWorkerEligibility } from "@synapsor-runner/mcp-server";
import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import { parseWritebackJob, type WritebackJob } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { requiredAttentionSinksHealthy } from "./attention-domain.js";
import { operationalLog } from "./cli-logging.js";
import { optionalArg } from "./cli-options.js";
import { envWithDemoDefaults, operatorIdentityForDecision, readRuntimeConfig, redactConfig, requireLocalProposal, resolveProposalId, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { TrustedOperatorInvocation, trustedCliContext } from "./operator-authority.js";
import { argsWithRuntimeStoreBridge, assertLocalGovernanceMutationAllowed, assertNoRuntimeStoreForLocalMutation, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge, withoutSharedPostgresLedgerMirror } from "./store-shared.js";
import { assertSupervisedPolicyApprovalCurrent, assertSupervisedWriterPosture, supervisedWorkerEligibilityCode, workerControlAllowsPolicy, workerPolicyError } from "./worker-policy.js";
import { applyCommandHandlerProposal, applyHttpHandlerProposal, applySqlJob, executorConfig, findProposalCapability, formatApplyResult, formatHandlerApplyResult, logProposalWritebackOutcome, proposalExecutorName, verifyStoredApprovalAuthority } from "./writeback-execution.js";


export async function authorizeConfiguredJobApply(
  args: string[],
  job: WritebackJob,
  configPath: string,
  storePath: string | undefined,
): Promise<void> {
  const config = await readRuntimeConfig(configPath);
  if (!config.operator_identity) return;
  if (!storePath) {
    throw new Error("operator_identity requires --store for apply so the signed authorization can be bound to the proposal ledger");
  }
  const store = new ProposalStore(storePath);
  try {
    const proposal = requireLocalProposal(store, job.proposal_id);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "apply" });
    store.recordOperatorAuthorization(job.proposal_id, identity, config.operator_identity.provider !== "dev_env");
    operationalLog("info", "operator_decision", {
      action: "apply",
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant: proposal.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: config.operator_identity.apply_roles?.join(",") || undefined,
    });
  } finally {
    store.close();
  }
}


export type BatchApplyResult = {
  proposal_id: string;
  capability: string;
  tenant: string;
  status: "applied" | "conflict" | "skipped";
  detail: string;
};


export function formatBatchApplySummary(summary: {
  selected: number;
  applied: number;
  conflict: number;
  skipped: number;
  results: BatchApplyResult[];
}): string {
  const lines = [
    "Synapsor approved proposal batch",
    "",
    ...summary.results.map((result) => `${result.status.toUpperCase()} ${result.proposal_id}  ${result.capability}  tenant=${result.tenant}  ${result.detail}`),
    ...(summary.results.length === 0 ? ["No approved or pending-worker proposals matched."] : []),
    "",
    `Summary: ${summary.applied} applied / ${summary.conflict} conflict / ${summary.skipped} skipped (${summary.selected} selected)`,
    "",
  ];
  return lines.join("\n");
}


export async function applyProposal(
  args: string[],
  proposalId: string,
  invocation: TrustedOperatorInvocation = {},
): Promise<number> {
  const configPath = runnerConfigPath(args);
  const storePath = resolvedLocalStorePath(args);
  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const runnerId = optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner";
  const workerAttempt = Number(optionalArg(args, "--worker-attempt") ?? "1");
  const workerExecutionMode = optionalArg(args, "--worker-execution-mode");
  const workerLeaseId = optionalArg(args, "--worker-lease-id");
  const config = await readRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "apply");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `apply ${proposalId}`,
      (bridgeStorePath) => applyProposal(argsWithRuntimeStoreBridge(args, bridgeStorePath), proposalId, invocation),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "apply", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(
      args,
      storePath,
      `apply ${proposalId}`,
      () => applyProposal(withoutSharedPostgresLedgerMirror(args), proposalId, invocation),
      config,
    );
  }
  const resolvedProposalId = await resolveProposalId(proposalId, storePath);
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`cannot apply proposal with invalid local config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
  }
  if (config.mode !== "review") {
    throw new Error(`local proposal apply requires review mode, got ${config.mode}`);
  }
  if (storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  const store = new ProposalStore(storePath);
  try {
    const proposal = requireLocalProposal(store, resolvedProposalId);
    const capability = findProposalCapability(config, proposal);
    let supervisedPolicy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]> | undefined;
    if (workerExecutionMode !== undefined) {
      if (workerExecutionMode !== "supervised_worker" || !workerLeaseId) {
        throw workerPolicyError(
          "SUPERVISED_WORKER_LEASE_REQUIRED",
          "supervised worker apply requires its exact execution mode and active lease id",
        );
      }
      const queueItem = store.assertActiveWorkerLease({
        proposalId: resolvedProposalId,
        workerId: runnerId,
        leaseId: workerLeaseId,
      });
      if (queueItem.execution_mode !== "supervised_worker") {
        throw workerPolicyError("SUPERVISED_WORKER_QUEUE_MODE_MISMATCH", "worker queue item is not supervised execution authority");
      }
      const eligibility = resolveSupervisedWorkerEligibility(config, capability, {
        workerIdentity: runnerId,
        phase: "execute",
      });
      if (!eligibility.eligible || !eligibility.policy || !eligibility.contract_digest) {
        throw workerPolicyError(
          supervisedWorkerEligibilityCode(eligibility.reasons),
          `supervised execution authority no longer matches: ${eligibility.reasons.join(", ")}`,
        );
      }
      if (
        queueItem.contract_digest !== eligibility.contract_digest
        || queueItem.contract_digest !== capability.contract_provenance?.digest
      ) {
        throw workerPolicyError(
          "SUPERVISED_WORKER_DIGEST_STALE",
          "queued contract digest no longer matches the exact active capability digest",
        );
      }
      const workerControl = store.workerControlState();
      if (workerControl.mode !== "active") {
        throw workerPolicyError(
          "SUPERVISED_WORKER_PAUSED",
          `supervised execution is ${workerControl.mode}; no new source mutation may begin`,
        );
      }
      if (!workerControlAllowsPolicy(workerControl, eligibility.policy)) {
        throw workerPolicyError(
          "SUPERVISED_WORKER_DIGEST_REVOKED",
          "supervised execution is disabled or revoked for this exact capability digest",
        );
      }
      if (!requiredAttentionSinksHealthy(store, config, eligibility.policy)) {
        throw workerPolicyError(
          "SUPERVISED_WORKER_ATTENTION_SINK_UNHEALTHY",
          "required supervision sinks are not healthy; approved work remains held",
        );
      }
      await assertSupervisedWriterPosture(
        store,
        config,
        eligibility.policy,
        envWithDemoDefaults(config, configPath),
      );
      supervisedPolicy = eligibility.policy;
    } else if (workerLeaseId) {
      throw workerPolicyError(
        "SUPERVISED_WORKER_MODE_REQUIRED",
        "a worker lease id cannot be used without supervised-worker execution mode",
      );
    }
    await verifyStoredApprovalAuthority(config, configPath, store, proposal, capability);
    const identity = await operatorIdentityForDecision({
      args,
      config,
      configPath,
      proposal,
      action: "apply",
      decision: invocation.decision,
    });
    store.recordOperatorAuthorization(resolvedProposalId, identity, Boolean(config.operator_identity && config.operator_identity.provider !== "dev_env"));
    operationalLog("info", "operator_decision", {
      action: "apply",
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant: proposal.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: config.operator_identity?.apply_roles?.join(",") || undefined,
    });
    const proposalScope = proposal.change_set.guards.principal_scope;
    if (capability.target.principal_scope_key) {
      if (!proposalScope || proposalScope.column !== capability.target.principal_scope_key || proposalScope.value === undefined) {
        throw new Error(`proposal ${proposal.proposal_id} is missing its reviewed principal scope`);
      }
      if (proposalScope.provider === "environment" || proposalScope.provider === "static_dev") {
        const current = trustedCliContext(config, capability, process.env);
        if (current.tenant_id !== proposal.tenant_id || current.principal !== String(proposalScope.value)) {
          throw new Error("current trusted tenant/principal cannot apply this proposal");
        }
      }
    } else if (proposalScope) {
      throw new Error(`proposal ${proposal.proposal_id} carries unreviewed principal scope`);
    }
    if (supervisedPolicy) {
      const expiresAt = Date.parse(proposal.created_at) + supervisedPolicy.proposal_ttl_seconds * 1_000;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw workerPolicyError(
          "SUPERVISED_WORKER_PROPOSAL_EXPIRED",
          "the supervised proposal exceeded its reviewed execution TTL",
        );
      }
      assertSupervisedPolicyApprovalCurrent(store, config, capability, proposal);
      await preflightGeneratedAuthority(config, envWithDemoDefaults(config, configPath));
    }
    const executorName = proposalExecutorName(proposal, capability);
    if (executorName === "none" || executorName === "cloud_worker") {
      throw new Error(`proposal ${resolvedProposalId} is not locally applyable; capability ${capability.name} declares ${executorName === "none" ? "no local writeback" : "cloud-worker writeback"}.`);
    }
    if (executorName === "sql_update") {
      if (supervisedPolicy && workerLeaseId) {
        store.renewWorkerLease({
          proposalId: resolvedProposalId,
          workerId: runnerId,
          leaseId: workerLeaseId,
          leaseSeconds: supervisedPolicy.lease_seconds,
        });
      }
      const job = store.createWritebackJobFromProposal(resolvedProposalId, {
        project_id: optionalArg(args, "--project") ?? "local",
        runner_id: runnerId,
        lease_seconds: supervisedPolicy?.lease_seconds ?? Number(optionalArg(args, "--lease-seconds") ?? "300"),
        ...(workerLeaseId ? { lease_id: workerLeaseId } : {}),
        attempt: workerAttempt,
      });
      const result = await applySqlJob(job, configPath, storePath, dryRun, envWithDemoDefaults(config, configPath));
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!invocation.quiet && !args.includes("--batch-quiet")) {
        process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatApplyResult(parseWritebackJob(job), result, dryRun, storePath));
      }
      return result.status === "failed" || result.status === "reconciliation_required" ? 1 : 0;
    }
    const executor = executorConfig(config, executorName);
    if (executor.type === "http_handler") {
      const result = await applyHttpHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, workerAttempt, env: envWithDemoDefaults(config, configPath) });
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!invocation.quiet && !args.includes("--batch-quiet")) {
        process.stdout.write(args.includes("--json") ? `${JSON.stringify(redactConfig(result), null, 2)}\n` : formatHandlerApplyResult(result, resolvedProposalId, storePath));
      }
      return result.status === "failed" ? 1 : 0;
    }
    if (executor.type === "command_handler") {
      const result = await applyCommandHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, workerAttempt, env: envWithDemoDefaults(config, configPath) });
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!invocation.quiet && !args.includes("--batch-quiet")) {
        process.stdout.write(args.includes("--json") ? `${JSON.stringify(redactConfig(result), null, 2)}\n` : formatHandlerApplyResult(result, resolvedProposalId, storePath));
      }
      return result.status === "failed" ? 1 : 0;
    }
    throw new Error(`unsupported executor type for ${executorName}`);
  } finally {
    store.close();
  }
}
