import { readRevisionMappingContinuation, type ReadRevisionMappingOwner } from "./read-revision-mapping-continuation.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { AskError } from "./model-ask.js";
import { analyzeReadWorkloadSet } from "./read-workload-assist.js";
import { parseReadWorkloadAssistanceCheckpoint, readWorkloadAssistanceDecisionAnswer,
  type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { activePolicySource, PolicySourceChangedError, type PolicySourceSession } from "./authoring-policy-source.js";
import { createOwnerHandoff, answerOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { createReadScopeQuestion, proposeReadScopeReview, type ReadScopeNativeInventory } from "./authoring-read-scope-question.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import type { ReadScopeBinding } from "./read-structured-scope.js";
import { authoringReadCheckpoint, type AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { createOperatorQuestion, presentOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { rememberModelAuthoringTurn, type ModelAuthoringConversation } from "./model-authoring-conversation.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { ModelReadWorkloadResult } from "./read-workload-model.js";
import type { BoundaryAuthoringResumeRead } from "./boundary-authoring-resume.js";
import type { storeReadWorkloadAnalysis } from "./read-workloads.js";

type Digest = `sha256:${string}`;
type ReviewedRelationshipAnswer = { id: string; digest: string; context: Digest };
export type ReadAssistanceCheckpointUpdate = {
  checkpoint?: ReadWorkloadAssistanceCheckpoint;
  recovery?: AuthoringTransportState;
  read?: BoundaryAuthoringResumeRead;
  reviewedRelationshipAnswer?: ReviewedRelationshipAnswer;
  /** Transient install instruction, never a durable authority/review marker. */
  completedReadRevision?: { question_id: string };
};
export type ReadAssistanceCheckpointAccess = {
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  scopeDigest(): Digest;
  contextDigest(permit: ProjectAuthorityMutationPermit): Promise<Digest>;
  currentCandidate(permit?: ProjectAuthorityMutationPermit): Promise<{ candidate_digest: Digest }>;
  readCheckpoint(): ReadWorkloadAssistanceCheckpoint | undefined;
  readPreparedRead?(): BoundaryAuthoringResumeRead | undefined;
  /** Exact currently saved revision projection, reloaded under this mutation.
   * The prior Read pointer remains in its own slot until this real new mapping. */
  readPendingRevision?(permit: ProjectAuthorityMutationPermit): Promise<ReadRevisionMappingOwner | undefined>;
  /** Re-resolve from current protected records inside the owning mutation, not
   * a cached display/model inventory. Absence cannot silently use legacy mode. */
  scopeInventory?(permit: ProjectAuthorityMutationPermit): Promise<ReadScopeNativeInventory & { binding: ReadScopeBinding }>;
  readHandoffs(): AuthoringOwnerHandoff[];
  readQuestions(): OperatorQuestion[];
  readRecovery(): AuthoringTransportState | undefined;
  readConversation(): ModelAuthoringConversation | undefined;
  readReviewedRelationshipAnswer(): ReviewedRelationshipAnswer | undefined;
  /** Applies to the caller's existing locals under its native rollback wrapper.
   * Property presence is significant: undefined clears an acknowledged wait. */
  install(update: ReadAssistanceCheckpointUpdate): void;
  storeAnalysis(input: Omit<Parameters<typeof storeReadWorkloadAnalysis>[0], "projectRoot">): ReturnType<typeof storeReadWorkloadAnalysis>;
  appendSourceMessage(sources: PolicySourceSession, message: string,
    options: { permit: ProjectAuthorityMutationPermit; expectedDigest: Digest }): Promise<void>;
  save(permit: ProjectAuthorityMutationPermit, subject: string, acknowledge?: false): Promise<void>;
  checkpointFailure(subject: string): Error;
};

/** Initial Read's existing producer checkpoint coordination. Producers, native
 * stores/CAS and rollback stay with their owners. Read-edit's earlier Source
 * testimony append is deliberately not part of this accepted-remap boundary. */
export function createReadAssistanceCheckpointHost({ access }: { access: ReadAssistanceCheckpointAccess }) {
  const persist = async (checkpoint: ReadWorkloadAssistanceCheckpoint | undefined,
    currentBoundary: ExplorationBoundaryDraft, accepted?: ModelReadWorkloadResult, completion?: AuthoringQuestionCompletion) => access.mutate(async permit => {
      const currentContext = await access.contextDigest(permit);
      const current = await access.currentCandidate(permit);
      if (explorationBoundaryCandidateDigest(currentBoundary) !== current.candidate_digest) {
        throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: The exact Read candidate changed. Preserve the assistance and inspect the current saved job.");
      }
      if (!checkpoint) {
        if (!accepted || accepted.analysis.status !== "ready") throw access.checkpointFailure("The accepted Read mapping");
        // The immutable analysis is inert until the SAME resume CAS records its
        // exact pointer. Failure never clears a question or acknowledges a save.
        // A rolling window is resolved during the producer's analysis. Reuse
        // that host-only clock rather than making an unchanged plan appear stale.
        const analysis = analyzeReadWorkloadSet({ workload: accepted.workload, generatedBoundary: currentBoundary,
          now: accepted.analysis_clock });
        if (analysis.status !== "ready" || canonicalJsonDigest(analysis) !== canonicalJsonDigest(accepted.analysis)) {
          throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: The accepted mapping no longer validates against the current Read catalog.");
        }
        let scopeQuestion: OperatorQuestion | undefined;
        let completedReadRevision: ReadAssistanceCheckpointUpdate["completedReadRevision"];
        if (accepted.read_scope) {
          if (!completion || !access.scopeInventory) throw access.checkpointFailure("The native typed Read review");
          const inventory = await access.scopeInventory(permit);
          const currentRead = access.readPreparedRead?.();
          const previousId = accepted.read_scope_predecessor_id ?? currentRead?.scope_question_id;
          const pendingRevision = accepted.read_scope_predecessor_id ? await access.readPendingRevision?.(permit) : undefined;
          let revisionPredecessor: OperatorQuestion | undefined;
          if (pendingRevision) {
            if (!currentRead || previousId !== pendingRevision.question_id
              || canonicalJsonDigest(pendingRevision.read) !== canonicalJsonDigest(currentRead))
              throw access.checkpointFailure("The exact saved pending Read revision and prior mapping");
            revisionPredecessor = readRevisionMappingContinuation({ ...pendingRevision, currentBoundary,
              questions: access.readQuestions(), handoffs: access.readHandoffs(), generation: access.readRecovery() },
              { expectedBinding: inventory.binding, ...inventory }).question;
            completedReadRevision = { question_id: revisionPredecessor.id };
          }
          const previous = previousId ? access.readQuestions().find(q => q.id === previousId
            && q.kind === "read_scope" && q.read_scope?.mode === "review" && q.scope_digest === access.scopeDigest()) : undefined;
          if (previousId && (!previous || !revisionPredecessor && currentRead?.scope_question_id !== previousId
            || access.readQuestions().some(q => q.read_scope?.predecessor_id === previousId)))
            throw access.checkpointFailure("The exact current Read proposal predecessor");
          if (accepted.read_scope_predecessor_id && !revisionPredecessor) {
            const raw = access.readQuestions().find(q => q.read_scope?.mode === "replacement_answer"
              && q.read_scope.review_question_id === previousId && q.raw_answer && !q.disposition
              && !access.readQuestions().some(next => next.read_scope?.predecessor_id === q.id));
            if (!previous?.disposition || previous.confirmation || !raw || !accepted.read_scope.references.some(ref => ref.kind === "answer"
              && ref.question_id === raw.id && ref.question_revision === raw.revision && ref.answer_id === raw.raw_answer!.id
              && ref.digest === canonicalJsonDigest(raw.raw_answer)))
              throw access.checkpointFailure("The exact raw Read correction and declined proposal");
          }
          scopeQuestion = proposeReadScopeReview(createReadScopeQuestion({ id: randomUUID(), revision: previous ? previous.revision + 1 : 1,
            scope_digest: access.scopeDigest(), context_digest: currentContext,
            read_scope: { mode: "review", record: accepted.read_scope, completion, ...(previous ? { predecessor_id: previous.id } : {}) } }),
            inventory.binding, analysis, inventory);
          access.install({ recovery: authoringReadCheckpoint(access.readRecovery(), completion, readScopeConsumption(scopeQuestion.read_scope!)) });
          access.readQuestions().push(scopeQuestion);
        }
        const saved = await access.storeAnalysis({ generatedBoundary: currentBoundary, source: accepted.workload.source, analysis });
        // The producer pins its input history until this accepted mapping.
        // Index newly confirmed testimony only here, without changing that
        // contract or upgrading legacy conversation into current meaning.
        const sources = access.readConversation()?.policySources;
        const source = activePolicySource(sources);
        const previousCheckpoint = access.readCheckpoint();
        if (sources && source && previousCheckpoint) {
          const pending = previousCheckpoint.pending_question;
          const answers = [...previousCheckpoint.state.clarified_targets];
          const retired = new Set((previousCheckpoint.state.reviewed_replacements ?? []).map(review => review.previous_index));
          if (pending?.kind === "clarification" && pending.decision?.state === "answered") {
            if (pending.replacement?.confirmed) retired.add(pending.replacement.previous_index);
            answers.push({ ...pending.request, answer: pending.decision.answer });
          }
          const statements = answers.filter((_answer, index) => !retired.has(index)).flatMap(answer => {
            const handoff = [...access.readHandoffs()].reverse().find(record => record.consumer === "read_clarification"
              && record.question === answer.question);
            // Older non-mediated checkpoints remain ordinary naming context.
            // Association precedes validation: an existing malformed native
            // question must never masquerade as absent legacy evidence.
            const question = [...access.readQuestions()].reverse().find(record => record.kind === "attributed_meaning"
              && record.handoff_id === handoff?.id);
            if (!question) return [];
            if (question.scope_digest !== access.scopeDigest() || question.context_digest !== currentContext
              || question.target.resource !== answer.resource || question.target.field !== answer.field
              || question.presentation?.text !== answer.question || question.raw_answer?.text !== answer.answer
              || !question.confirmation || !handoff || handoff.state !== "answered"
              || handoff.answer !== answer.answer || handoff.answer_context_digest !== currentContext) throw new PolicySourceChangedError();
            return [{ resource: answer.resource, ...(answer.field ? { field: answer.field } : {}),
              question: answer.question, raw_answer: answer.answer, question_digest: question.digest,
              question_context_digest: question.context_digest, confirmation: question.confirmation }];
          });
          if (statements.length) await access.appendSourceMessage(sources,
            JSON.stringify({ kind: "confirmed_read_meaning", attribution: "Untrusted operator naming context for this task only; not database proof or permission to read or change data.",
              source_digest: source.digest, scope_digest: access.scopeDigest(), statements }),
            { permit, expectedDigest: canonicalJsonDigest(sources) });
        }
        access.install({ read: { analysis_id: saved.analysis_id, analysis_digest: saved.analysis_digest,
          ...(scopeQuestion ? { scope_question_id: scopeQuestion.id } : {}),
          ...(access.readCheckpoint() ? { assistance_history: structuredClone(access.readCheckpoint()!) } : {}) },
          checkpoint: undefined, ...(completedReadRevision ? { completedReadRevision } : {}) });
      } else {
        const checked = parseReadWorkloadAssistanceCheckpoint(checkpoint);
        if (checked.stage === "dispatching") {
          // Preserve the producer's actual input and spent limits before I/O.
          // A raw controller reservation is neither an operator question nor
          // acknowledgement of any previous uncertain response or mutation.
          access.install({ checkpoint: checked });
          await access.save(permit, "The Read dispatch checkpoint", false);
          return;
        }
        const q = checked.pending_question;
        const consumer = q.kind === "value" ? "read_value_context" : "read_clarification";
        const last = access.readHandoffs().at(-1);
        const sameQuestion = last?.consumer === consumer && last.question === q.question
          && canonicalJsonDigest(last.completion ?? null) === canonicalJsonDigest(q.completion ?? null);
        if (checked.stage === "waiting") {
          if (sameQuestion && last?.state === "waiting") {
            if (last.scope_digest !== access.scopeDigest() || last.context_digest !== currentContext) {
              throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The saved Read question is not current. No answer or replacement was inferred.");
            }
          } else {
            if (last?.state === "waiting") throw new Error("AUTHORING_OWNER_QUESTION_PENDING: Inspect the current saved question before replacing it.");
            const next = createOwnerHandoff({ consumer, question: q.question, scope_digest: access.scopeDigest(),
              context_digest: currentContext, ...(q.completion ? { completion: q.completion } : {}) });
            if (q.completion) access.install({ recovery: authoringQuestionCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(next)) });
            else if (access.readRecovery()?.operations.some(op => ["in_flight", "received", "handled", "unknown", "partial"].includes(op.state))) {
              throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The Read question has no exact completed consumer association. Preserve the saved generation without replay.", 409);
            }
            access.readHandoffs().push(next);
          }
          if (q.kind === "scope" && !access.readQuestions().some(record => record.handoff_id === access.readHandoffs().at(-1)!.id)) {
            const h = access.readHandoffs().at(-1)!;
            const requirement = q.request.scope.requirement_bindings.find(r => r.digest === q.request.requirement_digest);
            if (!q.completion || !requirement) throw access.checkpointFailure("The actual typed Read question");
            const question = presentOperatorQuestion(createReadScopeQuestion({ id: h.id, revision: 1, handoff_id: h.id,
              scope_digest: h.scope_digest, context_digest: h.context_digest,
              read_scope: { mode: "missing_answer", record: q.request.scope, requirement_id: requirement.id, completion: q.completion } }), h.question);
            access.install({ recovery: authoringReadCheckpoint(access.readRecovery(), q.completion, readScopeConsumption(question.read_scope!)) });
            access.readQuestions().push(question);
          }
          if (q.kind === "clarification" && !access.readQuestions().some(record => record.handoff_id === access.readHandoffs().at(-1)!.id)) {
            const h = access.readHandoffs().at(-1)!;
            access.readQuestions().push(createOperatorQuestion({ id: h.id, revision: 1, handoff_id: h.id,
              kind: "attributed_meaning", scope_digest: h.scope_digest, context_digest: h.context_digest,
              target: { phase: "read_mapping", resource: q.request.resource, ...(q.request.field ? { field: q.request.field } : {}), outcomes: [] },
              material: [`This meaning is for ${q.request.resource}${q.request.field ? ` / ${q.request.field}` : ""} in this task only.`,
                "It is a statement of business meaning, not private sample data, a database guarantee, or permission to read or change data."],
              evidence: [{ id: "current-read-candidate", digest: current.candidate_digest },
                { id: "current-source-and-permissions", digest: currentContext }], continuation: "read_mapping" }));
          }
        } else {
          const reviewedRelationshipAnswer = access.readReviewedRelationshipAnswer();
          const acknowledged = sameQuestion && last?.state === "answered" && (q.kind === "clarification"
            && access.readQuestions().some(record => record.handoff_id === last.id && record.confirmation
              && record.raw_answer?.text === readWorkloadAssistanceDecisionAnswer(q))
            || q.kind === "scope" && access.readQuestions().some(record => record.id === q.decision?.answer_reference.question_id
              && record.revision === q.decision.answer_reference.revision && record.raw_answer?.id === q.decision.answer_reference.answer_id
              && record.raw_answer.text === last.answer));
          if (!sameQuestion || !last || !acknowledged && last.state !== "waiting" || last.scope_digest !== access.scopeDigest()
            || last.context_digest !== currentContext && !(q.kind === "relationship"
              && reviewedRelationshipAnswer?.id === last.id && reviewedRelationshipAnswer.digest === last.digest
              && reviewedRelationshipAnswer.context === currentContext)) {
            throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: Source, permissions or the exact Read question changed. Its answer was not accepted.");
          }
          const scopeQuestion = q.kind === "scope" ? access.readQuestions().find(record =>
            record.id === q.decision?.answer_reference.question_id && record.revision === q.decision.answer_reference.revision) : undefined;
          if (q.kind === "scope" && (!scopeQuestion || scopeQuestion.kind !== "read_scope" || scopeQuestion.read_scope?.mode !== "missing_answer"
            || scopeQuestion.handoff_id !== last.id || scopeQuestion.scope_digest !== access.scopeDigest()
            || scopeQuestion.context_digest !== currentContext || scopeQuestion.read_scope.record.digest !== q.request.scope.digest
            || scopeQuestion.read_scope.record.requirement_bindings.find(r => r.id === scopeQuestion.read_scope!.requirement_id)?.digest !== q.request.requirement_digest
            || scopeQuestion.disposition || !scopeQuestion.raw_answer?.text.trim()
            || scopeQuestion.raw_answer.id !== q.decision?.answer_reference.answer_id))
            throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The Read scope decision has no exact current captured answer.");
          const answer = q.kind === "scope" ? scopeQuestion!.raw_answer!.text : readWorkloadAssistanceDecisionAnswer(q);
          if (!acknowledged) {
            const next = answerOwnerHandoff(last, answer, currentContext);
            if (last.completion) access.install({ recovery: authoringQuestionAnswerCheckpoint(access.readRecovery(),
              ownerHandoffCheckpoint(last), { digest: canonicalJsonDigest(next), operator_messages: [answer] }) });
            access.readHandoffs()[access.readHandoffs().length - 1] = next;
            rememberModelAuthoringTurn(access.readConversation(), last.question, answer);
          }
          access.install({ reviewedRelationshipAnswer: undefined });
        }
        access.install({ checkpoint: checked });
      }
      await access.save(permit, "The Read assistance checkpoint");
  });
  return { persist };
}
