import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { expect, it } from "vitest";
import { createOwnerHandoff } from "./authoring-owner-handoff.js";
import { createOperatorQuestion } from "./authoring-operator-question.js";
import { assertBusinessStatementResponse, businessStatementBinding,
  type BusinessStatementInteraction, type BusinessStatementResponse } from "./authoring-business-statement-interaction.js";

// Derived-view controls, not native producer/completion or publication proof.
function fixture() {
  const digest = canonicalJsonDigest("declared Action binding");
  const handoff = createOwnerHandoff({ consumer: "policy_clarification", question: "How many reviewers are needed?",
    scope_digest: digest, context_digest: digest });
  const question = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: handoff.id,
    kind: "attributed_meaning", scope_digest: digest, context_digest: digest,
    target: { phase: "action_rule_components", outcomes: [] }, material: [], evidence: [], continuation: "action_rule_review" });
  const binding = businessStatementBinding(question, handoff, canonicalJsonDigest("producer question"), canonicalJsonDigest("Read checkpoint"));
  const view: BusinessStatementInteraction = { kind: "question", binding, text: handoff.question,
    material: [], preserveWhitespace: true, recordPolicyAnswer: false };
  return { binding, view };
}

it.each(["question_id", "question_revision", "question_digest", "handoff_id", "handoff_digest", "context_digest",
  "scope_digest", "proposal_digest", "producer_question_digest", "read_checkpoint_digest"] as const)(
  "refuses substitution of the derived %s", field => {
    const { binding, view } = fixture();
    const changed = { ...binding, [field]: field === "question_revision" ? binding.question_revision + 1
      : field.endsWith("_id") ? randomUUID() : canonicalJsonDigest("other state") };
    expect(() => assertBusinessStatementResponse(view, { kind: "answer", binding: changed, raw: "Two." })).toThrow("POLICY_SOURCE_CHANGED");
  });

it("keeps raw words, explicit decisions and retained-answer operations distinct", () => {
  const { binding, view } = fixture();
  for (const raw of [null, "  Two reviewers. 🧭\t"]) expect(() => assertBusinessStatementResponse(view, { kind: "answer", binding, raw })).not.toThrow();
  expect(() => assertBusinessStatementResponse(view, { kind: "decision", binding, accepted: true })).toThrow();
  const readback: BusinessStatementInteraction = { kind: "readback", binding, question: view.text, lines: [], defaultValue: false };
  for (const accepted of [true, false, null]) expect(() => assertBusinessStatementResponse(readback, { kind: "decision", binding, accepted })).not.toThrow();
  expect(() => assertBusinessStatementResponse(readback, { kind: "answer", binding, raw: "yes" })).toThrow();
  const pending: BusinessStatementInteraction = { kind: "pending", binding, lines: [], defaultValue: "keep", canReplace: true };
  for (const choice of ["keep", "review", "replace"] as const) expect(() => assertBusinessStatementResponse(pending, { kind: "pending", binding, choice })).not.toThrow();
  expect(() => assertBusinessStatementResponse(pending, { kind: "pending", binding, choice: "answer" } as unknown as BusinessStatementResponse)).toThrow();
});
