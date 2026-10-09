import { describe, expect, it } from "vitest";
import { phaseForDiagnostics } from "./action-rule-model.js";

describe("actual diagnostic correction phase retirement preseal", () => {
  it.each(["approval and shared limit", "effect envelope and numeric bounds", "verification binding and relationship"])(
    "does not choose a focused correction from unclassified English prose: %s", message => {
      expect(phaseForDiagnostics([{ code: "ACTION_RULE_DRAFT_INVALID", message, repair: "model" }])).toBe("rule");
    });
  it.each([
    ["approval.shared_limits", "approval"],
    ["rule.effect.set.amount", "effect"],
    ["effect_envelope.allowed_fields", "effect"],
    ["verification_boundary.resources.collection", "verification"],
    ["rule.require", "rule"],
  ] as const)("uses exact diagnostic locator %s regardless of prose", (path, expected) => {
    expect(phaseForDiagnostics([{ code: "ACTION_RULE_DRAFT_INVALID", path,
      message: "approval effect verification contradictory display text", repair: "model" }])).toBe(expected);
  });
  it("keeps Source input fidelity as the existing typed rule correction", () => {
    expect(phaseForDiagnostics([{ code: "SOURCE_INPUT_CONSTRAINT_WEAKER", message: "effect envelope approval", repair: "model" }])).toBe("rule");
  });
});
