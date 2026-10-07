import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, unresolvedAuthoringTransportOperations, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending,
  operatorQuestionReadback, presentOperatorQuestion, proposeOperatorAnswer, reopenOperatorQuestion,
  type OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import { isUnknownReadMeaning } from "./read-meaning-evidence.js";
import { validateReadPrerequisiteBusinessAnswer } from "./read-prerequisite-model.js";
import { rememberModelAuthoringClarification, rememberModelAuthoringTurn } from "./model-authoring-conversation.js";
import { AskError, type AskHistoryTurn } from "./model-ask.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { ReadBusinessStatementDecision } from "./authoring-business-statement-read-decision.js";
import { businessStatementBinding, assertBusinessStatementResponse,
  type BusinessStatementInteraction, type BusinessStatementResponse } from "./authoring-business-statement-interaction.js";

type Digest = `sha256:${string}`;
type Stage = "action_drafting" | "authority_review" | "read_mapping";
export type BusinessStatementRecordUpdate = {
  questions?: OperatorQuestion[]; handoffs?: AuthoringOwnerHandoff[];
  recovery?: AuthoringTransportState; conversationTurns?: AskHistoryTurn[];
  readCheckpoint?: ReadBusinessStatementDecision["checkpoint"];
  readDecisions?: ReadBusinessStatementDecision["decisions"];
};
export type BusinessStatementHostAccess = {
  readQuestions(): readonly OperatorQuestion[];
  readHandoffs(): readonly AuthoringOwnerHandoff[];
  readRecovery(): AuthoringTransportState | undefined;
  readConversationTurns(): readonly AskHistoryTurn[] | undefined;
  readCheckpointDigest(): Digest | undefined;
  scopeDigest(): Digest;
  contextDigest(permit: ProjectAuthorityMutationPermit | undefined, consumer: AuthoringOwnerHandoff["consumer"]): Promise<Digest>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  install(update: BusinessStatementRecordUpdate): void;
  save(permit: ProjectAuthorityMutationPermit, stage: Stage, subject: string): Promise<void>;
  appendSourceStatement(permit: ProjectAuthorityMutationPermit, answer: string): Promise<void>;
  prepareReadDecision(permit: ProjectAuthorityMutationPermit, handoff: AuthoringOwnerHandoff,
    question: OperatorQuestion, answer: string): Promise<ReadBusinessStatementDecision>;
  checkpointFailure(subject: string): Error;
};

/** Existing Action attributed testimony and its shared Read-edit adapters.
 * The producer still interprets the answer; confirmation is not policy proof,
 * a disabled draft, permission or a completed program. No allowance is owned here. */
export function createBusinessStatementHost(input: {
  access: BusinessStatementHostAccess;
  question: string; stage: "action_drafting" | "authority_review";
  handoff?: AuthoringOwnerHandoff; producerQuestionDigest?: Digest; privateCorrection?: boolean;
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  interact(view: BusinessStatementInteraction): Promise<BusinessStatementResponse>;
}) {
  const access = input.access;
  let savedHandoff: AuthoringOwnerHandoff;
  const latestQuestion = () => access.readQuestions().filter(q => q.handoff_id === savedHandoff.id)
    .sort((a, b) => a.revision - b.revision).at(-1);
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    await input.assertCurrent(permit);
    const latest = access.readHandoffs().at(-1);
    if (latest?.state !== "waiting" || latest.id !== savedHandoff.id || latest.digest !== savedHandoff.digest
      || latest.scope_digest !== access.scopeDigest()
      || latest.context_digest !== await access.contextDigest(permit, latest.consumer)) throw new PolicySourceChangedError();
  };
  const binding = () => {
    const q = latestQuestion();
    if (!q) throw access.checkpointFailure("The exact business statement");
    return businessStatementBinding(q, savedHandoff, input.producerQuestionDigest,
      input.handoff ? access.readCheckpointDigest() : undefined);
  };
  const exchange = async (view: BusinessStatementInteraction) => {
    await assertCurrent();
    const response = await input.interact(view);
    assertBusinessStatementResponse(view, response);
    await assertCurrent();
    if (canonicalJsonDigest(view.binding) !== canonicalJsonDigest(binding())) throw new PolicySourceChangedError();
    return response;
  };
  const saveQuestion = async (next: OperatorQuestion, expected?: Digest) => access.mutate(async permit => {
    await assertCurrent(permit);
    const questions = access.readQuestions(), old = questions.find(q => q.id === next.id);
    if (expected ? old?.digest !== expected : Boolean(old)) throw new PolicySourceChangedError();
    access.install({ questions: old ? questions.map(q => q.id === next.id ? next : q) : [...questions, next] });
    await access.save(permit, input.stage, "The exact business statement");
  });
  const createHandoff = (consumer: AuthoringOwnerHandoff["consumer"]) => access.mutate(async permit => {
    const context = await access.contextDigest(permit, consumer);
    const handoff = createOwnerHandoff({ consumer, question: input.question,
      scope_digest: access.scopeDigest(), context_digest: context });
    if (access.readHandoffs().at(-1)?.state === "waiting")
      throw new Error("AUTHORING_OWNER_QUESTION_PENDING: Answer or inspect the saved question before another question can replace it.");
    const recovery = access.readRecovery();
    // A recorded disposition retains the uncertain original as history. Use
    // the native validator; unrelated or uncheckpointed output still fences.
    if (recovery && unresolvedAuthoringTransportOperations(recovery).length)
      throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "A question without an acknowledged completed turn cannot clear an unresolved generation. Preserve the current job for inspection.", 409);
    access.install({ handoffs: [...access.readHandoffs(), handoff] });
    await access.save(permit, consumer === "policy_clarification" || consumer.startsWith("read_revision_") ? "authority_review" : "read_mapping", "The owner question");
    return handoff;
  });
  const adopt = (answer: string, question?: OperatorQuestion, testimony = true) => access.mutate(async permit => {
    const current = await access.contextDigest(permit, savedHandoff.consumer), pending = access.readHandoffs().at(-1);
    if (savedHandoff.state !== "waiting" || pending?.state !== "waiting" || pending.id !== savedHandoff.id
      || pending.digest !== savedHandoff.digest || savedHandoff.scope_digest !== access.scopeDigest()
      || savedHandoff.context_digest !== current)
      throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The question's Source, permissions or job changed. Its answer was not accepted; inspect the saved context before continuing.");
    const confirming = question && access.readQuestions().find(q => q.id === question.id);
    if (question && (!confirming || confirming.digest !== question.digest || confirming.handoff_id !== savedHandoff.id
      || confirming.raw_answer?.text !== answer || confirming.proposal?.disposition !== "proposed" || confirming.disposition))
      throw new PolicySourceChangedError();
    // Validate and preserve the existing Read stage decision before Source writes.
    const read = confirming ? await access.prepareReadDecision(permit, savedHandoff, confirming, answer) : {};
    if (read.decisions || read.recovery) access.install({
      ...(read.decisions ? { readDecisions: read.decisions } : {}), ...(read.recovery ? { recovery: read.recovery } : {}),
    });
    // The private prerequisite never appends this raw statement to policy Source.
    if (testimony && savedHandoff.consumer !== "read_revision_prerequisite") await access.appendSourceStatement(permit, answer);
    const acceptedContext = await access.contextDigest(permit, savedHandoff.consumer);
    const next = answerOwnerHandoff(savedHandoff, answer, acceptedContext);
    const update: BusinessStatementRecordUpdate = {
      handoffs: access.readHandoffs().map(h => h.id === savedHandoff.id ? next : h),
      ...(confirming ? { questions: access.readQuestions().map(q => q.id === confirming.id ? confirmOperatorAnswer(confirming) : q) } : {}),
      ...(read.checkpoint ? { readCheckpoint: read.checkpoint } : {}),
    };
    if (savedHandoff.completion) update.recovery = authoringQuestionAnswerCheckpoint(access.readRecovery(),
      ownerHandoffCheckpoint(savedHandoff), { digest: canonicalJsonDigest(next), operator_messages: [answer] });
    const turns = access.readConversationTurns();
    if (testimony && turns) {
      const conversation = { turns: structuredClone([...turns]) };
      if (savedHandoff.consumer === "policy_clarification" || savedHandoff.consumer.startsWith("read_revision_"))
        rememberModelAuthoringClarification(conversation, savedHandoff.question, answer);
      else rememberModelAuthoringTurn(conversation, savedHandoff.question, answer);
      update.conversationTurns = conversation.turns;
    }
    access.install(update);
    await access.save(permit, savedHandoff.consumer === "policy_clarification" || savedHandoff.consumer.startsWith("read_revision_")
      ? "authority_review" : "read_mapping", "The owner answer");
  });
  const review = async (): Promise<string | undefined> => {
    await input.assertCurrent();
    let h = input.handoff ?? access.readHandoffs().at(-1);
    if (!input.handoff && input.producerQuestionDigest && h?.state === "answered"
      && h.consumer === "policy_clarification" && h.question === input.question) {
      const acknowledged = access.readQuestions().filter(q => q.handoff_id === h!.id && q.continuation === "action_rule_review")
        .sort((a, b) => a.revision - b.revision).at(-1);
      const association = acknowledged?.evidence.find(e => e.id === "action-producer-question");
      if (acknowledged && (!association || association.digest === input.producerQuestionDigest))
        throw new Error("ACTION_OPERATOR_ANSWER_CHECKPOINT_INCOMPLETE: The answer is already recorded but its producer question is still pending. Inspect the preserved checkpoint; no question, answer or model allowance was replayed.");
    }
    if (!input.handoff && h?.state === "waiting" && (h.consumer !== "policy_clarification" || h.question !== input.question))
      throw access.checkpointFailure("The exact Action business question");
    if (!h || h.state !== "waiting") h = await createHandoff("policy_clarification");
    savedHandoff = h;
    let q = latestQuestion();
    if (!q) {
      const read = h.consumer.startsWith("read_revision_"), privateRead = h.consumer === "read_revision_prerequisite";
      await saveQuestion(presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: h.id,
        kind: "attributed_meaning", scope_digest: h.scope_digest, context_digest: h.context_digest,
        target: { phase: privateRead ? input.privateCorrection ? "read_prerequisite_correction" : "read_prerequisite" : read ? "read_revision" : "action_rule_components",
          ...(read ? { resource: "current-reviewed-read-edit" } : {}), outcomes: [] },
        material: ["This records only your statement for this exact question. Runner must still map and validate the resulting disabled draft.",
          "It does not override the attached policy, prove database behavior, grant access or enable execution."],
        evidence: [{ id: "current-owner-question", digest: h.digest },
          ...(input.producerQuestionDigest ? [{ id: "action-producer-question", digest: input.producerQuestionDigest }] : [])],
        continuation: read ? "read_mapping" : "action_rule_review" }), h.question));
      q = latestQuestion()!;
    }
    if (q.disposition) {
      const response = await exchange({ kind: "pending", binding: binding(), lines: operatorQuestionReadback(q),
        defaultValue: "keep", canReplace: Boolean(q.raw_answer) });
      const choice = response.kind === "pending" ? response.choice : "keep";
      if (choice === "replace" && q.raw_answer) {
        const previous = q;
        if (previous.raw_answer!.text.trim() && !input.handoff) {
          await adopt(previous.raw_answer!.text, undefined, false);
          savedHandoff = await createHandoff(savedHandoff.consumer);
        }
        await saveQuestion(presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: previous.revision + 1,
          handoff_id: savedHandoff.id, kind: previous.kind, scope_digest: savedHandoff.scope_digest,
          context_digest: savedHandoff.context_digest, target: previous.target, material: previous.material,
          evidence: [{ id: "current-owner-question", digest: savedHandoff.digest },
            ...previous.evidence.filter(e => e.id === "action-producer-question")], continuation: previous.continuation }), savedHandoff.question));
      } else {
        if (choice !== "review") return undefined;
        await saveQuestion(reopenOperatorQuestion(q), q.digest);
      }
      q = latestQuestion()!;
    }
    if (!q.raw_answer) {
      const response = await exchange({ kind: "question", binding: binding(), text: q.presentation!.text,
        material: q.material, preserveWhitespace: true, recordPolicyAnswer: false });
      const raw = response.kind === "answer" ? response.raw ?? undefined : undefined;
      if (raw === undefined) { await saveQuestion(leaveOperatorQuestionPending(q, "cancelled"), q.digest); return undefined; }
      await saveQuestion(captureOperatorAnswer(q, raw), q.digest);
      q = latestQuestion()!;
    }
    const raw = q.raw_answer!.text;
    if (!raw.trim() || isUnknownReadMeaning(raw) || input.handoff && raw.length > (input.handoff.consumer === "read_revision_prerequisite" ? 8_000 : 1_000)) {
      await saveQuestion(leaveOperatorQuestionPending(q, "unknown"), q.digest); return undefined;
    }
    if (input.handoff?.consumer === "read_revision_prerequisite") validateReadPrerequisiteBusinessAnswer(raw);
    if (!q.proposal) {
      await saveQuestion(proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
        answer_id: q.raw_answer!.id, disposition: "proposed", value: { kind: "attributed_meaning" } }), q.digest);
      q = latestQuestion()!;
    }
    const response = await exchange({ kind: "readback", binding: binding(), question: savedHandoff.question,
      lines: operatorQuestionReadback(q), defaultValue: false });
    const yes = response.kind === "decision" ? response.accepted : null;
    if (yes !== true) { await saveQuestion(leaveOperatorQuestionPending(q, yes === null ? "cancelled" : "declined"), q.digest); return undefined; }
    await adopt(raw, q);
    return raw;
  };
  return { review };
}
