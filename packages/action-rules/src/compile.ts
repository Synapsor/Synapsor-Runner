import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarExpressionV1,
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
  RuleVerificationResourceSpecV1,
} from "@synapsor/spec";
import { ActionRuleError } from "./errors.js";
import {
  actionRuleDigest,
  effectEnvelopeDigest,
  normalizeActionRule,
  normalizeActionRuleBooleanExpression,
  normalizeActionRuleCatalog,
  normalizeDerivedEffectEnvelope,
  normalizeVerificationBoundary,
  verificationBoundaryDigest,
} from "./normalize.js";
import {
  ACTION_RULE_COMPILER_VERSION,
  COMPILED_ACTION_RULE_VERSION,
  type ActionRuleCatalogFieldV1,
  type ActionRuleCatalogRelationshipV1,
  type ActionRuleCatalogResourceV1,
  type ActionRuleCatalogV1,
  type CompiledActionRuleV1,
  type CompiledRuleBindingV1,
} from "./types.js";

export type CompileActionRuleInput = {
  rule: ActionRuleSpecV1;
  verification_boundary: RuleVerificationBoundarySpecV1;
  effect_envelope: DerivedEffectEnvelopeSpecV1;
  catalog: ActionRuleCatalogV1;
};

export function compileActionRuleBooleanPredicate(input: {
  compiled: CompiledActionRuleV1;
  expression: ActionRuleBooleanExpressionV1;
  path?: string;
}): ActionRuleBooleanExpressionV1 {
  const expression = normalizeActionRuleBooleanExpression(input.expression);
  const context: CompileContext = {
    bindings: new Map(input.compiled.bindings.map((binding) => [binding.binding, binding])),
    inputs: new Map((input.compiled.rule.inputs ?? []).map((value) => [value.name, value.type])),
    derivedTypes: new Map(Object.entries(input.compiled.derived_types)),
  };
  inferBoolean(expression, context, input.path ?? "approval.auto_approve_when");
  return expression;
}

type InferredType = {
  type: ActionRuleScalarTypeSpecV1;
  nullable: boolean;
};

type CompileContext = {
  inputs: Map<string, ActionRuleScalarTypeSpecV1>;
  bindings: Map<string, CompiledRuleBindingV1>;
  derivedTypes: Map<string, ActionRuleScalarTypeSpecV1>;
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function fail(code: ConstructorParameters<typeof ActionRuleError>[0], message: string, path?: string): never {
  throw new ActionRuleError(code, message, path);
}

function uniqueByName<T extends { name: string }>(items: T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.name)) fail("ACTION_RULE_INVALID", `${label} ${item.name} is duplicated.`);
    result.set(item.name, item);
  }
  return result;
}

function fieldMap(resource: ActionRuleCatalogResourceV1): Map<string, ActionRuleCatalogFieldV1> {
  return uniqueByName(resource.fields, `Field in ${resource.name}`);
}

function typeKey(type: ActionRuleScalarTypeSpecV1): string {
  switch (type.kind) {
    case "integer": return `integer:${type.unit ?? ""}`;
    case "money_minor": return `money_minor:${type.currency}`;
    case "string": return "string:exact";
    default: return type.kind;
  }
}

function compatibleTypes(left: ActionRuleScalarTypeSpecV1, right: ActionRuleScalarTypeSpecV1): boolean {
  return typeKey(left) === typeKey(right);
}

function exactTypes(left: ActionRuleScalarTypeSpecV1, right: ActionRuleScalarTypeSpecV1): boolean {
  if (!compatibleTypes(left, right)) return false;
  if (left.kind !== "string" || right.kind !== "string") return true;
  if (left.max_length !== right.max_length) return false;
  return JSON.stringify([...(left.enum ?? [])].sort()) === JSON.stringify([...(right.enum ?? [])].sort());
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertLiteralMatchesType(expression: Extract<ActionRuleScalarExpressionV1, { kind: "literal" }>, path: string): void {
  const { value, value_type: type } = expression;
  if (value === null) return;
  if (type.kind === "boolean" && typeof value !== "boolean") fail("ACTION_RULE_TYPE_MISMATCH", `${path} is not boolean.`, path);
  if ((type.kind === "integer" || type.kind === "money_minor") && !Number.isSafeInteger(value)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} must be a safe integer.`, path);
  if (type.kind === "string") {
    if (typeof value !== "string" || value.length > type.max_length) fail("ACTION_RULE_TYPE_MISMATCH", `${path} is not a bounded string.`, path);
    if (type.enum !== undefined && !type.enum.includes(value)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} is outside its reviewed enum.`, path);
  }
  if (type.kind === "date" && (typeof value !== "string" || !isCanonicalDate(value))) fail("ACTION_RULE_TYPE_MISMATCH", `${path} must be a real ISO calendar date.`, path);
  if (type.kind === "timestamp" && (typeof value !== "string" || !isCanonicalTimestamp(value))) fail("ACTION_RULE_TYPE_MISMATCH", `${path} must be a canonical UTC timestamp.`, path);
}

function assertEffectFieldConstraint(
  field: DerivedEffectEnvelopeSpecV1["allowed_fields"][number],
  path: string,
): void {
  if ((field.minimum !== undefined || field.maximum !== undefined)
    && field.type.kind !== "integer"
    && field.type.kind !== "money_minor") {
    fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path} has numeric bounds on a nonnumeric field.`, path);
  }
  if (field.minimum !== undefined && !Number.isSafeInteger(field.minimum)) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path}.minimum must be a safe integer.`, path);
  if (field.maximum !== undefined && !Number.isSafeInteger(field.maximum)) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path}.maximum must be a safe integer.`, path);
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path} has an inverted numeric range.`, path);
  if (field.values !== undefined) {
    if (field.values.length === 0 || field.values.length > 256
      || new Set(field.values.map((value) => canonicalJsonDigest(value))).size !== field.values.length) {
      fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path}.values must be a bounded unique allowlist.`, path);
    }
    field.values.forEach((value, index) => {
      if (value === null) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `${path}.values[${index}] cannot be null.`, path);
      assertLiteralMatchesType({ kind: "literal", value, value_type: field.type }, `${path}.values[${index}]`);
    });
  }
}

function resolveRelationship(
  verification: RuleVerificationResourceSpecV1,
  binding: CompiledRuleBindingV1,
  bindings: Map<string, CompiledRuleBindingV1>,
  relationships: Map<string, ActionRuleCatalogRelationshipV1>,
): ActionRuleCatalogRelationshipV1 | undefined {
  if (verification.source.kind === "subject_ref") return undefined;
  const parent = bindings.get(verification.source.from_binding);
  if (parent === undefined) fail("ACTION_RULE_INVALID", `Binding ${verification.binding} references unknown parent ${verification.source.from_binding}.`, `verification_boundary.resources.${verification.binding}.source.from_binding`);
  const relationship = relationships.get(verification.source.relationship);
  if (relationship === undefined) fail("ACTION_RULE_INVALID", `Relationship ${verification.source.relationship} is not present in the inspected catalog.`, `verification_boundary.resources.${verification.binding}.source.relationship`);
  if (verification.source.local_field !== relationship.local_field || verification.source.target_field !== relationship.target_field) {
    fail("ACTION_RULE_INVALID", `Relationship ${relationship.name} columns do not match the inspected catalog.`, `verification_boundary.resources.${verification.binding}.source`);
  }
  const forward = verification.source.direction === "forward";
  const expectedParent = forward ? relationship.from_resource : relationship.to_resource;
  const expectedChild = forward ? relationship.to_resource : relationship.from_resource;
  if (parent.resource.name !== expectedParent || binding.resource.name !== expectedChild) {
    fail("ACTION_RULE_INVALID", `Relationship ${relationship.name} does not connect ${parent.resource.name} to ${binding.resource.name} in the reviewed direction.`, `verification_boundary.resources.${verification.binding}.source`);
  }
  const yieldsMany = forward
    ? relationship.cardinality === "one_to_many"
    : relationship.cardinality === "many_to_one";
  const expectedCardinality = yieldsMany ? "many" : "one";
  if (verification.cardinality !== expectedCardinality) {
    fail("ACTION_RULE_UNBOUNDED", `Binding ${verification.binding} must declare cardinality ${expectedCardinality} for relationship ${relationship.name}.`, `verification_boundary.resources.${verification.binding}.cardinality`);
  }
  if (!yieldsMany && relationship.cardinality !== "one_to_many" && !relationship.target_unique) {
    fail("ACTION_RULE_UNBOUNDED", `Relationship ${relationship.name} does not prove at-most-one target row.`, `verification_boundary.resources.${verification.binding}.source.relationship`);
  }
  return relationship;
}

function assertScope(
  binding: CompiledRuleBindingV1,
  bindings: Map<string, CompiledRuleBindingV1>,
): void {
  const { resource, verification } = binding;
  const fields = fieldMap(resource);
  if (verification.scope.mode === "columns") {
    if (resource.tenant_key !== verification.scope.tenant_field) {
      fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${verification.binding} does not use the inspected trusted tenant key.`, `verification_boundary.resources.${verification.binding}.scope.tenant_field`);
    }
    if (resource.principal_scope_key !== verification.scope.principal_field) {
      fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${verification.binding} does not use the inspected trusted principal key.`, `verification_boundary.resources.${verification.binding}.scope.principal_field`);
    }
    for (const name of [verification.scope.tenant_field, verification.scope.principal_field].filter((value): value is string => value !== undefined)) {
      if (!fields.has(name)) fail("ACTION_RULE_SCOPE_UNPROVEN", `Scope field ${resource.name}.${name} is absent from the inspected catalog.`);
      requireVerificationField(binding, name, "trusted scope verification");
    }
    return;
  }
  if (verification.scope.mode === "inherited") {
    if (verification.source.kind !== "relationship" || verification.source.from_binding !== verification.scope.from_binding) {
      fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${verification.binding} may inherit scope only through its reviewed parent relationship.`, `verification_boundary.resources.${verification.binding}.scope`);
    }
    if (!bindings.has(verification.scope.from_binding)) fail("ACTION_RULE_SCOPE_UNPROVEN", `Scope parent ${verification.scope.from_binding} is unavailable.`);
    return;
  }
  if (verification.scope.mode !== "single_organization" || verification.scope.organization_id.length === 0) {
    fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${verification.binding} has no proven scope.`);
  }
  if (resource.principal_scope_key !== verification.scope.principal_field) {
    fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${verification.binding} does not use the inspected trusted principal key.`, `verification_boundary.resources.${verification.binding}.scope.principal_field`);
  }
  if (verification.scope.principal_field !== undefined) {
    if (!fields.has(verification.scope.principal_field)) fail("ACTION_RULE_SCOPE_UNPROVEN", `Scope field ${resource.name}.${verification.scope.principal_field} is absent from the inspected catalog.`);
    requireVerificationField(binding, verification.scope.principal_field, "trusted principal verification");
  }
}

type RootScopeAuthority =
  | { mode: "tenant" }
  | { mode: "single_organization"; organization_id: string };

function rootScopeAuthority(
  binding: CompiledRuleBindingV1,
  bindings: Map<string, CompiledRuleBindingV1>,
  visiting = new Set<string>(),
): RootScopeAuthority {
  if (visiting.has(binding.binding)) fail("ACTION_RULE_SCOPE_UNPROVEN", `Scope inheritance for ${binding.binding} is cyclic.`);
  if (binding.verification.scope.mode === "columns") return { mode: "tenant" };
  if (binding.verification.scope.mode === "single_organization") {
    return { mode: "single_organization", organization_id: binding.verification.scope.organization_id };
  }
  const parent = bindings.get(binding.verification.scope.from_binding);
  if (parent === undefined) fail("ACTION_RULE_SCOPE_UNPROVEN", `Scope parent ${binding.verification.scope.from_binding} is unavailable.`);
  const next = new Set(visiting);
  next.add(binding.binding);
  return rootScopeAuthority(parent, bindings, next);
}

function assertAuthorityScope(
  envelope: DerivedEffectEnvelopeSpecV1,
  bindings: Map<string, CompiledRuleBindingV1>,
): void {
  const authorities = [...bindings.values()].map((binding) => rootScopeAuthority(binding, bindings));
  const signatures = new Set(authorities.map((authority) => authority.mode === "tenant"
    ? "tenant"
    : `organization:${authority.organization_id}`));
  if (signatures.size !== 1) {
    fail("ACTION_RULE_SCOPE_UNPROVEN", "Every Verification Boundary binding must resolve to one identical reviewed tenant or organization scope.", "verification_boundary.resources");
  }
  const authority = authorities[0]!;
  if (authority.mode === "tenant") {
    if (envelope.tenant_key === undefined || envelope.organization_scope !== undefined) {
      fail("ACTION_RULE_SCOPE_UNPROVEN", "A tenant-scoped rule requires one reviewed target tenant key and no single-organization effect scope.", "effect_envelope");
    }
    return;
  }
  if (envelope.tenant_key !== undefined
    || envelope.organization_scope?.mode !== "single_organization"
    || envelope.organization_scope.organization_id !== authority.organization_id) {
    fail("ACTION_RULE_SCOPE_UNPROVEN", "The derived effect must bind the same reviewed single organization as every verification fact.", "effect_envelope.organization_scope");
  }
}

function requireVerificationField(binding: CompiledRuleBindingV1, name: string, purpose: string): void {
  if (!binding.verification.fields.some((field) => field.name === name)) {
    fail("ACTION_RULE_INVALID", `${binding.resource.name}.${name} must be in the private Verification Boundary for ${purpose}.`, `verification_boundary.resources.${binding.binding}.fields`);
  }
}

function inferScalar(
  expression: ActionRuleScalarExpressionV1,
  context: CompileContext,
  path: string,
  rowBinding?: string,
): InferredType {
  switch (expression.kind) {
    case "input": {
      const type = context.inputs.get(expression.name);
      if (!type) fail("ACTION_RULE_INVALID", `${path} references undeclared business input ${expression.name}.`, path);
      return { type, nullable: false };
    }
    case "literal":
      assertLiteralMatchesType(expression, path);
      return { type: expression.value_type, nullable: expression.value === null };
    case "trusted":
      if (expression.binding === "transaction_time") return { type: { kind: "timestamp" }, nullable: false };
      if (expression.binding === "organization") return { type: { kind: "string", max_length: 4096, comparison: "exact" }, nullable: false };
      return { type: { kind: "string", max_length: 4096, comparison: "exact" }, nullable: expression.binding === "principal" };
    case "field": {
      const binding = context.bindings.get(expression.binding);
      if (binding === undefined) fail("ACTION_RULE_INVALID", `${path} references unknown binding ${expression.binding}.`, path);
      if (binding.verification.cardinality === "many" && rowBinding !== expression.binding) {
        fail("ACTION_RULE_UNBOUNDED", `${path} reads a many-row binding outside a bounded aggregate or exists predicate.`, path);
      }
      const reviewed = binding.verification.fields.find((field) => field.name === expression.field);
      if (reviewed === undefined) fail("ACTION_RULE_INVALID", `${path} references a field outside the private Verification Boundary.`, path);
      const catalogField = fieldMap(binding.resource).get(expression.field);
      if (catalogField === undefined || !exactTypes(reviewed.type, catalogField.type)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} no longer matches the inspected field type.`, path);
      return { type: reviewed.type, nullable: reviewed.nullable ?? catalogField.nullable };
    }
    case "derived": {
      const type = context.derivedTypes.get(expression.name);
      if (type === undefined) fail("ACTION_RULE_INVALID", `${path} references unresolved derived value ${expression.name}.`, path);
      return { type, nullable: false };
    }
    case "aggregate": {
      fail(
        "ACTION_RULE_UNBOUNDED",
        `${path} uses an aggregate without a reviewed cross-engine phantom-prevention strategy. Action Rule v1 supports positive bounded exists only.`,
        path,
      );
    }
    case "math": {
      const inputs = expression.inputs.map((input, index) => inferScalar(input, context, `${path}.inputs[${index}]`, rowBinding));
      const first = inputs[0];
      if (first === undefined || (first.type.kind !== "integer" && first.type.kind !== "money_minor")) fail("ACTION_RULE_TYPE_MISMATCH", `${path} requires numeric inputs.`, path);
      if (inputs.some((input) => !compatibleTypes(first.type, input.type))) fail("ACTION_RULE_TYPE_MISMATCH", `${path} mixes incompatible units or scalar types.`, path);
      return { type: first.type, nullable: inputs.some((input) => input.nullable) };
    }
    case "scale": {
      const input = inferScalar(expression.input, context, `${path}.input`, rowBinding);
      if (input.type.kind !== "integer" && input.type.kind !== "money_minor") fail("ACTION_RULE_TYPE_MISMATCH", `${path} scale requires an integer or money value.`, path);
      return input;
    }
    case "clamp": {
      const input = inferScalar(expression.input, context, `${path}.input`, rowBinding);
      const minimum = inferScalar(expression.minimum, context, `${path}.minimum`, rowBinding);
      const maximum = inferScalar(expression.maximum, context, `${path}.maximum`, rowBinding);
      if (!compatibleTypes(input.type, minimum.type) || !compatibleTypes(input.type, maximum.type)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} clamp bounds must use the same type and unit.`, path);
      if (input.type.kind !== "integer" && input.type.kind !== "money_minor") fail("ACTION_RULE_TYPE_MISMATCH", `${path} clamp requires a numeric value.`, path);
      return { type: input.type, nullable: input.nullable || minimum.nullable || maximum.nullable };
    }
    case "add_duration": {
      const input = inferScalar(expression.timestamp, context, `${path}.timestamp`, rowBinding);
      if (input.type.kind !== "timestamp") fail("ACTION_RULE_TYPE_MISMATCH", `${path} requires a timestamp.`, path);
      return { type: { kind: "timestamp" }, nullable: input.nullable };
    }
  }
}

function inferBoolean(
  expression: ActionRuleBooleanExpressionV1,
  context: CompileContext,
  path: string,
  rowBinding?: string,
  positive = true,
): void {
  switch (expression.kind) {
    case "all":
    case "any":
      expression.expressions.forEach((item, index) => inferBoolean(
        item,
        context,
        `${path}.expressions[${index}]`,
        rowBinding,
        positive,
      ));
      return;
    case "not":
      inferBoolean(expression.expression, context, `${path}.expression`, rowBinding, !positive);
      return;
    case "null_check":
      inferScalar(expression.value, context, `${path}.value`, rowBinding);
      return;
    case "in": {
      const subject = inferScalar(expression.value, context, `${path}.value`, rowBinding);
      expression.values.forEach((value, index) => {
        const candidate = inferScalar(value, context, `${path}.values[${index}]`, rowBinding);
        if (!compatibleTypes(subject.type, candidate.type)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} contains incompatible values.`, path);
      });
      return;
    }
    case "compare": {
      const left = inferScalar(expression.left, context, `${path}.left`, rowBinding);
      const right = inferScalar(expression.right, context, `${path}.right`, rowBinding);
      if (!compatibleTypes(left.type, right.type)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} compares incompatible types or units.`, path);
      if ((left.type.kind === "boolean" || left.type.kind === "string") && !["eq", "neq"].includes(expression.operator)) {
        fail("ACTION_RULE_TYPE_MISMATCH", `${path} permits only exact equality for ${left.type.kind} values.`, path);
      }
      return;
    }
    case "exists": {
      if (!positive) {
        fail(
          "ACTION_RULE_UNBOUNDED",
          `${path} uses negative existence without a reviewed cross-engine phantom-prevention strategy. Action Rule v1 supports positive bounded exists only.`,
          path,
        );
      }
      const binding = context.bindings.get(expression.binding);
      if (binding === undefined) fail("ACTION_RULE_INVALID", `${path} references unknown binding ${expression.binding}.`, path);
      if (binding.verification.cardinality !== "many") fail("ACTION_RULE_INVALID", `${path} exists requires a bounded many-row binding.`, path);
      inferBoolean(expression.where, context, `${path}.where`, expression.binding);
      return;
    }
  }
}

function collectDerivedReferences(expression: ActionRuleScalarExpressionV1, result: Set<string>): void {
  switch (expression.kind) {
    case "derived": result.add(expression.name); return;
    case "math": expression.inputs.forEach((item) => collectDerivedReferences(item, result)); return;
    case "scale": collectDerivedReferences(expression.input, result); return;
    case "clamp":
      collectDerivedReferences(expression.input, result);
      collectDerivedReferences(expression.minimum, result);
      collectDerivedReferences(expression.maximum, result);
      return;
    case "add_duration": collectDerivedReferences(expression.timestamp, result); return;
    default: return;
  }
}

function derivationOrder(rule: ActionRuleSpecV1): string[] {
  const names = new Set(Object.keys(rule.derive));
  const dependencies = new Map<string, Set<string>>();
  for (const [name, expression] of Object.entries(rule.derive)) {
    const refs = new Set<string>();
    collectDerivedReferences(expression, refs);
    for (const ref of refs) if (!names.has(ref)) fail("ACTION_RULE_INVALID", `Derived value ${name} references unknown value ${ref}.`, `rule.derive.${name}`);
    dependencies.set(name, refs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) fail("ACTION_RULE_INVALID", `Derived value cycle includes ${name}.`, `rule.derive.${name}`);
    visiting.add(name);
    for (const dependency of [...(dependencies.get(name) ?? [])].sort()) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };
  for (const name of [...names].sort()) visit(name);
  return result;
}

function usesBusinessInput(expression: ActionRuleScalarExpressionV1, rule: ActionRuleSpecV1): boolean {
  switch (expression.kind) {
    case "input": return true;
    case "derived": return usesBusinessInput(rule.derive[expression.name]!, rule);
    case "math": return expression.inputs.some((input) => usesBusinessInput(input, rule));
    case "scale": return usesBusinessInput(expression.input, rule);
    case "clamp": return [expression.input, expression.minimum, expression.maximum].some((input) => usesBusinessInput(input, rule));
    case "add_duration": return usesBusinessInput(expression.timestamp, rule);
    default: return false;
  }
}

function assertFieldTypeMatches(
  declared: ActionRuleScalarTypeSpecV1,
  catalog: ActionRuleScalarTypeSpecV1,
  path: string,
): void {
  if (!exactTypes(declared, catalog)) fail("ACTION_RULE_TYPE_MISMATCH", `${path} does not match the inspected schema type.`, path);
}

function assertEnvelope(
  envelope: DerivedEffectEnvelopeSpecV1,
  rule: ActionRuleSpecV1,
  catalogResource: ActionRuleCatalogResourceV1,
  bindings: Map<string, CompiledRuleBindingV1>,
  context: CompileContext,
): Record<string, ActionRuleScalarTypeSpecV1> {
  if (rule.effect.operation !== envelope.operation || rule.effect.target_resource !== envelope.target_resource) {
    fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "The Action Rule effect does not match its reviewed effect envelope.", "rule.effect");
  }
  if (catalogResource.source !== envelope.source || catalogResource.primary_key !== envelope.primary_key) {
    fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "The effect target no longer matches the inspected source identity.", "effect_envelope");
  }
  if ((envelope.tenant_key !== undefined && envelope.tenant_key !== catalogResource.tenant_key)
    || envelope.principal_scope_key !== catalogResource.principal_scope_key) {
    fail("ACTION_RULE_SCOPE_UNPROVEN", "The effect envelope trusted scope does not match the inspected target.", "effect_envelope");
  }
  const catalogFields = fieldMap(catalogResource);
  const allowed = new Map<string, DerivedEffectEnvelopeSpecV1["allowed_fields"][number]>();
  for (const field of envelope.allowed_fields) {
    if (allowed.has(field.name)) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Effect field ${field.name} is duplicated.`);
    const inspected = catalogFields.get(field.name);
    if (inspected === undefined) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Effect field ${catalogResource.name}.${field.name} is absent from the inspected catalog.`);
    assertFieldTypeMatches(field.type, inspected.type, `effect_envelope.allowed_fields.${field.name}`);
    assertEffectFieldConstraint(field, `effect_envelope.allowed_fields.${field.name}`);
    if ([envelope.primary_key, envelope.tenant_key, envelope.principal_scope_key, envelope.conflict_key, envelope.version_advance?.column].includes(field.name)) {
      fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Guard field ${field.name} cannot be a freely derived write field.`, `effect_envelope.allowed_fields.${field.name}`);
    }
    allowed.set(field.name, field);
  }
  const setEntries = Object.entries(rule.effect.set);
  if (setEntries.length === 0) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "A derived effect must set at least one reviewed field.", "rule.effect.set");
  const result: Record<string, ActionRuleScalarTypeSpecV1> = {};
  for (const [name, expression] of setEntries) {
    const field = allowed.get(name);
    if (field === undefined) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Rule attempts to set ${name} outside the effect envelope.`, `rule.effect.set.${name}`);
    const inferred = inferScalar(expression, context, `rule.effect.set.${name}`);
    if (!compatibleTypes(inferred.type, field.type)) fail("ACTION_RULE_TYPE_MISMATCH", `Derived value for ${name} has the wrong type or unit.`, `rule.effect.set.${name}`);
    if (inferred.nullable) fail("ACTION_RULE_TYPE_MISMATCH", `Derived value for ${name} can be null or unknown.`, `rule.effect.set.${name}`);
    result[name] = field.type;
  }
  if (envelope.operation === "update") {
    if (rule.effect.target_binding !== envelope.target_binding || envelope.target_binding === undefined) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived UPDATE must target the one reviewed subject binding.", "rule.effect.target_binding");
    const target = bindings.get(envelope.target_binding);
    if (target === undefined || target.resource.name !== envelope.target_resource || target.verification.cardinality !== "one") fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived UPDATE target binding is not one exact verified row.");
    if (envelope.conflict_key === undefined || catalogResource.version_field !== envelope.conflict_key) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived UPDATE requires the inspected version field as conflict guard.");
    requireVerificationField(target, envelope.primary_key, "row identity");
    requireVerificationField(target, envelope.conflict_key, "conflict detection");
  } else {
    if (envelope.target_binding !== undefined || rule.effect.target_binding !== undefined) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived INSERT cannot target an existing row binding.");
    if (envelope.deduplication === undefined || envelope.deduplication.components.length === 0) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived INSERT requires source-enforced deduplication.");
  }
  if (!envelope.approval_classes.includes(rule.approval_class)) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Approval class ${rule.approval_class} is outside the effect envelope.`);
  return result;
}

export function compileActionRule(input: CompileActionRuleInput): CompiledActionRuleV1 {
  const catalog = normalizeActionRuleCatalog(input.catalog);
  const rule = normalizeActionRule(input.rule);
  const boundary = normalizeVerificationBoundary(input.verification_boundary);
  const envelope = normalizeDerivedEffectEnvelope(input.effect_envelope);
  if (catalog.schema_version !== "synapsor.action-rule-catalog.v1") fail("ACTION_RULE_INVALID", "Unsupported Action Rule catalog version.");
  if (rule.schema_version !== "synapsor.action-rule.v1" || boundary.schema_version !== "synapsor.verification-boundary.v1" || envelope.schema_version !== "synapsor.derived-effect-envelope.v1") fail("ACTION_RULE_INVALID", "Unsupported Action Rule authority version.");
  if (!Number.isSafeInteger(rule.ttl_seconds) || rule.ttl_seconds < 15 || rule.ttl_seconds > 3_600) fail("ACTION_RULE_INVALID", "Action Rule ttl_seconds must be from 15 through 3600.", "rule.ttl_seconds");
  if (boundary.transaction.timezone !== "UTC"
    || !["read_committed", "repeatable_read", "serializable"].includes(boundary.transaction.isolation)) {
    fail("ACTION_RULE_INVALID", "Verification transaction posture must freeze a supported isolation level and UTC.", "verification_boundary.transaction");
  }
  if (envelope.max_rows !== 1
    || !["update", "insert"].includes(envelope.operation)
    || !["none", "direct_sql"].includes(envelope.writeback.mode)
    || !["disabled", "allowed"].includes(envelope.writeback.supervised_worker)
    || (envelope.writeback.mode === "none" && envelope.writeback.supervised_worker !== "disabled")) {
    fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Derived effect operation, row bound, or writeback posture is invalid.", "effect_envelope");
  }
  if (!SAFE_QUALIFIED_NAME.test(rule.outcome) || !SAFE_QUALIFIED_NAME.test(rule.name) || !SAFE_IDENTIFIER.test(rule.context) || !SAFE_IDENTIFIER.test(rule.source)) fail("ACTION_RULE_INVALID", "Action Rule names and outcome must be fixed reviewed identifiers.");
  if (rule.verification_boundary_ref !== boundary.name || rule.effect_envelope_ref !== envelope.name) fail("ACTION_RULE_INVALID", "Action Rule authority references do not match the supplied reviewed objects.");
  if (rule.source !== boundary.source || rule.source !== envelope.source || rule.context !== boundary.context) fail("ACTION_RULE_INVALID", "Action Rule source or trusted context differs across its authority objects.");
  if (boundary.generation_lock_fingerprint !== catalog.generation_lock_fingerprint) fail("ACTION_RULE_AUTHORITY_STALE", "The Verification Boundary generation lock does not match the inspected catalog.");

  const catalogResources = uniqueByName(catalog.resources, "Catalog resource");
  const relationships = uniqueByName(catalog.relationships, "Catalog relationship");
  const bindings = new Map<string, CompiledRuleBindingV1>();
  for (const verification of boundary.resources) {
    if (bindings.has(verification.binding)) fail("ACTION_RULE_INVALID", `Verification binding ${verification.binding} is duplicated.`);
    const resource = catalogResources.get(verification.resource);
    if (resource === undefined || resource.source !== boundary.source) fail("ACTION_RULE_INVALID", `Verification resource ${verification.resource} is not in source ${boundary.source}.`);
    if (verification.primary_key !== resource.primary_key || verification.version_field !== resource.version_field) fail("ACTION_RULE_AUTHORITY_STALE", `Verification identity for ${resource.name} no longer matches the inspected catalog.`);
    if (verification.cardinality === "one" && verification.max_rows !== 1) fail("ACTION_RULE_UNBOUNDED", `One-row binding ${verification.binding} must have max_rows 1.`);
    if (verification.cardinality === "many" && (verification.max_rows < 1 || verification.max_rows > 100)) fail("ACTION_RULE_UNBOUNDED", `Many-row binding ${verification.binding} must be bounded to 1 through 100 rows.`);
    const inspectedFields = fieldMap(resource);
    for (const field of verification.fields) {
      const inspected = inspectedFields.get(field.name);
      if (inspected === undefined) fail("ACTION_RULE_AUTHORITY_STALE", `Verification field ${resource.name}.${field.name} is absent from the inspected catalog.`);
      assertFieldTypeMatches(field.type, inspected.type, `verification_boundary.resources.${verification.binding}.fields.${field.name}`);
      if ((field.nullable ?? false) !== inspected.nullable) fail("ACTION_RULE_AUTHORITY_STALE", `Nullability changed for ${resource.name}.${field.name}.`);
    }
    bindings.set(verification.binding, { binding: verification.binding, resource, verification });
  }

  for (const binding of bindings.values()) {
    const relationship = resolveRelationship(binding.verification, binding, bindings, relationships);
    if (relationship !== undefined) binding.relationship = relationship;
    assertScope(binding, bindings);
    requireVerificationField(binding, binding.resource.primary_key, "dependency identity");
    if (binding.resource.version_field !== undefined) requireVerificationField(binding, binding.resource.version_field, "dependency freshness");
    if (binding.relationship !== undefined && binding.verification.source.kind === "relationship") {
      const parent = bindings.get(binding.verification.source.from_binding)!;
      if (binding.verification.source.direction === "forward") {
        requireVerificationField(parent, binding.relationship.local_field, "relationship verification");
        requireVerificationField(binding, binding.relationship.target_field, "relationship verification");
      } else {
        requireVerificationField(parent, binding.relationship.target_field, "relationship verification");
        requireVerificationField(binding, binding.relationship.local_field, "relationship verification");
      }
    }
    if (binding.verification.cardinality === "many") {
      const order = binding.verification.deterministic_order;
      if (order === undefined || order.length === 0 || !order.some((entry) => entry.field === binding.resource.primary_key)) {
        fail("ACTION_RULE_UNBOUNDED", `Many-row binding ${binding.binding} requires deterministic ordering with its primary key as a tie-breaker.`, `verification_boundary.resources.${binding.binding}.deterministic_order`);
      }
      for (const item of order) requireVerificationField(binding, item.field, "deterministic bounded loading");
    }
  }

  const lockOrder = boundary.lock_order;
  if (lockOrder.length !== bindings.size || new Set(lockOrder).size !== lockOrder.length || lockOrder.some((name) => !bindings.has(name))) fail("ACTION_RULE_UNBOUNDED", "Verification lock_order must contain every binding exactly once.", "verification_boundary.lock_order");
  const lockIndex = new Map(lockOrder.map((name, index) => [name, index]));
  for (const binding of bindings.values()) {
    if (binding.verification.source.kind === "relationship" && (lockIndex.get(binding.verification.source.from_binding) ?? Infinity) >= (lockIndex.get(binding.binding) ?? -1)) {
      fail("ACTION_RULE_UNBOUNDED", `Lock parent ${binding.verification.source.from_binding} must precede ${binding.binding}.`, "verification_boundary.lock_order");
    }
  }
  assertAuthorityScope(envelope, bindings);

  const subjects = new Map(rule.subjects.map((subject) => [subject.binding, subject]));
  if (subjects.size !== rule.subjects.length) fail("ACTION_RULE_INVALID", "Action Rule subject bindings must be unique.");
  for (const binding of bindings.values()) {
    if (binding.verification.source.kind !== "subject_ref") continue;
    const subject = subjects.get(binding.binding);
    if (subject === undefined || subject.resource !== binding.resource.name || subject.input !== "opaque_subject_ref") fail("ACTION_RULE_INVALID", `Subject binding ${binding.binding} must use one opaque reference for ${binding.resource.name}.`);
  }
  for (const subject of rule.subjects) {
    const binding = bindings.get(subject.binding);
    if (binding === undefined || binding.verification.source.kind !== "subject_ref") fail("ACTION_RULE_INVALID", `Subject ${subject.binding} has no matching Verification Boundary root.`);
  }

  const context: CompileContext = { bindings, derivedTypes: new Map(), inputs: new Map((rule.inputs ?? []).map((value) => [value.name, value.type])) };
  inferBoolean(rule.require, context, "rule.require");
  const order = derivationOrder(rule);
  for (const name of order) {
    const inferred = inferScalar(rule.derive[name]!, context, `rule.derive.${name}`);
    if (inferred.nullable) fail("ACTION_RULE_TYPE_MISMATCH", `Derived effect value ${name} can be null or unknown.`, `rule.derive.${name}`);
    context.derivedTypes.set(name, inferred.type);
  }

  const targetResource = catalogResources.get(envelope.target_resource);
  if (targetResource === undefined) fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Effect target ${envelope.target_resource} is not in the inspected catalog.`);
  const effectFieldTypes = assertEnvelope(envelope, rule, targetResource, bindings, context);
  for (const relationship of catalog.relationships) {
    if (relationship.from_resource !== targetResource.name) continue;
    const expression = rule.effect.set[relationship.local_field];
    if (expression && usesBusinessInput(expression, rule)) {
      fail("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Relationship identity ${relationship.local_field} must come from a verified subject or fact, not a business input.`, `rule.effect.set.${relationship.local_field}`);
    }
  }
  const ruleDigest = actionRuleDigest(rule);
  const boundaryDigest = verificationBoundaryDigest(boundary);
  const envelopeDigest = effectEnvelopeDigest(envelope);
  const schemaLockDigest = canonicalJsonDigest(catalog);
  const bindingList = [...bindings.values()].sort((left, right) => left.binding.localeCompare(right.binding));
  const derivedTypes = Object.fromEntries([...context.derivedTypes.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const compiledPlanDigest = canonicalJsonDigest({
    compiler_version: ACTION_RULE_COMPILER_VERSION,
    rule_digest: ruleDigest,
    verification_boundary_digest: boundaryDigest,
    effect_envelope_digest: envelopeDigest,
    schema_lock_digest: schemaLockDigest,
    target_resource: targetResource,
    bindings: bindingList,
    derivation_order: order,
    derived_types: derivedTypes,
    effect_field_types: effectFieldTypes,
  });
  return {
    schema_version: COMPILED_ACTION_RULE_VERSION,
    compiler_version: ACTION_RULE_COMPILER_VERSION,
    name: rule.name,
    outcome: rule.outcome,
    context: rule.context,
    source: rule.source,
    rule_digest: ruleDigest,
    verification_boundary_digest: boundaryDigest,
    effect_envelope_digest: envelopeDigest,
    compiled_plan_digest: compiledPlanDigest,
    schema_lock_digest: schemaLockDigest,
    generation_lock_fingerprint: catalog.generation_lock_fingerprint,
    rule,
    verification_boundary: boundary,
    effect_envelope: envelope,
    target_resource: targetResource,
    bindings: bindingList,
    derivation_order: order,
    derived_types: derivedTypes,
    effect_field_types: Object.fromEntries(Object.entries(effectFieldTypes).sort(([left], [right]) => left.localeCompare(right))),
    approval_class: rule.approval_class,
    ttl_seconds: rule.ttl_seconds,
    uses: 1,
  };
}
