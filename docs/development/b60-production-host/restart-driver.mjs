// Finite declared-fact fixture for the actual production host/native writers.
// Each invocation is a fresh OS process; no registry survives between phases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createReceiptRequirementHost } from '../../../apps/runner/dist/authoring-receipt-requirement-host.js';
import { createBusinessStatementHost } from '../../../apps/runner/dist/authoring-business-statement-host.js';
import { newPolicySourceSession, policyTextSnapshot, loadPolicySources, savePolicySources,
  activePolicySource } from '../../../apps/runner/dist/authoring-policy-source.js';
import { receiptRequirementQuestionContext, receiptRequirementPreparedContext } from '../../../apps/runner/dist/authoring-receipt-requirement.js';
import { coverageResponseContext } from '../../../apps/runner/dist/authoring-coverage-feedback.js';
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState,
  assertBoundaryAuthoringResumeCurrent } from '../../../apps/runner/dist/boundary-authoring-resume.js';
import { withProjectAuthorityMutation } from '../../../apps/runner/dist/project-authority-mutation.js';

const [root, operation, fault = 'none', declaredAnswer = 'Use the trusted worker completion receipt. Unapplied requests stay pending or approved.'] = process.argv.slice(2);
const manifestFile = path.join(root, 'declared-fixture.json');
const callsFile = path.join(root, 'model-calls.jsonl');
const resultFile = path.join(root, 'last-result.json');
const binding = { boundary_name: 'studio_receipt_variant', generation_lock_fingerprint: canonicalJsonDigest('declared lock'),
  schema_fingerprint: canonicalJsonDigest('declared metadata'), role_posture_fingerprint: canonicalJsonDigest('declared role') };
const store = canonicalJsonDigest('declared exact local receipt store');
const scope = canonicalJsonDigest({ binding, job: 'Complete only from the trusted receipt' });
const attemptKey = canonicalJsonDigest('declared entire prepared review key');
const draft = { read: { source: 'studio' }, actions: [{ name: 'Finish a session', outcome: 'studio.finish',
  effect: { writeback: 'supervised', operation: 'update', target_resource: 'studio.sessions', primary_key: 'id', conflict_key: 'version' } }],
  runner_evidence: { runtime_contract: {
    receipt_configuration: { status: 'current', digest: canonicalJsonDigest('declared storage'), modes: [{source: 'studio', authority: 'runner_ledger'}] },
    receipts: { ledger: 'local', observed: false }, onboarding_reader: { engine: 'postgres', fingerprint: 'declared metadata' } } } };
let sources;
const prepared = () => ({ ...draft, runner_evidence: { ...draft.runner_evidence, receipt_requirement: receiptRequirementPreparedContext(sources, store) } });
if (operation === 'init') {
  sources = newPolicySourceSession();
  const source = policyTextSnapshot(Buffer.from('Describe a completed session only from its trusted completion receipt.'), 'studio-receipt-variant.txt');
  sources.snapshots = [source]; sources.active = source.version;
  const responseContext = coverageResponseContext(source.digest, prepared(), []);
  // Declared host-refusal fixture, not an accepted policy mapping or seeded answer.
  sources.coverage_episodes = [{ id: randomUUID(), context: attemptKey, started_at: '2026-10-07T23:15:45.188Z', submissions: [{
    number: 1, reserved_at: '2026-10-07T23:15:45.188Z', completed_at: '2026-10-07T23:15:46.188Z', validated: false,
    tentative: {status: 'unaccepted_generation', context: responseContext, raw_response: {passages: [{start: 1, end: 1,
      disposition: 'implemented', responsibility: 'runner', draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'] }]}},
    diagnostic: JSON.stringify({context: responseContext, findings: [{component: '/passages/0', typed_reason: 'receipt_configuration.source_requirement_unestablished'}]}),
  }] }];
  await savePolicySources(root, sources);
  await fs.writeFile(manifestFile, JSON.stringify({ sources: sources.id }), {mode: 0o600});
  const initial = buildBoundaryAuthoringResumeState({ binding, stage: 'authority_review', jobIntent: 'Complete only from the trusted receipt',
    provider: 'openai', model: 'declared-offline-model', policySourceSession: sources.id });
  await writeBoundaryAuthoringResumeState(root, initial, {expectedRevisionDigest: null});
  await fs.writeFile(resultFile, JSON.stringify({pid: process.pid, initialized: true}), {mode: 0o600});
  process.exit(0);
}
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
sources = await loadPolicySources(root, manifest.sources);
const loaded = await readBoundaryAuthoringResumeState(root, binding);
if (loaded.status !== 'ready') throw new Error(`Declared native Resume unavailable: ${loaded.status}`);
let resume = loaded.value;
let state = { questions: resume.operator_questions ?? [], handoffs: resume.owner_handoffs ?? [], recovery: resume.generation_recovery,
  conversationTurns: resume.conversation };
const context = () => canonicalJsonDigest({sources: receiptRequirementQuestionContext(sources), draft});
const assertCurrent = permit => assertBoundaryAuthoringResumeCurrent(root, resume, undefined, {permit});
const saveResume = async permit => {
  await assertCurrent(permit);
  const next = buildBoundaryAuthoringResumeState({binding, stage: 'authority_review', jobIntent: resume.job_intent,
    provider: 'openai', model: 'declared-offline-model', previous: resume, policySourceSession: sources.id,
    operatorQuestions: state.questions, ownerHandoffs: state.handoffs, generationRecovery: state.recovery,
    conversation: state.conversationTurns });
  await writeBoundaryAuthoringResumeState(root, next, {permit, expectedRevisionDigest: resume.revision_digest});
  resume = next;
};
let failed = false;
function interrupt(point) {
  if (!failed && fault === point) { failed = true; throw new Error(`DECLARED_INTERRUPTION:${point}`); }
}
function questionBody(value) {
  if (typeof value === 'string') { const match = /Current question: (\{[^\n]+\})/u.exec(value); if (match) return JSON.parse(match[1]); }
  if (value && typeof value === 'object') for (const child of Object.values(value)) { const found = questionBody(child); if (found) return found; }
}
const session = {provider: 'openai', model: 'declared-offline-model', apiKey: 'inert-controlled-credential', dependencies: {requestJson: async request => {
  const question = questionBody(request.body);
  if (!question) throw new Error('Actual request has no native question');
  // The responder uses only actual model-visible raw words, never a private oracle.
  const clear = /completion receipt/u.test(question.raw_answer) && /pending or approved/u.test(question.raw_answer);
  await fs.appendFile(callsFile, JSON.stringify({pid: process.pid, question_id: question.question_id, raw: question.raw_answer}) + '\n', {mode: 0o600});
  return {status: 200, body: {status: 'completed', output: [{type: 'function_call', call_id: randomUUID(), name: 'runner__propose_operator_decision',
    arguments: JSON.stringify({question_id: question.question_id, revision: question.revision, answer_id: question.answer_id, status: 'proposal',
      disposition: clear ? 'proposed' : 'pending', ...(clear ? {value: {kind: 'receipt_requirement', completion_basis: 'applied_change_receipt', unapplied_status: 'pending_or_approved'}} : {})})}]}};
}}};
let prompts = 0, decisions = 0;
const host = createReceiptRequirementHost({projectRoot: root, modelSession: session, businessContext: {references: []}, attemptKey,
  readSources: () => sources, readQuestions: () => state.questions, readHandoff: () => state.handoffs.at(-1),
  scopeDigest: () => scope, storeDigest: () => store, currentDraft: prepared,
  refreshEvidence: async () => {}, readConfiguration: async () => draft.runner_evidence.runtime_contract.receipt_configuration,
  assertReviewCurrent: assertCurrent, questionContext: async permit => { await assertCurrent(permit); return context(); },
  mutate: operation => withProjectAuthorityMutation(root, operation),
  acknowledgeResume: async permit => {
    const confirmed = Boolean(state.questions.at(-1)?.confirmation);
    if(confirmed)interrupt('source_projection'); await saveResume(permit); if(confirmed)interrupt('acknowledgement');
  },
  assertGenerationAdmission: () => {},
  reviewAnswer: review => createBusinessStatementHost({question: review.question, stage: 'authority_review', decision: review.decision,
    assertCurrent: review.assertCurrent, access: {
      readQuestions: () => state.questions, readHandoffs: () => state.handoffs, readRecovery: () => state.recovery,
      readConversationTurns: () => state.conversationTurns, readCheckpointDigest: () => undefined, scopeDigest: () => scope,
      contextDigest: review.contextDigest, mutate: operation => withProjectAuthorityMutation(root, operation),
      install: update => { state = {...state, ...update}; },
      save: async (permit, _stage, subject) => {
        await saveResume(permit);
        const question = state.questions.at(-1);
        if (subject === 'The exact business statement' && question?.raw_answer && !question.proposal) interrupt('raw_answer');
        if (subject === 'The exact business statement' && question?.proposal && !question.confirmation) interrupt('proposal');
        if (subject === 'The owner answer' && question?.confirmation) interrupt('confirmation');
        await review.afterSave(permit);
      }, appendSourceStatement: async () => {throw new Error('Receipt testimony cannot become Source policy');},
      prepareReadDecision: async () => ({}), checkpointFailure: subject => new Error(subject),
    }, interact: async view => {
      if (view.kind === 'question') { prompts++; return {kind: 'answer', binding: view.binding, raw: declaredAnswer}; }
      if (view.kind === 'readback') { decisions++; return {kind: 'decision', binding: view.binding, accepted: true}; }
      return {kind: 'pending', binding: view.binding, choice: operation === 'replace' ? 'replace' : 'review'};
    },
  }).review(),
});
let result, error;
try { result = await host.review(); } catch (caught) { error = caught.message; }
await fs.writeFile(resultFile, JSON.stringify({pid: process.pid, result, error, prompts, decisions,
  native_revision: resume.revision_digest, questions: state.questions, source_reviews: sources.receipt_requirement_reviews ?? []}), {mode: 0o600});
if (error) process.exitCode = 78;
