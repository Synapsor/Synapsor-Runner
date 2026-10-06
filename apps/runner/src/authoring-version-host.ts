import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError } from "./model-provider-transport.js";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint,
  type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint,
  type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, createOperatorQuestion, presentOperatorQuestion,
  reopenOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { assertActionVersionQuestionHandoff } from "./boundary-authoring-resume.js";
import type { ActionAuthoringPendingVersion, ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { VersionConversationPorts } from "./authoring-version-conversation.js";
import { rememberModelAuthoringTurn } from "./model-authoring-conversation.js";
import type { AskHistoryTurn } from "./model-ask.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { assertVersionInteractionResponse, versionInteractionBinding,
  type VersionInteraction, type VersionInteractionResponse } from "./authoring-version-interaction.js";

type Digest = `sha256:${string}`;
type PendingQuestion = NonNullable<ActionRuleAuthoringCheckpoint["pending_question"]>;
export type VersionQuestionRecordUpdate = {
  questions?: OperatorQuestion[];
  handoffs?: AuthoringOwnerHandoff[];
  recovery?: AuthoringTransportState;
  conversationTurns?: AskHistoryTurn[];
};
export type VersionQuestionHostAccess = {
  readQuestions(): readonly OperatorQuestion[];
  readHandoffs(): readonly AuthoringOwnerHandoff[];
  readRecovery(): AuthoringTransportState | undefined;
  readConversationTurns(): readonly AskHistoryTurn[] | undefined;
  readCheckpoint(): ActionRuleAuthoringCheckpoint | undefined;
  scopeDigest(): Digest;
  contextDigest(permit?: ProjectAuthorityMutationPermit): Promise<Digest>;
  /** Actual Source, Read, schema, role and generation-lock checks stay with the
   * owning Action producer. This also checks the current prepared proof. */
  assertFresh(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  assertPreparedProof(marker: ActionAuthoringPendingVersion): void;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  /** Installs only these question records before the existing producer save.
   * The enclosing mutation retains its normal rollback and CAS fence. */
  install(update: VersionQuestionRecordUpdate): void;
  savePendingVersion(marker: ActionAuthoringPendingVersion, question: PendingQuestion,
    completion?: AuthoringOwnerHandoff["completion"]): Promise<void>;
  saveRawCheckpoint(permit: ProjectAuthorityMutationPermit): Promise<void>;
};
export type VersionQuestionHostInput = {
  question: string;
  review: { resource: string; field: string; proof_digest: Digest };
  outcomes: readonly string[];
  completion?: AuthoringOwnerHandoff["completion"];
  initialPendingQuestion: Omit<PendingQuestion, "question" | "completion">;
  access: VersionQuestionHostAccess;
  interact(view: VersionInteraction, assertCurrent: () => Promise<void>): Promise<VersionInteractionResponse>;
};

const stale = () => new AskError("ACTION_VERSION_QUESTION_STALE",
  "The saved counter question or its source changed. Preserve this job and inspect the current setup; no answer or new generation was accepted.", 409);

/** The actual Version question lifecycle owner. The controller still owns model
 * interpretation, and the Action producer still consumes the reviewed mapping. */
export async function createVersionQuestionHost(input: VersionQuestionHostInput): Promise<{
  ports: VersionConversationPorts; rootQuestionId: string;
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
}> {
  const { access, review } = input;
  await access.assertFresh();
  if (!access.readCheckpoint()?.pending_version) {
    if (!input.completion) throw stale();
    await access.mutate(async permit => {
      const cp = access.readCheckpoint(), turn = cp?.logical_turns?.at(-1);
      if (!turn || turn.completed || cp?.pending_version || access.readHandoffs().at(-1)?.state === "waiting") throw stale();
      const h = createOwnerHandoff({ consumer: "version_maintenance", question: input.question,
        scope_digest: access.scopeDigest(), context_digest: await access.contextDigest(permit), completion: input.completion });
      const q = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: h.id, kind: "writer_maintenance",
        scope_digest: h.scope_digest, context_digest: h.context_digest,
        target: { phase: "changed_record_protection", resource: review.resource, field: review.field, outcomes: [...input.outcomes] },
        material: ["This check prevents a prepared change from overwriting a record that another application has changed.",
          "Your statement records planned, unverified counter maintenance. It grants no Read or execution permission."],
        evidence: [{ id: "version-structure", digest: review.proof_digest }], continuation: "version_mapping" });
      access.install({ handoffs: [...access.readHandoffs(), h], questions: [...access.readQuestions(), q],
        recovery: authoringQuestionCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(h)) });
      await access.savePendingVersion({ turn_id: turn.id, root_question_id: q.id, question_id: q.id,
        handoff_id: h.id, resource: review.resource, field: review.field, proof_digest: review.proof_digest },
        { ...input.initialPendingQuestion, question: h.question, completion: input.completion! }, input.completion);
    });
  }
  const readQuestion = () => {
    const marker = access.readCheckpoint()?.pending_version;
    const q = marker && access.readQuestions().find(q => q.id === marker.question_id);
    if (!marker || !q) throw stale();
    return q;
  };
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    await access.assertFresh(permit);
    const cp = access.readCheckpoint(), marker = cp?.pending_version, q = readQuestion();
    if (!cp || !marker || marker.resource !== review.resource || marker.field !== review.field
      || marker.proof_digest !== review.proof_digest || q.scope_digest !== access.scopeDigest()
      || q.context_digest !== await access.contextDigest(permit)) throw stale();
    access.assertPreparedProof(marker);
    assertActionVersionQuestionHandoff({ generation_recovery: access.readRecovery(),
      owner_handoffs: [...access.readHandoffs()], operator_questions: [...access.readQuestions()] }, cp);
  };
  const binding = () => versionInteractionBinding(access.readCheckpoint()!.pending_version!, readQuestion());
  const exchange = async (view: VersionInteraction) => {
    const response = await input.interact(structuredClone(view), () => assertCurrent());
    assertVersionInteractionResponse(view, response);
    return response;
  };
  const persistQuestion: VersionConversationPorts["saveQuestion"] = (q, expected, completion, options) =>
    access.mutate(async permit => {
      await assertCurrent(permit);
      const previous = readQuestion(), cp = access.readCheckpoint()!;
      if (previous.digest !== expected || previous.id !== q.id) throw stale();
      access.install({ questions: access.readQuestions().map(old => old.id === previous.id ? q : old) });
      if (options?.rawCheckpoint) {
        if (completion) throw stale();
        await access.saveRawCheckpoint(permit);
      } else await access.savePendingVersion(cp.pending_version!, cp.pending_question!, completion);
    });
  const ports: VersionConversationPorts = {
    readQuestion, assertCurrent: () => assertCurrent(), saveQuestion: persistQuestion,
    recordRawAnswer: (q, raw, expected) => access.mutate(async permit => {
      await assertCurrent(permit);
      const previous = readQuestion(), cp = access.readCheckpoint()!, handoffs = access.readHandoffs();
      const h = handoffs.find(h => h.id === previous.handoff_id);
      if (previous.digest !== expected || previous.id !== q.id || !h || h.state !== "waiting") throw stale();
      const captured = captureOperatorAnswer(previous, raw);
      const update: VersionQuestionRecordUpdate = {
        questions: access.readQuestions().map(old => old.id === previous.id ? captured : old),
      };
      if (raw.trim()) {
        const answered = answerOwnerHandoff(h, raw, h.context_digest);
        update.handoffs = handoffs.map(old => old.id === h.id ? answered : old);
        if (h.completion) update.recovery = authoringQuestionAnswerCheckpoint(access.readRecovery(),
          ownerHandoffCheckpoint(h), { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
        const turns = access.readConversationTurns();
        if (turns) {
          const conversation = { turns: structuredClone([...turns]) };
          rememberModelAuthoringTurn(conversation, previous.presentation!.text, raw);
          update.conversationTurns = conversation.turns;
        }
      }
      access.install(update);
      await access.savePendingVersion(cp.pending_version!, cp.pending_question!);
      return captured;
    }),
    resumePending: async q => {
      await assertCurrent();
      if (readQuestion().digest !== q.digest) throw stale();
      const response = await exchange({ kind: "pending", binding: binding(), canAnswer: true,
        hasRawAnswer: !!q.raw_answer, defaultValue: "keep",
        material: [...q.material, ...(q.presentation ? [q.presentation.text] : []),
          ...(q.raw_answer ? ["Your saved words:", q.raw_answer.text] : []),
          "Earlier answers and the remaining allowance are retained. This choice changes no permissions."] });
      if (response.kind !== "pending" || response.choice !== "answer") return "keep";
      if (!q.raw_answer) {
        await persistQuestion(reopenOperatorQuestion(q), q.digest);
        return "reopen";
      }
      return access.mutate(async permit => {
        await assertCurrent(permit);
        const previous = readQuestion(), cp = access.readCheckpoint()!, handoffs = access.readHandoffs();
        const oldH = handoffs.find(h => h.id === previous.handoff_id);
        if (previous.digest !== q.digest || previous.confirmation || previous.terminal_failure
          || !previous.disposition || !previous.presentation || !oldH) throw stale();
        let h = oldH;
        const update: VersionQuestionRecordUpdate = {};
        if (previous.raw_answer!.text.trim()) {
          if (oldH.state !== "answered" || oldH.answer !== previous.raw_answer!.text
            || oldH.actor !== previous.raw_answer!.actor || handoffs.at(-1)?.state === "waiting") throw stale();
          h = createOwnerHandoff({ consumer: "version_maintenance", question: previous.presentation.text,
            scope_digest: previous.scope_digest, context_digest: previous.context_digest });
          update.handoffs = [...handoffs, h];
        } else if (oldH.state !== "waiting") throw stale();
        const next = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: previous.revision + 1,
          handoff_id: h.id, kind: "writer_maintenance", scope_digest: previous.scope_digest, context_digest: previous.context_digest,
          target: previous.target, material: previous.material, evidence: previous.evidence, continuation: "version_mapping" }), previous.presentation.text);
        update.questions = [...access.readQuestions(), next];
        access.install(update);
        await access.savePendingVersion({ ...cp.pending_version!, question_id: next.id, handoff_id: h.id }, cp.pending_question!);
        return "replace" as const;
      });
    },
    prompt: async (text, options) => {
      await assertCurrent();
      const response = await exchange({ kind: "question", binding: binding(), text,
        material: readQuestion().material, ...options, recordPolicyAnswer: false });
      if (response.kind !== "answer") throw stale();
      return response.raw ?? undefined;
    },
    confirm: async (lines, options) => {
      await assertCurrent();
      const response = await exchange({ kind: "readback", binding: binding(), lines, ...options });
      if (response.kind !== "decision") throw stale();
      return response.accepted ?? undefined;
    },
  };
  return { ports, assertCurrent, rootQuestionId: access.readCheckpoint()!.pending_version!.root_question_id };
}
