import { describe, expect, it, vi } from "vitest";
import { verifiedActionActivationChoiceCopy, verifiedActionManualRevisionChoice } from "./verified-action-review.js";

describe("verified Action manual revision entry", () => {
  it("offers an explicit disabled-only manual route without requiring Read activation", () => {
    const run = vi.fn();
    const choices = verifiedActionManualRevisionChoice({ run });

    expect(choices).toEqual([expect.objectContaining({
      value: "manual_revision",
      label: "Edit business rules manually",
    })]);
    expect(choices[0]?.detail).toContain("current draft and live permissions stay unchanged");
    expect(verifiedActionManualRevisionChoice(undefined)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("verified Action activation guidance", () => {
  it("names an unfinished program when Read is current, without directing the operator to reactivate Read", () => {
    const choice = verifiedActionActivationChoiceCopy({ draftReady: false, readReviewPending: false, programConcern: true,
      subjectConcern: false, canRecheckRead: false, boundaryName: "reviewed_staging" });
    expect(choice.label).toBe("Review saved program status first");
    expect(choice.detail).toContain("attached-policy review concern");
    expect(`${choice.label} ${choice.detail}`).not.toContain("Activate linked Read Boundary first");
  });

  it("keeps Read guidance for a real Read dependency and activation wording for a ready draft", () => {
    const base = { readReviewPending: false, programConcern: false, subjectConcern: false, canRecheckRead: false,
      boundaryName: "reviewed_staging" };
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false }).label)
      .toBe("Activate linked Read Boundary first");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: true }).label)
      .toBe("Activate this exact proposal authority");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false,
      readReviewPending: true, programConcern: true }).label).toBe("Activate linked Read Boundary first");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false,
      canRecheckRead: true, programConcern: true }).label).toBe("Recheck saved changes first");
  });
});
