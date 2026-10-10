import { readScopeModelCompletion } from "./authoring-read-scope-binding.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createOwnerHandoff, answerOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending,
  operatorQuestionReadback, presentOperatorQuestion, proposeOperatorAnswer, reopenOperatorQuestion,
  parseOperatorQuestions, type OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import { readWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceCheckpoint,
  type ReadScopeAssistanceRequest, type ReadScopeAnswerReference } from "./read-workload-assistance-checkpoint.js";
import { createReadScopeQuestion } from "./authoring-read-scope-question.js";
import type { ReadScopeReference } from "./read-structured-scope.js";
import { rememberModelAuthoringTurn } from "./model-authoring-conversation.js";
import type { AskHistoryTurn } from "./model-ask.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { ModelReadClarificationDecision, ModelReadClarificationRequest } from "./read-authoring-contract-types.js";
import { assertReadMeaningInteractionResponse, readMeaningInteractionBinding, type PreviousReadMeaning,
  type ReadMeaningInteraction, type ReadMeaningInteractionResponse } from "./authoring-read-meaning-interaction.js";

type Digest = `sha256:${string}`;
export type ReadMeaningRecordUpdate = {
  questions?: OperatorQuestion[]; handoffs?: AuthoringOwnerHandoff[];
  checkpoint?: ReadWorkloadAssistanceCheckpoint; recovery?: AuthoringTransportState;
  conversationTurns?: AskHistoryTurn[];
};
export type ReadMeaningHostAccess = {
  readQuestions(): readonly OperatorQuestion[];
  readHandoffs(): readonly AuthoringOwnerHandoff[];
  readCheckpoint(): ReadWorkloadAssistanceCheckpoint | undefined;
  readRecovery(): AuthoringTransportState | undefined;
  readConversationTurns(): readonly AskHistoryTurn[] | undefined;
  scopeDigest(): Digest;
  contextDigest(permit?: ProjectAuthorityMutationPermit): Promise<Digest>;
  assertFresh(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  install(update: ReadMeaningRecordUpdate): void;
  save(permit: ProjectAuthorityMutationPermit, subject: string): Promise<void>;
  checkpointFailure(subject: string): Error;
};

/** Initial Read's existing local question transitions. Its producer still
 * creates real completion/handoff records and indexes meaning only AFTER an
 * accepted remap. Read-edit, values and relationships do not use this host. */
export function createReadMeaningHost(input: {
  access: ReadMeaningHostAccess;
  interact(view: ReadMeaningInteraction, assertCurrent: () => Promise<void>): Promise<ReadMeaningInteractionResponse>;
  answerTooLarge(): void;
}) {
  const { access } = input;
  const exchange = async (view: ReadMeaningInteraction, controls: { assertCurrent(): Promise<void>; binding(): ReadMeaningInteraction["binding"] }) => {
    await controls.assertCurrent();
    const response = await input.interact(structuredClone(view), controls.assertCurrent);
    assertReadMeaningInteractionResponse(view, response);
    await controls.assertCurrent();
    if (canonicalJsonDigest(controls.binding()) !== canonicalJsonDigest(view.binding)) throw new PolicySourceChangedError();
    return response;
  };
  // Preserve an explicit refusal for old callers until the public wiring drops
  // these retired entry points. No history, prompt, model call or save occurs.
  const clarify = async (_request: ModelReadClarificationRequest, _previous?: PreviousReadMeaning): Promise<ModelReadClarificationDecision | undefined> => {
    throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: Reopen the typed Read scope question; legacy meaning interpretation is unsupported.");
  };
  const confirmReplacement = async (_input: { previous: PreviousReadMeaning; request: ModelReadClarificationRequest; answer: string }): Promise<boolean> => {
    throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: Use the exact native Read scope replacement; legacy meaning replacement is unsupported.");
  };
  const scopeQuestion = (request: ReadScopeAssistanceRequest) => {
    const cp = access.readCheckpoint();
    if (!cp || cp.pending_question?.kind !== "scope" || canonicalJsonDigest(cp.pending_question.request) !== canonicalJsonDigest(request))
      throw access.checkpointFailure("The exact saved scope question");
    const questions = parseOperatorQuestions(access.readQuestions(), access.readHandoffs(), access.readRecovery());
    const h = access.readHandoffs().at(-1);
    const q = [...questions].reverse().find(q => q.handoff_id === h?.id && q.kind === "read_scope" && q.read_scope?.mode === "missing_answer");
    if (!q || !h || q.presentation?.text !== request.question || q.read_scope!.record.digest !== request.scope.digest
      || q.read_scope!.record.requirement_bindings.find(r => r.id === q.read_scope!.requirement_id)?.digest !== request.requirement_digest)
      throw access.checkpointFailure("The exact saved scope question");
    return { q, h, cp };
  };
  const assertScopeCurrent = async (request: ReadScopeAssistanceRequest, permit?: ProjectAuthorityMutationPermit) => {
    await access.assertFresh(permit);
    const { q } = scopeQuestion(request);
    if (q.context_digest !== await access.contextDigest(permit) || q.scope_digest !== access.scopeDigest()) throw new PolicySourceChangedError();
  };
  const scopeBinding = (request: ReadScopeAssistanceRequest) => {
    const { q, h, cp } = scopeQuestion(request); return readMeaningInteractionBinding(q, h, cp);
  };
  const saveScopeQuestion = (request: ReadScopeAssistanceRequest, next: OperatorQuestion, expected: Digest) => access.mutate(async permit => {
    await assertScopeCurrent(request, permit);
    const { q } = scopeQuestion(request);
    if (q.digest !== expected) throw new PolicySourceChangedError();
    access.install({ questions: next.id === q.id ? access.readQuestions().map(item => item.id === q.id ? next : item)
      : [...access.readQuestions(), next] });
    await access.save(permit, "The captured scope-answer evidence");
  });
  const answerScope = async (request: ReadScopeAssistanceRequest): Promise<ReadScopeAnswerReference | undefined> => {
    await assertScopeCurrent(request);
    let { q, h, cp } = scopeQuestion(request);
    if (h.state === "answered" && cp.stage === "decided" && cp.pending_question.kind === "scope") {
      const reference = cp.pending_question.decision?.answer_reference;
      if (!reference || !q.raw_answer || reference.question_id !== q.id || reference.revision !== q.revision
        || reference.answer_id !== q.raw_answer.id || q.disposition || !q.raw_answer.text.trim())
        throw access.checkpointFailure("The exact saved raw scope answer");
      return reference;
    }
    if (h.state !== "waiting") throw access.checkpointFailure("The waiting scope question");
    const controls = { assertCurrent: () => assertScopeCurrent(request), binding: () => scopeBinding(request) };
    if (q.raw_answer && q.disposition) {
      let replace = !q.raw_answer.text.trim();
      if (!replace) {
        const response = await exchange({ kind: "pending", binding: controls.binding(), canReplace: true, defaultValue: "keep",
          material: [request.question, `Earlier response: ${q.raw_answer.text}`, "Words are retained as testimony; scope meaning is not yet confirmed."] }, controls);
        if (response.kind !== "pending" || response.choice === "keep") return undefined;
        replace = response.choice === "replace";
      }
      if (replace) {
        const next = presentOperatorQuestion(createReadScopeQuestion({ id: randomUUID(), revision: q.revision + 1,
          handoff_id: q.handoff_id, scope_digest: q.scope_digest, context_digest: q.context_digest,
          read_scope: { ...q.read_scope!, predecessor_id: q.id } }), request.question);
        await saveScopeQuestion(request, next, q.digest); q = next;
      }
    }
    if (q.disposition) { const next = reopenOperatorQuestion(q); await saveScopeQuestion(request, next, q.digest); q = next; }
    let answer = q.raw_answer?.text;
    if (answer === undefined) {
      const response = await exchange({ kind: "question", binding: controls.binding(), text: request.question,
        material: ["Your exact answer will be mapped, then reviewed separately. No meaning or permission is confirmed here."],
        preserveWhitespace: true, recordPolicyAnswer: false, scope_request: request }, controls);
      answer = response.kind === "answer" ? response.raw ?? undefined : undefined;
    }
    if (answer === undefined) { await saveScopeQuestion(request, leaveOperatorQuestionPending(q, "cancelled"), q.digest); return undefined; }
    if (!answer.trim() || answer.length > 1_000) {
      const captured = q.raw_answer ? q : captureOperatorAnswer(q, answer);
      await saveScopeQuestion(request, leaveOperatorQuestionPending(captured, "unknown"), q.digest);
      if (answer.length > 1_000) input.answerTooLarge();
      return undefined;
    }
    const raw = answer, shown = q;
    return access.mutate(async permit => {
      await assertScopeCurrent(request, permit);
      const current = scopeQuestion(request);
      if (current.q.digest !== shown.digest || current.h.state !== "waiting" || current.cp.stage !== "waiting"
        || current.cp.pending_question.kind !== "scope") throw new PolicySourceChangedError();
      const captured = current.q.raw_answer ? current.q : captureOperatorAnswer(current.q, raw);
      const answered = answerOwnerHandoff(current.h, raw, await access.contextDigest(permit));
      const reference = { question_id: captured.id, revision: captured.revision, answer_id: captured.raw_answer!.id };
      const { digest: _old, schema_version: _version, ...body } = current.cp;
      const update: ReadMeaningRecordUpdate = { questions: access.readQuestions().map(item => item.id === captured.id ? captured : item),
        handoffs: access.readHandoffs().map(item => item.id === answered.id ? answered : item),
        checkpoint: readWorkloadAssistanceCheckpoint({ ...body, stage: "decided", pending_question: { ...current.cp.pending_question,
          decision: { state: "answered", answer_reference: reference } } }) };
      if (current.h.completion) update.recovery = authoringQuestionAnswerCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(current.h),
        { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
      access.install(update); await access.save(permit, "The unconfirmed raw scope answer"); return reference;
    });
  };
  const resolveScopeAnswer = (reference: ReadScopeAnswerReference, request: ReadScopeAssistanceRequest): ReadScopeReference | undefined => {
    const questions = parseOperatorQuestions(access.readQuestions(), access.readHandoffs(), access.readRecovery());
    const q = questions.find(q => q.id === reference.question_id), h = q && access.readHandoffs().find(h => h.id === q.handoff_id);
    if (!q || q.kind !== "read_scope" || q.read_scope?.mode !== "missing_answer" || q.disposition || q.confirmation
      || q.revision !== reference.revision || q.raw_answer?.id !== reference.answer_id || !q.raw_answer.text.trim()
      || q.read_scope.record.digest !== request.scope.digest || q.scope_digest !== access.scopeDigest()
      || h?.state !== "answered" || h.answer !== q.raw_answer.text
      || q.read_scope.record.requirement_bindings.find(r => r.id === q.read_scope!.requirement_id)?.digest !== request.requirement_digest
      || questions.some(item => item.read_scope?.predecessor_id === q.id)) return undefined;
    return { kind: "answer", id: `answer:${q.id}:${q.revision}:${q.raw_answer.id}`, digest: canonicalJsonDigest(q.raw_answer),
      question_id: q.id, question_revision: q.revision, answer_id: q.raw_answer.id, text: q.raw_answer.text };
  };
  const replacementState = (reviewId: string, historicalTestimony = false) => {
    const questions = parseOperatorQuestions(access.readQuestions(), access.readHandoffs(), access.readRecovery());
    const review = questions.find(q => q.id === reviewId);
    if (!review || review.read_scope?.mode !== "review" || !review.disposition || review.confirmation
      || !historicalTestimony && questions.some(q => q.read_scope?.predecessor_id === reviewId))
      throw access.checkpointFailure("The exact declined Read scope");
    const raw = [...questions].reverse().find(q => q.read_scope?.mode === "replacement_answer" && q.read_scope.review_question_id === reviewId);
    const handoff = raw && access.readHandoffs().find(h => h.id === raw.handoff_id);
    return { review, raw, handoff, digest: canonicalJsonDigest({ review, raw: raw ?? null, handoff: handoff ?? null }) };
  };
  const assertReplacementCurrent = async (reviewId: string, permit?: ProjectAuthorityMutationPermit) => {
    await access.assertFresh(permit); const state = replacementState(reviewId);
    if (state.review.context_digest !== await access.contextDigest(permit) || state.review.scope_digest !== access.scopeDigest())
      throw new PolicySourceChangedError();
    return state;
  };
  const replacementBinding = (reviewId: string) => {
    const { review, raw, handoff } = replacementState(reviewId);
    if (!raw || !handoff) throw access.checkpointFailure("The recorded replacement question");
    return { question_id: raw.id, question_revision: raw.revision, question_digest: raw.digest,
      handoff_digest: handoff.digest, assistance_digest: review.digest,
      context_digest: raw.context_digest, scope_digest: raw.scope_digest };
  };
  const answerScopeReplacement = async (reviewId: string): Promise<ReadScopeAnswerReference | undefined> => {
    let state = await assertReplacementCurrent(reviewId);
    if (!state.raw) {
      await access.mutate(async permit => {
        const current = await assertReplacementCurrent(reviewId, permit);
        if (current.digest !== state.digest) throw new PolicySourceChangedError();
        const handoff = createOwnerHandoff({ consumer: "read_revision_instruction", question: "What should change in this Read scope?",
          scope_digest: current.review.scope_digest, context_digest: current.review.context_digest });
        const raw = presentOperatorQuestion(createReadScopeQuestion({ id: randomUUID(), revision: 1, handoff_id: handoff.id,
          scope_digest: handoff.scope_digest, context_digest: handoff.context_digest,
          read_scope: { mode: "replacement_answer", review_question_id: reviewId,
            record: current.review.read_scope!.record, completion: readScopeModelCompletion(current.review.read_scope!) } }), handoff.question);
        access.install({ questions: [...access.readQuestions(), raw], handoffs: [...access.readHandoffs(), handoff] });
        await access.save(permit, "The operator-requested Read replacement question");
      });
      state = await assertReplacementCurrent(reviewId);
    }
    const { raw: saved, handoff } = state;
    if (!saved || !handoff) throw access.checkpointFailure("The recorded replacement question");
    if (handoff.state === "answered") {
      if (!saved.raw_answer?.text.trim() || saved.disposition) throw access.checkpointFailure("The captured replacement answer");
      return { question_id: saved.id, revision: saved.revision, answer_id: saved.raw_answer.id };
    }
    if (saved.disposition || saved.raw_answer) {
      // The prompt's native acknowledgement binds a live unanswered question.
      // Reopen cancellation before that wait; keep earlier blank testimony in
      // its immutable revision rather than displaying or overwriting it.
      await access.mutate(async permit => {
        const current = await assertReplacementCurrent(reviewId, permit);
        if (current.digest !== state.digest || current.handoff?.state !== "waiting" || !current.raw)
          throw new PolicySourceChangedError();
        let question = reopenOperatorQuestion(current.raw);
        if (question.raw_answer) question = presentOperatorQuestion(createReadScopeQuestion({
          id: randomUUID(), revision: question.revision + 1, handoff_id: handoff.id,
          context_digest: question.context_digest, scope_digest: question.scope_digest,
          read_scope: { ...question.read_scope!, predecessor_id: question.id },
        }), handoff.question);
        access.install({ questions: question.id === current.raw.id
          ? access.readQuestions().map(q => q.id === question.id ? question : q)
          : [...access.readQuestions(), question] });
        await access.save(permit, "The reopened operator Read correction question");
      });
      state = await assertReplacementCurrent(reviewId);
    }
    const controls = { assertCurrent: async () => { await assertReplacementCurrent(reviewId); }, binding: () => replacementBinding(reviewId) };
    const response = await exchange({ kind: "question", binding: controls.binding(), replacement_review_id: reviewId,
      text: handoff.question, material: ["Your exact correction is raw testimony. The revised mapping will require separate explicit review."],
      preserveWhitespace: true, recordPolicyAnswer: false }, controls);
    const raw = response.kind === "answer" ? response.raw : null;
    return access.mutate(async permit => {
      const current = await assertReplacementCurrent(reviewId, permit);
      if (current.digest !== state.digest || current.handoff?.state !== "waiting" || !current.raw) throw new PolicySourceChangedError();
      if (current.raw.disposition || current.raw.raw_answer) throw access.checkpointFailure("The displayed replacement question");
      let question = raw === null ? leaveOperatorQuestionPending(current.raw, "cancelled")
        : captureOperatorAnswer(current.raw, raw);
      if (raw !== null && (!raw.trim() || raw.length > 1000)) question = leaveOperatorQuestionPending(question, "unknown");
      const accepted = raw !== null && !!raw.trim() && raw.length <= 1000;
      access.install({ questions: question.id === current.raw.id ? access.readQuestions().map(q => q.id === question.id ? question : q)
        : [...access.readQuestions(), question],
        ...(accepted ? { handoffs: access.readHandoffs().map(h => h.id === handoff.id ? answerOwnerHandoff(h, raw!, question.context_digest) : h) } : {}) });
      await access.save(permit, "The unconfirmed operator Read correction");
      if (raw !== null && raw.length > 1000) input.answerTooLarge();
      return accepted ? { question_id: question.id, revision: question.revision, answer_id: question.raw_answer!.id } : undefined;
    });
  };
  const resolveScopeReplacementAnswer = (reference: ReadScopeAnswerReference, reviewId: string): ReadScopeReference | undefined => {
    // A completed successor retires the ability to reopen this review, not its
    // exact immutable testimony. Native parsing still validates the full chain.
    const { raw, handoff } = replacementState(reviewId, true);
    if (!raw || raw.disposition || raw.confirmation || raw.id !== reference.question_id || raw.revision !== reference.revision
      || raw.raw_answer?.id !== reference.answer_id || !raw.raw_answer.text.trim() || handoff?.state !== "answered"
      || handoff.answer !== raw.raw_answer.text) return undefined;
    return { kind: "answer", id: `answer:${raw.id}:${raw.revision}:${raw.raw_answer.id}`, digest: canonicalJsonDigest(raw.raw_answer),
      question_id: raw.id, question_revision: raw.revision, answer_id: raw.raw_answer.id, text: raw.raw_answer.text };
  };
  return { clarify, confirmReplacement, answerScope, resolveScopeAnswer, answerScopeReplacement, resolveScopeReplacementAnswer };
}
