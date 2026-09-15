// Owned deterministic schedule at the newly extracted handler's acknowledgement.
// No provider network or runtime authority change. Complete original suite first.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { ensurePreparedPolicyCoverage } from '../../../apps/runner/src/authoring-prepared-policy-review.js';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.js';
import { authoringDestination, loadPolicySources, newPolicySourceSession, policyTextSnapshot, savePolicySources } from '../../../apps/runner/src/authoring-policy-source.js';

const evidence = path.dirname(new URL(import.meta.url).pathname);
const label = process.argv[2];
assert(label && /^[a-z0-9-]+$/.test(label));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-choice-save-race-'));
const source = newPolicySourceSession();
source.snapshots = [policyTextSnapshot(Buffer.from('The approved work uses the shared allowance described by its owner.'), 'rules.txt')];
source.active = 1;
source.operator_messages = [];
source.approvals = [{ digest: source.snapshots[0]!.digest, destination: authoringDestination({ provider: 'openai', model: 'gpt-test' }) }];
await savePolicySources(root, source, { expectedDigest: null });
const saved = JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/fixtures/mixed-counting-review.json', import.meta.url), 'utf8'));
const draft = structuredClone(saved.drafts[0]);
draft.runner_evidence.counting_interpretations = [];
draft.runner_evidence.counting_decisions = [];
const sourcePath = path.join(root, '.synapsor/boundary-authoring/policy-sources', source.id + '.json');
const readFile = fs.readFile;
const concurrentMessage = 'Preserve this independently saved owner note.';
let interleaved = false, producerCalls = 0, completed = false, failure: string | null = null;
const timeline: string[] = [];
// On the first read after the choices are committed, a cooperating independent
// save obtains/releases the real authority lock before the digest read returns.
(fs as any).readFile = async (...args: any[]) => {
  const bytes = await (readFile as any)(...args);
  if (!interleaved && String(args[0]) === sourcePath) {
    const current = JSON.parse(String(bytes));
    if (current.counting_decisions?.length && !current.coverage) {
      interleaved = true;
      timeline.push('own choices committed and source read reached after lock release');
      current.operator_messages.push(concurrentMessage);
      await savePolicySources(root, current, { expectedDigest: canonicalJsonDigest(JSON.parse(String(bytes))) });
      timeline.push('independent source update committed');
      return (readFile as any)(...args);
    }
  }
  return bytes;
};
try {
  const conversation = createModelAuthoringConversation(); conversation.policySources = source;
  await ensurePreparedPolicyCoverage({ projectRoot: root, sources: source, authorityDigest: canonicalJsonDigest(draft.actions),
    modelSession: { provider: 'openai', model: 'gpt-test', apiKey: 'captured-only', conversation,
      dependencies: { requestJson: async () => {
        producerCalls++; timeline.push('coverage producer uses original in-memory source');
        return { status: 200, body: { output: [{ type: 'function_call', call_id: 'owned-review', name: 'runner__review_policy_coverage',
          arguments: JSON.stringify({ passages: [{ start: 1, end: 1, disposition: 'implemented', responsibility: 'runner',
            interpretation: 'The configured approval pools use the explicitly reviewed counting set.', draft_paths: ['/actions/0'] }] }) }] } };
      } } },
    operatorSession: { chooseOption: async () => 'boundary', confirm: async () => true },
    currentDraft: () => ({ ...draft, runner_evidence: { ...draft.runner_evidence, counting_decisions: source.counting_decisions ?? [] } }),
    clarifications: [], assertCurrent: async () => {}, state: {}, requireCountingChoice: true,
    progress: async (_label, operation) => {
      // If the unsafe post-save digest read no longer exists, commit the same
      // competing operation at the next outside-lock provider boundary.
      if (!interleaved) {
        interleaved = true;
        const current = await loadPolicySources(root, source.id);
        timeline.push('own choices committed; independent update enters before provider work');
        current.operator_messages!.push(concurrentMessage);
        await savePolicySources(root, current, { expectedDigest: canonicalJsonDigest(source) });
        timeline.push('independent source update committed');
      }
      return operation();
    },
    onValidated: async () => { completed = true; timeline.push('coverage and completion saved'); },
  });
} catch (error) { failure = String(error); timeline.push('refused: ' + failure); }
finally { fs.readFile = readFile; }
const stored = await loadPolicySources(root, source.id);
const result = { label, interleaved, timeline, producerCalls, completed, failure,
  concurrent_note_preserved: stored.operator_messages?.includes(concurrentMessage) ?? false,
  coverage_saved: Boolean(stored.coverage), root,
  expectation: 'The independent saved source update must survive and the stale review must not complete.' };
await fs.writeFile(path.join(evidence, label + '-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
assert(interleaved, 'The intended real save ordering was not reached');
assert(result.concurrent_note_preserved && !completed && !result.coverage_saved, 'Stale review adopted an unrelated newer digest and overwrote the concurrent source update');
