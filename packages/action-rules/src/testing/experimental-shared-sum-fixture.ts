import type { ActionRuleBooleanExpressionV1, ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from '@synapsor/spec';
import { createActionRuleAuthority } from '../authority.js';
import type { ActionRuleCatalogV1, ActionRuleFactSetV1 } from '../types.js';
import type { ExperimentalSharedSumDesignationV1 } from '../experimental-shared-sum.js';

/** Synthetic reviewed native-experiment input. Production compiler/verifier;
 * no public authority, customer grants, ledger edits or activation asserted. */
export function experimentalSharedSumFixture(options: { credit?: number; waiver?: number; limitChange?: number;
  schema?: string; unit?: string | null; engine?: 'postgres' | 'mysql'; creditBinding?: string; waiverBinding?: string } = {}) {
  const schema = options.schema ?? 'shared_fixture', source = 'experimental_database';
  const id = { kind: 'string', max_length: 64, comparison: 'exact' } as const;
  const amount = { kind: 'integer', ...(options.unit === null ? {} : { unit: options.unit ?? 'reviewed_credits' }) } as const;
  const version = { kind: 'integer' } as const;
  const digest = `sha256:${'a'.repeat(64)}` as const, engine = options.engine ?? 'postgres';
  const scope = { mode: 'columns', tenant_field: 'tenant_id', principal_field: 'principal_id' } as const;
  const rootFields = [{ name: 'tenant_id', type: id, nullable: false }, { name: 'principal_id', type: id, nullable: false },
    { name: 'team_id', type: id, nullable: false }, { name: 'version', type: version, nullable: false }];
  const catalog: ActionRuleCatalogV1 = { schema_version: 'synapsor.action-rule-catalog.v1', generation_lock_fingerprint: digest,
    resources: [
      { name: `${schema}.teams`, source, engine, schema, table: 'teams', primary_key: 'team_id', tenant_key: 'tenant_id',
        principal_scope_key: 'principal_id', version_field: 'version', fields: [...rootFields, { name: 'limit', type: amount, nullable: false }] },
      ...['credits', 'waivers'].map((table) => ({ name: `${schema}.${table}`, source, engine, schema, table,
        primary_key: table === 'credits' ? 'credit_id' : 'waiver_id', tenant_key: 'tenant_id', principal_scope_key: 'principal_id',
        version_field: 'version', fields: [...rootFields, { name: table === 'credits' ? 'credit_id' : 'waiver_id', type: id, nullable: false },
          { name: 'amount', type: amount, nullable: false }] })),
    ], relationships: ['credits', 'waivers'].map(table => ({ name: `${table}_team_fk`, from_resource: `${schema}.${table}`,
      to_resource: `${schema}.teams`, cardinality: 'many_to_one', nullable: false, target_unique: true,
      field_pairs: ['tenant_id', 'principal_id', 'team_id'].map(field => ({ local_field: field, target_field: field })) })) };
  const cb = options.creditBinding ?? 'credit_population', wb = options.waiverBinding ?? 'waiver_population';
  const base: RuleVerificationBoundarySpecV1 = { schema_version: 'synapsor.verification-boundary.v1', name: 'shared.verify',
    source, context: 'team', generation_lock_fingerprint: digest,
    resources: [{ binding: 'team', resource: `${schema}.teams`, source: { kind: 'subject_ref' }, primary_key: 'team_id', version_field: 'version',
      fields: catalog.resources[0]!.fields, scope, cardinality: 'one', max_rows: 1, overflow: 'unsupported', lock: 'for_update' },
    ...[cb, wb].map((binding, i) => ({ binding, resource: catalog.resources[i + 1]!.name,
      source: { kind: 'relationship' as const, from_binding: 'team', relationship: catalog.relationships[i]!.name,
        direction: 'inverse' as const, field_pairs: catalog.relationships[i]!.field_pairs! },
      primary_key: catalog.resources[i + 1]!.primary_key, version_field: 'version', fields: catalog.resources[i + 1]!.fields,
      scope, cardinality: 'many' as const, collection_consistency: 'complete_locked' as const, max_rows: 20,
      overflow: 'unsupported' as const, deterministic_order: [{ field: catalog.resources[i + 1]!.primary_key, direction: 'asc' as const }], lock: 'for_update' as const }))],
    lock_order: ['team', cb, wb], transaction: { isolation: engine === 'postgres' ? 'read_committed' : 'repeatable_read', timezone: 'UTC' } };
  const require: ActionRuleBooleanExpressionV1 = { kind: 'compare', operator: 'lte',
    left: { kind: 'math', operation: 'add', inputs: [cb, wb].map(binding => ({ kind: 'aggregate', operation: 'sum', binding, field: 'amount' })) },
    right: { kind: 'field', binding: 'team', field: 'limit' } };
  function entry(kind: 'credit' | 'waiver' | 'limit') {
    const boundary = structuredClone(base), target = kind === 'credit' ? catalog.resources[1]! : kind === 'waiver' ? catalog.resources[2]! : catalog.resources[0]!;
    const binding = kind === 'waiver' ? 'waiver' : kind === 'limit' ? 'team' : undefined;
    if (kind === 'waiver') {
      const single = structuredClone(base.resources[2]!);
      Object.assign(single, { binding: 'waiver', source: { kind: 'subject_ref' }, cardinality: 'one', max_rows: 1 });
      delete single.collection_consistency; delete single.deterministic_order;
      boundary.resources.push(single); boundary.lock_order.push('waiver');
    }
    const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: 'synapsor.derived-effect-envelope.v1', name: `shared.${kind}_effect`, source,
      operation: kind === 'credit' ? 'insert' : 'update', target_resource: target.name, ...(binding ? { target_binding: binding } : {}),
      primary_key: target.primary_key, tenant_key: 'tenant_id', principal_scope_key: 'principal_id', max_rows: 1,
      allowed_fields: kind === 'credit' ? [{ name: 'team_id', type: id }, { name: 'amount', type: amount, minimum: 0, maximum: 1000 }, { name: 'version', type: version, minimum: 1, maximum: 1 }]
        : [{ name: kind === 'waiver' ? 'amount' : 'limit', type: amount, minimum: 0, maximum: 1000 }],
      ...(kind === 'credit' ? { deduplication: { components: [{ column: 'credit_id', source: 'proposal_id' as const }, { column: 'tenant_id', source: 'trusted_tenant' as const }] } }
        : { conflict_key: 'version', version_advance: { column: 'version', strategy: 'integer_increment' as const } }),
      approval_classes: ['shared.review'], writeback: { mode: 'direct_sql', supervised_worker: 'allowed' } };
    const rule: ActionRuleSpecV1 = { schema_version: 'synapsor.action-rule.v1', name: `shared.${kind}`, outcome: `shared.${kind}`, context: 'team', source,
      verification_boundary_ref: boundary.name, effect_envelope_ref: envelope.name,
      subjects: [{ binding: 'team', resource: catalog.resources[0]!.name, input: 'opaque_subject_ref' },
        ...(kind === 'waiver' ? [{ binding: 'waiver', resource: target.name, input: 'opaque_subject_ref' as const }] : [])],
      require: structuredClone(require), derive: {},
      effect: kind === 'credit' ? { operation: 'insert', target_resource: target.name, set: {
        team_id: { kind: 'field', binding: 'team', field: 'team_id' }, amount: { kind: 'literal', value: options.credit ?? 300, value_type: amount },
        version: { kind: 'literal', value: 1, value_type: version } } }
        : { operation: 'update', target_resource: target.name, target_binding: binding!, set: {
          [kind === 'waiver' ? 'amount' : 'limit']: { kind: 'literal', value: kind === 'waiver' ? options.waiver ?? 250 : options.limitChange ?? 500, value_type: amount } } },
      approval_class: 'shared.review', ttl_seconds: 300 };
    return { read_boundary_name: 'shared.read', read_boundary_digest: digest, rule, verification_boundary: boundary,
      effect_envelope: envelope, activated_at: '2026-10-09T00:00:00.000Z' };
  }
  const entries = [entry('credit'), entry('waiver'), entry('limit')];
  const authority = createActionRuleAuthority({ name: 'shared_native_experiment', action_boundary_name: 'shared.actions', catalog, rules: entries });
  const team = { tenant_id: 't1', principal_id: 'p1', team_id: 'team1', version: 1, limit: 500 };
  const waiver = { tenant_id: 't1', principal_id: 'p1', team_id: 'team1', waiver_id: 'w1', version: 1, amount: 0 };
  const facts: ActionRuleFactSetV1 = { bindings: { team: { rows: [team] }, [cb]: { rows: [] }, [wb]: { rows: [waiver] }, waiver: { rows: [structuredClone(waiver)] } },
    trusted: { tenant: 't1', principal: 'p1', transaction_time: '2026-10-09T00:00:00.000Z' }, subject_provenance_digest: digest };
  const designation: ExperimentalSharedSumDesignationV1 = { schema_version: 'synapsor.experimental.shared-sum-protection.v1', kind: 'experimental_shared_sum', source,
    scope: { tenant_field: 'tenant_id', principal_field: 'principal_id' }, limit: { resource: `${schema}.teams`, field: 'limit' },
    populations: [{ resource: `${schema}.credits`, field: 'amount' }, { resource: `${schema}.waivers`, field: 'amount' }], time: 'current_state', external_writers: 'participating_only' };
  return { catalog, entries, authority, registry: authority.registry, facts, designation, cb, wb };
}
