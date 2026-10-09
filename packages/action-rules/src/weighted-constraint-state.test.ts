import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { evaluateActionRule } from './evaluate.js';
import { HardLimitPostStateExceeded } from './hard-limit.js';
import { weightedConstraintFixture as setup } from './testing/weighted-constraint-fixture.js';
import { buildWeightedConstraintState, checkWeightedCurrentState, checkWeightedPostState } from './weighted-constraint-state.js';

const time = '2026-10-09T12:00:00.000Z';
function proposed(f: ReturnType<typeof setup>, outcome = 'shared.credit') {
  const compiled = f.registry.rules.find(r => r.compiled.outcome === outcome)!.compiled;
  const facts = { ...f.facts, bindings: Object.fromEntries(compiled.bindings.map(b => [b.binding, f.facts.bindings[b.binding]!])) };
  const decision = evaluateActionRule({ compiled, facts, proposal_id: 'weighted_component_request' });
  if (decision.result !== 'eligible') throw new Error(JSON.stringify(decision));
  return { compiled, effect: decision.effect };
}
function creditRow(f: ReturnType<typeof setup>, amount: number) {
  f.facts.bindings[f.cb]!.rows = [{ tenant_id: 't1', principal_id: 'p1', team_id: 'team1', credit_id: 'existing', amount, version: 1 }];
}
describe('weighted compiler and complete projected facts (not activated/native authority)', () => {
  it('composes ordinary local eligibility with the independently designated shared post-state bound', () => {
    const f = setup(); creditRow(f, 3000); const v = proposed(f, 'shared.waiver');
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, time)).not.toThrow();
  });
  it('refuses fresh8000c after3000 minutes and preserves fresh4000c exact10000', () => {
    const f = setup({ waiver: 8000 }); creditRow(f, 3000); const v = proposed(f, 'shared.waiver');
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, time)).toThrow(HardLimitPostStateExceeded);
    const smaller = setup({ waiver: 4000 }); creditRow(smaller, 3000); const s = proposed(smaller, 'shared.waiver');
    smaller.facts.bindings.team!.rows[0]!.limit = 10000;
    expect(() => checkWeightedPostState(smaller.state, s.compiled, smaller.facts, s.effect, time)).not.toThrow();
  });
  it('projects one population with two fields once and advances an alias version once', () => {
    const f = setup({ sharedPopulation: true }), v = proposed(f);
    expect(f.state.contexts.get(v.compiled.outcome)!.populations).toHaveLength(1);
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, time)).not.toThrow();
    expect(f.facts.bindings[f.cb]!.rows).toEqual([]);
  });
  it('replaces rather than adds an existing quantity, enforcing each raw cap', () => {
    const f = setup(); creditRow(f, 3000);
    for (const b of [f.wb, 'waiver']) f.facts.bindings[b]!.rows[0]!.amount = 5000;
    const v = proposed(f, 'shared.waiver');
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, time)).not.toThrow();
    const over = setup({ credit: 3001 }), o = proposed(over);
    expect(() => checkWeightedPostState(over.state, o.compiled, over.facts, o.effect, time)).toThrow(HardLimitPostStateExceeded);
  });
  it('supports three structurally independent terms and refuses13000 with valid pairs', () => {
    const f = setup({ third: true }); creditRow(f, 2000);
    for (const b of [f.wb, 'waiver']) f.facts.bindings[b]!.rows[0]!.amount = 5000;
    f.facts.bindings.support_population!.rows = [{ tenant_id: 't1', principal_id: 'p1', team_id: 'team1', support_id: 'h1', amount: 2, version: 1 }];
    const compiled = f.registry.rules[0]!.compiled;
    expect(() => checkWeightedCurrentState(f.state, compiled, f.facts, time)).toThrow(HardLimitPostStateExceeded);
    f.facts.bindings.support_population!.rows = [];
    expect(() => checkWeightedCurrentState(f.state, compiled, f.facts, time)).not.toThrow();
  });
  it('revalues current state with an immutable rate version without accepting unsafe replacement', () => {
    const f = setup(); creditRow(f, 3000); f.facts.bindings[f.wb]!.rows[0]!.amount = 6000;
    const next = structuredClone(f.designation); next.measures[0]!.valuation.numerator = '3'; next.measures[0]!.valuation.version = 'policy.v2';
    const state = buildWeightedConstraintState(f.registry, next), c = f.registry.rules[0]!.compiled;
    expect(() => checkWeightedCurrentState(state, c, f.facts, time)).toThrow(HardLimitPostStateExceeded);
    f.facts.bindings[f.wb]!.rows[0]!.amount = 2000;
    expect(() => checkWeightedCurrentState(state, c, f.facts, time)).not.toThrow();
  });
  it('refuses a closed period after a wait instead of moving the request to November', () => {
    const f = setup(), v = proposed(f);
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, '2026-11-01T00:00:00.000Z'))
      .toThrow(expect.objectContaining({ path: 'source.hard_limit.weighted_period_closed' }));
  });
  it.each(['missing', 'negative', 'foreign_scope'])('refuses%s population facts', mode => {
    const f = setup(), v = proposed(f);
    if (mode === 'missing') delete f.facts.bindings[f.wb];
    if (mode === 'negative') f.facts.bindings[f.wb]!.rows[0]!.amount = -1;
    if (mode === 'foreign_scope') f.facts.bindings[f.wb]!.rows[0]!.principal_id = 'another';
    expect(() => checkWeightedPostState(f.state, v.compiled, f.facts, v.effect, time)).toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('refuses a new writer or wrong original unit before claiming participation', () => {
    const f = setup(), d = structuredClone(f.designation); d.participating_outcomes.pop();
    expect(() => buildWeightedConstraintState(f.registry, d)).toThrow(expect.objectContaining({ path: 'source.hard_limit.weighted_writer_inventory' }));
    const wrong = structuredClone(f.designation); wrong.measures[0]!.input_unit = { kind: 'integer', unit: 'hours' }; wrong.measures[0]!.valuation.input_unit = wrong.measures[0]!.input_unit;
    expect(() => buildWeightedConstraintState(f.registry, wrong)).toThrow(expect.objectContaining({ path: 'source.hard_limit.weighted_unit' }));
  });
});
