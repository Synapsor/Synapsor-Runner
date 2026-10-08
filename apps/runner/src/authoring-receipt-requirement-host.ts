import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { activePolicySource, PolicySourceChangedError, savePolicySources, type PolicySourceSession } from './authoring-policy-source.js';
import { currentReceiptRequirement, makeReceiptRequirementReview, pendingReceiptRequirement, receiptRequirementDependencies,
  receiptRequirementQuestionTarget, receiptRequirementReviewTarget, receiptRequirementSourceBinding } from './authoring-receipt-requirement.js';
import type { OperatorQuestion } from './authoring-operator-question.js';
import type { ProjectAuthorityMutationPermit } from './project-authority-mutation.js';
import type { AuthoringOwnerHandoff } from './authoring-owner-handoff.js';
import type { ActionModelSuggestionSession } from './action-tui.js';
import type { OperatorBusinessContext } from './authoring-operator-presentation.js';
import type { policyCoverageDraft } from './authoring-policy-evidence.js';
import type { authoringReceiptConfiguration } from './authoring-receipt-configuration.js';
import type { BusinessStatementDecisionAdapter } from './authoring-business-statement-host.js';
import { coverageResponseContext } from './authoring-coverage-feedback.js';
import { receiptBusinessStatementAdapter, receiptRequirementMaterial } from './authoring-receipt-decision-adapter.js';

type Draft = ReturnType<typeof policyCoverageDraft>;
type Digest = `sha256:${string}`;
export type ReceiptRequirementResult =
  | { kind: 'no_target' }
  | { kind: 'pending'; question_id?: string }
  | { kind: 'saved'; disposition: 'reused' | 'confirmed' | 'projection_recovered' }
  | { kind: 'blocked'; code: 'receipt_store_unavailable' | 'receipt_configuration_unestablished'; lines: readonly string[] };

export type ReceiptRequirementAnswerReview = {
  question: string; decision: BusinessStatementDecisionAdapter;
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  contextDigest(permit?: ProjectAuthorityMutationPermit): Promise<Digest>;
  afterSave(permit: ProjectAuthorityMutationPermit): Promise<void>;
};

/** Production receipt interaction owner. Setup, saved Review, edit and Resume
 * supply only current records and existing protected writer/question ports.
 * Target nomination is separate from an acknowledged decision and from the
 * enclosing complete review. No boolean or session flag owns receipt state. */
export function createReceiptRequirementHost(input: {
  projectRoot: string; modelSession: ActionModelSuggestionSession; businessContext: OperatorBusinessContext;
  attemptKey?: string;
  readSources(): PolicySourceSession | undefined;
  readQuestions(): readonly OperatorQuestion[];
  readHandoff(): AuthoringOwnerHandoff | undefined;
  scopeDigest(): Digest; storeDigest(): string | undefined;
  currentDraft(): Draft;
  refreshEvidence(): Promise<void>;
  readConfiguration(): Promise<Awaited<ReturnType<typeof authoringReceiptConfiguration>>>;
  assertReviewCurrent?(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  questionContext(permit: ProjectAuthorityMutationPermit | undefined, sources: PolicySourceSession): Promise<Digest>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  acknowledgeResume(permit: ProjectAuthorityMutationPermit): Promise<void>;
  assertGenerationAdmission(): void;
  reviewAnswer(review: ReceiptRequirementAnswerReview): Promise<string | undefined>;
}) {
  return { async review(): Promise<ReceiptRequirementResult> {
    const sources = input.readSources(), source = activePolicySource(sources);
    if (!sources || !source || !input.modelSession) return { kind: 'no_target' };
    const store = input.storeDigest();
    if (!store) return { kind: 'blocked', code: 'receipt_store_unavailable',
      lines: ['The exact local receipt review store is unavailable. Inspect the saved program before interpreting this rule.'] };
    const handoff = input.readHandoff(), waiting = handoff?.state === 'waiting';
    const savedQuestion = waiting ? input.readQuestions().filter(q => q.handoff_id === handoff.id).at(-1)
      : input.readQuestions().filter(q => q.kind === 'receipt_requirement' && q.scope_digest === input.scopeDigest()
        && receiptRequirementQuestionTarget(q, source, sources.id, store)).at(-1);
    if (waiting && savedQuestion && savedQuestion.kind !== 'receipt_requirement') return { kind: 'no_target' };
    const retained = savedQuestion && sources.receipt_requirement_reviews?.filter(r => r.question.id === savedQuestion.id).at(-1);
    const target = retained ?? (savedQuestion && receiptRequirementQuestionTarget(savedQuestion, source, sources.id, store))
      ?? pendingReceiptRequirement(source, input.currentDraft(), sources)
      ?? receiptRequirementReviewTarget(source, sources.coverage_episodes ?? [], input.attemptKey,
        coverageResponseContext(source.digest, input.currentDraft(), sources.operator_messages ?? []));
    if (!target || retained && (retained.source_session !== sources.id || retained.source_digest !== source.digest)) return { kind: 'no_target' };
    await input.refreshEvidence();
    const draft = input.currentDraft(), configuration = draft.runner_evidence.runtime_contract.receipt_configuration;
    const modes = configuration?.modes ?? [], selected = modes[0];
    if (configuration?.status !== 'current' || !selected || !['runner_ledger', 'source_db'].includes(selected.authority)
      || modes.some(mode => mode.source !== draft.read.source || mode.authority !== selected.authority)) {
      return { kind: 'blocked', code: 'receipt_configuration_unestablished', lines: [
        'Current receipt storage is not established for this exact program. Inspect its supported execution setup; a business answer cannot select storage or establish its guarantees.',
        'The rule, draft and answer history remain saved.'] };
    }
    if (!waiting && currentReceiptRequirement(source, target, draft, sources)) return { kind: 'saved', disposition: 'reused' };
    const dependencies = receiptRequirementDependencies(draft);
    const binding = receiptRequirementSourceBinding(source, sources.id, store, target.start, target.end);
    const predecessor = input.readQuestions().filter(q => q.kind === 'receipt_requirement'
      && q.evidence.find(e => e.id === 'receipt-source-range')?.digest === binding
      && q.receipt_selection?.dependencies_digest === dependencies && q.scope_digest === input.scopeDigest()).at(-1);
    const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
      await input.assertReviewCurrent?.(permit);
      await input.questionContext(permit, sources);
      if (canonicalJsonDigest(await input.readConfiguration()) !== canonicalJsonDigest(configuration)
        || receiptRequirementDependencies(input.currentDraft()) !== dependencies) throw new PolicySourceChangedError();
    };
    const checkpoint = receiptRequirementCheckpoint({ projectRoot: input.projectRoot, sources, store,
      start: target.start, end: target.end, currentDraft: input.currentDraft, questions: input.readQuestions,
      assertCurrent, acknowledge: input.acknowledgeResume });
    if (savedQuestion?.confirmation && savedQuestion.receipt_selection?.dependencies_digest === dependencies) {
      // Complete only a missing Source projection after the real native
      // confirmation save. Do not replay words, mapping or explicit consent.
      await input.mutate(async permit => {
        const current = await input.questionContext(permit, sources);
        if (savedQuestion.scope_digest !== input.scopeDigest() || savedQuestion.context_digest !== current)
          throw new PolicySourceChangedError();
        await checkpoint.saved(permit);
      });
      return currentReceiptRequirement(source, target, input.currentDraft(), sources)
        ? { kind: 'saved', disposition: 'projection_recovered' } : { kind: 'pending', question_id: savedQuestion.id };
    }
    input.assertGenerationAdmission();
    const answer = await input.reviewAnswer({
      question: 'What establishes that a change is complete, and how should an unapplied request be described?',
      assertCurrent, contextDigest: permit => input.questionContext(permit, sources), afterSave: checkpoint.saved,
      decision: receiptBusinessStatementAdapter({ session: input.modelSession, businessContext: input.businessContext,
        target: { phase: 'receipt_requirement', resource: source.digest, field: `lines:${target.start}-${target.end}`,
          outcomes: draft.actions.filter(a => a.effect?.writeback === 'supervised').map(a => a.outcome).sort() },
        material: receiptRequirementMaterial(target),
        evidence: [{ id: 'receipt-source-range', digest: binding }, { id: 'receipt-meaning-dependencies', digest: dependencies }],
        selection: { source: draft.read.source, mode: selected.authority as 'runner_ledger' | 'source_db', dependencies_digest: dependencies },
        ...(predecessor ? { predecessor } : {}) }),
    });
    return answer && currentReceiptRequirement(source, target, input.currentDraft(), sources)
      ? { kind: 'saved', disposition: 'confirmed' } : { kind: 'pending', question_id: checkpoint.current()?.id };
  } };
}

/** An adapter around the existing business-statement host, not another question
 * producer. The actual native question is saved before its Source projection;
 * a partial cross-file save remains inspectable and cannot originate consent. */
export function receiptRequirementCheckpoint(input: {
  projectRoot: string; sources: PolicySourceSession; store: string; start: number; end: number;
  currentDraft(): unknown; questions(): readonly OperatorQuestion[];
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  acknowledge(permit: ProjectAuthorityMutationPermit): Promise<void>;
}) {
  const source = activePolicySource(input.sources);
  if (!source) throw new PolicySourceChangedError();
  const sourceBinding = receiptRequirementSourceBinding(source, input.sources.id, input.store, input.start, input.end);
  const dependencies = receiptRequirementDependencies(input.currentDraft());
  const current = () => input.questions().filter(q => q.kind === 'receipt_requirement'
    && q.evidence.find(e => e.id === 'receipt-source-range')?.digest === sourceBinding
    && q.receipt_selection?.dependencies_digest === dependencies).at(-1);
  return {
    current,
    async saved(permit: ProjectAuthorityMutationPermit) {
      await input.assertCurrent(permit);
      if (receiptRequirementDependencies(input.currentDraft()) !== dependencies) throw new PolicySourceChangedError();
      const q = current();
      if (!q) return; // The existing host saves its handoff before the question.
      const previous = input.sources.receipt_requirement_reviews?.filter(r => r.question.id === q.id).at(-1);
      // Reserve a durable pending target once. Later budget/raw checkpoints stay
      // in Resume; only a real disposition or confirmation adds a decision.
      if (previous?.question.digest === q.digest || previous && !q.disposition && !q.confirmation && !q.terminal_failure) return;
      const review = makeReceiptRequirementReview({ source, session: input.sources, store: input.store,
        start: input.start, end: input.end, draft: input.currentDraft(), question: q });
      const staged = { ...input.sources, receipt_requirement_reviews: [...(input.sources.receipt_requirement_reviews ?? []), review] };
      await savePolicySources(input.projectRoot, staged, { permit, expectedDigest: canonicalJsonDigest(input.sources) });
      Object.assign(input.sources, staged);
      await input.acknowledge(permit);
    },
  };
}
