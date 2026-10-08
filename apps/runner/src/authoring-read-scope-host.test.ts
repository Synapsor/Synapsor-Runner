import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { createReadScopeHost, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
import { presentReadScopeInteraction } from "./authoring-question-presenter.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { leaveOperatorQuestionPending } from "./authoring-operator-question.js";
import { nativeFixture, binding, inventory, analysis } from "./test-fixtures/native-read-scope.js";

// Actual controlled provider and native Resume CAS. The mutation callback models
// the protected owner's lease boundary; this is not installed/public acceptance.
async function setup(options: { pending?: boolean; noRead?: boolean } = {}) {
  const f = await nativeFixture(options.noRead, options.pending), q = await f.produce();
  const controls = { currentBinding: structuredClone(binding), failSave: false,
    duringWait: undefined as (() => Promise<void>) | undefined };
  let locked = false;
  const views: ReadScopeInteraction[] = [], responses: Array<boolean | null | "keep" | "review" | "replace"> = [];
  const host = createReadScopeHost({ access: {
    load: async questionId => {
      const disk = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding);
      if (disk.status !== "ready") throw new Error("Actual native fixture unavailable");
      return { questions: disk.value.operator_questions!, handoffs: disk.value.owner_handoffs ?? [], generation: disk.value.generation_recovery,
        question_id: questionId, expectedBinding: controls.currentBinding, ...inventory,
        ...(!options.pending && !options.noRead ? { analysis: analysis() } : {}),
        resume_revision_digest: disk.value.revision_digest, context_digest: q.context_digest, scope_digest: q.scope_digest };
    },
    mutate: async operation => { locked = true; try { return await operation({ testPermit: true } as never); } finally { locked = false; } },
    save: async (next, { expected }) => {
      expect(locked).toBe(true); expect(expected.resume_revision_digest).toBe(f.state().revision_digest);
      if (controls.failSave) throw new Error("NATIVE_REVIEW_SAVE_FAILED");
      await f.save(next);
    },
  }, interact: async view => {
    expect(locked).toBe(false); views.push(view); await controls.duringWait?.();
    const answer = responses.shift();
    return view.kind === "readback" ? { kind: "decision", binding: view.binding, accepted: typeof answer === "boolean" ? answer : null }
      : { kind: "pending", binding: view.binding, choice: answer === "review" || answer === "replace" ? answer : "keep" };
  } });
  return { f, q, host, controls, views, responses, cleanup: () => fs.rm(f.dir, { recursive: true, force: true }) };
}
describe("grouped Read scope protected review", () => {
  it.each([true, false, null])("records only the explicit displayed decision %s through native CAS", async accepted => {
    const h = await setup();
    try {
      h.responses.push(accepted);
      const result = await h.host.review(h.q.id);
      expect(result.state).toBe(accepted === true ? "confirmed" : "pending");
      const saved = h.f.state().operator_questions![0]!;
      expect(!!saved.confirmation).toBe(accepted === true); expect(saved.raw_answer).toBeUndefined();
      expect(h.views).toHaveLength(1); expect(h.views[0]).toMatchObject({ kind: "readback", defaultValue: false });
      expect(h.f.state().generation_recovery!.operations).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("keeps a not-yet-mapped proposal pending and cannot present a Yes decision", async () => {
    const h = await setup({ pending: true });
    try {
      h.responses.push("keep"); expect((await h.host.review(h.q.id)).state).toBe("pending");
      expect(h.views[0]).toMatchObject({ kind: "pending", canReview: false, defaultValue: "keep" });
      expect(h.f.state().operator_questions![0]!.proposal).toBeUndefined();
    } finally { await h.cleanup(); }
  });
  it("reopens the same declined proposal and records an ordinary replacement request without inventing a successor", async () => {
    const h = await setup();
    try {
      h.responses.push(false); await h.host.review(h.q.id);
      const declined = structuredClone(h.f.state().operator_questions![0]!);
      h.responses.push("replace"); expect((await h.host.review(h.q.id)).state).toBe("replace_requested");
      expect(h.f.state().operator_questions).toHaveLength(1);
      expect(h.f.state().operator_questions![0]!.read_scope).toEqual(declined.read_scope);
      h.responses.push("review", true); expect((await h.host.review(h.q.id)).state).toBe("confirmed");
      expect(h.f.state().operator_questions![0]!.disposition_history).toEqual(expect.arrayContaining(declined.disposition_history!));
    } finally { await h.cleanup(); }
  });
  it("refuses Source drift during an unlocked wait", async () => {
    const h = await setup();
    try {
      h.controls.duringWait = async () => { h.controls.currentBinding.source_digest = digest("changed Source"); };
      h.responses.push(true); await expect(h.host.review(h.q.id)).rejects.toThrow("READ_SCOPE_REVIEW_CHANGED");
      expect(h.f.state().operator_questions![0]!.confirmation).toBeUndefined();
    } finally { await h.cleanup(); }
  });
  it("does not silently adopt a newer question or claim success after failed save", async () => {
    const h = await setup();
    try {
      h.controls.duringWait = async () => { h.controls.failSave = true; };
      h.responses.push(true); await expect(h.host.review(h.q.id)).rejects.toThrow("NATIVE_REVIEW_SAVE_FAILED");
      expect(h.f.state().operator_questions![0]!.confirmation).toBeUndefined();
      h.controls.failSave = false; h.controls.duringWait = undefined;
      await h.f.produce(h.f.state().operator_questions![0]!);
      await expect(h.host.review(h.q.id)).rejects.toThrow("READ_SCOPE_REVIEW_CHANGED");
    } finally { await h.cleanup(); }
  });
  it("detects an exact question revision change during the human wait", async () => {
    const h = await setup();
    try {
      h.controls.duringWait = async () => { await h.f.save(leaveOperatorQuestionPending(h.f.state().operator_questions![0]!, "cancelled")); };
      h.responses.push(true); await expect(h.host.review(h.q.id)).rejects.toThrow("READ_SCOPE_REVIEW_CHANGED");
      expect(h.f.state().operator_questions![0]!.confirmation).toBeUndefined();
    } finally { await h.cleanup(); }
  });
  it("uses the shared presenter with default No and the exact binding", async () => {
    const h = await setup({ noRead: true });
    try {
      h.responses.push(false); await h.host.review(h.q.id);
      const view = h.views[0]!, confirm = vi.fn(async (..._args: unknown[]) => true);
      const response: ReadScopeInteractionResponse = await presentReadScopeInteraction({ view,
        session: { confirm, promptText: vi.fn(), chooseOption: vi.fn() } });
      expect(response).toEqual({ kind: "decision", binding: view.binding, accepted: true });
      expect(confirm.mock.calls[0]?.[1]).toMatchObject({ defaultValue: false, decisionKind: "business_review", localOnly: true });
    } finally { await h.cleanup(); }
  });
});
