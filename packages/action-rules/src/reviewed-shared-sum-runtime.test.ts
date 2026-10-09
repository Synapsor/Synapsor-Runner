import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest, type NormalizedWritebackJobV5 } from '@synapsor-runner/protocol';
import { createSemanticActionVerifier, evaluateSemanticActionEligibility } from './runtime.js';
import { matchesActionRuleHardLimitRefusal } from './hard-limit-refusal.js';
import { reviewedSharedSumFixture } from './testing/reviewed-shared-sum-fixture.js';

const time = '2026-10-09T00:00:01.000Z';
async function setup(options: { committed?: number; waiver?: number; limitChange?: number; outcome?: 'waiver' | 'limit' } = {}) {
  const f = reviewedSharedSumFixture(options), trace: string[] = [];
  if (options.committed) f.facts.bindings[f.cb]!.rows.push({ tenant_id: 't1', principal_id: 'p1', team_id: 'team1',
    credit_id: 'c1', version: 1, amount: options.committed });
  const adapter = { engine: 'postgres' as const,
    async assertReviewedSharedSumSource() { trace.push('protection'); },
    async assertCompleteCollection() { trace.push('complete'); },
    async assertRelationshipCompatible() { trace.push('relationship'); },
    async load(query: { binding: string; lock: string }) {
      trace.push(`load:${query.binding}:${query.lock}`);
      return structuredClone(f.facts.bindings[query.binding]?.rows ?? []);
    } };
  const compiled = f.registry.rules.find(r => r.compiled.outcome === `shared.${options.outcome ?? 'waiver'}`)!.compiled;
  const decision = await evaluateSemanticActionEligibility({ registry: f.registry, outcome: compiled.outcome,
    subjects: compiled.rule.subjects.map(s => ({ binding: s.binding, resource: s.resource,
      primary_key: { column: s.binding === 'team' ? 'team_id' : 'waiver_id', value: s.binding === 'team' ? 'team1' : 'w1' },
      subject_ref_digest: canonicalJsonDigest(s.binding) })), trusted: f.facts.trusted, adapter,
    proposal_id: 'reviewed_component', trusted_context_digest: canonicalJsonDigest('trusted'),
    evidence_provenance_digest: canonicalJsonDigest('evidence'), verified_at: time });
  if (decision.result !== 'eligible') throw new Error(JSON.stringify(decision));
  const effect = decision.semantic_authority.effect;
  const job: NormalizedWritebackJobV5 = { protocol_version: '5.0', job_id: 'reviewed_component_job', proposal_id: 'reviewed_component',
    approval_id: canonicalJsonDigest('component approval'), proposal_hash: canonicalJsonDigest('component proposal'), source_id: effect.source,
    engine: 'postgres', operation: 'single_row_update', target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard, principal_scope: { schema_version: 'synapsor.principal-scope.v1', column: effect.principal_scope!.column,
        binding: 'principal', provider: 'environment', value_fingerprint: canonicalJsonDigest({ principal: effect.principal_scope!.value }),
        value: effect.principal_scope!.value } }, allowed_columns: effect.allowed_columns, patch: effect.set,
    conflict_guard: { kind: 'version_column', column: effect.expected_version!.column, expected_value: effect.expected_version!.value },
    version_advance: effect.version_advance, semantic_authority: decision.semantic_authority, idempotency_key: 'semantic:reviewed_component',
    lease_expires_at: '2026-10-09T00:10:00.000Z', attempt_count: 1 };
  trace.length = 0;
  const verifier = createSemanticActionVerifier({ registry: f.registry, clock: () => time });
  return { ...f, adapter, trace, job, verifier };
}

describe('persisted shared SUM is compulsory in the existing verifier', () => {
  it('reconstructs protection without a host experiment flag and refuses a fresh overshoot', async () => {
    const f = await setup({ committed: 300 });
    const error = await f.verifier({ job: f.job, factLoader: f.adapter }).catch(e => e);
    expect(error).toMatchObject({ code: 'ACTION_RULE_HARD_LIMIT_EXCEEDED', cause: 'hard_limit_exceeded' });
    expect(matchesActionRuleHardLimitRefusal(error, f.job)).toBe(true);
    expect(f.trace[0]).toBe('protection');
    expect(f.trace.indexOf('load:team:for_update')).toBeLessThan(f.trace.indexOf('load:credit_population:for_update'));
  });
  it('admits a smaller fresh change after the committed contribution', async () => {
    const f = await setup({ committed: 300, waiver: 100 });
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).resolves.toMatchObject({ status: 'reverified' });
    expect(f.trace[0]).toBe('protection');
  });
  it('checks a proposed limit decrease too', async () => {
    const f = await setup({ committed: 300, limitChange: 299, outcome: 'limit' });
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_HARD_LIMIT_EXCEEDED' });
  });
  it('refuses absent Source inspection before loading facts', async () => {
    const f = await setup();
    const { assertReviewedSharedSumSource: _removed, ...adapter } = f.adapter;
    await expect(f.verifier({ job: f.job, factLoader: adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_SCOPE_UNPROVEN' });
    expect(f.trace).toEqual([]);
  });
  it('refuses absent Source inspection during early admission', async () => {
    const f = await setup();
    const { assertReviewedSharedSumSource: _removed, ...adapter } = f.adapter;
    await expect(f.verifier.admitSource({ job: f.job, factLoader: adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_SCOPE_UNPROVEN' });
    expect(f.trace).toEqual([]);
  });
  it('refuses an authority changed while Source inspection waited, before reading facts', async () => {
    const f = await setup();
    let current = f.registry;
    f.adapter.assertReviewedSharedSumSource = async () => {
      f.trace.push('protection');
      current = reviewedSharedSumFixture({ credit: 100 }).registry;
    };
    const verifier = createSemanticActionVerifier({ registry: () => current, clock: () => time });
    await expect(verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_AUTHORITY_STALE' });
    expect(f.trace).toEqual(['protection']);
  });
});
