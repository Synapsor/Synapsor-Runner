import { afterEach, describe, expect, it, vi } from "vitest";
import * as reads from "./auto-boundary.js";
import * as actions from "./action-rule-authority.js";
import { readActivationImpact, readActivationImpactLines } from "./read-activation-impact.js";

afterEach(() => vi.restoreAllMocks());

describe("Read activation impact display failures", () => {
  // Failed assessments must not fabricate a clean result, expose store internals,
  // or become new activation failures. Real successful projections use the CLI fixture.
  it.each(["read", "activation", "revision"] as const)("reports unavailable assessment for an unreadable %s", async stage => {
    const privateError = Object.assign(new Error("private store details must not escape"), { code: "ENOENT" });
    vi.spyOn(reads, "loadActivatedExplorationBoundaries").mockImplementation(async () => {
      if (stage === "read") throw new Error("private corrupt Read snapshot");
      return [];
    });
    vi.spyOn(actions, "readActionRuleAuthorityActivation").mockImplementation(async () => {
      if (stage === "activation") throw privateError;
      return { state: "active" } as Awaited<ReturnType<typeof actions.readActionRuleAuthorityActivation>>;
    });
    vi.spyOn(actions, "loadActiveActionRuleAuthority").mockRejectedValue(privateError);
    const impact = await readActivationImpact("/owned-test-project", {} as reads.ExplorationBoundaryDraft);
    expect(impact.assessment).toBe("unavailable");
    const lines = readActivationImpactLines(impact).join("\n");
    expect(lines).toContain("COULD NOT BE ASSESSED");
    expect(lines).toMatch(/Action recheck.*writer review/s);
    expect(lines).not.toContain("private");
  });

  it("does not warn when no Action authority exists", async () => {
    vi.spyOn(reads, "loadActivatedExplorationBoundaries").mockResolvedValue([]);
    vi.spyOn(actions, "readActionRuleAuthorityActivation").mockResolvedValue(undefined);
    const load = vi.spyOn(actions, "loadActiveActionRuleAuthority");
    expect(readActivationImpactLines(await readActivationImpact("/owned-test-project", {} as reads.ExplorationBoundaryDraft))).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
