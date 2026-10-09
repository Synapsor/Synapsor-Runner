import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createAuthoringRecoveryHost, type AuthoringRecoveryInspection } from "./authoring-recovery-host.js";
import type { AuthoringInterruptedRecoveryPreview, AuthoringTransportOperation } from "./authoring-generation-recovery.js";
import type { AuthoringRecoveryView } from "./authoring-recovery-interaction.js";

// Synthetic existing host-port presentation controls; never native continuation
// or saved-job success claims. Actual PG route acceptance remains separate.
function fixture(count: number, attempts: number, owner: boolean, choice = "pause", accepted = false) {
  const digest = canonicalJsonDigest;
  const preview: AuthoringInterruptedRecoveryPreview = {
    operation_id: "selected-step", attempt_id: "selected-attempt", checkpoint_digest: digest("resume"),
    operation_digest: digest("operation"), prior_context_digest: digest("old"), current_context_digest: digest("current"),
    state_digest: digest("recovery"), root_operation_id: "selected-step", remaining_attempts: attempts, unresolved_operation_count: count,
  };
  const snapshot: AuthoringRecoveryInspection = { resume: preview.checkpoint_digest, digest: digest("inspection"), recovery: undefined,
    business: ["Unfinished task: Read mapping"], retained: ["Original retained work"] };
  const access = {
    inspect: vi.fn(async () => structuredClone(snapshot)),
    unresolved: vi.fn(() => Array.from({ length: count }, (_, index) => ({ id: index ? `other-step-${index}` : preview.operation_id,
      state: index ? "partial" : "handled" } as AuthoringTransportOperation))),
    prepareInterrupted: vi.fn(async () => preview),
    prepareManual: vi.fn(async () => { throw new Error("Manual replacement not requested"); }),
    hasRemainingOwner: vi.fn(() => owner), recordInterrupted: vi.fn(async () => {}), recordManual: vi.fn(async () => {}),
  };
  const views: AuthoringRecoveryView[] = [];
  const host = createAuthoringRecoveryHost({ access, interact: async view => {
    views.push(structuredClone(view));
    if (view.kind === "select") return { kind: "choice", binding: view.binding, value: preview.operation_id };
    if (view.kind === "confirm") return { kind: "decision", binding: view.binding, accepted };
    if (view.kind === "details") return { kind: "details", binding: view.binding };
    return { kind: "choice", binding: view.binding, value: choice };
  } });
  return { host, access, views, preview, snapshot };
}

describe("recovery Continue availability explanations", () => {
  it.each([
    [2, 2, true], [1, 0, true], [1, 1, false], [2, 0, true],
    [2, 1, false], [1, 0, false], [2, 0, false],
  ] as const)("explains every current blocker without changing the gate (%s unfinished, %s attempts, owner=%s)", async (count, attempts, owner) => {
    const f = fixture(count, attempts, owner);
    expect(await f.host.review("interrupted")).toBe("pending");
    const view = f.views.find(view => view.kind === "mode")!;
    expect(view.options?.map(option => option.value)).toEqual(["details", "review", "pause"]);
    for (const text of [view.lines.join("\n"), view.details.join("\n")]) {
      expect(text).toContain("Continue is unavailable");
      expect(text.includes(`${count} unfinished operations remain`)).toBe(count !== 1);
      expect(text.includes("No same-step attempts remain")).toBe(attempts <= 0);
      expect(text.includes("No remaining saved provider allowance owns this exact step")).toBe(!owner);
      expect(text).toContain("Local review does not complete the work, replay output, or grant another allowance");
      if (count > 1) expect(text).toContain("Review each unfinished step separately");
    }
    expect(f.access.recordInterrupted).not.toHaveBeenCalled();
    expect(f.views.some(view => view.kind === "confirm")).toBe(false);
  });

  it("preserves the eligible Continue option without an unavailable claim", async () => {
    const f = fixture(1, 1, true);
    expect(await f.host.review("interrupted")).toBe("pending");
    const view = f.views.find(view => view.kind === "mode")!;
    expect(view.options?.map(option => option.value)).toEqual(["details", "continue", "review", "pause"]);
    expect([...view.lines, ...view.details].join("\n")).not.toContain("Continue is unavailable");
    expect(f.access.recordInterrupted).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps per-step local review default-No and exact preview binding (accepted=%s)", async accepted => {
    const f = fixture(2, 2, true, "review", accepted);
    expect(await f.host.review("interrupted")).toBe(accepted ? "recorded" : "pending");
    expect(f.views.find(view => view.kind === "confirm")?.defaultValue).toBe(false);
    expect(f.access.prepareInterrupted).toHaveBeenCalledExactlyOnceWith(f.snapshot.resume, f.preview.operation_id);
    if (accepted) expect(f.access.recordInterrupted).toHaveBeenCalledExactlyOnceWith(f.preview, "local_review", f.snapshot.digest);
    else expect(f.access.recordInterrupted).not.toHaveBeenCalled();
    expect(f.access.recordManual).not.toHaveBeenCalled();
  });
});
