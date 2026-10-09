import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery,
  type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, completedAuthoringDecodedTurn, inspectActionAuthoringDecodedSequence,
  resolveAskProviderConfiguration, runAskProviderTurn, withActionAuthoringDecodedSequence, completedAuthoringQuestionSequence,
  type ActionAuthoringDecodedSequence, type AskToolDefinition } from "./model-ask.js";

function fixture() {
  let state: AuthoringTransportState | undefined;
  const tools: AskToolDefinition[] = [{ name: "runner.submit_component", description: "Disabled typed component",
    input_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "controlled",
    api_key: "inert-no-provider-access", egress_acknowledged: true, authority_digest: authorityDigest }, {}, new Date());
  let sends = 0;
  const run = (value: number, options: { mutate?: boolean; throwCallback?: boolean } = {}) => runAskProviderTurn({
    configuration, authorityDigest, tools, question: JSON.stringify({ declared_component: { value } }), history: [],
    signal: new AbortController().signal, skipRunnerQuestionContext: true,
    authoringInput: { consumer: "action_rule_components", operator_message: "Declared typed components" },
    requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
    gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (_name, args) => {
      if (options.throwCallback) throw new Error("actual interrupted consumer");
      if (options.mutate) args.value = 99;
      return { ok: true, value: { disabled: true } };
    } }, dependencies: { requestJson: async actual => {
      sends++;
      // Only actual model-visible request + declared operator facts supply the
      // scripted response; no private oracle or hidden expected mapping.
      const find = (v: unknown): { declared_component: { value: number } } | undefined => {
        if (typeof v === "string") for (const line of v.split("\n")) {
          try { const parsed = JSON.parse(line); if (parsed.declared_component) return parsed; } catch {}
        }
        if (v && typeof v === "object") for (const child of Object.values(v)) { const found = find(child); if (found) return found; }
        return undefined;
      };
      const visible = find(actual.body); if (!visible) throw new Error("Actual request lacks declared component");
      return { status: 200, body: { output: [{ type: "function_call", call_id: `actual_call_${sends}`,
        name: "runner__submit_component", arguments: JSON.stringify(visible.declared_component) }] } };
    } },
  });
  const tracked = <T>(f: () => Promise<T>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ read: () => state, write: async next => { state = structuredClone(next); },
      available: () => true, current: async () => digest("actual declared Source and Resume context") });
    return f();
  });
  return { tracked, run, state: () => state, sends: () => sends };
}

describe("actual Action decoded producer sequence", () => {
  it("captures original arguments before host reconciliation and cannot import cloned or mutated result JSON", async () => {
    const f = fixture();
    await f.tracked(() => withActionAuthoringDecodedSequence(async sequence => {
      const result = await f.run(7, { mutate: true });
      expect(result.tool_calls[0]!.arguments.value).toBe(99);
      const original = completedAuthoringDecodedTurn(result)!;
      expect(original.submissions[0]!.arguments).toEqual({ value: 7 });
      expect(original.operations[0]).toMatchObject({ operation_id: f.state()!.operations[0]!.id,
        attempt_id: f.state()!.operations[0]!.attempts[0]!.id });
      expect(completedAuthoringDecodedTurn(structuredClone(result))).toBeUndefined();
      result.tool_calls.length = 0; original.submissions[0]!.arguments.value = 123;
      const captured = inspectActionAuthoringDecodedSequence(sequence.current());
      expect(captured.turns[0]!.submissions[0]!.arguments).toEqual({ value: 7 });
      expect(captured.turns[0]!.received_response_digests).toEqual([captured.completion.response_digest]);
      expect(f.sends()).toBe(1);
    }));
  });
  it("records every actual turn in order, refuses earlier projections, copied tokens and closed invocations", async () => {
    const f = fixture(); let closed: ActionAuthoringDecodedSequence | undefined;
    await f.tracked(() => withActionAuthoringDecodedSequence(async sequence => {
      await f.run(1); const earlier = sequence.current(); await f.run(2); await f.run(3);
      expect(() => inspectActionAuthoringDecodedSequence(earlier)).toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
      closed = sequence.current();
      expect(() => inspectActionAuthoringDecodedSequence(structuredClone(closed!))).toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
      const material = inspectActionAuthoringDecodedSequence(closed!);
      expect(material.turns.map(turn => turn.submissions[0]!.arguments.value)).toEqual([1, 2, 3]);
      expect(material.turns.map(turn => turn.operations[0]!.operation_id)).toEqual(f.state()!.operations.map(op => op.id));
      expect(material.completion.operation_id).toBe(f.state()!.operations[2]!.id);
      expect(f.sends()).toBe(3);
    }));
    expect(() => inspectActionAuthoringDecodedSequence(closed!)).toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
    await f.tracked(() => withActionAuthoringDecodedSequence(async () => {
      expect(() => inspectActionAuthoringDecodedSequence(closed!)).toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
    }));
  });
  it("refuses genuine outside-turn contamination of the shared completed-consumer association", async () => {
    const f = fixture();
    await f.tracked(async () => {
      const outside = await f.run(10);
      await withActionAuthoringDecodedSequence(async sequence => {
        const inside = await f.run(20);
        completedAuthoringQuestionSequence([outside, inside]);
        expect(() => inspectActionAuthoringDecodedSequence(sequence.current()))
          .toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
      });
    });
  });
  it("does not turn interrupted handling into an apparently complete staged sequence", async () => {
    const f = fixture();
    await f.tracked(() => withActionAuthoringDecodedSequence(async sequence => {
      await f.run(1);
      await expect(f.run(2, { throwCallback: true })).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
      expect(() => sequence.current()).toThrowError(expect.objectContaining({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }));
      expect(f.state()!.operations[1]!.state).toBe("partial");
    }));
  });
});
