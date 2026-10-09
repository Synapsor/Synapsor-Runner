import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { createReadScopeHost, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
import { presentReadScopeInteraction } from "./authoring-question-presenter.js";
import { readBoundaryAuthoringResumeStateHeld } from "./boundary-authoring-resume.js";
import { leaveOperatorQuestionPending } from "./authoring-operator-question.js";
import { buildBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { nativeReadScopeFailure } from "./authoring-read-scope-error.js";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";

// Actual controlled provider and native Resume CAS. The mutation callback models
// the protected owner's lease boundary; this is not installed/public acceptance.
async function setup(options: { pending?: boolean; noRead?: boolean } = {}) {
  const f = await nativeFixture(options.noRead, options.pending), q = await f.produce();
  const {binding,inventory,analysis}=f;
  const controls = { currentBinding: structuredClone(binding), failSave: false, failAck: false, ackUnavailable: false,
    duringWait: undefined as (() => Promise<void>) | undefined };
  let locked = false;
  const views: ReadScopeInteraction[] = [], responses: Array<boolean | null | "keep" | "review" | "replace"> = [];
  const loadSnapshot = async (questionId: string, permit: ProjectAuthorityMutationPermit) => {
      if (controls.ackUnavailable) throw new Error("Actual acknowledgement read unavailable");
      const disk = await readBoundaryAuthoringResumeStateHeld(f.dir, f.nativeBinding, permit);
      if (disk.status !== "ready") throw new Error("Actual native fixture unavailable");
      return { questions: disk.value.operator_questions!, handoffs: disk.value.owner_handoffs ?? [], generation: disk.value.generation_recovery,
        question_id: questionId, expectedBinding: controls.currentBinding, ...inventory,
        historical_inventory: { binding, ...inventory },
        ...(!options.pending && !options.noRead ? { analysis: analysis() } : {}),
        resume_revision_digest: disk.value.revision_digest, context_digest: q.context_digest, scope_digest: q.scope_digest };
    };
  const host = createReadScopeHost({ access: {
    load: questionId => withProjectAuthorityMutation(f.dir, permit => loadSnapshot(questionId, permit)),
    loadHeld: (questionId, permit) => withHeldProjectAuthorityAccess(f.dir, permit, held => loadSnapshot(questionId, held)),
    mutate: operation => withProjectAuthorityMutation(f.dir, async permit => { locked = true; try { return await operation(permit); } finally { locked = false; } }),
    save: async (next, { expected, permit }) => {
      expect(locked).toBe(true); expect(expected.resume_revision_digest).toBe(f.state().revision_digest);
      if (controls.failSave) throw new Error("NATIVE_REVIEW_SAVE_FAILED");
      if (f.state().operator_questions!.some(q => q.id === next.id)) await f.save(next, permit);
      else await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
        operatorQuestions: [...f.state().operator_questions!, next] }), permit);
      if (controls.failAck) controls.ackUnavailable = true;
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
  it("reports unknown acknowledgement after a durable decision instead of claiming unchanged", async () => {
    const h = await setup();
    try {
      h.responses.push(true);
      h.controls.duringWait = async () => { h.controls.failAck = true; };
      let failure: unknown;
      try { await h.host.review(h.q.id); } catch (error) { failure = error; }
      expect(nativeReadScopeFailure(failure)).toMatchObject({ code: "READ_SCOPE_REVIEW_ACK_UNKNOWN", local_outcome: "unknown" });
      expect(h.f.state().operator_questions![0]!.confirmation).toBeDefined();
      expect(h.views).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("loads authentic stale scope for inspection and keeps it pending without a Yes or model request", async () => {
    const h = await setup();
    try {
      h.controls.currentBinding.operation_digest = digest("changed reviewed permissions");
      const before = structuredClone(h.f.state());
      h.responses.push("keep");
      expect((await h.host.review(h.q.id)).state).toBe("pending");
      expect(h.views).toHaveLength(1);
      expect(h.views[0]).toMatchObject({ kind: "pending", canReview: false, canReplace: true });
      expect(h.f.state()).toEqual(before);
    } finally { await h.cleanup(); }
  });
  it("replaces stale confirmed scope with a validated pending successor, preserving the historical Yes", async () => {
    const h = await setup();
    try {
      h.responses.push(true); await h.host.review(h.q.id);
      const confirmed = structuredClone(h.f.state().operator_questions![0]!);
      const generation = structuredClone(h.f.state().generation_recovery);
      h.controls.currentBinding.catalog_digest = digest("narrower current catalog");
      h.responses.push("replace");
      const result = await h.host.review(h.q.id);
      expect(result.state).toBe("replace_requested"); expect(result.question_id).not.toBe(h.q.id);
      expect(h.f.state().operator_questions![0]).toEqual(confirmed);
      expect(h.f.state().operator_questions![1]).toMatchObject({ id: result.question_id,
        disposition: "declined", read_scope: { predecessor_id: h.q.id } });
      expect(h.f.state().operator_questions![1]!.confirmation).toBeUndefined();
      expect(h.f.state().generation_recovery).toEqual(generation);
    } finally { await h.cleanup(); }
  });
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
  it("does not claim a failed save and explicitly displays only the native validated successor", async () => {
    const h = await setup();
    try {
      h.controls.duringWait = async () => { h.controls.failSave = true; };
      h.responses.push(true); await expect(h.host.review(h.q.id)).rejects.toThrow("NATIVE_REVIEW_SAVE_FAILED");
      expect(h.f.state().operator_questions![0]!.confirmation).toBeUndefined();
      h.controls.failSave = false; h.controls.duringWait = undefined;
      const original = structuredClone(h.f.state().operator_questions![0]!);
      const successor = await h.f.produce(original);
      expect((await h.host.review(h.q.id)).state).toBe("pending");
      expect(h.views.at(-1)).toMatchObject({ kind: "readback", defaultValue: false,
        binding: { requested_question_id: h.q.id, requested_question_digest: original.digest,
          question_id: successor.id, question_digest: expect.any(String) } });
      expect(h.f.state().operator_questions![0]).toEqual(original);
      expect(h.f.state().operator_questions![1]!.confirmation).toBeUndefined();
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
