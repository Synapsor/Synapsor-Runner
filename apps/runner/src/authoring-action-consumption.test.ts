import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import * as recovery from "./authoring-generation-recovery.js";
import { runOperatorQuestionModel } from "./authoring-operator-question-model.js";
import { captureOperatorAnswer, createOperatorQuestion, presentOperatorQuestion } from "./authoring-operator-question.js";
import { randomUUID } from "node:crypto";

// Controlled local decoder only. A generated self-hash and a stored handled row
// are not a current-frame consumer association.
const material = canonicalJsonDigest("exact non-circular Version interpretation");
async function consumed() {
  let state: recovery.AuthoringTransportState = { version: 1, operations: [] };
  let q = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: randomUUID(), kind: "writer_maintenance",
    scope_digest: canonicalJsonDigest("owned scope"), context_digest: canonicalJsonDigest("current source"),
    target: { phase: "Action", resource: "cases.items", field: "revision", outcomes: ["cases.hold"] },
    material: ["Only an unverified writer assertion; execution remains disabled."], evidence: [], continuation: "version_mapping" });
  q = captureOperatorAnswer(presentOperatorQuestion(q, "How are external record changes tracked?"), "All applications advance this counter.");
  recovery.configureAuthoringGenerationRecovery({ available: () => true, read: () => state,
    current: async () => q.context_digest, write: async next => { recovery.validateAuthoringTransportState(next); state = next; } });
  const result = await runOperatorQuestionModel({ question: q, stage: "answer-map",
    session: { provider: "openai", model: "controlled-Action-consumer", apiKey: "inert-local-fixture", dependencies: {
      requestJson: async () => ({ status: 200, body: { status: "completed", output: [{ type: "function_call", name: "runner__propose_operator_decision",
        call_id: "controlled", arguments: JSON.stringify({ question_id: q.id, revision: q.revision, answer_id: q.raw_answer!.id,
          status: "proposal", disposition: "proposed", value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }) }] } }),
    } }, actionLogicalTurnBudget: { admitIteration: async () => {}, reserveToolBatch: async () => {} },
    reserveCorrection: async () => false, authorityGuard: expected => expected, egressAcknowledged: true, env: {} });
  return { result, read: () => state };
}
type ActionCheckpoint = (state: recovery.AuthoringTransportState, completion: NonNullable<Awaited<ReturnType<typeof consumed>>["result"]["completion"]>,
  record: { consumer: "action_rule_components"; kind: "version_interpretation" | "compiled_draft"; material_digest: `sha256:${string}` }) => recovery.AuthoringTransportState;
function checkpoint(...args: Parameters<ActionCheckpoint>) {
  return (recovery as unknown as { authoringActionCheckpoint: ActionCheckpoint }).authoringActionCheckpoint(...args);
}
describe("prospective exact Action consumer association", () => {
  it("binds the live consumed response and material without a fabricated question or write", async () => {
    await recovery.withAuthoringGenerationRecovery(async () => {
      const f = await consumed(), before = structuredClone(f.read());
      const next = checkpoint(f.read(), f.result.completion!, { consumer: "action_rule_components", kind: "version_interpretation", material_digest: material });
      recovery.validateAuthoringTransportState(next);
      expect(next.operations[0]).toMatchObject({ state: "checkpointed", checkpoint_seen: true,
        action_checkpoint: { consumer: "action_rule_components", kind: "version_interpretation", material_digest: material,
          response_digest: f.result.completion!.response_digest } });
      expect(next.operations[0]!.question_handoff).toBeUndefined(); expect(f.read()).toEqual(before);
    });
  });
  it("saved completion outside its real consuming frame cannot acknowledge an old handled response", async () => {
    const f = await recovery.withAuthoringGenerationRecovery(consumed), before = structuredClone(f.read());
    expect(() => checkpoint(f.read(), f.result.completion!, { consumer: "action_rule_components", kind: "compiled_draft", material_digest: material }))
      .toThrow(/current|consum|inspection/i);
    expect(f.read()).toEqual(before);
  });
  it("refuses changed request or unknown response even with genuine completion metadata", async () => {
    await recovery.withAuthoringGenerationRecovery(async () => {
      const f = await consumed();
      for (const delta of [{ state: "unknown" }, { request_digest: canonicalJsonDigest("competing request") }]) {
        const copy = structuredClone(f.read()); Object.assign(copy.operations[0]!, delta);
        expect(() => checkpoint(copy, f.result.completion!, { consumer: "action_rule_components", kind: "compiled_draft", material_digest: material })).toThrow();
      }
    });
  });
});
