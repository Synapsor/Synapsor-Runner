import path from "node:path";
import { createSemanticActionVerifier } from "@synapsor-runner/action-rules";
import { createDelegatedSemanticExecutor, OwnerRuntimeError, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest, parseWritebackJob, parseWritebackResult, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import type { ApplyAdapter, RunnerConfig } from "@synapsor-runner/worker-core";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";
import { openBoundProjectControlPolicies, assertProjectControlPolicyBinding } from "./control-policy-store.js";
import { operationalLog } from "./cli-logging.js";

/** One trusted database adapter invocation. Policy admission runs inside the
 * adapter's source transaction; accounting follows its actual durable receipt.
 * Existing source receipts can still reconcile after revocation, but cannot
 * authorize another mutation. Never expose this function as a model tool. */
export async function applyRuntimeDatabaseJob(input: {
  job: WritebackJob; runnerConfig: RunnerConfig; runtimeConfig?: RuntimeConfig;
  configPath?: string; adapter: ApplyAdapter; env?: NodeJS.ProcessEnv;
}): Promise<WritebackResult> {
  const selected = input.runtimeConfig?.action_rules?.owner_delegation;
  if (!selected) return input.adapter.apply(input.job, input.runnerConfig);
  // Snapshot before opening the store: delegation and the source transaction
  // must use the same approved-proposal scope even if the caller mutates config.
  const runnerConfig = { ...input.runnerConfig, databaseScope: structuredClone(input.runnerConfig.databaseScope) };
  const parentName = selected.parent_name;
  const job = parseWritebackJob(input.job);
  if (job.protocol_version !== "5.0" || !job.semantic_authority.proof.delegation) throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
  const configuredRoot = input.runtimeConfig?.action_rules?.project_root;
  if (!configuredRoot || !input.configPath) throw new OwnerRuntimeError("DELEGATION_POLICY_STORE_REQUIRED");
  const root = path.resolve(path.dirname(path.resolve(input.configPath)), configuredRoot);
  const binding = await openBoundProjectControlPolicies(root, input.env);
  if (!binding) throw new OwnerRuntimeError("DELEGATION_POLICY_STORE_REQUIRED");
  const read = createActiveActionRuleAuthorityLoader(root, binding);
  const registry = async () => {
    await assertProjectControlPolicyBinding(root, binding);
    return (await read({ dependency_check: "report" })).registry;
  };
  const attempt = createDelegatedSemanticExecutor({ repository: binding.repository, deployment_id: binding.deployment_id,
    parent_name: parentName, resolveRules: async () => (await registry()).rules.map((rule) => rule.compiled) }).forJob(job, runnerConfig.databaseScope);
  const verifier = createSemanticActionVerifier({ registry, check_delegation: attempt.check });
  const account = async (state: "completed" | "no_effect" | "unknown", receipt: string) => {
    try { await attempt.record({ state, receipt_digest: receipt }); }
    catch {
      // A source commit must not be reported as failed because the separate
      // control store is unavailable. Its reservation remains held for replay.
      operationalLog("warn", "delegated_effect_accounting_pending", { proposal_id: job.proposal_id,
        source_state: state, recovery: "reconcile_exact_source_receipt", capacity_released: false });
    }
  };
  try {
    const result = parseWritebackResult(await input.adapter.apply(job, { ...runnerConfig, semanticActionVerifier: verifier }));
    if (runnerConfig.dryRun) return result;
    if (result.protocol_version !== "5.0" || result.job_id !== job.job_id || result.operation !== job.operation) {
      throw new OwnerRuntimeError("DELEGATION_SOURCE_RECEIPT_INVALID");
    }
    if (attempt.wasDispatched() || result.status === "already_applied") {
      const completed = (result.status === "applied" || result.status === "already_applied")
        && result.semantic_verification.proof_digest === job.semantic_authority.proof.proof_digest
        && result.semantic_verification.effect_digest === job.semantic_authority.effect.effect_digest;
      const state = completed ? "completed" : ["conflict", "canceled"].includes(result.status) && result.affected_rows === 0 ? "no_effect" : "unknown";
      await account(state, canonicalJsonDigest({ effect: job.semantic_authority.effect.effect_digest,
        result: result.result_hash ?? canonicalJsonDigest(result) }));
    }
    return result;
  } catch (error) {
    if (attempt.wasDispatched() && !runnerConfig.dryRun) await account("unknown", canonicalJsonDigest({
      job: canonicalJsonDigest(job), status: "source_outcome_unknown" }));
    throw error;
  } finally {
    await binding.close().catch(() => operationalLog("warn", "delegated_policy_connection_cleanup_pending", {
      proposal_id: job.proposal_id, authority_changed: false }));
  }
}
