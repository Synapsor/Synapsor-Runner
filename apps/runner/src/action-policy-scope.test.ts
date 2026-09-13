import { describe, expect, it } from "vitest";
import {
  assertJointApprovalLimitsPreserved,
  explicitJointApprovalLimits,
  explicitApprovalPolicyRequirements,
  explicitPolicyLimits,
  explicitTrustedPolicyScope,
  explicitTrustedPolicyScopes,
} from "./action-policy-scope.js";

describe("Action approval policy scope wording", () => {
  it.each([
    "Yes. Each tenant is exactly one league, and each principal is an assigned referee within that league. Referees in the same league share the limit of two automatic ratifications in the rolling 24 hours; all leagues share the overall limit of six.",
    "Each principal represents an assigned coordinator. Each tenant means one organization.",
    "Each tenant is an organization; every principal is a person in that organization.",
    "Every principal refers to an assigned person. Across the Action Boundary allow at most six automatic approvals per day.",
  ])("does not derive a principal quota from a role glossary: %s", (text) => {
    expect(explicitTrustedPolicyScopes(text).some(scope => scope.scope === "tenant_principal")).toBe(false);
  });

  it("retains actual independent limits after role definitions, including a shared later window", () => {
    const text = "Each principal is a person. Each tenant is an organization. Allow at most 8 automatic approvals per tenant and 2 per principal. Both limits use a rolling 24-hour window.";
    expect(explicitTrustedPolicyScopes(text).map(scope => scope.scope).sort()).toEqual(["tenant", "tenant_principal"]);
    expect(explicitPolicyLimits(text)).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "tenant", maximum: 8, window_seconds: 86400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 2, window_seconds: 86400 }),
    ]));
  });

  it.each([
    "Each principal is one assigned operator. Allow at most 8 automatic approvals per tenant and 2 per principal in a rolling 24-hour window.",
    "Allow at most 8 automatic approvals per tenant and 2 per principal in a rolling 24-hour window. Every principal represents a person; each tenant means an organization.",
    "Each tenant means an organization. In a rolling 24-hour window, each principal is allowed at most 2 automatic approvals; allow at most 8 per tenant.",
  ])("keeps the real quota set when definitions are reordered: %s", text => {
    expect(explicitPolicyLimits(text).map(limit => [limit.scope, limit.maximum, limit.window_seconds]).sort())
      .toEqual([["tenant", 8, 86400], ["tenant_principal", 2, 86400]]);
  });

  it("does not borrow a tenant quota from the remainder of a principal definition", () => {
    expect(explicitTrustedPolicyScopes("Each principal is an assigned person in a tenant that is allowed at most 2 automatic approvals per tenant in a rolling 24-hour window.")
      .map(entry => entry.scope)).toEqual(["tenant"]);
  });

  it("keeps a real principal quota despite later glossary and unanswered scope-change questions", () => {
    const policy = "At most 8 automatic approvals per tenant and 2 per principal in a rolling 24-hour window.";
    const result = explicitApprovalPolicyRequirements([policy, "Each principal is one assigned operator.", "Should we change to 3 per tenant rather than per principal?"]);
    expect(result.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "tenant", maximum: 8 }), expect.objectContaining({ scope: "tenant_principal", maximum: 2 }),
    ]));
  });

  it("retains the exact unresolved scope alternative until a concrete operator clarification", () => {
    const question = "Allow at most 2 automatic approvals per tenant or per principal in a rolling 24-hour window.";
    expect(explicitApprovalPolicyRequirements([question]).ambiguous).toEqual([question]);
    const resolved = explicitApprovalPolicyRequirements([question, "Use at most 2 automatic approvals per tenant in the rolling 24-hour window."]);
    expect(resolved.ambiguous).toEqual([]);
    expect(resolved.scopes.map(entry => entry.scope)).toEqual(["tenant"]);
  });

  it("honors an exact scoped window replacement while retaining another scope's window", () => {
    const result = explicitApprovalPolicyRequirements([
      "At most 8 automatic approvals per tenant in a rolling 24-hour window and 2 per principal in a rolling 12-hour window.",
      "Change the limit to 1 per principal in a rolling 6-hour window.",
    ]);
    expect(result.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "tenant", maximum: 8, window_seconds: 86400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 21600 }),
    ]));
    expect(result.durations.map(entry => entry.seconds).sort()).toEqual([21600, 86400]);
  });

  it("does not turn explicitly negated principal accounting into a quota", () => {
    expect(explicitTrustedPolicyScopes("There is no quota per principal. Allow at most 2 automatic approvals per tenant in a rolling 24-hour window.")
      .map(entry => entry.scope)).toEqual(["tenant"]);
  });

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
