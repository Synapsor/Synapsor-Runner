import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { normalizeActionRuleCatalog } from '../normalize.js';
import { createActionRuleAuthority } from '../authority.js';
import { experimentalSharedSumFixture } from './experimental-shared-sum-fixture.js';
import { parseWeightedSharedSumDesignation } from '../weighted-shared-sum-designation.js';
import { buildWeightedConstraintState } from '../weighted-constraint-state.js';
const money = { kind: 'money_minor' as const, currency: 'USD' };
const minutes = { kind: 'integer' as const, unit: 'minutes' }, hours = { kind: 'integer' as const, unit: 'support_hours' };
export function weightedConstraintFixture(options: { credit?: number; waiver?: number; sharedPopulation?: boolean; third?: boolean } = {}) {
  const f = experimentalSharedSumFixture({ unit: 'minutes' });
  const root = f.catalog.resources[0]!, discounts = f.catalog.resources[2]!;
  root.fields.find(field => field.name === 'limit')!.type = money;
  root.fields.push({ name: 'starts_at', type: { kind: 'timestamp' }, nullable: false },
    { name: 'ends_at', type: { kind: 'timestamp' }, nullable: false },
    { name: 'minutes_cap', type: minutes, nullable: false }, { name: 'discount_cap', type: money, nullable: false });
  discounts.fields.find(field => field.name === 'amount')!.type = money;
  if (options.sharedPopulation) f.catalog.resources[1]!.fields.push({ name: 'discount_cents', type: money, nullable: false });
  Object.assign(f.facts.bindings.team!.rows[0]!, { limit: 12000, minutes_cap: 3000, discount_cap: 10000,
    starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-11-01T00:00:00.000Z' });
  let entries = options.sharedPopulation ? [f.entries[0]!, f.entries[2]!] : f.entries;
  for (const entry of entries) {
    if (options.sharedPopulation) {
      entry.verification_boundary.resources = entry.verification_boundary.resources.filter(b => b.binding !== f.wb);
      entry.verification_boundary.lock_order = entry.verification_boundary.lock_order.filter(b => b !== f.wb);
    }
    for (const b of entry.verification_boundary.resources) b.fields = structuredClone(f.catalog.resources.find(r => r.name === b.resource)!.fields);
    for (const a of entry.effect_envelope.allowed_fields) {
      a.type = structuredClone(f.catalog.resources.find(r => r.name === entry.effect_envelope.target_resource)!.fields.find(field => field.name === a.name)!.type);
      if (a.name === 'amount' || a.name === 'limit') a.maximum = 20000;
      const value = entry.rule.effect.set[a.name]; if (value?.kind === 'literal') {
        value.value_type = structuredClone(a.type);
        if (a.name === 'amount') value.value = entry.rule.outcome === 'shared.credit' ? options.credit ?? 3000 : options.waiver ?? 6000;
        if (a.name === 'limit') value.value = 12000;
      }
    }
    if (options.sharedPopulation && entry.rule.effect.operation === 'insert') {
      entry.effect_envelope.allowed_fields.push({ name: 'discount_cents', type: money, minimum: 0, maximum: 20000 });
      entry.rule.effect.set.discount_cents = { kind: 'literal', value: options.waiver ?? 4000, value_type: money };
    }
    entry.rule.require = { kind: 'all', expressions: [
      { kind: 'compare', operator: 'lte', left: { kind: 'aggregate', operation: 'sum', binding: f.cb, field: 'amount' }, right: { kind: 'field', binding: 'team', field: 'minutes_cap' } },
      { kind: 'compare', operator: 'lte', left: { kind: 'aggregate', operation: 'sum', binding: options.sharedPopulation ? f.cb : f.wb, field: options.sharedPopulation ? 'discount_cents' : 'amount' }, right: { kind: 'field', binding: 'team', field: 'discount_cap' } },
    ] };
  }
  if (options.third) {
    const support = structuredClone(f.catalog.resources[1]!);
    Object.assign(support, { name: 'shared_fixture.support', table: 'support', primary_key: 'support_id' });
    support.fields.find(field => field.name === 'credit_id')!.name = 'support_id';
    support.fields.find(field => field.name === 'amount')!.type = hours;
    const relationship = { ...structuredClone(f.catalog.relationships[0]!), name: 'support_team_fk', from_resource: support.name };
    f.catalog.resources.push(support); f.catalog.relationships.push(relationship);
    for (const entry of entries) {
      const b = structuredClone(entry.verification_boundary.resources.find(b => b.binding === f.cb)!);
      Object.assign(b, { binding: 'support_population', resource: support.name, primary_key: support.primary_key, fields: structuredClone(support.fields),
        source: { kind: 'relationship', from_binding: 'team', relationship: relationship.name, direction: 'inverse', field_pairs: relationship.field_pairs },
        deterministic_order: [{ field: support.primary_key, direction: 'asc' }] });
      entry.verification_boundary.resources.push(b); entry.verification_boundary.lock_order.push(b.binding);
    }
    const entry = structuredClone(entries[0]!);
    Object.assign(entry.rule, { name: 'shared.support', outcome: 'shared.support' });
    Object.assign(entry.effect_envelope, { name: 'shared.support_effect', target_resource: support.name, primary_key: support.primary_key });
    entry.rule.effect.target_resource = support.name;
    entry.rule.effect.set.amount = { kind: 'literal', value: 2, value_type: hours };
    entry.effect_envelope.allowed_fields.find(a => a.name === 'amount')!.type = hours;
    entry.effect_envelope.deduplication!.components[0]!.column = support.primary_key;
    entry.rule.effect_envelope_ref = entry.effect_envelope.name;
    entries = [...entries, entry]; f.facts.bindings.support_population = { rows: [] };
  }
  const registry = createActionRuleAuthority({ name: 'weighted_compiler_data', action_boundary_name: 'weighted.actions', catalog: f.catalog, rules: entries }).registry;
  const provenance = { source_session: '12345678-1234-1234-1234-123456789abc', source_digest: canonicalJsonDigest('synthetic policy'), store_digest: canonicalJsonDigest('synthetic store'), start: 1, end: 4 };
  const valuation = (input_unit: typeof minutes | typeof money | typeof hours, numerator: string) => ({ input_unit, output_unit: money, numerator, denominator: '1', version: 'policy.v1', provenance });
  const designation = parseWeightedSharedSumDesignation({ schema_version: 'synapsor.shared-sum-designation.v2', kind: 'weighted_shared_sum', source: f.catalog.resources[0]!.source,
    scope: { tenant_field: 'tenant_id', principal_field: 'principal_id' }, guard: { resource: root.name, identity_field: 'team_id', period_start_field: 'starts_at', period_end_field: 'ends_at' },
    populations: [{ id: 'minutes', resource: f.catalog.resources[1]!.name, guard_relationship: f.catalog.relationships[0]!.name },
      ...(!options.sharedPopulation ? [{ id: 'discounts', resource: discounts.name, guard_relationship: f.catalog.relationships[1]!.name }] : []),
      ...(options.third ? [{ id: 'support', resource: 'shared_fixture.support', guard_relationship: 'support_team_fk' }] : [])],
    measures: [{ id: 'minutes', population: 'minutes', field: 'amount', input_unit: minutes, meaning: 'Service minutes.', valuation: valuation(minutes, '2'), raw_cap: { resource: root.name, field: 'minutes_cap' } },
      { id: 'discounts', population: options.sharedPopulation ? 'minutes' : 'discounts', field: options.sharedPopulation ? 'discount_cents' : 'amount', input_unit: money, meaning: 'USD discounts.', valuation: valuation(money, '1'), raw_cap: { resource: root.name, field: 'discount_cap' } },
      ...(options.third ? [{ id: 'support', population: 'support', field: 'amount', input_unit: hours, meaning: 'Support hours.', valuation: valuation(hours, '2000') }] : [])],
    limit: { resource: root.name, field: 'limit', unit: money, meaning: 'Combined USD minor-unit goodwill.' }, period: { kind: 'utc_calendar_month', interval: 'half_open', attribution: 'host_execution_admission' },
    revaluation: 'complete_selected_period_current_state', external_writers: 'participating_only', participating_outcomes: registry.rules.map(r => r.compiled.outcome) });
  const state = buildWeightedConstraintState(registry, designation);
  const shared_sum = { schema_version: 'synapsor.reviewed-shared-sum.v2' as const, designation,
    confirmation: { actor: 'local_installation_operator' as const, decision: 'new_attributed_decision' as const,
      recorded_at: '2026-10-09T00:00:00.000Z', question: { id: '00000000-0000-4000-8000-000000000001', revision: 1, digest: canonicalJsonDigest('synthetic question') },
      proposal_digest: canonicalJsonDigest('synthetic proposal'), context_digest: canonicalJsonDigest('synthetic context'),
      source_digest: canonicalJsonDigest('synthetic source'), catalog_digest: canonicalJsonDigest(normalizeActionRuleCatalog(f.catalog)),
      generation_lock_fingerprint: f.catalog.generation_lock_fingerprint, read_dependencies: [{ name: 'shared.read', digest: f.entries[0]!.read_boundary_digest }],
      designation_digest: canonicalJsonDigest(designation) } };
  return { ...f, entries, registry, designation, state, shared_sum };
}
