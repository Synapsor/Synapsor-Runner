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

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

const EXTENSION_KEY = /^x-(?:cloud|experimental|runner)-/u;
const SCALAR_TYPE_KEYS = {
  boolean: new Set(["kind"]),
  integer: new Set(["kind", "unit"]),
  money_minor: new Set(["kind", "currency"]),
  string: new Set(["kind", "max_length", "enum", "comparison"]),
  date: new Set(["kind"]),
  timestamp: new Set(["kind"]),
} as const;
const SCALAR_EXPRESSION_KEYS = {
  literal: new Set(["kind", "value", "value_type"]),
  trusted: new Set(["kind", "binding"]),
  field: new Set(["kind", "binding", "field"]),
  derived: new Set(["kind", "name"]),
  aggregate: new Set(["kind", "operation", "binding", "field"]),
  math: new Set(["kind", "operation", "inputs"]),
  scale: new Set(["kind", "operation", "input", "constant", "rounding"]),
  clamp: new Set(["kind", "input", "minimum", "maximum"]),
  add_duration: new Set(["kind", "timestamp", "seconds"]),
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
    if (type.enum !== undefined) {
      array(type.enum, `${path}.enum`, 1, 256).forEach((item, index) => string(item, `${path}.enum[${index}]`));
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
      if (normalized.operation !== "count") string(normalized.field, `${path}.field`);
      return normalized;
    case "math":
      onlyKeys(raw, SCALAR_EXPRESSION_KEYS.math, path);
      oneOf(normalized.operation, ["add", "subtract", "min", "max"] as const, `${path}.operation`);
      normalized.inputs = array(normalized.inputs, `${path}.inputs`, 2, 16)
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
      invalid(`${path}.kind`, `Action Rule scalar expression kind ${String(raw.kind)} is unsupported.`);
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
