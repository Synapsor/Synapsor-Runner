import { describe, expect, it } from "vitest";
import { assertActionExecutionIntentPreserved, explicitActionExecutionIntent } from "./action-execution-intent.js";

describe("execution intent is a requirement, not authority", () => {
  it.each([
    "Automatically approve and complete valid plan changes. Do not write refunds, bill adjustments, new lines, ownership changes, or unrelated amendments.",
    "Automatically complete eligible enrollments. Never apply tuition discounts.",
    "Automatically complete approved support updates. Do not execute account closures.",
  ])("does not mistake exclusions of unrelated effects for proposal-only intent: %s", (request) => {
    expect(explicitActionExecutionIntent([request])).toBe("automatic");
    expect(() => assertActionExecutionIntentPreserved([request], "proposal_only")).toThrow("ACTION_EXECUTION_INTENT_UNMET");
  });
  it.each([
    "Automatically approve and complete routine eligible changes.",
    "Automatically approve and complete no more than 10 plan changes overall and 3 per account.",
    "Apply eligible enrollments automatically.",
    "Prepare supervised execution for the reviewed update.",
  ])("detects an unmet completion request: %s", (request) => {
    expect(explicitActionExecutionIntent([request])).toBe("automatic");
    expect(() => assertActionExecutionIntentPreserved([request], "proposal_only")).toThrow("ACTION_EXECUTION_INTENT_UNMET");
    expect(() => assertActionExecutionIntentPreserved([request], "supervised")).not.toThrow();
  });
  it.each([
    "Automatically approve routine refunds.", "What does automatically complete mean?",
    "Never apply during setup.", "Keep execution disabled until operator review.",
  ])("does not invent runtime execution intent: %s", (request) => {
    expect(explicitActionExecutionIntent([request])).toBeUndefined();
  });
  it.each(["Do not automatically complete changes.", "Keep writeback disabled.", "Keep it proposal-only.", "Never apply or write anything.", "Do not write source changes.", "Never execute.", "Do not actually apply database updates for this test."])("retains explicit no-write intent: %s", (request) => {
    expect(explicitActionExecutionIntent(["Automatically complete changes.", request])).toBe("proposal_only");
    expect(() => assertActionExecutionIntentPreserved([request], "supervised")).toThrow("ACTION_EXECUTION_INTENT_UNMET");
  });
});
