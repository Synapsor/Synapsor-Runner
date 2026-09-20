import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { compileActionRule, actionRuleEffectInventory, actionRuleEffectLines, actionRulePublicEffects, actionRuleDiscoveryContract, type ActionRuleAuthorityV1 } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
const fixture = () => JSON.parse(fs.readFileSync(new URL("./fixtures/minimal-edit-verification.json", import.meta.url), "utf8")).baseline as ActionRuleAuthorityV1;
const compile = (f = fixture()) => compileActionRule({ catalog: f.catalog, ...f.rules[0]! });
describe("canonical effect inventory", () => {
  it("compares every mutation to its canonical envelope, excluding private verification", () => {
    const c = compile(), result = actionRuleEffectInventory(c);
    expect(result.components).toHaveLength(2);
    expect(result.components.map(v => [v.resource, v.binding, v.max_rows, v.changes, v.system_managed])).toEqual([
      [c.rule.effect.target_resource, c.rule.effect.target_binding, 1, c.rule.effect.set, { version_advance: c.effect_envelope.version_advance }],
      [c.rule.atomic_updates![0]!.target_resource, c.rule.atomic_updates![0]!.target_binding, 1, c.rule.atomic_updates![0]!.set, { version_advance: c.effect_envelope.atomic_updates![0]!.version_advance }],
    ]);
    expect(result.verification).toMatchObject([{ binding: "checks", max_rows: 12 }]);
    expect(result.transaction).toMatchObject({ grouping: "atomic_updates", aggregate_row_bound: null });
    expect(result.observed_affected_rows).toBeNull();
    expect(actionRuleDiscoveryContract(c, "policy")).toMatchObject({ proposal_effect: { scope: expect.stringContaining("primary_only"), max_rows: 1 }, business_effects: { components: [{ max_rows: 1 }, { max_rows: 1 }] } });
  });
  it("preserves operator transformations while confining public companion disclosure", () => {
    const c = compile(), publicView = JSON.stringify(actionRulePublicEffects(c));
    expect(actionRuleEffectLines(c).join("\n")).toContain('"value":"consumed"');
    expect(publicView).not.toContain("security_hold");
    expect(publicView).not.toContain("build_checks");
    expect(publicView).not.toContain("slot_state"); // related row is not a public subject
    expect(publicView).not.toContain("consumed");
    expect(actionRulePublicEffects(c).components[1]).toMatchObject({ target: "related reviewed record" });
  });
  it("supports scalar effects without inventing atomic companions", () => {
    const c = compileActionRule(completeCollectionFixture("postgres"));
    expect(actionRuleEffectInventory(c).components).toHaveLength(1);
    expect(actionRuleEffectInventory(c).transaction.grouping).toBe("single_effect");
  });
  it("retains distinct bindings and reordering through the four-target supported compiler", () => {
    const f = fixture(), s = f.rules[0]!, slot = s.verification_boundary.resources.find(r => r.binding === "slot")!;
    // Same relation and field names, different exact subject bindings. No summed bound.
    for (const binding of ["second_slot", "third_slot"]) {
      s.verification_boundary.resources.push({ ...structuredClone(slot), binding, source: { kind: "subject_ref" } });
      s.verification_boundary.lock_order.push(binding);
      s.rule.subjects.push({ binding, resource: slot.resource, input: "opaque_subject_ref" });
      s.rule.atomic_updates!.push({ ...structuredClone(s.rule.atomic_updates![0]!), target_binding: binding });
      s.effect_envelope.atomic_updates!.push({ ...structuredClone(s.effect_envelope.atomic_updates![0]!), target_binding: binding });
    }
    for (const reverse of [false, true]) {
      if (reverse) { s.rule.atomic_updates!.reverse(); s.effect_envelope.atomic_updates!.reverse(); }
      const c = compile(f), result = actionRuleEffectInventory(c);
      expect(result.components).toHaveLength(4);
      expect(result.components.map(v => v.binding)).toEqual(["candidate", ...s.rule.atomic_updates!.map(v => v.target_binding)]);
      expect(result.components.map(v => v.changes)).toEqual([s.rule.effect.set, ...s.rule.atomic_updates!.map(v => v.set)]);
      expect(result.transaction.aggregate_row_bound).toBeNull();
    }
  });
  it.each(["missing", "empty", "mismatched"])("refuses incomplete %s inspection rather than silently omitting it", kind => {
    const c = compile();
    if (kind === "missing") delete c.effect_envelope.atomic_updates;
    if (kind === "empty") c.rule.atomic_updates = [];
    if (kind === "mismatched") c.rule.atomic_updates![0]!.target_resource = "unrelated";
    expect(() => actionRuleEffectInventory(c)).toThrow();
  });
});
