import { Buffer } from "node:buffer";

export type HostedModelProvider = "openai" | "anthropic";

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
    : "https://api.anthropic.com/v1/models?limit=100";
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    redirect: "error",
    headers: input.provider === "openai"
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
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 262_144) return [];
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 262_144) return [];
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const models = value.data.flatMap((item): HostedProviderModel[] => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const id = item.id.trim();
    if (!safeModelId(id) || !compatibleModelId(input.provider, id)) return [];
    return [{
      id,
      ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
      ...(typeof item.created === "number" && Number.isFinite(item.created) ? { created: item.created } : {}),
    }];
  });
  models.sort((left, right) => modelTime(right) - modelTime(left) || left.id.localeCompare(right.id));
  return [...new Set(models.map((model) => model.id))].slice(0, 20);
}

function safeModelId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,159}$/iu.test(id);
}

function compatibleModelId(provider: HostedModelProvider, id: string): boolean {
  const normalized = id.toLowerCase();
  if (provider === "anthropic") return /^claude-/u.test(normalized);
  if (!/^(?:gpt-|o[1345](?:-|$)|codex-)/u.test(normalized)) return false;
  return !/(?:audio|realtime|transcrib|tts|whisper|embedding|moderation|image|dall-e|search-preview)/u.test(normalized);
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
