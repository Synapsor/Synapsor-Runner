import { describe, expect, it, vi } from "vitest";
import { verifiedActionManualRevisionChoice } from "./verified-action-review.js";

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
