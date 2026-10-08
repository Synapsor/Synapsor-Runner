import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createOperatorQuestion, operatorQuestionEpisode, parseOperatorQuestion,
  proposeOperatorAnswer, leaveOperatorQuestionPending, type OperatorQuestion } from './authoring-operator-question.js';
import { runOperatorQuestionModel, consumedOperatorQuestionFailure } from './authoring-operator-question-model.js';
import { PolicySourceChangedError } from './authoring-policy-source.js';
import type { ActionModelSuggestionSession } from './action-tui.js';
import type { OperatorBusinessContext } from './authoring-operator-presentation.js';
import type { BusinessStatementDecisionAdapter } from './authoring-business-statement-host.js';

export type ReceiptDecisionInput = {
  session: ActionModelSuggestionSession; businessContext?: OperatorBusinessContext;
  target: OperatorQuestion['target']; material: string[]; evidence: OperatorQuestion['evidence'];
  selection: NonNullable<OperatorQuestion['receipt_selection']>; predecessor?: OperatorQuestion;
};

/** The receipt domain supplies meaning/configuration bindings and owns its
 * finite mapping pool. Raw capture, review, cancellation and protected writes
 * remain in the existing shared business-statement host. */
export function receiptBusinessStatementAdapter(input: ReceiptDecisionInput): BusinessStatementDecisionAdapter {
  const continuedQuestion = (next: OperatorQuestion, previous?: OperatorQuestion) => {
    if (!previous) return next;
    const { digest: _digest, ...body } = next;
    const continued = { ...body, budget_owner_id: previous.budget_owner_id ?? previous.id, budget: previous.budget! };
    return parseOperatorQuestion({ ...continued, digest: canonicalJsonDigest(continued) });
  };
  return {
    kind: 'receipt_requirement', appendToSource: false,
    createQuestion: identity => continuedQuestion(createOperatorQuestion({ ...identity,
      revision: input.predecessor ? input.predecessor.revision + 1 : 1, kind: 'receipt_requirement',
      target: input.target, material: input.material, evidence: [...identity.evidence, ...input.evidence],
      receipt_selection: input.selection, assistedLocalConsumer: true, continuation: 'receipt_requirement_review',
    }), input.predecessor),
    replacementQuestion: continuedQuestion,
    canReview: question => !question.terminal_failure && question.proposal?.disposition === 'proposed',
    async mapAnswer(ports) {
      const question = ports.readQuestion();
      const episode = operatorQuestionEpisode({ read: ports.readQuestion, save: ports.saveQuestion });
      let result;
      try {
        result = await runOperatorQuestionModel({ question, stage: 'answer-map', session: input.session,
          businessContext: input.businessContext, episodeBudget: episode, reserveCorrection: () => episode.reserveCorrection(),
          authorityGuard: async digest => { await ports.assertCurrent(); return digest; }, egressAcknowledged: true });
      } catch (error) {
        const failure = consumedOperatorQuestionFailure(error, question, 'answer-map');
        if (failure) {
          const current = ports.readQuestion(), { digest: _digest, ...body } = current;
          const stopped = { ...body, terminal_failure: { code: 'ASK_TOOL_ARGUMENTS_INVALID' as const, stage: 'answer-map' as const,
            completion: failure.completion, recorded_at: new Date().toISOString() } };
          await ports.saveQuestion(parseOperatorQuestion({ ...stopped, digest: canonicalJsonDigest(stopped) }), current.digest, true);
        }
        throw error;
      }
      if (result.state === 'question') throw new PolicySourceChangedError();
      const current = ports.readQuestion(), proposed = proposeOperatorAnswer(current, result.proposal);
      await ports.saveQuestion(result.state === 'pending' ? leaveOperatorQuestionPending(proposed, 'unknown') : proposed,
        current.digest, true);
      return result.state === 'pending' ? 'pending' : 'proposed';
    },
  };
}

/** Each native material entry is limited to 2,000 characters. Preserve the
 * exact excerpt (including whitespace and UTF-16 pairs) in labelled sections;
 * section labels are presentation, never new Source line references. */
export function receiptRequirementMaterial(target: { start: number; end: number; source_excerpt: string }): string[] {
  const entries: string[] = [];
  let offset = 0;
  while (offset < target.source_excerpt.length) {
    const label = `Attached Source lines ${target.start}-${target.end}; excerpt part ${entries.length + 1}:\n`;
    let end = Math.min(offset + 2_000 - label.length, target.source_excerpt.length);
    if (end < target.source_excerpt.length && /[\uD800-\uDBFF]/u.test(target.source_excerpt[end - 1]!)) end--;
    entries.push(label + target.source_excerpt.slice(offset, end));
    offset = end;
  }
  return [...entries,
    'Describe the required business evidence of completion. Runner supplies the existing receipt location separately in its readback.',
    'Your interpretation grants no access, storage change, atomicity guarantee or claim that a change has already completed.'];
}
