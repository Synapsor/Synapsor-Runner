import { describe, expect, it } from "vitest";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import { actionRuleDiagnosticRepair, type ActionRuleRepairContext } from "./action-rule-diagnostic-repair.js";

const diagnostic = { code: "ACTION_RULE_UNBOUNDED", path: "verification_boundary.resources.holds.deterministic_order", message: "Missing primary key tie-breaker." };
function context(): ActionRuleRepairContext {
  return {
    builtCatalog: { catalog: { resources: [{ name: "university.holds", primary_key: "hold_key", fields: [{ name: "starts_at" }, { name: "hold_key" }] }] } } as BuiltActionRuleAuthoringCatalogV1,
    verification: { name: "verify", resources: [{ binding: "holds", resource: "university.holds", deterministic_order: [{ field: "starts_at", direction: "desc" }] }] },
  };
}

describe("exact Action draft diagnostic repairs", () => {
  it("names the inspected primary key while preserving all existing ordering", () => {
    const input = context(), before = structuredClone(input);
    const result = actionRuleDiagnosticRepair(diagnostic, input);
    expect(result.category).toBe("draft_structure");
    expect(result.correction).toEqual({
      operation: "replace_deterministic_order", path: "verification.resources.holds.deterministic_order",
      resource: "university.holds", binding: "holds",
      before: [{ field: "starts_at", direction: "desc" }],
      after: [{ field: "starts_at", direction: "desc" }, { field: "hold_key", direction: "asc" }],
      catalog_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      requires_validation: true, authority_granted: false,
    });
    expect(input).toEqual(before);
  });

  it.each(["unknown_binding", "unavailable_key", "unknown_order_field", "duplicate_order", "already_has_key", "ambiguous_binding"])("offers no guessed replacement for %s", (failure) => {
    const input = context();
    const binding = input.verification!.resources[0]!;
    if (failure === "unknown_binding") binding.binding = "other";
    if (failure === "unavailable_key") input.builtCatalog.catalog.resources[0]!.primary_key = "missing";
    if (failure === "unknown_order_field") binding.deterministic_order![0]!.field = "invented";
    if (failure === "duplicate_order") binding.deterministic_order!.push(structuredClone(binding.deterministic_order![0]!));
    if (failure === "already_has_key") binding.deterministic_order!.push({ field: "hold_key", direction: "asc" });
    if (failure === "ambiguous_binding") input.verification!.resources.push(structuredClone(binding));
    expect(actionRuleDiagnosticRepair(diagnostic, input).correction).toBeUndefined();
  });

  it.each([
    ["ACTION_RULE_FACTS_UNKNOWN", "source_evidence", /authoritative source/],
    ["ACTION_RULE_VERSION_SELECTION_REQUIRED", "concurrency", /write grant does not/],
    ["WRITER_GRANTS_MISSING", "deployment", /database owner/],
    ["ACTION_RULE_POLICY_LIMIT_REQUIRED", "business_decision", /reuse prior answers/],
    ["ACTION_RULE_AUTHORITY_STALE", "draft_structure", /old fingerprint/],
  ])("distinguishes %s without inventing a permission repair", (code, category, message) => {
    const result = actionRuleDiagnosticRepair({ code: String(code), message: "Cannot validate." }, context());
    expect(result.category).toBe(category);
    expect(result.next_action).toMatch(message as RegExp);
    expect(result.correction).toBeUndefined();
  });
});
