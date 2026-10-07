import { expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { policyTextSnapshot } from './authoring-policy-source.js';
import { receiptRequirementReviewTarget } from './authoring-receipt-requirement.js';

// Native coverage records use two distinct host contexts: the episode binds
// the whole prepared review; its tentative response/refusal binds the draft.
// This shape was observed through ordinary public Review on the declared lab.
function fixture() {
  const source = policyTextSnapshot(Buffer.from('Record processing results for each request. Show when a request is complete.'), 'declared-rules.txt');
  const draft = { read: { source: 'workshop' }, runner_evidence: { receipt: 'declared current configuration' } };
  const draftDigest = canonicalJsonDigest(draft);
  const key = canonicalJsonDigest({ source: source.digest, draft, messages: [], clarifications: [] });
  const episode = { context: key, submissions: [{ completed_at: '2026-10-07T23:15:46.188Z', validated: false,
    tentative: { status: 'unaccepted_generation', context: draftDigest, raw_response: { passages: [
      { start: 1, end: 1, disposition: 'implemented', responsibility: 'runner',
        draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'] },
    ] } }, diagnostic: JSON.stringify({ context: draftDigest, findings: [
      { component: '/passages/0', typed_reason: 'receipt_configuration.source_requirement_unestablished' },
    ] }) }] };
  return { source, draftDigest, key, episode };
}

it('nominates the exact native failed passage with distinct whole-review and draft contexts', () => {
  const f = fixture();
  expect(f.draftDigest).not.toBe(f.key);
  expect(receiptRequirementReviewTarget(f.source, [f.episode], f.key, f.draftDigest))
    .toEqual({ start: 1, end: 1, source_excerpt: f.source.text });
});

it('does not nominate from a stale outer context, a different draft or an unbound refusal', () => {
  const f = fixture();
  expect(receiptRequirementReviewTarget(f.source, [f.episode], canonicalJsonDigest('other whole review'), f.draftDigest)).toBeUndefined();
  expect(receiptRequirementReviewTarget(f.source, [f.episode], f.key, canonicalJsonDigest('different current draft'))).toBeUndefined();
  const wrongRefusal = structuredClone(f.episode);
  wrongRefusal.submissions[0]!.diagnostic = JSON.stringify({ context: canonicalJsonDigest('other refusal draft'), findings: [
    { component: '/passages/0', typed_reason: 'receipt_configuration.source_requirement_unestablished' },
  ] });
  expect(receiptRequirementReviewTarget(f.source, [wrongRefusal], f.key, f.draftDigest)).toBeUndefined();
  const unfinished = { context: f.key, submissions: [] };
  expect(receiptRequirementReviewTarget(f.source, [f.episode, unfinished], f.key, f.draftDigest)).toBeUndefined();
});
