import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SynapsorProjectResolution = {
  source: "environment" | "discovered";
  project_root?: string;
  config_path: string;
  store_path?: string;
};

const CONFIG_ENV_NAMES = ["SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"] as const;
const STORE_ENV_NAME = "SYNAPSOR_LOCAL_STORE";

export async function resolveSynapsorProject(
  startDirectory = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SynapsorProjectResolution | undefined> {
  const configured = configuredPath(CONFIG_ENV_NAMES, env);
  if (configured) {
    return {
      source: "environment",
      config_path: configured,
      ...(nonEmpty(env[STORE_ENV_NAME]) ? { store_path: env[STORE_ENV_NAME] } : {}),
    };
  }

  const discovered = await discoverNearestProject(path.resolve(startDirectory));
  if (!discovered) return undefined;
  return {
    source: "discovered",
    project_root: discovered.projectRoot,
    config_path: discovered.configPath,
    store_path: await discoveredStorePath(discovered.projectRoot, discovered.configPath),
  };
}

async function discoverNearestProject(startDirectory: string): Promise<{
  projectRoot: string;
  configPath: string;
} | undefined> {
  let current = startDirectory;
  const home = path.resolve(os.homedir());
  while (true) {
    const candidates = await projectConfigCandidates(current);
    if (candidates.length > 1) {
      throw new Error([
        `Multiple Synapsor projects are valid at ${current}:`,
        ...candidates.map((candidate) => `  - ${candidate}`),
        "Pass --config <path> to choose one explicitly.",
      ].join("\n"));
    }
    if (candidates.length === 1) {
      return { projectRoot: current, configPath: candidates[0]! };
    }
    const parent = path.dirname(current);
    if (await isRepositoryBoundary(current) || current === home || parent === current) return undefined;
    current = parent;
  }
}

async function projectConfigCandidates(directory: string): Promise<string[]> {
  const candidates = new Set<string>();
  const conventional = path.join(directory, "synapsor.runner.json");
  if (await isRegularFile(conventional)) candidates.add(conventional);

  const statePath = path.join(directory, ".synapsor/guided-onboarding.json");
  if (await isRegularFile(statePath)) {
    const state = await readJsonObject(statePath);
    const artifacts = isRecord(state?.artifacts) ? state.artifacts : undefined;
    const recorded = nonEmpty(artifacts?.runner_config);
    if (recorded) {
      const resolved = resolveContained(directory, recorded);
      if (await isRegularFile(resolved)) candidates.add(resolved);
    }
  }
  return [...candidates].sort();
}

async function discoveredStorePath(projectRoot: string, configPath: string): Promise<string> {
  const config = await readJsonObject(configPath);
  const storage = isRecord(config?.storage) ? config.storage : undefined;
  const configured = nonEmpty(storage?.sqlite_path);
  return configured
    ? path.resolve(path.dirname(configPath), configured)
    : path.join(projectRoot, ".synapsor/local.db");
}

function configuredPath(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const configured = names
    .map((name) => ({ name, value: nonEmpty(env[name]) }))
    .filter((entry): entry is { name: string; value: string } => Boolean(entry.value));
  const values = [...new Set(configured.map((entry) => entry.value))];
  if (values.length > 1) {
    throw new Error(
      `${configured.map((entry) => entry.name).join(" and ")} point to different Runner configs. Keep one value or pass --config explicitly.`,
    );
  }
  return values[0];
}

function resolveContained(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Guided project config path escapes its project root: ${value}`);
  }
  return resolved;
}

async function isRepositoryBoundary(directory: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path.join(directory, ".git"));
    return (stat.isDirectory() || stat.isFile()) && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isRecord(parsed)) throw new Error(`Expected a JSON object in ${filePath}.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot discover Synapsor project because ${filePath} is invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
