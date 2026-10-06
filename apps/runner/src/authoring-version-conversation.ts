import type { ActionModelSuggestionSession } from "./action-tui.js";
import type { AskAuthoringEpisodeBudget } from "./model-ask.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { AskError } from "./model-provider-transport.js";
import { isUnknownReadMeaning } from "./read-meaning-evidence.js";
import { runOperatorQuestionModel, consumedOperatorQuestionFailure } from "./authoring-operator-question-model.js";
import { presentOperatorClarification, type OperatorBusinessContext } from "./authoring-operator-presentation.js";
import { parseOperatorQuestion, presentOperatorQuestion, proposeOperatorAnswer, confirmOperatorAnswer,
  leaveOperatorQuestionPending, retainOperatorQuestionWording, stopOperatorVersionQuestion, type OperatorQuestion } from "./authoring-operator-question.js";

type Digest = `sha256:${string}`;
export type VersionConversationBinding = {
  resource: string; field: string; proof_digest: Digest;
  scope_digest: Digest; context_digest: Digest; outcomes: string[];
};
export type VersionConversationPorts = {
  readQuestion(): OperatorQuestion;
  /** Checks the actual current pending_version, owning Action turn/root,
   * Source/Read/schema/role/proof and exact current q/h association. */
  assertCurrent(): Promise<void>;
  saveQuestion(next: OperatorQuestion, expectedDigest: Digest, completion?: AuthoringQuestionCompletion,
    options?: { rawCheckpoint: true }): Promise<void>;
  recordRawAnswer(question: OperatorQuestion, raw: string, expectedDigest: Digest): Promise<OperatorQuestion>;
  prompt(plainQuestion: string, options: { preserveWhitespace: true }): Promise<string | undefined>;
  confirm(readback: string[], options: { defaultValue: false }): Promise<boolean | undefined>;
  /** The host performs its public explicit keep/reopen/replace transition.
   * It retains old q/raw/h history and the owning turn, never a new allowance. */
  resumePending(question: OperatorQuestion): Promise<"keep" | "reopen" | "replace">;
};
export type VersionConversationResult = {
  state: "pending" | "confirmed"; question: OperatorQuestion; terminal?: true;
};

/** Interpret one existing staged Version question outside the fully consumed
 * Action callback batch. This records unverified owner meaning only; the host
 * still performs its normal exact-proof reviewed mapping save. */
export async function runVersionConversation(input: {
  binding: VersionConversationBinding;
  rootQuestionId: string;
  session: ActionModelSuggestionSession;
  actionLogicalTurnBudget: AskAuthoringEpisodeBudget;
  reserveCorrection(rootQuestionId: string): Promise<boolean>;
  ports: VersionConversationPorts;
  egressAcknowledged: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  businessContext?: OperatorBusinessContext;
}): Promise<VersionConversationResult> {
  const { ports, binding } = input;
  const current = async () => {
    await ports.assertCurrent();
    const q = parseOperatorQuestion(ports.readQuestion());
    if (q.kind !== "writer_maintenance" || q.continuation !== "version_mapping" || q.budget || q.budget_owner_id || q.source_binding
      || q.target.resource !== binding.resource || q.target.field !== binding.field
      || q.scope_digest !== binding.scope_digest || q.context_digest !== binding.context_digest
      || JSON.stringify(q.target.outcomes) !== JSON.stringify(binding.outcomes)
      || !q.evidence.some(e => e.digest === binding.proof_digest))
      throw new AskError("ACTION_VERSION_QUESTION_STALE", "The saved question no longer matches the current reviewed counter and owning Action. Preserve its history; no interpretation was sent.", 409);
    if (input.signal?.aborted) throw new AskError("ASK_CANCELLED", "The saved counter question remains pending.", 499);
    return q;
  };
  const save = async (next: OperatorQuestion, previous: OperatorQuestion, completion?: AuthoringQuestionCompletion,
    options?: { rawCheckpoint: true }) => {
    const latest = await current();
    if (latest.digest !== previous.digest) throw new AskError("ACTION_VERSION_QUESTION_STALE", "A competing saved answer changed this question. Reopen the current saved state.", 409);
    await ports.saveQuestion(next, previous.digest, completion, options);
    const saved = await current();
    if (saved.digest !== next.digest) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The exact question save was not acknowledged. Preserve the saved state before continuing.", 409);
    return saved;
  };
  const pending = (q: OperatorQuestion): VersionConversationResult => ({ state: "pending", question: q,
    ...(q.terminal_failure ? { terminal: true as const } : {}) });
  const model = async (q: OperatorQuestion, stage: "present" | "answer-map") => {
    let expectedQuestion = q;
    try {
      const result = await runOperatorQuestionModel({ question: q, stage, session: input.session,
        businessContext: input.businessContext,
        actionLogicalTurnBudget: input.actionLogicalTurnBudget,
        reserveCorrection: () => input.reserveCorrection(input.rootQuestionId),
        authorityGuard: async expected => { const latest = await current();
          if (latest.digest !== expectedQuestion.digest) throw new AskError("ACTION_VERSION_QUESTION_STALE", "The saved counter answer changed before interpretation.", 409);
          return expected; },
        onWordingState: async state => {
          expectedQuestion = await save(retainOperatorQuestionWording(expectedQuestion, state), expectedQuestion,
            undefined, { rawCheckpoint: true });
        },
        env: input.env ?? {}, egressAcknowledged: input.egressAcknowledged, signal: input.signal });
      return { ...result, expectedQuestion };
    } catch (error) {
      // Error prose or a matching code cannot create terminal phase evidence.
      // A partial/unknown/cancelled turn retains the ordinary B32 fence.
      const consumed = consumedOperatorQuestionFailure(error, q, stage);
      if (consumed) await save(stopOperatorVersionQuestion(expectedQuestion, { stage, completion: consumed.completion }), expectedQuestion, consumed.completion);
      throw error;
    }
  };
  let q = await current();
  if (q.terminal_failure) return pending(q);
  if (q.confirmation) return { state: "confirmed", question: q };
  if (q.disposition) {
    if (await ports.resumePending(q) === "keep") return pending(await current());
    q = await current();
    if (q.disposition || q.terminal_failure) return pending(q);
    if (q.confirmation) return { state: "confirmed", question: q };
  }
  if (!q.presentation) {
    const result = await model(q, "present");
    if (result.state !== "question" || !result.completion)
      throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The counter question has no completed presentation. Preserve the saved job.", 409);
    q = await save(presentOperatorQuestion(result.expectedQuestion, result.question), result.expectedQuestion, result.completion);
  }
  if (!q.raw_answer) {
    const answer = await ports.prompt(presentOperatorClarification(q.presentation!.text,
      { stage: "version", context: input.businessContext, target: q.target }), { preserveWhitespace: true });
    await current();
    if (answer === undefined) return pending(await save(leaveOperatorQuestionPending(q, "cancelled"), q));
    const previous = q;
    q = await ports.recordRawAnswer(previous, answer, previous.digest);
    const saved = await current();
    if (saved.digest !== q.digest || q.id !== previous.id || q.revision !== previous.revision
      || q.raw_answer?.text !== answer || q.raw_answer.actor !== "local_installation_operator")
      throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The exact owner answer was not durably acknowledged. Preserve its original words before interpretation.", 409);
    q = saved;
  }
  if (!q.raw_answer!.text.trim() || isUnknownReadMeaning(q.raw_answer!.text))
    return pending(await save(leaveOperatorQuestionPending(q, "unknown"), q));
  if (!q.proposal) {
    const result = await model(q, "answer-map");
    if (result.state === "question" || !result.completion)
      throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The counter answer has no completed interpretation. Preserve the exact saved answer.", 409);
    q = await save(proposeOperatorAnswer(result.expectedQuestion, result.proposal), result.expectedQuestion, result.completion);
  }
  if (q.proposal!.disposition !== "proposed") return pending(await save(leaveOperatorQuestionPending(q, "unknown"), q));
  const readback = [
    ...q.material,
    `Counter: ${binding.resource}.${binding.field}.`,
    "Your exact words:", q.raw_answer!.text,
    "Runner understood: every application that changes one of these records advances this counter on each update.",
    "This records your statement only. Implementation remains unverified. It grants no Read or execution permission and changes no business rule.",
  ];
  const confirmed = await ports.confirm(readback, { defaultValue: false });
  await current();
  if (confirmed !== true) return pending(await save(leaveOperatorQuestionPending(q, confirmed === undefined ? "cancelled" : "declined"), q));
  q = await save(confirmOperatorAnswer(q), q);
  return { state: "confirmed", question: q };
}
