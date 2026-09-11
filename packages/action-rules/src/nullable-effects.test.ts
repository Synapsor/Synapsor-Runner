import { describe, expect, it } from "vitest";
import type { ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule } from "./evaluate.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";

const text = { kind: "string", max_length: 32, comparison: "exact", enum: ["prerequisite_error"] } satisfies ActionRuleScalarTypeSpecV1;
const timestamp = { kind: "timestamp" } as const;
function fixture(engine: "postgres" | "mysql") {
  const f = completeCollectionFixture(engine);
  for (const [name, type] of [["drop_reason", text], ["dropped_at", timestamp]] as const) {
    f.catalog.resources[0]!.fields.push({ name, type, nullable: true });
    f.effect_envelope.allowed_fields.push({ name, type, values: [null] });
    f.rule.effect.set[name] = { kind: "literal", value: null, value_type: type };
    f.facts.bindings.customer!.rows[0]![name] = name === "drop_reason" ? "prerequisite_error" : "2026-09-01T00:00:00.000Z";
  }
  return f;
}

describe.each(["postgres", "mysql"] as const)("explicit nullable effects on %s", engine => {
  it("clears two explicitly reviewed nullable fields in one exact update without changing its guards", () => {
    const f = fixture(engine);
    const result = evaluateActionRule({ compiled: compileActionRule(f), facts: f.facts, proposal_id: "restore" });
    expect(result).toMatchObject({ result: "eligible", effect: { set: { state: "ready", drop_reason: null, dropped_at: null },
      primary_key: { column: "customer_id", value: "c1" }, expected_version: { column: "version", value: 1 } } });
  });
  it.each(["not_nullable", "unreviewed_null", "wrong_type", "nullable_copy", "unknown_copy", "named_null", "guard"])("refuses %s without converting it into a clear", failure => {
    const f = fixture(engine);
    if (failure === "not_nullable") f.catalog.resources[0]!.fields.find(field => field.name === "dropped_at")!.nullable = false;
    if (failure === "unreviewed_null") delete f.effect_envelope.allowed_fields.find(field => field.name === "dropped_at")!.values;
    if (failure === "wrong_type") f.rule.effect.set.dropped_at = { kind: "literal", value: null, value_type: text };
    if (failure === "nullable_copy" || failure === "unknown_copy") f.rule.effect.set.dropped_at = { kind: "field", binding: "customer", field: "dropped_at" };
    if (failure === "unknown_copy") delete f.facts.bindings.customer!.rows[0]!.dropped_at;
    if (failure === "named_null") { f.rule.derive.clear = f.rule.effect.set.dropped_at!; f.rule.effect.set.dropped_at = { kind: "derived", name: "clear" }; }
    if (failure === "guard") { f.effect_envelope.allowed_fields.push({ name: "version", type: { kind: "integer" }, values: [null] }); f.rule.effect.set.version = { kind: "literal", value: null, value_type: { kind: "integer" } }; }
    expect(() => compileActionRule(f)).toThrow();
  });
  it("keeps missing verification facts unknown even when the effect explicitly clears that field", () => {
    const f = fixture(engine);
    delete f.facts.bindings.customer!.rows[0]!.dropped_at;
    expect(evaluateActionRule({ compiled: compileActionRule(f), facts: f.facts, proposal_id: "restore" }).result).toBe("unknown");
  });
  it("binds clearing permission to the immutable envelope instead of assuming all nullable fields are writable", () => {
    const f = fixture(engine), first = compileActionRule(f);
    f.rule.effect.set.drop_reason = { kind: "literal", value: "prerequisite_error", value_type: text };
    f.effect_envelope.allowed_fields.find(field => field.name === "drop_reason")!.values = ["prerequisite_error"];
    const changed = compileActionRule(f);
    expect(changed.effect_envelope_digest).not.toBe(first.effect_envelope_digest);
    expect(changed.rule_digest).not.toBe(first.rule_digest);
  });
});
