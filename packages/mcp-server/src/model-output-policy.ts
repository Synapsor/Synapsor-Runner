import type { RuntimeConfig } from "./runtime-types.js";

export type ModelAuthorityMetadataMode = "semantic" | "exact";

const EXACT_MODEL_METADATA_KEYS = new Set([
  "query_audit_handle",
]);

const EXACT_MODEL_METADATA_KEY_SUFFIX = /(?:^|_)(?:digest|digests|fingerprint|fingerprints|hash|hashes)$/u;
const OPAQUE_SOURCE_VALUE_KEYS = new Set([
  "after",
  "before",
  "data",
  "diff",
  "patch",
  "proposed",
]);

export function modelAuthorityMetadataMode(
  config: Pick<RuntimeConfig, "model_output"> | undefined,
): ModelAuthorityMetadataMode {
  return config?.model_output?.authority_metadata === "exact" ? "exact" : "semantic";
}

export function projectAuthorityMetadataForModel(
  input: Record<string, unknown>,
  mode: ModelAuthorityMetadataMode,
): {
  value: Record<string, unknown>;
  withheld: boolean;
} {
  if (mode === "exact") {
    return { value: structuredClone(input), withheld: false };
  }
  let withheld = false;
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (!isRecord(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (EXACT_MODEL_METADATA_KEYS.has(key) || EXACT_MODEL_METADATA_KEY_SUFFIX.test(key)) {
        withheld = true;
        continue;
      }
      // Source rows and reviewed proposal values are not metadata. Preserve
      // their keys and values even when an application column happens to be
      // named "digest" or contains a string with a sha256 prefix.
      output[key] = OPAQUE_SOURCE_VALUE_KEYS.has(key) ? structuredClone(item) : project(item);
    }
    return output;
  };
  return {
    value: project(input) as Record<string, unknown>,
    withheld,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
