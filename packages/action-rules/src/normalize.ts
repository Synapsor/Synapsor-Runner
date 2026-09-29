import { actionRuleStringMatches, actionRuleStringMinimumValid } from "@synapsor/spec";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "@synapsor-runner/protocol";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarExpressionV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import type {
  ActionRuleCatalogV1,
  CompiledActionRuleV1,
} from "./types.js";
import { ActionRuleError } from "./errors.js";
import { ACTION_RULE_MATH_OPERATIONS, ACTION_RULE_MATH_MIN_INPUTS, ACTION_RULE_MATH_MAX_INPUTS } from "./expression-contract.js";
import { validateActionRuleInputDefinitions } from "./inputs.js";
import { actionRuleRelationshipPairs } from "./relationships.js";

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

const EXTENSION_KEY = /^x-(?:cloud|experimental|runner)-/u;
const SCALAR_TYPE_KEYS = {
  boolean: new Set(["kind"]),
  integer: new Set(["kind", "unit"]),
  money_minor: new Set(["kind", "currency"]),
  string: new Set(["kind", "max_length", "min_length", "enum", "comparison"]),
  date: new Set(["kind"]),
  timestamp: new Set(["kind"]),
} as const;
const SCALAR_EXPRESSION_KEYS = {
  input: new Set(["kind", "name"]),
  literal: new Set(["kind", "value", "value_type"]),
  trusted: new Set(["kind", "binding"]),
  field: new Set(["kind", "binding", "field"]),
  derived: new Set(["kind", "name"]),
  aggregate: new Set(["kind", "operation", "binding", "field", "where"]),
  math: new Set(["kind", "operation", "inputs"]),
  scale: new Set(["kind", "operation", "input", "constant", "rounding"]),
  clamp: new Set(["kind", "input", "minimum", "maximum"]),
  add_duration: new Set(["kind", "timestamp", "seconds"]),
  date_of: new Set(["kind", "timestamp", "timezone"]),
} as const;
const BOOLEAN_EXPRESSION_KEYS = {
  all: new Set(["kind", "expressions"]),
  any: new Set(["kind", "expressions"]),
  not: new Set(["kind", "expression"]),
  compare: new Set(["kind", "operator", "left", "right"]),
  null_check: new Set(["kind", "operator", "value"]),
  in: new Set(["kind", "value", "values"]),
  exists: new Set(["kind", "binding", "where"]),
} as const;

function invalid(path: string, message: string): never {
  throw new ActionRuleError("ACTION_RULE_INVALID", message, path);
}

function canonicalCloneAt<T>(value: T, path: string): T {
  try {
    return canonicalClone(value);
  } catch (error) {
    if (error instanceof ActionRuleError) throw error;
    invalid(path, `${path} must be one finite canonical JSON value.`);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(path, `${path} must contain from ${minimum} through ${maximum} items.`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(path, `${path} must be a non-empty string.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, `${path} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key) && !EXTENSION_KEY.test(key));
  if (unexpected !== undefined) {
    invalid(`${path}.${unexpected}`, `${path} contains unsupported field ${unexpected}.`);
  }
}

function own(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    invalid(`${path}.${key}`, `${path}.${key} is required.`);
  }
  return value[key];
}

function assertScalarTypeShape(value: unknown, path: string): void {
  const type = record(value, path);
  const kind = oneOf(type.kind, ["boolean", "integer", "money_minor", "string", "date", "timestamp"] as const, `${path}.kind`);
  onlyKeys(type, SCALAR_TYPE_KEYS[kind], path);
  if (kind === "integer" && type.unit !== undefined) string(type.unit, `${path}.unit`);
  if (kind === "money_minor") string(own(type, "currency", path), `${path}.currency`);
  if (kind === "string") {
    const maximum = own(type, "max_length", path);
    if (!Number.isSafeInteger(maximum) || Number(maximum) < 1) {
      invalid(`${path}.max_length`, `${path}.max_length must be a positive safe integer.`);
    }
    if (!actionRuleStringMinimumValid({max_length:maximum,min_length:type.min_length})) invalid(`${path}.min_length`, "min_length must be a nonnegative safe integer no greater than max_length (UTF-16 units).");
    if (type.enum !== undefined) {
      array(type.enum, `${path}.enum`, 1, 256).forEach((item, index) => {
        if (type.min_length === undefined && item === "") invalid(`${path}.enum[${index}]`, "Legacy enum values must be non-empty strings.");
        if (!actionRuleStringMatches(item,{max_length:Number(maximum),min_length:type.min_length as number | undefined})) invalid(`${path}.enum[${index}]`, "Enum values must fit the reviewed UTF-16 text bounds.");
      });
    }
    oneOf(own(type, "comparison", path), ["exact"] as const, `${path}.comparison`);
  }
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right));
}

function normalizeScalarExpression(
  expression: ActionRuleScalarExpressionV1,
  path = "action_rule.scalar_expression",
  depth = 0,
): ActionRuleScalarExpressionV1 {
  if (depth > 24) invalid(path, "Action Rule expressions may be at most 24 levels deep.");
  const normalized = canonicalCloneAt(expression, path);
  const raw = record(normalized, path);
  switch (normalized.kind) {
    case "input":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.input, path);
      string(normalized.name, `${path}.name`);
      return normalized;
    case "literal":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.literal, path);
      own(raw, "value", path);
      assertScalarTypeShape(own(raw, "value_type", path), `${path}.value_type`);
      return normalized;
    case "trusted":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.trusted, path);
      oneOf(normalized.binding, ["tenant", "organization", "principal", "transaction_time"] as const, `${path}.binding`);
      return normalized;
    case "field":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.field, path);
      string(normalized.binding, `${path}.binding`);
      string(normalized.field, `${path}.field`);
      return normalized;
    case "derived":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.derived, path);
      string(normalized.name, `${path}.name`);
      return normalized;
    case "aggregate":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.aggregate, path);
      oneOf(normalized.operation, ["count", "sum", "min", "max"] as const, `${path}.operation`);
      string(normalized.binding, `${path}.binding`);
      if (normalized.operation !== "count" || normalized.field !== undefined) string(normalized.field, `${path}.field`);
      if (normalized.where !== undefined) normalized.where = normalizeActionRuleBooleanExpression(normalized.where, `${path}.where`, depth + 1);
      return normalized;
    case "math":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.math, path);
      oneOf(normalized.operation, ACTION_RULE_MATH_OPERATIONS, `${path}.operation`);
      normalized.inputs = array(normalized.inputs, `${path}.inputs`, ACTION_RULE_MATH_MIN_INPUTS, ACTION_RULE_MATH_MAX_INPUTS)
        .map((input, index) => normalizeScalarExpression(
          input as ActionRuleScalarExpressionV1,
          `${path}.inputs[${index}]`,
          depth + 1,
        ));
      if (normalized.operation === "add" || normalized.operation === "min" || normalized.operation === "max") {
        normalized.inputs.sort(compareCanonical);
      }
      return normalized;
    case "scale":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.scale, path);
      oneOf(normalized.operation, ["multiply", "divide"] as const, `${path}.operation`);
      if (!Number.isSafeInteger(normalized.constant) || normalized.constant === 0) {
        invalid(`${path}.constant`, `${path}.constant must be a non-zero safe integer.`);
      }
      oneOf(normalized.rounding, ["floor", "ceiling", "half_even"] as const, `${path}.rounding`);
      normalized.input = normalizeScalarExpression(normalized.input, `${path}.input`, depth + 1);
      return normalized;
    case "clamp":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.clamp, path);
      normalized.input = normalizeScalarExpression(normalized.input, `${path}.input`, depth + 1);
      normalized.minimum = normalizeScalarExpression(normalized.minimum, `${path}.minimum`, depth + 1);
      normalized.maximum = normalizeScalarExpression(normalized.maximum, `${path}.maximum`, depth + 1);
      return normalized;
    case "date_of":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.date_of, path);
      oneOf(normalized.timezone, ["UTC"] as const, `${path}.timezone`);
      normalized.timestamp = normalizeScalarExpression(normalized.timestamp, `${path}.timestamp`, depth + 1);
      return normalized;
    case "add_duration":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.add_duration, path);
      if (!Number.isSafeInteger(normalized.seconds)
        || normalized.seconds < -31_536_000
        || normalized.seconds > 31_536_000) {
        invalid(`${path}.seconds`, `${path}.seconds must be a safe whole-second value within one year.`);
      }
      normalized.timestamp = normalizeScalarExpression(normalized.timestamp, `${path}.timestamp`, depth + 1);
      return normalized;
    default:
      // Do not echo an arbitrary submitted discriminator (it may contain private
      // input), convert aliases, or infer the intended operation or operands.
      throw new ActionRuleError("ACTION_RULE_EXPRESSION_KIND_INVALID", "The generated scalar expression has an invalid node kind. Use an advertised scalar expression; arithmetic operations belong inside kind=math, not in kind itself.", `${path}.kind`);
  }
}

export function normalizeActionRuleBooleanExpression(
  expression: ActionRuleBooleanExpressionV1,
  path = "action_rule.boolean_expression",
  depth = 0,
): ActionRuleBooleanExpressionV1 {
  if (depth > 24) invalid(path, "Action Rule expressions may be at most 24 levels deep.");
  const normalized = canonicalCloneAt(expression, path);
  const raw = record(normalized, path);
  switch (normalized.kind) {
    case "all":
    case "any": {
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS[normalized.kind], path);
      normalized.expressions = array(normalized.expressions, `${path}.expressions`, 1, 32)
        .map((item, index) => normalizeActionRuleBooleanExpression(
          item as ActionRuleBooleanExpressionV1,
          `${path}.expressions[${index}]`,
          depth + 1,
        ))
        .sort(compareCanonical);
      return normalized;
    }
    case "not":
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS.not, path);
      normalized.expression = normalizeActionRuleBooleanExpression(normalized.expression, `${path}.expression`, depth + 1);
      return normalized;
    case "compare":
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS.compare, path);
      oneOf(normalized.operator, ["eq", "neq", "lt", "lte", "gt", "gte"] as const, `${path}.operator`);
      normalized.left = normalizeScalarExpression(normalized.left, `${path}.left`, depth + 1);
      normalized.right = normalizeScalarExpression(normalized.right, `${path}.right`, depth + 1);
      return normalized;
    case "null_check":
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS.null_check, path);
      oneOf(normalized.operator, ["is_null", "is_not_null"] as const, `${path}.operator`);
      normalized.value = normalizeScalarExpression(normalized.value, `${path}.value`, depth + 1);
      return normalized;
    case "in":
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS.in, path);
      normalized.value = normalizeScalarExpression(normalized.value, `${path}.value`, depth + 1);
      normalized.values = array(normalized.values, `${path}.values`, 1, 256)
        .map((item, index) => normalizeScalarExpression(
          item as ActionRuleScalarExpressionV1,
          `${path}.values[${index}]`,
          depth + 1,
        ))
        .sort(compareCanonical);
      return normalized;
    case "exists":
      onlyKeys(raw, BOOLEAN_EXPRESSION_KEYS.exists, path);
      string(normalized.binding, `${path}.binding`);
      normalized.where = normalizeActionRuleBooleanExpression(normalized.where, `${path}.where`, depth + 1);
      return normalized;
    default:
      invalid(`${path}.kind`, `Action Rule boolean expression kind ${String(raw.kind)} is unsupported.`);
  }
}

export function normalizeActionRuleCatalog(catalog: ActionRuleCatalogV1): ActionRuleCatalogV1 {
  const normalized = canonicalClone(catalog);
  for (const [index, resource] of normalized.resources.entries()) {
    if (resource.verification_only !== undefined && resource.verification_only !== true) {
      invalid(`catalog.resources.${index}.verification_only`, "Verification-only purpose must be true or absent.");
    }
  }
  normalized.relationships.forEach(actionRuleRelationshipPairs);
  normalized.resources = normalized.resources
    .map((resource) => ({
      ...resource,
      fields: [...resource.fields].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  normalized.relationships = [...normalized.relationships]
    .sort((left, right) => left.name.localeCompare(right.name));
  return canonicalClone(normalized);
}

export function normalizeVerificationBoundary(
  boundary: RuleVerificationBoundarySpecV1,
): RuleVerificationBoundarySpecV1 {
  const normalized = canonicalClone(boundary);
  for (const resource of normalized.resources) {
    if (resource.source.kind === "relationship") actionRuleRelationshipPairs(resource.source);
  }
  normalized.resources = normalized.resources
    .map((resource) => ({
      ...resource,
      fields: [...resource.fields].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.binding.localeCompare(right.binding));
  return canonicalClone(normalized);
}

export function normalizeDerivedEffectEnvelope(
  envelope: DerivedEffectEnvelopeSpecV1,
): DerivedEffectEnvelopeSpecV1 {
  const normalized = canonicalClone(envelope);
  normalized.allowed_fields = [...normalized.allowed_fields]
    .map((field) => ({
      ...field,
      ...(field.values === undefined ? {} : { values: [...field.values].sort(compareCanonical) }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  normalized.approval_classes = [...normalized.approval_classes].sort();
  if (normalized.deduplication !== undefined) {
    normalized.deduplication.components = [...normalized.deduplication.components]
      .sort((left, right) => left.column.localeCompare(right.column));
  }
  if (normalized.atomic_updates !== undefined) {
    array(normalized.atomic_updates, "effect_envelope.atomic_updates", 1, 3);
    normalized.atomic_updates = normalized.atomic_updates.map((update, index) => {
      const raw = record(update, `effect_envelope.atomic_updates.${index}`);
      const allowed = new Set(["operation", "target_resource", "target_binding", "primary_key", "tenant_key",
        "organization_scope", "principal_scope_key", "conflict_key", "max_rows", "allowed_fields", "version_advance"]);
      if (Object.keys(raw).some(key => !allowed.has(key))) invalid(`effect_envelope.atomic_updates.${index}`, "Atomic update contains unsupported fields.");
      array(update.allowed_fields, `effect_envelope.atomic_updates.${index}.allowed_fields`, 1, 64);
      return { ...update, allowed_fields: update.allowed_fields.map(field => ({ ...field,
        ...(field.values === undefined ? {} : { values: [...field.values].sort(compareCanonical) }),
      })).sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }
  return canonicalClone(normalized);
}

export function normalizeActionRule(rule: ActionRuleSpecV1): ActionRuleSpecV1 {
  const normalized = canonicalCloneAt(rule, "rule");
  const raw = record(normalized, "rule");
  array(normalized.subjects, "rule.subjects", 1, 8);
  record(normalized.derive, "rule.derive");
  record(normalized.effect, "rule.effect");
  record(normalized.effect.set, "rule.effect.set");
  own(raw, "require", "rule");
  if (normalized.inputs !== undefined) {
    validateActionRuleInputDefinitions(normalized.inputs);
    for (const input of normalized.inputs) assertScalarTypeShape(input.type, `rule.inputs.${input.name}.type`);
    normalized.inputs.sort((a, b) => a.name.localeCompare(b.name));
  }
  normalized.subjects = [...normalized.subjects]
    .sort((left, right) => left.binding.localeCompare(right.binding));
  normalized.require = normalizeActionRuleBooleanExpression(normalized.require, "rule.require");
  normalized.derive = Object.fromEntries(
    Object.entries(normalized.derive)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, expression]) => [name, normalizeScalarExpression(expression, `rule.derive.${name}`)]),
  );
  normalized.effect.set = Object.fromEntries(
    Object.entries(normalized.effect.set)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, expression]) => [name, normalizeScalarExpression(expression, `rule.effect.set.${name}`)]),
  );
  if (normalized.atomic_updates !== undefined) {
    array(normalized.atomic_updates, "rule.atomic_updates", 1, 3);
    normalized.atomic_updates = normalized.atomic_updates.map((update, index) => {
      const raw = record(update, `rule.atomic_updates.${index}`);
      if (Object.keys(raw).some(key => !["operation", "target_resource", "target_binding", "set"].includes(key))) {
        invalid(`rule.atomic_updates.${index}`, "Atomic update contains unsupported fields.");
      }
      record(update.set, `rule.atomic_updates.${index}.set`);
      return { ...update, set: Object.fromEntries(Object.entries(update.set).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, expression]) => [name, normalizeScalarExpression(expression, `rule.atomic_updates.${index}.set.${name}`)])) };
    });
  }
  return canonicalClone(normalized);
}

export function verificationBoundaryDigest(
  boundary: RuleVerificationBoundarySpecV1,
): `sha256:${string}` {
  return canonicalJsonDigest(normalizeVerificationBoundary(boundary));
}

export function effectEnvelopeDigest(
  envelope: DerivedEffectEnvelopeSpecV1,
): `sha256:${string}` {
  return canonicalJsonDigest(normalizeDerivedEffectEnvelope(envelope));
}

export function actionRuleDigest(rule: ActionRuleSpecV1): `sha256:${string}` {
  return canonicalJsonDigest(normalizeActionRule(rule));
}

export function compiledActionRuleDigest(rule: CompiledActionRuleV1): `sha256:${string}` {
  return canonicalJsonDigest(rule);
}
