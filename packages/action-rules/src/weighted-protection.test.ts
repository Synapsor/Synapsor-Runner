import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { evaluateActionRule } from './evaluate.js';
import { weightedConstraintFixture } from './testing/weighted-constraint-fixture.js';
import { deriveReviewedWeightedSharedSumProtection, resolveReviewedWeightedSharedSumProtection,
  checkReviewedWeightedSharedSumPostState, reviewedWeightedSharedSumGuardIdentity } from './weighted-protection.js';

/** Prospective registry DATA tests. B66 owns actual constructor/readback V3
 * integration; none of these synthetic confirmation records is consent. */
function data() {
  const f = weightedConstraintFixture(), registry = structuredClone(f.registry);
  Object.assign(registry, { schema_version: 'synapsor.action-rule-registry.v3', shared_sum: f.shared_sum });
  const boundary = { schema_version: 'synapsor.semantic-action-boundary.v3', name: registry.rules[0]!.action_boundary_name,
    rules: registry.rules.map(({ compiled: c, approval_policy_digest }) => ({ approval_policy_digest,
      approval_mode: registry.approval_classes.find(a => a.name === c.approval_class)!.mode, outcome: c.outcome,
      effect_envelope_digest: c.effect_envelope_digest, action_rule_digest: c.rule_digest,
      compiled_plan_digest: c.compiled_plan_digest, approval_class: c.approval_class,
      operation: c.effect_envelope.operation, target_resource: c.effect_envelope.target_resource,
      allowed_fields: c.effect_envelope.allowed_fields.map(f => f.name).sort(), max_rows: 1, writeback: c.effect_envelope.writeback,
    })).sort((a, b) => a.outcome.localeCompare(b.outcome)), shared_sum_digest: canonicalJsonDigest(f.shared_sum) };
  for (const r of registry.rules) r.action_boundary_digest = canonicalJsonDigest(boundary);
  const material = { ...registry, digest: undefined }; delete material.digest;
  registry.digest = canonicalJsonDigest(material);
  return { ...f, registry, boundary };
}
describe('derived weighted registry protection (prospective component DATA)', () => {
  it('derives from serialized registry and checks the exact verified post-state', () => {
    const f = data(), registry = JSON.parse(JSON.stringify(f.registry)), plan = deriveReviewedWeightedSharedSumProtection(registry)!;
    const c = registry.rules.find((r: typeof f.registry.rules[number]) => r.compiled.outcome === 'shared.credit')!.compiled;
    const facts = { ...f.facts, bindings: Object.fromEntries(c.bindings.map((b: typeof c.bindings[number]) => [b.binding, f.facts.bindings[b.binding]!])) };
    const v = evaluateActionRule({ compiled: c, facts, proposal_id: 'request' });
    if (v.result !== 'eligible') throw new Error('fixture not eligible');
    expect(resolveReviewedWeightedSharedSumProtection(plan, registry, c)).toEqual({ digest: plan.digest });
    expect(() => checkReviewedWeightedSharedSumPostState(plan, c, facts, v.effect, '2026-10-09T12:00:00.000Z')).not.toThrow();
    expect(() => checkReviewedWeightedSharedSumPostState(plan, c, facts, v.effect, '2026-11-01T00:00:00.000Z')).toThrow();
  });
  it.each(['boundary', 'generation', 'read', 'writer', 'unit'] as const)('refuses unproven %s inventory', mode => {
    const f = data();
    if (mode === 'boundary') f.registry.rules[0]!.action_boundary_digest = canonicalJsonDigest('different');
    if (mode === 'generation') f.registry.rules[0]!.compiled.generation_lock_fingerprint = canonicalJsonDigest('different');
    if (mode === 'read') f.registry.rules[0]!.read_boundary_digest = canonicalJsonDigest('different');
    if (mode === 'writer') f.registry.rules.pop();
    if (mode === 'unit') f.registry.rules[0]!.compiled.bindings.find(b => b.binding === f.cb)!.resource.fields.find(v => v.name === 'amount')!.type = { kind: 'integer', unit: 'other' };
    expect(() => deriveReviewedWeightedSharedSumProtection(f.registry)).toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));
  });
  it('refuses a current registry change after deriving protection', () => {
    const f = data(), plan = deriveReviewedWeightedSharedSumProtection(f.registry)!;
    f.registry.digest = canonicalJsonDigest('replacement');
    expect(() => resolveReviewedWeightedSharedSumProtection(plan, f.registry, f.registry.rules[0]!.compiled)).toThrow();
  });
  it('keeps the physical guard identity across rate and policy changes, and separates guard rows', () => {
    const f = data(), before = deriveReviewedWeightedSharedSumProtection(f.registry)!;
    const c = f.registry.rules[0]!.compiled, identity = reviewedWeightedSharedSumGuardIdentity(before, c, f.facts);
    f.shared_sum.designation.measures[0]!.valuation.numerator = '3';
    f.shared_sum.designation.measures[0]!.valuation.version = 'policy.v2';
    f.shared_sum.confirmation.designation_digest = canonicalJsonDigest(f.shared_sum.designation);
    f.boundary.shared_sum_digest = canonicalJsonDigest(f.shared_sum);
    for (const r of f.registry.rules) r.action_boundary_digest = canonicalJsonDigest(f.boundary);
    const after = deriveReviewedWeightedSharedSumProtection(f.registry)!;
    expect(before.digest).not.toBe(after.digest);
    expect(reviewedWeightedSharedSumGuardIdentity(after, c, f.facts)).toBe(identity);
    for (const value of Object.values(f.facts.bindings)) for (const row of value.rows) row.team_id = 'other_team';
    expect(reviewedWeightedSharedSumGuardIdentity(after, c, f.facts)).not.toBe(identity);
  });
  it('does not activate protection from a plain V1 registry', () => {
    expect(deriveReviewedWeightedSharedSumProtection(weightedConstraintFixture().registry)).toBeUndefined();
  });
});
