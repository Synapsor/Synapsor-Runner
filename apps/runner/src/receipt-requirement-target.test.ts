import { expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { policyTextSnapshot, newPolicySourceSession } from './authoring-policy-source.js';
import { reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { ensurePreparedPolicyCoverage } from './authoring-prepared-policy-review.js';
import { authoringDestination, savePolicySources } from './authoring-policy-source.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { receiptRequirementReviewTarget } from './authoring-receipt-requirement.js';

// Native coverage records use two distinct host contexts: the episode binds
// the whole prepared review; its tentative response/refusal binds the draft.
// This shape was observed through ordinary public Review on the declared lab.
function fixture() {
  const source = policyTextSnapshot(Buffer.from('Record processing results for each request. Show when a request is complete.'), 'declared-rules.txt');
  const draft = { read: { source: 'workshop' }, runner_evidence: { receipt: 'declared current configuration' } };
  const draftDigest = canonicalJsonDigest({ source: source.digest, draft, messages: [] });
  const key = canonicalJsonDigest({ source: source.digest, draft, messages: [], clarifications: [],
    interpretations: [], source_transaction_scope_reviews: [] });
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
});

it('retains a completed refusal as a question target while unfinished reservations remain untouched', () => {
  const f = fixture();
  const reserved = { context: f.key, submissions: [{ reserved_at: '2026-10-07T23:16:00.000Z' }] };
  const before = structuredClone([f.episode, reserved]);
  expect(receiptRequirementReviewTarget(f.source, [f.episode, reserved], f.key, f.draftDigest))
    .toEqual({ start: 1, end: 1, source_excerpt: f.source.text });
  expect([f.episode, reserved]).toEqual(before);
  const success = structuredClone(f.episode); success.submissions[0]!.validated = true;
  expect(receiptRequirementReviewTarget(f.source, [f.episode, reserved, success], f.key, f.draftDigest)).toBeUndefined();
  const anotherFailure = structuredClone(f.episode);
  anotherFailure.submissions[0]!.diagnostic = JSON.stringify({ context: f.draftDigest, findings: [{ component: '/passages/0', typed_reason: 'other_failure' }] });
  expect(receiptRequirementReviewTarget(f.source, [f.episode, anotherFailure], f.key, f.draftDigest)).toBeUndefined();
});

it('uses the context and refusal actually emitted by the native coverage producer', async () => {
  const source = policyTextSnapshot(Buffer.from('Record processing results for each request. Show when a request is complete.'), 'declared-native-rules.txt');
  const sources = newPolicySourceSession(); sources.snapshots = [source]; sources.active = source.version;
  sources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: 'openai', model: 'declared-offline-model' }) }];
  const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
  const draft = { read: { source: 'workshop' }, actions: [], runner_evidence: { runtime_contract: {
    receipt_configuration: { status: 'current', modes: [{ source: 'workshop', authority: 'runner_ledger' }] },
  } } };
  const key = canonicalJsonDigest({ source: source.digest, draft, messages: [], clarifications: [],
    interpretations: [], source_transaction_scope_reviews: [] });
  const submissions: any[] = []; let calls = 0;
  await expect(reviewPolicyCoverage({ source, draft, sourceSession: sources,
    session: { provider: 'openai', model: 'declared-offline-model', apiKey: 'inert-controlled-credential', conversation,
      dependencies: { requestJson: async request => {
        calls += 1;
        const tool = (request.body as any).tools[0];
        return { status: 200, body: { status: 'completed', output: [{ type: 'function_call', call_id: 'declared-native-call',
          name: tool.name ?? tool.function.name, arguments: JSON.stringify({ passages: [{
            start: 1, end: 1, disposition: 'implemented', responsibility: 'runner', issue_kind: 'coverage_link',
            interpretation: 'The current Runner-ledger configuration records processing results.',
            draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'],
          }] }) }] } };
      } } },
    episode: { beforeSubmission: async () => {}, afterSubmission: async (_number, feedback, accepted, tentative) => {
      submissions.push({ number: _number, reserved_at: '2026-10-07T23:15:45.188Z', completed_at: '2026-10-07T23:15:46.188Z', validated: accepted, tentative,
        diagnostic: feedback ? JSON.stringify(feedback) : undefined });
    } },
  })).rejects.toMatchObject({ code: 'POLICY_COVERAGE_INVALID' });
  expect(calls).toBe(1); expect(submissions).toHaveLength(1);
  expect(submissions[0].tentative.context).toBe(canonicalJsonDigest({ source: source.digest, draft, messages: [] }));
  expect(submissions[0].tentative.context).not.toBe(canonicalJsonDigest(draft));
  expect(receiptRequirementReviewTarget(source, [{ context: key, submissions }], key, submissions[0].tentative.context))
    .toEqual({ start: 1, end: 1, source_excerpt: source.text });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-receipt-target-'));
  try {
    sources.coverage_episodes = [{ id: randomUUID(), context: key,
      started_at: '2026-10-07T23:15:45.188Z', submissions }];
    await savePolicySources(root, sources);
    let extraCalls = 0;
    await expect(ensurePreparedPolicyCoverage({ projectRoot: root, sources,
      modelSession: { provider: 'openai', model: 'declared-offline-model', apiKey: 'inert-controlled-credential', conversation,
        dependencies: { requestJson: async () => { extraCalls += 1; throw new Error('Unexpected extra coverage request'); } } },
      operatorSession: { confirm: async () => true } as never, currentDraft: (() => draft) as never,
      authorityDigest: canonicalJsonDigest('declared current authority'), clarifications: [], assertCurrent: async () => {}, state: {},
    })).rejects.toMatchObject({ plan: expect.objectContaining({ recommended: 'receipt_requirement_review' }) });
    expect(extraCalls).toBe(0);
    expect(sources.coverage_episodes).toHaveLength(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
