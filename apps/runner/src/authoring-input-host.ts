import path from "node:path";
import { parseActionRuleSourceQuestionPassages } from "./action-rule-source-question-codec.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint, unresolvedAuthoringTransportOperations, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending, presentOperatorQuestion,
  reopenOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { activePolicySource, loadPolicySourcesHeld, policySourceSavedDigest, policySourceSavedDigestHeld, PolicySourceChangedError, adoptPolicySourceAcknowledgement,
  type PolicySourceSession } from "./authoring-policy-source.js";
import { reusableSourceInputConversationReview, type SourceInputConversationPorts,
  type SourceInputConversationRecovery } from "./authoring-input-policy-conversation.js";
import { assertInputInteractionResponse, inputInteractionBinding, type InputInteraction,
  type InputInteractionResponse } from "./authoring-input-interaction.js";
import { rememberModelAuthoringTurn } from "./model-authoring-conversation.js";
import { AskError, type AskHistoryTurn } from "./model-ask.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
/** Only records owned by this Input transition. The enclosing workflow installs
 * them before its protected Resume save and retains that acknowledged state on
 * return. This is not an unrestricted authoring-session setter. */
export type SourceInputRecordUpdate = {
  questions?: OperatorQuestion[];
  handoffs?: AuthoringOwnerHandoff[];
  recovery?: AuthoringTransportState;
  conversationTurns?: AskHistoryTurn[];
};
export type SourceInputHostAccess = {
  readQuestions(): readonly OperatorQuestion[];
  readHandoffs(): readonly AuthoringOwnerHandoff[];
  readRecovery(): AuthoringTransportState | undefined;
  readConversationTurns(): readonly AskHistoryTurn[] | undefined;
  readOutcomes(): readonly string[] | undefined;
  scopeDigest(): Digest;
  contextDigest(sourceContext?: PolicySourceSession, savedSourceContext?: PolicySourceSession): Promise<Digest>;
  contextDigestHeld(permit: ProjectAuthorityMutationPermit, sourceContext?: PolicySourceSession,
    savedSourceContext?: PolicySourceSession): Promise<Digest>;
  assertResumeCurrent(): Promise<void>;
  assertResumeCurrentHeld(permit: ProjectAuthorityMutationPermit): Promise<void>;
  loadContext(): Promise<{ store: string; inspectReader(): Promise<void> }>;
  loadContextHeld(permit: ProjectAuthorityMutationPermit): Promise<{ store: string; inspectReader(): Promise<void> }>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>, parentPermit?: ProjectAuthorityMutationPermit): Promise<T>;
  commit(update: SourceInputRecordUpdate, options: { permit: ProjectAuthorityMutationPermit;
    acknowledgeGeneration: boolean; subject: string }): Promise<void>;
  checkpointFailure(subject: string): Error;
};
export type SourceInputHostInput = {
  projectRoot: string;
  /** Expected Source snapshot; updated only by the exact acknowledged append.
   * Disk Source is reread at every existing currentness boundary. */
  sources: PolicySourceSession;
  store: string;
  outcomes: string[];
  actor: string;
  preserveCurrentReview?: boolean;
  savedRoot?: OperatorQuestion;
  access: SourceInputHostAccess;
  interact(view: InputInteraction, assertCurrent: () => Promise<void>): Promise<InputInteractionResponse>;
};

export function assertSourceInputRootBinding(input: Pick<SourceInputHostInput, "sources" | "store" | "outcomes" | "savedRoot">,
  questions: readonly OperatorQuestion[]): void {
  const root = input.savedRoot;
  if (!root) return;
  const source = activePolicySource(input.sources), binding = root.source_binding;
  const currentRoot = questions.find(q => q.id === root.id);
  if (!source || !binding || !currentRoot || currentRoot.digest !== root.digest
    || binding.source_session !== input.sources.id || binding.source_digest !== source.digest || binding.lines !== source.lines
    || binding.store_digest !== input.store || canonicalJsonDigest(root.target.outcomes) !== canonicalJsonDigest(input.outcomes)
    || binding.agenda_digest !== canonicalJsonDigest({ source_session: input.sources.id, source_digest: source.digest,
      store_digest: input.store, outcomes: input.outcomes })) throw new PolicySourceChangedError();
}

/** One production owner for Input record transitions. Rendering never owns a
 * transition, and the protected commit callback does no semantic interpretation. */
export async function createSourceInputHost(input: SourceInputHostInput): Promise<
  { state: "reused" } | { state: "ready"; ports: SourceInputConversationPorts }> {
  const { sources, store, outcomes, access } = input;
  const source = activePolicySource(sources);
  if (!source) throw new PolicySourceChangedError();
  assertSourceInputRootBinding(input, access.readQuestions());
  const current = sources.input_policy_reviews?.at(-1), handoff = access.readHandoffs().at(-1);
  const waitingForInput = handoff?.state === "waiting" && handoff.consumer === "input_policy";
  if (!waitingForInput && !current?.question_reference && current?.decision === "confirmed"
    && current.source_session === sources.id && current.source_digest === source.digest && current.store_digest === store
    && outcomes.every(o => current.outcomes.includes(o))) {
    await access.assertResumeCurrent();
    return { state: "reused" };
  }
  if (!waitingForInput && input.preserveCurrentReview && current?.question_reference && current.decision === "confirmed"
    && current.source_session === sources.id && current.source_digest === source.digest && current.store_digest === store
    && canonicalJsonDigest(current.outcomes) === canonicalJsonDigest(outcomes)) {
    const root = access.readQuestions().find(q => q.id === current.question_reference!.root_id);
    if (!root) throw new PolicySourceChangedError();
    const reusable = reusableSourceInputConversationReview({ sources, store, outcomes, actor: input.actor,
      questions: { root, children: access.readQuestions().filter(q => q.budget_owner_id === root.id) } });
    if (reusable?.digest === current.digest) {
      await access.assertResumeCurrent();
      if (await policySourceSavedDigest(input.projectRoot, sources.id) !== canonicalJsonDigest(sources)) throw new PolicySourceChangedError();
      const fresh = await access.loadContext();
      if (fresh.store !== store) throw new PolicySourceChangedError();
      await fresh.inspectReader();
      return { state: "reused" };
    }
  }
  const agenda = canonicalJsonDigest({ source_session: sources.id, source_digest: source.digest, store_digest: store, outcomes });
  let root = input.savedRoot ?? access.readQuestions().find(q => q.kind === "input_bounds" && q.source_binding?.agenda_digest === agenda);
  if (!root) await access.mutate(async permit => {
    if (access.readHandoffs().at(-1)?.state === "waiting") throw new Error("AUTHORING_OWNER_QUESTION_PENDING: Inspect the saved question before reviewing another input decision.");
    const contextDigest = await access.contextDigestHeld(permit);
    root = createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", scope_digest: access.scopeDigest(), context_digest: contextDigest,
      target: { phase: "input_policy", outcomes }, source_binding: { source_session: sources.id, source_digest: source.digest as Digest,
        store_digest: store as Digest, agenda_digest: agenda, lines: source.lines },
      material: ["Review the text length requirements for this current Action inventory.",
        "Required presence, nullability, spaces, allowed values and text length are separate. This records an unverified interpretation; it grants no permission."],
      evidence: [{ id: sources.id, digest: source.digest as Digest }, { id: "current-store", digest: store as Digest }],
      continuation: "input_policy_review", assistedLocalConsumer: true });
    await commit({ questions: [...access.readQuestions(), root] }, permit, "The pending input-policy interpretation");
  });
  // Retain only identity. Every transition reads current records, including any
  // budget advancement performed by the admitted controller operation.
  const rootId = root!.id;
  const readQuestions = () => {
    const questions = access.readQuestions(), currentRoot = questions.find(q => q.id === rootId);
    if (!currentRoot) throw access.checkpointFailure("The retained input-policy question");
    return { root: currentRoot, children: questions.filter(q => q.budget_owner_id === currentRoot.id) };
  };
  const assertCurrentHeld = async (permit: ProjectAuthorityMutationPermit, recovery?: SourceInputConversationRecovery, projection?: PolicySourceSession) => {
    await access.assertResumeCurrentHeld(permit);
    let savedSources = projection ?? sources;
    if (recovery?.mode === "append_recovery") {
      if (!recovery.sourceBeforeAppend || canonicalJsonDigest(recovery.sourceBeforeAppend) !== canonicalJsonDigest(sources)) throw new PolicySourceChangedError();
      const expected = structuredClone(recovery.sourceBeforeAppend);
      expected.input_policy_reviews = [...(expected.input_policy_reviews ?? []), recovery.review];
      const actual = await loadPolicySourcesHeld(input.projectRoot, sources.id, permit);
      if (canonicalJsonDigest(actual) !== canonicalJsonDigest(expected)) throw new PolicySourceChangedError();
      savedSources = actual;
    }
    if (await policySourceSavedDigestHeld(input.projectRoot, sources.id, permit) !== canonicalJsonDigest(savedSources)) throw new PolicySourceChangedError();
    const fresh = await access.loadContextHeld(permit);
    if (fresh.store !== store || activePolicySource(savedSources)?.digest !== source.digest
      || canonicalJsonDigest(access.readOutcomes()) !== canonicalJsonDigest(outcomes)) throw new PolicySourceChangedError();
    await fresh.inspectReader();
    if (recovery?.mode === "completed_review") return;
    const records = readQuestions(), q = records.children.at(-1) ?? records.root;
    if (q.scope_digest !== access.scopeDigest()
      || q.context_digest !== await access.contextDigestHeld(permit, recovery?.sourceBeforeAppend, savedSources)) throw new PolicySourceChangedError();
  };
  const assertCurrent = (recovery?: SourceInputConversationRecovery) =>
    withProjectAuthorityMutation(input.projectRoot, permit => assertCurrentHeld(permit, recovery));
  const exchange = async (view: InputInteraction) => {
    const response = await input.interact(structuredClone(view), () => assertCurrent());
    assertInputInteractionResponse(view, response);
    return response;
  };
  const binding = () => {
    const records = readQuestions();
    return inputInteractionBinding(records.root, records.children.at(-1) ?? records.root);
  };
  const ports: SourceInputConversationPorts = {
    readQuestions, assertCurrent, assertCurrentHeld,
    saveQuestion: async (next, expected, options) => access.mutate(async permit => {
      await assertCurrentHeld(permit);
      const questions = access.readQuestions(), old = questions.find(q => q.id === next.id);
      if (!old || old.digest !== expected) throw new PolicySourceChangedError();
      await commit({ questions: questions.map(q => q.id === old.id ? next : q) }, permit, "The exact input-policy question", !options.rawCheckpoint);
    }, options.permit),
    createMissingQuestion: async (currentRoot, text, completion, options) => access.mutate(async permit => {
      await assertCurrentHeld(permit);
      const records = readQuestions();
      if (records.root.digest !== options.expectedRootDigest || records.root.id !== currentRoot.id
        || access.readHandoffs().at(-1)?.state === "waiting") throw new PolicySourceChangedError();
      const naming_passages = parseActionRuleSourceQuestionPassages(options.sourcePassages, records.root, source);
      const h = createOwnerHandoff({ consumer: "input_policy", question: text, scope_digest: records.root.scope_digest,
        context_digest: records.root.context_digest, completion });
      const recovery = authoringQuestionCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(h));
      const q = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(),
        revision: Math.max(records.root.revision, ...records.children.map(c => c.revision)) + 1,
        handoff_id: h.id, kind: "input_bounds", scope_digest: h.scope_digest, context_digest: h.context_digest, target: records.root.target,
        material: records.root.material, evidence: records.root.evidence, continuation: "input_policy_review", budget_owner_id: records.root.id, naming_passages }), text);
      await commit({ questions: [...access.readQuestions(), q], handoffs: [...access.readHandoffs(), h], recovery }, permit, "The missing input-policy question");
    }, options.permit),
    recordRawAnswer: async (q, raw, expected, options) => access.mutate(async permit => {
      await assertCurrentHeld(permit);
      const current = readQuestions().children.at(-1), handoffs = access.readHandoffs(), h = handoffs.at(-1);
      if (!current || !h || current.id !== q.id || current.digest !== expected || h.id !== q.handoff_id || h.state !== "waiting") throw new PolicySourceChangedError();
      let captured = captureOperatorAnswer(current, raw);
      const update: SourceInputRecordUpdate = {};
      if (!raw.trim()) captured = leaveOperatorQuestionPending(captured, "unknown");
      else {
        const answered = answerOwnerHandoff(h, raw, h.context_digest);
        if (h.completion) update.recovery = authoringQuestionAnswerCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(h),
          { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
        update.handoffs = [...handoffs.slice(0, -1), answered];
        const turns = access.readConversationTurns();
        if (turns) {
          const conversation = { turns: structuredClone([...turns]) };
          rememberModelAuthoringTurn(conversation, h.question, raw);
          update.conversationTurns = conversation.turns;
        }
      }
      update.questions = access.readQuestions().map(old => old.id === current.id ? captured : old);
      await commit(update, permit, "The exact raw input-policy answer");
    }, options.permit),
    acknowledge: async (q, review, staged, permit, sourceSave) => access.mutate(async held => {
      const projected=sourceSave ? adoptPolicySourceAcknowledgement(structuredClone(sources),sourceSave) : structuredClone(staged);
      const matchesQuestion=()=> (readQuestions().children.at(-1) ?? readQuestions().root).digest===q.digest
        && reusableSourceInputConversationReview({sources:projected,questions:readQuestions(),outcomes,store,actor:input.actor})?.digest===review.digest;
      if (canonicalJsonDigest(projected)!==canonicalJsonDigest(staged)
        || sourceSave && sourceSave.outcome.reference.path!==path.join(held.projectRoot,".synapsor","boundary-authoring","policy-sources",`${sources.id}.json`)
        || !matchesQuestion()) throw new PolicySourceChangedError();
      await assertCurrentHeld(held, { mode: "completed_review", review }, projected);
      if (!matchesQuestion()) throw new PolicySourceChangedError();
      if (sourceSave) adoptPolicySourceAcknowledgement(sources,sourceSave);
      else { // Already authenticated native recovery observation; no new write ACK.
        for (const key of Object.keys(sources)) if (!Object.hasOwn(projected,key)) Reflect.deleteProperty(sources,key);
        Object.assign(sources,projected);
      }
      await commit({}, held, "The saved input-policy interpretation");
    }, permit),
    resumePending: async (q, currentRoot) => {
      const canAnswer = !(q.source_binding && q.proposal?.disposition !== "proposed");
      if (canAnswer) await assertCurrent();
      const response = await exchange({ kind: "pending", binding: inputInteractionBinding(currentRoot, q),
        sourceInterpretation: Boolean(q.source_binding), canAnswer, defaultValue: "keep", material: [...q.material,
          ...(q.presentation ? [q.presentation.text] : []), ...(q.raw_answer ? [`Previous answer (retained): ${JSON.stringify(q.raw_answer.text)}`] : []),
          "Earlier questions and answers stay recorded. This choice grants no permission and does not renew the allowance."] });
      if (response.kind !== "pending" || response.choice !== "answer") return "keep";
      return access.mutate(async permit => {
        await assertCurrentHeld(permit);
        const records = readQuestions(), latest = records.children.at(-1) ?? records.root;
        if (latest.digest !== q.digest || records.root.digest !== currentRoot.digest || !q.disposition || q.confirmation) throw new PolicySourceChangedError();
        if (!q.raw_answer) {
          const h = q.handoff_id && access.readHandoffs().find(h => h.id === q.handoff_id);
          if (!q.source_binding && (!h || h.state !== "waiting" || h.question !== q.presentation?.text)) throw new PolicySourceChangedError();
          await commit({ questions: access.readQuestions().map(old => old.id === q.id ? reopenOperatorQuestion(q) : old) }, permit, "The reopened input-policy question");
          return "reopen" as const;
        }
        const handoffs = access.readHandoffs(), oldH = handoffs.find(h => h.id === q.handoff_id);
        if (!oldH || !q.presentation || oldH.question !== q.presentation.text
          || oldH.state === "waiting" && q.raw_answer.text.trim()) throw new PolicySourceChangedError();
        let h = oldH;
        const update: SourceInputRecordUpdate = {};
        if (oldH.state === "answered") {
          if (handoffs.at(-1)?.state === "waiting") throw new PolicySourceChangedError();
          const recovery = access.readRecovery();
          if (recovery && unresolvedAuthoringTransportOperations(recovery).length)
            throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "Inspect the unresolved generation before answering another question. No response was replayed.", 409);
          h = createOwnerHandoff({ consumer: "input_policy", question: q.presentation.text, scope_digest: q.scope_digest, context_digest: q.context_digest });
          update.handoffs = [...handoffs, h];
        }
        const next = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: q.revision + 1, handoff_id: h.id,
          kind: "input_bounds", scope_digest: q.scope_digest, context_digest: q.context_digest, target: q.target, material: q.material,
          evidence: q.evidence, continuation: q.continuation, budget_owner_id: records.root.id,
          ...(q.naming_passages ? { naming_passages: q.naming_passages } : {}) }), q.presentation.text);
        update.questions = [...access.readQuestions(), next];
        await commit(update, permit, "The replacement input-policy answer question");
        return "replace" as const;
      });
    },
    prompt: async (text, options) => {
      await assertCurrent();
      const response = await exchange({ kind: "question", binding: binding(), text,
        material: readQuestions().root.material, ...options, recordPolicyAnswer: false });
      if (response.kind !== "answer") throw new PolicySourceChangedError();
      return response.raw;
    },
    confirm: async (lines, options) => {
      const response = await exchange({ kind: "readback", binding: binding(), lines, ...options });
      if (response.kind !== "decision") throw new PolicySourceChangedError();
      return response.accepted;
    },
  };
  return { state: "ready", ports };

  async function commit(update: SourceInputRecordUpdate, permit: ProjectAuthorityMutationPermit, subject: string,
    acknowledgeGeneration = true): Promise<void> {
    await access.commit(update, { permit, acknowledgeGeneration, subject });
  }
}
