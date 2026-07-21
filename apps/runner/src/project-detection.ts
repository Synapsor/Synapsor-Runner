import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectDetectionSummary } from "./onboarding-artifacts.js";

const schemaCandidates: Array<{ kind: "prisma" | "drizzle" | "openapi" | "synapsor"; paths: string[] }> = [
  { kind: "prisma", paths: ["prisma/schema.prisma", "schema.prisma"] },
  { kind: "drizzle", paths: ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs", "src/schema.ts", "src/db/schema.ts"] },
  { kind: "openapi", paths: ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"] },
  { kind: "synapsor", paths: ["synapsor.runner.json", "synapsor.contract.json", "contract.synapsor.sql", "contract.synapsor"] },
];

const databaseEnvPattern = /^(?:DATABASE_URL|POSTGRES(?:QL)?_URL|MYSQL_URL|DB_URL|SYNAPSOR_DATABASE_(?:READ|WRITE)_URL)$/;

export async function detectProjectContext(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectDetectionSummary> {
  const resolvedRoot = path.resolve(root);
  const schemaInputs: ProjectDetectionSummary["schema_inputs"] = [];
  for (const candidate of schemaCandidates) {
    for (const relativePath of candidate.paths) {
      if (await isRegularFile(path.join(resolvedRoot, relativePath))) {
        schemaInputs.push({ kind: candidate.kind, path: normalizeRelative(relativePath) });
      }
    }
  }

  const packageJson = await readJsonObject(path.join(resolvedRoot, "package.json"));
  const dependencyNames = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const values = packageJson?.[field];
    if (isRecord(values)) for (const name of Object.keys(values)) dependencyNames.add(name);
  }
  const frameworks = [
    ...(packageJson ? ["node"] : []),
    ...(dependencyNames.has("next") ? ["nextjs"] : []),
    ...(dependencyNames.has("@prisma/client") || dependencyNames.has("prisma") ? ["prisma"] : []),
    ...(dependencyNames.has("drizzle-orm") || dependencyNames.has("drizzle-kit") ? ["drizzle"] : []),
    ...(dependencyNames.has("fastify") ? ["fastify"] : []),
    ...(dependencyNames.has("express") ? ["express"] : []),
  ];
  const exampleEnvNames = await readEnvironmentNames(path.join(resolvedRoot, ".env.example"));
  const processEnvNames = Object.keys(env).filter((name) => databaseEnvPattern.test(name));
  const packageManager = await detectPackageManager(resolvedRoot);

  return {
    root: resolvedRoot,
    ...(packageManager ? { package_manager: packageManager } : {}),
    frameworks: unique(frameworks),
    schema_inputs: uniqueBy(schemaInputs, (item) => `${item.kind}:${item.path}`),
    database_env_names: unique([...processEnvNames, ...exampleEnvNames].filter((name) => databaseEnvPattern.test(name))).sort(),
  };
}

export function formatProjectDetection(summary: ProjectDetectionSummary): string {
  const lines = [
    "Detected project context (files were inspected; adopter code was not executed):",
    `  root: ${summary.root}`,
    `  package manager: ${summary.package_manager ?? "not detected"}`,
    `  frameworks: ${summary.frameworks.join(", ") || "not detected"}`,
    `  schema inputs: ${summary.schema_inputs.map((item) => `${item.kind}:${item.path}`).join(", ") || "none"}`,
    `  database env names: ${summary.database_env_names.join(", ") || "none in process/.env.example"}`,
    "  .env values were not read.",
  ];
  return `${lines.join("\n")}\n`;
}

async function detectPackageManager(root: string): Promise<ProjectDetectionSummary["package_manager"]> {
  if (await isRegularFile(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await isRegularFile(path.join(root, "yarn.lock"))) return "yarn";
  if (await isRegularFile(path.join(root, "bun.lock")) || await isRegularFile(path.join(root, "bun.lockb"))) return "bun";
  if (await isRegularFile(path.join(root, "package-lock.json"))) return "npm";
  return undefined;
}

async function readEnvironmentNames(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((value): value is string => Boolean(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
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

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
