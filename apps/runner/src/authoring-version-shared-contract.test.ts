import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { captureOperatorAnswer, createOperatorQuestion, parseOperatorQuestion, presentOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { runOperatorQuestionModel } from "./authoring-operator-question-model.js";

function writerQuestion() {
  return captureOperatorAnswer(presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1,
    handoff_id: randomUUID(), kind: "writer_maintenance", scope_digest: canonicalJsonDigest("owned writer scope"),
    context_digest: canonicalJsonDigest("current inspected source"),
    target: { phase: "Action counter", resource: "dispatch.parcels", field: "revision", outcomes: ["dispatch.hold"] },
    material: ["All external changes must remain detectable; this is an unverified assertion, not execution consent."],
    evidence: [{ id: "counter-proof", digest: canonicalJsonDigest("inspected integer counter") }],
    continuation: "version_mapping" }), "How do your other applications keep record changes detectable?"),
    "  Every application and maintenance script advances that counter on every change. 😀\t ");
}
function terminal(q: OperatorQuestion) {
  const { digest: _, ...core } = q;
  const body = { ...core, terminal_failure: { code: "ASK_TOOL_ARGUMENTS_INVALID", stage: "answer-map",
    completion: { operation_id: randomUUID(), request_digest: canonicalJsonDigest("request"),
      context_digest: canonicalJsonDigest("generation context"), response_digest: canonicalJsonDigest("consumed invalid response") },
    recorded_at: new Date().toISOString() } };
  return { ...body, digest: canonicalJsonDigest(body) };
}
function fixture(q = writerQuestion()) {
  let iterations = 11, callbacks = 23;
  const admission = { admitIteration: vi.fn(async () => { if (iterations >= 12) throw new Error("OWNED_TURN_EXHAUSTED"); iterations++; }),
    reserveToolBatch: vi.fn(async (n: number) => { if (callbacks + n > 24) throw new Error("OWNED_CALLBACKS_EXHAUSTED"); callbacks += n; }) };
  const requestJson = vi.fn(async () => ({ status: 200, body: { status: "completed", output: [{ type: "function_call",
    call_id: "controlled-version-map", name: "runner__propose_operator_decision", arguments: JSON.stringify({ question_id: q.id,
      revision: q.revision, answer_id: q.raw_answer!.id, status: "proposal", disposition: "proposed",
      value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }) }] } }));
  const input = { question: q, stage: "answer-map" as const,
    session: { provider: "openai" as const, model: "controlled-version", apiKey: "inert-local-fixture", dependencies: { requestJson } },
    actionLogicalTurnBudget: admission, reserveCorrection: async () => false,
    authorityGuard: (expected: `sha256:${string}`) => expected, env: {}, egressAcknowledged: true };
  return { input, requestJson, admission, counts: () => ({ iterations, callbacks }) };
}

describe("prospective Version shared contract; local decoder only", () => {
  it("represents a terminal writer answer-map without inventing an Input Source or6/8 allowance", () => {
    const q = writerQuestion(), stopped = parseOperatorQuestion(terminal(q));
    expect(stopped.terminal_failure?.stage).toBe("answer-map");
    expect(stopped.raw_answer).toEqual(q.raw_answer);
    expect(stopped.budget).toBeUndefined(); expect(stopped.source_binding).toBeUndefined();
  });
  it("refuses using the Input source-review stage for writer failure", () => {
    const { digest: _, ...core } = terminal(writerQuestion());
    const body = { ...core, terminal_failure: { ...core.terminal_failure, stage: "source-review" } };
    expect(() => parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) })).toThrow();
  });
  it("represents only the unpresented writer's consumed presentation stop", () => {
    const { digest: _, presentation: _presentation, raw_answer: _raw, ...core } = terminal(writerQuestion());
    const body = { ...core, terminal_failure: { ...core.terminal_failure, stage: "present" } };
    const stopped = parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
    expect(stopped.terminal_failure?.stage).toBe("present");
    expect(stopped.presentation).toBeUndefined(); expect(stopped.raw_answer).toBeUndefined();
    const changed = { ...body, raw_answer: writerQuestion().raw_answer, presentation: writerQuestion().presentation };
    expect(() => parseOperatorQuestion({ ...changed, digest: canonicalJsonDigest(changed) })).toThrow();
  });
  it("uses the last actual12/24 admission for a Version map, then stops without a reset", async () => {
    const f = fixture();
    expect(await runOperatorQuestionModel(f.input as never)).toMatchObject({ state: "proposed" });
    expect(f.counts()).toEqual({ iterations: 12, callbacks: 24 });
    await expect(runOperatorQuestionModel(f.input as never)).rejects.toThrow("OWNED_TURN_EXHAUSTED");
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("refuses both allowance routes before any request or counter change", async () => {
    const f = fixture();
    await expect(runOperatorQuestionModel({ ...f.input, episodeBudget: f.admission } as never))
      .rejects.toMatchObject({ code: "OPERATOR_QUESTION_BUDGET_INVALID" });
    expect(f.requestJson).not.toHaveBeenCalled(); expect(f.counts()).toEqual({ iterations: 11, callbacks: 23 });
  });
  it("does not admit an Input question through the Action logical-turn bridge", async () => {
    const f = fixture();
    const { digest: _, ...core } = f.input.question;
    const changed = { ...core, kind: "input_bounds", continuation: "input_policy_review" };
    await expect(runOperatorQuestionModel({ ...f.input, question: { ...changed, digest: canonicalJsonDigest(changed) } } as never))
      .rejects.toMatchObject({ code: "OPERATOR_QUESTION_BUDGET_INVALID" });
    expect(f.requestJson).not.toHaveBeenCalled();
  });
});
