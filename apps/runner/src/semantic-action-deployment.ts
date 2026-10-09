import { inspectReviewedHardLimitWriterSetup, assertReviewedHardLimitWriterSetup, HardLimitWriterReviewChangedError,
  type HardLimitWriterReviewBinding, type HardLimitWriterReviewContext } from "./hard-limit-writer-review-binding.js";
export type { HardLimitWriterReviewBinding } from "./hard-limit-writer-review-binding.js";
import { projectHardLimitActivationWriterSelections } from "./hard-limit-writer-selection.js";
import { inspectHardLimitWriterSetup, assertHardLimitWriterSetup, type HardLimitWriterSetupReadback } from "./hard-limit-writer-setup.js";
import { assessActionWithdrawal } from "./action-rule-withdrawal.js";
import { SEMANTIC_ACTION_RUNTIME_CONFIG, executionConfigForReview, readSemanticSupervisedExecutionState, type SemanticSupervisedExecutionState } from "./semantic-execution-state.js";
export { SEMANTIC_ACTION_RUNTIME_CONFIG, readSemanticSupervisedExecutionState, type SemanticSupervisedExecutionState } from "./semantic-execution-state.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { assertCompleteSelectedActionProgram } from "./saved-action-job-review.js";
import fs from "node:fs/promises";
import { inspectSemanticReceiptSetup, selectedSemanticReceipts, type SemanticReceiptMode } from "./semantic-receipt-setup.js";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import {
  loadRuntimeConfigFromFile,
  resolveRuntimeConfig,
  resolveSemanticSupervisedWriterSource,
  type RuntimeConfig,
  type RuntimeSupervisedWorkerOutcomePolicy,
} from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseActionRuleAuthority } from "@synapsor-runner/action-rules";
import {
  inspectDatabase,
  rolePostureFingerprint,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import process from "node:process";
import {
  activateActionRuleAuthority,
  createActiveActionRuleAuthorityLoader,
  loadActiveActionRuleAuthority,
  readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft,
  parseStoredActionRuleAuthority,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";
import { actionRuleCollectionReadiness } from "./action-rule-collection-readiness.js";
import { actionRuleRlsReadiness } from "./action-rule-rls-readiness.js";
import { compareGenerationLock, loadGenerationLockForActivatedBoundary, generationLockRemediation,
  loadActivatedExplorationBoundaries, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { bindSemanticReadScope, bindSemanticReviewedReadScope } from "./semantic-action-read-scope.js";
import { SemanticWriterPostureError } from "./semantic-execution-setup.js";
import { writerProvisioningPlan } from "./writer-provisioning.js";
import { encodeOperatorExecutionPolicy, parseOperatorExecutionPolicy } from "./control-policy-execution.js";
import { OPERATOR_EXECUTION_POLICY_KEY, assertOperatorPolicyRecord } from "./control-policy-record.js";
import { openBoundProjectControlPolicies, openProjectControlPolicies,
  type BoundProjectPolicyStore } from "./control-policy-store.js";
import { assertNoPendingPolicyConfiguration, publishPolicyConfiguration, recoverPolicyConfiguration } from "./control-policy-config-publication.js";


/** A dedicated credential reference is stable across rule and database reviews. */
export function semanticDedicatedWriterEnvironment(outcome: string): string {
  const label = outcome.replace(/[^a-z0-9]/giu, "_").toUpperCase().slice(0, 48);
  return `SYNAPSOR_WRITE_${label}_${canonicalJsonDigest({ outcome }).slice(7, 15).toUpperCase()}`;
}

function assertSeparateWriterConnection(readUrlEnv: string | undefined, writeUrlEnv: string, env: NodeJS.ProcessEnv): void {
  if (readUrlEnv && (writeUrlEnv === readUrlEnv || (stringValue(env[writeUrlEnv])
    && stringValue(env[readUrlEnv]) === stringValue(env[writeUrlEnv])))) {
    throw new Error("SEMANTIC_ACTION_WRITER_READER_CONNECTION: The selected write connection is the saved reader. Keep the read connection unchanged; choose a separate write credential or prepare administrator instructions for this action. No writer was inspected and execution was not enabled.");
  }
}

export type SemanticActionRuntimeActivation = {
  activation: ActionRuleAuthorityActivationV1;
  config_path: string;
  config_changed: boolean;
};

export type SemanticSupervisedExecutionPreview = {
  outcome: string;
  action_boundary_digest: `sha256:${string}`;
  config_path: string;
  current_config_digest: `sha256:${string}`;
  profile: "development" | "staging" | "production";
  source: string;
  target: string;
  operation: "insert" | "update";
  write_url_env: string;
  writer_role: string;
  writer_posture_fingerprint: `sha256:${string}`;
  allowed_relations: string[];
  verification: {
    writer: import("./worker-policy.js").SupervisedWriterPostureAssessment;
    receipt_probe: "passed_rolled_back" | "not_run_runner_ledger";
  };
  receipts: SemanticReceiptMode;
  policy: RuntimeSupervisedWorkerOutcomePolicy;
  config: Record<string, unknown>;
  policy_epoch?: number;
};

/**
 * A complete Action Boundary digest binds every supervised outcome. Retain no
 * execution authority across a replacement: this only identifies the current
 * outcomes an operator must separately review after activation.
 */
export function executionReReviewOutcomesForActionActivation(input: {
  active?: ActionRuleAuthorityActivationV1;
  draft: ActionRuleAuthorityDraftV1;
  execution: SemanticSupervisedExecutionState;
}): string[] {
  if (!input.active || !input.execution.enabled
    || input.active.authority.action_boundary.digest === input.draft.authority.action_boundary.digest) return [];
  const nextExecutable = new Set(input.draft.authority.action_boundary.rules
    .filter((rule) => rule.writeback.mode === "direct_sql" && rule.writeback.supervised_worker === "allowed")
    .map((rule) => rule.outcome));
  return [...new Set(input.execution.policies
    .filter((policy) => policy.action_boundary_digest === input.active!.authority.action_boundary.digest
      && nextExecutable.has(policy.outcome))
    .map((policy) => policy.outcome))].sort();
}

const DEFAULT_SEMANTIC_WORKER_LIMITS = {
  concurrency: 1,
  queue_limit: 100,
  lease_seconds: 300,
  max_attempts: 5,
  proposal_ttl_seconds: 86_400,
  rate_limit: { executions: 60, window_seconds: 60 },
} as const;

/** Bounded native metadata/lock prerequisite check. The candidate config stays in memory and cannot enable execution. */
export async function inspectDraftSemanticWriter(input: {
  draft: Pick<ActionRuleAuthorityDraftV1, "authority" | "digest">;
  reads: Parameters<typeof bindSemanticReviewedReadScope>[2];
  engine: "postgres" | "mysql";
  readUrlEnv: string;
  writeUrlEnv?: string;
  outcome?: string;
  requirementsOnly?: boolean;
  receipts?: SemanticReceiptMode;
  env?: NodeJS.ProcessEnv;
  inspect?: typeof inspectDatabase;
}) {
  const { authority, registry } = parseActionRuleAuthority(input.draft.authority, input.draft.digest);
  const executable = registry.rules.filter(({ compiled }) => (!input.outcome || compiled.outcome === input.outcome)
    && compiled.effect_envelope.writeback.mode === "direct_sql"
    && compiled.effect_envelope.writeback.supervised_worker === "allowed");
  if (!executable.length) return undefined;
  const writeUrlEnv = environmentName(input.writeUrlEnv ?? "SYNAPSOR_DATABASE_WRITE_URL");
  const env = input.env ?? process.env;
  const writerConfigured = Boolean(stringValue(env[writeUrlEnv])) && !input.requirementsOnly;
  if (writerConfigured) assertSeparateWriterConnection(environmentName(input.readUrlEnv), writeUrlEnv, env);
  const inspectionEnv = writerConfigured ? writeUrlEnv : environmentName(input.readUrlEnv);
  if (!stringValue(env[inspectionEnv])) throw new Error("SEMANTIC_ACTION_WRITER_URL_MISSING: no selected writer or read connection is available to inspect administrator requirements. Restore the read connection and resume this saved job.");
  // A single configured writer is checked against the complete planned bundle.
  // Actual per-outcome deployment still rechecks its selected credential separately.
  const sources = Object.fromEntries(executable.map(({ compiled }) => [compiled.source, {
    engine: input.engine, read_url_env: environmentName(input.readUrlEnv), write_url_env: writeUrlEnv,
    read_only: false, receipts: input.receipts ?? { authority: "runner_ledger" },
  }]));
  if (Object.keys(sources).length !== 1) throw new Error("SEMANTIC_ACTION_WRITER_SOURCE_MISMATCH: select and verify a writer for each source during execution setup.");
  const outcomes = new Set(executable.map(({ compiled }) => compiled.outcome));
  const scoped = bindSemanticReviewedReadScope({ version: 1, mode: "review", sources },
    authority.rules.filter((rule) => outcomes.has(rule.rule.outcome)), input.reads);
  const inspection = await (input.inspect ?? inspectDatabase)({ engine: input.engine,
    databaseUrlEnv: inspectionEnv, statementTimeoutMs: 5_000, env });
  if (inspection.engine !== input.engine) throw new Error("SEMANTIC_ACTION_WRITER_ENGINE_MISMATCH: the writer must connect to the reviewed database engine.");
  const fingerprint = rolePostureFingerprint(inspection);
  const policies: RuntimeSupervisedWorkerOutcomePolicy[] = executable.map(({ compiled }) => ({
    outcome: compiled.outcome, action_boundary_digest: authority.action_boundary.digest,
    mode: "supervised_worker", ...DEFAULT_SEMANTIC_WORKER_LIMITS, write_url_env: writeUrlEnv,
    require_least_privilege_writer: true, writer_posture_fingerprint: fingerprint,
  }));
  const candidate: RuntimeConfig = { ...scoped, version: 1, mode: "review",
    supervised_worker: { enabled: false, profile: "development", capabilities: [], outcomes: policies } };
  const hardLimitSetup = await inspectHardLimitWriterSetup({ registry, config: candidate, env: writerConfigured ? env : {}, outcome: input.outcome });
  const checked = assessSemanticSupervisedWriterPosture(candidate, policies[0]!, registry, inspection);
  const collectionIssues = executable.flatMap(({ compiled }) => actionRuleCollectionReadiness({ compiled, inspection,
    source: candidate.sources![compiled.source]!, connection: writerConfigured ? "writer" : "reader" }));
  const rlsIssues = executable.flatMap(({ compiled }) => actionRuleRlsReadiness({ compiled, inspection,
    source: candidate.sources![compiled.source]!, connection: writerConfigured ? "writer" : "reader" }));
  // Reader evidence establishes requirements, never the writer's readiness.
  if (hardLimitSetup.status === "refused" && writerConfigured) { checked.ok = false; checked.reasons.push("hard_limit_writer_setup_unproven"); }
  const assessment = writerConfigured ? checked : { ...checked, ok: false,
    reasons: ["writer_connection_not_checked"], relation_issues: [] };
  const plan = writerProvisioningPlan({ assessment, inspection, outcome: policies[0]!.outcome,
    outcomes: policies.map((policy) => policy.outcome),
    hardLimitNamespace: executable.some(({ compiled }) => Boolean(compiled.hard_limit)),
    actionDigest: authority.action_boundary.digest, writerEnv: writeUrlEnv, readEnv: input.readUrlEnv,
    ...(input.receipts?.authority === "source_db" ? { receiptSetup: { schema: input.receipts.schema, table: input.receipts.table } } : {}) });
  return { assessment, hard_limit_setup: hardLimitSetup, outcomes: policies.map((policy) => policy.outcome),
    receipt_status: input.receipts ? "selected_not_verified" as const : "selection_required" as const,
    writer_status: writerConfigured ? "checked" as const : "not_checked" as const,
    inspected_connection_env: inspectionEnv,
    action_digest: authority.action_boundary.digest, collection_issues: collectionIssues, rls_issues: rlsIssues, ...(plan ? { plan } : {}) };
}

/** Derive an administrator handoff from the exact saved rule, without a writer
 * credential, execution authorization, or a source-row query. */
export async function prepareSemanticWriterHandoff(input: {
  projectRoot: string; outcome: string;
  reads: Parameters<typeof bindSemanticReviewedReadScope>[2];
  writeUrlEnv?: string; env?: NodeJS.ProcessEnv; inspect?: typeof inspectDatabase;
}) {
  const active = await executionReviewActionAuthority(input.projectRoot, input.env, { outcome: input.outcome });
  const rule = active.registry.rules.find((entry) => entry.compiled.outcome === input.outcome);
  if (!rule) throw new Error("SEMANTIC_ACTION_OUTCOME_NOT_ACTIVE: the saved outcome is not available for execution review.");
  const configPath = path.join(input.projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG);
  const review = await executionConfigForReview(input.projectRoot, configPath, await readJsonObject(configPath), undefined, input.env);
  const source = currentConfigSource(review.config, rule.compiled.source);
  if (typeof source.read_url_env !== "string") throw new Error("SEMANTIC_ACTION_SOURCE_CONFIG_MISSING: restore the saved read connection before preparing administrator instructions.");
  const config = resolveRuntimeConfig(review.config as RuntimeConfig, input.projectRoot);
  const requestedEnv = input.writeUrlEnv;
  const usedByAnother = config.supervised_worker?.outcomes?.some((policy) => policy.outcome !== input.outcome
    && policy.write_url_env === requestedEnv);
  const writeUrlEnv = requestedEnv && !usedByAnother && requestedEnv !== source.read_url_env
    ? requestedEnv : semanticDedicatedWriterEnvironment(input.outcome);
  const receiptSetup = await inspectSemanticReceiptSetup({ projectRoot: input.projectRoot, configPath, outcome: input.outcome, env: input.env });
  const receipts = receiptSetup?.epoch !== undefined ? selectedSemanticReceipts(receiptSetup, writeUrlEnv) : undefined;
  const result = await inspectDraftSemanticWriter({ draft: active.activation, reads: input.reads, receipts,
    engine: source.engine, readUrlEnv: source.read_url_env, writeUrlEnv,
    outcome: input.outcome, requirementsOnly: true, env: input.env, inspect: input.inspect });
  if (!result?.plan) throw new Error("SEMANTIC_ACTION_WRITER_HANDOFF_UNAVAILABLE: complete administrator instructions could not be derived for this database. Exact execution requirements remain available; no grant or execution was enabled.");
  return { ...result, plan: result.plan };
}

type ActivationWriterCandidateInput = {
  projectRoot: string; baseConfigPath?: string; outputConfigPath?: string;
  draft: ActionRuleAuthorityDraftV1; env?: NodeJS.ProcessEnv;
};

/** One projection for the shown readback and the held publication check. */
async function activationWriterCandidate(input: ActivationWriterCandidateInput, permit?: ProjectAuthorityMutationPermit) {
  const projectRoot = await fs.realpath(input.projectRoot);
  const draft = parseStoredActionRuleAuthority(input.draft);
  const registry = parseActionRuleAuthority(draft.authority, draft.digest).registry;
  const outputConfigPath = path.resolve(input.outputConfigPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG));
  assertContainedProjectPath(projectRoot, outputConfigPath);
  const previous = await readOptionalText(outputConfigPath);
  const sourceConfigPath = previous === undefined ? path.resolve(input.baseConfigPath ?? path.join(projectRoot, "synapsor.runner.json")) : outputConfigPath;
  assertContainedProjectPath(projectRoot, sourceConfigPath);
  const sourceConfigText = await fs.readFile(sourceConfigPath, "utf8");
  const raw = await readJsonObject(sourceConfigPath);
  const binding = await openBoundProjectControlPolicies(projectRoot, input.env);
  try {
    const before = binding ? await binding.repository.deployment(binding.deployment_id) : undefined;
    if (binding && !before) throw new HardLimitWriterReviewChangedError();
    const review = await executionConfigForReview(projectRoot, sourceConfigPath, raw, binding, input.env);
    if (before && review.epoch !== before.epoch) throw new HardLimitWriterReviewChangedError();
    const sourceConfig = await projectHardLimitActivationWriterSelections({ projectRoot,
      config: review.config as RuntimeConfig, registry, authorityDigest: draft.digest, env: input.env, permit });
    const nextConfig = bindSemanticReadScope(semanticActionRuntimeConfig({ projectRoot, sourceConfigPath, outputConfigPath,
      sourceConfig, draft, preserveActionRuntime: previous !== undefined }), draft.authority.rules,
      await loadActivatedExplorationBoundaries(projectRoot, binding));
    const after = binding ? await binding.repository.deployment(binding.deployment_id) : undefined;
    if (before && (!after || after.epoch !== before.epoch)) throw new HardLimitWriterReviewChangedError();
    if (await fs.readFile(sourceConfigPath, "utf8") !== sourceConfigText
      || await readOptionalText(outputConfigPath) !== previous) throw new HardLimitWriterReviewChangedError();
    const reviewContext: HardLimitWriterReviewContext = { projectRoot, sourceConfigPath, outputConfigPath,
      sourceConfigText, previousConfigText: previous, draft,
      executionReview: { digest: review.digest, ...(review.epoch === undefined ? {} : { epoch: review.epoch }) },
      ...(binding && before ? { nativePolicy: { project_id: binding.project_id, deployment_id: binding.deployment_id, epoch: before.epoch } } : {}) };
    return { registry, nextConfig, config: resolveRuntimeConfig(nextConfig as RuntimeConfig, path.dirname(outputConfigPath)), reviewContext };
  } finally { await binding?.close(); }
}

async function assertActivationWriterContextCurrent(context: HardLimitWriterReviewContext, env?: NodeJS.ProcessEnv): Promise<void> {
  const binding = await openBoundProjectControlPolicies(context.projectRoot, env);
  try {
    const current = binding ? await binding.repository.deployment(binding.deployment_id) : undefined;
    if (context.nativePolicy ? !binding || !current || binding.project_id !== context.nativePolicy.project_id
      || binding.deployment_id !== context.nativePolicy.deployment_id || current.epoch !== context.nativePolicy.epoch : binding !== undefined) {
      throw new HardLimitWriterReviewChangedError();
    }
    if (await fs.readFile(context.sourceConfigPath, "utf8") !== context.sourceConfigText
      || await readOptionalText(context.outputConfigPath) !== context.previousConfigText) throw new HardLimitWriterReviewChangedError();
  } finally { await binding?.close(); }
}

export type SemanticActionActivationWriterSetupReadback = HardLimitWriterSetupReadback & {
  writerReviewBinding?: HardLimitWriterReviewBinding;
};
/** Pre-approval readback and ephemeral identity from the same checked candidate. */
export async function inspectSemanticActionActivationWriterSetup(input: ActivationWriterCandidateInput): Promise<SemanticActionActivationWriterSetupReadback> {
  const registry = parseActionRuleAuthority(input.draft.authority, input.draft.digest).registry;
  if (!registry.rules.some(({ compiled }) => compiled.hard_limit)) return inspectHardLimitWriterSetup({ registry, config: { version: 1, mode: "review" }, env: input.env });
  const env = { ...(input.env ?? process.env) };
  const candidate = await activationWriterCandidate({ ...input, env });
  const readback = await inspectReviewedHardLimitWriterSetup({ ...candidate, env });
  await assertActivationWriterContextCurrent(candidate.reviewContext, env);
  return readback;
}

/**
 * Publishes the separate Action runtime binding before the immutable authority
 * pointer. The intermediate state is deliberately under-authorized: a config
 * without an active authority exposes no semantic Action tools.
 */
export async function activateSemanticActionRuntime(input: {
  projectRoot: string;
  baseConfigPath?: string;
  outputConfigPath?: string;
  draft: ActionRuleAuthorityDraftV1;
  actor: string;
  now?: string;
  env?: NodeJS.ProcessEnv;
  /** Exact local withdrawal preview, never a model-supplied bypass. */
  withdrawalContext?: string;
  /** Ephemeral host readback identity carried through the operator confirmation. */
  writerReviewBinding?: HardLimitWriterReviewBinding;
}): Promise<SemanticActionRuntimeActivation> {
  const draft = parseStoredActionRuleAuthority(input.draft);
  if (draft.state !== "disabled") throw new Error("ACTION_RULE_DRAFT_REQUIRED: review a disabled Action revision before activation.");
  return withProjectRuntimeAdmission(input.projectRoot, root => withProjectAuthorityMutation(root, (permit) => activateSemanticActionRuntimeUnlocked({ ...input,
    draft,
    projectRoot: permit.projectRoot,
    ...(input.baseConfigPath === undefined ? {} : { baseConfigPath: projectPathAfterLock(input.baseConfigPath, input.projectRoot, permit.projectRoot) }),
    ...(input.outputConfigPath === undefined ? {} : { outputConfigPath: projectPathAfterLock(input.outputConfigPath, input.projectRoot, permit.projectRoot) }),
  }, permit)));
}

async function activateSemanticActionRuntimeUnlocked(input: Parameters<typeof activateSemanticActionRuntime>[0],
  permit: ProjectAuthorityMutationPermit): Promise<SemanticActionRuntimeActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  const withdrawal = input.withdrawalContext ? await assessActionWithdrawal({ projectRoot, draft: input.draft,
    env: input.env, baseConfigPath: input.baseConfigPath, outputConfigPath: input.outputConfigPath,
    expected_context_digest: input.withdrawalContext, permit }) : undefined;
  if (!withdrawal) await assertCompleteSelectedActionProgram({ projectRoot, draft: input.draft, env: input.env, permit });
  const outputConfigPath = path.resolve(
    input.outputConfigPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, outputConfigPath);
  await assertNoPendingPolicyConfiguration(projectRoot, outputConfigPath);
  const baseConfigPath = path.resolve(
    input.baseConfigPath ?? path.join(projectRoot, "synapsor.runner.json"),
  );
  const previous = await readOptionalText(outputConfigPath);
  const sourceConfigPath = previous === undefined ? baseConfigPath : outputConfigPath;
  const rawSourceConfig = await readJsonObject(sourceConfigPath);
  const parsedDraft = parseActionRuleAuthority(input.draft.authority, input.draft.digest);
  const writerCandidate = !withdrawal && parsedDraft.registry.rules.some(({ compiled }) => compiled.hard_limit)
    ? await activationWriterCandidate(input, permit) : undefined;
  if (writerCandidate && writerCandidate.reviewContext.previousConfigText !== previous) throw new HardLimitWriterReviewChangedError();
  const sourceConfig = rawSourceConfig;
  const binding = await openBoundProjectControlPolicies(projectRoot, input.env);
  try {
    const nextConfig = writerCandidate?.nextConfig ?? bindSemanticReadScope(semanticActionRuntimeConfig({
      projectRoot,
      sourceConfigPath,
      outputConfigPath,
      sourceConfig,
      draft: input.draft,
      preserveActionRuntime: previous !== undefined,
    }), input.draft.authority.rules, await loadActivatedExplorationBoundaries(projectRoot, binding));
    await validateRuntimeConfig(nextConfig, outputConfigPath);
    if (!withdrawal) {
      if (writerCandidate && input.writerReviewBinding) await assertReviewedHardLimitWriterSetup({ ...writerCandidate,
        env: input.env }, input.writerReviewBinding);
      else await assertHardLimitWriterSetup({ registry: parsedDraft.registry,
        config: resolveRuntimeConfig(nextConfig as RuntimeConfig, path.dirname(outputConfigPath)), env: input.env });
      if (writerCandidate) await assertActivationWriterContextCurrent(writerCandidate.reviewContext, input.env);
    }
    const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    const configChanged = nextText !== previous;
    if (binding) {
      const resolved = resolveRuntimeConfig(nextConfig as RuntimeConfig, path.dirname(outputConfigPath));
      const selected = await openProjectControlPolicies({ projectRoot, config: resolved, env: input.env,
        storePath: path.resolve(path.dirname(outputConfigPath), resolved.storage?.sqlite_path ?? ".synapsor/local.db") });
      await selected?.close();
      const activation = await activateActionRuleAuthority({ clientContract: "four_tool", projectRoot, name: input.draft.authority.name,
        expected_digest: input.draft.digest, confirmation: `ACTIVATE ${input.draft.digest}`, actor: input.actor, ...{ env: input.env },
        mutationPermit: permit, ...(withdrawal ? { withdrawal } : {}), ...(input.now ? { now: input.now } : {}),
        runtimePublication: { binding, configPath: outputConfigPath, before: previous, after: nextText } });
      return { activation, config_path: projectRelativePath(projectRoot, outputConfigPath), config_changed: configChanged };
    }
    if (configChanged) await writePrivateTextAtomic(outputConfigPath, nextText);
    try {
      const activation = await activateActionRuleAuthority({
        clientContract: "four_tool", projectRoot,
        name: input.draft.authority.name,
        expected_digest: input.draft.digest,
        confirmation: `ACTIVATE ${input.draft.digest}`,
        actor: input.actor, ...{ env: input.env },
        mutationPermit: permit,
        ...(withdrawal ? { withdrawal } : {}),
        ...(input.now ? { now: input.now } : {}),
      });
      return { activation, config_path: projectRelativePath(projectRoot, outputConfigPath), config_changed: configChanged };
    } catch (error) {
      if (configChanged) {
        if (previous === undefined) await fs.rm(outputConfigPath, { force: true }).catch(() => undefined);
        else await writePrivateTextAtomic(outputConfigPath, previous).catch(() => undefined);
      }
      throw error;
    }
  } finally { await binding?.close(); }
}

/** Operator review recovery only. Reload saved state after settling the exact
 * earlier attempt, including a committed activation whose draft was removed. */
export async function recoverSemanticActionRuntime(input: {
  projectRoot: string; configPath?: string; draftName?: string; env?: NodeJS.ProcessEnv;
}): Promise<{ state: "none" | "committed" | "cancelled";
  authority?: { active?: ActionRuleAuthorityActivationV1; draft?: ActionRuleAuthorityDraftV1 };
  readBoundaries?: ActivatedExplorationBoundary[] }> {
  return withProjectAuthorityMutation(input.projectRoot, async (held) => {
    const configPath = input.configPath === undefined ? path.join(held.projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG)
      : projectPathAfterLock(input.configPath, input.projectRoot, held.projectRoot);
    const recovery = await recoverPolicyConfiguration({ projectRoot: held.projectRoot, configPath,
      env: input.env, mutationPermit: held });
    const binding = await openBoundProjectControlPolicies(held.projectRoot, input.env);
    if (!binding) return recovery;
    try {
      const before = await binding.repository.deployment(binding.deployment_id);
      const authority = { active: await readActionRuleAuthorityActivation(held.projectRoot, binding),
        draft: input.draftName ? await readActionRuleAuthorityDraft(held.projectRoot, input.draftName, binding) : undefined };
      const readBoundaries = await loadActivatedExplorationBoundaries(held.projectRoot, binding).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      if ((await binding.repository.deployment(binding.deployment_id))?.epoch !== before?.epoch) {
        throw Object.assign(new Error("POLICY_REVISION_CONFLICT: authority changed during recovery review. Reopen the current review."), { code: "POLICY_REVISION_CONFLICT" });
      }
      return { ...recovery, authority, readBoundaries };
    } finally { await binding.close(); }
  });
}

/** Repair only omitted, already-authorized RLS wiring on a guided resume. */
export async function restoreReviewedSemanticReadScope(projectRoot: string): Promise<boolean> {
  // Read-only handoffs need no Action config or writer state. If one appears
  // after this check, a later repair can inspect it; this invocation writes nothing.
  const configPath = path.join(path.resolve(projectRoot), SEMANTIC_ACTION_RUNTIME_CONFIG);
  if (await readOptionalText(configPath) === undefined) return false;
  return withProjectAuthorityMutation(projectRoot, (held) => restoreReviewedSemanticReadScopeUnlocked(held.projectRoot));
}

async function restoreReviewedSemanticReadScopeUnlocked(projectRoot: string): Promise<boolean> {
  const configPath = path.join(path.resolve(projectRoot), SEMANTIC_ACTION_RUNTIME_CONFIG);
  await assertNoPendingPolicyConfiguration(projectRoot, configPath);
  const previous = await readOptionalText(configPath);
  if (previous === undefined) return false;
  const config = JSON.parse(previous) as Record<string, unknown>;
  if (!isRecord(config.action_rules)) return false;
  // A configured runtime can precede activation or coexist with legacy actions.
  // Only absence is a no-op; malformed revisions and stale Read bindings still fail.
  if (await readActionRuleAuthorityActivation(projectRoot) === undefined) return false;
  const active = await loadActiveActionRuleAuthority(projectRoot);
  const next = bindSemanticReadScope(config, active.authority.rules, await loadActivatedExplorationBoundaries(projectRoot));
  if (canonicalJsonDigest(next) === canonicalJsonDigest(config)) return false;
  await validateRuntimeConfig(next, configPath);
  await writePrivateTextAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/**
 * Inspects the separately configured writer and prepares, but does not save,
 * one exact semantic worker allowlist entry. The connection value never enters
 * the returned config or operator review record.
 */
export async function previewSemanticSupervisedExecution(input: {
  projectRoot: string;
  outcome: string;
  profile: "development" | "staging" | "production";
  configPath?: string;
  writeUrlEnv?: string;
  workerIdentity?: string;
  delayedWork?: NonNullable<RuntimeSupervisedWorkerOutcomePolicy["delayed_work"]>;
  env?: NodeJS.ProcessEnv;
  inspect?: typeof inspectDatabase;
}): Promise<SemanticSupervisedExecutionPreview> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.resolve(
    input.configPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, configPath);
  await recoverPolicyConfiguration({ projectRoot, configPath, env: input.env });
  const active = await executionReviewActionAuthority(projectRoot, input.env, { outcome: input.outcome });
  const activated = active.registry.rules.find((candidate) => candidate.compiled.outcome === input.outcome);
  if (!activated) {
    throw new Error(`SEMANTIC_ACTION_OUTCOME_NOT_ACTIVE: ${input.outcome} is not in the active verified Action Boundary.`);
  }
  if (activated.compiled.effect_envelope.writeback.mode !== "direct_sql"
    || activated.compiled.effect_envelope.writeback.supervised_worker !== "allowed") {
    throw new Error(
      `SEMANTIC_ACTION_EXECUTION_NOT_REVIEWED: ${input.outcome} permits proposals only; create and activate a replacement rule before enabling a worker.`,
    );
  }
  const writeUrlEnv = environmentName(input.writeUrlEnv ?? "SYNAPSOR_DATABASE_WRITE_URL");
  const env = input.env ?? process.env;
  if (!stringValue(env[writeUrlEnv])) {
    throw new Error(
      `SEMANTIC_ACTION_WRITER_URL_MISSING: ${writeUrlEnv} is not set. Export the separate least-privilege writer URL, then review this execution step again.`,
    );
  }
  const currentText = await readOptionalText(configPath);
  if (currentText === undefined) {
    throw new Error(
      `SEMANTIC_ACTION_CONFIG_REQUIRED: activate proposal authority first so ${projectRelativePath(projectRoot, configPath)} can be reviewed for execution.`,
    );
  }
  const currentReview = await executionConfigForReview(projectRoot, configPath, await readJsonObject(configPath), undefined, env);
  const currentConfig = currentReview.config;
  const source = currentConfigSource(currentConfig, activated.compiled.source);
  assertSeparateWriterConnection(stringValue(source.read_url_env), writeUrlEnv, env);
  const inspection = await (input.inspect ?? inspectDatabase)({
    engine: source.engine as "postgres" | "mysql",
    databaseUrlEnv: writeUrlEnv,
    statementTimeoutMs: positiveInteger(source.statement_timeout_ms) ?? 5_000,
    env,
  });
  if (inspection.engine !== source.engine) {
    throw new Error(
      `SEMANTIC_ACTION_WRITER_ENGINE_MISMATCH: ${writeUrlEnv} resolved to ${inspection.engine}, but ${activated.compiled.source} is ${String(source.engine)}.`,
    );
  }
  const receiptSetup = await inspectSemanticReceiptSetup({ projectRoot, configPath, outcome: input.outcome, env });
  const receipts = receiptSetup?.epoch !== undefined ? selectedSemanticReceipts(receiptSetup, writeUrlEnv) : undefined;
  if (input.delayedWork && (source.engine !== "postgres"
    || receipts?.authority !== "source_db" || receipts.provisioning !== "precreated")) {
    throw new Error("DELAYED_WORK_UNSUPPORTED: delayed execution requires PostgreSQL and an exact reviewed precreated source receipt.");
  }
  const fingerprint = rolePostureFingerprint(inspection);
  const nextConfig = semanticSupervisedExecutionConfig({
    sourceConfig: currentConfig,
    receipts,
    activation: active.activation,
    outcome: input.outcome,
    profile: input.profile,
    writeUrlEnv,
    writerPostureFingerprint: fingerprint,
    ...(input.workerIdentity ? { workerIdentity: input.workerIdentity } : {}),
    ...(input.delayedWork ? { delayedWork: input.delayedWork } : {}),
  });
  const policy = semanticWorkerOutcomePolicy(nextConfig, input.outcome);
  const assessment = assessSemanticSupervisedWriterPosture(
    nextConfig as RuntimeConfig,
    policy,
    active.registry,
    inspection,
  );
  const otherPolicies = (nextConfig.supervised_worker as RuntimeConfig["supervised_worker"])?.outcomes
    ?.filter((entry) => entry.outcome !== policy.outcome && entry.write_url_env === writeUrlEnv) ?? [];
  if (otherPolicies.some((entry) => entry.writer_posture_fingerprint !== fingerprint)) {
    assessment.ok = false;
    assessment.reasons.push("writer_shared_connection_changed");
  }
  if (!assessment.ok) {
    // Recovery provisions one dedicated credential, not a replacement for a
    // shared connection. Its grant envelope must survive unrelated re-review.
    const dedicatedConfig = { ...nextConfig, supervised_worker: {
      ...(nextConfig.supervised_worker as RuntimeConfig["supervised_worker"]), outcomes: [policy],
    } } as RuntimeConfig;
    const dedicated = assessSemanticSupervisedWriterPosture(dedicatedConfig, policy, active.registry, inspection);
    throw new SemanticWriterPostureError(assessment, writeUrlEnv, writerProvisioningPlan({ assessment: dedicated, inspection,
      hardLimitNamespace: Boolean(activated.compiled.hard_limit),
      outcome: input.outcome, outcomes: [input.outcome], actionDigest: active.authority.action_boundary.digest,
      writerEnv: semanticDedicatedWriterEnvironment(input.outcome),
      readEnv: typeof source.read_url_env === "string" ? source.read_url_env : undefined,
      ...(receipts?.authority === "source_db" ? { receiptSetup: { schema: receipts.schema, table: receipts.table } } : {}) }));
  }
  await assertHardLimitWriterSetup({ registry: active.registry, config: nextConfig as RuntimeConfig, env, outcome: input.outcome });
  const selectedSource = resolveSemanticSupervisedWriterSource(nextConfig as RuntimeConfig, activated.compiled.source, policy)!;
  const selectedReceipts = selectedSource.receipts ?? { authority: "runner_ledger" as const };
  if (selectedReceipts.authority === "source_db") {
    const relation = inspection.tables.find(table => table.schema === selectedReceipts.schema && table.name === selectedReceipts.table);
    const required = ["idempotency_key", "job_id", "proposal_id", "status", "result_hash", "completed_at", "semantic_verification_json"];
    if (!relation || required.some(name => !relation.columns?.some(column => column.name === name))
      || relation.primary_key?.length !== 1 || relation.primary_key[0] !== "idempotency_key"
      || source.engine === "postgres" && relation.columns.find(column => column.name === "semantic_verification_json")?.data_type !== "jsonb") {
      throw new Error("SEMANTIC_RECEIPT_OBJECT_INVALID: The selected source receipt relation does not have the required engine columns and idempotency primary key. Review the exact writeback setup migration; execution was not enabled.");
    }
    // Existing adapter probe writes only a receipt diagnostic inside ROLLBACK.
    // Metadata/grants alone cannot prove the required relation accepts receipts.
    const checked = await (source.engine === "postgres" ? postgresAdapter : mysqlAdapter).doctor({
      controlPlaneUrl: "local", runnerToken: "local", runnerId: "semantic-receipt-review", sourceId: activated.compiled.source,
      engine: source.engine, databaseUrl: env[writeUrlEnv]!, receipts: selectedReceipts,
      pollIntervalMs: 0, statementTimeoutMs: positiveInteger(source.statement_timeout_ms) ?? 5_000,
      logLevel: "error", dryRun: true, stateDir: "./state",
    });
    if (!checked.ok) throw new Error("SEMANTIC_RECEIPT_NOT_VERIFIED: The effective writer could not verify the required source receipt relation. Apply the reviewed setup and inspect the current writer before execution review.");
  }
  await validateRuntimeConfig(nextConfig, configPath);
  return {
    receipts: selectedReceipts as SemanticReceiptMode,
    outcome: input.outcome,
    action_boundary_digest: active.authority.action_boundary.digest,
    config_path: projectRelativePath(projectRoot, configPath),
    current_config_digest: currentReview.digest,
    profile: input.profile,
    source: activated.compiled.source,
    target: `${activated.compiled.target_resource.schema}.${activated.compiled.target_resource.table}`,
    operation: activated.compiled.effect_envelope.operation,
    write_url_env: writeUrlEnv,
    writer_role: inspection.current_user,
    writer_posture_fingerprint: fingerprint,
    allowed_relations: assessment.allowed_relations,
    verification: { writer: assessment, receipt_probe: selectedReceipts.authority === "source_db" ? "passed_rolled_back" : "not_run_runner_ledger" },
    policy,
    config: nextConfig,
    ...(currentReview.epoch === undefined ? {} : { policy_epoch: currentReview.epoch }),
  };
}

/** Saves an already reviewed execution posture only if authority, config, and writer posture are unchanged. */
export async function enableSemanticSupervisedExecution(input: {
  projectRoot: string;
  outcome: string;
  profile: "development" | "staging" | "production";
  expectedActionBoundaryDigest: string;
  expectedConfigDigest: string;
  expectedWriterPostureFingerprint: string;
  confirmation: string;
  configPath?: string;
  writeUrlEnv?: string;
  workerIdentity?: string;
  delayedWork?: NonNullable<RuntimeSupervisedWorkerOutcomePolicy["delayed_work"]>;
  env?: NodeJS.ProcessEnv;
  inspect?: typeof inspectDatabase;
}): Promise<SemanticSupervisedExecutionPreview> {
  const preview = await previewSemanticSupervisedExecution(input);
  if (preview.action_boundary_digest !== input.expectedActionBoundaryDigest) {
    throw new Error("SEMANTIC_ACTION_AUTHORITY_CHANGED: the active Action Boundary changed; review execution again.");
  }
  if (preview.current_config_digest !== input.expectedConfigDigest) {
    throw new Error("SEMANTIC_ACTION_CONFIG_CHANGED: the Action runtime config changed; review execution again.");
  }
  if (preview.writer_posture_fingerprint !== input.expectedWriterPostureFingerprint) {
    throw new Error("SEMANTIC_ACTION_WRITER_POSTURE_CHANGED: the writer role changed; review execution again.");
  }
  const expectedConfirmation = semanticExecutionConfirmation(preview);
  if (input.confirmation !== expectedConfirmation) {
    throw new Error(`SEMANTIC_ACTION_EXECUTION_CONFIRMATION_REQUIRED: enter ${expectedConfirmation}.`);
  }
  await publishReviewedExecutionConfig({ projectRoot: path.resolve(input.projectRoot),
    configPath: path.resolve(input.configPath ?? path.join(path.resolve(input.projectRoot), SEMANTIC_ACTION_RUNTIME_CONFIG)),
    config: preview.config, expectedDigest: preview.current_config_digest, expectedEpoch: preview.policy_epoch,
    expectedActionDigest: preview.action_boundary_digest, outcome: input.outcome, operation: "enable_reviewed_execution", env: input.env });
  return preview;
}

export function semanticExecutionConfirmation(
  preview: Pick<SemanticSupervisedExecutionPreview, "outcome" | "action_boundary_digest" | "writer_posture_fingerprint"> &
    { policy?: Pick<RuntimeSupervisedWorkerOutcomePolicy, "delayed_work"> },
): string {
  return `ENABLE SUPERVISED ${preview.outcome} ${preview.action_boundary_digest} ${preview.writer_posture_fingerprint}`
    + (preview.policy?.delayed_work ? ` ${canonicalJsonDigest(preview.policy.delayed_work)}` : "");
}

/** Metadata-only readiness check after writer repair, before guided execution consent. */
export async function verifySemanticExecutionReadPosture(input: {
  projectRoot: string; outcome: string; activeReads: ActivatedExplorationBoundary[];
  env?: NodeJS.ProcessEnv; inspect?: typeof inspectDatabase;
}): Promise<void> {
  const active = await executionReviewActionAuthority(input.projectRoot, input.env, { outcome: input.outcome });
  const rule = active.registry.rules.find((entry) => entry.compiled.outcome === input.outcome)!;
  const read = input.activeReads.find((entry) => entry.pack.name === rule.read_boundary_name
    && entry.activation.digest === rule.read_boundary_digest);
  if (!read) throw new Error("SEMANTIC_ACTION_READ_REVIEW_REQUIRED: The exact dependent Read revision is no longer active. Resume the saved job to review its dependencies.");
  const binding = await openBoundProjectControlPolicies(input.projectRoot, input.env);
  let lock;
  try { lock = await loadGenerationLockForActivatedBoundary(input.projectRoot, read, binding); }
  finally { await binding?.close(); }
  const inspection = await (input.inspect ?? inspectDatabase)({ engine: lock.engine,
    databaseUrlEnv: lock.source_env, ...(lock.inspected_schema ? { schema: lock.inspected_schema } : {}), env: input.env ?? process.env });
  const comparison = compareGenerationLock(lock, inspection);
  if (!comparison.current) throw new Error(`SEMANTIC_ACTION_READ_REVIEW_REQUIRED: ${comparison.changes.join("; ")}.\n${generationLockRemediation(lock)}\nResume the saved job to revalidate the same business rules, then review Read, Action and execution separately. Do not reset the project.`);
  const config = await readJsonObject(path.join(input.projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG));
  const source = resolveRuntimeConfig(config as RuntimeConfig, input.projectRoot).sources![rule.compiled.source]!;
  const issues = actionRuleRlsReadiness({ compiled: rule.compiled, inspection, source, connection: "reader" });
  if (issues.length) throw new Error(`SEMANTIC_ACTION_DATABASE_REVIEW_REQUIRED: The read connection cannot yet verify these changes.\n${issues.map(issue => `${issue.relation}: ${issue.reason}`).join("\n")}`);
}

/** Operator prompt defaults only, never execution authority. Historical records
 * must still match this runtime binding; every use requires a fresh review. */
export async function readSemanticExecutionReviewDefaults(input: {
  projectRoot: string; outcome: string; env?: NodeJS.ProcessEnv;
}): Promise<{ write_url_env: string; worker_identity?: string;
  delayed_work?: NonNullable<RuntimeSupervisedWorkerOutcomePolicy["delayed_work"]> } | undefined> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG);
  if (await readOptionalText(configPath) === undefined) return undefined;
  const binding = await openBoundProjectControlPolicies(projectRoot, input.env);
  try {
    const review = await executionConfigForReview(projectRoot, configPath, await readJsonObject(configPath), binding, input.env);
    const config = resolveRuntimeConfig(review.config as RuntimeConfig, projectRoot);
    let selected = config.supervised_worker?.outcomes?.find((policy) => policy.outcome === input.outcome);
    let before: { epoch: number; revision_id: string } | undefined;
    for (let pageIndex = 0; binding && !selected && pageIndex < 4; pageIndex++) {
      const page = await binding.repository.history({ deployment_id: binding.deployment_id, key: OPERATOR_EXECUTION_POLICY_KEY,
        limit: 16, ...(before ? { before } : {}) });
      for (const { revision } of page) {
        let historical;
        try { historical = parseOperatorExecutionPolicy(revision.content, config); }
        catch (error) {
          if ((error as { code?: string }).code === "POLICY_EXECUTION_BINDING_CHANGED") continue;
          throw error;
        }
        assertOperatorPolicyRecord(revision, OPERATOR_EXECUTION_POLICY_KEY, canonicalJsonDigest(historical));
        selected = historical.policy.outcomes?.find((policy) => policy.outcome === input.outcome);
        if (selected) break;
      }
      if (page.length < 16) break;
      const last = page.at(-1)!;
      before = { epoch: last.epoch, revision_id: last.revision.revision_id };
    }
    if (binding && (await binding.repository.deployment(binding.deployment_id))?.epoch !== review.epoch) {
      throw new Error("SEMANTIC_ACTION_CONFIG_CHANGED: saved execution changed while choosing review defaults; reopen execution review.");
    }
    return selected ? { write_url_env: environmentName(selected.write_url_env),
      ...(selected.worker_identity === undefined ? {} : { worker_identity: safeWorkerIdentity(selected.worker_identity) }),
      ...(selected.delayed_work ? { delayed_work: structuredClone(selected.delayed_work) } : {}) } : undefined;
  } finally { await binding?.close(); }
}

export async function disableSemanticSupervisedExecution(input: {
  projectRoot: string;
  outcome: string;
  expectedActionBoundaryDigest: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SemanticSupervisedExecutionState> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.resolve(
    input.configPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, configPath);
  await recoverPolicyConfiguration({ projectRoot, configPath, env: input.env });
  const active = await executionReviewActionAuthority(projectRoot, input.env, { dependency_check: "report" });
  if (active.authority.action_boundary.digest !== input.expectedActionBoundaryDigest) {
    throw new Error("SEMANTIC_ACTION_AUTHORITY_CHANGED: the active Action Boundary changed; review execution again.");
  }
  const review = await executionConfigForReview(projectRoot, configPath, await readJsonObject(configPath), undefined, input.env);
  const config = review.config;
  const worker = isRecord(config.supervised_worker)
    ? structuredClone(config.supervised_worker)
    : undefined;
  if (!worker) return readSemanticSupervisedExecutionState({ projectRoot, configPath, env: input.env });
  const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities : [];
  const outcomes = Array.isArray(worker.outcomes)
    ? worker.outcomes.filter((entry) => !isRecord(entry) || entry.outcome !== input.outcome)
    : [];
  worker.capabilities = capabilities;
  if (outcomes.length > 0) worker.outcomes = outcomes;
  else delete worker.outcomes;
  worker.enabled = capabilities.length > 0 || outcomes.length > 0;
  config.supervised_worker = worker;
  await validateRuntimeConfig(config, configPath);
  await publishReviewedExecutionConfig({ projectRoot, configPath, config, expectedDigest: review.digest,
    expectedEpoch: review.epoch, expectedActionDigest: input.expectedActionBoundaryDigest, outcome: input.outcome, operation: "disable_reviewed_execution", env: input.env });
  return readSemanticSupervisedExecutionState({ projectRoot, configPath, env: input.env });
}

async function executionReviewActionAuthority(projectRoot: string, env?: NodeJS.ProcessEnv,
  options: Parameters<typeof loadActiveActionRuleAuthority>[1] = {}) {
  const binding = await openBoundProjectControlPolicies(projectRoot, env);
  try { return binding ? await createActiveActionRuleAuthorityLoader(projectRoot, binding)(options) : await loadActiveActionRuleAuthority(projectRoot, options); }
  finally { await binding?.close(); }
}

/** Internal persistence after exact operator confirmation. Store CAS also
 * covers Read/Action revocation during writer inspection; exports grant nothing. */
async function publishReviewedExecutionConfig(input: {
  projectRoot: string; configPath: string; config: Record<string, unknown>;
  expectedDigest: string; expectedEpoch?: number; expectedActionDigest: string; outcome: string;
  operation: "enable_reviewed_execution" | "disable_reviewed_execution"; env?: NodeJS.ProcessEnv;
}): Promise<void> {
  return withProjectAuthorityMutation(input.projectRoot, (held) => publishReviewedExecutionConfigUnlocked({ ...input,
    projectRoot: held.projectRoot,
    configPath: projectPathAfterLock(input.configPath, input.projectRoot, held.projectRoot),
  }, held));
}

function projectPathAfterLock(file: string, originalRoot: string, heldRoot: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(path.resolve(originalRoot), absolute);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? path.resolve(heldRoot, relative) : absolute;
}

async function publishReviewedExecutionConfigUnlocked(input: Parameters<typeof publishReviewedExecutionConfig>[0],
  permit: ProjectAuthorityMutationPermit): Promise<void> {
  await assertNoPendingPolicyConfiguration(input.projectRoot, input.configPath);
  const previous = await fs.readFile(input.configPath, "utf8");
  const previousConfig = resolveRuntimeConfig(JSON.parse(previous) as RuntimeConfig, path.dirname(input.configPath));
  const binding = await openProjectControlPolicies({ projectRoot: input.projectRoot, config: previousConfig, env: input.env,
    storePath: path.resolve(path.dirname(input.configPath), previousConfig.storage?.sqlite_path ?? ".synapsor/local.db") });
  const nextText = `${JSON.stringify(input.config, null, 2)}\n`;
  if (!binding) {
    if (input.expectedEpoch !== undefined) throw new Error("POLICY_REPOSITORY_MISSING: review execution again.");
    if (canonicalJsonDigest(JSON.parse(previous)) !== input.expectedDigest) {
      throw new Error("SEMANTIC_ACTION_CONFIG_CHANGED: the reviewed runtime config changed before publication; review execution again.");
    }
    const active = await loadActiveActionRuleAuthority(input.projectRoot, {
      dependency_check: input.operation === "disable_reviewed_execution" ? "report" : "all",
      outcome: input.outcome,
    });
    if (active.authority.action_boundary.digest !== input.expectedActionDigest) {
      throw new Error("SEMANTIC_ACTION_AUTHORITY_CHANGED: the reviewed Action Boundary changed before publication; review execution again.");
    }
    if (input.operation === "enable_reviewed_execution" && (input.config as RuntimeConfig).supervised_worker?.outcomes
      ?.some((outcome) => active.unavailable_outcomes?.includes(outcome.outcome))) {
      throw new Error("POLICY_EXECUTION_AUTHORITY_STALE: an enabled outcome lacks its reviewed Read dependency. Review that outcome before enabling execution.");
    }
    if (input.operation === "enable_reviewed_execution") await assertHardLimitWriterSetup({ registry: active.registry,
      config: resolveRuntimeConfig(input.config as RuntimeConfig, path.dirname(input.configPath)), env: input.env, outcome: input.outcome });
    await writePrivateTextAtomic(input.configPath, nextText);
    return;
  }
  try {
    const review = await executionConfigForReview(input.projectRoot, input.configPath, JSON.parse(previous), binding);
    if (review.epoch !== input.expectedEpoch || review.digest !== input.expectedDigest) {
      throw new Error("SEMANTIC_ACTION_CONFIG_CHANGED: reviewed policy or runtime bindings changed; review execution again.");
    }
    const active = await createActiveActionRuleAuthorityLoader(input.projectRoot, binding)({
      dependency_check: input.operation === "disable_reviewed_execution" ? "report" : "all",
      outcome: input.outcome,
    });
    if (active.authority.action_boundary.digest !== input.expectedActionDigest) {
      throw new Error("SEMANTIC_ACTION_AUTHORITY_CHANGED: review execution again.");
    }
    const config = resolveRuntimeConfig(input.config as RuntimeConfig, path.dirname(input.configPath));
    if (canonicalJsonDigest(config.storage ?? null) !== canonicalJsonDigest(previousConfig.storage ?? null)) {
      throw new Error("POLICY_STORE_MISMATCH: execution review cannot change the control store.");
    }
    const revision = encodeOperatorExecutionPolicy(config);
    if (!revision) throw new Error("POLICY_EXECUTION_CONTEXT_REQUIRED: no reviewed execution configuration was prepared.");
    if (config.supervised_worker?.enabled) {
      for (const outcome of config.supervised_worker.outcomes ?? []) {
        if (outcome.action_boundary_digest !== active.authority.action_boundary.digest
          || !active.registry.rules.some((rule) => rule.compiled.outcome === outcome.outcome)
          || (input.operation === "enable_reviewed_execution" && active.unavailable_outcomes?.includes(outcome.outcome))) {
          throw new Error("POLICY_EXECUTION_AUTHORITY_STALE: review every affected execution outcome again.");
        }
      }
    }
    if (input.operation === "enable_reviewed_execution") await assertHardLimitWriterSetup({ registry: active.registry, config, env: input.env, outcome: input.outcome });
    // Publish new source bindings first: until the CAS, the old policy either
    // remains exact or refuses the changed binding. A worker export is ignored.
    const event = { event_id: randomUUID(), actor: "local_operator", occurred_at: new Date().toISOString(),
      receipt: { operation: input.operation, action_boundary_digest: input.expectedActionDigest,
        execution_revision: revision.revision_id, source_database_changed: false } };
    await publishPolicyConfiguration({ projectRoot: input.projectRoot, configPath: input.configPath, binding,
      mutationPermit: permit, before: previous, after: nextText,
      change: { expected_epoch: review.epoch!, revisions: [revision],
        active: [{ ...OPERATOR_EXECUTION_POLICY_KEY, revision_id: revision.revision_id }], drafts: [],
        event } });
  } finally {
    await binding.close();
  }
}

export function semanticSupervisedExecutionConfig(input: {
  sourceConfig: Record<string, unknown>;
  activation: ActionRuleAuthorityActivationV1;
  outcome: string;
  profile: "development" | "staging" | "production";
  writeUrlEnv: string;
  writerPostureFingerprint: `sha256:${string}`;
  workerIdentity?: string;
  delayedWork?: NonNullable<RuntimeSupervisedWorkerOutcomePolicy["delayed_work"]>;
  receipts?: SemanticReceiptMode;
}): Record<string, unknown> {
  const config = structuredClone(input.sourceConfig);
  const sourceRule = input.activation.authority.rules.find((candidate) => candidate.rule.outcome === input.outcome);
  const boundaryRule = input.activation.authority.action_boundary.rules.find((candidate) => candidate.outcome === input.outcome);
  if (!sourceRule || !boundaryRule) {
    throw new Error(`SEMANTIC_ACTION_OUTCOME_NOT_ACTIVE: ${input.outcome} is not in the active verified Action Boundary.`);
  }
  if (boundaryRule.writeback.mode !== "direct_sql" || boundaryRule.writeback.supervised_worker !== "allowed") {
    throw new Error(`SEMANTIC_ACTION_EXECUTION_NOT_REVIEWED: ${input.outcome} permits proposals only.`);
  }
  const sources = isRecord(config.sources) ? structuredClone(config.sources) : {};
  const source = currentConfigSource(config, sourceRule.effect_envelope.source);
  const writeUrlEnv = environmentName(input.writeUrlEnv);
  const sourceName = sourceRule.effect_envelope.source;
  const writerSourceName = typeof source.write_url_env === "string" && source.write_url_env !== writeUrlEnv
    ? `${sourceName}_writer_${canonicalJsonDigest({ source: sourceName, write_url_env: writeUrlEnv }).slice(7, 19)}`
    : sourceName;
  source.read_only = false;
  source.write_url_env = writeUrlEnv;
  const receipts = input.receipts ?? source.receipts ?? { authority: "runner_ledger" };
  const otherWriters = (config as RuntimeConfig).supervised_worker?.outcomes?.filter(policy => policy.outcome !== input.outcome && policy.write_url_env === writeUrlEnv) ?? [];
  if (otherWriters.length && canonicalJsonDigest(receipts) !== canonicalJsonDigest(source.receipts ?? { authority: "runner_ledger" })) {
    throw new Error("SEMANTIC_RECEIPT_SHARED_WRITER_CONFLICT: Choose a dedicated writer reference before changing this outcome's receipt mode. Other reviewed outcomes remain unchanged.");
  }
  source.receipts = receipts;
  if (writerSourceName !== sourceName && sources[writerSourceName]
    && canonicalJsonDigest(sources[writerSourceName]) !== canonicalJsonDigest(source)) {
    throw new Error("SEMANTIC_ACTION_WRITER_SOURCE_CONFLICT: the configured writer alias no longer matches the reviewed source binding");
  }
  sources[writerSourceName] = source;
  config.sources = sources;
  config.mode = "review";

  const existing = isRecord(config.supervised_worker)
    ? structuredClone(config.supervised_worker)
    : undefined;
  if (existing?.profile !== undefined && existing.profile !== input.profile) {
    throw new Error(
      `SEMANTIC_ACTION_WORKER_PROFILE_MISMATCH: existing ${String(existing.profile)} worker controls cannot be combined with ${input.profile}.`,
    );
  }
  const capabilities = Array.isArray(existing?.capabilities) ? existing.capabilities : [];
  const priorPolicy = Array.isArray(existing?.outcomes)
    ? existing.outcomes.find((entry) => isRecord(entry) && entry.outcome === input.outcome
      && entry.action_boundary_digest === input.activation.authority.action_boundary.digest)
    : undefined;
  const proposalTtlSeconds = isRecord(priorPolicy) && Number.isSafeInteger(priorPolicy.proposal_ttl_seconds)
    ? Number(priorPolicy.proposal_ttl_seconds) : DEFAULT_SEMANTIC_WORKER_LIMITS.proposal_ttl_seconds;
  if (input.delayedWork && input.delayedWork.absolute_request_age_seconds > proposalTtlSeconds) {
    throw new Error("DELAYED_WORK_EXCEEDS_WORKER_AGE: the requested absolute age exceeds the already reviewed worker proposal age; review that bound separately before enabling delayed work.");
  }
  // This is a review candidate only. Stale bundle bindings never carry forward;
  // the old governed revision remains history after explicit publication.
  const outcomes = Array.isArray(existing?.outcomes)
    ? existing.outcomes.filter((entry) => !isRecord(entry) || (entry.outcome !== input.outcome
      && (typeof entry.action_boundary_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.action_boundary_digest)
        || entry.action_boundary_digest === input.activation.authority.action_boundary.digest)))
    : [];
  const policy: RuntimeSupervisedWorkerOutcomePolicy = {
    outcome: input.outcome,
    action_boundary_digest: input.activation.authority.action_boundary.digest,
    mode: "supervised_worker",
    ...DEFAULT_SEMANTIC_WORKER_LIMITS,
    ...(input.delayedWork ? { proposal_ttl_seconds: proposalTtlSeconds, max_attempts: 1 } : {}),
    write_url_env: environmentName(input.writeUrlEnv),
    require_least_privilege_writer: true,
    writer_posture_fingerprint: input.writerPostureFingerprint,
    ...(input.workerIdentity ? { worker_identity: safeWorkerIdentity(input.workerIdentity) } : {}),
    ...(input.delayedWork ? { delayed_work: structuredClone(input.delayedWork) } : {}),
  };
  config.supervised_worker = {
    ...(existing ?? {}),
    enabled: true,
    profile: input.profile,
    capabilities,
    outcomes: [...outcomes, policy],
  };
  return config;
}

export function semanticActionRuntimeConfig(input: {
  projectRoot: string;
  sourceConfigPath: string;
  outputConfigPath: string;
  sourceConfig: Record<string, unknown>;
  draft: ActionRuleAuthorityDraftV1;
  preserveActionRuntime: boolean;
}): Record<string, unknown> {
  const projectRoot = path.resolve(input.projectRoot);
  const sourceDirectory = path.dirname(path.resolve(input.sourceConfigPath));
  const outputDirectory = path.dirname(path.resolve(input.outputConfigPath));
  const config = structuredClone(input.sourceConfig);
  const productionExplore = isRecord(config.production_explore)
    ? config.production_explore
    : undefined;
  const existingActionRules = isRecord(config.action_rules)
    ? config.action_rules
    : undefined;
  if (existingActionRules && typeof existingActionRules.project_root === "string") {
    const boundRoot = path.resolve(sourceDirectory, existingActionRules.project_root);
    if (boundRoot !== projectRoot) {
      throw new Error(
        `SEMANTIC_ACTION_PROJECT_ROOT_MISMATCH: ${input.sourceConfigPath} is bound to ${boundRoot}, not ${projectRoot}.`,
      );
    }
  }

  config.mode = "review";
  config.action_rules = actionRuleBinding({
    projectRoot,
    outputDirectory,
    existing: existingActionRules,
    productionExplore,
  });
  delete config.production_explore;

  if (!input.preserveActionRuntime) {
    // A Read runtime may contain ordinary read capabilities or contracts. They
    // never migrate into the separate Action endpoint implicitly.
    const proposalCapabilities = Array.isArray(config.capabilities)
      ? config.capabilities.filter((entry) => isRecord(entry) && entry.kind === "proposal")
      : [];
    if (proposalCapabilities.length > 0) config.capabilities = proposalCapabilities;
    else delete config.capabilities;
    delete config.contracts;
    delete config.action_boundary;
    delete config.proposal_freshness;
  } else {
    rebaseConfigPaths(config, sourceDirectory, outputDirectory);
  }

  pruneStaleSemanticWorkerPolicies(config, input.draft);
  return config;
}

function actionRuleBinding(input: {
  projectRoot: string;
  outputDirectory: string;
  existing?: Record<string, unknown>;
  productionExplore?: Record<string, unknown>;
}): Record<string, unknown> {
  const projectRoot = relativeConfigPath(input.outputDirectory, input.projectRoot);
  const productionKey = stringValue(input.productionExplore?.budget_hmac_key_env);
  const productionNamespace = stringValue(input.productionExplore?.accounting_namespace);
  const existingKey = stringValue(input.existing?.subject_reference_hmac_key_env);
  const existingNamespace = stringValue(input.existing?.subject_reference_namespace);
  if (productionKey && productionNamespace && existingKey && existingNamespace
    && (productionKey !== existingKey || productionNamespace !== existingNamespace)) {
    throw new Error(
      "SEMANTIC_ACTION_SUBJECT_BINDING_MISMATCH: the Action runtime and production Explore use different opaque-subject authority.",
    );
  }
  const key = productionKey ?? existingKey;
  const namespace = productionNamespace ?? existingNamespace;
  return {
    project_root: projectRoot,
    legacy_tools: input.existing?.legacy_tools === "enabled" ? "enabled" : "disabled",
    ...(key && namespace
      ? {
          subject_reference_hmac_key_env: key,
          subject_reference_namespace: namespace,
        }
      : {}),
  };
}

function pruneStaleSemanticWorkerPolicies(
  config: Record<string, unknown>,
  draft: ActionRuleAuthorityDraftV1,
): void {
  if (!isRecord(config.supervised_worker)) return;
  const worker = structuredClone(config.supervised_worker);
  const outcomes = new Set(draft.authority.rules.map((rule) => rule.rule.outcome));
  const retainedOutcomes = Array.isArray(worker.outcomes)
    ? worker.outcomes.filter((entry) => isRecord(entry)
      && outcomes.has(String(entry.outcome))
      && entry.action_boundary_digest === draft.authority.action_boundary.digest)
    : [];
  const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities : [];
  worker.capabilities = capabilities;
  if (retainedOutcomes.length > 0) worker.outcomes = retainedOutcomes;
  else delete worker.outcomes;
  if (capabilities.length === 0 && retainedOutcomes.length === 0) {
    delete config.supervised_worker;
    return;
  }
  config.supervised_worker = worker;
}

function rebaseConfigPaths(
  config: Record<string, unknown>,
  sourceDirectory: string,
  outputDirectory: string,
): void {
  if (sourceDirectory === outputDirectory) return;
  if (Array.isArray(config.contracts)) {
    config.contracts = config.contracts.map((entry) => typeof entry === "string"
      ? relativeConfigPath(outputDirectory, path.resolve(sourceDirectory, entry))
      : entry);
  }
  if (isRecord(config.generated_authority)
    && typeof config.generated_authority.generation_lock_path === "string") {
    config.generated_authority.generation_lock_path = relativeConfigPath(
      outputDirectory,
      path.resolve(sourceDirectory, config.generated_authority.generation_lock_path),
    );
  }
  if (isRecord(config.governance) && typeof config.governance.connection_file === "string") {
    config.governance.connection_file = relativeConfigPath(
      outputDirectory,
      path.resolve(sourceDirectory, config.governance.connection_file),
    );
  }
}

async function validateRuntimeConfig(
  config: Record<string, unknown>,
  outputConfigPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outputConfigPath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(outputConfigPath),
    `.synapsor-semantic-action-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await writePrivateTextAtomic(temporary, `${JSON.stringify(config, null, 2)}\n`);
  try {
    loadRuntimeConfigFromFile(temporary);
  } catch (error) {
    throw new Error(
      `SEMANTIC_ACTION_CONFIG_INVALID: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `SEMANTIC_ACTION_CONFIG_READ_FAILED: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`SEMANTIC_ACTION_CONFIG_INVALID: ${filePath} must contain one JSON object.`);
  }
  return parsed;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePrivateTextAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertContainedProjectPath(projectRoot: string, target: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("SEMANTIC_ACTION_CONFIG_PATH_ESCAPE: the managed Action config must stay inside the project.");
  }
}

function projectRelativePath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/gu, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function relativeConfigPath(configDirectory: string, target: string): string {
  const relative = path.relative(configDirectory, target).replace(/\\/gu, "/");
  return relative === "." || relative.startsWith("./") || relative.startsWith("../")
    ? relative
    : `./${relative}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function currentConfigSource(
  config: Record<string, unknown>,
  sourceName: string,
): Record<string, unknown> & { engine: "postgres" | "mysql" } {
  const sources = isRecord(config.sources) ? config.sources : undefined;
  const source = sources && isRecord(sources[sourceName])
    ? structuredClone(sources[sourceName])
    : undefined;
  if (!source || (source.engine !== "postgres" && source.engine !== "mysql")) {
    throw new Error(`SEMANTIC_ACTION_SOURCE_CONFIG_MISSING: source ${sourceName} is not configured for PostgreSQL or MySQL.`);
  }
  return source as Record<string, unknown> & { engine: "postgres" | "mysql" };
}

function semanticWorkerOutcomePolicy(
  config: Record<string, unknown>,
  outcome: string,
): RuntimeSupervisedWorkerOutcomePolicy {
  const worker = isRecord(config.supervised_worker) ? config.supervised_worker : undefined;
  const policy = Array.isArray(worker?.outcomes)
    ? worker.outcomes.find((entry) => isRecord(entry) && entry.outcome === outcome)
    : undefined;
  if (!isRecord(policy)) {
    throw new Error(`SEMANTIC_ACTION_WORKER_POLICY_MISSING: no worker policy was prepared for ${outcome}.`);
  }
  return policy as RuntimeSupervisedWorkerOutcomePolicy;
}

function environmentName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z_][A-Z0-9_]{1,127}$/.test(normalized)) {
    throw new Error("SEMANTIC_ACTION_WRITE_ENV_INVALID: the writer credential must be referenced by an uppercase environment variable name.");
  }
  return normalized;
}

function safeWorkerIdentity(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error("SEMANTIC_ACTION_WORKER_IDENTITY_INVALID: worker identity must be one fixed safe name.");
  }
  return normalized;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
