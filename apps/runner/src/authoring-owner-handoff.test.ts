import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it } from "vitest";
import { answerOwnerHandoff, createOwnerHandoff, parseOwnerHandoffs } from "./authoring-owner-handoff.js";

describe("bounded host owner handoffs", () => {
  it.each(["planning", "read_clarification", "read_value_context"] as const)("retains the original question and separate attributed answer: %s", consumer => {
    const question = createOwnerHandoff({ consumer, question: "Which current business meaning applies?",
      scope_digest: canonicalJsonDigest("same job"), context_digest: canonicalJsonDigest("current Source") });
    const answer = answerOwnerHandoff(question, "The selected record only.", canonicalJsonDigest("accepted current Source"));
    expect(question.state).toBe("waiting"); expect(answer.digest).toBe(question.digest);
    expect(answer).toMatchObject({ state: "answered", actor: "local_installation_operator", question: question.question });
    expect(parseOwnerHandoffs([answer])).toEqual([answer]);
    expect(() => answerOwnerHandoff(answer, "another answer", answer.context_digest)).toThrow("RESUME_INVALID");
    // This factory does not decide applicability. The public consumer must
    // recheck its actual Source/permissions and coordinate the save.
  });
  it("rejects blank answers, changed questions, extra fields, duplicate IDs and a question hidden by a later record", () => {
    const question = createOwnerHandoff({ consumer: "planning", question: "Which record?",
      scope_digest: canonicalJsonDigest(1), context_digest: canonicalJsonDigest(2) });
    expect(() => answerOwnerHandoff(question, " ", question.context_digest)).toThrow("RESUME_INVALID");
    expect(() => parseOwnerHandoffs([{...question, question: "A different question"}])).toThrow("RESUME_INVALID");
    expect(() => parseOwnerHandoffs([{...question, authority_granted: true}])).toThrow("RESUME_INVALID");
    expect(() => parseOwnerHandoffs([question, question])).toThrow("RESUME_INVALID");
    const next = createOwnerHandoff({ consumer: "planning", question: "Another question?",
      scope_digest: question.scope_digest, context_digest: question.context_digest });
    expect(() => parseOwnerHandoffs([question, next])).toThrow("RESUME_INVALID");
  });
});
