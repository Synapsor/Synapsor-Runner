import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { presentAuthoringRecovery } from "./authoring-interrupted-step-review.js";
import { createAuthoringRecoveryHost, type AuthoringRecoveryInspection } from "./authoring-recovery-host.js";
import type { AuthoringInterruptedRecoveryPreview, AuthoringTransportOperation } from "./authoring-generation-recovery.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

const digest = canonicalJsonDigest;
const preview: AuthoringInterruptedRecoveryPreview = {
  operation_id: "old-step", attempt_id: "old-attempt", checkpoint_digest: digest("resume"),
  operation_digest: digest("operation"), prior_context_digest: digest("old"), current_context_digest: digest("current"),
  state_digest: digest("recovery"), root_operation_id: "old-step", remaining_attempts: 1, unresolved_operation_count: 1,
};
// Synthetic host-port controls. Native interruption, saving and cold continuation
// are separately exercised by the public-process fixtures, never inferred here.
const create = (choice: string | null, confirmed: boolean | null, canContinue = true) => {
  const snapshot: AuthoringRecoveryInspection = { resume: preview.checkpoint_digest, digest: digest("inspection"),
    recovery: undefined, business: ["Unfinished task: establish the acceptance rule"], retained: ["Exact saved work"] };
  const access = {
    inspect: vi.fn(async () => structuredClone(snapshot)),
    unresolved: vi.fn(() => [{id:preview.operation_id} as AuthoringTransportOperation]),
    prepareInterrupted: vi.fn(async () => preview), prepareManual: vi.fn(async () => ({
      operation_id: preview.operation_id, attempt_id: preview.attempt_id,
      checkpoint_digest: preview.checkpoint_digest, state_digest: preview.state_digest,
      context_digest: preview.current_context_digest,
    })),
    hasRemainingOwner: vi.fn(() => canContinue), recordInterrupted: vi.fn(async () => {}), recordManual: vi.fn(async () => {}),
  };
  const session = {
    chooseOption: vi.fn<NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>>(async () => choice ?? undefined),
    confirm: vi.fn<BoundaryReviewInteractiveSession["confirm"]>(async () => confirmed ?? undefined),
    showReviewDetails: vi.fn(async () => {}),
  };
  return { snapshot, access, session, host: createAuthoringRecoveryHost({ access,
    interact: view => presentAuthoringRecovery(view, session) }) };
};

describe("shared local recovery host", () => {
  it.each([null, "pause"])("retains cancellation/default pause with no decision (%s)", async choice => {
    const input = create(choice, true);
    expect(await input.host.review("interrupted")).toBe("pending");
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
    expect(input.session.confirm).not.toHaveBeenCalled();
    expect(input.session.chooseOption.mock.calls[0]?.[2]).toMatchObject({ initialValue: "pause" });
  });
  it.each([false, null])("keeps declined/unknown confirmation pending (%s)", async confirmed => {
    const input = create("continue", confirmed);
    expect(await input.host.review("interrupted")).toBe("pending");
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
    expect(input.session.confirm.mock.calls[0]?.[1]).toMatchObject({ defaultValue: false });
  });
  it("records only the exact inspected preview after details and explicit consent", async () => {
    const input = create("continue", true);
    input.session.chooseOption.mockResolvedValueOnce("details");
    expect(await input.host.review("interrupted")).toBe("recorded");
    expect(input.access.recordInterrupted).toHaveBeenCalledExactlyOnceWith(preview, "linked_generation", input.snapshot.digest);
    expect(input.session.showReviewDetails).toHaveBeenCalledOnce();
  });
  it("keeps local review without borrowing a missing owner", async () => {
    const input = create("review", true, false);
    expect(await input.host.review("interrupted")).toBe("recorded");
    expect(input.access.recordInterrupted).toHaveBeenCalledExactlyOnceWith(preview, "local_review", input.snapshot.digest);
    expect(input.session.chooseOption.mock.calls[0]?.[1]).not.toContainEqual(expect.objectContaining({ value: "continue" }));
    const forged = create("continue", true, false);
    await expect(forged.host.review("interrupted")).rejects.toThrow("AUTHORING_RECOVERY_CONTEXT_CHANGED");
    expect(forged.access.recordInterrupted).not.toHaveBeenCalled();
  });
  it("refuses a late Yes after the inspected saved work changes", async () => {
    const input = create("continue", true);
    input.session.confirm.mockImplementation(async () => { input.snapshot.digest = digest("competing source"); return true; });
    await expect(input.host.review("interrupted")).rejects.toThrow("AUTHORING_RECOVERY_CONTEXT_CHANGED");
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
  });
  it("binds a decision to the exact operation and view", async () => {
    const input = create("continue", true);
    const host = createAuthoringRecoveryHost({ access: input.access,
      interact: async view => ({ kind: "choice", binding: digest("another operation"), value: "continue" }) });
    await expect(host.review("interrupted")).rejects.toThrow("AUTHORING_RECOVERY_CONTEXT_CHANGED");
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
  });
  it("does not report recorded when persistence acknowledgement fails", async () => {
    const input = create("continue", true);
    input.access.recordInterrupted.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(input.host.review("interrupted")).rejects.toThrow("lost acknowledgement");
  });
  it("uses the same host default-No contract for exact manual replacement", async () => {
    const input = create(null, false);
    expect(await input.host.review("manual")).toBe("pending");
    expect(input.access.recordManual).not.toHaveBeenCalled();
    input.session.confirm.mockResolvedValueOnce(true);
    expect(await input.host.review("manual")).toBe("recorded");
    expect(input.access.recordManual).toHaveBeenCalledOnce();
    expect(input.session.confirm.mock.calls[0]?.[1]).toMatchObject({ defaultValue: false });
  });
  it("cannot use a local-review Yes for linked continuation", async () => {
    const input=create("review",true);
    let localBinding: `sha256:${string}` | undefined;
    const first=createAuthoringRecoveryHost({access:input.access,interact:async view=>{
      if(view.kind==="confirm") { localBinding=view.binding; return {kind:"decision",binding:view.binding,accepted:false}; }
      return presentAuthoringRecovery(view,input.session);
    }});
    expect(await first.review("interrupted")).toBe("pending");
    input.session.chooseOption.mockResolvedValue("continue");
    const forged=createAuthoringRecoveryHost({access:input.access,interact:async view=>view.kind==="confirm"
      ? {kind:"decision",binding:localBinding!,accepted:true} : presentAuthoringRecovery(view,input.session)});
    await expect(forged.review("interrupted")).rejects.toThrow("AUTHORING_RECOVERY_CONTEXT_CHANGED");
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
  });
  it("offers honest local inspection when no operation can be selected", async () => {
    const input=create("continue",true); input.access.unresolved.mockReturnValueOnce([]);
    expect(await input.host.review("interrupted")).toBe("pending");
    expect(input.access.prepareInterrupted).not.toHaveBeenCalled();
    expect(input.session.showReviewDetails).toHaveBeenCalledOnce();
    expect(input.access.recordInterrupted).not.toHaveBeenCalled();
  });
});
