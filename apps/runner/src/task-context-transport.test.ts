import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskContextMeter, type TaskContextProfile } from "@synapsor-runner/protocol";
import { resolveAskProviderConfiguration, runAskProviderTurn, secureAskJsonRequest, type AskToolDefinition } from "./model-ask.js";

// Local, labelled responses only: this exercises product encoders and transport,
// not admission or model correctness on either remote provider.
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
const authorityDigest = `sha256:${"1".repeat(64)}` as const;
const tools: AskToolDefinition[] = [{ name: "runner.context_probe", description: "Local inert context measurement probe.",
  input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } }];

describe("actual encoded task context boundary", () => {
  for (const provider of ["openai", "openrouter"] as const) {
    it(`observes the final ${provider} streaming envelope and completed JSON without rewriting it`, async () => {
      const captured: string[] = [], wireResponses: string[] = [], profiles: TaskContextProfile[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          const encoding = Buffer.concat(chunks).toString("utf8");
          captured.push(encoding);
          const body = JSON.parse(encoding);
          const toolName = provider === "openai" ? body.tools[0].name : body.tools[0].function.name;
          const args = JSON.stringify({ label: "雪\\\"" });
          const usage = provider === "openai" ? { input_tokens: 17, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } }
            : { prompt_tokens: 17, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 }, cost: 0.001 };
          const event = provider === "openai"
            ? { type: "response.completed", response: { id: "derived-local", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: toolName, arguments: args }], usage } }
            : { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: toolName, arguments: args } }] }, finish_reason: "tool_calls" }], usage };
          const wire = `data: ${JSON.stringify(event)}\n\n${provider === "openrouter" ? "data: [DONE]\n\n" : ""}`;
          wireResponses.push(wire);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(wire);
        });
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const configuration = resolveAskProviderConfiguration({ provider,
        model: provider === "openai" ? "gpt-5-mini" : "openai/gpt-5.6-terra", api_key: "inert-local-canary",
        authority_digest: authorityDigest, egress_acknowledged: true }, {}, new Date("2026-09-27T02:19:50Z"));
      const meter = createTaskContextMeter();
      const handled: unknown[] = [];
      const gateway = { mode: "authoring" as const, listTools: () => tools, close: async () => {},
        callTool: async (_name: string, args: Record<string, unknown>) => { handled.push(args); return { ok: true, value: { status: "derived-local-only" } }; } };
      for (let run = 0; run < 2; run++) {
        await runAskProviderTurn({ configuration, authorityDigest, tools, gateway, question: "Retain this exact task: 雪\\\".", history: [],
          providerSystemPrompt: "Keep the early exception and whole-program duties.", skipRunnerQuestionContext: true,
          signal: new AbortController().signal, requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
          dependencies: { onStream: () => {}, contextMeasurement: { meter, onProfile: profile => profiles.push(profile) },
            requestJson: input => secureAskJsonRequest({ ...input, endpoint: new URL(`http://127.0.0.1:${port}/local`), scope: "custom_loopback", headers: {} }) } });
      }
      expect(handled).toEqual([{ label: "雪\\\"" }, { label: "雪\\\"" }]);
      expect(captured).toHaveLength(2);
      const requests = profiles.filter(profile => profile.boundary === "provider_request");
      const completed = profiles.filter(profile => profile.boundary === "provider_completed_response");
      expect(requests).toHaveLength(2); expect(completed).toHaveLength(2);
      for (const [index, encoded] of captured.entries()) {
        const body = JSON.parse(encoded);
        expect(body.stream).toBe(true);
        expect(body).not.toHaveProperty("contextMeasurement");
        expect(body).not.toHaveProperty("onProfile");
        expect(requests[index]!.encoded_utf8_bytes).toBe(Buffer.byteLength(encoded));
        expect(requests[index]!.schema_bytes).toBe(Buffer.byteLength(JSON.stringify(body.tools)));
        expect(requests[index]!.actual_provider_sends).toBeNull();
        expect(completed[index]!.reported_usage).toMatchObject({ input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 0 });
        expect(completed[index]!.encoded_utf8_bytes).not.toBe(Buffer.byteLength(wireResponses[index]!));
      }
      expect(requests[1]!.repeated_conversation_bytes).toBeGreaterThan(0);
      expect(requests[1]!.new_conversation_bytes).toBe(0);
      expect(requests[1]!.cumulative_provider_request_bytes).toBe(captured.reduce((sum, text) => sum + Buffer.byteLength(text), 0));
      expect(JSON.stringify(profiles)).not.toContain("early exception");
      expect(JSON.stringify(profiles)).not.toContain("inert-local-canary");
      if (provider === "openai") {
        expect(JSON.parse(captured[0]!)).toMatchObject({ store: false, instructions: "Keep the early exception and whole-program duties.", parallel_tool_calls: false });
        expect(completed[0]!.reported_usage).not.toHaveProperty("cost_usd");
      } else {
        expect(JSON.parse(captured[0]!)).toMatchObject({ provider: { require_parameters: true, allow_fallbacks: false, data_collection: "deny" } });
        expect(completed[0]!.reported_usage?.cost_usd).toBe(0.001);
      }
    });
  }

  it("does not send when the observer refuses preparation or the lifetime was cancelled", async () => {
    let received = 0;
    const server = createServer((_request, response) => { received++; response.end("{}"); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const input = { endpoint: new URL(`http://127.0.0.1:${port}/local`), scope: "custom_loopback" as const, headers: {}, body: { model: "local", input: "unchanged" }, signal: new AbortController().signal };
    await expect(secureAskJsonRequest({ ...input, contextMeasurement: { meter: createTaskContextMeter(), onProfile: () => { throw new Error("local observation failure"); } } })).rejects.toThrow("local observation failure");
    const controller = new AbortController(); controller.abort();
    const observed: TaskContextProfile[] = [];
    await expect(secureAskJsonRequest({ ...input, signal: controller.signal, contextMeasurement: { meter: createTaskContextMeter(), onProfile: profile => observed.push(profile) } })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(received).toBe(0); expect(observed).toEqual([]);
  });
});
