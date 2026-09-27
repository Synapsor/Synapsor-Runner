import type { CountingRequirementBinding } from './authoring-policy-source.js';

type IndexedRequirement = Omit<CountingRequirementBinding, 'source_excerpt'> & { source_excerpt_index: number };
type CountingReviewContext = readonly CountingRequirementBinding[] | {
  source_excerpts: string[];
  requirements: IndexedRequirement[];
};

/** Request-local, lossless representation only. Canonical source associations,
 * decisions and review identity continue to use the original complete records.
 */
export function countingRequirementContext(requirements: readonly CountingRequirementBinding[]): CountingReviewContext {
  const original = JSON.stringify(requirements);
  if (Buffer.byteLength(original) <= 65_536) return requirements;
  const source_excerpts: string[] = [];
  const indices = new Map<string, number>();
  const indexed = requirements.map(requirement => {
    let index = indices.get(requirement.source_excerpt);
    if (index === undefined) {
      index = source_excerpts.length;
      indices.set(requirement.source_excerpt, index);
      source_excerpts.push(requirement.source_excerpt);
    }
    return Object.fromEntries(Object.entries(requirement).map(([key, value]) => key === 'source_excerpt'
      ? ['source_excerpt_index', index] : [key, value])) as IndexedRequirement;
  });
  const factored = { source_excerpts, requirements: indexed };
  return Buffer.byteLength(JSON.stringify(factored)) < Buffer.byteLength(original) ? factored : requirements;
}

export function countingRequirementsReviewText(requirements: readonly CountingRequirementBinding[]): string {
  const context = countingRequirementContext(requirements);
  return JSON.stringify(context) + (Array.isArray(context) ? ''
    : ' Each source_excerpt_index is a zero-based index into this request’s source_excerpts. Substitute that exact string for source_excerpt; every other requirement field is unchanged. These indices are not operator-message IDs or new confirmations.');
}
