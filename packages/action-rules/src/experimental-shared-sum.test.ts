import { describe, expect, it } from 'vitest';
import { createActionRuleAuthority } from './authority.js';
import { evaluateActionRule } from './evaluate.js';
import { HardLimitPostStateExceeded } from './hard-limit.js';
import { checkExperimentalSharedSumPostState, compileExperimentalSharedSumProtection,
  experimentalSharedSumGuardIdentity, resolveExperimentalSharedSumProtection,
  type ExperimentalSharedSumProtection } from './experimental-shared-sum.js';
import { experimentalSharedSumFixture } from './testing/experimental-shared-sum-fixture.js';

function setup(options: Parameters<typeof experimentalSharedSumFixture>[0] = {}) {
  const f = experimentalSharedSumFixture(options);
  return { ...f, plan: compileExperimentalSharedSumProtection(f) };
}
function effect(f: ReturnType<typeof setup>, outcome: 'credit' | 'waiver' | 'limit') {
  const compiled = f.registry.rules.find(r => r.compiled.outcome === `shared.${outcome}`)!.compiled;
  // Each actual loader returns only this rule's reviewed bindings. The shared
  // fixture holds the union needed by the different participants.
  const facts = { ...f.facts, bindings: Object.fromEntries(compiled.bindings.map(b => [b.binding, f.facts.bindings[b.binding]!])) };
  const decision = evaluateActionRule({ compiled, facts, proposal_id: `proposal_${outcome}` });
  expect(decision.result, JSON.stringify(decision)).toBe('eligible');
  if (decision.result !== 'eligible') throw new Error('Fixture eligibility failed');
  return { compiled, effect: decision.effect };
}
function authority(f: ReturnType<typeof setup>) {
  return createActionRuleAuthority({ name: 'changed', action_boundary_name: 'shared.actions', catalog: f.catalog, rules: f.entries }).registry;
}

describe('experimental shared SUM compiler and whole proposed state', () => {
  it('characterizes existing pre-state eligibility allowing the individually approved overshoot', () => {
    const f = setup(); f.facts.bindings[f.cb]!.rows = [{ tenant_id: 't1', principal_id: 'p1', team_id: 'team1', credit_id: 'c1', amount: 300, version: 1 }];
    const v = effect(f, 'waiver');
    expect(v.effect.set.amount).toBe(250);
    expect(300 + Number(v.effect.set.amount)).toBe(550);
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect)).toThrow(HardLimitPostStateExceeded);
  });
  it.each(['credit', 'waiver', 'limit'] as const)('admits the exact standalone %s effect', outcome => {
    const f = setup(), v = effect(f, outcome), before = JSON.stringify(f.facts);
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect)).not.toThrow();
    expect(JSON.stringify(f.facts)).toBe(before);
  });
  it('refuses credit300 after waiver250 even though the fresh pre-state condition passes', () => {
    const f = setup(); Object.assign(f.facts.bindings[f.wb]!.rows[0]!, { amount: 250, version: 2 });
    Object.assign(f.facts.bindings.waiver!.rows[0]!, { amount: 250, version: 2 });
    const v = effect(f, 'credit');
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect)).toThrow(HardLimitPostStateExceeded);
  });
  it('admits a fresh smaller credit request against the complete combined state', () => {
    const f = setup({ credit: 100 }); Object.assign(f.facts.bindings[f.wb]!.rows[0]!, { amount: 250 });
    Object.assign(f.facts.bindings.waiver!.rows[0]!, { amount: 250 });
    const v = effect(f, 'credit');
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect)).not.toThrow();
  });
  it('includes the proposed limit decrease in the same whole-state check', () => {
    const f = setup({ limitChange: 100 }); Object.assign(f.facts.bindings[f.wb]!.rows[0]!, { amount: 250 });
    Object.assign(f.facts.bindings.waiver!.rows[0]!, { amount: 250 });
    const v = effect(f, 'limit');
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect)).toThrow(HardLimitPostStateExceeded);
  });
  it('uses the same physical guard across alias and policy/effect revision, with separate teams', () => {
    const first = setup(), second = setup({ credit: 100, creditBinding: 'other_credit_alias', waiverBinding: 'other_waiver_alias' });
    const a = first.registry.rules.find(r => r.compiled.outcome === 'shared.credit')!.compiled;
    const b = second.registry.rules.find(r => r.compiled.outcome === 'shared.credit')!.compiled;
    expect(a.compiled_plan_digest).not.toBe(b.compiled_plan_digest);
    expect(experimentalSharedSumGuardIdentity(first.plan, a, first.facts)).toBe(experimentalSharedSumGuardIdentity(second.plan, b, second.facts));
    const differentTeam = structuredClone(first.facts);
    for (const binding of Object.values(differentTeam.bindings)) for (const row of binding.rows) row.team_id = 'team2';
    expect(experimentalSharedSumGuardIdentity(first.plan, a, differentTeam)).not.toBe(experimentalSharedSumGuardIdentity(first.plan, a, first.facts));
  });
  it('does not accept a copied or caller-created plan as compiler provenance', () => {
    const f = setup(), c = f.registry.rules[0]!.compiled;
    expect(() => resolveExperimentalSharedSumProtection({ ...f.plan } as ExperimentalSharedSumProtection, f.registry, c))
      .toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN', path: 'experimental.shared_sum.plan_origin' }));
  });
  it('refuses current compiled participation drift rather than reusing an old plan', () => {
    const f = setup(), changed = experimentalSharedSumFixture({ credit: 100 });
    expect(() => resolveExperimentalSharedSumProtection(f.plan, changed.registry, changed.registry.rules[0]!.compiled))
      .toThrow(expect.objectContaining({ path: 'experimental.shared_sum.inventory_changed' }));
  });
  it('refuses a valid partial writer that omits the other contribution dependency', () => {
    const f = setup(), credit = f.entries[0]!;
    credit.verification_boundary.resources = credit.verification_boundary.resources.filter(b => b.binding !== f.wb);
    credit.verification_boundary.lock_order = credit.verification_boundary.lock_order.filter(b => b !== f.wb);
    credit.rule.require = { kind: 'compare', operator: 'lte', left: { kind: 'aggregate', operation: 'sum', binding: f.cb, field: 'amount' },
      right: { kind: 'field', binding: 'team', field: 'limit' } };
    expect(() => compileExperimentalSharedSumProtection({ ...f, registry: authority(f) }))
      .toThrow(expect.objectContaining({ path: 'experimental.shared_sum.population' }));
  });
  it('requires the shared meaning already bound in each immutable reviewed rule', () => {
    const f = setup(); f.entries[0]!.rule.require = { kind: 'compare', operator: 'eq',
      left: { kind: 'literal', value: 1, value_type: { kind: 'integer' } }, right: { kind: 'literal', value: 1, value_type: { kind: 'integer' } } };
    expect(() => compileExperimentalSharedSumProtection({ ...f, registry: authority(f) }))
      .toThrow(expect.objectContaining({ path: 'experimental.shared_sum.reviewed_condition' }));
  });
  it('refuses PostgreSQL-to-MySQL transfer of the experimental profile', () => {
    const f = experimentalSharedSumFixture({ engine: 'mysql' });
    expect(() => compileExperimentalSharedSumProtection(f)).toThrow(expect.objectContaining({ path: 'experimental.shared_sum.profile' }));
  });
  it.each(['missing', 'negative', 'overflow', 'scope', 'membership', 'limit_null'])('fails closed for %s complete facts', mode => {
    const f = setup(), v = effect(f, 'credit');
    if (mode === 'missing') delete f.facts.bindings[f.wb];
    if (mode === 'negative') f.facts.bindings[f.wb]!.rows[0]!.amount = -1;
    if (mode === 'overflow') f.facts.bindings[f.wb]!.rows[0]!.amount = Number.MAX_SAFE_INTEGER;
    if (mode === 'scope') f.facts.trusted.principal = 'another_principal';
    if (mode === 'membership') f.facts.bindings[f.wb]!.rows[0]!.team_id = 'another_team';
    if (mode === 'limit_null') f.facts.bindings.team!.rows[0]!.limit = null;
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect))
      .toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('refuses an update whose target is outside the complete team population', () => {
    const f = setup(), v = effect(f, 'waiver');
    v.effect.primary_key.value = 'other_team_row';
    expect(() => checkExperimentalSharedSumPostState(f.plan, v.compiled, f.facts, v.effect))
      .toThrow(expect.objectContaining({ path: 'experimental.shared_sum.effect_member' }));
  });
});
