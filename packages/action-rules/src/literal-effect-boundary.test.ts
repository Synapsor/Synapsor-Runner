import { describe, expect, it } from "vitest";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule } from "./evaluate.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";
import { atomicSource } from "./testing/atomic-fixture.js";

describe.each(["postgres", "mysql"] as const)("constant effect boundaries on %s", engine => {
  it.each([false, true])("rejects a type-valid constant outside the reviewed allowlist (named: %s)", named => {
    const f = completeCollectionFixture(engine);
    const value = { kind: "literal" as const, value: "released", value_type: f.effect_envelope.allowed_fields[0]!.type };
    if (named) f.rule.derive.next_state = value;
    f.rule.effect.set.state = named ? { kind: "derived", name: "next_state" } : value;
    expect(() => compileActionRule(f)).toThrowError(expect.objectContaining({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY" }));
  });

  it.each([6, 9])("rejects integer constant %i outside a singleton numeric envelope", value => {
    const f = completeCollectionFixture(engine), type = { kind: "integer" as const };
    f.catalog.resources[0]!.fields.push({ name: "quantity", type, nullable: false });
    f.effect_envelope.allowed_fields = [{ name: "quantity", type, minimum: 7, maximum: 7 }];
    f.rule.effect.set = { quantity: { kind: "literal", value, value_type: type } };
    expect(() => compileActionRule(f)).toThrowError(expect.objectContaining({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY" }));
  });

  it.each([1, 20])("accepts exact numeric boundary %i without altering the envelope or guards", value => {
    const f = completeCollectionFixture(engine), type = { kind: "money_minor" as const, currency: "USD" };
    f.catalog.resources[0]!.fields.push({ name: "credit", type, nullable: false });
    f.effect_envelope.allowed_fields = [{ name: "credit", type, minimum: 1, maximum: 20 }];
    f.rule.effect.set = { credit: { kind: "literal", value, value_type: type } };
    f.facts.bindings.customer!.rows[0]!.credit = 0;
    const before = structuredClone(f), compiled = compileActionRule(f);
    expect(f).toEqual(before);
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "bounded-credit" }))
      .toMatchObject({ result: "eligible", effect: { set: { credit: value }, expected_version: { column: "version", value: 1 } } });
  });

  it("keeps a fact-derived value subject to the existing runtime allowlist", () => {
    const f = completeCollectionFixture(engine);
    f.rule.effect.set.state = { kind: "field", binding: "customer", field: "state" };
    const result = evaluateActionRule({ compiled: compileActionRule(f), facts: f.facts, proposal_id: "dynamic-state" });
    expect(result).toMatchObject({ result: "unknown", safe_code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY" });
    expect(result).not.toHaveProperty("effect");
  });

  it("rejects an impossible constant on an atomic companion", () => {
    const f = atomicSource(engine);
    f.rule.atomic_updates![0]!.set.status = { kind: "literal", value: "available", value_type: f.envelope.atomic_updates![0]!.allowed_fields[0]!.type };
    expect(() => compileActionRule({ catalog: f.catalog, verification_boundary: f.verification, effect_envelope: f.envelope, rule: f.rule }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY" }));
  });
});
