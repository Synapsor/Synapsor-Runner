import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { answerOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending,
  operatorQuestionReadback, presentOperatorQuestion, proposeOperatorAnswer, reopenOperatorQuestion,
  type OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import { isUnknownReadMeaning } from "./read-meaning-evidence.js";
import { readWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
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
  const readQuestion = () => {
    const h = access.readHandoffs().at(-1);
    const q = [...access.readQuestions()].reverse().find(record => record.handoff_id === h?.id && record.kind === "attributed_meaning");
    if (!q || !h || h.state !== "waiting") throw access.checkpointFailure("The exact saved Read question");
    return q;
  };
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    await access.assertFresh(permit);
    const q = readQuestion();
    if (q.context_digest !== await access.contextDigest(permit) || q.scope_digest !== access.scopeDigest()) throw new PolicySourceChangedError();
  };
  const binding = () => {
    const cp = access.readCheckpoint();
    if (!cp) throw access.checkpointFailure("The exact saved Read question");
    return readMeaningInteractionBinding(readQuestion(), access.readHandoffs().at(-1)!, cp);
  };
  const exchange = async (view: ReadMeaningInteraction) => {
    await assertCurrent();
    const response = await input.interact(structuredClone(view), () => assertCurrent());
    assertReadMeaningInteractionResponse(view, response);
    await assertCurrent();
    if (canonicalJsonDigest(binding()) !== canonicalJsonDigest(view.binding)) throw new PolicySourceChangedError();
    return response;
  };
  const saveQuestion = (next: OperatorQuestion, expected: Digest) => access.mutate(async permit => {
    await assertCurrent(permit);
    const current = readQuestion();
    if (current.id !== next.id || current.digest !== expected) throw new PolicySourceChangedError();
    access.install({ questions: access.readQuestions().map(q => q.id === current.id ? next : q) });
    await access.save(permit, "The exact Read question evidence");
  });
  const acceptQuestion = (shown: OperatorQuestion) => access.mutate(async permit => {
    await access.assertFresh(permit);
    const current = readQuestion(), h = access.readHandoffs().at(-1)!, checkpoint = access.readCheckpoint();
    const contextDigest = await access.contextDigest(permit);
    if (current.digest !== shown.digest || current.context_digest !== contextDigest || current.scope_digest !== access.scopeDigest()
      || !current.raw_answer || !checkpoint || checkpoint.stage !== "waiting" || checkpoint.pending_question.kind !== "clarification"
      || checkpoint.pending_question.request.resource !== current.target.resource || checkpoint.pending_question.request.field !== current.target.field
      || checkpoint.pending_question.question !== current.presentation?.text) throw new PolicySourceChangedError();
    const raw = current.raw_answer.text, adopted = confirmOperatorAnswer(current), answered = answerOwnerHandoff(h, raw, contextDigest);
    const { digest: _old, schema_version: _version, ...body } = checkpoint;
    const update: ReadMeaningRecordUpdate = {
      checkpoint: readWorkloadAssistanceCheckpoint({ ...body, stage: "decided",
        pending_question: { ...checkpoint.pending_question, decision: { state: "answered", answer: raw },
          ...(checkpoint.pending_question.replacement ? { replacement: { ...checkpoint.pending_question.replacement,
            proposed_answer: raw, confirmed: true } } : {}) } }),
      handoffs: access.readHandoffs().map(record => record.id === h.id ? answered : record),
      questions: access.readQuestions().map(record => record.id === current.id ? adopted : record),
    };
    if (h.completion) update.recovery = authoringQuestionAnswerCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(h),
      { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
    const turns = access.readConversationTurns();
    if (turns) { const conversation = { turns: structuredClone([...turns]) };
      rememberModelAuthoringTurn(conversation, h.question, raw); update.conversationTurns = conversation.turns; }
    access.install(update);
    await access.save(permit, "The confirmed Read meaning");
  });
  const resumePending = async (request: ModelReadClarificationRequest) => {
    const saved = readQuestion();
    if (!saved.raw_answer || saved.disposition !== "unknown" && saved.raw_answer.text.trim()) return true;
    const cp = access.readCheckpoint();
    const blankWaiting = !saved.raw_answer.text.trim() && !saved.confirmation && cp?.stage === "waiting"
      && cp.pending_question.kind === "clarification" && !cp.pending_question.decision;
    if (!blankWaiting) {
      const response = await exchange({ kind: "pending", binding: binding(), canAnswer: true, defaultValue: "keep",
        material: [saved.presentation?.text ?? request.question, `Earlier response: ${saved.raw_answer.text}`,
          "A new response uses the same existing Read clarification allowance."] });
      if (response.kind !== "pending" || response.choice !== "answer") return false;
    }
    await access.mutate(async permit => {
      await assertCurrent(permit);
      if (readQuestion().digest !== saved.digest) throw new PolicySourceChangedError();
      access.install({ questions: [...access.readQuestions(), createOperatorQuestion({ id: randomUUID(), revision: saved.revision + 1,
        handoff_id: saved.handoff_id, kind: saved.kind, scope_digest: saved.scope_digest, context_digest: saved.context_digest,
        target: saved.target, material: saved.material, evidence: saved.evidence, continuation: saved.continuation })] });
      await access.save(permit, "The new response to the retained Read question");
    });
    return true;
  };
  const clarify = async (request: ModelReadClarificationRequest, previous?: PreviousReadMeaning): Promise<ModelReadClarificationDecision | undefined> => {
    if (!await resumePending(request)) return undefined;
    let q = readQuestion();
    if (q.disposition && q.disposition !== "unknown") { const next = reopenOperatorQuestion(q); await saveQuestion(next, q.digest); q = next; }
    if (!q.presentation) { const next = presentOperatorQuestion(q, request.question); await saveQuestion(next, q.digest); q = next; }
    let answer = q.raw_answer?.text;
    if (answer === undefined) {
      const response = await exchange({ kind: "question", binding: binding(), text: q.presentation!.text,
        material: [], preserveWhitespace: true, recordPolicyAnswer: false, request, ...(previous ? { previous } : {}) });
      answer = response.kind === "answer" ? response.raw ?? undefined : undefined;
    }
    if (answer === undefined) { await saveQuestion(leaveOperatorQuestionPending(q, "cancelled"), q.digest); return undefined; }
    if (!q.raw_answer) { const next = captureOperatorAnswer(q, answer); await saveQuestion(next, q.digest); q = next; }
    if (answer.trim()) {
      if (answer.length > 1_000) { await saveQuestion(leaveOperatorQuestionPending(q, "unknown"), q.digest); input.answerTooLarge(); return undefined; }
      if (isUnknownReadMeaning(answer)) { await saveQuestion(leaveOperatorQuestionPending(q, "unknown"), q.digest); return { state: "answered", answer }; }
      if (!q.proposal) { const next = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
        answer_id: q.raw_answer!.id, disposition: "proposed", value: { kind: "attributed_meaning" } }); await saveQuestion(next, q.digest); q = next; }
      if (!previous) {
        const response = await exchange({ kind: "readback", binding: binding(), lines: operatorQuestionReadback(q), defaultValue: false, purpose: "meaning" });
        const confirmed = response.kind === "decision" ? response.accepted : null;
        if (confirmed !== true) { await saveQuestion(leaveOperatorQuestionPending(q, confirmed === null ? "cancelled" : "declined"), q.digest); return undefined; }
        await acceptQuestion(q);
      }
      return { state: "answered", answer };
    }
    const response = await exchange({ kind: "readback", binding: binding(), defaultValue: false, purpose: "decline",
      lines: [request.question, "Declining leaves this meaning unanswered. No keeps the exact saved question available on Resume."] });
    const declined = response.kind === "decision" ? response.accepted : null;
    await saveQuestion(leaveOperatorQuestionPending(q, declined === true ? "declined" : declined === null ? "cancelled" : "unknown"), q.digest);
    return declined === true ? { state: "declined" } : undefined;
  };
  const confirmReplacement = async ({ previous, request, answer }: { previous: PreviousReadMeaning; request: ModelReadClarificationRequest; answer: string }) => {
    const assertReplacement = async () => {
      await assertCurrent();
      const cp = access.readCheckpoint(), pending = cp?.pending_question;
      if (cp?.stage !== "waiting" || pending?.kind !== "clarification" || canonicalJsonDigest(pending.request) !== canonicalJsonDigest(request)
        || pending.replacement?.previous_digest !== canonicalJsonDigest(previous) || pending.replacement.proposed_answer !== answer)
        throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The exact pending interpretation review changed. No replacement was accepted.");
    };
    await assertReplacement();
    const response = await exchange({ kind: "readback", binding: binding(), defaultValue: false, purpose: "replacement",
      lines: [`Earlier question: ${previous.question}`, `Earlier answer: ${previous.answer}`, `Follow-up question: ${request.question}`,
        `Proposed answer: ${answer}`, ...operatorQuestionReadback(readQuestion()),
        "Yes replaces only this interpretation. Both exact responses stay in history and count against the same question allowance.",
        "No or cancel keeps the proposal pending and the earlier interpretation current. Resume reopens this review without another answer or model request."] });
    await assertReplacement();
    const confirmed = response.kind === "decision" && response.accepted === true;
    if (confirmed) await acceptQuestion(readQuestion());
    return confirmed;
  };
  return { clarify, confirmReplacement };
}
