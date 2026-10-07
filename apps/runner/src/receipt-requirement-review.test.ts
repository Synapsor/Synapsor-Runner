import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { policyTextSnapshot, type PolicySourceSession } from './authoring-policy-source.js';
import { createOperatorQuestion, presentOperatorQuestion, captureOperatorAnswer, proposeOperatorAnswer,
  confirmOperatorAnswer, leaveOperatorQuestionPending, operatorQuestionReadback, parseOperatorQuestion } from './authoring-operator-question.js';
import { makeReceiptRequirementReview, currentReceiptRequirement, receiptRequirementDependencies,
  receiptRequirementSourceBinding, receiptRequirementPreparedContext, assertReceiptRequirementReviews } from './authoring-receipt-requirement.js';
import { receiptRequirement, receiptSelectionComponent } from './authoring-obligation-review.js';

const CONFIG = '/runner_evidence/runtime_contract/receipt_configuration';
function fixture() {
  const source = policyTextSnapshot(Buffer.from('Describe an applied change as complete only from its trusted completion receipt.\nPending and approved requests remain pending or approved.'), 'declared-receipt-policy.txt');
  const session: PolicySourceSession = { id: randomUUID(), snapshots: [source], active: 1, approvals: [] };
  const store = canonicalJsonDigest('owned unit store');
  const draft = { read: { source: 'lab' }, actions: [{ name: 'Change a plan', outcome: 'lab.change',
    approvals: { reviewers: 1 }, effect: { writeback: 'supervised', operation: 'update', target_resource: 'lab.plans', target_binding: 'plan',
      primary_key: 'plan_id', conflict_key: 'version', version_advance: { strategy: 'integer_increment', column: 'version' } } }],
    runner_evidence: { runtime_contract: { receipt_configuration: { status: 'current', digest: canonicalJsonDigest('configuration'),
      modes: [{ source: 'lab', authority: 'runner_ledger' }] }, receipts: { ledger: 'local', observed: false },
      onboarding_reader: { engine: 'postgres', generation_lock_fingerprint: 'declared-metadata' } } } };
  const dependencies = receiptRequirementDependencies(draft);
  let question = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: randomUUID(),
    kind: 'receipt_requirement', scope_digest: canonicalJsonDigest('declared job'), context_digest: canonicalJsonDigest('declared current context'),
    target: { phase: 'receipt_requirement', outcomes: ['lab.change'] }, material: [source.text],
    evidence: [{ id: 'receipt-source-range', digest: receiptRequirementSourceBinding(source, session.id, store, 1, 2) as `sha256:${string}` },
      { id: 'receipt-meaning-dependencies', digest: dependencies as `sha256:${string}` }],
    receipt_selection: { source: 'lab', mode: 'runner_ledger', dependencies_digest: dependencies as `sha256:${string}` },
    continuation: 'receipt_requirement_review', assistedLocalConsumer: true }), 'What establishes that a plan change is complete?');
  question = captureOperatorAnswer(question, 'The trusted worker records the completion receipt. Only that receipt allows completed; requests remain pending or approved.');
  question = proposeOperatorAnswer(question, { question_id: question.id, revision: question.revision, answer_id: question.raw_answer!.id,
    disposition: 'proposed', value: { kind: 'receipt_requirement', completion_basis: 'applied_change_receipt', unapplied_status: 'pending_or_approved' } });
  const review = makeReceiptRequirementReview({ source, session, store, start: 1, end: 2, draft, question: confirmOperatorAnswer(question) });
  session.receipt_requirement_reviews = [review];
  const prepared = () => ({ ...draft, runner_evidence: { ...draft.runner_evidence, receipt_requirement: receiptRequirementPreparedContext(session, store) } });
  return { source, session, store, draft, question, review, prepared };
}
describe('attributed completion meaning, configured mode and exact applicability', () => {
  it('keeps generic prose unresolved until the exact structured local decision; selection is still not an observed completion', () => {
    const f = fixture(), passage = { start: 1, end: 2, disposition: 'implemented' as const, responsibility: 'runner' as const,
      issue_kind: 'coverage_link' as const, interpretation: 'The selected receipt configuration matches this duty.', draft_paths: [CONFIG] };
    expect(receiptRequirement(f.source, passage)).toBeUndefined();
    expect(receiptRequirement(f.source, passage, f.prepared(), f.session)).toBe('runner_ledger');
    expect(receiptSelectionComponent(passage, f.source, f.prepared(), f.session)).toMatchObject({ disposition: 'needs_decision', responsibility: 'deployment' });
    expect(f.review.selection).toMatchObject({ origin: 'current_host_configuration', applicability: 'operator_confirmed' });
    expect(f.review.requirement).not.toHaveProperty('mode');
    expect(operatorQuestionReadback(f.review.question).join('\n')).toContain('outside the source database transaction');
  });
  it('retains meaning across a reviewer-count change while checking all receipt/effect dependencies', () => {
    const f = fixture(); f.draft.actions[0]!.approvals.reviewers = 2;
    expect(currentReceiptRequirement(f.source, { start: 1, end: 2 }, f.prepared(), f.session)?.mode).toBe('runner_ledger');
    f.draft.actions[0]!.effect.conflict_key = 'other_version';
    expect(currentReceiptRequirement(f.source, { start: 1, end: 2 }, f.prepared(), f.session)).toBeUndefined();
  });
  it.each(['source', 'store', 'mode', 'contract', 'reader', 'range'] as const)('rejects changed %s without erasing the historical decision', change => {
    const f = fixture(); let source = f.source, span = { start: 1, end: 2 }, draft: any = f.prepared();
    if (change === 'source') source = policyTextSnapshot(Buffer.from('A different policy.'), 'changed-policy.txt');
    if (change === 'store') draft.runner_evidence.receipt_requirement.store_digest = canonicalJsonDigest('other store');
    if (change === 'mode') draft.runner_evidence.runtime_contract.receipt_configuration.modes[0].authority = 'source_db';
    if (change === 'contract') draft.runner_evidence.runtime_contract.receipts.ledger = 'other contract';
    if (change === 'reader') draft.runner_evidence.runtime_contract.onboarding_reader.generation_lock_fingerprint = 'changed';
    if (change === 'range') span = { start: 2, end: 2 };
    expect(currentReceiptRequirement(source, span, draft, f.session)).toBeUndefined();
    expect(f.session.receipt_requirement_reviews![0]).toEqual(f.review);
  });
  it('a later declined replacement blocks the earlier affirmative decision', () => {
    const f = fixture();
    const { digest: _digest, confirmation: _confirmation, proposal: _proposal, raw_answer: _answer, ...body } = f.question;
    const replacement = { ...body, id: randomUUID(), revision: 2, budget_owner_id: body.id };
    let nextQuestion = parseOperatorQuestion({ ...replacement, digest: canonicalJsonDigest(replacement) });
    nextQuestion = captureOperatorAnswer(nextQuestion, 'Completion comes from the trusted worker receipt; pending is pending.');
    nextQuestion = proposeOperatorAnswer(nextQuestion, { question_id: nextQuestion.id, revision: nextQuestion.revision,
      answer_id: nextQuestion.raw_answer!.id, disposition: 'proposed', value: {
        kind: 'receipt_requirement', completion_basis: 'applied_change_receipt', unapplied_status: 'pending_or_approved' } });
    const pending = leaveOperatorQuestionPending(nextQuestion, 'declined');
    const next = makeReceiptRequirementReview({ source: f.source, session: f.session, store: f.store, start: 1, end: 2, draft: f.draft, question: pending });
    f.session.receipt_requirement_reviews!.push(next);
    expect(currentReceiptRequirement(f.source, { start: 1, end: 2 }, f.prepared(), f.session)).toBeUndefined();
    expect(f.session.receipt_requirement_reviews![0]).toEqual(f.review);
  });
  it('does not accept duplicate dependency evidence or attribute host storage to the raw answer', () => {
    const f = fixture(), { digest: _digest, ...body } = f.review.question;
    const duplicate = { ...body, evidence: [...body.evidence, { id: 'receipt-meaning-dependencies', digest: canonicalJsonDigest('different') }] };
    expect(() => parseOperatorQuestion({ ...duplicate, digest: canonicalJsonDigest(duplicate) })).toThrow('AUTHORING_QUESTION_INVALID');
    const forged = { ...f.review, dependencies_digest: canonicalJsonDigest('different') }, { digest: _recordDigest, ...recordBody } = forged;
    expect(() => assertReceiptRequirementReviews([{ ...recordBody, digest: canonicalJsonDigest(recordBody) }])).toThrow('RECEIPT_REQUIREMENT_REVIEW_INVALID');
  });
});
