import fs from "node:fs/promises";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import type { ModelAuthorityMetadataMode } from "@synapsor-runner/mcp-server";

export async function readModelAuthorityMetadataMode(
  configPath: string,
): Promise<ModelAuthorityMetadataMode> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    const modelOutput = isRecord(parsed) && isRecord(parsed.model_output)
      ? parsed.model_output
      : undefined;
    return modelOutput?.authority_metadata === "exact" ? "exact" : "semantic";
  } catch {
    // This preference never grants authority. Preserve the pre-existing
    // authoring path and use the privacy-preserving default when an optional
    // config is absent, stale, unreadable, or malformed.
    return "semantic";
  }
}

export async function updateModelAuthorityMetadataMode(input: {
  configPath: string;
  mode: ModelAuthorityMetadataMode;
}): Promise<{
  authority_metadata: ModelAuthorityMetadataMode;
  changed: boolean;
}> {
  const parsed = await readValidatedConfig(input.configPath);
  const current = configuredMode(parsed);
  if (current === input.mode) {
    return { authority_metadata: current, changed: false };
  }
  parsed.model_output = { authority_metadata: input.mode };
  const after = validateRunnerCapabilityConfig(parsed);
  if (!after.ok) {
    throw new Error(
      `Refused to write an invalid Runner config: ${formatConfigIssues(after.errors)}`,
    );
  }
  await writeJsonAtomically(input.configPath, parsed);
  return { authority_metadata: input.mode, changed: true };
}

async function readValidatedConfig(configPath: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read Runner config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot change model output because ${configPath} is not a JSON object.`);
  }
  const validation = validateRunnerCapabilityConfig(parsed);
  if (!validation.ok) {
    throw new Error(
      `Cannot change model output because the Runner config is invalid: ${formatConfigIssues(validation.errors)}`,
    );
  }
  return parsed;
}

function configuredMode(config: Record<string, unknown>): ModelAuthorityMetadataMode {
  return isRecord(config.model_output)
    && config.model_output.authority_metadata === "exact"
    ? "exact"
    : "semantic";
}

function formatConfigIssues(
  issues: Array<{ path: string; code: string }>,
): string {
  return issues.map((issue) => `${issue.path} ${issue.code}`).join(", ");
}

async function writeJsonAtomically(
  destination: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    const existingMode = (await fs.stat(destination)).mode & 0o777;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: existingMode,
    });
    await fs.chmod(temporary, existingMode);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
