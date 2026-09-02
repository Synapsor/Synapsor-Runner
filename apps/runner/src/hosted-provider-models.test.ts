import { describe, expect, it, vi } from "vitest";
import { discoverHostedProviderModels } from "./hosted-provider-models.js";

describe("hosted provider model discovery", () => {
  it("sorts compatible OpenAI text models newest first and excludes non-chat surfaces", async () => {
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
    })).resolves.toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer secret-key" }),
    }));
  });

  it("lists Anthropic Claude models and sends the supported API version header", async () => {
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
    })).resolves.toEqual(["claude-opus-latest", "claude-sonnet-current"]);
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
        id: `gpt-5-test-${String(index).padStart(2, "0")}`,
        created: index,
      })),
    }), { status: 200 }));

    const models = await discoverHostedProviderModels({
      provider: "openai",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(models).toHaveLength(20);
    expect(models[0]).toBe("gpt-5-test-34");
    expect(models.at(-1)).toBe("gpt-5-test-15");
  });
});
