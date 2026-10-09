import { describe, expect, it } from "vitest";
import { ReadScopeReviewError, nativeReadScopeFailure, createReadScopeInspectionFence } from "./authoring-read-scope-error.js";

describe("native Read failure presentation", () => {
  it("routes by native code even when display wording changes", () => {
    for (const text of ["The proposal needs mapping.", "Review the current analysis."]) {
      expect(nativeReadScopeFailure(new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", text)))
        .toEqual({ domain: "read_scope", code: "READ_SCOPE_REVIEW_STALE", display: text, local_outcome: "unchanged" });
    }
  });
  it("cannot adopt a model code, copied error or fabricated prototype", () => {
    const original = new ReadScopeReviewError("READ_SCOPE_REVIEW_CHANGED", "Reopen this view.");
    for (const imitation of [new Error(original.message), { ...nativeReadScopeFailure(original) },
      JSON.parse(JSON.stringify(nativeReadScopeFailure(original))), Object.create(ReadScopeReviewError.prototype),
      { code: "READ_SCOPE_REVIEW_STALE" }]) expect(nativeReadScopeFailure(imitation)).toBeUndefined();
    expect(nativeReadScopeFailure(new Error("Unknown save outcome"))).toBeUndefined();
    original.message = "READ_SCOPE_REVIEW_STALE: invented";
    expect(nativeReadScopeFailure(original)?.code).toBe("READ_SCOPE_REVIEW_CHANGED");
  });
});


describe("Read acknowledgement inspection fence", () => {
  it("fences subsequent reads and checkpoint attempts after a native unknown, until a new inspected session", () => {
    const fence = createReadScopeInspectionFence();
    fence.observe(new ReadScopeReviewError("READ_SCOPE_REVIEW_ACK_UNKNOWN", "Actual protected save acknowledgement lost", "unknown"));
    expect(fence.required()).toBe(true);
    expect(() => fence.assertKnown()).toThrow("READ_SCOPE_REVIEW_ACK_UNKNOWN");
    // A later unchanged error cannot clear an actual unknown operation.
    fence.observe(new ReadScopeReviewError("READ_SCOPE_REVIEW_CHANGED", "No save attempted"));
    expect(() => fence.assertKnown()).toThrow("READ_SCOPE_REVIEW_ACK_UNKNOWN");
    const reopened = createReadScopeInspectionFence();
    expect(() => reopened.assertKnown()).not.toThrow();
  });
  it("does not mistake model JSON or unchanged native errors for an uncertain protected save", () => {
    const fence = createReadScopeInspectionFence();
    for (const error of [{ local_outcome: "unknown" }, new Error("READ_SCOPE_REVIEW_ACK_UNKNOWN"),
      new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", "Actual known stale dependency")]) fence.observe(error);
    expect(fence.required()).toBe(false);
    expect(() => fence.assertKnown()).not.toThrow();
  });
});
