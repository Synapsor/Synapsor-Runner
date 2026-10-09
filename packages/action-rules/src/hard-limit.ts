import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleBooleanExpressionV1 } from '@synapsor/spec';
import { compileActionRuleBooleanPredicate } from './compile.js';
import { ActionRuleError } from './errors.js';
import { actionRuleRelationshipPairs } from './relationships.js';
import { evaluateActionRuleApprovalPredicate } from './evaluate.js';
import type { ActionRuleFactRowV1, ActionRuleFactSetV1, CompiledActionRuleV1, CompiledRuleBindingV1, CompiledHardLimitV1, DerivedActionEffectV1, HardLimitDesignationV1, RuntimeActionRuleRegistryV1 } from './types.js';

function unsupported(): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'This change cannot be checked with the supported Source guarantees.');
}
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) unsupported();
}
function finiteFilter(value: ActionRuleBooleanExpressionV1, binding: string): boolean {
  if (value.kind === 'all' || value.kind === 'any') return value.expressions.every(item => finiteFilter(item, binding));
  if (value.kind === 'not') return finiteFilter(value.expression, binding);
  return value.kind === 'compare' && [value.left, value.right].every(side => side.kind === 'literal' || (side.kind === 'field' && side.binding === binding));
}

/** Meaning is reviewed in typed authority; condition and effects are derived by Runner. */
export function compileHardLimit(compiled: CompiledActionRuleV1, source: HardLimitDesignationV1): CompiledHardLimitV1 {
  const d = structuredClone(source);
  closed(d, ['kind', 'scope', 'population', 'limit', 'time', 'external_writers']);
  closed(d.scope, ['tenant_field', 'principal_field']); closed(d.population, ['binding', 'field', 'where']); closed(d.limit, ['binding', 'field']);
  if (d.kind !== 'hard_invariant' || d.time !== 'current_state' || d.external_writers !== 'participating_only'
    || compiled.target_resource.engine !== 'postgres') unsupported();
  const child = compiled.bindings.find(b => b.binding === d.population.binding);
  const parent = compiled.bindings.find(b => b.binding === d.limit.binding);
  if (!child || !parent || child.verification.collection_consistency !== 'complete_locked'
    || child.verification.source.kind !== 'relationship' || child.verification.source.from_binding !== parent.binding
    || child.verification.source.direction !== 'inverse' || !child.relationship
    || parent.verification.source.kind !== 'subject_ref' || parent.verification.cardinality !== 'one'
    || compiled.verification_boundary.transaction.isolation !== 'read_committed'
    || parent.verification.scope.mode !== 'columns' || child.verification.scope.mode !== 'columns'
    || parent.verification.scope.tenant_field !== d.scope.tenant_field || parent.verification.scope.principal_field !== d.scope.principal_field
    || child.verification.scope.tenant_field !== d.scope.tenant_field || child.verification.scope.principal_field !== d.scope.principal_field
    || (d.population.where && !finiteFilter(d.population.where, child.binding))) unsupported();
  const effects = [compiled.rule.effect, ...(compiled.rule.atomic_updates ?? [])];
  const envelopes = [compiled.effect_envelope, ...(compiled.effect_envelope.atomic_updates ?? [])];
  if (compiled.rule.effect.operation === 'insert') {
    const envelope = compiled.effect_envelope;
    if (effects.length !== 1 || envelopes.length !== 1 || compiled.target_resource.name !== child.resource.name
      || envelope.conflict_key !== undefined || envelope.version_advance !== undefined
      || !envelope.deduplication?.components.some(c => c.column === child.resource.primary_key && c.source === 'proposal_id')) unsupported();
    const supplied = new Set([...Object.keys(compiled.rule.effect.set), ...envelope.deduplication.components.map(c => c.column),
      envelope.tenant_key, envelope.principal_scope_key]);
    if (child.resource.fields.some(field => !supplied.has(field.name))) unsupported();
    // The inserted row joins the one already verified and locked parent. Scope
    // components are supplied by trusted context, never business inputs.
    for (const pair of actionRuleRelationshipPairs(child.relationship!)) {
      if (pair.local_field === envelope.tenant_key && pair.target_field === parent.resource.tenant_key) continue;
      if (pair.local_field === envelope.principal_scope_key && pair.target_field === parent.resource.principal_scope_key) continue;
      const value = compiled.rule.effect.set[pair.local_field];
      if (value?.kind !== 'field' || value.binding !== parent.binding || value.field !== pair.target_field) unsupported();
    }
    for (const alias of compiled.bindings.filter(b => b.resource.name === child.resource.name)) {
      if (alias.verification.cardinality !== 'many' || alias.verification.collection_consistency !== 'complete_locked'
        || alias.verification.source.kind !== 'relationship' || alias.verification.source.from_binding !== parent.binding
        || alias.verification.source.direction !== 'inverse' || !alias.relationship
        || canonicalJsonDigest(actionRuleRelationshipPairs(alias.relationship)) !== canonicalJsonDigest(actionRuleRelationshipPairs(child.relationship!))) unsupported();
    }
  } else for (const [i, effect] of effects.entries()) {
    const target = compiled.bindings.find(b => b.binding === effect.target_binding);
    const envelope = envelopes[i]!;
    const identity = new Set([target?.resource.primary_key, target?.resource.tenant_key, target?.resource.principal_scope_key,
      ...actionRuleRelationshipPairs(child.relationship!).flatMap(pair => [pair.local_field, pair.target_field])]);
    if (effect.operation !== 'update' || !target || target.verification.cardinality !== 'one'
      || ![child.resource.name, parent.resource.name].includes(effect.target_resource)
      || envelope.version_advance?.strategy !== 'integer_increment' || envelope.version_advance.column !== target.resource.version_field
      || envelope.conflict_key !== target.resource.version_field
      || Object.keys(effect.set).some(field => identity.has(field) || !target.verification.fields.some(f => f.name === field))) unsupported();
  }
  const condition = compileActionRuleBooleanPredicate({ compiled, expression: { kind: 'compare', operator: 'lte',
    left: { kind: 'aggregate', operation: 'sum', binding: child.binding, field: d.population.field,
      ...(d.population.where ? { where: d.population.where } : {}) },
    right: { kind: 'field', binding: parent.binding, field: d.limit.field } } });
  const material = { designation: d, condition };
  return { ...material, digest: canonicalJsonDigest(material) };
}

/** Project only the immutable approved effect over actual locked facts, preserving all aliases. */
export function checkHardLimitPostState(compiled: CompiledActionRuleV1, facts: ActionRuleFactSetV1,
  effect: DerivedActionEffectV1, inputs: Record<string, unknown>): void {
  const limit = compiled.hard_limit;
  if (!limit) return;
  const post = structuredClone(facts);
  for (const member of [effect, ...(effect.atomic_updates ?? [])]) {
    if (member.operation === 'single_row_insert') {
      projectInsert(compiled, post, member);
      continue;
    }
    if (member.operation !== 'single_row_update' || !member.expected_version || member.version_advance?.strategy !== 'integer_increment'
      || member.version_advance.column !== member.expected_version.column
      || member.tenant_guard?.value !== facts.trusted.tenant || member.principal_scope?.value !== facts.trusted.principal) unsupported();
    const population = member.resource === compiled.bindings.find(b => b.binding === limit.designation.limit.binding)!.resource.name
      ? limit.designation.limit.binding : limit.designation.population.binding;
    if (post.bindings[population]?.rows.filter(row => row[member.primary_key.column] === member.primary_key.value).length !== 1) unsupported();
    for (const binding of compiled.bindings.filter(b => b.resource.name === member.resource)) {
      for (const row of post.bindings[binding.binding]?.rows ?? []) {
        if (row[member.primary_key.column] !== member.primary_key.value) continue;
        const version = row[member.expected_version.column];
        if (version !== member.expected_version.value || typeof version !== 'number' || !Number.isSafeInteger(version + 1)) {
          throw new ActionRuleError('ACTION_RULE_AUTHORITY_STALE', 'Current authoritative facts no longer prove the proposal’s exact effect.');
        }
        Object.assign(row, member.set, { [member.expected_version.column]: version + 1 });
      }
    }
  }
  const decision = evaluateActionRuleApprovalPredicate({ compiled, facts: post, expression: limit.condition, inputs });
  if (decision.result === 'unknown') unsupported();
  if (decision.result === 'no_match') throw new HardLimitPostStateExceeded();
}
function projectInsert(compiled: CompiledActionRuleV1, post: ActionRuleFactSetV1, member: DerivedActionEffectV1): void {
  const d = compiled.hard_limit!.designation;
  const child = compiled.bindings.find(b => b.binding === d.population.binding)!;
  const parent = compiled.bindings.find(b => b.binding === d.limit.binding)!;
  if (compiled.rule.effect.operation !== 'insert' || member.resource !== child.resource.name || member.atomic_updates?.length
    || member.expected_version || member.version_advance || member.primary_key.value === undefined
    || member.tenant_guard?.value !== post.trusted.tenant || member.principal_scope?.value !== post.trusted.principal
    || !member.deduplication?.components.some(c => c.column === member.primary_key.column && c.source === 'proposal_id')) unsupported();
  const row: ActionRuleFactRowV1 = { ...member.set };
  const assign = (column: string, value: ActionRuleFactRowV1[string]) => {
    if (Object.hasOwn(row, column) && row[column] !== value) unsupported();
    row[column] = value;
  };
  for (const component of member.deduplication.components) assign(component.column, component.value);
  if (!member.tenant_guard || !member.principal_scope) unsupported();
  assign(member.tenant_guard.column, member.tenant_guard.value);
  assign(member.principal_scope.column, member.principal_scope.value);
  if (row[child.resource.primary_key] !== member.primary_key.value
    || child.resource.fields.some(field => !Object.hasOwn(row, field.name) || (!field.nullable && row[field.name] === null))
    || Object.keys(row).some(field => !child.resource.fields.some(f => f.name === field))) unsupported();
  const parents = post.bindings[parent.binding]?.rows;
  if (parents?.length !== 1 || !actionRuleRelationshipPairs(child.relationship!).every(pair =>
    row[pair.local_field] !== null && row[pair.local_field] === parents[0]![pair.target_field])) unsupported();
  for (const binding of compiled.bindings.filter(b => b.resource.name === child.resource.name)) {
    const rows = post.bindings[binding.binding]?.rows;
    if (!rows || rows.some(existing => existing[member.primary_key.column] === member.primary_key.value)) unsupported();
    rows.push(structuredClone(row));
  }
}

/** Internal decision signal; the current verifier binds it to the exact job before transport. */
export class HardLimitPostStateExceeded extends Error {}

/** Current activated effect inventory, never a host-supplied writer boolean/list. */
export function assertHardLimitWriterInventory(registry: RuntimeActionRuleRegistryV1, compiled: CompiledActionRuleV1): void {
  if (!compiled.hard_limit) return;
  const context = hardLimitContext(compiled);
  const participating = new Set(compiled.bindings.map(b => JSON.stringify([b.resource.engine,b.resource.source,b.resource.schema,b.resource.table])));
  for (const rule of registry.rules) {
    const current=rule.compiled;
    if (current.source!==compiled.source || current.effect_envelope.writeback.mode!=='direct_sql') continue;
    const targets=[{resource:current.target_resource,envelope:current.effect_envelope},
      ...(current.atomic_updates??[]).map((member,i)=>({resource:member.target_resource,envelope:current.effect_envelope.atomic_updates![i]!}))];
    if (targets.some(t=>participating.has(JSON.stringify([t.resource.engine,t.resource.source,t.resource.schema,t.resource.table])))
      && (current.hard_limit?.digest!==compiled.hard_limit.digest || hardLimitContext(current)!==context)) unsupported();
  }
}

/** Resolve alias-shaped meaning against the compiler's actual protected context.
 * This is an internal comparison; signed authority/digest formats are unchanged. */
function hardLimitContext(compiled: CompiledActionRuleV1): string {
  if (!compiled.hard_limit) unsupported();
  const d = compiled.hard_limit.designation;
  const binding = (name: string): CompiledRuleBindingV1 => {
    const found = compiled.bindings.find(b => b.binding === name);
    if (!found) unsupported();
    return found;
  };
  const parent = binding(d.limit.binding), child = binding(d.population.binding);
  const resource = (b: CompiledRuleBindingV1) => ({
    physical: [b.resource.engine, b.resource.source, b.resource.schema, b.resource.table],
    primary_key: b.resource.primary_key, tenant_key: b.resource.tenant_key ?? null,
    principal_scope_key: b.resource.principal_scope_key ?? null, version_field: b.resource.version_field ?? null,
    fields: [...b.resource.fields].sort((a,b) => a.name.localeCompare(b.name)),
    scope: b.verification.scope,
  });
  if (!child.relationship || child.verification.source.kind !== 'relationship') unsupported();
  return canonicalJsonDigest({ parent: resource(parent), child: resource(child),
    relationship: { pairs: actionRuleRelationshipPairs(child.relationship),
      direction: child.verification.source.direction, from_binding: child.verification.source.from_binding,
      cardinality: child.relationship.cardinality, nullable: child.relationship.nullable, target_unique: child.relationship.target_unique } });
}
