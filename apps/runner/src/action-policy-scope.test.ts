import { describe, expect, it } from "vitest";
import {
  assertJointApprovalLimitsPreserved,
  explicitJointApprovalLimits,
  explicitPolicyLimits,
  explicitTrustedPolicyScope,
  explicitTrustedPolicyScopes,
} from "./action-policy-scope.js";

describe("Action approval policy scope wording", () => {
  it("honors an explicit later replacement of joint counters without changing unrelated limits", () => {
    const original = "Across both actions allow at most 10 automatic approvals overall and 3 per account in a rolling 24-hour period.";
    expect(explicitJointApprovalLimits([original, "Correction: do not share automatic approvals across both actions. Give each action its own 10 overall and 3 per account in a rolling 24-hour period."])).toEqual([]);
    expect(explicitJointApprovalLimits([original, "Apply automatic approvals separately, not across both actions."])).toEqual([]);
    expect(explicitJointApprovalLimits([original, "Should automatic approvals not be shared across both actions?"])).toHaveLength(2);
    expect(explicitJointApprovalLimits([original, "Across both actions allow at most 8 automatic approvals overall and 2 per account in a rolling 24-hour period."]))
      .toEqual([expect.objectContaining({ scope: "boundary", maximum: 8 }), expect.objectContaining({ scope: "tenant", maximum: 2 })]);
  });
  it.each([
    "Across both actions allow at most 10 automatic approvals overall and at most 3 per account in a rolling 24-hour period.",
    "The two actions share one joint maximum of 10 automatic approvals overall and 3 per account in a rolling 24-hour period; do not apply either limit separately to each action.",
  ])("preserves explicit joint counters instead of separate per-action allowances: %s", (job) => {
    const limits = explicitJointApprovalLimits([job]);
    expect(limits).toEqual([expect.objectContaining({ scope: "boundary", maximum: 10, window_seconds: 86400 }),
      expect.objectContaining({ scope: "tenant", maximum: 3, window_seconds: 86400 })]);
    expect(() => assertJointApprovalLimitsPreserved([job], { mode: "policy", shared_limits: limits })).not.toThrow();
    for (const incorrect of [limits.map((limit) => ({ ...limit, capability: "stock.change" })),
      limits.map((limit) => ({ ...limit, maximum: limit.maximum + 1 })),
      limits.map((limit) => ({ ...limit, window_seconds: 3600 })),
      limits.map((limit) => ({ ...limit, scope: limit.scope === "boundary" ? "capability" : limit.scope }))]) {
      expect(() => assertJointApprovalLimitsPreserved([job], { mode: "policy", shared_limits: incorrect })).toThrow("JOINT");
    }
  });
  it.each([
    "Allow 10 automatic approvals overall and 3 per account in a rolling 24-hour period for this action.",
    "Across both actions use automatic approvals with reasonable shared limits.",
    "Across both actions allow at most 10 automatic approvals overall and 3 per customer in a rolling 24-hour period.",
    "Allow 10 automatic approvals overall and 3 per account in a rolling 24-hour period, not across both actions.",
  ])("does not invent joint limits from ambiguous or separate intent: %s", (job) => {
    expect(explicitJointApprovalLimits([job])).toEqual([]);
  });
  it("distinguishes an account from a signed-in person and one exact object", () => {
    expect(explicitTrustedPolicyScope(
      "No more than 3 for the same customer account in a rolling 24-hour period.",
    )?.scope).toBe("tenant");
    expect(explicitTrustedPolicyScope(
      "No more than 3 for the same signed-in person in an account in a rolling 24-hour period.",
    )?.scope).toBe("tenant_principal");
    expect(explicitTrustedPolicyScope(
      "No more than 3 for this exact subscription in a rolling 24-hour period.",
    )?.scope).toBe("tenant_object");
  });

  it("does not guess whether a bare customer means an account or a person", () => {
    expect(explicitTrustedPolicyScope(
      "Auto-approve at most 3 per customer in a rolling 24-hour period.",
    )).toBeUndefined();
  });

  it("preserves the exact account-wide maximum and rolling window", () => {
    const intent = "Automatically approve no more than 3 for the same customer account in any rolling 24-hour period.";
    expect(explicitTrustedPolicyScopes(intent)).toEqual([
      expect.objectContaining({ scope: "tenant" }),
    ]);
    expect(explicitPolicyLimits(intent)).toEqual([
      expect.objectContaining({
        kind: "count",
        scope: "tenant",
        maximum: 3,
        window_seconds: 86_400,
      }),
    ]);
  });
});
