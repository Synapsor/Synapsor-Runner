import { describe, expect, it } from "vitest";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule, evaluateActionRuleApprovalPredicate } from "./evaluate.js";
import { loadActionRuleFacts } from "./fact-loader.js";
import { requiredSingletonFixture } from "./testing/required-singleton-fixture.js";

describe("required scoped singleton canonical contract (synthetic)", () => {
  it("preserves its typed meaning and requires the current exact witness", () => {
    const f = requiredSingletonFixture(), serialized = JSON.parse(JSON.stringify(f));
    const compiled = compileActionRule(serialized);
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p" }).result).toBe("eligible");
    expect(evaluateActionRuleApprovalPredicate({ compiled, facts: f.facts, expression: f.rule.require }).result).toBe("match");
    expect(compiled.verification_boundary.resources[1]).toMatchObject({ cardinality: "one", max_rows: 1,
      evidence_mode: "required_scoped_singleton", scope: { tenant_field: "tenant_id", principal_field: "principal_id" } });
  });

  it("allows an unused catalog enum, but refuses selecting it as an unqualified required dependency", () => {
    const f = requiredSingletonFixture(), parent = f.catalog.resources[0]!;
    // The shared collection seed aliases catalog fields and verification fields.
    // This control deliberately advertises an unselected catalog field, so keep
    // those arrays independent before changing either representation.
    f.verification_boundary.resources[0]!.fields = structuredClone(f.verification_boundary.resources[0]!.fields);
    const status = { name: "status", nullable: false, type: { kind: "string" as const,
      comparison: "exact" as const, max_length: 16, enum: ["open", "ready", "held"] } };
    parent.fields.push(status);
    expect(f.verification_boundary.resources[0]!.fields.some(field => field.name === "status")).toBe(false);
    // Synthetic catalog: no live stamp for the enum. A required allocation may
    // use qualified scalar dependencies without relying on this unrelated field.
    expect(() => compileActionRule(f)).not.toThrow();
    f.verification_boundary.resources[0]!.fields.push({ ...status, model_visible: false });
    f.rule.require = { kind: "all", expressions: [f.rule.require, { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "customer", field: "status" },
      right: { kind: "literal", value: "open", value_type: status.type } }] };
    expect(() => compileActionRule(f)).toThrow();
  });

  it.each(["absent", "null", "missing", "tenant", "principal", "link", "duplicate"])("%s witness cannot be bypassed by OR or approval", kind => {
    const f = requiredSingletonFixture();
    f.rule.require = { kind: "any", expressions: [f.rule.require, { kind: "compare", operator: "eq",
      left: { kind: "literal", value: 1, value_type: { kind: "integer" } },
      right: { kind: "literal", value: 1, value_type: { kind: "integer" } } }] };
    const compiled = compileActionRule(f), rows = f.facts.bindings.holds!.rows;
    if (kind === "absent") rows.length = 0;
    else if (kind === "null") rows[0]!.state = null;
    else if (kind === "missing") delete rows[0]!.state;
    else if (kind === "tenant") rows[0]!.tenant_id = "other";
    else if (kind === "principal") rows[0]!.principal_id = "other";
    else if (kind === "link") rows[0]!.customer_id = "other";
    else rows.push(structuredClone(rows[0]!));
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p" }).result).toBe("unknown");
    expect(evaluateActionRuleApprovalPredicate({ compiled, facts: f.facts,
      expression: { kind: "compare", operator: "eq", left: { kind: "literal", value: 1, value_type: { kind: "integer" } },
        right: { kind: "literal", value: 1, value_type: { kind: "integer" } } } }).result).toBe("unknown");
  });

  it.each(["proof", "mode", "purpose", "collection", "visible", "mysql", "isolation", "scope", "exists"])("refuses incompatible %s declaration", kind => {
    const f = requiredSingletonFixture();
    if (kind === "proof") delete f.catalog.relationships[0]!.required_singleton_proof;
    if (kind === "mode") delete f.verification_boundary.resources[1]!.evidence_mode;
    if (kind === "purpose") delete f.catalog.resources[1]!.private_evidence;
    if (kind === "collection") f.verification_boundary.resources[1]!.collection_consistency = "complete_locked";
    if (kind === "visible") f.verification_boundary.resources[1]!.fields[0]!.model_visible = true;
    if (kind === "mysql") for (const resource of f.catalog.resources) resource.engine = "mysql";
    if (kind === "isolation") f.verification_boundary.transaction.isolation = "repeatable_read";
    if (kind === "scope") f.verification_boundary.resources[1]!.scope = { mode: "columns", tenant_field: "tenant_id" };
    if (kind === "exists") f.rule.require = { kind: "not", expression: { kind: "exists", binding: "holds", where: f.rule.require } };
    expect(() => compileActionRule(f)).toThrow();
  });

  it("loads the exact base parent/witness with separate runtime scope predicates", async () => {
    const f = requiredSingletonFixture(), compiled = compileActionRule(f), guards: string[] = [];
    const loaded = await loadActionRuleFacts({ compiled, subjects: f.subjects, trusted: f.facts.trusted, mode: "transaction_reverify",
      adapter: { engine: "postgres", assertResourceCompatible: async binding => { guards.push(binding.binding); },
        assertRelationshipCompatible: async (_binding, _parent, mode) => { expect(mode).toBe("transaction_reverify"); guards.push("relationship"); },
        load: async query => structuredClone(f.facts.bindings[query.binding]!.rows) } });
    expect(guards).toEqual(["customer", "holds", "relationship"]);
    expect(loaded.queries.map(query => query.relation_mode)).toEqual(["only", "only"]);
    expect(loaded.queries[1]).toMatchObject({ lock: "for_update", predicates: [
      { operation: "eq", column: "customer_id", value: "c1" }, { operation: "eq", column: "tenant_id", value: "t1" },
      { operation: "eq", column: "principal_id", value: "p1" }] });
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "p" }).result).toBe("eligible");
  });
});
