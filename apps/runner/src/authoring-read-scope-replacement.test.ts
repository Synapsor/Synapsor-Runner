import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { createReadScopeQuestion } from "./authoring-read-scope-question.js";
import { createOwnerHandoff, answerOwnerHandoff } from "./authoring-owner-handoff.js";
import { leaveOperatorQuestionPending, presentOperatorQuestion, captureOperatorAnswer, parseOperatorQuestions } from "./authoring-operator-question.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

describe("native user-initiated Read replacement answer", () => {
  it("retains a declined genuine proposal and exact raw correction without inventing another model completion", async () => {
    const f = await nativeFixture();
    try {
      const original = await f.produce();
      const declined = leaveOperatorQuestionPending(original, "declined"); await f.save(declined);
      const generationBefore = d(f.state().generation_recovery);
      const handoff = createOwnerHandoff({ consumer: "read_revision_instruction", scope_digest: declined.scope_digest,
        context_digest: declined.context_digest, question: "What should change in this Read scope?" });
      const question = presentOperatorQuestion(createReadScopeQuestion({ id: randomUUID(), revision: 1,
        scope_digest: declined.scope_digest, context_digest: declined.context_digest, handoff_id: handoff.id,
        read_scope: { mode: "replacement_answer", review_question_id: declined.id, record: declined.read_scope!.record,
          completion: declined.read_scope!.completion } }), handoff.question);
      const raw = "Keep these records, but show only the label; leave the count out.";
      const captured = captureOperatorAnswer(question, raw), answered = answerOwnerHandoff(handoff, raw, declined.context_digest);
      await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
        operatorQuestions: [...f.state().operator_questions!, captured], ownerHandoffs: [answered] }));
      const reopened = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding);
      expect(reopened.status).toBe("ready");
      if (reopened.status !== "ready") throw new Error("Exact saved replacement unavailable");
      const parsed = parseOperatorQuestions(reopened.value.operator_questions, reopened.value.owner_handoffs!, reopened.value.generation_recovery);
      expect(parsed[0]!.disposition).toBe("declined");
      expect(parsed[1]!.raw_answer?.text).toBe(raw); expect(parsed[1]!.confirmation).toBeUndefined();
      expect(reopened.value.owner_handoffs![0]!.completion).toBeUndefined();
      expect(d(reopened.value.generation_recovery)).toBe(generationBefore);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});
