import { capabilityWritebackMode } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type StoredProposal,
  type StoredWritebackReceipt
} from "@synapsor-runner/proposal-store";
import { parseWritebackJob, protocolVersions, type CompensationChangeSetV1, type InverseDescriptorV1, type WritebackResult } from "@synapsor-runner/protocol";
import {
  type RunnerConfig
} from "@synapsor-runner/worker-core";
import { validateContract } from "@synapsor/spec";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { safeErrorMessage } from "./cli-format.js";
import { logIdentifier, operationalLog, safeOperationalErrorCode } from "./cli-logging.js";
import { firstPositional, optionalArg, optionalPositiveIntegerArg, positional, runtimeStoreBridgeFlag } from "./cli-options.js";
import { isSynapsorContractLike, operatorIdentityForDecision, optionalResolvedLocalStorePath, optionalRunnerConfigPath, optionalRuntimeConfig, readRuntimeConfig, requireLocalProposal, resolveProposalIdFromStore, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { adapters } from "./cli-runtime.js";
import { readJob } from "./config-templates.js";
import { BatchApplyResult, applyProposal, authorizeConfiguredJobApply, formatBatchApplySummary } from "./guarded-apply.js";
import { trustedCliContext } from "./operator-authority.js";
import { argsWithRuntimeStoreBridge, assertLocalGovernanceMutationAllowed, assertNoRuntimeStoreForLocalMutation, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge, withoutSharedPostgresLedgerMirror } from "./store-shared.js";
import { hashReceipt, runnerReceiptConfig, toExecutionReceipt, writebackDatabaseScope, writebackTimeoutMs } from "./writeback-domain.js";
import { createWritebackIntentAuthority, findProposalCapability, resolveSqlWriteDatabaseUrl, verifyLocalWritebackAuthority, writebackAffectedRows, writebackErrorCode, writebackResultStatus } from "./writeback-execution.js";


export async function validate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (target) {
    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    if (isSynapsorContractLike(parsed)) {
      const result = validateContract(parsed);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        process.stdout.write(`contract valid: ${target}\n`);
        for (const warning of result.warnings) process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
      } else {
        process.stdout.write(`contract invalid: ${target}\n`);
        for (const error of result.errors) process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
      }
      return result.ok ? 0 : 1;
    }
  }
  const job = await readJob(args);
  parseWritebackJob(job);
  process.stdout.write("job valid\n");
  return 0;
}


export async function revert(args: string[]): Promise<number> {
  const requested = positional(args, 0);
  if (!requested) throw new Error("revert requires an applied proposal id or latest");
  const configPath = runnerConfigPath(args);
  const storePath = resolvedLocalStorePath(args);
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `revert ${requested}`, (bridgeStorePath) => revert(argsWithRuntimeStoreBridge([...args, "--store", bridgeStorePath], bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "revert", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `revert ${requested}`, () => revert(withoutSharedPostgresLedgerMirror(args)), config);
  }
  if (config.mode !== "review") throw new Error(`revert requires review mode, got ${config.mode}`);
  if (storePath !== ":memory:") await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  const store = new ProposalStore(storePath);
  try {
    const proposalId = resolveProposalIdFromStore(requested, store);
    const forward = requireLocalProposal(store, proposalId);
    const capability = findProposalCapability(config, forward);
    if (capabilityWritebackMode(capability) !== "direct_sql") throw new Error(`REVERSAL_APP_EXECUTOR_UNSUPPORTED: ${capability.name} does not use Runner-owned direct SQL writeback`);
    if (capability.reversibility?.mode !== "reviewed_inverse") throw new Error(`REVERSIBILITY_NOT_REVIEWED: capability ${capability.name} does not declare reviewed inverse authority`);
    const trusted = trustedCliContext(config, capability, process.env);
    if (trusted.tenant_id !== forward.tenant_id) throw new Error("REVERSAL_TENANT_MISMATCH: current trusted tenant does not own the forward proposal");
    const forwardPrincipalScope = forward.change_set.guards.principal_scope;
    if (capability.target.principal_scope_key) {
      if (!forwardPrincipalScope?.value || forwardPrincipalScope.column !== capability.target.principal_scope_key) throw new Error("REVERSAL_PRINCIPAL_SCOPE_MISSING: forward proposal does not preserve reviewed principal authority");
      if (String(forwardPrincipalScope.value) !== trusted.principal) throw new Error("REVERSAL_PRINCIPAL_MISMATCH: current trusted principal does not own the forward proposal");
    }
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal: forward, action: "revert", reason: optionalArg(args, "--reason") });
    const receipt = [...store.receipts(forward.proposal_id)].reverse().find((item) => item.status === "applied" || item.status === "already_applied");
    if (!receipt) {
      if (forward.state === "reconciliation_required") throw new Error("REVERSAL_RECONCILIATION_REQUIRED: reconcile the ambiguous forward write before creating a revert proposal");
      throw new Error(`REVERSAL_APPLIED_RECEIPT_REQUIRED: proposal ${forward.proposal_id} has no successful writeback receipt`);
    }
    const inverse = inverseFromStoredReceipt(receipt);
    if (!inverse) throw new Error("REVERSAL_INVERSE_MISSING: the applied receipt predates or did not request reviewed inverse capture");
    if (inverse.availability !== "available") throw new Error(`REVERSAL_UNAVAILABLE: ${inverse.reason_codes.join(", ") || "the receipt has no safe inverse"}`);
    if (inverse.lineage.depth > 16) throw new Error("REVERSAL_CHAIN_DEPTH_EXHAUSTED");
    if (!receipt.receipt.receipt_hash.startsWith("sha256:")) throw new Error("REVERSAL_RECEIPT_INTEGRITY_REQUIRED");
    const forwardReceiptHash = receipt.receipt.receipt_hash as `sha256:${string}`;
    const duplicate = store.listProposals().find((candidate) => candidate.change_set.schema_version === protocolVersions.compensationChangeSet
      && candidate.change_set.compensation.forward_receipt_hash === forwardReceiptHash);
    if (duplicate) throw new Error(`REVERSAL_ALREADY_PROPOSED: ${duplicate.proposal_id} already compensates receipt ${forwardReceiptHash}`);
    const created = createCompensationProposal({ store, forward, receiptHash: forwardReceiptHash, inverse, actor: identity.subject, identity });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    else {
      process.stdout.write([
        `Revert proposal created: ${created.proposal_id}`,
        `Forward proposal: ${forward.proposal_id}`,
        `Forward receipt: ${forwardReceiptHash}`,
        `Operation: ${inverse.operation}`,
        `Rows bounded: ${inverse.members.length} of ${inverse.max_rows}`,
        "Source database changed: no",
        "Approval: required outside MCP",
        "",
        "Next:",
        `  ${cliCommandName()} proposals show ${created.proposal_id} --details --store ${storePath}`,
        `  ${cliCommandName()} proposals approve ${created.proposal_id} --yes --config ${configPath} --store ${storePath}`,
        `  ${cliCommandName()} apply ${created.proposal_id} --config ${configPath} --store ${storePath}`,
        "",
      ].join("\n"));
    }
    return 0;
  } finally {
    store.close();
  }
}


function inverseFromStoredReceipt(receipt: StoredWritebackReceipt): InverseDescriptorV1 | undefined {
  const value = receipt.receipt;
  if (value.schema_version === protocolVersions.executionReceiptV2
    || value.schema_version === protocolVersions.executionReceiptV3
    || value.schema_version === protocolVersions.executionReceiptV4) return value.inverse;
  return undefined;
}


function createCompensationProposal(input: {
  store: ProposalStore;
  forward: StoredProposal;
  receiptHash: `sha256:${string}`;
  inverse: InverseDescriptorV1;
  actor: string;
  identity: { provider: string; verified: boolean; subject: string; roles: string[]; decision_hash: string };
}): StoredProposal {
  const proposalId = `wrp_revert_${crypto.randomBytes(10).toString("hex")}`;
  const evidenceId = `ev_revert_${crypto.randomBytes(10).toString("hex")}`;
  const createdAt = new Date().toISOString();
  const one = input.inverse.members.length === 1 ? input.inverse.members[0] : undefined;
  const before = one ? one.expected_state : { row_count: input.inverse.members.length };
  const patch = one?.restore_values ?? { operation: input.inverse.operation, row_count: input.inverse.members.length };
  const after = input.inverse.operation === "remove_insert"
    ? { row_count: 0 }
    : one?.restore_values ?? { row_count: input.inverse.members.length };
  const evidenceItems = input.inverse.members.map((member) => ({
    schema_version: "synapsor.revert-evidence.v1",
    primary_key: member.primary_key,
    expected_state_digest: hashReceipt(member.expected_state),
    restore_values_digest: hashReceipt(member.restore_values ?? {}),
  }));
  const queryFingerprint = hashReceipt({ forward_receipt_hash: input.receiptHash, inverse: input.inverse });
  const originalApproval = input.forward.change_set.approval;
  const core = {
    schema_version: protocolVersions.compensationChangeSet,
    proposal_id: proposalId,
    proposal_version: 1,
    action: input.forward.action,
    ...(input.forward.change_set.contract ? { contract: input.forward.change_set.contract } : {}),
    mode: "review_required" as const,
    // Compensation targets the same trusted row scope as the forward effect.
    // The operator requesting the revert is recorded separately in evidence.
    principal: structuredClone(input.forward.change_set.principal),
    scope: { tenant_id: input.forward.tenant_id, business_object: input.forward.business_object, object_id: input.forward.object_id },
    source: {
      kind: input.forward.source_kind === "external_mysql" ? "external_mysql" as const : "external_postgres" as const,
      source_id: input.forward.source_id,
      schema: input.forward.source_schema,
      table: input.forward.source_table,
      primary_key: {
        column: input.inverse.target.primary_key_column,
        ...(one ? { value: one.primary_key.value } : {}),
      },
    },
    before,
    patch,
    after,
    compensation: { descriptor: input.inverse, forward_receipt_hash: input.receiptHash },
    guards: { tenant: input.inverse.tenant_guard, ...(input.inverse.principal_scope ? { principal_scope: input.inverse.principal_scope } : {}), allowed_columns: input.inverse.allowed_columns },
    evidence: { bundle_id: evidenceId, query_fingerprint: queryFingerprint, items: evidenceItems },
    approval: {
      status: "pending" as const,
      mode: originalApproval.mode === "operator" ? "operator" as const : "human" as const,
      ...(originalApproval.required_role ? { required_role: originalApproval.required_role } : {}),
      ...(originalApproval.required_approvals ? { required_approvals: originalApproval.required_approvals } : {}),
    },
    writeback: { status: "not_applied" as const, mode: "trusted_worker_required" as const, executor: "sql_update" as const },
    source_database_mutated: false as const,
    created_at: createdAt,
  };
  const changeSet: CompensationChangeSetV1 = { ...core, integrity: { proposal_hash: hashReceipt(core) } };
  const proposal = input.store.createProposal(changeSet);
  input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceId,
    proposal_id: proposalId,
    tenant_id: input.forward.tenant_id,
    payload: {
      schema_version: "synapsor.revert-evidence.v1",
      capability: input.forward.action,
      principal: input.actor,
      business_object: input.forward.business_object,
      object_id: input.forward.object_id,
      forward_proposal_id: input.forward.proposal_id,
      forward_receipt_hash: input.receiptHash,
      requested_by: { provider: input.identity.provider, verified: input.identity.verified, subject: input.identity.subject, roles: input.identity.roles, decision_hash: input.identity.decision_hash },
    },
    items: evidenceItems,
  });
  input.store.replay(proposalId);
  return proposal;
}


export async function apply(args: string[]): Promise<number> {
  if (args.includes("--all-approved")) return applyAllApproved(args);
  const directProposalId = positional(args, 0);
  const proposalId = optionalArg(args, "--proposal") ?? (directProposalId && !directProposalId.endsWith(".json") ? directProposalId : undefined);
  if (proposalId) return applyProposal(args, proposalId);

  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const configPath = await optionalRunnerConfigPath(args);
  const runtimeConfig = configPath ? await optionalRuntimeConfig(configPath) : undefined;
  if (!dryRun) assertLocalGovernanceMutationAllowed(runtimeConfig, "apply --job");
  if (runtimeConfig && runtimeStoreBridgeRequired(args, runtimeConfig)) {
    return withSharedPostgresRuntimeStoreBridge(args, runtimeConfig, "apply --job", (bridgeStorePath) => apply(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(runtimeConfig, "apply --job", args);
  const storePath = optionalResolvedLocalStorePath(args);
  const mirrorStorePath = storePath ?? runtimeConfig?.storage?.sqlite_path;
  if (mirrorStorePath && sharedPostgresLedgerMirrorRequested(args, runtimeConfig)) {
    return withSharedPostgresLedgerMirror(args, mirrorStorePath, "apply --job", () => apply(withoutSharedPostgresLedgerMirror(args)), runtimeConfig);
  }

  const raw = await readJob(args);
  const job = parseWritebackJob(raw);
  if (configPath) {
    if (!dryRun && !storePath) {
      throw new Error("local config writeback apply requires --store so proposal approval and digest can be verified");
    }
    await verifyLocalWritebackAuthority(job, configPath, storePath);
    await authorizeConfiguredJobApply(args, job, configPath, storePath);
  }
  const databaseUrl = configPath
    ? await resolveSqlWriteDatabaseUrl(job, configPath, process.env)
    : process.env.SYNAPSOR_DATABASE_URL || "";
  let localStore: ProposalStore | undefined;
  if (storePath) {
    if (storePath !== ":memory:") {
      await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
    }
    localStore = new ProposalStore(storePath);
  }
  const config: RunnerConfig = {
    controlPlaneUrl: process.env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: process.env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: process.env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: process.env.SYNAPSOR_SOURCE_ID || job.source_id,
    databaseUrl,
    engine: job.engine,
    pollIntervalMs: Number(process.env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    statementTimeoutMs: writebackTimeoutMs(runtimeConfig?.sources?.[job.source_id], process.env),
    logLevel: (process.env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: process.env.SYNAPSOR_STATE_DIR || "./state",
    receipts: runnerReceiptConfig(runtimeConfig?.sources?.[job.source_id]),
    databaseScope: writebackDatabaseScope(
      runtimeConfig?.sources?.[job.source_id],
      localStore?.getProposal(job.proposal_id),
      job,
    ),
  };
  const intentAuthority = createWritebackIntentAuthority(runtimeConfig, job.source_id, process.env, localStore);
  if (intentAuthority.store) config.writebackIntentStore = intentAuthority.store;
  let result: WritebackResult;
  try {
    result = await adapters[job.engine].apply(job, config);
    localStore?.recordExecutionReceipt(toExecutionReceipt(job, result, config.dryRun));
  } finally {
    await intentAuthority.close();
    localStore?.close();
  }
  operationalLog("info", "writeback_outcome", {
    proposal_id: job.proposal_id,
    tenant: logIdentifier(job.target.tenant_guard.value),
    source: job.source_id,
    runner_id: config.runnerId,
    executor: "sql_update",
    status: writebackResultStatus(result),
    rows_affected: writebackAffectedRows(result),
    error_code: writebackErrorCode(result),
    dry_run: dryRun,
    source_database_changed: writebackResultStatus(result) === "applied" && !dryRun && writebackAffectedRows(result) > 0,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "failed" || result.status === "reconciliation_required" ? 1 : 0;
}


async function applyAllApproved(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    throw new Error("apply --all-approved requires --yes because it can commit multiple approved proposals");
  }
  if (positional(args, 0)) throw new Error("apply --all-approved does not accept a proposal id or --job");
  const configPath = runnerConfigPath(args);
  const storePath = resolvedLocalStorePath(args);
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "apply --all-approved");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, "apply --all-approved", (bridgeStorePath) => applyAllApproved(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "apply --all-approved", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, "apply --all-approved", () => applyAllApproved(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const capability = optionalArg(args, "--capability");
  const tenant = optionalArg(args, "--tenant");
  const max = optionalPositiveIntegerArg(args, "--max");
  const store = new ProposalStore(storePath);
  let selected: StoredProposal[];
  try {
    const filters = { capability, tenant };
    selected = [
      ...store.listProposals({ ...filters, state: "approved" }),
      ...store.listProposals({ ...filters, state: "pending_worker" }),
    ]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, max ?? Number.POSITIVE_INFINITY);
  } finally {
    store.close();
  }

  const results: BatchApplyResult[] = [];
  for (const proposal of selected) {
    try {
      await applyProposal([
        proposal.proposal_id,
        "--config", configPath,
        "--store", storePath,
        "--yes",
        "--batch-quiet",
        ...(args.includes("--dry-run") ? ["--dry-run"] : []),
        ...(optionalArg(args, "--runner") ? ["--runner", optionalArg(args, "--runner")!] : []),
        ...(optionalArg(args, "--project") ? ["--project", optionalArg(args, "--project")!] : []),
        ...(optionalArg(args, "--lease-seconds") ? ["--lease-seconds", optionalArg(args, "--lease-seconds")!] : []),
        ...(optionalArg(args, "--identity") ? ["--identity", optionalArg(args, "--identity")!] : []),
        ...(optionalArg(args, "--identity-key") ? ["--identity-key", optionalArg(args, "--identity-key")!] : []),
        ...(optionalArg(args, "--actor") ? ["--actor", optionalArg(args, "--actor")!] : []),
        ...(args.includes(runtimeStoreBridgeFlag) ? [runtimeStoreBridgeFlag] : []),
      ], proposal.proposal_id);
      const afterStore = new ProposalStore(storePath);
      try {
        const after = afterStore.getProposal(proposal.proposal_id);
        const status = after?.state === "conflict" ? "conflict" : after?.state === "applied" ? "applied" : "skipped";
        results.push({
          proposal_id: proposal.proposal_id,
          capability: proposal.action,
          tenant: proposal.tenant_id,
          status,
          detail: after
            ? status === "skipped"
              ? `not applied; proposal remained ${after.state}`
              : `proposal state: ${after.state}`
            : "not applied; proposal no longer exists",
        });
      } finally {
        afterStore.close();
      }
    } catch (error) {
      operationalLog("warn", "writeback_outcome", {
        proposal_id: proposal.proposal_id,
        capability: proposal.action,
        tenant: proposal.tenant_id,
        status: "skipped",
        error_code: safeOperationalErrorCode(error),
        source_database_changed: false,
      });
      results.push({
        proposal_id: proposal.proposal_id,
        capability: proposal.action,
        tenant: proposal.tenant_id,
        status: "skipped",
        detail: safeErrorMessage(error),
      });
    }
  }

  const summary = {
    selected: selected.length,
    applied: results.filter((result) => result.status === "applied").length,
    conflict: results.filter((result) => result.status === "conflict").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    filters: { capability: capability ?? null, tenant: tenant ?? null, max: max ?? null },
    results,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatBatchApplySummary(summary));
  }
  return summary.skipped > 0 ? 1 : 0;
}
