import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { CoverageReceiptConfigurationError, coverageFinding } from './authoring-coverage-feedback.js';
import { planCoverageResolution } from './authoring-review-resolution.js';

describe('an owner-resolvable receipt requirement', () => {
  it('routes missing business meaning to the attributed decision path, with no model correction or acceptance', () => {
    const context = canonicalJsonDigest('declared completion-rule review');
    const finding = coverageFinding(new CoverageReceiptConfigurationError('source_requirement_unestablished'),
      '/passages/0', { start: 1, end: 1, source: canonicalJsonDigest('Customers hear completed only from a completion receipt.') });
    const plan = planCoverageResolution({ context, findings: [finding], limited: false,
      unevaluated: ['/passages/0'], complete_validation: false });
    expect(plan.recommended).toBe('receipt_requirement_review');
    expect(plan.options).toContainEqual(expect.objectContaining({ operation: 'receipt_requirement_review',
      actor: 'operator', handler: 'receipt_requirement_review', availability: 'available' }));
    expect(plan.options.some(option => option.operation === 'scoped_correction')).toBe(false);
    expect(plan.complete_validation).toBe(false);
    expect(plan.result).toBe('pending');
  });
  it('keeps a real physical-mode conflict blocked rather than treating it as a wording correction', () => {
    const context = canonicalJsonDigest('declared conflicting receipt modes');
    const finding = coverageFinding(new CoverageReceiptConfigurationError('mode_mismatch'), '/passages/0', context);
    const plan = planCoverageResolution({ context, findings: [finding], limited: false,
      unevaluated: ['/passages/0'], complete_validation: false });
    expect(plan.options.some(option => option.operation === 'scoped_correction')).toBe(false);
    expect(plan.result).toBe('stopped');
  });
});
