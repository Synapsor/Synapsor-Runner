import { assertValidContract } from "./validate.js";
import type { JsonValue, SynapsorContract } from "./types.js";

export function normalizeContract(input: unknown): SynapsorContract {
  assertValidContract(input);
  return sortJson(input) as SynapsorContract;
}

function sortJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson) as JsonValue;
  if (!value || typeof value !== "object") return value as JsonValue;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of entries) output[key] = sortJson(child);
  return output;
}
