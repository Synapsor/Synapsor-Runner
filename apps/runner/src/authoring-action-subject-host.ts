import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestions, captureOperatorAnswer, presentOperatorQuestion, confirmOperatorAnswer,
  leaveOperatorQuestionPending, reopenOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { createActionSubjectQuestion, applyActionSubjectFieldEvent, proposeActionSubjectAnswer } from "./authoring-action-subject.js";
import { runActionSubjectQuestionModel, type OperatorQuestionModelInput } from "./authoring-operator-question-model.js";
import { presentTypedAuthoringReview, confirmTypedAuthoringReview } from "./authoring-question-presenter.js";
import { resolveActionReadSubject } from "./authoring-action-subject-read.js";
import type { ActionSubjectHostMaterial, ActionSubjectProposal } from "./authoring-action-subject-binding.js";
import type { CurrentStructuredReadEvidence } from "./read-current-evidence.js";
import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState, AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { TypedReviewResponse, TypedReviewConfirmation, TypedReviewView } from "./authoring-typed-review.js";
type Digest = `sha256:${string}`;
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function stale(): never { throw new Error("ACTION_SUBJECT_CHANGED: The exact question, subject dependencies or acknowledged Action changed. No later state or authority was adopted."); }
export type ActionSubjectSnapshot = {
  questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[]; generation?: AuthoringTransportState;
  checkpoint: ActionRuleAuthoringCheckpoint; resume_revision_digest: Digest;
  /** Current protected request/Source/catalog/structural-review projection. */
  material: ActionSubjectHostMaterial;
  read?: CurrentStructuredReadEvidence;
};
export type ActionSubjectHostAccess = {
  load(questionId: string, permit?: ProjectAuthorityMutationPermit): Promise<ActionSubjectSnapshot>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  /** Existing native CAS saves generation + full question history + exact
   * subject_question reference together. Reload only its acknowledged revision. */
  save(question: OperatorQuestion, input: { expected: ActionSubjectSnapshot; permit: ProjectAuthorityMutationPermit;
    completion?: AuthoringQuestionCompletion; replaces?: OperatorQuestion }): Promise<void>;
};
function record(q: OperatorQuestion): ActionSubjectProposal {
  if (!q.action_subject || q.proposal?.value?.kind !== "action_subject") stale();
  return q.proposal.value.record;
}
function applicable(saved: ActionSubjectHostMaterial, current: ActionSubjectHostMaterial) {
  // The origin candidate is an actual consumed uncompiled projection. Scope
  // applicability is separate, so unrelated later approval edits don't erase it.
  const { candidate_digest: _saved, logical_turn_id: _turn, ...prior } = saved;
  const { candidate_digest: _current, logical_turn_id: _currentTurn, ...next } = current;
  if (!equal(prior, next)) stale();
}
function checked(snapshot: ActionSubjectSnapshot, questionId: string) {
  const questions = parseOperatorQuestions(snapshot.questions, snapshot.handoffs, snapshot.generation);
  const q = questions.find(item => item.id === questionId);
  if (!q?.action_subject || questions.some(item => item.action_subject?.predecessor?.question_id === q.id)) stale();
  const ref = snapshot.checkpoint.subject_question;
  if (!ref || ref.id !== q.id || ref.revision !== q.revision || ref.question_digest !== q.digest
    || !snapshot.checkpoint.logical_turns?.some(turn => turn.id === q.action_subject!.material.logical_turn_id)) stale();
  applicable(q.action_subject.material, snapshot.material);
  const proposal = record(q);
  for (const entry of proposal.entries) {
    if (entry.state !== "proposed" || entry.support.kind !== "read_subject") continue;
    const target = q.action_subject.material.targets.find(t => t.target_digest === entry.target_digest)!;
    if (!snapshot.read || !equal(resolveActionReadSubject({ target: target.target, options: target.options, read: snapshot.read }), entry)) stale();
  }
  const identity = canonicalJsonDigest({ question: q.digest, material: snapshot.material,
    components: snapshot.checkpoint.components, intent: snapshot.checkpoint.intent_digest, context: snapshot.checkpoint.context_digest,
    subject_question: ref, turn: q.action_subject.material.logical_turn_id });
  return { snapshot, q, proposal, identity };
}
/** Scoped adapter to existing typed presentation, question transitions, model
 * producer and protected native saves. No new store, allowance or authority. */
export function createActionSubjectHost(input: { access: ActionSubjectHostAccess;
  model: Omit<OperatorQuestionModelInput, "question" | "stage" | "authorityGuard" | "episodeBudget" | "onWordingState">;
  present(view: TypedReviewView, assertCurrent: () => Promise<void>): Promise<TypedReviewResponse>;
  confirm(view: TypedReviewView, assertCurrent: () => Promise<void>): Promise<TypedReviewConfirmation>;
}) {
  const load = async (id: string, permit?: ProjectAuthorityMutationPermit) => checked(await input.access.load(id, permit), id);
  const assertShown = async (shown: ReturnType<typeof checked>, permit?: ProjectAuthorityMutationPermit) => {
    const current = await load(shown.q.id, permit);
    if (current.identity !== shown.identity) stale();
    return current;
  };
  const save = async (shown: ReturnType<typeof checked>, change: (q: OperatorQuestion) => OperatorQuestion,
    completion?: AuthoringQuestionCompletion, replace = false) => input.access.mutate(async permit => {
    const current = await assertShown(shown, permit), next = change(current.q);
    await input.access.save(next, { expected: current.snapshot, permit, ...(completion ? { completion } : {}), ...(replace ? { replaces: current.q } : {}) });
    const acknowledged = await load(next.id, permit);
    if (acknowledged.q.digest !== next.digest || acknowledged.q.revision !== next.revision) stale();
    return acknowledged;
  });
  const review = async (questionId: string): Promise<OperatorQuestion | undefined> => {
    let current = await load(questionId);
    if (current.q.confirmation) return current.q;
    // A captured but not mapped answer resumes interpretation; it is never asked again.
    const mapSavedAnswer = async () => {
      if (current.q.disposition || !current.q.raw_answer?.text.trim()) return;
      const history = [...(current.q.proposal_history ?? []), current.q.proposal!];
      if (history.some(p => p.value?.kind === "action_subject" && p.value.record.provenance.kind === "model_answer"
        && p.value.record.provenance.answer.answer_id === current.q.raw_answer!.id)) return;
      const shown = current;
      const mapped = await runActionSubjectQuestionModel({ ...input.model, question: shown.q, stage: "answer-map",
        authorityGuard: async expected => { await assertShown(shown); return expected; } });
      if (!mapped.completion) throw new Error("ACTION_SUBJECT_COMPLETION_REQUIRED: The mapping has no actual consumed response; preserve it for supported inspection.");
      await assertShown(shown);
      current = await save(shown, q => proposeActionSubjectAnswer(q, mapped.entries, mapped.completion!), mapped.completion);
    };
    await mapSavedAnswer();
    for (;;) {
      const shown = current, assertCurrent = async () => { await assertShown(shown); };
      const response = await input.present(shown.proposal.view, assertCurrent);
      await assertCurrent();
      if (!equal(response.kind === "field_event" ? response.event.binding : response.binding, shown.proposal.view.binding)) stale();
      if (response.kind === "pause") {
        await save(shown, q => leaveOperatorQuestionPending(q, "cancelled")); return undefined;
      }
      if (response.kind === "field_event") {
        current = await save(shown, q => applyActionSubjectFieldEvent(q.disposition ? reopenOperatorQuestion(q) : q, response.event));
        continue;
      }
      if (response.kind === "describe_correction") {
        const raw = response.raw;
        if (typeof raw !== "string" || raw.length > 4000) stale();
        const replacement = Boolean(shown.q.raw_answer);
        current = await save(shown, q => {
          let next = q.disposition ? reopenOperatorQuestion(q) : q;
          if (replacement) {
            const initial = [...(q.proposal_history ?? []), q.proposal!][0]!.value;
            if (initial?.kind !== "action_subject") stale();
            next = createActionSubjectQuestion({ id: randomUUID(), revision: q.revision + 1,
              binding: { ...q.action_subject!, predecessor: { question_id: q.id, question_digest: q.digest } },
              entries: initial.record.entries, scope_digest: q.scope_digest, context_digest: q.context_digest });
          }
          if (!next.presentation) next = presentOperatorQuestion(next, shown.proposal.view.unresolved.length === 1
            ? shown.proposal.view.unresolved[0]! : "Describe which records each displayed group may affect.");
          return captureOperatorAnswer(next, raw);
        }, undefined, replacement);
        if (!raw.trim()) return undefined;
        await mapSavedAnswer(); continue;
      }
      const decision = await input.confirm(shown.proposal.view, assertCurrent);
      await assertCurrent();
      if (!equal(decision.binding, shown.proposal.view.binding) || ![true, false, null].includes(decision.accepted)) stale();
      current = await save(shown, q => decision.accepted === true
        ? confirmOperatorAnswer(q.disposition ? reopenOperatorQuestion(q) : q)
        : leaveOperatorQuestionPending(q, decision.accepted === false ? "declined" : "cancelled"));
      return decision.accepted === true ? current.q : undefined;
    }
  };
  return { review };
}
export function actionSubjectPresenter(session: Parameters<typeof presentTypedAuthoringReview>[0]["session"]) {
  return { present: (view: TypedReviewView, assertCurrent: () => Promise<void>) => presentTypedAuthoringReview({ view, session, assertCurrent }),
    confirm: (view: TypedReviewView, assertCurrent: () => Promise<void>) => confirmTypedAuthoringReview({ view, session, assertCurrent }) };
}
