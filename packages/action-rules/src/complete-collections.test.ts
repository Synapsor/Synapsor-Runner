import { describe, expect, it } from "vitest";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule } from "./evaluate.js";
import { loadActionRuleFacts } from "./fact-loader.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";

describe.each(["postgres", "mysql"] as const)("complete collection authority: %s", engine => {
  it("permits absence only on the complete bounded reviewed collection, including an empty result", () => {
    const f = completeCollectionFixture(engine);
    const compiled = compileActionRule(f);
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p1" }).result).toBe("eligible");
    f.facts.bindings.holds!.rows = [{ tenant_id: "t1", principal_id: "p1", customer_id: "c1", hold_id: "h1", state: "released" }];
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p1" }).result).toBe("eligible");
    f.facts.bindings.holds!.rows[0]!.state = "active";
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p1" }).result).toBe("ineligible");
    f.facts.bindings.holds!.rows = Array.from({ length: 6 }, (_, n) => ({ ...f.facts.bindings.holds!.rows[0]!, hold_id: `h${n}` }));
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p1" }).result).not.toBe("eligible");
  });
  it.each(["missing_strategy", "isolation", "many_parent", "scope", "lock_order"])("refuses unsupported %s before compiling", issue => {
    const f = completeCollectionFixture(engine);
    if (issue === "missing_strategy") delete f.verification_boundary.resources[1]!.collection_consistency;
    if (issue === "isolation") f.verification_boundary.transaction.isolation = "serializable";
    if (issue === "many_parent") { f.verification_boundary.resources[0]!.cardinality = "many"; f.verification_boundary.resources[0]!.deterministic_order = [{ field: "customer_id", direction: "asc" }]; }
    if (issue === "scope") f.verification_boundary.resources[1]!.scope = { mode: "inherited", from_binding: "customer" };
    if (issue === "lock_order") f.verification_boundary.lock_order.reverse();
    expect(() => compileActionRule(f)).toThrow();
  });
  it("requires adapter visibility/phantom proof and keeps private rows out of model authority", async () => {
    const f = completeCollectionFixture(engine);
    const compiled = compileActionRule(f);
    const steps: string[] = [];
    const adapter = { engine, load: async (query: { binding: string }) => { steps.push(`load:${query.binding}`); return f.facts.bindings[query.binding]!.rows; },
      assertRelationshipCompatible: async () => { steps.push("foreign_key"); } };
    await expect(loadActionRuleFacts({ compiled, subjects: f.subjects, trusted: f.facts.trusted, adapter, mode: "transaction_reverify" })).rejects.toThrow("cannot prove");
    steps.length = 0;
    await loadActionRuleFacts({ compiled, subjects: f.subjects, trusted: f.facts.trusted, mode: "transaction_reverify",
      adapter: { ...adapter, assertCompleteCollection: async input => {
        steps.push("complete"); expect(input.parentRows).toEqual(f.facts.bindings.customer!.rows);
        expect(input.mode).toBe("transaction_reverify");
      } } });
    expect(steps).toEqual(["load:customer", "complete", "foreign_key", "load:holds"]);
    expect(compiled.verification_boundary.resources[1]!.fields.every(field => field.model_visible !== true)).toBe(true);
  });
});
