import { describe, expect, it } from "vitest";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { storeReadWorkloadAnalysis } from "./read-workloads.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { exploreVocabularyCoverage } from "./explore-vocabulary.js";

// Each fixture creates a genuine candidate, actual controlled model nomination,
// stored compiler analysis and displayed operator review. Never rename a
// confirmed candidate, forge an assessment or insert a saved confirmation.
async function reviewedNativeMeaning(resource: string, field: string, labelled = false) {
  const f = await nativeFixture(false, false, { resource, field,
    request: `Show the signed-in person the declared ${field} field from ${resource}.`,
    ...(labelled ? { review: { metadata: { label: "Items" }, field_metadata: [{ field, label: "Display value" }] } } : {}) });
  const question = await f.produce();
  const analysis = await storeReadWorkloadAnalysis({ projectRoot: f.dir,
    generatedBoundary: f.boundary(), source: { kind: "model", provider: "openai", model: "controlled" }, analysis: f.analysis() });
  await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
    read: { analysis_id: analysis.analysis_id, analysis_digest: analysis.analysis_digest, scope_question_id: question.id } }));
  let displayed = 0;
  const native = createNativeReadScope({ projectRoot: f.dir, ports: {
    snapshot: () => { const state = f.state(); return { resume: state, revision: state.revision_digest,
      blocked: false, questions: state.operator_questions ?? [], handoffs: state.owner_handoffs ?? [],
      generation: state.generation_recovery, read: state.read }; },
    assertCurrent: async () => {
      expect(await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding)).toEqual({ status: "ready", value: f.state() });
    },
    questionContext: async () => f.contextDigest, questionScope: () => f.scopeDigest,
    mutate: operation => withProjectAuthorityMutation(f.dir, operation),
    save: async (update, permit) => {
      await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
        stage: update.stage, read: update.read ?? f.state().read, operatorQuestions: update.questions,
        generationRecovery: update.generation ?? f.state().generation_recovery }), permit);
    },
    failure: subject => new Error(subject),
  }, interact: async (view, assertCurrent) => {
    await assertCurrent();
    if (view.kind !== "readback") throw new Error("Expected exact complete native Read review");
    expect(view.defaultValue).toBe(false);
    expect(view.lines.join("\n")).toContain(resource);
    expect(view.lines.join("\n")).toContain(field);
    displayed++;
    // Explicit declared local fixture operator response to the actual readback.
    return { kind: "decision", binding: view.binding, accepted: true };
  } });
  return { f, native, question, displayed: () => displayed };
}

describe("B64 vocabulary presentation and actual native Read meaning", () => {
  it("keeps pretty reviewed labels without a native operator decision unconfirmed", async () => {
    const h = await reviewedNativeMeaning("work.t_0031", "c7", true);
    const coverage = exploreVocabularyCoverage(h.f.boundary().pack.resources[0]!);
    expect(coverage.fields_with_reviewed_vocabulary).toBe(1);
    expect(Object.hasOwn(coverage, "status")).toBe(false);
    const assessment = await h.native.assess(h.f.boundary());
    expect(assessment.kind).toBe("native");
    expect(assessment.status).not.toBe("confirmed");
    expect(h.displayed()).toBe(0);
  });

  it.each([["work.items", "label"], ["work.t_0031", "c7"]])(
    "keeps %s.%s unconfirmed until actual review, then permits meaning without a label", async (resource, field) => {
      const h = await reviewedNativeMeaning(resource!, field!);
      const coverage = exploreVocabularyCoverage(h.f.boundary().pack.resources[0]!);
      expect(coverage.fields_with_reviewed_vocabulary).toBe(0);
      expect(Object.hasOwn(coverage, "status")).toBe(false);
      const before = await h.native.assess(h.f.boundary());
      expect(before.kind).toBe("native");
      expect(before.status).not.toBe("confirmed");
      expect(h.displayed()).toBe(0);
      expect((await h.native.review(h.question.id)).state).toBe("confirmed");
      expect(h.displayed()).toBe(1);
      const after = await withProjectAuthorityMutation(h.f.dir,
        permit => h.native.assess(h.f.boundary(), permit));
      expect(after).toMatchObject({ kind: "native", status: "confirmed", replacement_pending: false,
        analysis_assessment: { status: "compatible" } });
      expect(exploreVocabularyCoverage(h.f.boundary().pack.resources[0]!).fields_with_reviewed_vocabulary).toBe(0);
      // Keep all local native records for replay; no fixture cleanup.
    });
});
