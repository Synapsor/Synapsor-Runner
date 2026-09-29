import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, secureAskJsonRequest, type AskProviderDependencies } from "./model-ask.js";

const REASONING_BYTES = 512 * 1024;
const ARGUMENT_BYTES = 128 * 1024;
const tools = [{ name: "runner.save_draft", description: "Validate a disabled draft.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }];
const digest = askToolSurfaceDigest(tools);
const continuation = (bytes: number) => {
  const value = [{ type: "reasoning.encrypted", data: "private-continuation-", index: 0 }];
  value[0]!.data += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(value)));
  return value;
};
const argumentsOfSize = (bytes: number) => JSON.stringify({ name: "x".repeat(bytes - 11) });
const event = (response: ServerResponse, value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
async function serverRun(run: (endpoint: URL) => Promise<void>, respond: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { data += chunk; });
    request.on("end", () => respond(JSON.parse(data), response));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function configuration(provider: "openrouter" | "openai" | "anthropic" = "openrouter") {
  return resolveAskProviderConfiguration({ provider, model: provider === "openrouter" ? "test/reasoner" : provider === "openai" ? "gpt-5.6-terra" : "claude-sonnet-4-5", api_key: "synthetic-test-key", egress_acknowledged: true, authority_digest: digest, max_output_tokens: 12000 }, {}, new Date());
}
function turn(requestJson: AskProviderDependencies["requestJson"], options: { provider?: "openrouter" | "openai" | "anthropic"; conversational?: boolean; required?: boolean; onStream?: AskProviderDependencies["onStream"] } = {}) {
  const callTool = vi.fn(async () => ({ ok: true as const, value: { saved: true, authority_granted: false } }));
  const promise = runAskProviderTurn({ configuration: configuration(options.provider), question: "Prepare the disabled draft.", history: [], tools,
    gateway: { mode: "authoring", listTools: () => tools, callTool, close: async () => {} }, authorityDigest: digest,
    signal: new AbortController().signal, conversationalAuthoring: options.conversational,
    ...(options.required ? { requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true } : {}), dependencies: { requestJson, onStream: options.onStream } });
  return { promise, callTool };
}
const chatCall = (args: string, id = "call_1") => ({ id, type: "function", function: { name: "runner__save_draft", arguments: args } });
const chatReply = (args: string, reasoning_details?: unknown) => ({ choices: [{ message: { content: null, tool_calls: [chatCall(args)], ...(reasoning_details === undefined ? {} : { reasoning_details }) } }] });

// Synthetic transport reproductions of the recorded threshold, not captured model answers.
describe("bounded provider response assembly", () => {
  it.each([true, false])("replays a 512 KiB private continuation through the real request transport (stream=%s)", async stream => {
    const details = continuation(REASONING_BYTES); let requests = 0; const publicEvents: unknown[] = [];
    await serverRun(async endpoint => {
      const run = turn(request => secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {},
        ...(stream ? {} : { stream: undefined }) }), { conversational: true, onStream: e => publicEvents.push(e) });
      await expect(run.promise.then(result => JSON.stringify(result).includes("private-continuation-"))).resolves.toBe(false);
      expect(run.callTool).toHaveBeenCalledTimes(1);
    }, (body, response) => {
      requests++;
      expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false, data_collection: "deny" });
      expect(body.max_tokens).toBe(12000);
      if (requests === 2) {
        const assistant = (body.messages as Record<string, unknown>[]).find(m => m.role === "assistant");
        expect(JSON.stringify(assistant?.reasoning_details) === JSON.stringify(details)).toBe(true);
      }
      if (stream) {
        response.setHeader("content-type", "text/event-stream");
        if (requests === 1) {
          event(response, { choices: [{ delta: { reasoning_details: details } }] });
          event(response, { choices: [{ delta: { tool_calls: [{ index: 0, ...chatCall('{"name":"draft"}') }] }, finish_reason: "tool_calls" }] });
        } else event(response, { choices: [{ delta: { content: "Disabled draft saved." }, finish_reason: "stop" }] });
        response.end("data: [DONE]\n\n");
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(requests === 1 ? chatReply('{"name":"draft"}', details) : { choices: [{ message: { content: "Disabled draft saved." } }] }));
      }
    });
    expect(requests).toBe(2); expect(JSON.stringify(publicEvents)).not.toContain("private-continuation-");
  });

  it.each(["openrouter", "openai", "anthropic"] as const)("accepts exact 128 KiB tool arguments and rejects excess before execution (%s)", async provider => {
    for (const bytes of [ARGUMENT_BYTES, ARGUMENT_BYTES + 1]) {
      const args = argumentsOfSize(bytes); expect(Buffer.byteLength(args)).toBe(bytes);
      const body = provider === "anthropic" ? { content: [{ type: "tool_use", id: "call_1", name: "runner__save_draft", input: JSON.parse(args) }] }
        : provider === "openai" ? { output: [{ type: "function_call", call_id: "call_1", name: "runner__save_draft", arguments: args }] } : chatReply(args);
      const run = turn(async () => ({ status: 200, body }), { provider, required: true });
      if (bytes === ARGUMENT_BYTES) { await run.promise; expect(run.callTool).toHaveBeenCalledTimes(1); }
      else { await expect(run.promise.then(() => "accepted", error => error.code)).resolves.toBe("ASK_TOOL_ARGUMENTS_INVALID"); expect(run.callTool).not.toHaveBeenCalled(); }
    }
  });
});

const wireArguments = (response: ServerResponse, format: "openai_chat" | "anthropic", args: string, complete = true) => {
  response.setHeader("content-type", "text/event-stream");
  if (format === "anthropic") {
    event(response, { type: "message_start", message: {} });
    event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "runner__save_draft", input: {} } });
    for (let i = 0; i < args.length; i += 1000) event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(i, i + 1000) } });
    if (complete) event(response, { type: "message_stop" });
  } else {
    event(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "runner__save_draft", arguments: "" } }] } }] });
    for (let i = 0; i < args.length; i += 1000) event(response, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 1000) } }] } }] });
    if (complete) event(response, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  }
  response.end();
};

describe("stream and replay boundary controls", () => {
  it.each(["openai_chat", "anthropic"] as const)("enforces UTF-8 argument bytes while assembling %s, retaining incomplete refusal", async format => {
    for (const [args, complete, code] of [
      [argumentsOfSize(ARGUMENT_BYTES), true, "accepted"],
      [argumentsOfSize(ARGUMENT_BYTES + 1), true, "ASK_TOOL_ARGUMENTS_INVALID"],
      [JSON.stringify({ name: "界".repeat(44000) }), true, "ASK_TOOL_ARGUMENTS_INVALID"],
      [argumentsOfSize(70000), false, "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"],
      [argumentsOfSize(ARGUMENT_BYTES + 1), false, "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"],
    ] as const) {
      await serverRun(async endpoint => {
        const run = turn(request => secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {} }),
          { provider: format === "anthropic" ? "anthropic" : "openrouter", required: true, onStream: () => {} });
        expect(await run.promise.then(() => "accepted", error => error.code)).toBe(code);
        expect(run.callTool).toHaveBeenCalledTimes(code === "accepted" ? 1 : 0);
      }, (_body, response) => wireArguments(response, format, args, complete));
    }
  });

  it.each([false, true])("counts the retained continuation array independently of chunking (split=%s)", async split => {
    for (const excess of [0, 1]) {
      const details: unknown[] = Array.from({ length: 128 }, (_, index) => ({ type: "reasoning.encrypted", index, data: "" }));
      (details[0] as { data: string }).data = "x".repeat(REASONING_BYTES + excess - Buffer.byteLength(JSON.stringify(details)));
      await serverRun(async endpoint => {
        const events: unknown[] = [];
        const promise = secureAskJsonRequest({ endpoint, scope: "custom_loopback", headers: {}, body: {}, signal: new AbortController().signal,
          stream: { format: "openai_chat", onEvent: e => events.push(e) } });
        const actual = await promise.then(r => JSON.stringify((r.body.choices as Array<{ message: { reasoning_details: unknown } }>)[0]!.message.reasoning_details) === JSON.stringify(details) ? "exact" : "different", error => error.code);
        expect(actual).toBe(excess ? "ASK_PROVIDER_RESPONSE_INVALID" : "exact");
        expect(JSON.stringify(events)).not.toContain("reasoning.encrypted");
      }, (_body, response) => {
        response.setHeader("content-type", "text/event-stream");
        for (const fragment of split ? details.map(detail => [detail]) : [details]) event(response, { choices: [{ delta: { reasoning_details: fragment } }] });
        event(response, { choices: [{ delta: { content: "Ready" }, finish_reason: "stop" }] }); response.end();
      });
    }
  });

  it.each([true, false])("refuses oversized or malformed continuation before tools (stream=%s)", async stream => {
    for (const details of [continuation(REASONING_BYTES + 1), { secret: "private-malformed" }]) {
      await serverRun(async endpoint => {
        const run = turn(request => secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {}, ...(stream ? {} : { stream: undefined }) }), { required: true, onStream: () => {} });
        expect(await run.promise.then(() => "accepted", error => ({ code: error.code, private: error.message.includes("private-malformed") }))).toEqual({ code: "ASK_PROVIDER_RESPONSE_INVALID", private: false });
        expect(run.callTool).not.toHaveBeenCalled();
      }, (_body, response) => {
        if (stream) {
          response.setHeader("content-type", "text/event-stream");
          event(response, { choices: [{ delta: { reasoning_details: details, tool_calls: [{ index: 0, ...chatCall('{"name":"draft"}') }] }, finish_reason: "tool_calls" }] }); response.end();
        } else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(chatReply('{"name":"draft"}', details))); }
      });
    }
  });

  it("re-encodes the full accepted arguments in OpenAI Responses history", async () => {
    const args = argumentsOfSize(ARGUMENT_BYTES); let requests = 0;
    const run = turn(async request => {
      requests++;
      if (requests === 1) return { status: 200, body: { output: [{ type: "function_call", call_id: "call_1", name: "runner__save_draft", arguments: args }] } };
      expect((request.body.input as Array<Record<string, unknown>>).find(item => item.type === "function_call")?.arguments === args).toBe(true);
      return { status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: "Disabled draft saved." }] }] } };
    }, { provider: "openai", conversational: true });
    await run.promise; expect(requests).toBe(2); expect(run.callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses an over-budget cumulative follow-up without discarding continuation", async () => {
    let requests = 0;
    await serverRun(async endpoint => {
      const run = turn(request => secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {} }), { conversational: true });
      expect(await run.promise.then(() => "accepted", error => error.code)).toBe("ASK_PROVIDER_REQUEST_TOO_LARGE");
      expect(run.callTool).toHaveBeenCalledTimes(2);
    }, (_body, response) => { requests++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(chatReply('{"name":"draft"}', continuation(REASONING_BYTES)))); });
    expect(requests).toBe(2); // Earlier completed tools remain completed; no third HTTP request.
  });
});

function callsReply(provider: "openrouter" | "anthropic", count: number, round: number) {
  return provider === "anthropic"
    ? { content: Array.from({ length: count }, (_, i) => ({ type: "tool_use", id: `call_${round}_${i}`, name: "runner__save_draft", input: { name: "draft" } })) }
    : { choices: [{ message: { content: null, tool_calls: Array.from({ length: count }, (_, i) => chatCall('{"name":"draft"}', `call_${round}_${i}`)) } }] };
}
describe("completed tool budgets", () => {
  it.each(["openrouter", "anthropic"] as const)("retains per-response and exact structured initial-call limits (%s)", async provider => {
    for (const [count, required, code] of [[5, false, "ASK_TOOL_BUDGET_EXCEEDED"], [2, true, "ASK_REQUIRED_TOOL_NOT_CALLED"]] as const) {
      const run = turn(async () => ({ status: 200, body: callsReply(provider, count, 0) }), { provider, required });
      expect(await run.promise.then(() => "accepted", error => error.code)).toBe(code);
      expect(run.callTool).not.toHaveBeenCalled();
    }
  });
  it.each(["openrouter", "anthropic"] as const)("retains turn and round-trip limits, including the final answer-only request (%s)", async provider => {
    for (const conversational of [false, true]) {
      for (const count of [1, 4]) {
        let requests = 0;
        const run = turn(async () => ({ status: 200, body: callsReply(provider, count, ++requests) }), { provider, conversational });
        expect(await run.promise.then(() => "accepted", error => error.code)).toBe(count === 1 ? "ASK_TOOL_LOOP_EXHAUSTED" : "ASK_TOOL_BUDGET_EXCEEDED");
        const allowed = count === 1 ? (conversational ? 12 : 6) : (conversational ? 24 : 8);
        expect(run.callTool).toHaveBeenCalledTimes(allowed);
        expect(requests).toBe(allowed / count + 1);
      }
    }
  });
});
