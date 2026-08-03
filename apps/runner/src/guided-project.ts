import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { AutoBoundaryBuild } from "./auto-boundary.js";

export const GUIDED_ONBOARDING_VERSION = "synapsor.guided-onboarding.v1";

export type GuidedOnboardingStep =
  | "connected"
  | "classified"
  | "boundary_generated"
  | "boundary_active"
  | "first_safe_read"
  | "aggregate_complete"
  | "protected"
  | "action_drafted"
  | "proposal_created";

export type GuidedOnboardingState = {
  schema_version: typeof GUIDED_ONBOARDING_VERSION;
  status: "review_boundary" | "boundary_active" | "first_value" | "protect" | "add_action" | "proposal_ready";
  started_at: string;
  updated_at: string;
  source: {
    engine: "postgres" | "mysql";
    environment_variable: string;
    schema_fingerprint: `sha256:${string}`;
    role_posture_fingerprint: `sha256:${string}`;
  };
  artifacts: {
    boundary_root: string;
    runner_config: string;
    local_store: string;
    generation_lock: string;
    review_report: string;
    mcp_directory: string;
    writeback_setup_plan: string;
    action_drafts: string;
  };
  completed_steps: GuidedOnboardingStep[];
  authority_active: boolean;
  source_database_changed: false;
  recommended_next_action: string;
  instant_onboarding?: boolean;
  graduation_tip_suppressed?: boolean;
  graduation_tip_shown_at?: string;
};

export type GuidedProjectResult = {
  created: boolean;
  state: GuidedOnboardingState;
  state_path: string;
  config_path: string;
  store_path: string;
  environment_path: string;
  mcp_directory: string;
};

type GuidedBuild = Pick<AutoBoundaryBuild, "graph" | "lock" | "exploration_boundary" | "review">;

type GuidedProjectPaths = ReturnType<typeof guidedProjectPaths>;

export async function preflightGuidedProjectInitialization(projectRootInput: string): Promise<{
  project_root: string;
  resumable: boolean;
}> {
  const projectRoot = path.resolve(projectRootInput);
  const existingState = await readGuidedOnboardingState(projectRoot);
  if (existingState) return { project_root: projectRoot, resumable: true };
  const paths = guidedProjectPaths(projectRoot);
  await assertTargetsAbsent([
    paths.statePath,
    paths.configPath,
    paths.storePath,
    ...paths.mcpPaths,
    paths.writebackSetupPath,
    paths.actionDraftsPath,
  ]);
  await assertEnvironmentExampleCanBeExtended(paths.environmentPath);
  return { project_root: projectRoot, resumable: false };
}

export async function initializeGuidedProject(input: {
  projectRoot: string;
  build: GuidedBuild;
  runnerVersion: string;
  force?: boolean;
  now?: string;
  instantOnboarding?: boolean;
  suppressGraduationTip?: boolean;
}): Promise<GuidedProjectResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const paths = guidedProjectPaths(projectRoot);
  const existingState = await readGuidedOnboardingState(projectRoot);
  if (existingState) {
    return resultFor(projectRoot, existingState, false);
  }
  if (input.force && !existingState) {
    throw new Error("Refusing to replace project files because this directory is not marked as a Synapsor guided-onboarding project.");
  }
  await preflightGuidedProjectInitialization(projectRoot);

  const sourceName = input.build.exploration_boundary.source;
  const trustedContext = input.build.exploration_boundary.trusted_context;
  const principalRequired = input.build.exploration_boundary.pack.resources
    .some((resource) => Boolean(resource.principal_key));
  const config = {
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      [sourceName]: {
        engine: input.build.graph.engine,
        read_url_env: input.build.lock.source_env,
        read_only: true,
        statement_timeout_ms: input.build.exploration_boundary.budgets.statement_timeout_ms,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: trustedContext.tenant_env,
        ...(principalRequired ? { principal_env: trustedContext.principal_env } : {}),
      },
      tenant_binding: "tenant_id",
      ...(principalRequired ? { principal_binding: "principal" } : {}),
    },
    capabilities: [],
    generated_authority: {
      generation_lock_path: "./.synapsor/generation-lock.json",
      enforcement: "required",
      ...(input.build.lock.reporting_timezone
        ? { reporting_timezone: input.build.lock.reporting_timezone }
        : {}),
    },
    strict: true,
    result_format: 2,
  };
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`Generated authoring config is invalid: ${validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  }

  const packageRef = `@synapsor/runner@${input.runnerVersion}`;
  const commandArgs = [
    "-y",
    packageRef,
    "mcp",
    "serve",
    "--authoring",
    "--project-root",
    ".",
  ];
  const stdioConfig = {
    mcpServers: {
      synapsor_authoring: {
        command: "npx",
        args: commandArgs,
      },
    },
  };
  const codexToml = [
    "[mcp_servers.synapsor_authoring]",
    'command = "npx"',
    `args = ${JSON.stringify(commandArgs)}`,
    "",
  ].join("\n");
  const timestamp = input.now ?? new Date().toISOString();
  const state: GuidedOnboardingState = {
    schema_version: GUIDED_ONBOARDING_VERSION,
    status: "review_boundary",
    started_at: timestamp,
    updated_at: timestamp,
    source: {
      engine: input.build.graph.engine,
      environment_variable: input.build.lock.source_env,
      schema_fingerprint: input.build.lock.schema_fingerprint,
      role_posture_fingerprint: input.build.lock.role_posture_fingerprint,
    },
    artifacts: {
      boundary_root: "synapsor/generated",
      runner_config: "synapsor.runner.json",
      local_store: ".synapsor/local.db",
      generation_lock: ".synapsor/generation-lock.json",
      review_report: ".synapsor/review-report.json",
      mcp_directory: ".synapsor/mcp",
      writeback_setup_plan: ".synapsor/writeback-setup-plan.json",
      action_drafts: ".synapsor/guided-action-drafts.json",
    },
    completed_steps: ["connected", "classified", "boundary_generated"],
    authority_active: false,
    source_database_changed: false,
    recommended_next_action: "Review what the agent can see.",
    ...(input.instantOnboarding ? { instant_onboarding: true } : {}),
    ...(input.suppressGraduationTip ? { graduation_tip_suppressed: true } : {}),
  };

  const generatedFiles = new Map<string, string>([
    [paths.configPath, json(config)],
    [paths.mcpPaths[0]!, json(stdioConfig)],
    [paths.mcpPaths[1]!, json(stdioConfig)],
    [paths.mcpPaths[2]!, json(stdioConfig)],
    [paths.mcpPaths[3]!, codexToml],
    [paths.writebackSetupPath, json({
    schema_version: "synapsor.writeback-setup-plan.v1",
    state: "not_configured",
    source: sourceName,
    source_database_changed: false,
    production_execution: "plan_only",
    next_action: "Define and review a bounded action before selecting writeback authority.",
    })],
    [paths.actionDraftsPath, json({
    schema_version: "synapsor.guided-action-drafts.v1",
    state: "disabled",
    inferred_write_authority: false,
    structured_candidates: input.build.review.structured_actions,
    next_action: "Use Add a safe action after the first reviewed read.",
    })],
  ]);
  await commitGuidedProject({
    paths,
    generatedFiles,
    state,
    environmentContents: environmentExample(input.build),
  });

  return resultFor(projectRoot, state, true);
}

export async function readGuidedOnboardingState(projectRoot: string): Promise<GuidedOnboardingState | undefined> {
  const statePath = path.join(path.resolve(projectRoot), ".synapsor/guided-onboarding.json");
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as GuidedOnboardingState;
    if (parsed.schema_version !== GUIDED_ONBOARDING_VERSION) {
      throw new Error(`Unsupported guided-onboarding state at ${statePath}.`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function updateGuidedOnboardingState(input: {
  projectRoot: string;
  status?: GuidedOnboardingState["status"];
  completedStep?: GuidedOnboardingStep;
  completedSteps?: GuidedOnboardingStep[];
  authorityActive?: boolean;
  recommendedNextAction: string;
  now?: string;
}): Promise<GuidedOnboardingState> {
  const projectRoot = path.resolve(input.projectRoot);
  const current = await readGuidedOnboardingState(projectRoot);
  if (!current) throw new Error("Guided onboarding state is unavailable.");
  const requestedSteps = [
    ...(input.completedStep ? [input.completedStep] : []),
    ...(input.completedSteps ?? []),
  ];
  const completedSteps = requestedSteps.length
    ? [...new Set([...current.completed_steps, ...requestedSteps])]
    : current.completed_steps;
  const next: GuidedOnboardingState = {
    ...current,
    ...(input.status ? { status: input.status } : {}),
    ...(input.authorityActive === undefined ? {} : { authority_active: input.authorityActive }),
    completed_steps: completedSteps,
    updated_at: input.now ?? new Date().toISOString(),
    recommended_next_action: input.recommendedNextAction,
  };
  await writeAtomic(path.join(projectRoot, ".synapsor/guided-onboarding.json"), json(next));
  return next;
}

export async function consumeGuidedGraduationTip(input: {
  projectRoot: string;
  now?: string;
}): Promise<string | undefined> {
  const projectRoot = path.resolve(input.projectRoot);
  const current = await readGuidedOnboardingState(projectRoot);
  if (!current || current.graduation_tip_suppressed || current.graduation_tip_shown_at) {
    return undefined;
  }
  const timestamp = input.now ?? new Date().toISOString();
  const next: GuidedOnboardingState = {
    ...current,
    graduation_tip_shown_at: timestamp,
    updated_at: timestamp,
  };
  await writeAtomic(path.join(projectRoot, ".synapsor/guided-onboarding.json"), json(next));
  return "Install once: npm install -g @synapsor/runner. Then run synapsor-runner <command> without npx.";
}

export async function resetGuidedOnboardingForBoundaryReview(input: {
  projectRoot: string;
  schemaFingerprint: `sha256:${string}`;
  rolePostureFingerprint: `sha256:${string}`;
  now?: string;
}): Promise<GuidedOnboardingState> {
  const projectRoot = path.resolve(input.projectRoot);
  const current = await readGuidedOnboardingState(projectRoot);
  if (!current) throw new Error("Guided onboarding state is unavailable.");
  const next: GuidedOnboardingState = {
    ...current,
    status: "review_boundary",
    source: {
      ...current.source,
      schema_fingerprint: input.schemaFingerprint,
      role_posture_fingerprint: input.rolePostureFingerprint,
    },
    completed_steps: ["connected", "classified", "boundary_generated"],
    authority_active: false,
    source_database_changed: false,
    updated_at: input.now ?? new Date().toISOString(),
    recommended_next_action: "Review the changed boundary.",
  };
  await writeAtomic(path.join(projectRoot, ".synapsor/guided-onboarding.json"), json(next));
  return next;
}

function environmentExample(build: GuidedBuild): string {
  const trustedContext = build.exploration_boundary.trusted_context;
  const principalRequired = build.exploration_boundary.pack.resources
    .some((resource) => Boolean(resource.principal_key));
  const variables = [
    build.lock.source_env,
    trustedContext.tenant_env,
    ...(principalRequired ? [trustedContext.principal_env] : []),
    "SYNAPSOR_OPERATOR_ID",
  ];
  return [
    "# Runner does not load this file automatically. Export these values in the launching shell.",
    "# Never paste database credentials or trusted scope values into an agent chat.",
    ...[...new Set(variables)].map((name) => `${name}=`),
    "",
  ].join("\n");
}

function resultFor(projectRoot: string, state: GuidedOnboardingState, created: boolean): GuidedProjectResult {
  return {
    created,
    state,
    state_path: path.join(projectRoot, ".synapsor/guided-onboarding.json"),
    config_path: path.join(projectRoot, state.artifacts.runner_config),
    store_path: path.join(projectRoot, state.artifacts.local_store),
    environment_path: path.join(projectRoot, ".env.example"),
    mcp_directory: path.join(projectRoot, state.artifacts.mcp_directory),
  };
}

async function assertTargetsAbsent(targets: string[]): Promise<void> {
  for (const target of targets) {
    try {
      await fs.lstat(target);
      throw new Error([
        `Guided onboarding will not overwrite existing file ${target}.`,
        "Why it matters: an unmarked file may be application-owned and cannot be replaced safely.",
        "State preserved: the existing file, review state, and source database were not changed.",
        "Next: rerun the original start command and choose Resume if this is a managed project; otherwise move the conflicting file explicitly.",
      ].join("\n"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function guidedProjectPaths(projectRoot: string) {
  const stateDir = path.join(projectRoot, ".synapsor");
  const mcpDirectory = path.join(stateDir, "mcp");
  return {
    projectRoot,
    stateDir,
    statePath: path.join(stateDir, "guided-onboarding.json"),
    configPath: path.join(projectRoot, "synapsor.runner.json"),
    environmentPath: path.join(projectRoot, ".env.example"),
    storePath: path.join(stateDir, "local.db"),
    mcpDirectory,
    mcpPaths: [
      path.join(mcpDirectory, "cursor.json"),
      path.join(mcpDirectory, "claude.json"),
      path.join(mcpDirectory, "generic-stdio.json"),
      path.join(mcpDirectory, "codex.toml"),
    ],
    writebackSetupPath: path.join(stateDir, "writeback-setup-plan.json"),
    actionDraftsPath: path.join(stateDir, "guided-action-drafts.json"),
  };
}

async function assertEnvironmentExampleCanBeExtended(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Guided onboarding will not modify non-regular environment example ${filePath}.`);
    }
    if (stat.size > 1024 * 1024) {
      throw new Error(`Guided onboarding will not modify environment example larger than 1 MiB: ${filePath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function commitGuidedProject(input: {
  paths: GuidedProjectPaths;
  generatedFiles: Map<string, string>;
  state: GuidedOnboardingState;
  environmentContents: string;
}): Promise<void> {
  const { paths } = input;
  const stagingRoot = await createStagingRoot(paths);
  const stagedFiles = new Map<string, string>();
  const createdTargets: string[] = [];
  let environmentRollback: { existed: boolean; contents?: string } | undefined;
  try {
    for (const [target, contents] of input.generatedFiles) {
      const staged = path.join(stagingRoot, path.relative(paths.projectRoot, target));
      await writeStagedFile(staged, contents);
      stagedFiles.set(target, staged);
    }
    const stagedStore = path.join(stagingRoot, ".synapsor/local.db");
    await fs.mkdir(path.dirname(stagedStore), { recursive: true, mode: 0o700 });
    const store = new ProposalStore(stagedStore);
    store.close();
    stagedFiles.set(paths.storePath, stagedStore);
    const stagedState = path.join(stagingRoot, ".synapsor/guided-onboarding.json");
    await writeStagedFile(stagedState, json(input.state));

    // Recheck immediately before commit so a concurrent initializer cannot be overwritten.
    await preflightGuidedProjectInitialization(paths.projectRoot);
    for (const [target, staged] of stagedFiles) {
      await copyExclusive(staged, target);
      createdTargets.push(target);
    }
    environmentRollback = await extendEnvironmentExample(
      paths.environmentPath,
      input.environmentContents,
    );
    await copyExclusive(stagedState, paths.statePath);
    createdTargets.push(paths.statePath);
  } catch (error) {
    await Promise.all(createdTargets.reverse().map((target) => fs.rm(target, { force: true })));
    if (environmentRollback) {
      if (environmentRollback.existed) {
        await writeAtomic(paths.environmentPath, environmentRollback.contents ?? "");
      } else {
        await fs.rm(paths.environmentPath, { force: true });
      }
    }
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function createStagingRoot(paths: GuidedProjectPaths): Promise<string> {
  await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  return fs.mkdtemp(path.join(paths.stateDir, ".guided-init-"));
}

async function writeStagedFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function copyExclusive(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  await fs.chmod(target, 0o600);
}

export async function extendEnvironmentExample(
  filePath: string,
  generatedContents: string,
): Promise<{ existed: boolean; contents?: string }> {
  const requiredLines = generatedContents
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=$/.test(line));
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === undefined) {
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temporary, generatedContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await fs.copyFile(temporary, filePath, fsConstants.COPYFILE_EXCL);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { existed: false };
  }
  const declared = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((value): value is string => Boolean(value)),
  );
  const missing = requiredLines.filter((line) => !declared.has(line.slice(0, -1)));
  if (missing.length === 0) return { existed: true, contents: existing };
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const merged = [
    existing,
    separator,
    "# Synapsor Runner environment variable names (values stay in the launching shell).",
    ...missing,
    "",
  ].join("\n");
  await writeAtomic(filePath, merged);
  return { existed: true, contents: existing };
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
