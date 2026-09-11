import { describe, expect, it } from "vitest";
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarExpressionV1, ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule } from "./evaluate.js";
import { actionRuleDigest, normalizeActionRule } from "./normalize.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";

const integer = { kind: "integer", unit: "credits" } as const;
const active: ActionRuleBooleanExpressionV1 = { kind: "compare", operator: "eq",
  left: { kind: "field", binding: "holds", field: "state" },
  right: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 16, comparison: "exact" } } };
const sum: ActionRuleScalarExpressionV1 = { kind: "aggregate", operation: "sum", binding: "holds", field: "credits", where: active };

function fixture(engine: "postgres" | "mysql" = "postgres") {
  const f = completeCollectionFixture(engine);
  f.catalog.resources[1]!.fields.push({ name: "credits", type: integer, nullable: false });
  f.rule.require = { kind: "compare", operator: "lte", left: sum, right: { kind: "literal", value: 16, value_type: integer } };
  return f;
}
function row(id: string, credits: number, state = "active") {
  return { tenant_id: "t1", principal_id: "p1", customer_id: "c1", hold_id: id, state, credits };
}
function evaluate(f: ReturnType<typeof fixture>) {
  return evaluateActionRule({ compiled: compileActionRule(f), facts: f.facts, proposal_id: "collection_test" });
}

describe.each(["postgres", "mysql"] as const)("complete collection expressions on %s", engine => {
  it("uses the current filtered credit sum, including zero, rather than an eligibility cache", () => {
    const f = fixture(engine);
    expect(evaluate(f).result).toBe("eligible");
    f.facts.bindings.holds!.rows = [row("h1", 10), row("h2", 6), row("h3", 20, "released")];
    expect(evaluate(f).result).toBe("eligible");
    f.facts.bindings.holds!.rows[1]!.credits = 7;
    expect(evaluate(f).result).toBe("ineligible");
  });
  it.each(["missing", "null", "unknown_predicate", "overflow", "arithmetic"])("never treats %s as an empty or smaller collection", issue => {
    const f = fixture(engine);
    f.facts.bindings.holds!.rows = [row("h1", 1)];
    if (issue === "missing") delete f.facts.bindings.holds!.rows[0]!.credits;
    if (issue === "null") { f.catalog.resources[1]!.fields.find(field => field.name === "credits")!.nullable = true; f.facts.bindings.holds!.rows[0]!.credits = null; }
    if (issue === "unknown_predicate") { f.catalog.resources[1]!.fields.find(field => field.name === "state")!.nullable = true; f.facts.bindings.holds!.rows[0]!.state = null; }
    if (issue === "overflow") f.facts.bindings.holds!.rows = Array.from({ length: 6 }, (_, n) => row(`h${n}`, 1));
    if (issue === "arithmetic") f.facts.bindings.holds!.rows = [row("h1", Number.MAX_SAFE_INTEGER), row("h2", 1)];
    expect(evaluate(f).result).not.toBe("eligible");
  });
  it("counts rows and explicit non-null fields with exact units", () => {
    const f = fixture(engine);
    f.rule.require = { kind: "compare", operator: "eq", left: { kind: "aggregate", operation: "count", binding: "holds", where: active },
      right: { kind: "literal", value: 0, value_type: { kind: "integer", unit: "rows" } } };
    expect(evaluate(f).result).toBe("eligible");
    f.facts.bindings.holds!.rows = [row("h1", 3)];
    expect(evaluate(f).result).toBe("ineligible");
    f.catalog.resources[1]!.fields.find(field => field.name === "credits")!.nullable = true;
    f.facts.bindings.holds!.rows[0]!.credits = null;
    f.rule.require.left = { kind: "aggregate", operation: "count", binding: "holds", field: "credits", where: active };
    expect(evaluate(f).result).toBe("eligible");
    f.rule.require.right = { kind: "literal", value: 0, value_type: integer };
    expect(() => compileActionRule(f)).toThrow("incompatible");
  });
  it.each(["min", "max"] as const)("evaluates %s but refuses an empty ordered collection", operation => {
    const f = fixture(engine);
    f.rule.require = { kind: "compare", operator: "eq", left: { kind: "aggregate", operation, binding: "holds", field: "credits" },
      right: { kind: "literal", value: operation === "min" ? 3 : 5, value_type: integer } };
    expect(evaluate(f).result).not.toBe("eligible");
    f.facts.bindings.holds!.rows = [row("h1", 3), row("h2", 5)];
    expect(evaluate(f).result).toBe("eligible");
  });
  it("checks aggregate filter derivation order and refuses cycles", () => {
    const f = fixture(engine);
    f.rule.require = completeCollectionFixture(engine).rule.require;
    f.rule.derive = { a_total: { ...sum, where: { ...active, right: { kind: "derived", name: "z_state" } } as ActionRuleBooleanExpressionV1 },
      z_state: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 16, comparison: "exact" } } };
    expect(compileActionRule(f).derivation_order).toEqual(["z_state", "a_total"]);
    f.rule.derive.z_state = { kind: "derived", name: "a_total" };
    expect(() => compileActionRule(f)).toThrow("cycle");
  });
  it("rejects unreviewed fields, nested collection incompleteness and extra expression keys", () => {
    const f = fixture(engine);
    f.rule.require = { kind: "compare", operator: "eq", left: { ...sum, field: "not_reviewed" }, right: { kind: "literal", value: 0, value_type: integer } };
    expect(() => compileActionRule(f)).toThrow("outside the private");
    f.rule.require = { kind: "not", expression: { kind: "exists", binding: "holds", where: active } };
    delete f.verification_boundary.resources[1]!.collection_consistency;
    expect(() => compileActionRule(f)).toThrow("complete_locked");
    f.rule.derive.total = { ...sum, sql: "select sum(credits)" } as ActionRuleScalarExpressionV1;
    expect(() => normalizeActionRule(f.rule)).toThrow();
  });
  it("binds the filter to the immutable rule digest", () => {
    const f = fixture(engine);
    const before = actionRuleDigest(f.rule);
    f.rule.require = { kind: "compare", operator: "lte", left: { ...sum, where: { kind: "not", expression: active } }, right: { kind: "literal", value: 16, value_type: integer } };
    expect(actionRuleDigest(f.rule)).not.toBe(before);
  });
  it.each(["absence", "aggregate"])("requires completeness of nested predicates used by %s", mode => {
    const f = fixture(engine);
    const other = structuredClone(f.verification_boundary.resources[1]!);
    other.binding = "other";
    delete other.collection_consistency;
    f.verification_boundary.resources.push(other); f.verification_boundary.lock_order.push("other");
    const where: ActionRuleBooleanExpressionV1 = { kind: "exists", binding: "other", where: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "other", field: "state" }, right: { kind: "literal", value: "active", value_type: { kind: "string", comparison: "exact", max_length: 16 } } } };
    f.rule.require = mode === "absence" ? { kind: "not", expression: { kind: "exists", binding: "holds", where } }
      : { kind: "compare", operator: "lte", left: { ...sum, where }, right: { kind: "literal", value: 16, value_type: integer } };
    expect(() => compileActionRule(f)).toThrow("complete_locked");
    other.collection_consistency = "complete_locked";
    expect(() => compileActionRule(f)).not.toThrow();
  });
});

describe("explicit UTC calendar comparisons", () => {
  function dateFixture() {
    const f = fixture();
    const types: [string, ActionRuleScalarTypeSpecV1][] = [["satisfied_on", { kind: "date" }], ["removed_at", { kind: "timestamp" }]];
    for (const [name, type] of types) f.catalog.resources[0]!.fields.push({ name, type, nullable: false });
    Object.assign(f.facts.bindings.customer!.rows[0]!, { satisfied_on: "2026-09-08", removed_at: "2026-09-09T00:00:00.000Z" });
    f.rule.require = { kind: "compare", operator: "lt", left: { kind: "field", binding: "customer", field: "satisfied_on" },
      right: { kind: "date_of", timestamp: { kind: "field", binding: "customer", field: "removed_at" }, timezone: "UTC" } };
    return f;
  }
  it("compares before the calendar day, not merely before the instant", () => {
    const f = dateFixture();
    expect(evaluate(f).result).toBe("eligible");
    f.facts.bindings.customer!.rows[0]!.satisfied_on = "2026-09-09";
    f.facts.bindings.customer!.rows[0]!.removed_at = "2026-09-09T23:59:59.999Z";
    expect(evaluate(f).result).toBe("ineligible");
    f.facts.bindings.customer!.rows[0]!.removed_at = "2026-09-10T00:00:00.000Z";
    expect(evaluate(f).result).toBe("eligible");
  });
  it("does not coerce mixed date types, arbitrary timezones or invalid timestamps", () => {
    const f = dateFixture();
    const require = f.rule.require;
    if (require.kind !== "compare") throw new Error("fixture");
    require.right = { kind: "field", binding: "customer", field: "removed_at" };
    expect(() => compileActionRule(f)).toThrow("incompatible");
    require.right = { kind: "date_of", timestamp: require.right, timezone: "local" } as unknown as ActionRuleScalarExpressionV1;
    expect(() => compileActionRule(f)).toThrow();
    const valid = dateFixture();
    valid.facts.bindings.customer!.rows[0]!.removed_at = "2026-09-09T00:00:00-07:00";
    expect(evaluate(valid).result).not.toBe("eligible");
  });
});
