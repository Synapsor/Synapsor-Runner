import { describe, expect, it } from 'vitest';
import { assertUtcMonthAdmission, checkExactWeightedConstraint, type ExactWeightedTerm } from './exact-weighted-constraint.js';
import { HardLimitPostStateExceeded } from './hard-limit.js';

const term = (quantity: bigint, numerator = '1', denominator = '1', raw_cap?: bigint): ExactWeightedTerm =>
  ({ quantity, numerator, denominator, ...(raw_cap === undefined ? {} : { raw_cap }) });
const passes = (terms: ExactWeightedTerm[], limit = 12000n) => expect(() => checkExactWeightedConstraint(terms, limit)).not.toThrow();
const exceeds = (terms: ExactWeightedTerm[], limit = 12000n) => expect(() => checkExactWeightedConstraint(terms, limit)).toThrow(HardLimitPostStateExceeded);
const invalid = (terms: ExactWeightedTerm[], limit = 12000n) => expect(() => checkExactWeightedConstraint(terms, limit))
  .toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' }));

describe('bounded exact weighted comparison (component DATA, no Source/authority)', () => {
  it('refuses 3000 minutes plus 8000 cents, in either measure order', () => {
    const terms = [term(3000n, '2', '1', 3000n), term(8000n, '1', '1', 10000n)];
    exceeds(terms); exceeds([...terms].reverse());
  });
  it('allows 3000 minutes plus fresh6000 cents at exact equality', () => passes([term(3000n, '2'), term(6000n)]));
  it('preserves the10000 total for fresh4000 cents', () => {
    passes([term(3000n, '2'), term(4000n)], 10000n);
    exceeds([term(3000n, '2'), term(4000n)], 9999n);
  });
  it('enforces individual raw caps even when the weighted limit fits', () => {
    exceeds([term(3001n, '2', '1', 3000n), term(0n)]);
    exceeds([term(0n, '2'), term(10001n, '1', '1', 10000n)]);
  });
  it('refuses the three-unit13000 combination and allows every valid pair', () => {
    const terms = [term(2000n, '2'), term(5000n), term(2n, '2000')];
    exceeds(terms);
    for (let i = 0; i < terms.length; i++) passes(terms.filter((_, j) => j !== i));
  });
  it('revalues the complete quantity on rate edit', () => {
    passes([term(3000n, '2'), term(6000n)]);
    exceeds([term(3000n, '3'), term(6000n)]);
    passes([term(3000n, '3'), term(2000n)], 11000n);
    exceeds([term(3000n, '3'), term(2000n)], 10999n);
  });
  it('does not round fractional valuations at admission', () => {
    exceeds([term(1n, '1', '3'), term(1n, '2', '3')], 0n);
    passes([term(1n, '1', '3'), term(1n, '2', '3')], 1n);
    exceeds([term(1n, '1', '3'), term(1n, '3', '4')], 1n);
  });
  it('keeps split/merge and equivalent valuations exact', () => {
    passes([term(3n, '1', '3'), term(3n, '1', '3')], 2n);
    passes([term(6n, '2', '6'), term(0n)], 2n);
    exceeds([term(3n, '1', '3'), term(3n, '1', '3')], 1n);
    exceeds([term(6n, '2', '6'), term(0n)], 1n);
  });
  it('compares above binary floating-point precision without loss', () => {
    const q = 9007199254740993n;
    passes([term(q), term(1n)], q + 1n);
    exceeds([term(q), term(1n)], q);
  });
  it('accepts zero consumption and equality at the finite quantity bound', () => {
    passes([term(0n), term(0n)], 0n);
    passes([term((1n << 127n) - 1n), term(0n)], (1n << 127n) - 1n);
  });
  it.each(['0', '-1', '01', '1.5', '1e3', ' 1', '1000000000000'])('refuses invalid/overcomplex valuation%s', value => {
    invalid([term(1n, value), term(1n)]); invalid([term(1n, '1', value), term(1n)]);
  });
  it('refuses negative, nonintegral, missing and overbound quantities', () => {
    for (const q of [-1n, 1n << 127n, 1.5, undefined]) invalid([term(q as bigint), term(0n)]);
    invalid([term(0n), term(0n)], -1n);
    invalid([term(0n, '1', '1', -1n), term(0n)]);
  });
  it('refuses unsupported term count or a missing term', () => {
    invalid([]); invalid([term(0n)]); invalid(Array.from({ length: 9 }, () => term(0n)));
    invalid([term(0n), undefined as unknown as ExactWeightedTerm]);
  });
  it('bounds denominator complexity without truncation', () => {
    invalid(['999999999989', '999999999973', '999999999959', '999999999953',
      '999999999929', '999999999893', '999999999883', '999999999881'].map(d => term(1n, '1', d)), 1n);
  });
  it('does not mask invalid representation behind a raw-cap refusal', () => invalid([term(2n, '1', '1', 1n), term(-1n)]));
  it('never mutates supplied measures', () => {
    const terms = [Object.freeze(term(3000n, '2')), Object.freeze(term(4000n))];
    passes(terms); expect(terms).toEqual([term(3000n, '2'), term(4000n)]);
  });
});

describe('UTC calendar-month admission contract (no inferred Source period)', () => {
  const month = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
  it.each(['2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z'])('admits%s in the half-open month', admitted_at =>
    expect(() => assertUtcMonthAdmission({ ...month, admitted_at })).not.toThrow());
  it.each(['2026-09-30T23:59:59.999Z', '2026-11-01T00:00:00.000Z'])('refuses%s instead of reassigning period', admitted_at =>
    expect(() => assertUtcMonthAdmission({ ...month, admitted_at })).toThrow(expect.objectContaining({ path: 'source.hard_limit.weighted_period_closed' })));
  it('validates leap February and December rollover', () => {
    for (const [start, end] of [['2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
      ['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']]) {
      expect(() => assertUtcMonthAdmission({ start: start!, end: end!, admitted_at: start! })).not.toThrow();
    }
  });
  it.each([
    ['2026-10-02T00:00:00.000Z', month.end],
    [month.start, '2026-10-31T00:00:00.000Z'],
    [month.start, '2026-12-01T00:00:00.000Z'],
    ['2026-10-01T00:00:00+00:00', month.end],
    ['2026-02-30T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
  ])('refuses nonmonthly or ambiguous%s→%s', (start, end) =>
    expect(() => assertUtcMonthAdmission({ start, end, admitted_at: month.start })).toThrow(expect.objectContaining({ code: 'ACTION_RULE_SCOPE_UNPROVEN' })));
});
