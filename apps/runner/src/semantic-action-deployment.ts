import fs from "node:fs/promises";
import path from "node:path";
import {
  loadRuntimeConfigFromFile,
  type RuntimeConfig,
  type RuntimeSupervisedWorkerOutcomePolicy,
} from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  inspectDatabase,
  rolePostureFingerprint,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import process from "node:process";
import {
  activateActionRuleAuthority,
  loadActiveActionRuleAuthority,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";

export const SEMANTIC_ACTION_RUNTIME_CONFIG = "synapsor.actions.runner.json";

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
  policy: RuntimeSupervisedWorkerOutcomePolicy;
  config: Record<string, unknown>;
};

export type SemanticSupervisedExecutionState = {
  enabled: boolean;
  config_path: string;
  policies: RuntimeSupervisedWorkerOutcomePolicy[];
};

const DEFAULT_SEMANTIC_WORKER_LIMITS = {
  concurrency: 1,
  queue_limit: 100,
  lease_seconds: 300,
  max_attempts: 5,
  proposal_ttl_seconds: 86_400,
  rate_limit: { executions: 60, window_seconds: 60 },
} as const;

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
}): Promise<SemanticActionRuntimeActivation> {
  const projectRoot = path.resolve(input.projectRoot);
  const outputConfigPath = path.resolve(
    input.outputConfigPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, outputConfigPath);
  const baseConfigPath = path.resolve(
    input.baseConfigPath ?? path.join(projectRoot, "synapsor.runner.json"),
  );
  const previous = await readOptionalText(outputConfigPath);
  const sourceConfigPath = previous === undefined ? baseConfigPath : outputConfigPath;
  const sourceConfig = await readJsonObject(sourceConfigPath);
  const nextConfig = semanticActionRuntimeConfig({
    projectRoot,
    sourceConfigPath,
    outputConfigPath,
    sourceConfig,
    draft: input.draft,
    preserveActionRuntime: previous !== undefined,
  });
  await validateRuntimeConfig(nextConfig, outputConfigPath);
  const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const configChanged = nextText !== previous;
  if (configChanged) await writePrivateTextAtomic(outputConfigPath, nextText);
  try {
    const activation = await activateActionRuleAuthority({
      projectRoot,
      name: input.draft.authority.name,
      expected_digest: input.draft.digest,
      confirmation: `ACTIVATE ${input.draft.digest}`,
      actor: input.actor,
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      activation,
      config_path: projectRelativePath(projectRoot, outputConfigPath),
      config_changed: configChanged,
    };
  } catch (error) {
    if (configChanged) {
      if (previous === undefined) await fs.rm(outputConfigPath, { force: true }).catch(() => undefined);
      else await writePrivateTextAtomic(outputConfigPath, previous).catch(() => undefined);
    }
    throw error;
  }
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
  env?: NodeJS.ProcessEnv;
  inspect?: typeof inspectDatabase;
}): Promise<SemanticSupervisedExecutionPreview> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.resolve(
    input.configPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, configPath);
  const active = await loadActiveActionRuleAuthority(projectRoot);
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
  const currentConfig = await readJsonObject(configPath);
  const source = currentConfigSource(currentConfig, activated.compiled.source);
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
  const fingerprint = rolePostureFingerprint(inspection);
  const nextConfig = semanticSupervisedExecutionConfig({
    sourceConfig: currentConfig,
    activation: active.activation,
    outcome: input.outcome,
    profile: input.profile,
    writeUrlEnv,
    writerPostureFingerprint: fingerprint,
    ...(input.workerIdentity ? { workerIdentity: input.workerIdentity } : {}),
  });
  const policy = semanticWorkerOutcomePolicy(nextConfig, input.outcome);
  const assessment = assessSemanticSupervisedWriterPosture(
    nextConfig as RuntimeConfig,
    policy,
    active.registry,
    inspection,
  );
  if (!assessment.ok) {
    throw new Error(
      `SEMANTIC_ACTION_WRITER_POSTURE_INVALID: ${writeUrlEnv} is not the exact least-privilege writer for this outcome (${assessment.reasons.join(", ")}).`,
    );
  }
  await validateRuntimeConfig(nextConfig, configPath);
  return {
    outcome: input.outcome,
    action_boundary_digest: active.authority.action_boundary.digest,
    config_path: projectRelativePath(projectRoot, configPath),
    current_config_digest: canonicalJsonDigest(JSON.parse(currentText)),
    profile: input.profile,
    source: activated.compiled.source,
    target: `${activated.compiled.target_resource.schema}.${activated.compiled.target_resource.table}`,
    operation: activated.compiled.effect_envelope.operation,
    write_url_env: writeUrlEnv,
    writer_role: inspection.current_user,
    writer_posture_fingerprint: fingerprint,
    allowed_relations: assessment.allowed_relations,
    policy,
    config: nextConfig,
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
  await writePrivateTextAtomic(
    path.resolve(input.configPath ?? path.join(path.resolve(input.projectRoot), SEMANTIC_ACTION_RUNTIME_CONFIG)),
    `${JSON.stringify(preview.config, null, 2)}\n`,
  );
  return preview;
}

export function semanticExecutionConfirmation(
  preview: Pick<SemanticSupervisedExecutionPreview, "outcome" | "action_boundary_digest" | "writer_posture_fingerprint">,
): string {
  return `ENABLE SUPERVISED ${preview.outcome} ${preview.action_boundary_digest} ${preview.writer_posture_fingerprint}`;
}

export async function readSemanticSupervisedExecutionState(input: {
  projectRoot: string;
  configPath?: string;
}): Promise<SemanticSupervisedExecutionState> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.resolve(
    input.configPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, configPath);
  const text = await readOptionalText(configPath);
  if (text === undefined) {
    return { enabled: false, config_path: projectRelativePath(projectRoot, configPath), policies: [] };
  }
  const config = await readJsonObject(configPath);
  const worker = isRecord(config.supervised_worker) ? config.supervised_worker : undefined;
  const policies = Array.isArray(worker?.outcomes)
    ? worker.outcomes.filter(isRecord).map((entry) => entry as RuntimeSupervisedWorkerOutcomePolicy)
    : [];
  return {
    enabled: worker?.enabled === true,
    config_path: projectRelativePath(projectRoot, configPath),
    policies,
  };
}

export async function disableSemanticSupervisedExecution(input: {
  projectRoot: string;
  outcome: string;
  expectedActionBoundaryDigest: string;
  configPath?: string;
}): Promise<SemanticSupervisedExecutionState> {
  const projectRoot = path.resolve(input.projectRoot);
  const configPath = path.resolve(
    input.configPath ?? path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG),
  );
  assertContainedProjectPath(projectRoot, configPath);
  const active = await loadActiveActionRuleAuthority(projectRoot);
  if (active.authority.action_boundary.digest !== input.expectedActionBoundaryDigest) {
    throw new Error("SEMANTIC_ACTION_AUTHORITY_CHANGED: the active Action Boundary changed; review execution again.");
  }
  const config = await readJsonObject(configPath);
  const worker = isRecord(config.supervised_worker)
    ? structuredClone(config.supervised_worker)
    : undefined;
  if (!worker) return readSemanticSupervisedExecutionState({ projectRoot, configPath });
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
  await writePrivateTextAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return readSemanticSupervisedExecutionState({ projectRoot, configPath });
}

export function semanticSupervisedExecutionConfig(input: {
  sourceConfig: Record<string, unknown>;
  activation: ActionRuleAuthorityActivationV1;
  outcome: string;
  profile: "development" | "staging" | "production";
  writeUrlEnv: string;
  writerPostureFingerprint: `sha256:${string}`;
  workerIdentity?: string;
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
  source.read_only = false;
  source.write_url_env = environmentName(input.writeUrlEnv);
  source.receipts = { authority: "runner_ledger" };
  sources[sourceRule.effect_envelope.source] = source;
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
  const outcomes = Array.isArray(existing?.outcomes)
    ? existing.outcomes.filter((entry) => !isRecord(entry) || entry.outcome !== input.outcome)
    : [];
  const policy: RuntimeSupervisedWorkerOutcomePolicy = {
    outcome: input.outcome,
    action_boundary_digest: input.activation.authority.action_boundary.digest,
    mode: "supervised_worker",
    ...DEFAULT_SEMANTIC_WORKER_LIMITS,
    write_url_env: environmentName(input.writeUrlEnv),
    require_least_privilege_writer: true,
    writer_posture_fingerprint: input.writerPostureFingerprint,
    ...(input.workerIdentity ? { worker_identity: safeWorkerIdentity(input.workerIdentity) } : {}),
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
    ? worker.outcomes.filter((entry) => !isRecord(entry)
      || !outcomes.has(String(entry.outcome))
      || entry.action_boundary_digest === draft.authority.action_boundary.digest)
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
