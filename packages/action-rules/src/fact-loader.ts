import { actionRuleStringMatches, actionRuleStringMinimumValid } from "@synapsor/spec";
import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import type { ActionRuleScalarTypeSpecV1, JsonScalar } from "@synapsor/spec";
import { ActionRuleError, type ActionRuleErrorCode } from "./errors.js";
import { actionRuleRelationshipPairs } from "./relationships.js";
import type {
  ActionRuleFactRowV1,
  ActionRuleFactSetV1,
  CompiledActionRuleV1,
  CompiledRuleBindingV1,
} from "./types.js";

export type ActionRuleSubjectIdentityV1 = {
  binding: string;
  resource: string;
  primary_key: { column: string; value: JsonScalar };
  subject_ref_digest: `sha256:${string}`;
};

export type ActionRuleFactPredicateV1 =
  | { operation: "eq"; column: string; value: JsonScalar }
  | { operation: "in"; column: string; values: JsonScalar[] }
  | { operation: "tuple_in"; columns: string[]; tuples: JsonScalar[][] };

export type ActionRuleFactQueryV1 = {
  binding: string;
  engine: "postgres" | "mysql";
  source: string;
  schema: string;
  table: string;
  /** PG required-singleton proofs concern these base relations, not inherited rows. */
  relation_mode?: "only";
  projection: string[];
  predicates: ActionRuleFactPredicateV1[];
  order_by: Array<{ column: string; direction: "asc" | "desc" }>;
  limit: number;
  lock: "none" | "for_update";
};

export type ActionRuleFactLoaderAdapterV1 = {
  engine: "postgres" | "mysql";
  /** Current persisted shared invariant, inspected under the existing Source transaction. */
  assertReviewedSharedSumSource?(compiled: CompiledActionRuleV1): Promise<void>;
  assertHardLimitSource?(compiled: CompiledActionRuleV1): Promise<void>;
  /** Explicit experimental host profile; no default activation or fallback. */
  assertExperimentalSharedSumSource?(compiled: CompiledActionRuleV1): Promise<void>;
  assertResourceCompatible?(binding: CompiledRuleBindingV1): Promise<void>;
  assertRelationshipCompatible?(binding: CompiledRuleBindingV1, parent: CompiledRuleBindingV1,
    mode?: "proposal_snapshot" | "transaction_reverify"): Promise<void>;
  assertCompleteCollection?(input: {
    binding: CompiledRuleBindingV1;
    parent: CompiledRuleBindingV1;
    parentRows: ActionRuleFactRowV1[];
    trusted: ActionRuleFactSetV1["trusted"];
    mode: "proposal_snapshot" | "transaction_reverify";
  }): Promise<void>;
  load(query: ActionRuleFactQueryV1): Promise<Record<string, unknown>[]>;
};

export type LoadActionRuleFactsInputV1 = {
  compiled: CompiledActionRuleV1;
  subjects: ActionRuleSubjectIdentityV1[];
  trusted: ActionRuleFactSetV1["trusted"];
  adapter: ActionRuleFactLoaderAdapterV1;
  mode: "proposal_snapshot" | "transaction_reverify";
};

export type LoadedActionRuleFactsV1 = {
  facts: ActionRuleFactSetV1;
  subject_bindings: Array<{
    binding: string;
    resource: string;
    subject_ref_digest: `sha256:${string}`;
  }>;
  queries: ActionRuleFactQueryV1[];
};

function fail(code: ActionRuleErrorCode, message: string): never {
  throw new ActionRuleError(code, message);
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

export function normalizeActionRuleDatabaseValue(
  value: unknown,
  type: ActionRuleScalarTypeSpecV1,
  nullable: boolean,
): JsonScalar {
  if (value === null) {
    if (!nullable) fail("ACTION_RULE_FACT_TYPE_MISMATCH", "A non-null verification field returned null.");
    return null;
  }
  switch (type.kind) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === 0 || value === 1) return value === 1;
      break;
    case "integer":
    case "money_minor": {
      const numeric = typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^-?[0-9]+$/.test(value)
          ? Number(value)
          : value;
      if (typeof numeric === "number" && Number.isSafeInteger(numeric)) return numeric;
      break;
    }
    case "string":
      if (actionRuleStringMatches(value,type)) return value;
      break;
    case "date": {
      const date = value instanceof Date ? value.toISOString().slice(0, 10) : value;
      if (typeof date === "string" && isCanonicalDate(date)) return date;
      break;
    }
    case "timestamp": {
      const timestamp = normalizedTimestamp(value);
      if (timestamp !== undefined) return timestamp;
      break;
    }
  }
  fail("ACTION_RULE_FACT_TYPE_MISMATCH", `Database value does not match reviewed ${type.kind} verification type.`);
}

function uniqueValues(values: JsonScalar[]): JsonScalar[] {
  const byCanonical = new Map(values.map((value) => [canonicalJsonStringify(value), value]));
  return [...byCanonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function relationshipPredicate(
  binding: CompiledRuleBindingV1,
  loaded: Record<string, { rows: ActionRuleFactRowV1[] }>,
): ActionRuleFactPredicateV1 {
  if (binding.verification.source.kind !== "relationship" || binding.relationship === undefined) {
    return fail("ACTION_RULE_LOAD_PLAN_INVALID", `Binding ${binding.binding} has no reviewed relationship source.`);
  }
  const parentRows = loaded[binding.verification.source.from_binding]?.rows;
  if (parentRows === undefined) return fail("ACTION_RULE_LOAD_PLAN_INVALID", `Parent facts for ${binding.binding} are unavailable.`);
  const forward = binding.verification.source.direction === "forward";
  const pairs = actionRuleRelationshipPairs(binding.relationship);
  if (pairs.length > 1) {
    // Keep each parent's tuple intact; independent IN lists would permit cross-pair matches.
    const tuples = new Map<string, JsonScalar[]>();
    for (const row of parentRows) {
      const tuple = pairs.map((pair) => row[forward ? pair.local_field : pair.target_field]);
      if (tuple.some((value) => value === undefined || value === null)) continue;
      tuples.set(canonicalJsonDigest(tuple), tuple as JsonScalar[]);
    }
    return { operation: "tuple_in", columns: pairs.map((pair) => forward ? pair.target_field : pair.local_field),
      tuples: [...tuples].sort(([left], [right]) => left.localeCompare(right)).map(([, tuple]) => tuple) };
  }
  const parentColumn = forward ? pairs[0]!.local_field : pairs[0]!.target_field;
  const childColumn = forward ? pairs[0]!.target_field : pairs[0]!.local_field;
  const values = uniqueValues(parentRows
    .map((row) => row[parentColumn])
    .filter((value): value is JsonScalar => value !== undefined && value !== null));
  if (values.length === 0) return { operation: "in", column: childColumn, values: [] };
  return values.length === 1
    ? { operation: "eq", column: childColumn, value: values[0]! }
    : { operation: "in", column: childColumn, values };
}

function scopePredicates(
  binding: CompiledRuleBindingV1,
  trusted: ActionRuleFactSetV1["trusted"],
): ActionRuleFactPredicateV1[] {
  const scope = binding.verification.scope;
  if (scope.mode === "inherited") return [];
  if (scope.mode === "columns") {
    if (trusted.tenant === undefined) return fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${binding.binding} requires trusted tenant scope.`);
    if (scope.principal_field !== undefined && trusted.principal === undefined) return fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${binding.binding} requires trusted principal scope.`);
    return [
      { operation: "eq", column: scope.tenant_field, value: trusted.tenant },
      ...(scope.principal_field === undefined ? [] : [{ operation: "eq" as const, column: scope.principal_field, value: trusted.principal! }]),
    ];
  }
  if (trusted.organization_scope?.organization_id !== scope.organization_id) {
    return fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${binding.binding} does not match the reviewed organization scope.`);
  }
  if (scope.principal_field !== undefined && trusted.principal === undefined) return fail("ACTION_RULE_SCOPE_UNPROVEN", `Binding ${binding.binding} requires trusted principal scope.`);
  return scope.principal_field === undefined
    ? []
    : [{ operation: "eq", column: scope.principal_field, value: trusted.principal! }];
}

function validateSubjects(
  compiled: CompiledActionRuleV1,
  subjects: ActionRuleSubjectIdentityV1[],
): Map<string, ActionRuleSubjectIdentityV1> {
  const expected = new Map(compiled.rule.subjects.map((subject) => [subject.binding, subject]));
  if (subjects.length !== expected.size) fail("ACTION_RULE_SUBJECT_INVALID", "Every reviewed Action Rule subject is required exactly once.");
  const result = new Map<string, ActionRuleSubjectIdentityV1>();
  for (const subject of subjects) {
    const reviewed = expected.get(subject.binding);
    const binding = compiled.bindings.find((item) => item.binding === subject.binding);
    if (reviewed === undefined || binding === undefined || binding.verification.source.kind !== "subject_ref") fail("ACTION_RULE_SUBJECT_INVALID", `Subject binding ${subject.binding} is not reviewed for this outcome.`);
    if (result.has(subject.binding)
      || subject.resource !== reviewed.resource
      || subject.primary_key.column !== binding.verification.primary_key
      || subject.primary_key.value === null
      || !/^sha256:[a-f0-9]{64}$/.test(subject.subject_ref_digest)) {
      fail("ACTION_RULE_SUBJECT_INVALID", `Subject binding ${subject.binding} failed exact authority validation.`);
    }
    result.set(subject.binding, subject);
  }
  return result;
}

function normalizedRows(
  binding: CompiledRuleBindingV1,
  rows: Record<string, unknown>[],
): ActionRuleFactRowV1[] {
  const reviewed = new Map(binding.verification.fields.map((field) => [field.name, field]));
  return rows.map((row) => {
    if (Object.keys(row).some((column) => !reviewed.has(column))) fail("ACTION_RULE_FACT_TYPE_MISMATCH", `Database returned an unreviewed field for ${binding.binding}.`);
    const normalized: ActionRuleFactRowV1 = {};
    for (const [name, field] of reviewed) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) fail("ACTION_RULE_FACTS_UNKNOWN", `Database omitted verification field ${binding.binding}.${name}.`);
      normalized[name] = normalizeActionRuleDatabaseValue(row[name], field.type, field.nullable ?? false);
    }
    return normalized;
  });
}

export async function loadActionRuleFacts(input: LoadActionRuleFactsInputV1): Promise<LoadedActionRuleFactsV1> {
  if (input.adapter.engine !== input.compiled.target_resource.engine) fail("ACTION_RULE_ENGINE_MISMATCH", "Fact loader engine does not match the activated Action Rule.");
  const subjectByBinding = validateSubjects(input.compiled, input.subjects);
  const bindingByName = new Map(input.compiled.bindings.map((binding) => [binding.binding, binding]));
  const bindings: Record<string, { rows: ActionRuleFactRowV1[] }> = {};
  const queries: ActionRuleFactQueryV1[] = [];
  const exactRelations = new Set<string>();
  for (const binding of input.compiled.bindings) {
    if (binding.verification.evidence_mode === "required_scoped_singleton") {
      exactRelations.add(binding.binding);
      if (binding.verification.source.kind === "relationship") exactRelations.add(binding.verification.source.from_binding);
    }
  }
  for (const bindingName of input.compiled.verification_boundary.lock_order) {
    const binding = bindingByName.get(bindingName);
    if (binding === undefined) fail("ACTION_RULE_LOAD_PLAN_INVALID", `Compiled lock binding ${bindingName} is unavailable.`);
    if (binding.resource.engine !== input.adapter.engine) fail("ACTION_RULE_ENGINE_MISMATCH", `Verification resource ${binding.resource.name} uses another database engine.`);
    await input.adapter.assertResourceCompatible?.(binding);
    if (binding.verification.evidence_mode && (!input.adapter.assertRelationshipCompatible || !input.adapter.assertResourceCompatible
      || input.adapter.engine !== "postgres")) fail("ACTION_RULE_LOAD_PLAN_INVALID", "The adapter cannot establish required scoped singleton evidence.");
    if (binding.verification.source.kind === "relationship" && (binding.relationship?.field_pairs || binding.verification.collection_consistency || binding.verification.evidence_mode)) {
      const parent = input.compiled.bindings.find((candidate) => candidate.binding === (binding.verification.source.kind === "relationship" ? binding.verification.source.from_binding : ""));
      if (!parent) return fail("ACTION_RULE_LOAD_PLAN_INVALID", "A composite relationship requires its reviewed parent binding.");
      if (binding.verification.collection_consistency) {
        if (!input.adapter.assertCompleteCollection || !input.adapter.assertRelationshipCompatible) {
          return fail("ACTION_RULE_LOAD_PLAN_INVALID", "The source adapter cannot prove complete collection visibility and phantom protection.");
        }
        const parentRows = bindings[parent.binding]?.rows;
        if (!parentRows || parentRows.length !== 1) return fail("ACTION_RULE_FACTS_UNKNOWN", "Complete collection requires its exact existing parent.");
        await input.adapter.assertCompleteCollection({ binding, parent, parentRows, trusted: input.trusted, mode: input.mode });
      }
      await input.adapter.assertRelationshipCompatible?.(binding, parent, input.mode);
    }
    const sourcePredicate = binding.verification.source.kind === "subject_ref"
      ? (() => {
          const subject = subjectByBinding.get(binding.binding);
          if (subject === undefined) return fail("ACTION_RULE_SUBJECT_INVALID", `Subject ${binding.binding} is unavailable.`);
          return { operation: "eq" as const, column: subject.primary_key.column, value: subject.primary_key.value };
        })()
      : relationshipPredicate(binding, bindings);
    const query: ActionRuleFactQueryV1 = {
      binding: binding.binding,
      engine: binding.resource.engine,
      source: binding.resource.source,
      schema: binding.resource.schema,
      table: binding.resource.table,
      ...(exactRelations.has(binding.binding) ? { relation_mode: "only" as const } : {}),
      projection: binding.verification.fields.map((field) => field.name),
      predicates: [sourcePredicate, ...scopePredicates(binding, input.trusted)],
      order_by: binding.verification.deterministic_order?.map((entry) => ({ column: entry.field, direction: entry.direction }))
        ?? [{ column: binding.verification.primary_key, direction: "asc" }],
      limit: binding.verification.max_rows + 1,
      lock: input.mode === "transaction_reverify" ? "for_update" : "none",
    };
    queries.push(query);
    const emptyRelationship = (sourcePredicate.operation === "in" && sourcePredicate.values.length === 0)
      || (sourcePredicate.operation === "tuple_in" && sourcePredicate.tuples.length === 0);
    bindings[binding.binding] = {
      rows: emptyRelationship ? [] : normalizedRows(binding, await input.adapter.load(query)),
    };
  }
  const subjectBindings = input.subjects
    .map(({ binding, resource, subject_ref_digest }) => ({ binding, resource, subject_ref_digest }))
    .sort((left, right) => left.binding.localeCompare(right.binding));
  return {
    facts: {
      bindings,
      trusted: input.trusted,
      subject_provenance_digest: canonicalJsonDigest(subjectBindings),
    },
    subject_bindings: subjectBindings,
    queries,
  };
}
