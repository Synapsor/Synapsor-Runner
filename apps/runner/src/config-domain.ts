import { validateRunnerCapabilityConfig, type ConfigValidationResult } from "@synapsor-runner/config";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import path from "node:path";
import { readJsonFileWithLocation } from "./cli-files.js";


export async function validateConfigFile(configPath: string): Promise<ConfigValidationResult> {
  const parsed = await readJsonFileWithLocation<RuntimeConfig>(configPath, "Runner config");
  const raw = validateRunnerCapabilityConfig(parsed);
  if (!raw.ok) return raw;
  try {
    const resolved = resolveRuntimeConfig(parsed, path.dirname(path.resolve(configPath)));
    const resolvedValidation = validateRunnerCapabilityConfig(resolved);
    return {
      ok: resolvedValidation.ok,
      errors: resolvedValidation.errors,
      warnings: [...raw.warnings, ...resolvedValidation.warnings],
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        path: "$.contracts",
        code: "CONTRACT_RESOLUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }],
      warnings: raw.warnings,
    };
  }
}
