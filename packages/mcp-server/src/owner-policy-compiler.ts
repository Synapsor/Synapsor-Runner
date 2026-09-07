import { compileActionRuleBooleanPredicate, evaluateActionRule, evaluateActionRuleApprovalPredicate,
  type ActionRuleFactSetV1, type CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarExpressionV1, ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { assertBoundedOwnerPolicyInput, ownerPolicyDefinitionSchema, ownerPolicyParentSchema,
  type OwnerPolicyDefinition, type OwnerPolicyFact, type OwnerPolicyParent, type OwnerPredicate, type OwnerBudget, type OwnerBudgetCharge } from "./owner-policy-language.js";

export class OwnerPolicyCompileError extends Error {
  constructor(readonly code: string, readonly fact?: string) { super(code); this.name = "OwnerPolicyCompileError"; }
}
export type CompiledOwnerPolicy = {
  definition: OwnerPolicyDefinition;
  parent_digest: string;
  digest: string;
  budgets?: OwnerBudget[];
  rules: Array<{
    outcome: string;
    compiled_plan_digest: string;
    require: ActionRuleBooleanExpressionV1;
    approval: "inherit" | "human";
    auto_approve_when?: ActionRuleBooleanExpressionV1;
    budget_charges?: OwnerBudgetCharge[];
  }>;
};

export function compileOwnerPolicy(input: { parent: unknown; definition: unknown; rules: CompiledActionRuleV1[] }): CompiledOwnerPolicy {
  assertBoundedOwnerPolicyInput(input.parent); assertBoundedOwnerPolicyInput(input.definition);
  const parsedParent = ownerPolicyParentSchema.safeParse(input.parent), parsedDefinition = ownerPolicyDefinitionSchema.safeParse(input.definition);
  if (!parsedParent.success || !parsedDefinition.success) throw new OwnerPolicyCompileError("OWNER_POLICY_INVALID");
  const parent = parsedParent.data, definition = parsedDefinition.data;
  unique(parent.agents); unique(parent.outcomes.map((rule) => rule.outcome));
  unique(definition.agents); unique(definition.rules.map((rule) => rule.outcome));
  unique((parent.budgets ?? []).map((budget) => budget.meter));
  unique((definition.budget_limits ?? []).map((budget) => budget.meter));
  const budgets = new Map((parent.budgets ?? []).map((budget) => [budget.meter, { ...budget }]));
  for (const limit of definition.budget_limits ?? []) {
    const budget = budgets.get(limit.meter);
    if (!budget || limit.maximum > budget.maximum) throw new OwnerPolicyCompileError("OWNER_POLICY_PARENT_BUDGET_EXCEEDED");
    budget.maximum = limit.maximum;
  }
  const usedMeters = new Set<string>();
  for (const agent of definition.agents) if (!parent.agents.includes(agent)) throw new OwnerPolicyCompileError("OWNER_POLICY_AGENT_NOT_DELEGABLE");
  const available = new Map(input.rules.map((rule) => [rule.outcome, rule]));
  if (available.size !== input.rules.length) throw new OwnerPolicyCompileError("OWNER_POLICY_AMBIGUOUS_ACTION");
  const parents = new Map<string, { source: OwnerPolicyParent["outcomes"][number]; compiled: CompiledActionRuleV1; facts: Map<string, OwnerPolicyFact> }>();
  for (const source of parent.outcomes) {
    const compiled = available.get(source.outcome);
    if (!compiled || compiled.compiled_plan_digest !== source.compiled_plan_digest) throw new OwnerPolicyCompileError("OWNER_POLICY_PARENT_CHANGED");
    unique((source.budget_charges ?? []).map((charge) => charge.meter));
    for (const charge of source.budget_charges ?? []) {
      const budget = budgets.get(charge.meter);
      if (!budget) throw new OwnerPolicyCompileError("OWNER_POLICY_BUDGET_NOT_DEFINED");
      if (charge.kind === "effect_count") {
        if (budget.unit !== "effects") throw new OwnerPolicyCompileError("OWNER_POLICY_BUDGET_UNIT_MISMATCH");
      } else {
        const field = compiled.effect_envelope.allowed_fields.find((entry) => entry.name === charge.field);
        if (!field || !Object.hasOwn(compiled.rule.effect.set, charge.field)) throw new OwnerPolicyCompileError("OWNER_POLICY_BUDGET_EFFECT_NOT_VERIFIED");
        const unit = field.type.kind === "integer" ? field.type.unit : field.type.kind === "money_minor" ? `${field.type.currency}:minor` : undefined;
        if (unit !== budget.unit) throw new OwnerPolicyCompileError("OWNER_POLICY_BUDGET_UNIT_MISMATCH");
      }
      usedMeters.add(charge.meter);
    }
    unique(source.facts.map((fact) => fact.name));
    const facts = new Map(source.facts.map((fact) => [fact.name, fact]));
    for (const fact of facts.values()) {
      unique(fact.operators);
      const type = factType(compiled, fact);
      if (fact.literal_range && (!["integer", "money_minor"].includes(type.kind)
          || fact.literal_range.minimum > fact.literal_range.maximum
          || !Number.isSafeInteger(fact.literal_range.minimum) || !Number.isSafeInteger(fact.literal_range.maximum))) {
        throw new OwnerPolicyCompileError("OWNER_POLICY_FACT_RANGE_INVALID", fact.name);
      }
      for (const value of fact.literal_values ?? []) literal(type, value, fact, false);
    }
    if (source.require) compileActionRuleBooleanPredicate({ compiled, expression: translate(source.require, compiled, facts) });
    parents.set(source.outcome, { source, compiled, facts });
  }
  if ([...budgets.keys()].some((meter) => !usedMeters.has(meter))) throw new OwnerPolicyCompileError("OWNER_POLICY_BUDGET_NOT_ENFORCED");
  const rules = definition.rules.map((rule): CompiledOwnerPolicy["rules"][number] => {
    const parentRule = parents.get(rule.outcome);
    if (!parentRule) throw new OwnerPolicyCompileError("OWNER_POLICY_OUTCOME_NOT_DELEGABLE");
    const { compiled, facts, source } = parentRule;
    const compile = (predicate: OwnerPredicate) => compileActionRuleBooleanPredicate({ compiled, expression: translate(predicate, compiled, facts) });
    const conditions = [compile(rule.require), ...(source.require ? [compile(source.require)] : [])];
    if (rule.approval === "inherit" && !source.allow_automatic_approval) throw new OwnerPolicyCompileError("OWNER_POLICY_HUMAN_APPROVAL_REQUIRED");
    if (rule.approval === "human" && rule.auto_approve_when) throw new OwnerPolicyCompileError("OWNER_POLICY_CONTRADICTORY_APPROVAL");
    return { outcome: rule.outcome, compiled_plan_digest: compiled.compiled_plan_digest,
      require: { kind: "all", expressions: conditions }, approval: rule.approval,
      ...(rule.auto_approve_when ? { auto_approve_when: compile(rule.auto_approve_when) } : {}),
      ...(source.budget_charges ? { budget_charges: source.budget_charges } : {}) };
  });
  const body = { definition, parent_digest: canonicalJsonDigest(parent), rules,
    ...(budgets.size ? { budgets: [...budgets.values()] } : {}) };
  return { ...body, digest: canonicalJsonDigest(body) };
}

/** Adds owner checks to, never replaces, base eligibility. A passing result is
 * NOT approval or an execution permit. Parent approval/budget obligations still
 * apply. Current chain resolution must precede this pure evaluator. */
export function evaluateOwnerPolicy(input: { policy: CompiledOwnerPolicy; compiled: CompiledActionRuleV1;
  acting_agent: string; facts: ActionRuleFactSetV1; inputs?: Record<string, unknown>; proposal_id: string }):
  { result: "allowed"; approval: "inherit" | "human" } | { result: "refused" | "unknown"; code: string } {
  const { digest, ...body } = input.policy;
  if (canonicalJsonDigest(body) !== digest) return { result: "refused", code: "OWNER_POLICY_INTEGRITY_INVALID" };
  const rule = input.policy.rules.find((value) => value.outcome === input.compiled.outcome);
  if (!input.policy.definition.agents.includes(input.acting_agent) || !rule) return { result: "refused", code: "OWNER_POLICY_NOT_DELEGATED" };
  if (rule.compiled_plan_digest !== input.compiled.compiled_plan_digest) return { result: "refused", code: "OWNER_POLICY_PARENT_CHANGED" };
  const base = evaluateActionRule({ compiled: input.compiled, facts: input.facts, inputs: input.inputs, proposal_id: input.proposal_id });
  if (base.result !== "eligible") return { result: base.result === "unknown" ? "unknown" : "refused", code: base.safe_code };
  const check = (expression: ActionRuleBooleanExpressionV1) => evaluateActionRuleApprovalPredicate({
    compiled: input.compiled, facts: input.facts, inputs: input.inputs, expression,
  });
  const hard = check(rule.require);
  if (hard.result !== "match") return { result: hard.result === "unknown" ? "unknown" : "refused", code: "OWNER_POLICY_CONDITION_NOT_PROVEN" };
  const automatic = rule.auto_approve_when ? check(rule.auto_approve_when) : undefined;
  return { result: "allowed", approval: rule.approval === "human" || (automatic && automatic.result !== "match") ? "human" : "inherit" };
}

function translate(predicate: OwnerPredicate, compiled: CompiledActionRuleV1, facts: Map<string, OwnerPolicyFact>, depth = 0): ActionRuleBooleanExpressionV1 {
  if (depth > 8) throw new OwnerPolicyCompileError("OWNER_POLICY_COMPLEXITY_LIMIT");
  if (predicate.kind === "all" || predicate.kind === "any") return { kind: predicate.kind,
    expressions: predicate.conditions.map((child) => translate(child, compiled, facts, depth + 1)) };
  if (predicate.kind === "not") return { kind: "not", expression: translate(predicate.condition, compiled, facts, depth + 1) };
  const fact = facts.get(predicate.fact);
  if (!fact) throw new OwnerPolicyCompileError("OWNER_POLICY_FACT_NOT_DELEGABLE", predicate.fact);
  const operator = predicate.kind === "compare" || predicate.kind === "compare_facts" ? predicate.operator : predicate.kind;
  if (!fact.operators.includes(operator)) throw new OwnerPolicyCompileError("OWNER_POLICY_OPERATOR_NOT_DELEGABLE", fact.name);
  const type = factType(compiled, fact);
  if (predicate.kind === "is_present") return { kind: "null_check", operator: "is_not_null", value: fact.source };
  if (predicate.kind === "one_of") return { kind: "in", value: fact.source, values: predicate.values.map((value) => literal(type, value, fact)) };
  if (predicate.kind === "compare") return { kind: "compare", operator: predicate.operator, left: fact.source, right: literal(type, predicate.value, fact) };
  const other = facts.get(predicate.other_fact);
  if (!other || !other.operators.includes(predicate.operator)) throw new OwnerPolicyCompileError("OWNER_POLICY_FACT_NOT_DELEGABLE", predicate.other_fact);
  return { kind: "compare", operator: predicate.operator, left: fact.source, right: other.source };
}

function factType(compiled: CompiledActionRuleV1, fact: OwnerPolicyFact): ActionRuleScalarTypeSpecV1 {
  const source = fact.source;
  if (source.kind === "trusted") return { kind: "timestamp" };
  let type: ActionRuleScalarTypeSpecV1 | undefined;
  if (source.kind === "input") type = compiled.rule.inputs?.find((value) => value.name === source.name)?.type;
  if (source.kind === "derived" && Object.hasOwn(compiled.derived_types, source.name)) type = compiled.derived_types[source.name];
  if (source.kind === "field") {
    const binding = compiled.bindings.find((value) => value.binding === source.binding);
    type = binding?.verification.cardinality === "one" ? binding.verification.fields.find((value) => value.name === source.field)?.type : undefined;
  }
  if (!type) throw new OwnerPolicyCompileError("OWNER_POLICY_FACT_NOT_VERIFIED", fact.name);
  return type;
}

function literal(type: ActionRuleScalarTypeSpecV1, value: string | number | boolean, fact: OwnerPolicyFact, checkAllowlist = true): ActionRuleScalarExpressionV1 {
  let valid = false;
  if (type.kind === "boolean") valid = typeof value === "boolean";
  if (type.kind === "integer" || type.kind === "money_minor") valid = typeof value === "number" && Number.isSafeInteger(value);
  if (type.kind === "string") valid = typeof value === "string" && value.length <= type.max_length && (!type.enum || type.enum.includes(value));
  if (type.kind === "date" || type.kind === "timestamp") valid = typeof value === "string";
  if (!valid) throw new OwnerPolicyCompileError("OWNER_POLICY_VALUE_TYPE_INVALID", fact.name);
  if (fact.literal_range && (typeof value !== "number" || value < fact.literal_range.minimum || value > fact.literal_range.maximum)) {
    throw new OwnerPolicyCompileError("OWNER_POLICY_PARENT_LIMIT_EXCEEDED", fact.name);
  }
  if (checkAllowlist && fact.literal_values && !fact.literal_values.includes(value)) throw new OwnerPolicyCompileError("OWNER_POLICY_VALUE_NOT_DELEGABLE", fact.name);
  return { kind: "literal", value, value_type: type };
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new OwnerPolicyCompileError("OWNER_POLICY_DUPLICATE");
}
