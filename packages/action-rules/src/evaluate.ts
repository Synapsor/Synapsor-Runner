import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarExpressionV1,
  ActionRuleScalarTypeSpecV1,
  JsonScalar,
} from "@synapsor/spec";
import { ActionRuleError } from "./errors.js";
import { validateActionRuleInputs } from "./inputs.js";
import { actionRuleRelationshipPairs } from "./relationships.js";
import { actionRuleEffectEnvelopes, actionRuleEffects, assertAtomicUpdateShape } from "./atomic-updates.js";
import {
  actionRuleDigest,
  effectEnvelopeDigest,
  verificationBoundaryDigest,
} from "./normalize.js";
import {
  ACTION_RULE_COMPILER_VERSION,
  COMPILED_ACTION_RULE_VERSION,
  type ActionRuleDependencyV1,
  type ActionRuleApprovalPredicateEvaluationV1,
  type ActionRuleEvaluationV1,
  type ActionRuleFactRowV1,
  type ActionRuleFactSetV1,
  type CompiledActionRuleV1,
  type DerivedActionEffectV1,
  type EvaluateActionRuleInputV1,
} from "./types.js";

type KnownScalar = {
  known: true;
  value: JsonScalar;
  type: ActionRuleScalarTypeSpecV1;
};
type UnknownScalar = { known: false; reason: string };
type ScalarResult = KnownScalar | UnknownScalar;
type Truth = true | false | "unknown";

type EvaluationContext = {
  inputs: Record<string, JsonScalar>;
  compiled: CompiledActionRuleV1;
  facts: ActionRuleFactSetV1;
  rows: Record<string, ActionRuleFactRowV1[]>;
  derived: Map<string, KnownScalar>;
  currentRows: Map<string, ActionRuleFactRowV1>;
};

function unknownScalar(reason: string): UnknownScalar {
  return { known: false, reason };
}

function safeDigest(value: unknown): `sha256:${string}` {
  try {
    return canonicalJsonDigest(value);
  } catch {
    return canonicalJsonDigest({ invalid_action_rule_fact_payload: true });
  }
}

function compiledPlanDigest(compiled: CompiledActionRuleV1): `sha256:${string}` {
  return canonicalJsonDigest({
    compiler_version: compiled.compiler_version,
    rule_digest: compiled.rule_digest,
    verification_boundary_digest: compiled.verification_boundary_digest,
    effect_envelope_digest: compiled.effect_envelope_digest,
    schema_lock_digest: compiled.schema_lock_digest,
    target_resource: compiled.target_resource,
    bindings: compiled.bindings,
    derivation_order: compiled.derivation_order,
    derived_types: compiled.derived_types,
    effect_field_types: compiled.effect_field_types,
    ...(compiled.atomic_updates === undefined ? {} : { atomic_updates: compiled.atomic_updates }),
  });
}

function assertCompiledIntegrity(compiled: CompiledActionRuleV1): void {
  if (compiled.schema_version !== COMPILED_ACTION_RULE_VERSION || compiled.compiler_version !== ACTION_RULE_COMPILER_VERSION) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Unsupported compiled Action Rule authority.");
  }
  if (compiled.rule_digest !== actionRuleDigest(compiled.rule)
    || compiled.verification_boundary_digest !== verificationBoundaryDigest(compiled.verification_boundary)
    || compiled.effect_envelope_digest !== effectEnvelopeDigest(compiled.effect_envelope)
    || compiled.compiled_plan_digest !== compiledPlanDigest(compiled)) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Compiled Action Rule authority failed its integrity check.");
  }
  if (compiled.rule.name !== compiled.name
    || compiled.rule.outcome !== compiled.outcome
    || compiled.rule.context !== compiled.context
    || compiled.rule.source !== compiled.source
    || compiled.rule.approval_class !== compiled.approval_class
    || compiled.rule.ttl_seconds !== compiled.ttl_seconds
    || compiled.uses !== 1) {
    throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Compiled Action Rule identity does not match its reviewed rule.");
  }
}

function fieldType(compiled: CompiledActionRuleV1, bindingName: string, fieldName: string): ActionRuleScalarTypeSpecV1 | undefined {
  return compiled.bindings
    .find((binding) => binding.binding === bindingName)
    ?.verification.fields.find((field) => field.name === fieldName)?.type;
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

function scalarMatchesType(value: JsonScalar, type: ActionRuleScalarTypeSpecV1, allowNull: boolean): boolean {
  if (value === null) return allowNull;
  switch (type.kind) {
    case "boolean": return typeof value === "boolean";
    case "integer":
    case "money_minor": return Number.isSafeInteger(value);
    case "string": return typeof value === "string" && value.length <= type.max_length && (type.enum === undefined || type.enum.includes(value));
    case "date": return typeof value === "string" && isCanonicalDate(value);
    case "timestamp": return typeof value === "string" && isCanonicalTimestamp(value);
  }
}

function compareScalars(left: JsonScalar, right: JsonScalar, type: ActionRuleScalarTypeSpecV1): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (type.kind === "timestamp" && typeof left === "string" && typeof right === "string") return Date.parse(left) - Date.parse(right);
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right));
}

function checkedInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new ActionRuleError("ACTION_RULE_ARITHMETIC_OVERFLOW", `Checked integer arithmetic overflowed at ${path}.`, path);
  }
  return value;
}

function roundedQuotient(value: number, divisor: number, mode: "floor" | "ceiling" | "half_even"): number {
  const quotient = value / divisor;
  if (mode === "floor") return Math.floor(quotient);
  if (mode === "ceiling") return Math.ceil(quotient);
  const lower = Math.floor(quotient);
  const fraction = quotient - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function scalar(
  expression: ActionRuleScalarExpressionV1,
  context: EvaluationContext,
  path: string,
): ScalarResult {
  switch (expression.kind) {
    case "input": {
      const definition = context.compiled.rule.inputs?.find((input) => input.name === expression.name);
      return definition && Object.hasOwn(context.inputs, expression.name)
        ? { known: true, value: context.inputs[expression.name]!, type: definition.type }
        : unknownScalar(`${path} business input is unavailable.`);
    }
    case "literal":
      return scalarMatchesType(expression.value, expression.value_type, true)
        ? { known: true, value: expression.value, type: expression.value_type }
        : unknownScalar(`${path} literal does not match its reviewed type.`);
    case "trusted": {
      if (expression.binding === "transaction_time") return { known: true, value: context.facts.trusted.transaction_time, type: { kind: "timestamp" } };
      const value = expression.binding === "tenant"
        ? context.facts.trusted.tenant
        : expression.binding === "organization"
          ? context.facts.trusted.organization_scope?.organization_id
          : context.facts.trusted.principal;
      if (value === undefined) return unknownScalar(`Trusted ${expression.binding} is unavailable.`);
      return { known: true, value, type: { kind: "string", max_length: 4096, comparison: "exact" } };
    }
    case "field": {
      const binding = context.compiled.bindings.find((item) => item.binding === expression.binding);
      const type = fieldType(context.compiled, expression.binding, expression.field);
      if (binding === undefined || type === undefined) return unknownScalar(`${path} references unavailable reviewed metadata.`);
      const row = context.currentRows.get(expression.binding)
        ?? (binding.verification.cardinality === "one" ? context.rows[expression.binding]?.[0] : undefined);
      if (row === undefined || !(expression.field in row)) return unknownScalar(`${path} fact is unavailable.`);
      const value = row[expression.field];
      if (value === undefined || !scalarMatchesType(value, type, true)) return unknownScalar(`${path} fact has an invalid type.`);
      return { known: true, value, type };
    }
    case "derived":
      return context.derived.get(expression.name) ?? unknownScalar(`${path} derived value is unavailable.`);
    case "aggregate": {
      const rows = context.rows[expression.binding];
      if (rows === undefined) return unknownScalar(`${path} binding is unavailable.`);
      if (expression.operation === "count") {
        const value = expression.field === undefined
          ? rows.length
          : rows.filter((row) => row[expression.field!] !== null && row[expression.field!] !== undefined).length;
        return { known: true, value, type: { kind: "integer", unit: "rows" } };
      }
      if (expression.field === undefined) return unknownScalar(`${path} aggregate field is unavailable.`);
      const type = fieldType(context.compiled, expression.binding, expression.field);
      if (type === undefined) return unknownScalar(`${path} aggregate field type is unavailable.`);
      const values = rows.map((row) => row[expression.field!]).filter((value): value is Exclude<JsonScalar, null> => value !== null && value !== undefined);
      if (values.length === 0 || values.some((value) => !scalarMatchesType(value, type, false))) return unknownScalar(`${path} has no complete bounded values.`);
      if (expression.operation === "sum") {
        let sum = 0;
        for (const value of values) {
          if (typeof value !== "number") return unknownScalar(`${path} sum contains a non-numeric value.`);
          sum = checkedInteger(sum + value, path);
        }
        return { known: true, value: sum, type };
      }
      let selected = values[0]!;
      for (const value of values.slice(1)) {
        const comparison = compareScalars(value, selected, type);
        if ((expression.operation === "min" && comparison < 0) || (expression.operation === "max" && comparison > 0)) selected = value;
      }
      return { known: true, value: selected, type };
    }
    case "math": {
      const values = expression.inputs.map((item, index) => scalar(item, context, `${path}.inputs[${index}]`));
      const unknown = values.find((value): value is UnknownScalar => !value.known);
      if (unknown !== undefined) return unknown;
      const known = values as KnownScalar[];
      if (known.some((value) => typeof value.value !== "number")) return unknownScalar(`${path} requires complete numeric values.`);
      const numbers = known.map((value) => value.value as number);
      let value = numbers[0]!;
      if (expression.operation === "add") {
        value = 0;
        for (const item of numbers) value = checkedInteger(value + item, path);
      } else if (expression.operation === "subtract") {
        for (const item of numbers.slice(1)) value = checkedInteger(value - item, path);
      } else if (expression.operation === "min") value = Math.min(...numbers);
      else value = Math.max(...numbers);
      return { known: true, value, type: known[0]!.type };
    }
    case "scale": {
      const input = scalar(expression.input, context, `${path}.input`);
      if (!input.known) return input;
      if (typeof input.value !== "number") return unknownScalar(`${path} requires a numeric value.`);
      const value = expression.operation === "multiply"
        ? checkedInteger(input.value * expression.constant, path)
        : checkedInteger(roundedQuotient(input.value, expression.constant, expression.rounding), path);
      return { known: true, value, type: input.type };
    }
    case "clamp": {
      const input = scalar(expression.input, context, `${path}.input`);
      const minimum = scalar(expression.minimum, context, `${path}.minimum`);
      const maximum = scalar(expression.maximum, context, `${path}.maximum`);
      if (!input.known) return input;
      if (!minimum.known) return minimum;
      if (!maximum.known) return maximum;
      if (typeof input.value !== "number" || typeof minimum.value !== "number" || typeof maximum.value !== "number" || minimum.value > maximum.value) return unknownScalar(`${path} has invalid numeric clamp values.`);
      return { known: true, value: Math.min(maximum.value, Math.max(minimum.value, input.value)), type: input.type };
    }
    case "add_duration": {
      const timestamp = scalar(expression.timestamp, context, `${path}.timestamp`);
      if (!timestamp.known) return timestamp;
      if (typeof timestamp.value !== "string" || !isCanonicalTimestamp(timestamp.value)) return unknownScalar(`${path} requires a canonical UTC timestamp.`);
      const next = Date.parse(timestamp.value) + expression.seconds * 1000;
      if (!Number.isSafeInteger(next)) throw new ActionRuleError("ACTION_RULE_ARITHMETIC_OVERFLOW", `Timestamp arithmetic overflowed at ${path}.`, path);
      return { known: true, value: new Date(next).toISOString(), type: { kind: "timestamp" } };
    }
  }
}

function truth(expression: ActionRuleBooleanExpressionV1, context: EvaluationContext, path: string): Truth {
  switch (expression.kind) {
    case "all": {
      const values = expression.expressions.map((item, index) => truth(item, context, `${path}.expressions[${index}]`));
      if (values.includes(false)) return false;
      return values.includes("unknown") ? "unknown" : true;
    }
    case "any": {
      const values = expression.expressions.map((item, index) => truth(item, context, `${path}.expressions[${index}]`));
      if (values.includes(true)) return true;
      return values.includes("unknown") ? "unknown" : false;
    }
    case "not": {
      const value = truth(expression.expression, context, `${path}.expression`);
      return value === "unknown" ? "unknown" : !value;
    }
    case "null_check": {
      const value = scalar(expression.value, context, `${path}.value`);
      if (!value.known) return "unknown";
      return expression.operator === "is_null" ? value.value === null : value.value !== null;
    }
    case "compare": {
      const left = scalar(expression.left, context, `${path}.left`);
      const right = scalar(expression.right, context, `${path}.right`);
      if (!left.known || !right.known || left.value === null || right.value === null) return "unknown";
      const comparison = compareScalars(left.value, right.value, left.type);
      switch (expression.operator) {
        case "eq": return comparison === 0;
        case "neq": return comparison !== 0;
        case "lt": return comparison < 0;
        case "lte": return comparison <= 0;
        case "gt": return comparison > 0;
        case "gte": return comparison >= 0;
      }
    }
    case "in": {
      const value = scalar(expression.value, context, `${path}.value`);
      const candidates = expression.values.map((item, index) => scalar(item, context, `${path}.values[${index}]`));
      if (!value.known || value.value === null) return "unknown";
      if (candidates.some((candidate) => candidate.known && candidate.value !== null && compareScalars(value.value, candidate.value, value.type) === 0)) return true;
      return candidates.some((candidate) => !candidate.known || candidate.value === null) ? "unknown" : false;
    }
    case "exists": {
      const rows = context.rows[expression.binding];
      if (rows === undefined) return "unknown";
      const values = rows.map((row, index) => {
        context.currentRows.set(expression.binding, row);
        try {
          return truth(expression.where, context, `${path}.where[${index}]`);
        } finally {
          context.currentRows.delete(expression.binding);
        }
      });
      if (values.includes(true)) return true;
      return values.includes("unknown") ? "unknown" : false;
    }
  }
}

function compareFactValues(left: JsonScalar, right: JsonScalar): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right));
}

function normalizeAndValidateFacts(compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1): {
  facts: ActionRuleFactSetV1;
  dependencies: ActionRuleDependencyV1[];
  pendingUnknown?: { code: string; reason: string };
} {
  const hasTenant = typeof facts.trusted?.tenant === "string";
  const organizationId = facts.trusted?.organization_scope?.organization_id;
  const hasOrganization = facts.trusted?.organization_scope?.mode === "single_organization" && typeof organizationId === "string";
  if (hasTenant === hasOrganization) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Exactly one trusted tenant or reviewed organization context is required.");
  if (hasTenant && (facts.trusted.tenant!.length === 0 || facts.trusted.tenant!.length > 4096)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Trusted tenant context is invalid.");
  if (hasOrganization && (organizationId!.length === 0 || organizationId!.length > 4096)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Reviewed organization context is invalid.");
  if (facts.trusted.principal !== undefined && (facts.trusted.principal.length === 0 || facts.trusted.principal.length > 4096)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Trusted principal context is invalid.");
  if (!isCanonicalTimestamp(facts.trusted.transaction_time)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Runner transaction time is not canonical UTC.");
  if (!/^sha256:[a-f0-9]{64}$/.test(facts.subject_provenance_digest)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Opaque subject provenance is unavailable.");
  const names = new Set(compiled.bindings.map((binding) => binding.binding));
  if (Object.keys(facts.bindings).some((name) => !names.has(name))) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Fact payload contains an unreviewed binding.");
  const normalizedBindings: ActionRuleFactSetV1["bindings"] = {};
  const dependencies: ActionRuleDependencyV1[] = [];
  let pendingUnknown: { code: string; reason: string } | undefined;
  const byName = new Map(compiled.bindings.map((binding) => [binding.binding, binding]));
  const orderedBindings = compiled.verification_boundary.lock_order.map((name) => byName.get(name)!);
  for (const binding of orderedBindings) {
    const supplied = facts.bindings[binding.binding];
    if (supplied === undefined || !Array.isArray(supplied.rows)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Facts for ${binding.binding} are unavailable.`);
    const allowed = new Map(binding.verification.fields.map((field) => [field.name, field]));
    const rows = supplied.rows.map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Facts for ${binding.binding} contain an invalid row.`);
      if (Object.keys(row).some((name) => !allowed.has(name))) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Facts for ${binding.binding} contain an unreviewed field.`);
      const output: ActionRuleFactRowV1 = {};
      for (const [name, field] of allowed) {
        if (!(name in row)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Required verification fact ${binding.binding}.${name} is unavailable.`);
        const value = row[name];
        if (value === undefined || !scalarMatchesType(value, field.type, field.nullable ?? false)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Verification fact ${binding.binding}.${name} has an invalid value.`);
        output[name] = value;
      }
      return output;
    });
    if (rows.length > binding.verification.max_rows) {
      pendingUnknown = binding.verification.overflow === "ineligible"
        ? { code: "ACTION_RULE_NOT_ELIGIBLE", reason: `Bounded verification for ${binding.binding} exceeded ${binding.verification.max_rows} rows.` }
        : { code: "ACTION_RULE_UNBOUNDED", reason: `Bounded verification for ${binding.binding} exceeded its reviewed limit.` };
      rows.length = binding.verification.max_rows;
    }
    if (binding.verification.cardinality === "one" && rows.length !== 1) pendingUnknown = { code: "ACTION_RULE_FACTS_UNKNOWN", reason: `Exactly one verified ${binding.binding} row was not available.` };
    const order = binding.verification.deterministic_order ?? [{ field: binding.verification.primary_key, direction: "asc" as const }];
    rows.sort((left, right) => {
      for (const item of order) {
        const comparison = compareFactValues(left[item.field]!, right[item.field]!);
        if (comparison !== 0) return item.direction === "asc" ? comparison : -comparison;
      }
      return 0;
    });
    const seenKeys = new Set<string>();
    for (const row of rows) {
      const primaryValue = row[binding.verification.primary_key];
      if (primaryValue === undefined || primaryValue === null) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Verified ${binding.binding} row has no primary key.`);
      const primaryToken = canonicalJsonStringify(primaryValue);
      if (seenKeys.has(primaryToken)) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Verified ${binding.binding} rows repeat one primary key.`);
      seenKeys.add(primaryToken);
      const versionColumn = binding.verification.version_field;
      const versionValue = versionColumn === undefined ? undefined : row[versionColumn];
      dependencies.push({
        binding: binding.binding,
        resource: binding.resource.name,
        primary_key: { column: binding.verification.primary_key, value: primaryValue },
        ...(versionColumn === undefined || versionValue === undefined
          ? {}
          : { version: { column: versionColumn, value: versionValue } }),
        row_digest: canonicalJsonDigest({ binding: binding.binding, resource: binding.resource.name, row }),
      });
    }
    normalizedBindings[binding.binding] = { rows };
  }
  const normalizedFacts: ActionRuleFactSetV1 = {
    bindings: normalizedBindings,
    trusted: {
      ...(facts.trusted.tenant === undefined
        ? { organization_scope: facts.trusted.organization_scope! }
        : { tenant: facts.trusted.tenant }),
      ...(facts.trusted.principal === undefined ? {} : { principal: facts.trusted.principal }),
      transaction_time: facts.trusted.transaction_time,
    },
    subject_provenance_digest: facts.subject_provenance_digest,
  };
  dependencies.sort((left, right) => {
    const binding = left.binding.localeCompare(right.binding);
    return binding !== 0
      ? binding
      : canonicalJsonStringify(left.primary_key.value).localeCompare(canonicalJsonStringify(right.primary_key.value));
  });
  return { facts: normalizedFacts, dependencies, ...(pendingUnknown === undefined ? {} : { pendingUnknown }) };
}

function validateScopeAndRelationships(compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1): string | undefined {
  const byName = new Map(compiled.bindings.map((binding) => [binding.binding, binding]));
  for (const binding of compiled.bindings) {
    const rows = facts.bindings[binding.binding]!.rows;
    if (binding.verification.scope.mode === "columns") {
      if (facts.trusted.tenant === undefined) return `Verified ${binding.binding} requires trusted tenant scope.`;
      for (const row of rows) {
        if (row[binding.verification.scope.tenant_field] !== facts.trusted.tenant) return `Verified ${binding.binding} row is outside trusted tenant scope.`;
        if (binding.verification.scope.principal_field !== undefined) {
          if (facts.trusted.principal === undefined || row[binding.verification.scope.principal_field] !== facts.trusted.principal) return `Verified ${binding.binding} row is outside trusted principal scope.`;
        }
      }
    }
    if (binding.verification.scope.mode === "single_organization") {
      if (facts.trusted.organization_scope?.organization_id !== binding.verification.scope.organization_id) return `Verified ${binding.binding} is outside the reviewed organization scope.`;
      if (binding.verification.scope.principal_field !== undefined) {
        for (const row of rows) {
          if (facts.trusted.principal === undefined || row[binding.verification.scope.principal_field] !== facts.trusted.principal) return `Verified ${binding.binding} row is outside trusted principal scope.`;
        }
      }
    }
    if (binding.verification.source.kind === "relationship") {
      const parent = byName.get(binding.verification.source.from_binding)!;
      const parentRows = facts.bindings[parent.binding]!.rows;
      const relationship = binding.relationship!;
      const pairs = actionRuleRelationshipPairs(relationship).map((pair) => binding.verification.source.kind === "relationship" && binding.verification.source.direction === "forward"
        ? [pair.local_field, pair.target_field] as const : [pair.target_field, pair.local_field] as const);
      for (const row of rows) {
        if (!parentRows.some((parentRow) => pairs.every(([parentField, childField]) =>
          row[childField] !== null && row[childField] !== undefined && parentRow[parentField] === row[childField]))) return `Verified ${binding.binding} row does not follow its reviewed relationship.`;
      }
    }
  }
  return undefined;
}

function evaluationBase(facts: ActionRuleFactSetV1, dependencies: ActionRuleDependencyV1[]): {
  verified_facts_digest: `sha256:${string}`;
  dependency_set_digest: `sha256:${string}`;
} {
  return {
    verified_facts_digest: canonicalJsonDigest(facts),
    dependency_set_digest: canonicalJsonDigest(dependencies),
  };
}

function unknownEvaluation(
  code: string,
  reason: string,
  facts: ActionRuleFactSetV1,
  dependencies: ActionRuleDependencyV1[],
): ActionRuleEvaluationV1 {
  const base = evaluationBase(facts, dependencies);
  return { result: "unknown", safe_code: code, reason, dependencies, ...base };
}

function assertEffectValue(value: JsonScalar, type: ActionRuleScalarTypeSpecV1, minimum: number | undefined, maximum: number | undefined, values: JsonScalar[] | undefined, field: string): void {
  if (!scalarMatchesType(value, type, false)) throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Derived ${field} does not match its reviewed effect type.`);
  if (typeof value === "number" && ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum))) throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Derived ${field} is outside its reviewed effect bounds.`);
  if (values !== undefined && !values.some((candidate) => candidate === value)) throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", `Derived ${field} is outside its reviewed effect allowlist.`);
}

function deriveSingleEffect(input: EvaluateActionRuleInputV1, context: EvaluationContext): DerivedActionEffectV1 {
  const { compiled, facts, proposal_id: proposalId } = input;
  if (proposalId.length < 1 || proposalId.length > 200) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Runner proposal identity is unavailable.");
  const envelope = compiled.effect_envelope;
  const set: Record<string, JsonScalar> = {};
  for (const [fieldName, expression] of Object.entries(compiled.rule.effect.set).sort(([left], [right]) => left.localeCompare(right))) {
    const value = scalar(expression, context, `rule.effect.set.${fieldName}`);
    if (!value.known || value.value === null) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Exact derived effect value ${fieldName} is unavailable.`);
    const field = envelope.allowed_fields.find((item) => item.name === fieldName)!;
    assertEffectValue(value.value, field.type, field.minimum, field.maximum, field.values, fieldName);
    set[fieldName] = value.value;
  }
  const tenantGuard = envelope.tenant_key === undefined ? undefined : { column: envelope.tenant_key, value: facts.trusted.tenant as JsonScalar };
  const organizationScope = envelope.organization_scope === undefined
    ? undefined
    : facts.trusted.organization_scope?.organization_id !== envelope.organization_scope.organization_id
      ? (() => { throw new ActionRuleError("ACTION_RULE_SCOPE_UNPROVEN", "Reviewed organization context does not match the derived effect envelope."); })()
      : { mode: "single_organization" as const, organization_id: envelope.organization_scope.organization_id };
  const principalScope = envelope.principal_scope_key === undefined
    ? undefined
    : facts.trusted.principal === undefined
      ? (() => { throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Trusted principal is required by the derived effect."); })()
      : { column: envelope.principal_scope_key, value: facts.trusted.principal as JsonScalar };
  let primaryKey: DerivedActionEffectV1["primary_key"] = { column: envelope.primary_key };
  let expectedVersion: DerivedActionEffectV1["expected_version"];
  let deduplication: DerivedActionEffectV1["deduplication"];
  if (envelope.operation === "update") {
    const target = compiled.bindings.find((binding) => binding.binding === envelope.target_binding)!;
    const row = context.rows[target.binding]![0]!;
    const primaryValue = row[envelope.primary_key];
    const versionValue = envelope.conflict_key === undefined ? undefined : row[envelope.conflict_key];
    if (primaryValue === null || primaryValue === undefined || versionValue === null || versionValue === undefined) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", "Derived UPDATE identity or version is unavailable.");
    primaryKey = { column: envelope.primary_key, value: primaryValue };
    expectedVersion = { column: envelope.conflict_key!, value: versionValue };
  } else {
    const components = envelope.deduplication!.components.map((component) => {
      let value: JsonScalar;
      if (component.source === "proposal_id") value = proposalId;
      else if (component.source === "trusted_tenant") {
        if (facts.trusted.tenant === undefined) throw new ActionRuleError("ACTION_RULE_SCOPE_UNPROVEN", "A single-organization effect cannot derive a trusted-tenant deduplication value.");
        value = facts.trusted.tenant;
      }
      else if (component.source === "fixed") value = component.fixed!;
      else {
        const derived = context.derived.get(component.derived!);
        if (derived === undefined || derived.value === null) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Deduplication value ${component.derived} is unavailable.`);
        value = derived.value;
      }
      if (value === null) throw new ActionRuleError("ACTION_RULE_FACTS_UNKNOWN", `Deduplication column ${component.column} cannot be null.`);
      if (component.column === envelope.primary_key) primaryKey = { column: envelope.primary_key, value };
      return { column: component.column, source: component.source, value };
    });
    deduplication = { components };
  }
  const unsigned = {
    operation: envelope.operation === "update" ? "single_row_update" as const : "single_row_insert" as const,
    source: envelope.source,
    resource: compiled.target_resource.name,
    schema: compiled.target_resource.schema,
    table: compiled.target_resource.table,
    primary_key: primaryKey,
    ...(tenantGuard === undefined ? {} : { tenant_guard: tenantGuard }),
    ...(organizationScope === undefined ? {} : { organization_scope: organizationScope }),
    ...(principalScope === undefined ? {} : { principal_scope: principalScope }),
    ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }),
    ...(envelope.version_advance === undefined ? {} : { version_advance: envelope.version_advance }),
    allowed_columns: Object.keys(set).sort(),
    set,
    ...(deduplication === undefined ? {} : { deduplication }),
  };
  return { ...unsigned, effect_digest: canonicalJsonDigest(unsigned) };
}

function deriveEffect(input: EvaluateActionRuleInputV1, context: EvaluationContext): DerivedActionEffectV1 {
  const envelopes = actionRuleEffectEnvelopes(input.compiled.effect_envelope);
  const effects = actionRuleEffects(input.compiled.rule);
  const targets = [{ target_resource: input.compiled.target_resource, effect_field_types: input.compiled.effect_field_types },
    ...(input.compiled.atomic_updates ?? [])];
  assertAtomicUpdateShape(input.compiled.rule, input.compiled.effect_envelope);
  if (targets.length !== envelopes.length) throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "Compiled atomic targets do not match their reviewed envelopes.");
  const derived = envelopes.map((envelope, index) => deriveSingleEffect({ ...input, compiled: { ...input.compiled,
    effect_envelope: envelope, rule: { ...input.compiled.rule, effect: effects[index]! }, ...targets[index]!,
  } }, context));
  if (derived.length === 1) return derived[0]!;
  const identities = derived.map(effect => canonicalJsonDigest({ source: effect.source, schema: effect.schema,
    table: effect.table, identity: effect.primary_key, tenant: effect.tenant_guard ?? null }));
  if (new Set(identities).size !== identities.length) throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Atomic updates cannot write the same physical target more than once.");
  const { effect_digest: _digest, ...primary } = derived[0]!;
  const unsigned = { ...primary, atomic_updates: derived.slice(1) };
  return { ...unsigned, effect_digest: canonicalJsonDigest(unsigned) };
}

export function evaluateActionRule(input: EvaluateActionRuleInputV1): ActionRuleEvaluationV1 {
  assertCompiledIntegrity(input.compiled);
  let inputs: Record<string, JsonScalar>;
  try {
    inputs = validateActionRuleInputs(input.compiled.rule, input.inputs);
  } catch (error) {
    return unknownEvaluation("ACTION_RULE_INVALID", error instanceof Error ? error.message : "Invalid business inputs.", input.facts, []);
  }
  let normalized: ReturnType<typeof normalizeAndValidateFacts>;
  try {
    normalized = normalizeAndValidateFacts(input.compiled, input.facts);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Verified facts are unavailable.";
    const fallbackFacts: ActionRuleFactSetV1 = {
      bindings: {},
      trusted: {
        ...(typeof input.facts?.trusted?.tenant === "string"
          ? { tenant: input.facts.trusted.tenant }
          : input.facts?.trusted?.organization_scope?.mode === "single_organization"
            ? { organization_scope: input.facts.trusted.organization_scope }
            : { tenant: "unavailable" }),
        transaction_time: typeof input.facts?.trusted?.transaction_time === "string" ? input.facts.trusted.transaction_time : "unavailable",
      },
      subject_provenance_digest: safeDigest(input.facts),
    };
    return unknownEvaluation(error instanceof ActionRuleError ? error.code : "ACTION_RULE_FACTS_UNKNOWN", reason, fallbackFacts, []);
  }
  const base = evaluationBase(normalized.facts, normalized.dependencies);
  if (normalized.pendingUnknown !== undefined) {
    if (normalized.pendingUnknown.code === "ACTION_RULE_NOT_ELIGIBLE") return { result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE", dependencies: normalized.dependencies, ...base };
    return unknownEvaluation(normalized.pendingUnknown.code, normalized.pendingUnknown.reason, normalized.facts, normalized.dependencies);
  }
  const relationshipProblem = validateScopeAndRelationships(input.compiled, normalized.facts);
  if (relationshipProblem !== undefined) return unknownEvaluation("ACTION_RULE_SCOPE_UNPROVEN", relationshipProblem, normalized.facts, normalized.dependencies);
  const context: EvaluationContext = {
    inputs,
    compiled: input.compiled,
    facts: normalized.facts,
    rows: Object.fromEntries(Object.entries(normalized.facts.bindings).map(([name, value]) => [name, value.rows])),
    derived: new Map(),
    currentRows: new Map(),
  };
  try {
    const eligible = truth(input.compiled.rule.require, context, "rule.require");
    if (eligible === false) return { result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE", dependencies: normalized.dependencies, ...base };
    if (eligible === "unknown") return unknownEvaluation("ACTION_RULE_FACTS_UNKNOWN", "The reviewed rule could not be proven from complete authoritative facts.", normalized.facts, normalized.dependencies);
    const derived: Record<string, JsonScalar> = {};
    for (const name of input.compiled.derivation_order) {
      const value = scalar(input.compiled.rule.derive[name]!, context, `rule.derive.${name}`);
      if (!value.known || value.value === null) return unknownEvaluation("ACTION_RULE_FACTS_UNKNOWN", `Derived value ${name} could not be proven.`, normalized.facts, normalized.dependencies);
      context.derived.set(name, value);
      derived[name] = value.value;
    }
    const effect = deriveEffect({ ...input, facts: normalized.facts }, context);
    return { result: "eligible", derived, effect, dependencies: normalized.dependencies, ...base };
  } catch (error) {
    if (error instanceof ActionRuleError) return unknownEvaluation(error.code, error.message, normalized.facts, normalized.dependencies);
    throw error;
  }
}

export function evaluateActionRuleApprovalPredicate(input: {
  inputs?: Record<string, unknown>;
  compiled: CompiledActionRuleV1;
  facts: ActionRuleFactSetV1;
  expression: ActionRuleBooleanExpressionV1;
}): ActionRuleApprovalPredicateEvaluationV1 {
  assertCompiledIntegrity(input.compiled);
  try {
    const normalized = normalizeAndValidateFacts(input.compiled, input.facts);
    if (normalized.pendingUnknown !== undefined) {
      return {
        result: "unknown",
        safe_code: normalized.pendingUnknown.code,
        reason: normalized.pendingUnknown.reason,
      };
    }
    const relationshipProblem = validateScopeAndRelationships(input.compiled, normalized.facts);
    if (relationshipProblem !== undefined) {
      return { result: "unknown", safe_code: "ACTION_RULE_SCOPE_UNPROVEN", reason: relationshipProblem };
    }
    const context: EvaluationContext = {
      inputs: validateActionRuleInputs(input.compiled.rule, input.inputs),
      compiled: input.compiled,
      facts: normalized.facts,
      rows: Object.fromEntries(Object.entries(normalized.facts.bindings).map(([name, value]) => [name, value.rows])),
      derived: new Map(),
      currentRows: new Map(),
    };
    for (const name of input.compiled.derivation_order) {
      const value = scalar(input.compiled.rule.derive[name]!, context, `rule.derive.${name}`);
      if (!value.known || value.value === null) {
        return { result: "unknown", safe_code: "ACTION_RULE_FACTS_UNKNOWN", reason: `Derived value ${name} could not be proven for approval.` };
      }
      context.derived.set(name, value);
    }
    const result = truth(input.expression, context, "approval.auto_approve_when");
    if (result === "unknown") {
      return {
        result: "unknown",
        safe_code: "ACTION_RULE_FACTS_UNKNOWN",
        reason: "The reviewed automatic-approval predicate could not be proven from current authoritative facts.",
      };
    }
    return { result: result ? "match" : "no_match" };
  } catch (error) {
    if (error instanceof ActionRuleError) {
      return { result: "unknown", safe_code: error.code, reason: error.message };
    }
    throw error;
  }
}
