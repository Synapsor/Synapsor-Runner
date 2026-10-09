import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import * as ask from "./model-ask.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery,
  type AuthoringTransportState } from "./authoring-generation-recovery.js";

type Digest = `sha256:${string}`;
const context = canonicalJsonDigest("declared current authoring context");
const foreign = canonicalJsonDigest("different authority or authoring context");
const tools: ask.AskToolDefinition[] = [{ name: "runner.review_component", description: "Validate a disabled component.",
  input_schema: { type: "object", properties: {}, additionalProperties: false } }];
const authority = ask.askToolSurfaceDigest(tools);
// The producer-owned port is absent before this feature. Every positive case
// still performs the actual transport/decoder/callback/completion chain first.
function feedback(result: ask.AskTurnResult, expected = { authority_digest: authority, context_digest: context }) {
  return (ask as typeof ask & { completedAuthoringBatchHistory?: (result: ask.AskTurnResult,
    expected: { authority_digest: Digest; context_digest: Digest }) => Pick<ask.AskHistoryTurn, "runner_context"> | undefined })
    .completedAuthoringBatchHistory?.(result, expected);
}
async function actualTurn(options: { large?: boolean; toolFree?: boolean; client?: boolean } = {}) {
  let state: AuthoringTransportState | undefined;
  const configuration = ask.resolveAskProviderConfiguration({ provider: "openai", model: "scripted-batch-history",
    api_key: "unused-local-fixture-key", authority_digest: authority, egress_acknowledged: true }, {}, new Date());
  const publicResult = { code: "COMPONENT_CONSTRAINT_MISSING", accepted: false, source_database_changed: false,
    ...(options.large ? { bounded_detail: "x".repeat(15_000) } : {}) };
  const rawResult = { ...publicResult, private_host_value: "PRIVATE_HOST_ONLY_CANARY" };
  const callTool = vi.fn(async () => ({ ok: false, error_code: "COMPONENT_CONSTRAINT_MISSING",
    value: rawResult, provider_value: publicResult, model_withheld_values: true }));
  const requestJson = vi.fn(async () => ({ status: 200, body: { status: "completed", output: options.toolFree
    ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A bounded narration." }] }]
    : [{ type: "function_call", call_id: "call_component", name: "runner__review_component", arguments: "{}" }] } }));
  const run = () => ask.runAskProviderTurn({ configuration, authorityDigest: authority,
    question: "Review the declared disabled component.", history: [], signal: new AbortController().signal,
    gateway: { mode: options.client ? "client" : "authoring", listTools: () => options.toolFree ? [] : tools,
      callTool, close: async () => undefined }, tools: options.toolFree ? [] : tools,
    ...(options.client ? { requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true }
      : options.toolFree ? { allowToolFreeAuthoringResponse: true }
      : { conversationalAuthoring: true, stopAfterAuthoringToolBatch: () => true }), dependencies: { requestJson } });
  const result = await withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ read: () => state, write: async next => { state = structuredClone(next); },
      available: () => true, current: async () => context });
    return run();
  });
  expect(requestJson).toHaveBeenCalledOnce();
  expect(callTool).toHaveBeenCalledTimes(options.toolFree ? 0 : 1);
  if (!options.client) {
    expect(ask.completedAuthoringQuestion(result)?.context_digest).toBe(context);
    expect(state?.operations[0]?.state).toBe("handled");
  }
  return { result, state };
}
describe("producer-bound authoring batch feedback", () => {
  it("returns the already-filtered real batch feedback, without reconstructing the private trace", async () => {
    const { result } = await actualTurn(), value = feedback(result);
    expect(value).toBeDefined();
    expect(value?.runner_context).toContain("COMPONENT_CONSTRAINT_MISSING");
    expect(value?.runner_context).not.toContain("PRIVATE_HOST_ONLY_CANARY");
    expect(JSON.stringify(result.tool_calls)).toContain("PRIVATE_HOST_ONLY_CANARY");
    expect(JSON.parse(value!.runner_context!)).toMatchObject({ schema_version: "synapsor.ask-runner-context.v1",
      calls: [{ tool: "runner.review_component", status: "refused", error_code: "COMPONENT_CONSTRAINT_MISSING" }] });
  });
  it("does not authorize a reconstructed result or completion clone", async () => {
    const { result } = await actualTurn();
    expect(feedback(structuredClone(result))).toBeUndefined();
    expect(feedback(JSON.parse(JSON.stringify(result)))).toBeUndefined();
    expect(feedback(result)).toBeDefined();
  });
  it("checks the genuine producer authority even after the public result is mutated", async () => {
    const { result } = await actualTurn();
    result.authority_digest = foreign;
    expect(feedback(result, { authority_digest: foreign, context_digest: context })).toBeUndefined();
    expect(feedback(result)).toBeDefined();
  });
  it("refuses a different current context rather than adopting it", async () => {
    const { result } = await actualTurn();
    expect(feedback(result, { authority_digest: authority, context_digest: foreign })).toBeUndefined();
  });
  it("keeps immutable filtered history after callers alter public tool results and a completion copy", async () => {
    const { result } = await actualTurn(), original = feedback(result);
    const completion = ask.completedAuthoringQuestion(result)!; completion.context_digest = foreign;
    result.tool_calls[0]!.result = { private_host_value: "ALTERED_PRIVATE_VALUE" };
    result.answer = "invented caller history";
    expect(feedback(result)).toEqual(original); expect(original).toBeDefined();
    expect(original?.runner_context).not.toContain("ALTERED_PRIVATE_VALUE");
  });
  it("reuses the existing bounded omission representation for an oversized detailed result", async () => {
    const { result } = await actualTurn({ large: true }), value = feedback(result);
    expect(value).toBeDefined(); expect(value!.runner_context!.length).toBeLessThanOrEqual(12_288);
    expect(JSON.parse(value!.runner_context!).calls[0]).toMatchObject({ tool: "runner.review_component",
      status: "refused", error_code: "COMPONENT_CONSTRAINT_MISSING", result_omitted_from_history: true });
    expect(value!.runner_context).not.toContain("bounded_detail");
  });
  it("does not mint batch history from tool-free authoring narration", async () => {
    const { result } = await actualTurn({ toolFree: true }); expect(feedback(result)).toBeUndefined();
  });
  it("does not expose client-turn history as an authoring completion", async () => {
    const { result } = await actualTurn({ client: true });
    expect(ask.completedAuthoringQuestion(result)).toBeUndefined(); expect(feedback(result)).toBeUndefined();
  });
});
