import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { ActionRuleError } from './errors.js';
import { actionRuleRelationshipPairs } from './relationships.js';
import { assertBoundedInvariantEffectProfile, projectBoundedInvariantEffect, validateBoundedInvariantRows,
  type BoundedInvariantContext } from './bounded-invariant-state.js';
import { assertUtcMonthAdmission, checkExactWeightedConstraint } from './exact-weighted-constraint.js';
import { parseWeightedSharedSumDesignation, type WeightedSharedSumDesignationV2,
  type WeightedSharedSumUnitV2 } from './weighted-shared-sum-designation.js';
import type { ActionRuleFactSetV1, CompiledActionRuleV1, CompiledRuleBindingV1,
  DerivedActionEffectV1, RuntimeActionRuleRegistryV1 } from './types.js';

/** Compiler DATA only. The mandatory runtime will derive this from activated
 * serialized authority; this builder never enables a caller's designation. */
export type WeightedConstraintState = Readonly<{ designation: WeightedSharedSumDesignationV2;
  contexts: ReadonlyMap<string, BoundedInvariantContext>; meaning: `sha256:${string}`;
  participants: ReadonlyArray<{ outcome: string; compiled_plan_digest: string }> }>;
function refuse(stage: string): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The weighted constraint cannot be inspected with the supported Source guarantees.', `source.hard_limit.weighted_${stage}`);
}
const physical = (b: CompiledRuleBindingV1) => canonicalJsonDigest([b.resource.engine, b.resource.source, b.resource.schema, b.resource.table]);
function field(b: CompiledRuleBindingV1, name: string, unit: WeightedSharedSumUnitV2 | { kind: 'timestamp' }): void {
  const actual = b.resource.fields.find(f => f.name === name), selected = b.verification.fields.find(f => f.name === name);
  if (!actual || actual.nullable || !selected || selected.nullable
    || canonicalJsonDigest(actual.type) !== canonicalJsonDigest(unit)
    || canonicalJsonDigest(selected.type) !== canonicalJsonDigest(unit)) refuse('unit');
}
function context(c: CompiledActionRuleV1, d: WeightedSharedSumDesignationV2): BoundedInvariantContext {
  if (c.source !== d.source || c.target_resource.engine !== 'postgres' || c.hard_limit
    || c.rule.atomic_updates?.length || c.atomic_updates?.length || c.effect_envelope.atomic_updates?.length
    || c.effect_envelope.writeback.mode !== 'direct_sql' || c.effect_envelope.writeback.supervised_worker !== 'allowed'
    || c.verification_boundary.transaction.isolation !== 'read_committed' || c.verification_boundary.transaction.timezone !== 'UTC') refuse('profile');
  const parents = c.bindings.filter(b => b.resource.name === d.guard.resource && b.verification.cardinality === 'one'
    && b.verification.source.kind === 'subject_ref');
  if (parents.length !== 1) refuse('guard');
  const parent = parents[0]!;
  if (parent.resource.primary_key !== d.guard.identity_field || c.verification_boundary.lock_order[0] !== parent.binding) refuse('guard');
  const populations = d.populations.map(p => {
    const matches = c.bindings.filter(b => b.resource.name === p.resource && b.verification.cardinality === 'many');
    if (matches.length !== 1) refuse('population');
    const b = matches[0]!;
    if (b.verification.collection_consistency !== 'complete_locked' || b.verification.source.kind !== 'relationship'
      || b.verification.source.direction !== 'inverse' || b.verification.source.from_binding !== parent.binding
      || !b.relationship || b.relationship.name !== p.guard_relationship || b.relationship.from_resource !== p.resource
      || b.relationship.to_resource !== parent.resource.name || b.relationship.nullable || !b.relationship.target_unique) refuse('population');
    return b;
  });
  if (new Set([parent, ...populations].map(physical)).size !== populations.length + 1) refuse('overlap');
  for (const b of c.bindings) {
    if (![d.guard.resource, ...d.populations.map(p => p.resource)].includes(b.resource.name)
      || b.resource.engine !== 'postgres' || b.resource.source !== d.source || !b.resource.version_field
      || b.resource.verification_only || b.resource.private_evidence || b.verification.evidence_mode
      || b.verification.lock !== 'for_update' || b.verification.scope.mode !== 'columns'
      || b.verification.scope.tenant_field !== d.scope.tenant_field || b.verification.scope.principal_field !== d.scope.principal_field
      || b.resource.tenant_key !== d.scope.tenant_field || b.resource.principal_scope_key !== d.scope.principal_field) refuse('scope');
    if (b.resource.name === parent.resource.name && b.binding !== parent.binding) refuse('aliases');
    if (b.verification.cardinality === 'many' && !populations.includes(b)) refuse('aliases');
    if (b.verification.cardinality === 'one' && b.binding !== parent.binding
      && (c.rule.effect.operation !== 'update' || b.binding !== c.rule.effect.target_binding)) refuse('aliases');
  }
  field(parent, d.guard.period_start_field, { kind: 'timestamp' }); field(parent, d.guard.period_end_field, { kind: 'timestamp' });
  field(parent, d.limit.field, d.limit.unit);
  for (const m of d.measures) {
    const i = d.populations.findIndex(p => p.id === m.population);
    field(populations[i]!, m.field, m.input_unit);
    if (m.raw_cap) field(parent, m.raw_cap.field, m.input_unit);
  }
  assertBoundedInvariantEffectProfile(c, { parent, populations }, refuse,
    c.target_resource.name === parent.resource.name ? [d.guard.period_start_field, d.guard.period_end_field] : []);
  return { parent, populations };
}
function meaning(ctx: BoundedInvariantContext, d: WeightedSharedSumDesignationV2): `sha256:${string}` {
  const binding = (b: CompiledRuleBindingV1) => ({ physical: physical(b), primary_key: b.resource.primary_key,
    version: b.resource.version_field, scope: b.verification.scope, fields: b.resource.fields,
    max_rows: b.verification.max_rows, ...(b.relationship ? { pairs: actionRuleRelationshipPairs(b.relationship) } : {}) });
  return canonicalJsonDigest({ guard: binding(ctx.parent), populations: ctx.populations.map(binding).sort((a, b) => a.physical.localeCompare(b.physical)), designation: d });
}
export function buildWeightedConstraintState(registry: RuntimeActionRuleRegistryV1, input: WeightedSharedSumDesignationV2): WeightedConstraintState {
  const designation = parseWeightedSharedSumDesignation(input);
  if (registry.rules.some(r => r.compiled.source !== designation.source)) refuse('source_inventory');
  const writers = registry.rules.filter(r => r.compiled.effect_envelope.writeback.mode !== 'none');
  const outcomes = new Set(designation.participating_outcomes);
  if (writers.length !== outcomes.size || writers.some(r => !outcomes.has(r.compiled.outcome))) refuse('writer_inventory');
  const contexts = new Map(writers.map(r => [r.compiled.outcome, context(r.compiled, designation)]));
  const first = contexts.values().next().value as BoundedInvariantContext;
  const common = meaning(first, designation);
  if ([...contexts.values()].some(ctx => meaning(ctx, designation) !== common)) refuse('inventory_context');
  return { designation, contexts, meaning: common, participants: writers.map(r => ({ outcome: r.compiled.outcome,
    compiled_plan_digest: r.compiled.compiled_plan_digest })).sort((a, b) => a.outcome.localeCompare(b.outcome)) };
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse('quantity');
  return BigInt(value);
}
function values(state: WeightedConstraintState, ctx: BoundedInvariantContext, facts: ActionRuleFactSetV1) {
  validateBoundedInvariantRows(ctx, facts, refuse);
  const d = state.designation, parent = facts.bindings[ctx.parent.binding]!.rows[0]!;
  return { limit: quantity(parent[d.limit.field]), terms: d.measures.map(m => {
    const i = d.populations.findIndex(p => p.id === m.population), b = ctx.populations[i]!;
    let total = 0n;
    for (const row of facts.bindings[b.binding]!.rows) total += quantity(row[m.field]);
    return { quantity: total, numerator: m.valuation.numerator, denominator: m.valuation.denominator,
      ...(m.raw_cap ? { raw_cap: quantity(parent[m.raw_cap.field]) } : {}) };
  }) };
}
function currentContext(state: WeightedConstraintState, c: CompiledActionRuleV1): BoundedInvariantContext {
  const ctx = state.contexts.get(c.outcome);
  if (!ctx || !state.participants.some(p => p.outcome === c.outcome && p.compiled_plan_digest === c.compiled_plan_digest)) refuse('inventory_changed');
  return ctx;
}
function period(state: WeightedConstraintState, ctx: BoundedInvariantContext, facts: ActionRuleFactSetV1, admitted_at: string): void {
  const row = facts.bindings[ctx.parent.binding]!.rows[0]!;
  assertUtcMonthAdmission({ start: row[state.designation.guard.period_start_field] as string,
    end: row[state.designation.guard.period_end_field] as string, admitted_at });
}
/** Used for protected current-period revaluation; callers must qualify/lock
 * Source and order worker admission/publication before accepting a replacement. */
export function checkWeightedCurrentState(state: WeightedConstraintState, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1, admitted_at: string): void {
  const ctx = currentContext(state, compiled), current = values(state, ctx, facts);
  period(state, ctx, facts, admitted_at); checkExactWeightedConstraint(current.terms, current.limit);
}
export function checkWeightedPostState(state: WeightedConstraintState, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1, admitted_at: string): void {
  const ctx = currentContext(state, compiled);
  // Invalid original quantities must not be hidden by an UPDATE replacement.
  values(state, ctx, facts); period(state, ctx, facts, admitted_at);
  const post = projectBoundedInvariantEffect(ctx, compiled, facts, effect, refuse), projected = values(state, ctx, post);
  period(state, ctx, post, admitted_at); checkExactWeightedConstraint(projected.terms, projected.limit);
}
