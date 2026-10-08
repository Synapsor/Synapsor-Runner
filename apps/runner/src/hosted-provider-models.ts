import { Buffer } from "node:buffer";
import { isFixedOpenRouterModel, type HostedProvider } from "./hosted-provider-settings.js";

export type HostedModelProvider = HostedProvider;

export type HostedProviderModel = {
  id: string;
  created_at?: string;
  created?: number;
};

/**
 * Lists bounded, text/tool-capable model candidates from fixed hosted
 * provider endpoints. Credentials are used only as request headers and are
 * never returned, logged, or persisted.
 */
export async function discoverHostedProviderModels(input: {
  provider: HostedModelProvider;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string[]> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) return [];
  const endpoint = input.provider === "openai"
    ? "https://api.openai.com/v1/models"
    : input.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/models"
      : "https://api.anthropic.com/v1/models?limit=100";
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    redirect: "error",
    headers: input.provider !== "anthropic"
      ? {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        }
      : {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
    signal: AbortSignal.timeout(input.timeoutMs ?? 4_000),
  });
  if (!response.ok) return [];
  const maxBytes = input.provider === "openrouter" ? 2_097_152 : 262_144;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    return [];
  }
  const reader = response.body?.getReader();
  if (!reader) return [];
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); return []; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const models = value.data.flatMap((item): HostedProviderModel[] => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const id = item.id.trim();
    if (input.provider === "openrouter") {
      const parameters = item.supported_parameters;
      if (!isFixedOpenRouterModel(id) || !Array.isArray(parameters)
        || !["tools", "tool_choice", "max_tokens"].every((key) => parameters.includes(key))
        || !isRecord(item.architecture)
        || !Array.isArray(item.architecture.input_modalities) || !item.architecture.input_modalities.includes("text")
        || !Array.isArray(item.architecture.output_modalities) || !item.architecture.output_modalities.includes("text")) return [];
    } else return []; // These catalogs supply IDs without tool/modality capability facts.
    return [{
      id,
      ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
      ...(typeof item.created === "number" && Number.isFinite(item.created) ? { created: item.created } : {}),
    }];
  });
  models.sort((left, right) => modelTime(right) - modelTime(left) || left.id.localeCompare(right.id));
  return [...new Set(models.map((model) => model.id))].slice(0, 20);
}

function modelTime(model: HostedProviderModel): number {
  if (model.created !== undefined) return model.created * 1_000;
  if (model.created_at) {
    const parsed = Date.parse(model.created_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
