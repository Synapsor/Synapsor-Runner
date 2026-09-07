import { describe, expect, it } from "vitest";
import { compileOwnerPolicy, evaluateOwnerPolicy } from "./owner-policy-compiler.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";
import type { OwnerPredicate } from "./owner-policy-language.js";

describe("typed owner delegation compiler", () => {
  it.each(["inventory", "university", "customer_support"])("keeps the reviewed %s action and parent requirements mandatory", (domain) => {
    const f = ownerPolicyTestFixture(domain, domain === "university"), original = structuredClone(f.compiled);
    const policy = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    const evaluate = (quantity: number) => evaluateOwnerPolicy({ ...f, policy, acting_agent: "agent-a", inputs: { quantity }, proposal_id: "proposal-1" });
    expect(evaluate(10)).toEqual({ result: "allowed", approval: "inherit" });
    expect(evaluate(21)).toMatchObject({ result: "refused" });
    f.facts.bindings.request!.rows[0]!.category = "exception";
    expect(evaluate(10)).toEqual({ result: "allowed", approval: "human" });
    f.facts.bindings.request!.rows[0]!.available = false;
    expect(evaluate(10)).toMatchObject({ result: "refused" });
    f.facts.bindings.request!.rows[0]!.available = true;
    f.facts.bindings.request!.rows[0]!.expires_at = "2020-01-01T00:00:00.000Z";
    expect(evaluate(10)).toMatchObject({ result: "refused" });
    expect(f.compiled).toEqual(original);
  });

  it("lets an owner raise their own limit within the parent without inheriting the old child limit", () => {
    const f = ownerPolicyTestFixture();
    const first = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    f.definition.rules[0]!.require = { kind: "compare", fact: "requested_units", operator: "lte", value: 30 };
    const next = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    const input = { ...f, acting_agent: "agent-a", inputs: { quantity: 25 }, proposal_id: "proposal-1" };
    expect(evaluateOwnerPolicy({ ...input, policy: first })).toMatchObject({ result: "refused" });
    expect(evaluateOwnerPolicy({ ...input, policy: next })).toMatchObject({ result: "allowed" });
    f.definition.rules[0]!.require = { kind: "compare", fact: "requested_units", operator: "lte", value: 51 };
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_PARENT_LIMIT_EXCEEDED");
  });

  it("supports verified comparisons, all/any/not, presence, allowlists, and coded field aliases", () => {
    const f = ownerPolicyTestFixture("university", true);
    f.definition.rules[0]!.require = { kind: "all", conditions: [
      { kind: "compare_facts", fact: "requested_units", operator: "gte", other_fact: "current_units" },
      { kind: "is_present", fact: "valid_until" },
      { kind: "any", conditions: [{ kind: "one_of", fact: "request_category", values: ["routine"] },
        { kind: "not", condition: { kind: "compare", fact: "requested_units", operator: "gte", value: 30 } }] },
    ] };
    const policy = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    expect(JSON.stringify(policy.rules)).toContain('"field":"f09"');
    expect(evaluateOwnerPolicy({ ...f, policy, acting_agent: "agent-a", inputs: { quantity: 10 }, proposal_id: "proposal-1" })).toMatchObject({ result: "allowed" });
  });

  it.each([
    { kind: "compare", fact: "tenant_id", operator: "eq", value: "beta" },
    { kind: "compare", fact: "requested_units", operator: "lte", value: "20" },
    { kind: "compare", fact: "requested_units", operator: "neq", value: 20 },
    { kind: "one_of", fact: "request_category", values: ["invented"] },
    { kind: "compare_facts", fact: "requested_units", operator: "eq", other_fact: "request_category" },
    { kind: "sql", expression: "true" },
    { kind: "compare", fact: "requested_units", operator: "lte", value: 20, source: "some_other_table" },
    { kind: "compare", fact: "valid_until", operator: "gt", value: "tomorrow" },
  ])("refuses unreviewed names, types, operators, and extra controls: %j", (require) => {
    const f = ownerPolicyTestFixture();
    const definition = { ...f.definition, rules: [{ ...f.definition.rules[0]!, require }] };
    expect(() => compileOwnerPolicy({ parent: f.parent, definition, rules: [f.compiled] })).toThrow();
  });

  it("keeps owner approval narrower than the parent and prevents selecting another reviewer", () => {
    const f = ownerPolicyTestFixture(); f.parent.outcomes[0]!.allow_automatic_approval = false;
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_HUMAN_APPROVAL_REQUIRED");
    f.definition.rules[0]!.approval = "human";
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_CONTRADICTORY_APPROVAL");
    delete f.definition.rules[0]!.auto_approve_when;
    const policy = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    expect(evaluateOwnerPolicy({ ...f, policy, acting_agent: "agent-a", inputs: { quantity: 10 }, proposal_id: "proposal-1" })).toEqual({ result: "allowed", approval: "human" });
    expect(() => compileOwnerPolicy({ ...f, definition: { ...f.definition, reviewer: "me" }, rules: [f.compiled] })).toThrow("OWNER_POLICY_INVALID");
  });

  it("does not let a new or recreated agent adopt another agent's delegation", () => {
    const f = ownerPolicyTestFixture(), policy = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    expect(evaluateOwnerPolicy({ ...f, policy, acting_agent: "agent-b", inputs: { quantity: 10 }, proposal_id: "p" })).toMatchObject({ result: "refused", code: "OWNER_POLICY_NOT_DELEGATED" });
    f.definition.agents = ["unreviewed-agent"];
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_AGENT_NOT_DELEGABLE");
  });

  it("rejects changed base rules, duplicate outcomes, unverified parent facts and unreviewed effects", () => {
    const f = ownerPolicyTestFixture();
    f.parent.outcomes[0]!.compiled_plan_digest = `sha256:${"e".repeat(64)}`;
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_PARENT_CHANGED");
    f.parent.outcomes[0]!.compiled_plan_digest = f.compiled.compiled_plan_digest;
    f.definition.rules.push(structuredClone(f.definition.rules[0]!));
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_DUPLICATE");
    f.definition.rules.pop();
    f.parent.outcomes[0]!.facts[0]!.source = { kind: "field", binding: "other_source", field: "balance" };
    expect(() => compileOwnerPolicy({ ...f, rules: [f.compiled] })).toThrow("OWNER_POLICY_FACT_NOT_VERIFIED");
  });

  it("refuses missing or cross-owner facts instead of treating uncertainty as permission", () => {
    const f = ownerPolicyTestFixture(), policy = compileOwnerPolicy({ ...f, rules: [f.compiled] });
    const evaluate = () => evaluateOwnerPolicy({ ...f, policy, acting_agent: "agent-a", inputs: { quantity: 10 }, proposal_id: "p" });
    f.facts.bindings.request!.rows[0]!.tenant_id = "beta";
    expect(evaluate()).toMatchObject({ result: "unknown" });
    f.facts.bindings.request!.rows = [];
    expect(evaluate().result).not.toBe("allowed");
  });

  it("bounds cyclic and deeply nested model inputs before recursive validation", () => {
    const f = ownerPolicyTestFixture();
    const cycle: { kind: "not"; condition?: unknown } = { kind: "not" }; cycle.condition = cycle;
    const make = (require: unknown) => ({ ...f.definition, rules: [{ ...f.definition.rules[0]!, require }] });
    expect(() => compileOwnerPolicy({ ...f, definition: make(cycle), rules: [f.compiled] })).toThrow("OWNER_POLICY_COMPLEXITY_LIMIT");
    let expression: OwnerPredicate = { kind: "compare", fact: "requested_units", operator: "lte", value: 20 };
    for (let index = 0; index < 10; index++) expression = { kind: "not", condition: expression };
    expect(() => compileOwnerPolicy({ ...f, definition: make(expression), rules: [f.compiled] })).toThrow("OWNER_POLICY_COMPLEXITY_LIMIT");
  });
});
