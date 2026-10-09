import { parseActionRuleSourceQuestionPassages, type ActionRuleSourceQuestionPassageV1 } from "./action-rule-source-question-codec.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionModelSuggestionSession } from "./action-tui.js";
import { makeSourceInputReview, assertSourceInputRequirements, type SourceInputPolicyReview } from "./authoring-input-policy.js";
import { assertOperatorQuestionsAdvance, confirmOperatorAnswer, leaveOperatorQuestionPending, operatorQuestionEpisode, operatorQuestionReadback,
  parseOperatorQuestion, proposeOperatorAnswer, retainOperatorQuestionWording, stopOperatorInputQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { consumedOperatorInputFailure, runOperatorQuestionModel } from "./authoring-operator-question-model.js";
import { presentOperatorClarification, type OperatorBusinessContext } from "./authoring-operator-presentation.js";
import { activePolicySource, loadPolicySourcesHeld, policySourceSavedDigestHeld, savePolicySources,
  PolicySourceChangedError, type PolicySourceSession } from "./authoring-policy-source.js";
import { AskError, type completedAuthoringQuestionSequence } from "./model-ask.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
type Completion = NonNullable<ReturnType<typeof completedAuthoringQuestionSequence>>;
export type SourceInputConversationRecovery = {
  mode: "completed_review" | "append_recovery";
  review: SourceInputPolicyReview;
  sourceBeforeAppend?: PolicySourceSession;
};
/** These ports use the existing public Resume/B33 storage. None is permission
 * to invent a handoff, answer actor, consumed completion or acknowledgement. */
export type SourceInputConversationPorts = {
  readQuestions(): { root: OperatorQuestion; children: readonly OperatorQuestion[] };
  assertCurrent(recovery?: SourceInputConversationRecovery): Promise<void>;
  assertCurrentHeld(permit: ProjectAuthorityMutationPermit, recovery?: SourceInputConversationRecovery): Promise<void>;
  saveQuestion(next: OperatorQuestion, expectedDigest: Digest, options: {
    permit?: ProjectAuthorityMutationPermit; completion?: Completion; rawCheckpoint?: true;
  }): Promise<void>;
  createMissingQuestion(root: OperatorQuestion, text: string, completion: Completion, options: {
    expectedRootDigest: Digest; sourcePassages: ActionRuleSourceQuestionPassageV1[]; permit?: ProjectAuthorityMutationPermit;
  }): Promise<void>;
  recordRawAnswer(question: OperatorQuestion, raw: string, expectedDigest: Digest, options: {
    permit?: ProjectAuthorityMutationPermit;
  }): Promise<void>;
  /** Idempotent exact review acknowledgement, under the explicit writer permit. */
  acknowledge(question: OperatorQuestion, review: SourceInputPolicyReview, sources: PolicySourceSession,
    permit?: ProjectAuthorityMutationPermit): Promise<void>;
  prompt(text: string, options: { preserveWhitespace: true }): Promise<string | null>;
  confirm(readback: string[], options: { defaultValue: false }): Promise<boolean | null>;
  /** Explicit supported Resume/replacement, not a model call. The host retains
   * prior raw/handoff history and commits its default-safe choice with CAS. */
  resumePending?(question: OperatorQuestion, root: OperatorQuestion, options: { defaultValue: false }):
    Promise<"keep" | "reopen" | "replace">;
};
export type SourceInputConversationResult =
  | { state: "pending"; question: OperatorQuestion; source_database_changed: false; authority_granted: false }
  | { state: "saved" | "reused"; question: OperatorQuestion; review: SourceInputPolicyReview;
      sources: PolicySourceSession; source_database_changed: false; authority_granted: false };

function selectedInputQuestions(records: ReturnType<SourceInputConversationPorts["readQuestions"]>, outcomes: string[]) {
  const root = parseOperatorQuestion(records.root);
  if (root.kind !== "input_bounds" || !root.source_binding || !root.budget || root.budget_owner_id
    || canonicalJsonDigest(root.target.outcomes) !== canonicalJsonDigest(outcomes)) invalid();
  const children = records.children.map(parseOperatorQuestion);
  if (children.some(child => child.kind !== "input_bounds" || child.source_binding || child.budget
    || child.budget_owner_id !== root.id || child.revision <= root.revision || root.confirmation
    || child.context_digest !== root.context_digest || child.scope_digest !== root.scope_digest
    || canonicalJsonDigest(child.target) !== canonicalJsonDigest(root.target)
    || canonicalJsonDigest(child.material) !== canonicalJsonDigest(root.material)
    || canonicalJsonDigest(child.evidence) !== canonicalJsonDigest(root.evidence))
    || new Set(children.map(child => child.revision)).size !== children.length
    || new Set(children.map(child => child.id)).size !== children.length) invalid();
  return { root, question: children.sort((a, b) => b.revision - a.revision)[0] ?? root };
}

/** Read-only reuse check for saved Review. Reuses the consumer's exact current
 * Source/question/proposal/history checks without acknowledging a save again. */
export function reusableSourceInputConversationReview(input: {
  sources: PolicySourceSession; questions: ReturnType<SourceInputConversationPorts["readQuestions"]>;
  outcomes: string[]; store: string; actor: string;
}): SourceInputPolicyReview | undefined {
  const source = activePolicySource(input.sources), { root, question } = selectedInputQuestions(input.questions, input.outcomes);
  const binding = root.source_binding!;
  if (!source || binding.source_session !== input.sources.id || binding.source_digest !== source.digest
    || binding.lines !== source.lines || binding.store_digest !== input.store
    || binding.agenda_digest !== canonicalJsonDigest({ source_session: input.sources.id, source_digest: source.digest,
      store_digest: input.store, outcomes: input.outcomes })) invalid();
  if (!question.confirmation || question.disposition) return undefined;
  return matchingReview(input.sources, question, root, source.digest, input.store, input.actor);
}

/** One assisted Input review, with one host-persisted root allowance. Models
 * propose; local operator confirmation and the ordinary Source CAS save adopt. */
export async function runSourceInputConversation(input: {
  projectRoot: string; sources: PolicySourceSession; session: ActionModelSuggestionSession;
  outcomes: string[]; store: string; actor: string; ports: SourceInputConversationPorts;
  egressAcknowledged: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  businessContext?: OperatorBusinessContext;
}): Promise<SourceInputConversationResult> {
  const ports = input.ports;
  const selected = () => selectedInputQuestions(ports.readQuestions(), input.outcomes);
  const loadCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    const sources = await loadPolicySourcesHeld(input.projectRoot, input.sources.id, permit), source = activePolicySource(sources);
    const { root } = selected(), binding = root.source_binding!;
    if (!source || binding.source_session !== sources.id || binding.source_digest !== source.digest
      || binding.lines !== source.lines || binding.store_digest !== input.store
      || binding.agenda_digest !== canonicalJsonDigest({ source_session: sources.id, source_digest: source.digest,
        store_digest: input.store, outcomes: input.outcomes })) invalid();
    return { sources, source };
  };
  const pendingCurrentHeld = async (permit: ProjectAuthorityMutationPermit, expected?: OperatorQuestion) => {
    const current = await loadCurrentHeld(permit);
    if (await policySourceSavedDigestHeld(input.projectRoot, input.sources.id, permit) !== canonicalJsonDigest(input.sources)
      || canonicalJsonDigest(current.sources) !== canonicalJsonDigest(input.sources)) throw new PolicySourceChangedError();
    if (expected && semanticDigest(selected().question) !== semanticDigest(expected)) invalid();
    await ports.assertCurrentHeld(permit);
    return current;
  };
  const pendingCurrent = (expected?: OperatorQuestion) => withProjectAuthorityMutation(input.projectRoot,
    permit => pendingCurrentHeld(permit, expected), { signal: input.signal });
  const saveQuestion = async (next: OperatorQuestion, expected: OperatorQuestion, completion?: Completion, rawCheckpoint?: true) => {
    await withProjectAuthorityMutation(input.projectRoot, async permit => {
      await pendingCurrentHeld(permit, expected);
      if (selected().question.digest !== expected.digest) invalid();
      await ports.saveQuestion(next, expected.digest, { permit, ...(completion ? { completion } : {}), ...(rawCheckpoint ? { rawCheckpoint } : {}) });
    }, { signal: input.signal });
  };
  const pending = async (q: OperatorQuestion, disposition: "unknown" | "cancelled" | "declined", completion?: Completion,
    expected = q) => {
    const next = leaveOperatorQuestionPending(q, disposition);
    await saveQuestion(next, expected, completion);
    return { state: "pending" as const, question: selected().question, source_database_changed: false as const, authority_granted: false as const };
  };
  const episode = operatorQuestionEpisode({ read: () => selected().root, save: async (next, expected) => {
    await withProjectAuthorityMutation(input.projectRoot, async permit => {
      await pendingCurrentHeld(permit);
      if (selected().root.digest !== expected) invalid();
      await ports.saveQuestion(next, expected, { permit });
    }, { signal: input.signal });
  } });
  let { question } = selected();
  if (question.terminal_failure) throw new AskError("ASK_TOOL_ARGUMENTS_INVALID",
    "This input interpretation exhausted its correction and stopped. The saved question and any answer remain intact. No further interpretation was sent or accepted.", 422);
  if (!question.confirmation) {
    await pendingCurrent();
    if (question.disposition) {
      const before = selected(), oldRecords = [before.root, ...ports.readQuestions().children];
      const choice = await ports.resumePending?.(question, before.root, { defaultValue: false }) ?? "keep";
      if (choice === "keep") return { state: "pending", question, source_database_changed: false, authority_granted: false };
      await pendingCurrent();
      const after = selected();
      assertOperatorQuestionsAdvance(oldRecords, [after.root, ...ports.readQuestions().children]);
      if (canonicalJsonDigest(before.root.budget) !== canonicalJsonDigest(after.root.budget)
        || choice === "reopen" && (question.raw_answer || after.question.id !== question.id || after.question.disposition)
        || choice === "replace" && (!question.raw_answer || after.question.id === question.id
          || after.question.revision <= question.revision || after.question.raw_answer || after.question.proposal
          || after.question.confirmation || after.question.disposition || after.question.presentation?.text !== question.presentation?.text)) invalid();
      question = after.question;
    }
    if (!question.proposal) {
      if (question.source_binding) {
        let original = question;
        const { source } = await pendingCurrent();
        const result = await interpret({ question, stage: "source-review", session: input.session,
          businessContext: input.businessContext,
          episodeBudget: episode, reserveCorrection: episode.reserveCorrection,
          authorityGuard: async expected => { await pendingCurrent(original); return expected; },
          policyText: source.text, validateProposal: validateDomain, env: input.env,
          egressAcknowledged: input.egressAcknowledged, signal: input.signal });
        original = result.expectedQuestion;
        question = selected().question;
        if (result.state === "question") {
          if (!result.completion) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The missing-business question has no current consumed generation. Preserve it for inspection; no handoff was fabricated.", 409);
          const sourcePassages = parseActionRuleSourceQuestionPassages(result.source_passages, selected().root, source);
          await withProjectAuthorityMutation(input.projectRoot, async permit => {
            await pendingCurrentHeld(permit, original);
            const { root } = selected();
            await ports.createMissingQuestion(root, result.question, result.completion!, { expectedRootDigest: root.digest, sourcePassages, permit });
          }, { signal: input.signal });
          question = selected().question;
          if (question.source_binding || question.presentation?.text !== result.question
            || canonicalJsonDigest(question.naming_passages ?? null) !== canonicalJsonDigest(sourcePassages)) invalid();
        } else {
          const proposed = proposeOperatorAnswer(question, result.proposal);
          if (result.state === "pending") return pending(proposed, "unknown", result.completion, question);
          await saveQuestion(proposed, question, result.completion); question = selected().question;
        }
      }
      if (!question.source_binding && !question.proposal) {
        if (!question.presentation) invalid();
        if (!question.raw_answer) {
          const before = question;
          await pendingCurrent(before);
          const raw = await ports.prompt(presentOperatorClarification(question.presentation.text,
            { stage: "input", context: input.businessContext, target: question.target }), { preserveWhitespace: true });
          if (raw === null) return pending(before, "cancelled");
          await withProjectAuthorityMutation(input.projectRoot, async permit => {
            await pendingCurrentHeld(permit, before);
            await ports.recordRawAnswer(before, raw, before.digest, { permit });
          }, { signal: input.signal });
          question = selected().question;
          if (question.id !== before.id || question.raw_answer?.text !== raw) invalid();
        }
        if (!question.raw_answer!.text.trim()) return pending(question, "unknown");
        const original = question, current = await pendingCurrent(question);
        const result = await interpret({ question, stage: "answer-map", session: input.session,
          businessContext: input.businessContext,
          episodeBudget: episode, reserveCorrection: episode.reserveCorrection,
          authorityGuard: async expected => { await pendingCurrent(original); return expected; },
          inputContext: { root: selected().root, policyText: current.source.text },
          validateProposal: validateDomain, env: input.env, egressAcknowledged: input.egressAcknowledged, signal: input.signal });
        if (result.state === "question") invalid();
        question = selected().question;
        const proposed = proposeOperatorAnswer(question, result.proposal);
        if (result.state === "pending") return pending(proposed, "unknown", result.completion, question);
        await saveQuestion(proposed, question, result.completion); question = selected().question;
      }
    }
    if (question.proposal?.disposition !== "proposed") return pending(question, "unknown");
    validateDomain(question);
    await pendingCurrent(question);
    const accepted = await ports.confirm(operatorQuestionReadback(question), { defaultValue: false });
    if (!accepted) return pending(question, accepted === null ? "cancelled" : "declined");
    await saveQuestion(confirmOperatorAnswer(question), question); question = selected().question;
  }
  // Confirmation alone is not a Source save. A restart may finish this same
  // exact write without another generation or another operator confirmation.
  return withProjectAuthorityMutation(input.projectRoot, async (permit): Promise<SourceInputConversationResult> => {
    const { sources, source } = await loadCurrentHeld(permit), { root, question: q } = selected();
    const saved = matchingReview(sources, q, root, source.digest, input.store, input.actor);
    if (saved) {
      const before = structuredClone(sources);
      const priorInputs = before.input_policy_reviews;
      const removedLastAppend = priorInputs?.at(-1)?.digest === saved.digest;
      if (removedLastAppend && priorInputs) {
        before.input_policy_reviews = priorInputs.slice(0, -1);
        if (!before.input_policy_reviews.length && input.sources.input_policy_reviews === undefined) delete before.input_policy_reviews;
      }
      const exactAppend = removedLastAppend && canonicalJsonDigest(before) === canonicalJsonDigest(input.sources);
      await ports.assertCurrentHeld(permit, { mode: exactAppend ? "append_recovery" : "completed_review", review: saved,
        ...(exactAppend ? { sourceBeforeAppend: before } : {}) });
      await ports.acknowledge(q, saved, sources, permit);
      return { state: "reused", question: q, review: saved, sources, source_database_changed: false, authority_granted: false };
    }
    await pendingCurrentHeld(permit, q);
    const value = q.proposal?.value;
    if (!q.confirmation || value?.kind !== "input_bounds") invalid();
    const review = makeSourceInputReview({ source, session: sources, store: input.store, outcomes: input.outcomes,
      requirements: value.requirements, actor: input.actor, operatorQuestion: q, questionRoot: root });
    const next = structuredClone(sources);
    next.input_policy_reviews = [...(next.input_policy_reviews ?? []), review];
    await savePolicySources(input.projectRoot, next, { expectedDigest: canonicalJsonDigest(sources), permit });
    await ports.assertCurrentHeld(permit, { mode: "append_recovery", review, sourceBeforeAppend: sources });
    await ports.acknowledge(q, review, next, permit);
    return { state: "saved", question: q, review, sources: next, source_database_changed: false, authority_granted: false };
  }, { signal: input.signal });

  async function interpret(modelInput: Parameters<typeof runOperatorQuestionModel>[0]) {
    let expected = modelInput.question;
    try {
      const result = await runOperatorQuestionModel({ ...modelInput,
        authorityGuard: async digest => { await pendingCurrent(expected); return digest; },
        onWordingState: async state => {
          await pendingCurrent(expected);
          const previous = selected().question;
          if (semanticDigest(previous) !== semanticDigest(expected)) invalid();
          const next = retainOperatorQuestionWording(previous, state);
          await saveQuestion(next, previous, undefined, true);
          expected = next;
        },
      });
      return { ...result, expectedQuestion: expected };
    }
    catch (error) {
      const stage = modelInput.stage;
      const proof = stage === "present" ? undefined : consumedOperatorInputFailure(error, modelInput.question, stage);
      if (proof) {
        const current = selected();
        if (!current.root.budget!.correction_used || semanticDigest(current.question) !== semanticDigest(expected)) invalid();
        await saveQuestion(stopOperatorInputQuestion(current.question, { stage: proof.stage, completion: proof.completion }), current.question, proof.completion);
      }
      // A failed CAS/save never establishes the terminal write. Its existing
      // save/uncertainty refusal escapes instead of acknowledging an outcome.
      throw error;
    }
  }
  function validateDomain(q: OperatorQuestion): void {
    const source = activePolicySource(input.sources), value = q.proposal?.value;
    if (!source || value?.kind !== "input_bounds") invalid();
    // Pure domain check; a current raw answer is not yet a confirmed review.
    // Do not fabricate an adoption/reference merely to validate its shape.
    assertSourceInputRequirements(value.requirements, input.outcomes,
      q.source_binding ? "policy_source" : "operator_answer", source.lines);
  }
}

function semanticDigest(q: OperatorQuestion): Digest {
  const { digest: _, budget: __, ...body } = q;
  return canonicalJsonDigest(body);
}
function matchingReview(sources: PolicySourceSession, q: OperatorQuestion, root: OperatorQuestion,
  sourceDigest: string, store: string, actor: string): SourceInputPolicyReview | undefined {
  if (!q.confirmation || q.proposal?.value?.kind !== "input_bounds") invalid();
  const reference = { id: q.id, revision: q.revision, digest: q.digest, proposal_digest: canonicalJsonDigest(q.proposal),
    root_id: root.id, root_digest: root.digest, basis: q.source_binding ? "policy_source" : "operator_answer",
    ...(!q.source_binding ? { answer_id: q.raw_answer!.id } : {}) };
  const records = sources.input_policy_reviews ?? [], linked = records.filter(r => r.question_reference?.id === q.id);
  if (!linked.length) return undefined;
  if (linked.length !== 1) invalid();
  const review = linked[0]!;
  if (canonicalJsonDigest(review.question_reference) !== canonicalJsonDigest(reference) || review.decision !== "confirmed"
    || review.source_session !== sources.id || review.source_digest !== sourceDigest || review.store_digest !== store
    || review.actor !== actor || canonicalJsonDigest(review.outcomes) !== canonicalJsonDigest(q.target.outcomes)
    || canonicalJsonDigest(review.requirements) !== canonicalJsonDigest(q.proposal.value.requirements)) invalid();
  for (const outcome of q.target.outcomes) {
    const last = records.filter(r => r.source_session === sources.id && r.source_digest === sourceDigest
      && r.store_digest === store && r.outcomes.includes(outcome)).at(-1);
    if (last?.digest !== review.digest) invalid();
  }
  return review;
}
function invalid(): never {
  throw new AskError("OPERATOR_INPUT_CONTEXT_CHANGED", "The exact saved input interpretation, Source, current question or applicable history is unavailable or changed. Preserve it and reopen the current review; no replacement answer or authority was inferred.", 409);
}
