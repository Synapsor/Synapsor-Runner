import { describe, expect, it } from "vitest";
import { compileActionRule } from "./compile.js";
import { ActionRuleError } from "./errors.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";

describe.each(["postgres", "mysql"] as const)("complete collection diagnostic: %s", engine => {
  it("retains the actual refusal and identifies the collection strategy without message parsing", () => {
    const fixture = completeCollectionFixture(engine);
    fixture.verification_boundary.resources[1]!.scope = { mode: "inherited", from_binding: "customer" };
    let refusal: unknown;
    try { compileActionRule(fixture); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(ActionRuleError);
    const error = refusal as ActionRuleError;
    expect(error.code).toBe("ACTION_RULE_UNBOUNDED");
    expect(error.message).toBe("Complete collection holds requires an inverse foreign key from one directly scoped parent and explicit matching child scope.");
    expect(error.path).toBe("verification_boundary.resources.holds.collection_consistency");
  });
});
