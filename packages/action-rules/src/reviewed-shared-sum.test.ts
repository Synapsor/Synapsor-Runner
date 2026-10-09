import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createActionRuleAuthority, parseActionRuleAuthority } from './authority.js';
import { createActionRuleRegistry } from './registry.js';
import { deriveReviewedSharedSumProtection, resolveReviewedSharedSumProtection, reviewedSharedSumGuardIdentity } from './reviewed-shared-sum.js';
import { reviewedSharedSumFixture } from './testing/reviewed-shared-sum-fixture.js';

describe('reviewed shared SUM complete authoritative inventory', () => {
  it('survives serialization and derives mandatory plans without an issued-plan cache', () => {
    const f = reviewedSharedSumFixture(), restored = parseActionRuleAuthority(JSON.parse(JSON.stringify(f.authority.authority)));
    expect(restored.registry.schema_version).toBe('synapsor.action-rule-registry.v2');
    const plan = deriveReviewedSharedSumProtection(restored.registry)!;
    expect(resolveReviewedSharedSumProtection(plan, restored.registry, restored.registry.rules[0]!.compiled)).toEqual({ digest: plan.digest });
  });
  it('refuses a changed unit even when its designation digest is recomputed', () => {
    const f = reviewedSharedSumFixture(), shared_sum = structuredClone(f.shared_sum);
    shared_sum.designation.unit.unit = 'other_units';
    shared_sum.confirmation.designation_digest = canonicalJsonDigest(shared_sum.designation);
    expect(() => createActionRuleAuthority({ name: 'changed', action_boundary_name: 'shared.actions', catalog: f.catalog,
      rules: f.entries, shared_sum })).toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('refuses a hidden physical alias writer whose formula omits the invariant', () => {
    const f = reviewedSharedSumFixture(), entries = structuredClone(f.entries);
    entries[2]!.rule.require = { kind: 'compare', operator: 'eq',
      left: { kind: 'literal', value: true, value_type: { kind: 'boolean' } },
      right: { kind: 'literal', value: true, value_type: { kind: 'boolean' } } };
    expect(() => createActionRuleAuthority({ name: 'changed', action_boundary_name: 'shared.actions', catalog: f.catalog,
      rules: entries, shared_sum: f.shared_sum })).toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('refuses a copied registry missing the limit writer while retaining its bound Boundary', () => {
    const f = reviewedSharedSumFixture();
    const rules = f.registry.rules.filter(r => r.compiled.outcome !== 'shared.limit');
    expect(() => createActionRuleRegistry({ name: f.registry.name, rules, shared_sum: f.shared_sum }))
      .toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('does not reuse a plan after any participating authority changes', () => {
    const f = reviewedSharedSumFixture(), changed = reviewedSharedSumFixture({ credit: 100 });
    const plan = deriveReviewedSharedSumProtection(f.registry)!;
    expect(() => resolveReviewedSharedSumProtection(plan, changed.registry, changed.registry.rules[0]!.compiled))
      .toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('keeps guard identity stable across policy revisions and different collection aliases', () => {
    const a = reviewedSharedSumFixture(), b = reviewedSharedSumFixture({ credit: 100, creditBinding: 'other_credits', waiverBinding: 'other_waivers' });
    const pa = deriveReviewedSharedSumProtection(a.registry)!, pb = deriveReviewedSharedSumProtection(b.registry)!;
    expect(pa.registry_digest).not.toBe(pb.registry_digest);
    expect(reviewedSharedSumGuardIdentity(pa, a.registry.rules[0]!.compiled, a.facts))
      .toBe(reviewedSharedSumGuardIdentity(pb, b.registry.rules[0]!.compiled, b.facts));
    const different = structuredClone(a.facts);
    for (const value of Object.values(different.bindings)) for (const row of value.rows) row.team_id = 'other_team';
    expect(reviewedSharedSumGuardIdentity(pa, a.registry.rules[0]!.compiled, different))
      .not.toBe(reviewedSharedSumGuardIdentity(pa, a.registry.rules[0]!.compiled, a.facts));
  });
  it('refuses downgrade of a persisted v2 authority with retained v2 digests', () => {
    const f = reviewedSharedSumFixture(), authority = structuredClone(f.authority.authority);
    const downgraded = { ...authority, schema_version: 'synapsor.action-rule-authority.v1' };
    delete downgraded.shared_sum;
    expect(() => parseActionRuleAuthority(downgraded)).toThrow();
  });
});
