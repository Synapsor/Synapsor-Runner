import { describe, expect, it, vi } from "vitest";
import { discoverHostedProviderModels } from "./hosted-provider-models.js";

describe("hosted provider model discovery", () => {
  it.each(["openai", "anthropic"] as const)("B64 NEW9 I03575 leaves %s model-ID capability unknown without provider facts", async provider => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "gpt-text-tools", created: 1 }, { id: "claude-text-tools", created: 2 },
    ] }), { status: 200 }));
    expect(await discoverHostedProviderModels({ provider, apiKey: "inert-fixture", fetchImpl: fetchImpl as typeof fetch })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("B64 NEW9 I03575 uses actual OpenRouter modalities and tool parameters rather than ID fragments", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "vendor/audio-image-name", created: 2, supported_parameters: ["tools", "tool_choice", "max_tokens"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "openai/gpt-text-tools", created: 3 },
      { id: "vendor/plain", created: 4, supported_parameters: ["max_tokens"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    ] }), { status: 200 }));
    expect(await discoverHostedProviderModels({ provider: "openrouter", apiKey: "inert-fixture", fetchImpl: fetchImpl as typeof fetch }))
      .toEqual(["vendor/audio-image-name"]);
  });
  it("does not infer OpenAI compatibility from IDs and still sends authenticated discovery headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { id: "gpt-5.6-terra", created: 300 },
        { id: "gpt-5.6-luna", created: 200 },
        { id: "gpt-unsafe\nterminal", created: 600 },
        { id: "gpt-unsafe/route", created: 550 },
        { id: "text-embedding-3-large", created: 400 },
        { id: "gpt-4o-mini-transcribe", created: 500 },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(discoverHostedProviderModels({
      provider: "openai",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer secret-key" }),
    }));
  });

  it("leaves Anthropic ID-only compatibility unknown and sends the supported API version header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "claude-opus-latest", created_at: "2026-08-01T00:00:00Z" },
        { id: "claude-sonnet-current", created_at: "2026-07-01T00:00:00Z" },
        { id: "not-a-claude-model", created_at: "2026-09-01T00:00:00Z" },
      ],
    }), { status: 200 }));

    await expect(discoverHostedProviderModels({
      provider: "anthropic",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          "anthropic-version": "2023-06-01",
          "x-api-key": "secret-key",
        }),
      }),
    );
  });

  it("fails closed when provider discovery is unauthorized", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(discoverHostedProviderModels({
      provider: "openai",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual([]);
  });

  it("keeps the hosted picker bounded to the newest compatible candidates", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: Array.from({ length: 35 }, (_, index) => ({
        id: `vendor/model-${String(index).padStart(2, "0")}`,
        supported_parameters: ["tools", "tool_choice", "max_tokens"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        created: index,
      })),
    }), { status: 200 }));

    const models = await discoverHostedProviderModels({
      provider: "openrouter",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(models).toHaveLength(20);
    expect(models[0]).toBe("vendor/model-34");
    expect(models.at(-1)).toBe("vendor/model-15");
  });
});
