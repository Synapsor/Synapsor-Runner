import { describe, expect, it } from "vitest";
import { conflictGuardScalar } from "./safe-values.js";

describe("conflict guard scalar normalization", () => {
  it("normalizes safe driver integer strings without changing textual or unsafe guards", () => {
    expect(conflictGuardScalar("7")).toBe(7);
    expect(conflictGuardScalar("-7")).toBe(-7);
    expect(conflictGuardScalar("001")).toBe("001");
    expect(conflictGuardScalar("9007199254740992")).toBe("9007199254740992");
    expect(conflictGuardScalar("revision-7")).toBe("revision-7");
  });
});
