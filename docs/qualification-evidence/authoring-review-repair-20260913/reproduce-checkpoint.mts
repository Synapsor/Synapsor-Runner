// Local reconstructed candidate using original saved state and the recorded
// public answer. Missing historical response bodies are not reconstructed logs.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  prepareBoundaryActionRevision } from '../../../apps/runner/src/boundary-authoring-resume.js';
import { createModelAuthoringConversation, rememberModelAuthoringClarification } from '../../../apps/runner/src/model-authoring-conversation.js';

const E = path.dirname(new URL(import.meta.url).pathname);
const plan = JSON.parse(await fs.readFile(path.join(E, 'assignment-plan.json'), 'utf8'));
const attempt = process.argv[2]; assert(attempt && /^[a-z0-9-]+$/.test(attempt));
const root = path.join(plan.owned_root, 'deterministic', attempt); await fs.mkdir(root, { recursive: true });
const original = path.join(plan.previous_root, 'cases/tournament-ratification/checkpoints/unaided-clarification-refusal');
const finding = JSON.parse(await fs.readFile(path.join(original, 'failure.json'), 'utf8'));
const question = 'Does the reviewed tenant value represent the league for these referee assignments and the shared automatic-ratification limits?';
const results = [];
for (const variant of ['clarification', 'carried-forward-revision']) {
  const copied = path.join(root, variant); await fs.cp(path.join(original, 'project'), copied, { recursive: true, errorOnExist: true, force: false });
  const file = path.join(copied, '.synapsor/boundary-authoring/resume.json');
  const beforeBytes = await fs.readFile(file), previous = JSON.parse(beforeBytes.toString());
  // Checkpoint persistence uses only these exact local paths, not application
  // ledger resolution. No config/binding is edited and no application launches.
  for (const target of [file, path.join(copied, '.synapsor/authority-write-lock.sqlite')]) {
    assert((await fs.realpath(target)).startsWith(await fs.realpath(root) + path.sep));
    assert(!(await fs.lstat(target)).isSymbolicLink());
  }
  const conversation = createModelAuthoringConversation(previous.conversation);
  if (variant === 'clarification') rememberModelAuthoringClarification(conversation, question, finding.exact_answer);
  const input = { binding: previous.binding, stage: previous.stage, jobIntent: previous.job_intent,
    provider: previous.model.provider, model: previous.model.name, conversation: conversation.turns,
    policySourceSession: previous.policy_source_session, readIntent: previous.read_intent, read: previous.read,
    action: previous.action, reviewedVersionFields: previous.reviewed_version_fields,
    intendedClient: previous.intended_client, previous,
    ...(variant === 'carried-forward-revision' ? { pendingActionRevision: prepareBoundaryActionRevision({
      outcome: previous.action.outcome, instruction: 'Reconcile the recorded business meaning with the current disabled rule.',
      operator_statements: [finding.exact_answer], baseline_digest: canonicalJsonDigest({ reconstructed_baseline: true }),
    }) } : {}) };
  let code: string | undefined, state;
  try {
    state = buildBoundaryAuthoringResumeState(input);
    await writeBoundaryAuthoringResumeState(copied, state, { expectedRevisionDigest: previous.revision_digest });
    assert.deepEqual(await readBoundaryAuthoringResumeState(copied, previous.binding), { status: 'ready', value: state });
    for (const field of ['binding', 'read', 'read_intent', 'action', 'reviewed_version_fields', 'intended_client', 'policy_source_session', 'job_intent']) {
      assert.deepEqual(state[field], previous[field], `Preserve ${field}`);
    }
    if (variant === 'clarification') assert.equal(state.conversation.at(-1)?.answer, finding.exact_answer);
    else assert.equal(state.pending_action_revision?.operator_statements?.[0], finding.exact_answer);
  } catch (error) { code = (error as Error).message.split(':')[0]; }
  const failed = code !== undefined;
  if (failed) assert.deepEqual(await fs.readFile(file), beforeBytes, 'Failed save must retain previous progress');
  results.push({ variant, result: failed ? 'refused' : 'saved_and_reloaded', code,
    unchanged_good_checkpoint_on_failure: failed ? true : undefined,
    rejected_field: variant === 'clarification' ? `conversation[${previous.conversation.length}].answer` : 'pending_action_revision.operator_statements[0]',
    producer: variant === 'clarification' ? 'rememberModelAuthoringClarification -> persistAuthoringResume -> buildBoundaryAuthoringResumeState'
      : 'originalPolicyStatements -> prepareBoundaryActionRevision -> persistAuthoringResume -> buildBoundaryAuthoringResumeState',
    provenance: variant === 'clarification' ? 'Recorded exact operator answer; question reconstructed from public transcript'
      : 'Recorded operator answer also persists in policy_sources.operator_messages[2]; synthetic revision envelope, not historical missing response',
    payload_logged: false, runtime_identity_assigned: false, authority_granted: false,
    retained_read_action_counter_client_policy_binding: failed ? undefined : true,
    paths_preflighted: 'owned checkpoint and authority-write-lock only; no business ledger or source opened' });
}
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ at: new Date().toISOString(), attempt,
  original_candidate_unmodified: true, reconstructed_not_historical_response: true, results }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(results));
