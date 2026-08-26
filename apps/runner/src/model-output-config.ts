import fs from "node:fs/promises";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
