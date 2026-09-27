import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeSupervisedWorkerOutcomePolicy } from "@synapsor-runner/mcp-server";
import { readOperatorExecutionConfig } from "./control-policy-execution.js";
import type { BoundProjectPolicyStore } from "./control-policy-store.js";

// Read-only governed configuration projection. Publication remains in semantic-action-deployment.
export const SEMANTIC_ACTION_RUNTIME_CONFIG = "synapsor.actions.runner.json";

export type SemanticSupervisedExecutionState = {
  enabled: boolean;
  config_path: string;
  policies: RuntimeSupervisedWorkerOutcomePolicy[];
};

export async function readSemanticSupervisedExecutionState(input: {
  projectRoot: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
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
  const { config } = await executionConfigForReview(projectRoot, configPath, await readJsonObject(configPath), undefined, input.env);
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

export async function executionConfigForReview(projectRoot: string, configPath: string, raw: Record<string, unknown>,
  policyStore?: BoundProjectPolicyStore, env?: NodeJS.ProcessEnv) {
  const reviewed = await readOperatorExecutionConfig({ projectRoot,
    config: resolveRuntimeConfig(raw as RuntimeConfig, path.dirname(configPath)), policyStore, env,
    storePath: path.resolve(path.dirname(configPath), (raw as RuntimeConfig).storage?.sqlite_path ?? ".synapsor/local.db") });
  if (reviewed.epoch === undefined) return { config: raw, digest: canonicalJsonDigest(raw) };
  const config = structuredClone(raw);
  delete config.supervised_worker;
  if (reviewed.config.supervised_worker) config.supervised_worker = reviewed.config.supervised_worker;
  return { config, epoch: reviewed.epoch, digest: canonicalJsonDigest({ config, policy_epoch: reviewed.epoch }) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
