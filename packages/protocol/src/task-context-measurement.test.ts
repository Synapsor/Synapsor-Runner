import { describe, expect, it } from "vitest";
import { createTaskContextMeter, taskContextReportedUsage } from "./task-context-measurement.js";

describe("actual encoded task context measurement", () => {
  it("refuses ambiguous duplicate keys and invalid UTF-8 without leaking payloads", () => {
    const meter = createTaskContextMeter();
    expect(() => meter.observe({ boundary: "provider_request", encoded: '{"input":[],"\\u0069nput":["private"]}' })).toThrow("duplicate JSON object keys");
    expect(() => meter.observe({ boundary: "mcp_result", encoded: '{"content":[{"type":"text","text":"one","text":"private"}]}' })).toThrow("duplicate JSON object keys");
    expect(() => meter.observe({ boundary: "provider_request", encoded: Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]) })).toThrow("valid UTF-8 JSON");
    const valid = meter.observe({ boundary: "provider_request", encoded: String.raw`{"tools":[{"nested":["[,]",{"x":"\\\""}]}],"input":[]}` });
    expect(valid.provider_request_observations).toBe(1);
    expect(valid.static_instruction_bytes + valid.schema_bytes + valid.conversation_bytes + valid.framing_and_other_bytes).toBe(valid.encoded_utf8_bytes);
  });
  it("retains raw Unicode escapes and whitespace in exact encoded unit identity", () => {
    const meter = createTaskContextMeter();
    const escaped = String.raw`{"instructions":"\u00e9","input":[{"role":"user","content":"\u00e9"}],"tools":[]}`;
    const a = meter.observe({ boundary: "provider_request", encoded: escaped });
    expect(a.encoded_utf8_bytes).toBe(81);
    expect(a.static_instruction_bytes).toBe(8);
    expect(a.new_conversation_bytes).toBe(34);
    const literal = '{"instructions":"é","input":[{"role":"user","content":"é"}],"tools":[]}';
    const b = meter.observe({ boundary: "provider_request", encoded: literal });
    expect(b.encoded_utf8_bytes).toBe(73);
    expect(b.new_conversation_bytes).toBe(30);
    expect(b.repeated_conversation_bytes).toBe(0);
    const spaced = String.raw`{ "input" : [ { "role" : "user", "content" : "\u00e9" } ] }`;
    const c = meter.observe({ boundary: "provider_request", encoded: spaced });
    expect(c.new_conversation_bytes).toBe(Buffer.byteLength(String.raw`{ "role" : "user", "content" : "\u00e9" }`));
    expect(c.repeated_conversation_bytes).toBe(0);
    const d = meter.observe({ boundary: "provider_request", encoded: escaped });
    expect(d.repeated_conversation_bytes).toBe(34);
    expect(d.new_conversation_bytes).toBe(0);
    const e = meter.observe({ boundary: "mcp_result", encoded: String.raw`{"result":{"content":[{"type":"text","text":"\u00e9"}],"structuredContent":{"label":"\u00e9"}}}` });
    expect(e.mcp_text_rendering_bytes).toBe(8);
    expect(e.mcp_structured_rendering_bytes).toBe(Buffer.byteLength(String.raw`{"label":"\u00e9"}`));
  });

  it("partitions UTF-8, escaping, schemas and role-preserving history without treating bytes as tokens", () => {
    const meter = createTaskContextMeter();
    const first = { model: "synthetic", messages: [{ role: "system", content: "rule 界\n\"" }, { role: "user", content: "task" }], tools: [{ name: "one" }] };
    const encoded = JSON.stringify(first);
    const a = meter.observe({ boundary: "provider_request", encoded });
    expect(a.encoded_utf8_bytes).toBe(Buffer.byteLength(encoded));
    expect(a.encoded_utf8_bytes).toBeGreaterThan(encoded.length);
    expect(a.static_instruction_bytes + a.schema_bytes + a.conversation_bytes + a.framing_and_other_bytes).toBe(a.encoded_utf8_bytes);
    const b = meter.observe({ boundary: "provider_request", encoded: JSON.stringify({ ...first, messages: [...first.messages, { role: "tool", content: "required exception" }] }) });
    expect(b.repeated_conversation_bytes).toBe(a.new_conversation_bytes);
    expect(b.new_conversation_bytes).toBeGreaterThan(0);
    expect(b.provider_request_observations).toBe(2); expect(b.actual_provider_sends).toBeNull(); expect(b.mcp_tool_calls).toBe(0);
    expect(b.cumulative_provider_request_bytes).toBe(a.encoded_utf8_bytes + b.encoded_utf8_bytes);
    expect(b.peak_provider_request_bytes).toBe(b.encoded_utf8_bytes);
    expect(b.token_estimate).toBeNull(); expect(b.reported_usage).toBeNull();
    expect(JSON.stringify(b)).not.toMatch(/required exception|synthetic|rule 界|content|task"/);
    expect(first.messages).toHaveLength(2);
  });

  it("separates MCP calls from sends and measures duplicate text/structured renderings", () => {
    const meter = createTaskContextMeter();
    meter.observe({ boundary: "mcp_request", encoded: JSON.stringify({ method: "tools/list" }) });
    meter.observe({ boundary: "mcp_request", encoded: JSON.stringify({ method: "tools/call", params: { name: "app.describe_data" } }) });
    const result = { fields: ["a"], boundary: "not complete" };
    const encoded = JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ boundary: result.boundary, fields: result.fields }, null, 2) }], structuredContent: result } });
    const profile = meter.observe({ boundary: "mcp_result", encoded });
    expect(profile.mcp_tool_calls).toBe(1); expect(profile.provider_request_observations).toBe(0);
    expect(profile.mcp_text_rendering_bytes).toBeGreaterThan(profile.mcp_structured_rendering_bytes);
    expect(profile.equivalent_text_and_structured).toBe(true);
    const different = meter.observe({ boundary: "mcp_result", encoded: JSON.stringify({ content: [{ type: "text", text: "{}" }], structuredContent: result }) });
    expect(different.equivalent_text_and_structured).toBe(false);
    const textOnly = meter.observe({ boundary: "mcp_result", encoded: JSON.stringify({ content: [{ type: "text", text: "plain fallback" }] }) });
    expect(textOnly.equivalent_text_and_structured).toBeNull();
  });

  it("marks exhausted repetition memory unknown instead of resetting or retaining raw payloads", () => {
    const meter = createTaskContextMeter(1);
    const a = meter.observe({ boundary: "provider_request", encoded: '{"input":["one","two"]}' });
    expect(a.repetition_tracking).toBe("capacity_exhausted");
    expect(a.new_conversation_bytes).toBeNull(); expect(a.repeated_conversation_bytes).toBeNull();
    const b = meter.observe({ boundary: "provider_request", encoded: '{"input":["one"]}' });
    expect(b.provider_request_observations).toBe(2); expect(b.repetition_tracking).toBe("capacity_exhausted");
    expect(() => createTaskContextMeter(0)).toThrow(RangeError);
  });

  it("retains zero reported usage but no guessed tokens, money, elapsed time or SSE size", () => {
    const meter = createTaskContextMeter();
    const profile = meter.observe({ boundary: "provider_completed_response", encoded: '{"output":[]}', reportedUsage: { input_tokens: 0, output_tokens: 3, cost_usd: NaN }, elapsedMs: -1 });
    expect(profile.reported_usage).toEqual({ input_tokens: 0, output_tokens: 3 });
    expect(profile.elapsed_ms).toBeNull(); expect(profile.cumulative_completed_response_bytes).toBe(13);
    expect(profile.token_estimate).toBeNull();
    expect(() => meter.observe({ boundary: "provider_request", encoded: "not JSON" })).toThrow();
    expect(taskContextReportedUsage({ usage: { prompt_tokens: 11, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 7 }, cost: 0 } })).toEqual({ input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 7, cost_usd: 0 });
    expect(taskContextReportedUsage({ usage: { made_up_tokens: 0 } })).toBeUndefined();
  });
});
