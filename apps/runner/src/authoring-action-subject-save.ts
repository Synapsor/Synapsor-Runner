import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionLogicalTurnMaterialDigest, assertActionLogicalTurnJournalAdvance, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { actionVersionMaterialDigest, assertActionVersionQuestionHandoff } from "./boundary-authoring-resume.js";
import { parseOperatorQuestion, parseOperatorQuestions, assertOperatorQuestionsAdvance, type OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringActionCheckpoint, authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint,
  authoringQuestionSequenceCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { ModelActionRuleDraftInput } from "./action-rule-model.js";

type Metadata = Parameters<NonNullable<ModelActionRuleDraftInput["onCheckpoint"]>>[1];
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
/** Pure record projection inside the existing protected Resume writer. This
 * neither acquires a lease nor saves/adopts a revision or completes a turn.
 * Ordinary/Version consumers retain their existing rules. Subject questions
 * and their exact checkpoint reference are projected into the SAME save. */
export function projectActionQuestionCheckpoint(input: {
  previous?: ActionRuleAuthoringCheckpoint; next: ActionRuleAuthoringCheckpoint; metadata?: Metadata;
  questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState; stale(): Error;
}): { questions: OperatorQuestion[]; generation?: AuthoringTransportState } {
  const { previous, next, metadata } = input;
  let questions = [...input.questions], generation = input.generation;
  const stale = (): never => { throw input.stale(); };
  if (metadata?.expected_checkpoint_digest && previous?.digest !== metadata.expected_checkpoint_digest) stale();
  assertActionLogicalTurnJournalAdvance(previous, next);
  if (metadata?.subject_question) {
    if (metadata.ordinary_completion || metadata.version_completion || next.pending_version || next.pending_question) stale();
    const q = parseOperatorQuestion(metadata.subject_question.question), ref = next.subject_question;
    const material = q.action_subject?.material;
    if (!material || q.proposal?.value?.kind !== "action_subject" || !ref || ref.id !== q.id
      || ref.revision !== q.revision || ref.question_digest !== q.digest || material.request_digest !== next.intent_digest
      || !next.logical_turns?.some(turn => turn.id === material.logical_turn_id && !turn.completed)) stale();
    const completion = metadata.subject_question.completion;
    if (completion) {
      if (!generation) stale();
      const record = q.proposal!.value!.kind === "action_subject" ? q.proposal!.value!.record : stale();
      const digest = record.provenance.kind === "initial_producer" && equal(completion, q.action_subject!.origin.completion)
        ? q.action_subject!.origin.material_digest
        : record.provenance.kind === "model_answer" && equal(completion, record.provenance.completion)
          ? canonicalJsonDigest({ binding: q.action_subject, record }) : stale();
      generation = authoringActionCheckpoint(generation!, completion,
        { consumer: "action_rule_components", kind: "subject_proposal", material_digest: digest });
    }
    const index = questions.findIndex(item => item.id === q.id);
    if (index < 0) questions.push(q); else questions[index] = q;
    assertOperatorQuestionsAdvance(input.questions, questions);
    questions = parseOperatorQuestions(questions, input.handoffs, generation);
  } else if (metadata?.ordinary_completion) {
    const closed = metadata.ordinary_completion;
    if (next.pending_version || !equal(next.logical_turns?.at(-1)?.completed ?? null, closed)
      || actionLogicalTurnMaterialDigest(next) !== closed.material_digest
      || !equal(authoringQuestionSequenceCompletion([closed.completion]) ?? null, closed.completion)) stale();
    if (closed.kind === "ordinary_clarification") {
      if (!next.pending_question || !equal(next.pending_question.completion ?? null, closed.completion)) stale();
      generation = authoringQuestionCheckpoint(generation, next);
    } else {
      if (next.pending_question || !generation) stale();
      generation = authoringActionCheckpoint(generation!, closed.completion,
        { consumer: "action_rule_components", kind: "compiled_draft", material_digest: closed.material_digest });
    }
  } else if (next.pending_version) {
    const q = questions.find(q => q.id === next.pending_version!.question_id);
    if (!q) stale();
    if (metadata?.version_completion && (q!.presentation || q!.terminal_failure)) {
      if (!generation) stale();
      const phase = q!.terminal_failure?.stage === "present" ? "present" : q!.proposal || q!.terminal_failure ? "answer-map" : "present";
      generation = authoringActionCheckpoint(generation!, metadata.version_completion,
        { consumer: "action_rule_components", kind: "version_interpretation", material_digest: actionVersionMaterialDigest(next, q!, phase) });
    }
    assertActionVersionQuestionHandoff({ generation_recovery: generation, owner_handoffs: [...input.handoffs], operator_questions: questions }, next);
  } else if (!previous?.pending_version) {
    if (next.pending_question) {
      if (!previous?.pending_question || !equal(previous.pending_question, next.pending_question)) generation = authoringQuestionCheckpoint(generation, next);
    } else generation = authoringQuestionAnswerCheckpoint(generation, previous, next);
  }
  return { questions, ...(generation ? { generation } : {}) };
}
