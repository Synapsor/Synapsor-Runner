import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { actionRuleRelationshipPairs } from './relationships.js';
import type { ActionRuleFactRowV1, ActionRuleFactSetV1, CompiledActionRuleV1,
  CompiledRuleBindingV1, DerivedActionEffectV1 } from './types.js';

/** Internal compiler-derived population inventory, not caller authority. One
 * population may supply several measures; its effect is projected once. */
export type BoundedInvariantContext = Readonly<{ parent: CompiledRuleBindingV1;
  populations: readonly CompiledRuleBindingV1[] }>;
type Refuse = (stage: string) => never;
function rowScope(b: CompiledRuleBindingV1, row: ActionRuleFactRowV1, facts: ActionRuleFactSetV1): boolean {
  return typeof facts.trusted.tenant === 'string' && typeof facts.trusted.principal === 'string'
    && row[b.resource.tenant_key!] === facts.trusted.tenant && row[b.resource.principal_scope_key!] === facts.trusted.principal;
}
export function validateBoundedInvariantRows(ctx: BoundedInvariantContext, facts: ActionRuleFactSetV1, refuse: Refuse): void {
  const parents = facts.bindings[ctx.parent.binding]?.rows;
  if (!parents || parents.length !== 1 || !rowScope(ctx.parent, parents[0]!, facts)) refuse('facts_scope');
  for (const b of [ctx.parent, ...ctx.populations]) {
    const rows = facts.bindings[b.binding]?.rows;
    if (!rows || rows.length > b.verification.max_rows || new Set(rows.map(row => canonicalJsonDigest(row[b.resource.primary_key]))).size !== rows.length
      || rows.some(row => row[b.resource.primary_key] === undefined || !rowScope(b, row, facts)
        || (b.relationship && !actionRuleRelationshipPairs(b.relationship).every(p => row[p.local_field] !== null && row[p.local_field] === parents[0]![p.target_field])))) refuse('facts_membership');
  }
}
function integer(value: unknown, refuse: Refuse): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refuse('facts_integer');
  return value;
}
/** Projects the already-verified effect; never executes it. The existing host
 * verifier owns approval/effect identity. Callers validate original quantities
 * before replacement, so projection cannot repair missing/invalid facts. */
export function projectBoundedInvariantEffect(ctx: BoundedInvariantContext, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1, refuse: Refuse): ActionRuleFactSetV1 {
  validateBoundedInvariantRows(ctx, facts, refuse);
  const post = structuredClone(facts);
  if (effect.atomic_updates?.length || effect.source !== compiled.source
    || effect.resource !== compiled.target_resource.name || effect.schema !== compiled.target_resource.schema || effect.table !== compiled.target_resource.table
    || effect.primary_key.column !== compiled.target_resource.primary_key || effect.primary_key.value === undefined
    || !effect.tenant_guard || effect.tenant_guard.column !== compiled.target_resource.tenant_key || effect.tenant_guard.value !== facts.trusted.tenant
    || !effect.principal_scope || effect.principal_scope.column !== compiled.target_resource.principal_scope_key || effect.principal_scope.value !== facts.trusted.principal) refuse('effect_identity');
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
      const version = integer(row[effect.expected_version.column], refuse);
      if (version !== effect.expected_version.value || !Number.isSafeInteger(version + 1)) refuse('effect_version');
      Object.assign(row, effect.set, { [effect.expected_version.column]: version + 1 });
    }
  }
  validateBoundedInvariantRows(ctx, post, refuse);
  return post;
}
