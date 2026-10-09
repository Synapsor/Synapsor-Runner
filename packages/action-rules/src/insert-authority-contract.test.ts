import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest, parseSemanticAuthority } from '@synapsor-runner/protocol';
import { compileActionRule } from './compile.js';
import { createActionRuleAuthority } from './authority.js';
import { compileExperimentalSharedSumProtection } from './experimental-shared-sum.js';
import { evaluateSemanticActionEligibility } from './runtime.js';
import { experimentalSharedSumFixture } from './testing/experimental-shared-sum-fixture.js';

// Real eligibility/authority parser, controlled fact adapter only. The retained
// independent PG FIRST-BREAK is native evidence; these are components, no jobs.
describe('compiled INSERT agrees with the existing semantic authority contract', () => {
  it('produces a parseable credit INSERT authority with proposal and trusted tenant deduplication', async () => {
    const f = experimentalSharedSumFixture();
    const plan = compileExperimentalSharedSumProtection(f);
    expect(plan.disposition).toBe('EXPERIMENTAL_NO_PUBLIC_ACTIVATION');
    const decision = await evaluateSemanticActionEligibility({ registry: f.registry, outcome: 'shared.credit',
      subjects: [{ binding: 'team', resource: 'shared_fixture.teams', primary_key: { column: 'team_id', value: 'team1' },
        subject_ref_digest: canonicalJsonDigest('team') }], trusted: f.facts.trusted,
      adapter: { engine: 'postgres', async assertCompleteCollection() {}, async assertRelationshipCompatible() {},
        async load(query) { return structuredClone(f.facts.bindings[query.binding]?.rows ?? []); } },
      proposal_id: 'insert_authority_component', trusted_context_digest: canonicalJsonDigest('trusted'),
      evidence_provenance_digest: canonicalJsonDigest('evidence'), verified_at: '2026-10-09T00:00:01.000Z' });
    expect(decision.result).toBe('eligible');
    if (decision.result !== 'eligible') throw new Error('Fixture is not eligible');
    expect(() => parseSemanticAuthority(decision.semantic_authority)).not.toThrow();
    expect(decision.semantic_authority.effect.deduplication?.components).toEqual(expect.arrayContaining([
      { column: 'credit_id', source: 'proposal_id', value: 'insert_authority_component' },
      { column: 'tenant_id', source: 'trusted_tenant', value: 't1' },
    ]));
    expect(() => compileExperimentalSharedSumProtection(f)).not.toThrow();
  });
  it.each(['missing_tenant', 'wrong_tenant_column', 'missing_proposal'] as const)('refuses %s before issuing compiled authority or an opaque plan', failure => {
    const f = experimentalSharedSumFixture(), entry = f.entries[0]!;
    // Normalize the positive declaration before applying this exact mutation,
    // so the same test genuinely reaches both old and corrected compilers.
    entry.effect_envelope.deduplication = { components: [{ column: 'credit_id', source: 'proposal_id' }, { column: 'tenant_id', source: 'trusted_tenant' }] };
    if (failure === 'missing_tenant') entry.effect_envelope.deduplication.components.pop();
    if (failure === 'wrong_tenant_column') entry.effect_envelope.deduplication.components[1]!.column = 'principal_id';
    if (failure === 'missing_proposal') entry.effect_envelope.deduplication.components.shift();
    const rejection = { code: 'ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY', path: 'effect_envelope.deduplication' };
    let compilerError: unknown, authorityError: unknown, issuedPlan: unknown;
    try { compileActionRule({ catalog: f.catalog, rule: entry.rule,
      verification_boundary: entry.verification_boundary, effect_envelope: entry.effect_envelope }); } catch (error) { compilerError = error; }
    try {
      const authority = createActionRuleAuthority({ name: 'invalid_insert', action_boundary_name: 'shared.actions', catalog: f.catalog, rules: f.entries });
      issuedPlan = compileExperimentalSharedSumProtection({ registry: authority.registry, designation: f.designation });
    } catch (error) { authorityError = error; }
    expect(compilerError, `invalid declaration issued opaque plan: ${JSON.stringify(issuedPlan)}`).toMatchObject(rejection);
    expect(authorityError).toMatchObject(rejection);
    expect(issuedPlan).toBeUndefined();
  });
});
