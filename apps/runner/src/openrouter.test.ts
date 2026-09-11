import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, secureAskJsonRequest, WorkbenchAskSession, type AskProviderDependencies, type AskToolGateway } from "./model-ask.js";
import { discoverHostedProviderModels } from "./hosted-provider-models.js";
import { DEFAULT_OPENROUTER_MODEL, defaultProviderKeyEnv, OPENROUTER_CHAT_ENDPOINT } from "./hosted-provider-settings.js";
import { conventionalModelAuthoringSession } from "./action-tui.js";
import { promptBoundaryMappingModel } from "./boundary-commands.js";
import { choosePostActivationAskSelection, soleConfiguredHostedSelection } from "./post-activation-ask.js";
import { providerDisplayLabel, resolveAskModel } from "./try-ask.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const secret = "openrouter-test-secret-not-for-persistence";
const definitions = [{ name: "runner.save_draft", description: "Validate and save a disabled draft.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }];
const digest = askToolSurfaceDigest(definitions);
const input = { provider: "openrouter" as const, model: DEFAULT_OPENROUTER_MODEL, api_key_env: "OPENROUTER_API_KEY", egress_acknowledged: true, authority_digest: digest };
const resolve = (overrides: Partial<typeof input> = {}) => resolveAskProviderConfiguration({ ...input, ...overrides }, { OPENROUTER_API_KEY: secret }, new Date());

describe("first-class OpenRouter", () => {
  it("preserves the selected provider through a saved job and bounded Read validation correction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-openrouter-resume-"));
    const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: digest,
      schema_fingerprint: digest, role_posture_fingerprint: digest };
    try {
      const saved = buildBoundaryAuthoringResumeState({ binding, stage: "read_mapping", jobIntent: "Show my offered seats.",
        provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL, intendedClient: "claude-code",
        conversation: [{ question: "Which offers?", answer: "My current reserved seats." }] });
      await writeBoundaryAuthoringResumeState(root, saved);
      const resumed = await readBoundaryAuthoringResumeState(root, binding);
      expect(resumed).toEqual({ status: "ready", value: saved });
      expect(JSON.stringify(resumed)).not.toContain(secret);
      const resources = JSON.parse(await fs.readFile(new URL("./test-fixtures/university-waitlist-discovery-resource.json", import.meta.url), "utf8"));
      const boundary: ExplorationBoundaryDraft = { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
        deployment_profile: "staging", source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
        trusted_context: { provider: "environment", tenant_env: "ACCOUNT", principal_env: "USER" },
        generation_lock_fingerprint: digest, role_posture_fingerprint: digest,
        budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [], pack: { name: binding.boundary_name, resources } };
      const before = structuredClone(boundary);
      const bodies: Record<string, unknown>[] = [];
      const result = await generateModelReadWorkload({ name: "student_offers", allowedQuestions: [saved.job_intent],
        provider: saved.model.provider, model: saved.model.name, generatedBoundary: boundary, egressAcknowledged: true,
        env: { OPENROUTER_API_KEY: secret }, deferNarration: true, dependencies: { requestJson: async (request) => {
          bodies.push(request.body);
          expect(request.endpoint.href).toBe(OPENROUTER_CHAT_ENDPOINT);
          expect(request.headers.authorization).toBe(`Bearer ${secret}`);
          expect(request.body.model).toBe(DEFAULT_OPENROUTER_MODEL);
          const name = (request.body.tools as Array<{ function: { name: string } }>)[0]!.function.name;
          return { status: 200, body: { choices: [{ message: { content: null, tool_calls: [{ id: `draft${bodies.length}`, type: "function",
            function: { name, arguments: JSON.stringify({ allowed: [{ id: bodies.length === 1 ? "BAD ID" : "offered_seats",
              description: "My offered seats", plan: { kind: "rows", resource: "university.waitlist_offers", select: ["offer_state"] } }], forbidden: [] }) } }] } }] } };
        } } });
      expect(result.analysis.status).toBe("ready");
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).toContain("correction");
      expect(result.authority_granted).toBe(false);
      expect(boundary).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("cancels in-flight provider work without saving a returned tool or making another request", async () => {
    const controller = new AbortController();
    const callTool = vi.fn();
    const requestJson = vi.fn(async () => {
      controller.abort();
      return { status: 200, body: { choices: [{ message: { content: null, tool_calls: [{ id: "after_abort", type: "function",
        function: { name: "runner__save_draft", arguments: '{"name":"must-not-save"}' } }] } }] } };
    });
    await expect(runAskProviderTurn({ configuration: resolve(), question: "Prepare draft", history: [], tools: definitions,
      gateway: { mode: "authoring", listTools: () => definitions, callTool, close: async () => {} },
      authorityDigest: digest, signal: controller.signal, dependencies: { requestJson } })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("uses only its own key and fixed endpoint and keeps public state secret-free", () => {
    const configuration = resolve();
    expect(configuration.endpoint.href).toBe(OPENROUTER_CHAT_ENDPOINT);
    expect(configuration.apiKey).toBe(secret);
    expect(defaultProviderKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(() => resolveAskProviderConfiguration(input, { OPENAI_API_KEY: secret }, new Date())).toThrow(/requires.*key/i);
    expect(() => resolve({ egress_acknowledged: false })).toThrow(/Acknowledge/);
    expect(() => resolveAskProviderConfiguration({ ...input, base_url: "https://example.com" }, { OPENROUTER_API_KEY: secret }, new Date())).toThrow(/fixed API endpoint/);
    const session = new WorkbenchAskSession();
    const status = session.configure({ ...input, api_key_env: undefined, api_key: secret });
    expect(status.provider).toBe("openrouter");
    expect(JSON.stringify([status, session.status()])).not.toContain(secret);
    expect(providerDisplayLabel("openrouter", "official_remote")).toContain("serving provider");
    expect(resolveAskModel("openrouter", undefined)).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(conventionalModelAuthoringSession({ OPENROUTER_API_KEY: secret })).toMatchObject({ provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" });
    expect(conventionalModelAuthoringSession({ OPENROUTER_API_KEY: secret, OPENAI_API_KEY: secret })).toBeUndefined();
    expect(soleConfiguredHostedSelection({ OPENROUTER_API_KEY: secret })).toEqual({ route: "openrouter", model: DEFAULT_OPENROUTER_MODEL });
  });

  it.each(["openrouter/auto", "openrouter/free", "openai/gpt-5.6-terra:batch", "openai/gpt-5.6-terra:online", "gpt-5.6-terra", "@preset/private"])("refuses implicit routing or incompatible mode %s", (model) => {
    expect(() => resolve({ model })).toThrow(/specific OpenRouter|model identifier is invalid/);
  });

  it("selects explicit OpenRouter credentials and model in the guided picker", async () => {
    const result = await promptBoundaryMappingModel({
      chooseOption: async (title, choices) => {
        if (title === "CHOOSE A MODEL FOR BOUNDARY DRAFTING") {
          expect(choices.find((choice) => choice.value === "openrouter")?.detail).toContain("serving provider");
          return "openrouter";
        }
        return DEFAULT_OPENROUTER_MODEL;
      },
      promptText: async (label) => { expect(label).toContain("OPENROUTER_API_KEY"); return ""; },
    }, undefined, {
      env: { OPENAI_API_KEY: "wrong-provider-key", OPENROUTER_API_KEY: secret },
      discoverModels: async () => [],
      discoverHostedModels: async (request) => { expect(request).toEqual({ provider: "openrouter", apiKey: secret }); return [DEFAULT_OPENROUTER_MODEL]; },
    });
    expect(result).toEqual({ provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL, apiKeyEnv: "OPENROUTER_API_KEY" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await choosePostActivationAskSelection({
      env: { OPENROUTER_API_KEY: secret }, chooseRoute: async () => "openrouter",
      listHostedModels: async () => [DEFAULT_OPENROUTER_MODEL],
      chooseHostedModel: async (models) => models[0],
      promptWithDefault: async () => { throw new Error("No raw model-ID prompt expected"); },
    })).toEqual({ route: "openrouter", model: DEFAULT_OPENROUTER_MODEL });
  });

  it("filters catalog by advertised text/tool contract and accepts a realistically sized bounded catalog", async () => {
    const model = { id: DEFAULT_OPENROUTER_MODEL, supported_parameters: ["tools", "tool_choice", "max_tokens"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      expect(init.headers.authorization).toBe(`Bearer ${secret}`);
      expect(init.redirect).toBe("error");
      return new Response(JSON.stringify({ padding: "x".repeat(750_000), data: [model,
        { ...model, id: "openrouter/auto" }, { ...model, id: "test/no-tools", supported_parameters: ["max_tokens"] },
        { ...model, id: "test/audio-only", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
        { ...model, id: "openai/gpt-5.6-terra:batch" },
      ] }));
    }) as unknown as typeof fetch;
    expect(await discoverHostedProviderModels({ provider: "openrouter", apiKey: secret, fetchImpl })).toEqual([DEFAULT_OPENROUTER_MODEL]);
    expect(await discoverHostedProviderModels({ provider: "openrouter", apiKey: secret, fetchImpl: async () => new Response("x".repeat(2_097_153)) })).toEqual([]);
  });

  it("keeps routing restrictions, forced tool choice and private continuation across a validated tool round trip", async () => {
    const continuation = [{ type: "reasoning.encrypted", data: "private-provider-continuation", index: 0 }];
    const calls: string[] = [];
    const gateway: AskToolGateway = { mode: "authoring", listTools: () => definitions,
      callTool: async (name) => { calls.push(name); return { ok: true, value: { saved: true, authority_granted: false } }; }, close: async () => {} };
    const bodies: Record<string, unknown>[] = [];
    const requestJson: AskProviderDependencies["requestJson"] = async (request) => {
      expect(request.endpoint.href).toBe(OPENROUTER_CHAT_ENDPOINT);
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      expect(request.body.provider).toEqual({ require_parameters: true, allow_fallbacks: false, data_collection: "deny" });
      expect(request.body.model).toBe(DEFAULT_OPENROUTER_MODEL);
      expect(request.body).not.toHaveProperty("temperature");
      expect(request.body).not.toHaveProperty("parallel_tool_calls");
      expect(request.body).toHaveProperty("max_tokens");
      bodies.push(request.body);
      if (bodies.length === 1) {
        const name = (request.body.tools as Array<{ function: { name: string } }>)[0]!.function.name;
        expect(request.body.tool_choice).toEqual({ type: "function", function: { name } });
        return { status: 200, body: { choices: [{ message: { content: null, reasoning_details: continuation, tool_calls: [{ id: "draft1", type: "function", function: { name, arguments: '{"name":"registration"}' } }] } }] } };
      }
      const messages = request.body.messages as Array<Record<string, unknown>>;
      expect(messages.find((message) => message.role === "assistant")?.reasoning_details).toEqual(continuation);
      expect(messages.some((message) => message.role === "tool")).toBe(true);
      return { status: 200, body: { choices: [{ message: { content: "The disabled draft is saved." } }] } };
    };
    const result = await runAskProviderTurn({ configuration: resolve(), question: "Prepare a registration change.", history: [], tools: definitions, gateway,
      authorityDigest: digest, signal: new AbortController().signal, requiredInitialToolName: definitions[0]!.name, conversationalAuthoring: true, dependencies: { requestJson } });
    expect(calls).toEqual(["runner.save_draft"]);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("private-provider-continuation");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["length", "content_filter", "error"])("does not execute a tool from a %s response", async (finish_reason) => {
    const callTool = vi.fn();
    await expect(runAskProviderTurn({ configuration: resolve(), question: "Prepare draft", history: [], tools: definitions,
      gateway: { mode: "authoring", listTools: () => definitions, callTool, close: async () => {} }, authorityDigest: digest, signal: new AbortController().signal,
      dependencies: { requestJson: async () => ({ status: 200, body: { choices: [{ finish_reason, message: { content: "Incomplete" } }] } }) },
    })).rejects.toMatchObject({ code: "ASK_PROVIDER_RESPONSE_INCOMPLETE" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("assembles the real SSE wire format without displaying private reasoning and refuses mid-stream errors", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write(": OPENROUTER PROCESSING\n\n");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "private-chunk", index: 0 }] } }] })}\n\n`);
      if (request.url === "/error") {
        response.end(`data: ${JSON.stringify({ choices: [{ error: { message: "private-error" }, finish_reason: "error" }] })}\n\n`); return;
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Draft ready." }, finish_reason: "stop" }], usage: { total_tokens: 8 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const events: unknown[] = [];
      const request = (pathname: string) => secureAskJsonRequest({ endpoint: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`),
        scope: "custom_loopback", headers: {}, body: {}, signal: new AbortController().signal, stream: { format: "openai_chat", onEvent: (event) => events.push(event) } });
      const result = await request("/ok");
      expect(result.body.choices).toMatchObject([{ message: { content: "Draft ready.", reasoning_details: [{ data: "private-chunk" }] } }]);
      expect(JSON.stringify(events)).not.toContain("private-chunk");
      await expect(request("/error")).rejects.toMatchObject({ code: "ASK_PROVIDER_RESPONSE_INCOMPLETE" });
      expect(JSON.stringify(events)).not.toContain("private-error");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
