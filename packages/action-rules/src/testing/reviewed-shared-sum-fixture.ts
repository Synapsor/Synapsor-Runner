import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createActionRuleAuthority } from '../authority.js';
import { experimentalSharedSumFixture } from './experimental-shared-sum-fixture.js';

/** Component fixture only: attributed confirmation shape, no operator authentication. */
export function reviewedSharedSumFixture(options: Parameters<typeof experimentalSharedSumFixture>[0] = {}) {
  const f = experimentalSharedSumFixture(options);
  const designation = { ...f.designation,
    schema_version: 'synapsor.shared-sum-designation.v1' as const, kind: 'shared_sum' as const,
    unit: { kind: 'integer' as const, unit: options.unit ?? 'reviewed_credits', meaning: 'reviewed credit units' } };
  const shared_sum = { schema_version: 'synapsor.reviewed-shared-sum.v1' as const, designation,
    confirmation: { actor: 'local_installation_operator' as const, decision: 'new_attributed_decision' as const,
      recorded_at: '2026-10-09T00:00:00.000Z',
      question: { id: '00000000-0000-4000-8000-000000000001', revision: 1, digest: canonicalJsonDigest('question') },
      proposal_digest: canonicalJsonDigest('proposal'), context_digest: canonicalJsonDigest('context'),
      source_digest: canonicalJsonDigest('source'), catalog_digest: canonicalJsonDigest(f.authority.authority.catalog),
      generation_lock_fingerprint: f.catalog.generation_lock_fingerprint,
      read_dependencies: [{ name: 'shared.read', digest: f.entries[0]!.read_boundary_digest }],
      designation_digest: canonicalJsonDigest(designation) } };
  const input = { name: 'reviewed_shared_sum', action_boundary_name: 'shared.actions',
    catalog: f.catalog, rules: f.entries, shared_sum };
  const authority = createActionRuleAuthority(input);
  return { ...f, authority, registry: authority.registry, shared_sum };
}
