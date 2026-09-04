import { describe, expect, it } from "vitest";
import {
  explicitPolicyLimits,
  explicitTrustedPolicyScope,
  explicitTrustedPolicyScopes,
} from "./action-policy-scope.js";

describe("Action approval policy scope wording", () => {
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
