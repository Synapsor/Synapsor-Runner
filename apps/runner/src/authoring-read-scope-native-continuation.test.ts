import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { projectReadScopeCheckpointSave } from "./authoring-read-scope-checkpoint.js";
import { createReadMeaningHost, type ReadMeaningRecordUpdate } from "./authoring-read-meaning-host.js";
import { readBoundaryAuthoringResumeStateHeld, buildBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { loadBoundaryReviewContext, loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { projectAuthoringReadScopeContext } from "./authoring-read-scope-context.js";
import { storeReadWorkloadAnalysis } from "./read-workloads.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

describe("native saved Read applicability continuation", () => {
  it("records a stale replacement and raw answer through the real native owners/CAS without losing the old Yes", async () => {
    const f = await nativeFixture();
    try {
      const question = await f.produce();
      const stored = await storeReadWorkloadAnalysis({ projectRoot: f.dir, generatedBoundary: f.boundary(),
        source: { kind: "model", provider: "openai", model: "controlled" }, analysis: f.analysis() });
      await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(), read: {
        analysis_id: stored.analysis_id, analysis_digest: stored.analysis_digest, scope_question_id: question.id } }));
      let contextDigest = f.contextDigest, locked = false;
      const assertCurrent = async (permit: ProjectAuthorityMutationPermit) => {
        const actual = await readBoundaryAuthoringResumeStateHeld(f.dir, f.nativeBinding, permit);
        if (actual.status !== "ready" || actual.value.revision_digest !== f.state().revision_digest) throw new Error("Actual native CAS changed");
      };
      const mutate = <T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>) =>
        withProjectAuthorityMutation(f.dir, async permit => { locked = true;
          try { return await operation(permit); } finally { locked = false; } });
      const decisions: Array<true | "replace"> = [true];
      const native = createNativeReadScope({ projectRoot: f.dir, ports: {
        snapshot: () => ({ resume: f.state(), revision: f.state().revision_digest, blocked: false,
          questions: f.state().operator_questions!, handoffs: f.state().owner_handoffs ?? [],
          generation: f.state().generation_recovery, read: f.state().read }),
        assertCurrent, questionContext: async () => contextDigest, questionScope: () => f.scopeDigest,
        mutate, failure: subject => new Error(`Native checkpoint unavailable: ${subject}`),
        save: async (request, permit) => {
          const state = f.state(), next = projectReadScopeCheckpointSave({ questions: state.operator_questions!,
            generation: state.generation_recovery, planningResult: state.planning_result, read: state.read,
            pendingRevision: state.pending_read_revision_state, pendingRequest: state.pending_read_revision }, request);
          await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: state, stage: request.stage,
            operatorQuestions: next.questions, read: next.read, generationRecovery: next.generation,
            pendingReadRevision: next.pendingRequest, pendingReadRevisionState: next.pendingRevision ?? null }), permit);
        },
      }, interact: async view => {
        expect(locked).toBe(false);
        const decision = decisions.shift();
        return view.kind === "readback" ? { kind: "decision", binding: view.binding, accepted: decision === true }
          : { kind: "pending", binding: view.binding, choice: decision === "replace" ? "replace" : "keep" };
      } });
      expect((await native.restore(f.boundary())).state).toBe("restored");
      const confirmed = structuredClone(f.state().operator_questions![0]!);
      expect(confirmed.confirmation).toBeDefined();
      const generation = structuredClone(f.state().generation_recovery);
      const prepared = await prepareBoundaryResourceReviewMutation(f.dir, { resource_id: "work.items", include: true,
        selectable_fields: [], keep_out_fields: ["label"], actor: "declared fixture operator",
        reason: "Keep labels outside this customer's disabled Read revision." }, async () => f.inspection());
      await commitBoundaryResourceReviewMutation(f.dir, prepared);
      const current = await loadBoundaryReviewContext(f.dir);
      contextDigest = digest(projectAuthoringReadScopeContext({ resume: f.state(), boundary: current.candidate,
        structuralReview: current, records: { questions: f.state().operator_questions!, handoffs: [], generation } }));
      decisions.push("replace");
      const replacement = await native.restore(current.candidate);
      expect(replacement.state).toBe("replacement");
      if (replacement.state !== "replacement") throw new Error("Replacement owner not reached");
      const replacementId = replacement.owner.question_id;
      expect(replacementId).not.toBe(question.id);
      expect(f.state().read?.scope_question_id).toBe(replacementId);
      expect(f.state().operator_questions![0]).toEqual(confirmed);
      expect(f.state().generation_recovery).toEqual(generation);
      let update: ReadMeaningRecordUpdate = {};
      const raw = "Keep labels private. I want to review a count instead.";
      const meaning = createReadMeaningHost({ answerTooLarge: () => {}, access: {
        readQuestions: () => update.questions ?? f.state().operator_questions!,
        readHandoffs: () => update.handoffs ?? f.state().owner_handoffs ?? [],
        readCheckpoint: () => undefined, readRecovery: () => f.state().generation_recovery,
        readConversationTurns: () => [], scopeDigest: () => f.scopeDigest, contextDigest: async () => contextDigest,
        assertFresh: async permit => {
          if (permit) await assertCurrent(permit);
          else await withProjectAuthorityMutation(f.dir, assertCurrent);
        }, mutate, install: next => { update = next; }, checkpointFailure: subject => new Error(subject),
        save: async permit => { await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
          read: f.state().read, operatorQuestions: update.questions ?? f.state().operator_questions!,
          ownerHandoffs: update.handoffs ?? f.state().owner_handoffs ?? [] }), permit); update = {}; },
      }, interact: async view => { expect(locked).toBe(false); return { kind: "answer", binding: view.binding, raw }; } });
      const answer = await meaning.answerScopeReplacement(replacementId);
      expect(answer).toBeDefined();
      expect(meaning.resolveScopeReplacementAnswer(answer!, replacementId)?.text).toBe(raw);
      expect(f.state().operator_questions![0]).toEqual(confirmed);
      expect(f.state().operator_questions!.at(-1)!.confirmation).toBeUndefined();
      expect(f.state().generation_recovery).toEqual(generation);
      await withProjectAuthorityMutation(f.dir, async permit => {
        expect((await readBoundaryAuthoringResumeStateHeld(f.dir, f.nativeBinding, permit)).status).toBe("ready");
        expect((await loadBoundaryReviewContextHeld(f.dir, permit)).candidate.activation).toBe("disabled_unreviewed");
      });
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});
