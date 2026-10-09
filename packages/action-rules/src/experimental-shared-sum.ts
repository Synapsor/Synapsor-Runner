import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleBooleanExpressionV1 } from '@synapsor/spec';
import { ActionRuleError } from './errors.js';
import { normalizeActionRuleBooleanExpression } from './normalize.js';
import { checkExactWeightedConstraint } from './exact-weighted-constraint.js';
import { projectBoundedInvariantEffect, validateBoundedInvariantRows, assertBoundedInvariantEffectProfile } from './bounded-invariant-state.js';
import { actionRuleRelationshipPairs } from './relationships.js';
import { snapshotActionRuleRegistry } from './registry.js';
import type { ActionRuleFactSetV1, CompiledActionRuleV1, CompiledRuleBindingV1,
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
export type SharedSumDerivedState = { designation: ExperimentalSharedSumDesignationV1; contexts: Map<string, Context>;
  participants: Array<{ outcome: string; compiled_plan_digest: string }>; meaning: string };
const issued = new WeakMap<ExperimentalSharedSumProtection, SharedSumDerivedState>();
function refuse(stage: string): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The experimental shared limit cannot be inspected with the supported guarantees.', `experimental.shared_sum.${stage}`);
}
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
    if (!value || value.nullable || value.type.kind !== 'integer'
      || typeof value.type.unit !== 'string' || !value.type.unit) return refuse('unit');
    return canonicalJsonDigest(value.type);
  });
  if (new Set(units).size !== 1) refuse('unit');
  const condition: ActionRuleBooleanExpressionV1 = { kind: 'compare', operator: 'lte',
    left: { kind: 'math', operation: 'add', inputs: populations.map((b, i) => ({
      kind: 'aggregate', operation: 'sum', binding: b.binding, field: d.populations[i]!.field })) },
    right: { kind: 'field', binding: parent.binding, field: d.limit.field } };
  // The existing immutable rule/proof binds the exact reviewed shared meaning.
  // Runner supplies only the additional post-state projection, never a formula.
  if (canonicalJsonDigest(compiled.rule.require) !== canonicalJsonDigest(normalizeActionRuleBooleanExpression(condition))) refuse('reviewed_condition');
  assertBoundedInvariantEffectProfile(compiled, { parent, populations }, refuse);
  return { parent, populations };
}
function meaning(ctx: Context, d: ExperimentalSharedSumDesignationV1): string {
  const material = (b: CompiledRuleBindingV1, field: string) => ({ physical: physical(b),
    primary_key: b.resource.primary_key, version: b.resource.version_field, scope: b.verification.scope,
    field, type: b.verification.fields.find(f => f.name === field)!.type,
    ...(b.relationship ? { pairs: actionRuleRelationshipPairs(b.relationship) } : {}) });
  return canonicalJsonDigest({ parent: material(ctx.parent, d.limit.field),
    populations: ctx.populations.map((b, i) => material(b, d.populations[i]!.field)).sort((a, b) => a.physical.localeCompare(b.physical)) });
}
export function buildSharedSumDerivedState(registry: RuntimeActionRuleRegistryV1, designation: ExperimentalSharedSumDesignationV1): SharedSumDerivedState {
  const d = normalizeDesignation(designation), current = registry;
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
  const state = buildSharedSumDerivedState(snapshotActionRuleRegistry(input.registry), input.designation);
  const plan = Object.freeze({ schema_version: state.designation.schema_version,
    disposition: 'EXPERIMENTAL_NO_PUBLIC_ACTIVATION' as const,
    digest: canonicalJsonDigest({ schema_version: state.designation.schema_version, meaning: state.meaning }) }) as ExperimentalSharedSumProtection;
  issued.set(plan, state); return plan;
}
export function resolveExperimentalSharedSumProtection(plan: ExperimentalSharedSumProtection,
  registry: RuntimeActionRuleRegistryV1, compiled: CompiledActionRuleV1): { digest: `sha256:${string}` } | undefined {
  const state = issued.get(plan); if (!state) return refuse('plan_origin');
  const current = buildSharedSumDerivedState(snapshotActionRuleRegistry(registry), state.designation);
  if (current.meaning !== state.meaning || canonicalJsonDigest(current.participants) !== canonicalJsonDigest(state.participants)) refuse('inventory_changed');
  const participant = current.participants.find(p => p.outcome === compiled.outcome);
  if (!participant) return undefined;
  if (participant.compiled_plan_digest !== compiled.compiled_plan_digest) return refuse('inventory_changed');
  return { digest: plan.digest };
}
function stateFor(plan: ExperimentalSharedSumProtection, compiled: CompiledActionRuleV1): { state: SharedSumDerivedState; ctx: Context } {
  const state = issued.get(plan), ctx = state?.contexts.get(compiled.outcome);
  if (!state || !ctx || !state.participants.some(p => p.outcome === compiled.outcome && p.compiled_plan_digest === compiled.compiled_plan_digest)) return refuse('plan_origin');
  return { state, ctx };
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refuse('facts_integer');
  return value;
}
function numericState(ctx: Context, designation: ExperimentalSharedSumDesignationV1,
  facts: ActionRuleFactSetV1): { total: number; limit: number; quantities: number[] } {
  const limit = integer(facts.bindings[ctx.parent.binding]!.rows[0]![designation.limit.field]);
  let total = 0;
  const quantities: number[] = [];
  for (const [i, b] of ctx.populations.entries()) {
    let population = 0;
    for (const row of facts.bindings[b.binding]!.rows) {
      const value = integer(row[designation.populations[i]!.field]);
      total += value; population += value;
      if (!Number.isSafeInteger(total)) refuse('facts_overflow');
    }
    quantities.push(population);
  }
  return { total, limit, quantities };
}
/** Stable physical guard identity for diagnostics/tests. Protection itself is
 * the existing parent-row FOR UPDATE; this digest is never a lock service. */
export function experimentalSharedSumGuardIdentity(plan: ExperimentalSharedSumProtection,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1): `sha256:${string}` {
  const { state } = stateFor(plan, compiled);
  return sharedSumDerivedGuardIdentity(state, compiled, facts);
}
export function sharedSumDerivedGuardIdentity(state: SharedSumDerivedState,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1): `sha256:${string}` {
  const ctx = state.contexts.get(compiled.outcome); if (!ctx) return refuse('plan_origin');
  validateBoundedInvariantRows(ctx, facts, refuse);
  return canonicalJsonDigest({ source: compiled.source, relation: physical(ctx.parent),
    tenant: facts.trusted.tenant, principal: facts.trusted.principal,
    key: { column: ctx.parent.resource.primary_key, value: facts.bindings[ctx.parent.binding]!.rows[0]![ctx.parent.resource.primary_key] } });
}
/** Project one exact already-approved effect over both complete populations.
 * Called only after the existing verifier establishes immutable effect identity. */
export function checkExperimentalSharedSumPostState(plan: ExperimentalSharedSumProtection,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1): void {
  const { state } = stateFor(plan, compiled);
  checkSharedSumDerivedPostState(state, compiled, facts, effect);
}
export function checkSharedSumDerivedPostState(state: SharedSumDerivedState,
  compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1): void {
  const ctx = state.contexts.get(compiled.outcome);
  if (!ctx || !state.participants.some(p => p.outcome === compiled.outcome && p.compiled_plan_digest === compiled.compiled_plan_digest)) return refuse('plan_origin');
  validateBoundedInvariantRows(ctx, facts, refuse);
  // Validate the original complete state before replacement can hide invalid
  // amounts or unsafe arithmetic; projection must not repair unknown facts.
  numericState(ctx, state.designation, facts);
  const post = projectBoundedInvariantEffect(ctx, compiled, facts, effect, refuse);
  const { limit, quantities } = numericState(ctx, state.designation, post);
  checkExactWeightedConstraint(quantities.map(value => ({ quantity: BigInt(value), numerator: '1', denominator: '1' })), BigInt(limit));
}
