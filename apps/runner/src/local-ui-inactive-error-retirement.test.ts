import { describe, expect, it } from "vitest";
import { isInactiveExplorationBoundary } from "./local-ui.js";

describe("B64 inactive authority error projection", () => {
  it("does not claim inactive authority from an untyped matching message", () => {
    expect(isInactiveExplorationBoundary(new Error("Exploration boundary is not active."))).toBe(false);
  });
  it("uses the owner-produced error code independently of wording", () => {
    expect(isInactiveExplorationBoundary(Object.assign(new Error("La révision est désactivée."), {
      code: "EXPLORATION_BOUNDARY_INACTIVE",
    }))).toBe(true);
  });
  it("retains exact missing activation artifact handling and rejects unrelated missing files", () => {
    for (const name of ["exploration-boundary.active.json", "exploration-boundaries.active.json"]) {
      expect(isInactiveExplorationBoundary(Object.assign(new Error("unavailable"), {
        code: "ENOENT", path: `/owned/project/.synapsor/${name}`,
      }))).toBe(true);
    }
    expect(isInactiveExplorationBoundary(Object.assign(new Error("unavailable"), {
      code: "ENOENT", path: "/owned/project/unrelated.json",
    }))).toBe(false);
  });
});
