import { describe, expect, it } from "vitest";
import { operatorBusinessContext, operatorClarificationGate } from "./authoring-operator-presentation.js";

const context = operatorBusinessContext([{ id: "billing.cases", label: "billing cases",
  field_types: { private_note: "text" }, field_metadata: { private_note: { label: "registrar note" } } }]);
const target = { resource: "billing.cases", field: "private_note" };

describe("B64 GP01 wording cannot establish semantic equivalence", () => {
  it.each([
    ["Should billing.cases.private_note contain at most 200 characters?", "Should registrar note contain at least 200 characters?"],
    ["Must every reviewer accept billing.cases.private_note before any change?", "Must any reviewer accept registrar note before every change?"],
    ["Should billing.cases.private_note be visible only to its owner?", "Should registrar note be visible to anyone?"],
  ])("retains the original decision when a correction changes meaning: %s", (original, correction) => {
    const gate = operatorClarificationGate({ stage: "input", context, target });
    expect(gate(original).state).toBe("rephrase");
    expect(gate(correction)).toEqual({ state: "question", fallback: true,
      question: original.replace("billing.cases.private_note", "registrar note") });
    expect(gate.snapshot()?.original_question).toBe(original);
  });

  it("does not treat a resumed correction's identical word bag as proof", () => {
    const original = "Should billing.cases.private_note contain at most 200 characters?";
    const gate = operatorClarificationGate({ stage: "input", context, target });
    gate(original);
    const resumed = operatorClarificationGate({ stage: "input", context, target, resumeState: gate.snapshot() });
    expect(resumed("Should registrar note contain at least 200 characters?")).toEqual({
      state: "question", fallback: true, question: "Should registrar note contain at most 200 characters?" });
    expect(() => resumed(original, { ...target, field: "other_note" })).toThrow("STATE_STALE");
  });
});
