import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { saveAuthoringRecoveryResume } from "./authoring-recovery-resume.js";
import {
  assertBoundaryAuthoringResumeCurrent, buildBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState,
} from "./boundary-authoring-resume.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

type SaveInput = Parameters<typeof saveAuthoringRecoveryResume>[0];
const roots: string[] = [];
const binding = {
  boundary_name: "reviewed",
  generation_lock_fingerprint: canonicalJsonDigest("writer generation"),
  schema_fingerprint: canonicalJsonDigest("writer schema"),
  role_posture_fingerprint: canonicalJsonDigest("writer reader"),
};
function resume() {
  return buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting",
    jobIntent: "Preserve the pending business change.", provider: "openai", model: "offline-test",
    action: { intent: "Review the reserve change." },
    conversation: [{ kind: "clarification", question: "Which review is required?", answer: "One review." }],
    now: "2026-10-06T00:00:00.000Z" });
}
function recovery(): AuthoringTransportState { return { version: 1, operations: [] }; }
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-recovery-writer-"));
  roots.push(root); return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("acknowledged Resume transport writer", () => {
  it("passes the actual held permit through currentness and native CAS, preserving unrelated saved work", async () => {
    const root = await project(), base = resume(), before = structuredClone(base), state = recovery();
    await writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: null });
    await withProjectAuthorityMutation(root, async permit => {
      const assertCurrent = vi.fn<SaveInput["assertCurrent"]>(async received => {
        expect(received).toBe(permit);
        await assertBoundaryAuthoringResumeCurrent(root, base, undefined, { permit: received });
      });
      const write = vi.fn<SaveInput["write"]>(async (next, options) => {
        expect(options).toEqual({ expectedRevisionDigest: base.revision_digest, permit });
        expect(options.permit).toBe(permit);
        return writeBoundaryAuthoringResumeState(root, next, options);
      });
      const next = await saveAuthoringRecoveryResume({ resume: base, expectedRevision: base.revision_digest,
        recovery: state, permit, assertCurrent, write });
      expect(assertCurrent).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(next.generation_recovery).toEqual(state);
      expect(next.generation_recovery).not.toBe(state);
      expect(next.generation_recovery!.operations).not.toBe(state.operations);
      const { revision_digest, ...unsigned } = next;
      expect(revision_digest).toBe(canonicalJsonDigest(unsigned));
      expect(next).toMatchObject({ binding: base.binding, action: base.action, conversation: base.conversation,
        stage: base.stage, job_intent: base.job_intent });
      expect(base).toEqual(before);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: next });
    });
  });

  it("does not return or advance the caller baseline while native acknowledgement is pending", async () => {
    const base = resume(); let local = base, accepted = false;
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const call = saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
      recovery: recovery(), assertCurrent: async () => {},
      write: async (_next, options) => { expect(options).toEqual({ expectedRevisionDigest: base.revision_digest }); entered(); await pending; },
    }).then(next => { local = next; accepted = true; });
    await started;
    expect(local).toBe(base); expect(accepted).toBe(false);
    release(); await call;
    expect(accepted).toBe(true); expect(local).not.toBe(base);
    expect(base.generation_recovery).toBeUndefined();
  });

  it("refuses an unacknowledged baseline before invoking currentness or the writer", async () => {
    const base = resume(), assertCurrent = vi.fn(), write = vi.fn();
    await expect(saveAuthoringRecoveryResume({ resume: base, expectedRevision: canonicalJsonDigest("another revision"),
      recovery: recovery(), assertCurrent, write })).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(assertCurrent).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("propagates the exact currentness failure without writing or resetting caller state", async () => {
    const base = resume(), failure = new Error("Source review context changed"), write = vi.fn(); let local = base;
    await expect((async () => {
      local = await saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
        recovery: recovery(), assertCurrent: async () => { throw failure; }, write });
    })()).rejects.toBe(failure);
    expect(local).toBe(base); expect(write).not.toHaveBeenCalled();
  });

  it("propagates a native history refusal once without fallback save or local rollback", async () => {
    const base = resume(), before = structuredClone(base), failure = new Error("AUTHORING_TRANSPORT_STATE_INVALID");
    let local = base;
    // Native history validation is deliberately not duplicated by this adapter contract.
    const write = vi.fn(async () => { throw failure; });
    await expect((async () => {
      local = await saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
        recovery: recovery(), assertCurrent: async () => {}, write });
    })()).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1); expect(local).toBe(base); expect(base).toEqual(before);
  });

  it("uses only the latest acknowledged revision on successive native saves", async () => {
    const root = await project(); let local = resume(); const initial = local;
    await writeBoundaryAuthoringResumeState(root, local, { expectedRevisionDigest: null });
    const expected: string[] = [];
    for (let i = 0; i < 2; i++) {
      local = await saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
        recovery: recovery(), assertCurrent: () => assertBoundaryAuthoringResumeCurrent(root, local),
        write: (next, options) => { expected.push(options.expectedRevisionDigest); return writeBoundaryAuthoringResumeState(root, next, options); },
      });
      if (i === 0) expect(expected).toEqual([initial.revision_digest]);
    }
    expect(expected[1]).not.toBe(initial.revision_digest);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: local });
  });

  it("leaves a competing native save intact when CAS rejects after currentness passed", async () => {
    const root = await project(), base = resume(); let local = base;
    await writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: null });
    const competing = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Inspect records instead.",
      provider: "openai", model: "offline-test", previous: base });
    const write = vi.fn<SaveInput["write"]>((next, options) => writeBoundaryAuthoringResumeState(root, next, options));
    await expect((async () => {
      local = await saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
        recovery: recovery(), assertCurrent: async () => {
          await assertBoundaryAuthoringResumeCurrent(root, base);
          await writeBoundaryAuthoringResumeState(root, competing, { expectedRevisionDigest: base.revision_digest });
        }, write });
    })()).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(write).toHaveBeenCalledTimes(1); expect(local).toBe(base);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: competing });
  });

  it.each([false, true])("keeps the caller baseline after a native lost acknowledgement (rename committed=%s)", async committed => {
    const root = await project(), base = resume(); let local = base;
    await writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: null });
    const rename = fs.rename, failure = Object.assign(new Error("test lost native acknowledgement"), { code: "EACCES" });
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      if (committed) await rename(from, to);
      throw failure;
    });
    let attempted: BoundaryAuthoringResumeState | undefined;
    const write = vi.fn<SaveInput["write"]>((next, options) => { attempted = next; return writeBoundaryAuthoringResumeState(root, next, options); });
    await expect((async () => {
      local = await saveAuthoringRecoveryResume({ resume: local, expectedRevision: local.revision_digest,
        recovery: recovery(), assertCurrent: () => assertBoundaryAuthoringResumeCurrent(root, base), write });
    })()).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1); expect(local).toBe(base);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: committed ? attempted : base });
    expect(await fs.readdir(path.join(root, ".synapsor/boundary-authoring"))).toEqual(["resume.json"]);
  });
});
