import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { expect, it } from "vitest";
import { createOperatorQuestion } from "./authoring-operator-question.js";
import { createOwnerHandoff } from "./authoring-owner-handoff.js";
import { readWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { assertReadMeaningInteractionResponse, readMeaningInteractionBinding,
  type ReadMeaningInteraction, type ReadMeaningInteractionResponse } from "./authoring-read-meaning-interaction.js";

/** Derived-view controls only. These declared local records contain no model
 * completion and establish no successful native producer or saved authority. */
function fixture() {
  const digest = canonicalJsonDigest("declared local binding control");
  const request = { resource: "dispatch_lab.deliveries", field: "stage", reason: "Meaning is not established.",
    question: "What does the delivery stage mean for this task?" };
  const handoff = createOwnerHandoff({ consumer: "read_clarification", question: request.question,
    scope_digest: digest, context_digest: digest });
  const question = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: handoff.id, kind: "attributed_meaning",
    scope_digest: digest, context_digest: digest, target: { phase: "read_mapping", resource: request.resource, field: request.field, outcomes: [] },
    material: ["Untrusted local naming context; no permission."], evidence: [], continuation: "read_mapping" });
  const checkpoint = readWorkloadAssistanceCheckpoint({ stage: "waiting", input_digest: digest, boundary_digest: digest,
    catalog_digest: digest, tool_digest: digest, pending_question: { kind: "clarification", request, question: request.question },
    state: { call_count: 0, attempt: 1, phase: "initial", correction_used: false, relationship_reviews: 0, relationship_review_limit: 0,
      clarified_targets: [], clarification_answers: [], clarification_from_invalid_naming: false, clarification_resolved: false,
      mechanical_clarification_resolved: false, value_request_resolved: false, repeated_assistance_request: false,
      naming_evidence_correction_used: false, diagnostics: [] } });
  const binding = readMeaningInteractionBinding(question, handoff, checkpoint);
  const view: ReadMeaningInteraction = { kind: "question", binding, request, text: request.question, material: [],
    preserveWhitespace: true, recordPolicyAnswer: false };
  return { binding, view };
}

it.each([null, "  Scheduled or delivered. 🧭  "])("the exact current derived question accepts only raw words or cancellation: %s", raw => {
  const { view, binding } = fixture();
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "answer", binding, raw })).not.toThrow();
});

it.each(["question_id", "question_revision", "question_digest", "handoff_digest", "assistance_digest", "context_digest", "scope_digest"] as const)(
  "a late answer cannot substitute the %s of another saved interaction", field => {
    const { view, binding } = fixture();
    const changed = { ...binding, [field]: field === "question_revision" ? binding.question_revision + 1
      : field === "question_id" ? randomUUID() : canonicalJsonDigest("different saved state") };
    expect(() => assertReadMeaningInteractionResponse(view, { kind: "answer", binding: changed, raw: "Delivered." })).toThrow("POLICY_SOURCE_CHANGED");
  });

it("an answer cannot confirm a readback or choose a recovery operation", () => {
  const { view, binding } = fixture();
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "decision", binding, accepted: true })).toThrow("POLICY_SOURCE_CHANGED");
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "pending", binding, choice: "replace" })).toThrow("POLICY_SOURCE_CHANGED");
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "answer", binding, raw: 1 } as unknown as ReadMeaningInteractionResponse)).toThrow("POLICY_SOURCE_CHANGED");
});

it.each([true, false, null])("the exact readback accepts only an explicit decision or cancellation: %s", accepted => {
  const { binding } = fixture();
  const view: ReadMeaningInteraction = { kind: "readback", binding, lines: ["Declared raw meaning"], defaultValue: false, purpose: "meaning" };
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "decision", binding, accepted })).not.toThrow();
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "answer", binding, raw: "yes" })).toThrow("POLICY_SOURCE_CHANGED");
});

it("a pending view cannot invent an available Replace route", () => {
  const { binding } = fixture();
  const view: ReadMeaningInteraction = { kind: "pending", binding, material: [], canReplace: false, defaultValue: "keep" };
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "pending", binding, choice: "keep" })).not.toThrow();
  expect(() => assertReadMeaningInteractionResponse(view, { kind: "pending", binding, choice: "replace" })).toThrow("POLICY_SOURCE_CHANGED");
});
