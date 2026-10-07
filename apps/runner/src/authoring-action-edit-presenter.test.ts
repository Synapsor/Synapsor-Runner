import { describe, expect, it, vi } from "vitest";
import {
  presentActionEditSave,
  presentUnchangedActionRequest,
  rememberRequestedActionRevision,
} from "./authoring-question-presenter.js";

// Display-only declared fixtures. These are not compiled rules or saved authority.
const instruction = "  Lower the selected limit from 30 to 10; keep the peer rule.\n";
const current = { outcome: "fixture.request", require: { maximum: 30 }, approval: { reviewers: 1 } };

describe("native Action edit presentation", () => {
  it.each([false, undefined, true])("retains exact differences and default-No, returning only the actual decision %s", async answer => {
    const exactChanges = ["/limit: 30 -> 10", "/approval/reviewers: 1 -> 2", "/private/visible: false -> true"];
    const rememberDetails = vi.fn();
    const confirm = vi.fn(async (_question: string, options: any) => {
      expect(rememberDetails).toHaveBeenCalledOnce();
      expect(options.defaultValue).toBe(false);
      expect(options.context).toContain(`Requested edit: ${instruction}`);
      expect(options.exactDetails.lines).toBe(exactChanges);
      for (const change of exactChanges) expect(options.context).toContain(change);
      return answer;
    });
    const before = structuredClone(exactChanges);
    expect(await presentActionEditSave({ session: { confirm }, chat: { rememberDetails }, instruction, exactChanges })).toBe(answer);
    expect(confirm).toHaveBeenCalledOnce();
    expect(rememberDetails.mock.calls[0]![1]).toBe(exactChanges);
    expect(exactChanges).toEqual(before);
  });

  it("works without chat and propagates a native wait refusal without a second prompt", async () => {
    const failure = new Error("ACTUAL_HOST_CONTEXT_CHANGED");
    const confirm = vi.fn(async () => { throw failure; });
    await expect(presentActionEditSave({ session: { confirm }, instruction, exactChanges: ["/limit: 30 -> 10"] })).rejects.toBe(failure);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("keeps complete requested reconciliation before/after without another consent port", () => {
    const before = { outcome: "fixture.request", approval: { reviewers: 1 }, peers: ["retain"], guard: false };
    const after = { ...before, approval: { reviewers: 2 } };
    const snapshot = structuredClone({ before, after });
    const rememberDetails = vi.fn();
    rememberRequestedActionRevision({ chat: { rememberDetails }, differences: ["Reviewers: 1 -> 2"], before, after });
    expect(rememberDetails).toHaveBeenCalledOnce();
    const lines: string[] = rememberDetails.mock.calls[0]![1];
    expect(lines[0]).toBe("Reviewers: 1 -> 2");
    const beforeIndex = lines.indexOf("Before:"), afterIndex = lines.indexOf("After:");
    expect(JSON.parse(lines.slice(beforeIndex + 1, afterIndex).join("\n"))).toEqual(before);
    expect(JSON.parse(lines.slice(afterIndex + 1).join("\n"))).toEqual(after);
    expect({ before, after }).toEqual(snapshot);
  });

  it.each([false, undefined])("does not ask a reason after unchanged-request decision %s", async answer => {
    const confirm = vi.fn(async (_question: string, options: any) => {
      expect(options.defaultValue).toBe(false);
      expect(options.context).toContain(`Pending request: ${instruction}`);
      expect(options.context).toContain(`Current eligibility: ${JSON.stringify(current.require)}`);
      expect(options.context).toContain(`Current approval: ${JSON.stringify(current.approval)}`);
      return answer;
    });
    const chooseOption = vi.fn(async () => "cancelled");
    expect(await presentUnchangedActionRequest({ session: { confirm, chooseOption }, instruction, current })).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(chooseOption).not.toHaveBeenCalled();
  });

  it.each(["pending", undefined, "unrecognized", "confirmed_current", "cancelled"])("requires an explicit unchanged-request reason: %s", async reason => {
    const confirm = vi.fn(async () => true);
    const chooseOption = vi.fn(async (_title: string, options: any[], config: any) => {
      expect(confirm).toHaveBeenCalledOnce();
      expect(options.map(option => option.value)).toEqual(["pending", "confirmed_current", "cancelled"]);
      expect(config).toMatchObject({ initialValue: "pending", reviewOnly: true, displayContext: true });
      expect(config.context).toContain(`Request: ${instruction}`);
      return reason;
    });
    const snapshot = structuredClone(current);
    expect(await presentUnchangedActionRequest({ session: { confirm, chooseOption }, instruction, current }))
      .toBe(reason === "confirmed_current" || reason === "cancelled" ? reason : undefined);
    expect(chooseOption).toHaveBeenCalledOnce();
    expect(current).toEqual(snapshot);
  });

  it("keeps the request pending when the reason menu is unavailable", async () => {
    expect(await presentUnchangedActionRequest({ session: { confirm: async () => true }, instruction, current })).toBeUndefined();
  });
});
