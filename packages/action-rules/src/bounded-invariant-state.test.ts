import { describe, expect, it } from 'vitest';
import { ActionRuleError } from './errors.js';
import { createActionRuleAuthority } from './authority.js';
import { evaluateActionRule } from './evaluate.js';
import { projectBoundedInvariantEffect } from './bounded-invariant-state.js';
import { experimentalSharedSumFixture } from './testing/experimental-shared-sum-fixture.js';

const refuse = (stage: string): never => { throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'Unsupported projection.', stage); };
function setup(multipleColumns = false) {
  const f = experimentalSharedSumFixture();
  if (multipleColumns) {
    const entry = f.entries[1]!, type = { kind: 'integer' as const, unit: 'USD_cents' };
    f.catalog.resources[2]!.fields.push({ name: 'discount_cents', type, nullable: false });
    for (const b of entry.verification_boundary.resources.filter(b => b.resource === f.catalog.resources[2]!.name)) {
      b.fields.push({ name: 'discount_cents', type, nullable: false });
    }
    entry.effect_envelope.allowed_fields.push({ name: 'discount_cents', type, minimum: 0, maximum: 10000 });
    entry.rule.effect.set.discount_cents = { kind: 'literal', value: 2000, value_type: type };
    for (const b of [f.facts.bindings[f.wb]!, f.facts.bindings.waiver!]) b.rows[0]!.discount_cents = 3000;
  }
  const registry = createActionRuleAuthority({ name: 'projection_data', action_boundary_name: 'projection.actions', catalog: f.catalog, rules: f.entries }).registry;
  const compiled = registry.rules.find(r => r.compiled.outcome === 'shared.waiver')!.compiled;
  const facts = { ...f.facts, bindings: Object.fromEntries(compiled.bindings.map(b => [b.binding, f.facts.bindings[b.binding]!])) };
  const decision = evaluateActionRule({ compiled, facts, proposal_id: 'projection_waiver' });
  if (decision.result !== 'eligible') throw new Error(JSON.stringify(decision));
  const parent = compiled.bindings.find(b => b.binding === 'team')!;
  const population = compiled.bindings.find(b => b.binding === f.wb)!;
  return { ...f, compiled, facts, effect: decision.effect, ctx: { parent, populations: [population] } };
}

describe('one shared exact effect projection over deduplicated populations (DATA only)', () => {
  it('replaces multiple columns once and preserves original facts and every alias', () => {
    const f = setup(true);
    f.facts.bindings[f.wb]!.rows[0]!.amount = 100;
    f.facts.bindings.waiver!.rows[0]!.amount = 100;
    const before = JSON.stringify(f.facts);
    const post = projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse);
    for (const b of [f.wb, 'waiver']) expect(post.bindings[b]!.rows[0]).toMatchObject({ amount: 250, discount_cents: 2000, version: 2 });
    expect(post.bindings[f.wb]!.rows).toHaveLength(1);
    expect(f.facts.bindings[f.wb]!.rows[0]).toMatchObject({ amount: 100, discount_cents: 3000, version: 1 });
    expect(before).not.toBe(JSON.stringify(post));
    expect(JSON.stringify(f.facts)).toBe(before);
  });
  it('does not make an empty or hidden population a target member', () => {
    const f = setup(); f.facts.bindings[f.wb]!.rows = [];
    expect(() => projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse)).toThrow(expect.objectContaining({ path: 'effect_member' }));
    delete f.facts.bindings[f.wb];
    expect(() => projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse)).toThrow(expect.objectContaining({ path: 'facts_membership' }));
  });
  it('refuses parent membership changes in the projected row', () => {
    const f = setup(); f.effect.set.team_id = 'another-period';
    expect(() => projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse)).toThrow(expect.objectContaining({ path: 'facts_membership' }));
  });
  it('refuses a stale alias version instead of counting a second effect', () => {
    const f = setup(); f.facts.bindings.waiver!.rows[0]!.version = 2;
    expect(() => projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse)).toThrow(expect.objectContaining({ path: 'effect_version' }));
    expect(f.facts.bindings[f.wb]!.rows[0]!.version).toBe(1);
  });
  it('refuses an effect from a different trusted business scope', () => {
    const f = setup(); f.effect.principal_scope!.value = 'another-principal';
    expect(() => projectBoundedInvariantEffect(f.ctx, f.compiled, f.facts, f.effect, refuse)).toThrow(expect.objectContaining({ path: 'effect_identity' }));
  });
});
