import { describe, expect, it } from 'vitest';
import type { CountingRequirementBinding } from './authoring-policy-source.js';
import { countingRequirementContext, countingRequirementsReviewText } from './authoring-review-context.js';

const binding = (index: number, excerpt: string): CountingRequirementBinding => ({
  origin: 'HOST-SOURCE-ASSOCIATION', path: `/actions/operation_${index}/counting`,
  source_digest: `sha256:${'a'.repeat(64)}`, start: 1, end: 3, source_excerpt: excerpt,
  state: 'established', required_capability: 'tenant_principal',
  configuration_digest: `sha256:${'b'.repeat(64)}`, operator_clarification: `Original decision ${index}`,
  operator_review: { origin: 'OPERATOR-COUNTING-REVIEW', source_digest: `sha256:${'a'.repeat(64)}`,
    path: `/actions/operation_${index}/counting`, configuration_digest: `sha256:${'b'.repeat(64)}`,
    required_capability: 'tenant_principal', operator_history_digest: `sha256:${'c'.repeat(64)}`,
    reviewed_at: '2026-09-27T19:00:00Z' }, accepted_support: [`/actions/${index}/limits`],
});

function reconstructed(requirements: readonly CountingRequirementBinding[]) {
  const projected = countingRequirementContext(requirements);
  if (Array.isArray(projected)) return projected;
  const { source_excerpts, requirements: indexed } = projected as Exclude<typeof projected, readonly CountingRequirementBinding[]>;
  return indexed.map(requirement => Object.fromEntries(Object.entries(requirement).map(([key, value]) =>
    key === 'source_excerpt_index' ? ['source_excerpt', source_excerpts[value as number]] : [key, value])));
}

describe('lossless counting context projection', () => {
  it('leaves empty, single and small contexts byte-for-byte unchanged', () => {
    for (const requirements of [[], [binding(0, 'Source')], [binding(0, 'Source'), binding(1, 'Source')]]) {
      expect(countingRequirementContext(requirements)).toBe(requirements);
      expect(countingRequirementsReviewText(requirements)).toBe(JSON.stringify(requirements));
    }
  });
  it('factors repeated complete excerpts without changing any decision, record order or bytes', () => {
    const requirements = Array.from({ length: 24 }, (_, index) => binding(index, 'Complete source\n'.repeat(700)));
    const before = JSON.stringify(requirements);
    expect(Array.isArray(countingRequirementContext(requirements))).toBe(false);
    expect(JSON.stringify(reconstructed(requirements))).toBe(before);
    expect(JSON.stringify(requirements)).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(countingRequirementContext(requirements)))).toBeLessThan(Buffer.byteLength(before) / 3);
    expect(countingRequirementsReviewText(requirements)).toContain('not operator-message IDs or new confirmations');
  });
  it('preserves exact whitespace, line endings, Unicode and literal data distinctions', () => {
    const endings = ['a', 'a ', 'a\n', 'a\r\n', 'é', 'e\u0301', 'a\0', 'a"\\'];
    const requirements = Array.from({ length: 24 }, (_, index) => binding(index, 'x'.repeat(6000) + endings[index % endings.length]));
    const projected = countingRequirementContext(requirements) as Exclude<ReturnType<typeof countingRequirementContext>, readonly CountingRequirementBinding[]>;
    expect(projected.source_excerpts).toHaveLength(endings.length);
    expect(JSON.stringify(reconstructed(requirements))).toBe(JSON.stringify(requirements));
  });
  it('keeps unknown and ambiguous records and different provenance even for the same excerpt', () => {
    const excerpt = 'Original whole source'.repeat(400);
    const requirements: CountingRequirementBinding[] = Array.from({length: 24}, (_, index) => index % 3 === 0
      ? binding(index, excerpt) : {origin: 'HOST-SOURCE-ASSOCIATION', path: `/other/${index}`,
        source_digest: `sha256:${String(index % 10).repeat(64)}`, start: index + 1, end: index + 2,
        source_excerpt: excerpt, state: index % 3 === 1 ? 'unknown' : 'ambiguous',
        ...(index % 3 === 2 ? {ambiguity: 'outcome_reference_unresolved' as const} : {})});
    expect(JSON.stringify(reconstructed(requirements))).toBe(JSON.stringify(requirements));
  });
  it('does not reuse excerpt indices or meanings across requests', () => {
    const first = Array.from({length: 24}, (_, index) => binding(index, 'first'.repeat(2000)));
    const second = Array.from({length: 24}, (_, index) => binding(index, 'second'.repeat(2000)));
    expect(JSON.stringify(reconstructed(first))).toBe(JSON.stringify(first));
    expect(JSON.stringify(reconstructed(second))).toBe(JSON.stringify(second));
    expect(countingRequirementsReviewText(second)).not.toContain('first');
  });
  it('retains the original representation when unique excerpts cannot make it smaller', () => {
    const requirements = Array.from({length: 24}, (_, index) => binding(index, `${index}:` + 'unique'.repeat(2000)));
    expect(countingRequirementContext(requirements)).toBe(requirements);
  });
});
