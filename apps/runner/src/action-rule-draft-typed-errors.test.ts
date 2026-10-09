import { describe, expect, it } from "vitest";
import { ActionRuleError } from "@synapsor-runner/action-rules";
import { actionRuleDraftDiagnostics } from "./action-rule-draft.js";

// Actual existing producer projection, not a replacement display classifier.
// The same formal code in prose/JSON is not a trusted Runtime error instance.
describe("Action draft preserves trusted error identity", () => {
  const code = "ACTION_RULE_SCOPE_UNPROVEN" as const;
  const path = "verification_boundary.resources.r9_link.collection_consistency";

  it("preserves a genuine Runtime error code and formal path with opaque display", () => {
    const error = new ActionRuleError(code, "Opaque producer display.", path);
    expect(actionRuleDraftDiagnostics(error)).toEqual([
      expect.objectContaining({ code, path, message: "Opaque producer display." }),
    ]);
  });

  it("does not promote a known code appearing only in ordinary Error prose", () => {
    const error = new Error(`${code}: Opaque producer display.`);
    const diagnostics = actionRuleDraftDiagnostics(error);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).not.toBe(code);
    expect(diagnostics[0]!.path).toBeUndefined();
    expect(diagnostics[0]!.repair).not.toBe("operator");
  });

  it.each([
    { code, path, message: "Opaque producer display." },
    JSON.parse(JSON.stringify({ name: "ActionRuleError", code, path, message: "Opaque producer display." })),
  ])("does not revive an untrusted error-shaped object as a Runtime error", value => {
    const diagnostics = actionRuleDraftDiagnostics(value);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).not.toBe(code);
    expect(diagnostics[0]!.path).toBeUndefined();
    expect(diagnostics[0]!.repair).not.toBe("operator");
  });
});
