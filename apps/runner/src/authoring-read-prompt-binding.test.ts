import { readScopeModelCompletion } from "./authoring-read-scope-binding.js";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { createReadScopeQuestion } from "./authoring-read-scope-question.js";
import { createOwnerHandoff } from "./authoring-owner-handoff.js";
import { captureOperatorAnswer, leaveOperatorQuestionPending, presentOperatorQuestion } from "./authoring-operator-question.js";
import { readMeaningPromptHandoff } from "./authoring-read-prompt-binding.js";

it("admits a native raw correction only for its exact current declined review", async () => {
  const f = await nativeFixture();
  try {
    const review = leaveOperatorQuestionPending(await f.produce(), "declined"); await f.save(review);
    const handoff = createOwnerHandoff({ consumer: "read_revision_instruction", scope_digest: review.scope_digest,
      context_digest: review.context_digest, question: "What should change?" });
    const question = presentOperatorQuestion(createReadScopeQuestion({ id: randomUUID(), revision: 1,
      scope_digest: review.scope_digest, context_digest: review.context_digest, handoff_id: handoff.id,
      read_scope: { mode: "replacement_answer", review_question_id: review.id, record: review.read_scope!.record,
        completion: readScopeModelCompletion(review.read_scope!) } }), handoff.question);
    const input = { handoffs: [handoff], questions: [review, question], generation: f.state().generation_recovery };
    expect(readMeaningPromptHandoff(input)).toEqual(handoff);
    expect(readMeaningPromptHandoff({ ...input, questions: [review] })).toBeUndefined();
    expect(readMeaningPromptHandoff({ ...input, questions: [review, leaveOperatorQuestionPending(question, "declined")] })).toBeUndefined();
    const other = createOwnerHandoff({ consumer: "read_revision_instruction", scope_digest: review.scope_digest,
      context_digest: review.context_digest, question: "Another ordinary revision" });
    expect(readMeaningPromptHandoff({ ...input, handoffs: [handoff, other] })).toBeUndefined();
    const blank = leaveOperatorQuestionPending(captureOperatorAnswer(question, " \t "), "unknown");
    const successor = presentOperatorQuestion(createReadScopeQuestion({ id: randomUUID(), revision: 2,
      scope_digest: review.scope_digest, context_digest: review.context_digest, handoff_id: handoff.id,
      read_scope: { ...question.read_scope!, predecessor_id: blank.id } }), handoff.question);
    expect(readMeaningPromptHandoff({ ...input, questions: [review, blank, successor] })).toEqual(handoff);
    expect(blank.raw_answer?.text).toBe(" \t ");
    expect(successor.raw_answer).toBeUndefined();

  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
