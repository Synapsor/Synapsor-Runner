import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it } from "vitest";
import { createOperatorQuestion, operatorQuestionEpisode, presentOperatorQuestion, captureOperatorAnswer } from "./authoring-operator-question.js";
import { inputInteractionBinding, assertInputInteractionResponse, type InputInteraction } from "./authoring-input-interaction.js";

function records() {
  const source = canonicalJsonDigest("A note needs a business-defined maximum length."), store = canonicalJsonDigest("current store");
  const outcomes = ["parcel.hold"], sourceSession = randomUUID();
  const root = createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", assistedLocalConsumer: true,
    scope_digest: canonicalJsonDigest("selected job"), context_digest: canonicalJsonDigest("current Source/schema/role/baseline"),
    target: { phase: "input_policy", outcomes }, material: ["Interpret text length only."], evidence: [], continuation: "input_policy_review",
    source_binding: { source_session: sourceSession, source_digest: source, store_digest: store, lines: 1,
      agenda_digest: canonicalJsonDigest({ source_session: sourceSession, source_digest: source, store_digest: store, outcomes }) } });
  const child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 2, kind: "input_bounds",
    handoff_id: randomUUID(), budget_owner_id: root.id, scope_digest: root.scope_digest, context_digest: root.context_digest,
    target: root.target, material: root.material, evidence: root.evidence, continuation: root.continuation }), "What is the maximum note length?");
  return { root, child };
}

describe("derived Input response binding", () => {
  it("retains semantic identity after the owning episode admits its own budget advancement", async () => {
    const { root: initial, child } = records(); let root = initial;
    const before = inputInteractionBinding(root, child);
    const episode = operatorQuestionEpisode({ read: () => root, save: async (next, expected) => {
      expect(root.digest).toBe(expected); root = next;
    } });
    await episode.admitIteration(); await episode.reserveToolBatch(1);
    expect(root.digest).not.toBe(initial.digest);
    expect(root.budget?.iterations_used).toBe(1);
    expect(root.budget?.tool_calls_used).toBe(1);
    expect(inputInteractionBinding(root, child)).toEqual(before);
  });

  it("refuses a response for a different target, raw answer or context", () => {
    const { root, child } = records();
    const view: InputInteraction = { kind: "question", binding: inputInteractionBinding(root, child),
      text: child.presentation!.text, material: child.material, preserveWhitespace: true, recordPolicyAnswer: false };
    const captured = captureOperatorAnswer(child, "  sixty-four 😀\t");
    expect(() => assertInputInteractionResponse(view, { kind: "answer", binding: inputInteractionBinding(root, captured), raw: "64" })).toThrow();
    for (const changed of [ { ...view.binding, context_digest: canonicalJsonDigest("new context") },
      { ...view.binding, question_id: randomUUID() }, { ...view.binding, proposal_digest: canonicalJsonDigest("other interpretation") } ])
      expect(() => assertInputInteractionResponse(view, { kind: "answer", binding: changed, raw: "64" })).toThrow();
  });

  it("keeps exact raw whitespace, cancellation and explicit readback decisions separate", () => {
    const { root, child } = records(), binding = inputInteractionBinding(root, child);
    const question: InputInteraction = { kind: "question", binding, text: child.presentation!.text,
      material: child.material, preserveWhitespace: true, recordPolicyAnswer: false };
    const raw = "  sixty-four 😀\t";
    expect(() => assertInputInteractionResponse(question, { kind: "answer", binding, raw })).not.toThrow();
    expect(() => assertInputInteractionResponse(question, { kind: "answer", binding, raw: null })).not.toThrow();
    expect(() => assertInputInteractionResponse(question, { kind: "decision", binding, accepted: true })).toThrow();
    const review: InputInteraction = { kind: "readback", binding, lines: ["Maximum length: 64."], defaultValue: false };
    for (const accepted of [true, false, null]) expect(() => assertInputInteractionResponse(review, { kind: "decision", binding, accepted })).not.toThrow();
    expect(() => assertInputInteractionResponse(review, { kind: "answer", binding, raw: "yes" })).toThrow();
  });

  it("cannot reopen a pending Source interpretation with no actionable question", () => {
    const { root } = records(), binding = inputInteractionBinding(root, root);
    const pending: InputInteraction = { kind: "pending", binding, material: root.material,
      sourceInterpretation: true, canAnswer: false, defaultValue: "keep" };
    expect(() => assertInputInteractionResponse(pending, { kind: "pending", binding, choice: "keep" })).not.toThrow();
    expect(() => assertInputInteractionResponse(pending, { kind: "pending", binding, choice: "answer" })).toThrow();
  });
});
