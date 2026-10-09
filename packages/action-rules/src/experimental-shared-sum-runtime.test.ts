import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest, type NormalizedWritebackJobV5 } from '@synapsor-runner/protocol';
import { createSemanticActionVerifier, evaluateSemanticActionEligibility } from './runtime.js';
import { compileExperimentalSharedSumProtection } from './experimental-shared-sum.js';
import { matchesActionRuleHardLimitRefusal } from './hard-limit-refusal.js';
import { ActionRuleError } from './errors.js';
import type { ActionRuleFactLoaderAdapterV1 } from './fact-loader.js';
import { experimentalSharedSumFixture } from './testing/experimental-shared-sum-fixture.js';

const time = '2026-10-09T00:00:01.000Z';
// Actual eligibility/proof/loader/verifier, controlled Source qualification.
// Synthetic job envelope, no approval ledger or native execution asserted.
async function setup(options: { credit?: number; waiver?: number; limitChange?: number; committed?: number;
  oldWaiver?: number; outcome?: 'waiver' | 'limit' } = {}) {
  const f = experimentalSharedSumFixture(options);
  if (options.committed) f.facts.bindings[f.cb]!.rows.push({ tenant_id: 't1', principal_id: 'p1', team_id: 'team1', credit_id: 'c1', version: 1, amount: options.committed });
  if (options.oldWaiver) for (const binding of [f.wb, 'waiver']) f.facts.bindings[binding]!.rows[0]!.amount = options.oldWaiver;
  const trace: string[] = [], plan = compileExperimentalSharedSumProtection(f);
  const adapter: ActionRuleFactLoaderAdapterV1 = { engine: 'postgres',
    async assertExperimentalSharedSumSource() { trace.push('protection'); },
    async assertCompleteCollection() { trace.push('complete'); },
    async assertRelationshipCompatible() { trace.push('relationship'); },
    async load(query) { trace.push(`load:${query.binding}:${query.lock}`); return structuredClone(f.facts.bindings[query.binding]?.rows ?? []); } };
  const outcome = options.outcome ?? 'waiver';
  const compiled = f.registry.rules.find(r => r.compiled.outcome === `shared.${outcome}`)!.compiled;
  const decision = await evaluateSemanticActionEligibility({ registry: f.registry, outcome: compiled.outcome,
    subjects: compiled.rule.subjects.map(s => ({ binding: s.binding, resource: s.resource,
      primary_key: { column: s.binding === 'team' ? 'team_id' : 'waiver_id', value: s.binding === 'team' ? 'team1' : 'w1' }, subject_ref_digest: canonicalJsonDigest(s.binding) })),
    trusted: f.facts.trusted, adapter, proposal_id: 'experimental_component', trusted_context_digest: canonicalJsonDigest('trusted'),
    evidence_provenance_digest: canonicalJsonDigest('evidence'), verified_at: time });
  if (decision.result !== 'eligible') throw new Error(JSON.stringify(decision));
  const effect = decision.semantic_authority.effect;
  const job: NormalizedWritebackJobV5 = { protocol_version: '5.0', job_id: 'experimental_component_job', proposal_id: 'experimental_component',
    approval_id: canonicalJsonDigest('synthetic component approval'), proposal_hash: canonicalJsonDigest('synthetic proposal'), source_id: effect.source,
    engine: 'postgres', operation: effect.operation, target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard, principal_scope: { schema_version: 'synapsor.principal-scope.v1', column: effect.principal_scope!.column,
        binding: 'principal', provider: 'environment', value_fingerprint: canonicalJsonDigest({ principal: effect.principal_scope!.value }), value: effect.principal_scope!.value } },
    allowed_columns: effect.allowed_columns, patch: effect.set, conflict_guard: { kind: 'version_column', column: effect.expected_version!.column,
      expected_value: effect.expected_version!.value }, version_advance: effect.version_advance, semantic_authority: decision.semantic_authority,
    idempotency_key: 'semantic:experimental_component', lease_expires_at: '2026-10-09T00:10:00.000Z', attempt_count: 1 };
  trace.length = 0;
  const verifier = createSemanticActionVerifier({ registry: f.registry, clock: () => time, experimental_shared_sum: plan });
  return { ...f, plan, adapter, trace, job, verifier };
}

describe('experimental shared SUM in the existing semantic verifier', () => {
  it('returns the exact job-bound typed hard-limit reason on a fresh overflow', async () => {
    const f = await setup({ committed: 300 });
    const error = await f.verifier({ job: f.job, factLoader: f.adapter }).catch(e => e);
    expect(error).toMatchObject({ code: 'ACTION_RULE_HARD_LIMIT_EXCEEDED', cause: 'hard_limit_exceeded',
      message: 'This change would exceed the reviewed hard limit.', binding: { invariant_digest: f.plan.digest } });
    expect(matchesActionRuleHardLimitRefusal(error, f.job)).toBe(true);
    expect(matchesActionRuleHardLimitRefusal(error, { ...f.job, job_id: 'other' })).toBe(false);
    expect(f.trace[0]).toBe('protection');
    expect(f.trace.indexOf('load:team:for_update')).toBeLessThan(f.trace.indexOf('load:credit_population:for_update'));
  });
  it('accepts a fresh smaller UPDATE and subtracts its previous contribution', async () => {
    const f = await setup({ committed: 300, oldWaiver: 100, waiver: 150 });
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).resolves.toMatchObject({ status: 'reverified' });
  });
  it('checks a proposed limit decrease through the same verifier', async () => {
    const f = await setup({ committed: 300, limitChange: 200, outcome: 'limit' });
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_HARD_LIMIT_EXCEEDED' });
  });
  it.each(['admission', 'verification'])('refuses missing Source capability during %s before loading rows', async stage => {
    const f = await setup(); delete f.adapter.assertExperimentalSharedSumSource;
    const call = stage === 'admission' ? f.verifier.admitSource : f.verifier;
    await expect(call({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_SCOPE_UNPROVEN', path: 'experimental.shared_sum.source_capability' });
    expect(f.trace).toEqual([]);
  });
  it('propagates uninspectable hidden effects before loading business facts', async () => {
    const f = await setup(); f.adapter.assertExperimentalSharedSumSource = async () => { throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'Native Source effects cannot be inspected.', 'source.hard_limit.opaque_effects'); };
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ path: 'source.hard_limit.opaque_effects' });
    expect(f.trace).toEqual([]);
  });
  it.each(['admission', 'verification'])('rechecks current participating inventory after the %s Source wait', async stage => {
    const f = await setup(); let registry = f.registry;
    f.adapter.assertExperimentalSharedSumSource = async () => { registry = experimentalSharedSumFixture({ credit: 100 }).registry; };
    const verifier = createSemanticActionVerifier({ registry: () => registry, clock: () => time, experimental_shared_sum: f.plan });
    const call = stage === 'admission' ? verifier.admitSource : verifier;
    await expect(call({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_AUTHORITY_STALE' });
    expect(f.trace).toEqual([]);
  });
  it('rechecks current authority after the complete-fact loading waits', async () => {
    const f = await setup(); let registry = f.registry;
    const original = f.adapter.load;
    f.adapter.load = async query => { const rows = await original(query); if (query.binding === 'waiver') registry = experimentalSharedSumFixture({ waiver: 100 }).registry; return rows; };
    const verifier = createSemanticActionVerifier({ registry: () => registry, clock: () => time, experimental_shared_sum: f.plan });
    await expect(verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_AUTHORITY_STALE' });
  });
  it('refuses a proof that expires during the Source admission wait', async () => {
    const f = await setup(); let now = time;
    f.adapter.assertExperimentalSharedSumSource = async () => { now = '2026-10-09T00:06:00.000Z'; };
    const verifier = createSemanticActionVerifier({ registry: f.registry, clock: () => now, experimental_shared_sum: f.plan });
    await expect(verifier.admitSource({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_AUTHORITY_STALE' });
    expect(f.trace).toEqual([]);
  });
  it('fails closed when UPDATE would erase an original negative Source contribution', async () => {
    const f = await setup({ oldWaiver: -1 });
    await expect(f.verifier({ job: f.job, factLoader: f.adapter })).rejects.toMatchObject({ code: 'ACTION_RULE_SCOPE_UNPROVEN', path: 'experimental.shared_sum.facts_integer' });
  });
  it('keeps the default verifier unmarked and preserves the pre-state behavior', async () => {
    const f = await setup({ committed: 300 }); delete f.adapter.assertExperimentalSharedSumSource;
    const ordinary = createSemanticActionVerifier({ registry: f.registry, clock: () => time });
    await expect(ordinary({ job: f.job, factLoader: f.adapter })).resolves.toMatchObject({ status: 'reverified' });
  });
});
