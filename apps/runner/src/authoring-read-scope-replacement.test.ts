import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { createReadScopeQuestion, resolveNativeReadScope } from "./authoring-read-scope-question.js";
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

import { createReadMeaningHost, type ReadMeaningRecordUpdate } from "./authoring-read-meaning-host.js";
import type { ReadMeaningInteraction } from "./authoring-read-meaning-interaction.js";

describe("existing Read host captures a replacement as raw testimony", () => {
  async function setup() {
    const f = await nativeFixture(), original = await f.produce();
    await f.save(leaveOperatorQuestionPending(original, "declined"));
    let staged: ReadMeaningRecordUpdate = {}, context = original.context_digest, locked = false;
    const views: ReadMeaningInteraction[] = [], answers: Array<string | null> = [];
    const controls = { duringWait: undefined as (() => void) | undefined };
    const host = createReadMeaningHost({ answerTooLarge: () => {}, access: {
      readQuestions: () => staged.questions ?? f.state().operator_questions ?? [],
      readHandoffs: () => staged.handoffs ?? f.state().owner_handoffs ?? [],
      readCheckpoint: () => undefined, readRecovery: () => f.state().generation_recovery,
      readConversationTurns: () => [], scopeDigest: () => original.scope_digest, contextDigest: async () => context,
      assertFresh: async () => {}, checkpointFailure: text => new Error(text),
      mutate: async callback => { locked = true; try { return await callback({ fixturePermit: true } as never); }
        catch (error) { staged = {}; throw error; } finally { locked = false; } },
      install: update => { staged = { ...staged, ...update }; },
      save: async () => { expect(locked).toBe(true); await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
        operatorQuestions: staged.questions ?? f.state().operator_questions, ownerHandoffs: staged.handoffs ?? f.state().owner_handoffs })); staged = {}; },
    }, interact: async view => { expect(locked).toBe(false); views.push(view); controls.duringWait?.();
      return { kind: "answer", binding: view.binding, raw: answers.shift() ?? null }; } });
    return { f, original, host, views, answers, controls, drift: () => { context = d("changed protected context"); } };
  }
  it("resumes durably captured words without another prompt or model operation", async () => {
    const h = await setup();
    try {
      const generation = d(h.f.state().generation_recovery);
      h.answers.push("Keep only the labels for my own records.");
      const ref = await h.host.answerScopeReplacement(h.original.id);
      expect(ref).toBeDefined(); expect(h.host.resolveScopeReplacementAnswer(ref!, h.original.id)?.text).toBe("Keep only the labels for my own records.");
      expect(await h.host.answerScopeReplacement(h.original.id)).toEqual(ref);
      expect(h.views).toHaveLength(1); expect(d(h.f.state().generation_recovery)).toBe(generation);
      expect(h.f.state().operator_questions!.every(q => !q.confirmation)).toBe(true);
      expect(resolveNativeReadScope({ questions: h.f.state().operator_questions!, handoffs: h.f.state().owner_handoffs!,
        generation: h.f.state().generation_recovery, question_id: h.original.id, expectedBinding: h.f.binding,
        ...h.f.inventory, analysis: h.f.analysis() })).toMatchObject({ status: "pending", replacement_pending: true });
    } finally { await fs.rm(h.f.dir, { recursive: true, force: true }); }
  });
  it.each([null, "   "])("keeps %s pending then retains its history when answered", async pending => {
    const h = await setup();
    try {
      h.answers.push(pending); expect(await h.host.answerScopeReplacement(h.original.id)).toBeUndefined();
      const before = structuredClone(h.f.state().operator_questions!.at(-1)!);
      h.answers.push("Show the labels for the same reviewed people.");
      const ref = await h.host.answerScopeReplacement(h.original.id);
      expect(ref).toBeDefined(); expect(h.views).toHaveLength(2);
      const questions = h.f.state().operator_questions!;
      if (pending !== null) expect(questions.find(q => q.id === before.id)?.raw_answer?.text).toBe(pending);
      else expect(questions.at(-1)!.disposition_history).toContainEqual(expect.objectContaining({ disposition: "cancelled" }));
      expect(h.f.state().generation_recovery!.operations).toHaveLength(1);
    } finally { await fs.rm(h.f.dir, { recursive: true, force: true }); }
  });
  it("refuses a new raw answer after context changes during the unlocked wait", async () => {
    const h = await setup();
    try {
      h.answers.push("New words"); h.controls.duringWait = h.drift;
      await expect(h.host.answerScopeReplacement(h.original.id)).rejects.toThrow();
      expect(h.f.state().operator_questions!.at(-1)!.raw_answer).toBeUndefined();
      expect(h.f.state().owner_handoffs!.at(-1)!.state).toBe("waiting");
    } finally { await fs.rm(h.f.dir, { recursive: true, force: true }); }
  });
});
