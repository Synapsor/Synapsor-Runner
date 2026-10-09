import { describe, expect, it } from "vitest";
import { ReadScopeReviewError, nativeReadScopeFailure } from "./authoring-read-scope-error.js";

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
