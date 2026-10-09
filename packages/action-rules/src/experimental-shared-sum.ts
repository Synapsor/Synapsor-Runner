import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleBooleanExpressionV1 } from '@synapsor/spec';
import { ActionRuleError } from './errors.js';
import { HardLimitPostStateExceeded } from './hard-limit.js';
import { actionRuleRelationshipPairs } from './relationships.js';
import { snapshotActionRuleRegistry } from './registry.js';
import type { ActionRuleFactRowV1, ActionRuleFactSetV1, CompiledActionRuleV1, CompiledRuleBindingV1,
  DerivedActionEffectV1, RuntimeActionRuleRegistryV1 } from './types.js';

/** Explicit host-only experiment. This is neither persisted authority nor a
 * public activation profile; the existing approved effect remains authoritative. */
export type ExperimentalSharedSumDesignationV1 = {
  schema_version: 'synapsor.experimental.shared-sum-protection.v1';
  kind: 'experimental_shared_sum'; source: string;
  scope: { tenant_field: string; principal_field: string };
  limit: { resource: string; field: string };
  populations: [{ resource: string; field: string }, { resource: string; field: string }];
  time: 'current_state'; external_writers: 'participating_only';
};
declare const protectionBrand: unique symbol;
export type ExperimentalSharedSumProtection = Readonly<{
  schema_version: ExperimentalSharedSumDesignationV1['schema_version'];
  disposition: 'EXPERIMENTAL_NO_PUBLIC_ACTIVATION';
  digest: `sha256:${string}`;
  [protectionBrand]: true;
}>;
type Context = { parent: CompiledRuleBindingV1; populations: [CompiledRuleBindingV1, CompiledRuleBindingV1] };
type Built = { designation: ExperimentalSharedSumDesignationV1; contexts: Map<string, Context>;
  participants: Array<{ outcome: string; compiled_plan_digest: string }>; meaning: string };
const issued = new WeakMap<ExperimentalSharedSumProtection, Built>();
const refuse = (stage: string): never => {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The experimental shared limit cannot be inspected with the supported guarantees.', `experimental.shared_sum.${stage}`);
};
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) refuse('designation');
}
function normalizeDesignation(input: ExperimentalSharedSumDesignationV1): ExperimentalSharedSumDesignationV1 {
  const d = structuredClone(input);
  closed(d, ['schema_version', 'kind', 'source', 'scope', 'limit', 'populations', 'time', 'external_writers']);
  closed(d.scope, ['tenant_field', 'principal_field']); closed(d.limit, ['resource', 'field']);
  if (!Array.isArray(d.populations) || d.populations.length !== 2) refuse('designation');
  for (const p of d.populations) closed(p, ['resource', 'field']);
  if (d.schema_version !== 'synapsor.experimental.shared-sum-protection.v1' || d.kind !== 'experimental_shared_sum'
    || d.time !== 'current_state' || d.external_writers !== 'participating_only'
    || [d.source, d.scope.tenant_field, d.scope.principal_field, d.limit.resource, d.limit.field,
      ...d.populations.flatMap(p => [p.resource, p.field])].some(v => typeof v !== 'string' || !v)
    || new Set([d.limit.resource, ...d.populations.map(p => p.resource)]).size !== 3) refuse('designation');
  return d;
}
const physical = (b: CompiledRuleBindingV1): string => canonicalJsonDigest([
  b.resource.engine, b.resource.source, b.resource.schema, b.resource.table]);
function singleton(compiled: CompiledActionRuleV1, resource: string): CompiledRuleBindingV1 {
  const matches = compiled.bindings.filter(b => b.resource.name === resource && b.verification.source.kind === 'subject_ref'
    && b.verification.cardinality === 'one');
  if (matches.length !== 1) return refuse('parent');
  return matches[0]!;
}
function context(compiled: CompiledActionRuleV1, d: ExperimentalSharedSumDesignationV1): Context {
  if (compiled.source !== d.source || compiled.target_resource.engine !== 'postgres' || compiled.hard_limit
    || compiled.rule.atomic_updates?.length || compiled.atomic_updates?.length || compiled.effect_envelope.atomic_updates?.length
    || compiled.effect_envelope.writeback.mode !== 'direct_sql' || compiled.effect_envelope.writeback.supervised_worker !== 'allowed'
    || compiled.verification_boundary.transaction.isolation !== 'read_committed') refuse('profile');
  const parent = singleton(compiled, d.limit.resource);
  const populations = d.populations.map(p => {
    const matches = compiled.bindings.filter(b => b.resource.name === p.resource && b.verification.cardinality === 'many');
    if (matches.length !== 1) return refuse('population');
    const b = matches[0]!;
    if (b.verification.collection_consistency !== 'complete_locked' || b.verification.source.kind !== 'relationship'
      || b.verification.source.direction !== 'inverse' || b.verification.source.from_binding !== parent.binding
      || !b.relationship || b.relationship.from_resource !== b.resource.name || b.relationship.to_resource !== parent.resource.name
      || b.relationship.nullable || !b.relationship.target_unique) refuse('population');
    return b;
  }) as Context['populations'];
  if (new Set([parent, ...populations].map(physical)).size !== 3
    || compiled.verification_boundary.lock_order[0] !== parent.binding) refuse('guard');
  for (const b of compiled.bindings) {
    if (![d.limit.resource, ...d.populations.map(p => p.resource)].includes(b.resource.name)
      || b.resource.engine !== 'postgres' || b.resource.source !== d.source || !b.resource.version_field
      || b.resource.verification_only || b.resource.private_evidence || b.verification.evidence_mode
      || b.verification.lock !== 'for_update' || b.verification.scope.mode !== 'columns'
      || b.verification.scope.tenant_field !== d.scope.tenant_field || b.verification.scope.principal_field !== d.scope.principal_field
      || b.resource.tenant_key !== d.scope.tenant_field || b.resource.principal_scope_key !== d.scope.principal_field) refuse('scope');
    if (b.resource.name === parent.resource.name && b.binding !== parent.binding) refuse('aliases');
    if (b.verification.cardinality === 'many' && !populations.includes(b)) refuse('aliases');
    if (b.verification.cardinality === 'one' && b.binding !== parent.binding
      && (compiled.rule.effect.operation !== 'update' || b.binding !== compiled.rule.effect.target_binding)) refuse('aliases');
  }
  const valueFields = [{ binding: parent, field: d.limit.field },
    ...populations.map((binding, i) => ({ binding, field: d.populations[i]!.field }))];
  const units = valueFields.map(({ binding, field }) => {
    const value = binding.verification.fields.find(f => f.name === field);
    if (!value || value.nullable || value.type.kind !== 'integer') return refuse('unit');
    return canonicalJsonDigest(value.type);
  });
  if (new Set(units).size !== 1) refuse('unit');
  const condition: ActionRuleBooleanExpressionV1 = { kind: 'compare', operator: 'lte',
    left: { kind: 'math', operation: 'add', inputs: populations.map((b, i) => ({
      kind: 'aggregate', operation: 'sum', binding: b.binding, field: d.populations[i]!.field })) },
    right: { kind: 'field', binding: parent.binding, field: d.limit.field } };
  // The existing immutable rule/proof binds the exact reviewed shared meaning.
  // Runner supplies only the additional post-state projection, never a formula.
  if (canonicalJsonDigest(compiled.rule.require) !== canonicalJsonDigest(condition)) refuse('reviewed_condition');
  validateEffect(compiled, { parent, populations });
  return { parent, populations };
}
function validateEffect(c: CompiledActionRuleV1, ctx: Context): void {
  const effect = c.rule.effect, e = c.effect_envelope;
  const population = ctx.populations.find(b => b.resource.name === c.target_resource.name);
  if (effect.operation === 'insert') {
    if (!population || e.conflict_key !== undefined || e.version_advance !== undefined
      || !e.deduplication?.components.some(v => v.column === population.resource.primary_key && v.source === 'proposal_id')) refuse('insert');
    const supplied = new Set([...Object.keys(effect.set), ...e.deduplication.components.map(v => v.column), e.tenant_key, e.principal_scope_key]);
    if (population.resource.fields.some(f => !supplied.has(f.name))) refuse('insert_columns');
    for (const pair of actionRuleRelationshipPairs(population.relationship!)) {
      if (pair.local_field === e.tenant_key && pair.target_field === ctx.parent.resource.tenant_key) continue;
      if (pair.local_field === e.principal_scope_key && pair.target_field === ctx.parent.resource.principal_scope_key) continue;
      const v = effect.set[pair.local_field];
      if (v?.kind !== 'field' || v.binding !== ctx.parent.binding || v.field !== pair.target_field) refuse('insert_membership');
    }
  } else {
    const target = c.bindings.find(b => b.binding === effect.target_binding);
    if (effect.operation !== 'update' || !target || target.verification.cardinality !== 'one'
      || ![ctx.parent.resource.name, ...ctx.populations.map(b => b.resource.name)].includes(target.resource.name)
      || e.version_advance?.strategy !== 'integer_increment' || e.version_advance.column !== target.resource.version_field
      || e.conflict_key !== target.resource.version_field) refuse('update');
    const identity = new Set([target.resource.primary_key, target.resource.tenant_key, target.resource.principal_scope_key,
      target.resource.version_field, ...ctx.populations.flatMap(b => actionRuleRelationshipPairs(b.relationship!).flatMap(p => [p.local_field, p.target_field]))]);
    if (Object.keys(effect.set).some(f => identity.has(f) || !target.verification.fields.some(v => v.name === f))) refuse('update_identity');
  }
}
function meaning(ctx: Context, d: ExperimentalSharedSumDesignationV1): string {
  const material = (b: CompiledRuleBindingV1, field: string) => ({ physical: physical(b),
    primary_key: b.resource.primary_key, version: b.resource.version_field, scope: b.verification.scope,
    field, type: b.verification.fields.find(f => f.name === field)!.type,
    ...(b.relationship ? { pairs: actionRuleRelationshipPairs(b.relationship) } : {}) });
  return canonicalJsonDigest({ parent: material(ctx.parent, d.limit.field),
    populations: ctx.populations.map((b, i) => material(b, d.populations[i]!.field)).sort((a, b) => a.physical.localeCompare(b.physical)) });
}
function build(registry: RuntimeActionRuleRegistryV1, designation: ExperimentalSharedSumDesignationV1): Built {
  const d = normalizeDesignation(designation), current = snapshotActionRuleRegistry(registry);
  const relevant = current.rules.filter(({ compiled: c }) => c.source === d.source
    && c.effect_envelope.writeback.mode !== 'none'
    && [c.target_resource, ...(c.atomic_updates ?? []).map(m => m.target_resource)].some(r =>
      [d.limit.resource, ...d.populations.map(p => p.resource)].includes(r.name)));
  if (!relevant.length) return refuse('inventory');
  const contexts = new Map<string, Context>();
  for (const { compiled: c } of relevant) contexts.set(c.outcome, context(c, d));
  const first = contexts.values().next().value as Context;
  const protectedRelations = new Set([first.parent, ...first.populations].map(physical));
  // Physical aliases and unsupported writer modes cannot bypass participation.
  for (const { compiled: c } of current.rules) {
    const targets = [c.target_resource, ...(c.atomic_updates ?? []).map(m => m.target_resource)];
    if (c.effect_envelope.writeback.mode === 'none' || !targets.some(r => protectedRelations.has(canonicalJsonDigest([r.engine, r.source, r.schema, r.table])))) continue;
    if (!contexts.has(c.outcome) || c.source !== d.source) refuse('inventory');
  }
  const common = meaning(first, d);
  if ([...contexts.values()].some(ctx => meaning(ctx, d) !== common)) refuse('inventory_context');
  const participants = relevant.map(({ compiled: c }) => ({ outcome: c.outcome, compiled_plan_digest: c.compiled_plan_digest }))
    .sort((a, b) => a.outcome.localeCompare(b.outcome));
  return { designation: d, contexts, participants, meaning: common };
}
export function compileExperimentalSharedSumProtection(input: {
  registry: RuntimeActionRuleRegistryV1; designation: ExperimentalSharedSumDesignationV1;
}): ExperimentalSharedSumProtection {
  const state = build(input.registry, input.designation);
  const plan = Object.freeze({ schema_version: state.designation.schema_version,
    disposition: 'EXPERIMENTAL_NO_PUBLIC_ACTIVATION' as const,
    digest: canonicalJsonDigest({ schema_version: state.designation.schema_version, meaning: state.meaning }) }) as ExperimentalSharedSumProtection;
  issued.set(plan, state); return plan;
}
export function resolveExperimentalSharedSumProtection(plan: ExperimentalSharedSumProtection,
  registry: RuntimeActionRuleRegistryV1, compiled: CompiledActionRuleV1): { digest: `sha256:${string}` } | undefined {
  const state = issued.get(plan); if (!state) return refuse('plan_origin');
  const current = build(registry, state.designation);
  if (current.meaning !== state.meaning || canonicalJsonDigest(current.participants) !== canonicalJsonDigest(state.participants)) refuse('inventory_changed');
  const participant = current.participants.find(p => p.outcome === compiled.outcome);
  if (!participant) return undefined;
  if (participant.compiled_plan_digest !== compiled.compiled_plan_digest) return refuse('inventory_changed');
  return { digest: plan.digest };
}
function stateFor(plan: ExperimentalSharedSumProtection, compiled: CompiledActionRuleV1): { state: Built; ctx: Context } {
  const state = issued.get(plan), ctx = state?.contexts.get(compiled.outcome);
  if (!state || !ctx || !state.participants.some(p => p.outcome === compiled.outcome && p.compiled_plan_digest === compiled.compiled_plan_digest)) return refuse('plan_origin');
  return { state, ctx };
}
function rowScope(b: CompiledRuleBindingV1, row: ActionRuleFactRowV1, facts: ActionRuleFactSetV1): boolean {
  return typeof facts.trusted.tenant === 'string' && typeof facts.trusted.principal === 'string'
    && row[b.resource.tenant_key!] === facts.trusted.tenant && row[b.resource.principal_scope_key!] === facts.trusted.principal;
}
function validateRows(ctx: Context, facts: ActionRuleFactSetV1): void {
  const parents = facts.bindings[ctx.parent.binding]?.rows;
  if (!parents || parents.length !== 1 || !rowScope(ctx.parent, parents[0]!, facts)) refuse('facts_scope');
  for (const b of [ctx.parent, ...ctx.populations]) {
    const rows = facts.bindings[b.binding]?.rows;
    if (!rows || rows.length > b.verification.max_rows || new Set(rows.map(row => canonicalJsonDigest(row[b.resource.primary_key]))).size !== rows.length
      || rows.some(row => row[b.resource.primary_key] === undefined || !rowScope(b, row, facts)
        || (b.relationship && !actionRuleRelationshipPairs(b.relationship).every(p => row[p.local_field] !== null && row[p.local_field] === parents[0]![p.target_field])))) refuse('facts_membership');
  }
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refuse('facts_integer');
  return value;
}
/** Stable physical guard identity for diagnostics/tests. Protection itself is
 * the existing parent-row FOR UPDATE; this digest is never a lock service. */
export function experimentalSharedSumGuardIdentity(plan: ExperimentalSharedSumProtection,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1): `sha256:${string}` {
  const { ctx } = stateFor(plan, compiled); validateRows(ctx, facts);
  return canonicalJsonDigest({ source: compiled.source, relation: physical(ctx.parent),
    tenant: facts.trusted.tenant, principal: facts.trusted.principal,
    key: { column: ctx.parent.resource.primary_key, value: facts.bindings[ctx.parent.binding]!.rows[0]![ctx.parent.resource.primary_key] } });
}
/** Project one exact already-approved effect over both complete populations.
 * Called only after the existing verifier establishes immutable effect identity. */
export function checkExperimentalSharedSumPostState(plan: ExperimentalSharedSumProtection,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1): void {
  const { state, ctx } = stateFor(plan, compiled); validateRows(ctx, facts);
  const post = structuredClone(facts);
  if (effect.atomic_updates?.length || effect.source !== compiled.source
    || effect.resource !== compiled.target_resource.name || effect.schema !== compiled.target_resource.schema || effect.table !== compiled.target_resource.table
    || effect.primary_key.column !== compiled.target_resource.primary_key || effect.primary_key.value === undefined
    || effect.tenant_guard?.column !== compiled.target_resource.tenant_key || effect.tenant_guard.value !== facts.trusted.tenant
    || effect.principal_scope?.column !== compiled.target_resource.principal_scope_key || effect.principal_scope.value !== facts.trusted.principal) refuse('effect_identity');
  const population = ctx.populations.find(b => b.resource.name === effect.resource);
  const target = population ?? ctx.parent;
  if (effect.operation === 'single_row_insert') {
    if (!population || compiled.rule.effect.operation !== 'insert' || effect.expected_version || effect.version_advance
      || !effect.deduplication?.components.some(v => v.column === effect.primary_key.column && v.source === 'proposal_id')) refuse('effect_insert');
    const row = { ...effect.set };
    const assign = (field: string, value: ActionRuleFactRowV1[string]) => {
      if (Object.hasOwn(row, field) && row[field] !== value) refuse('effect_collision');
      row[field] = value;
    };
    for (const v of effect.deduplication.components) assign(v.column, v.value);
    assign(effect.tenant_guard.column, effect.tenant_guard.value); assign(effect.principal_scope.column, effect.principal_scope.value);
    if (row[effect.primary_key.column] !== effect.primary_key.value || target.resource.fields.some(f => !Object.hasOwn(row, f.name) || (!f.nullable && row[f.name] === null))
      || Object.keys(row).some(f => !target.resource.fields.some(v => v.name === f))) refuse('effect_columns');
    for (const b of compiled.bindings.filter(b => b.resource.name === effect.resource)) {
      const rows = post.bindings[b.binding]?.rows;
      if (!rows || rows.some(r => r[effect.primary_key.column] === effect.primary_key.value)) refuse('effect_member');
      rows.push(structuredClone(row));
    }
  } else {
    if (effect.operation !== 'single_row_update' || compiled.rule.effect.operation !== 'update'
      || !effect.expected_version || effect.expected_version.column !== target.resource.version_field
      || effect.version_advance?.strategy !== 'integer_increment' || effect.version_advance.column !== target.resource.version_field) refuse('effect_update');
    const matches = post.bindings[target.binding]?.rows.filter(row => row[effect.primary_key.column] === effect.primary_key.value);
    if (matches?.length !== 1) refuse('effect_member');
    for (const b of compiled.bindings.filter(b => b.resource.name === effect.resource)) for (const row of post.bindings[b.binding]?.rows ?? []) {
      if (row[effect.primary_key.column] !== effect.primary_key.value) continue;
      const version = integer(row[effect.expected_version.column]);
      if (version !== effect.expected_version.value || !Number.isSafeInteger(version + 1)) refuse('effect_version');
      Object.assign(row, effect.set, { [effect.expected_version.column]: version + 1 });
    }
  }
  validateRows(ctx, post);
  let total = 0;
  for (const [i, b] of ctx.populations.entries()) for (const row of post.bindings[b.binding]!.rows) {
    total += integer(row[state.designation.populations[i]!.field]);
    if (!Number.isSafeInteger(total)) refuse('facts_overflow');
  }
  if (total > integer(post.bindings[ctx.parent.binding]!.rows[0]![state.designation.limit.field])) throw new HardLimitPostStateExceeded();
}
