import { ActionRuleError } from './errors.js';
import { HardLimitPostStateExceeded } from './hard-limit.js';

/** Internal evaluated DATA, never an authority, Source capability or formula.
 * The compiler supplies deduplicated measures from complete projected facts. */
export type ExactWeightedTerm = Readonly<{
  quantity: bigint;
  numerator: string;
  denominator: string;
  raw_cap?: bigint;
}>;
const maximumQuantity = (1n << 127n) - 1n;
const maximumIntermediate = (1n << 256n) - 1n;
function refuse(stage: string): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The reviewed constraint cannot be checked with the supported exact representation.', `source.hard_limit.weighted_${stage}`);
}
function quantity(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maximumQuantity) refuse('quantity');
  return value;
}
function coefficient(value: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/u.test(value)) refuse('valuation');
  return BigInt(value);
}
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function bounded(value: bigint): bigint {
  if (value > maximumIntermediate) refuse('complexity');
  return value;
}
/** Exact upper-bound comparison without admission rounding. The result contains
 * no observations; existing refusal/receipt code binds the owning invariant. */
export function checkExactWeightedConstraint(terms: readonly ExactWeightedTerm[], limit: bigint): void {
  if (!Array.isArray(terms) || terms.length < 2 || terms.length > 8) refuse('terms');
  quantity(limit);
  let numerator = 0n, denominator = 1n;
  let capExceeded = false;
  for (const term of terms) {
    if (!term || typeof term !== 'object') refuse('terms');
    const q = quantity(term.quantity);
    const n = coefficient(term.numerator), d = coefficient(term.denominator);
    if (term.raw_cap !== undefined && q > quantity(term.raw_cap)) capExceeded = true;
    const termDivisor = gcd(q * n, d);
    const tn = bounded(q * n / termDivisor), td = d / termDivisor;
    const shared = gcd(denominator, td);
    numerator = bounded(bounded(numerator * (td / shared)) + bounded(tn * (denominator / shared)));
    denominator = bounded(denominator * (td / shared));
    const divisor = gcd(numerator, denominator);
    numerator /= divisor; denominator /= divisor;
  }
  if (capExceeded || numerator > bounded(limit * denominator)) throw new HardLimitPostStateExceeded();
}

function utc(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) refuse('period');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) refuse('period');
  return time;
}
/** Actual reviewed Source period rows are checked elsewhere. This validates
 * only the explicit UTC calendar-month contract and host admission instant. */
export function assertUtcMonthAdmission(input: Readonly<{ start: string; end: string; admitted_at: string }>): void {
  const start = utc(input.start), end = utc(input.end), admission = utc(input.admitted_at);
  const first = new Date(start), next = new Date(start);
  if (first.getUTCDate() !== 1 || first.getUTCHours() !== 0 || first.getUTCMinutes() !== 0
    || first.getUTCSeconds() !== 0 || first.getUTCMilliseconds() !== 0) refuse('period');
  next.setUTCMonth(next.getUTCMonth() + 1);
  if (next.getTime() !== end) refuse('period');
  if (admission < start || admission >= end) refuse('period_closed');
}
