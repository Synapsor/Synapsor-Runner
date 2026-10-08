import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { AskError } from "./model-ask.js";
import { consumeBoundaryReadRevisionResult, type BoundaryAuthoringReadRevision } from "./boundary-authoring-resume.js";
import { parseReadBoundaryRevisionCheckpoint, readBoundaryRevisionDecisionAnswer,
  type ReadBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import type { ModelReadBoundaryRevisionResult, ReadRevisionScopePreview } from "./read-boundary-revision-model.js";
import { activePolicySource, PolicySourceChangedError, type PolicySourceSession } from "./authoring-policy-source.js";
import { createOwnerHandoff, answerOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, authoringReadCheckpoint,
  assertAuthoringReadCheckpoint, authoringReadDecisionCheckpoint, type AuthoringQuestionCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { rememberModelAuthoringClarification, type ModelAuthoringConversation } from "./model-authoring-conversation.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

import { createReadScopeQuestion, proposeReadScopeReview } from "./authoring-read-scope-question.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { resolveReadScopeProposal } from "./read-structured-scope.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";

type Digest = `sha256:${string}`;
export type ReadRevisionCheckpointAccess = {
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  contextDigest(permit: ProjectAuthorityMutationPermit): Promise<Digest>;
  scopeDigest(): Digest;
  currentCandidate(): Promise<{ candidate_digest: Digest }>;
  readRevision(): BoundaryAuthoringReadRevision | undefined;
  readInstruction(): string | undefined;
  /** Actual current preview, resolved again under the existing protected save.
   * Scope-only unresolved results use the unchanged candidate. */
  scopePreview?(permit: ProjectAuthorityMutationPermit, result: ModelReadBoundaryRevisionResult): Promise<ReadRevisionScopePreview>;
  readQuestions?(): OperatorQuestion[];
  readHandoffs(): AuthoringOwnerHandoff[];
  readRecovery(): AuthoringTransportState | undefined;
  readConversation(): ModelAuthoringConversation | undefined;
  /** Caller locals remain under the native mutation wrapper's rollback. */
  install(update: { revision?: BoundaryAuthoringReadRevision; recovery?: AuthoringTransportState }): void;
  appendSourceMessage(sources: PolicySourceSession, message: string,
    options: { permit: ProjectAuthorityMutationPermit; expectedDigest: Digest }): Promise<void>;
  save(permit: ProjectAuthorityMutationPermit, subject: string, acknowledge?: false): Promise<void>;
  checkpointFailure(subject: string): Error;
};

/** Read-edit checkpoint coordination only. Native producers, Source testimony,
 * Resume CAS/rollback and the later guarded disabled save keep their owners. */
export function createReadRevisionCheckpointHost({ access }: { access: ReadRevisionCheckpointAccess }) {
  const persist = async (checkpoint: ReadBoundaryRevisionCheckpoint | undefined,
    currentBoundary: ExplorationBoundaryDraft, accepted?: ModelReadBoundaryRevisionResult, completion?: AuthoringQuestionCompletion) => {
    // A complete parsed result is known consumption, not a committed mutation.
    // Persist that distinction so a declined/failed save cannot replay the
    // already consumed producer on reopen. The actual guarded save clears it.
    if (!checkpoint) {
      if (!accepted) throw access.checkpointFailure("The Read revision result");
      await access.mutate(async permit => {
        const context = await access.contextDigest(permit);
        const current = await access.currentCandidate();
        if (!access.readRevision() || explorationBoundaryCandidateDigest(currentBoundary) !== current.candidate_digest) {
          throw new Error("READ_BOUNDARY_REVISION_CHECKPOINT_STALE: The consumed revision belongs to another current candidate.");
        }
        let scopeQuestion: OperatorQuestion | undefined;
        if (accepted.read_scope) {
          if (!completion || !access.scopePreview || !access.readQuestions)
            throw access.checkpointFailure("The typed Read revision scope");
          const preview = await access.scopePreview(permit, accepted);
          const exact = resolveReadScopeProposal(accepted.read_scope.proposal, { expectedBinding: preview.scope.binding,
            references: preview.scope.references, catalog: preview.scope.catalog, ...(preview.analysis ? { analysis: preview.analysis } : {}) });
          if (canonicalJsonDigest(exact) !== canonicalJsonDigest(accepted.read_scope))
            throw new Error("READ_BOUNDARY_REVISION_CHECKPOINT_STALE: The typed scope belongs to another preview or analysis.");
          const previous = [...access.readQuestions()].reverse().find(q => q.kind === "read_scope"
            && q.read_scope?.mode === "review" && q.scope_digest === access.scopeDigest());
          scopeQuestion = createReadScopeQuestion({ id: randomUUID(), revision: previous ? previous.revision + 1 : 1,
            scope_digest: access.scopeDigest(), context_digest: context,
            read_scope: { mode: "review", record: exact, completion, ...(previous ? { predecessor_id: previous.id } : {}) } });
          // Missing mapping is durable pending work, not invented analysis or a
          // confirmable interpretation. The later mapping owns its successor.
          if (accepted.read_scope_state === "analyzed_proposal")
            scopeQuestion = proposeReadScopeReview(scopeQuestion, preview.scope.binding, preview.analysis, preview.scope);
          else if (accepted.read_scope_state !== "pending_mapping") throw access.checkpointFailure("The typed Read scope status");
          access.install({ recovery: authoringReadCheckpoint(access.readRecovery(), completion, readScopeConsumption(scopeQuestion.read_scope!)) });
          access.readQuestions().push(scopeQuestion);
        }
        access.install({ revision: { ...consumeBoundaryReadRevisionResult(access.readRevision()!),
          ...(scopeQuestion ? { scope_question_id: scopeQuestion.id } : {}) } });
        await access.save(permit, "The consumed Read revision result");
      });
      return;
    }
    await access.mutate(async permit => {
      if (!access.readRevision() || access.readRevision()!.instruction !== access.readInstruction()) throw access.checkpointFailure("The pending Read revision");
      const currentContext = await access.contextDigest(permit);
      const current = await access.currentCandidate();
      if (explorationBoundaryCandidateDigest(currentBoundary) !== current.candidate_digest) {
        throw new Error("READ_BOUNDARY_REVISION_CHECKPOINT_STALE: The exact Read candidate changed. Preserve this question and inspect the current saved job.");
      }
      const checked = parseReadBoundaryRevisionCheckpoint(checkpoint);
      if (checked.stage === "dispatching" || checked.pending_question.kind === "private_prerequisite"
        && checked.pending_question.nested_checkpoint?.stage === "dispatching") {
        access.install({ revision: { ...access.readRevision()!, checkpoint: checked } });
        await access.save(permit, "The Read edit dispatch checkpoint", false);
        return;
      }
      const q = checked.pending_question;
      if (q.kind === "private_prerequisite") {
        const checkpointNative = (completion: NonNullable<AuthoringOwnerHandoff["completion"]> | undefined,
          kind: "private_prerequisite" | "prerequisite_mapping", material: unknown) => {
          if (!completion) {
            if (access.readRecovery()) throw access.checkpointFailure("The native private Read completion");
            return;
          }
          const record = { consumer: "read_revision" as const, kind, material_digest: canonicalJsonDigest(material) };
          const op = access.readRecovery()?.operations.find(op => op.id === completion.operation_id);
          if (op?.read_checkpoint) assertAuthoringReadCheckpoint(access.readRecovery(), completion, record);
          else access.install({ recovery: authoringReadCheckpoint(access.readRecovery(), completion, record) });
        };
        checkpointNative(q.completion, "private_prerequisite", q.request);
        const nested = q.nested_checkpoint;
        if (nested?.pending?.kind === "semantic_confirmation") {
          checkpointNative(nested.pending.completion, "prerequisite_mapping", nested.pending.proposal);
          if (nested.stage === "decided" && nested.pending.completion)
            access.install({ recovery: authoringReadDecisionCheckpoint(access.readRecovery(), nested.pending.completion,
              nested.pending.proposal, nested.pending.decision) });
        }
        if (nested?.pending?.kind === "clarification") {
          const p = nested.pending, last = access.readHandoffs().at(-1);
          const same = last?.consumer === "read_revision_prerequisite" && last.question === p.request.question
            && canonicalJsonDigest(last.completion ?? null) === canonicalJsonDigest(p.completion ?? null);
          if (nested.stage === "waiting") {
            if (!same) {
              if (last?.state === "waiting") throw access.checkpointFailure("The retained private Read question");
              const h = createOwnerHandoff({ consumer: "read_revision_prerequisite", question: p.request.question,
                scope_digest: access.scopeDigest(), context_digest: currentContext, ...(p.completion ? { completion: p.completion } : {}) });
              if (p.completion) access.install({ recovery: authoringQuestionCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(h)) });
              else if (access.readRecovery()) throw access.checkpointFailure("The private Read question completion");
              access.readHandoffs().push(h);
            } else if (last?.state !== "waiting" || last.context_digest !== currentContext) throw new PolicySourceChangedError();
          } else if (!same || last?.state !== "answered" || last.answer !== p.decision?.answer
            || last.answer_context_digest !== currentContext) throw new PolicySourceChangedError();
        }
        access.install({ revision: { ...access.readRevision()!, checkpoint: checked } });
        await access.save(permit, "The private Read adapter");
        return;
      }
      const last = access.readHandoffs().at(-1);
      const sameQuestion = last?.consumer === "read_revision_clarification" && last.question === q.question
        && canonicalJsonDigest(last.completion ?? null) === canonicalJsonDigest(q.completion ?? null);
      if (checked.stage === "waiting") {
        if (sameQuestion && last?.state === "waiting") {
          if (last.scope_digest !== access.scopeDigest() || last.context_digest !== currentContext) {
            throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The saved Read edit question changed. No answer was inferred.");
          }
        } else {
          if (last?.state === "waiting") throw new Error("AUTHORING_OWNER_QUESTION_PENDING: Inspect the exact saved question before replacing it.");
          const next = createOwnerHandoff({ consumer: "read_revision_clarification", question: q.question,
            scope_digest: access.scopeDigest(), context_digest: currentContext, ...(q.completion ? { completion: q.completion } : {}) });
          if (q.completion) access.install({ recovery: authoringQuestionCheckpoint(access.readRecovery(), ownerHandoffCheckpoint(next)) });
          else if (access.readRecovery()?.operations.some(op => ["in_flight", "received", "handled", "unknown", "partial"].includes(op.state))) {
            throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The Read edit question has no completed consumer association. Preserve the saved generation without replay.", 409);
          }
          access.readHandoffs().push(next);
        }
      } else {
        const answer = readBoundaryRevisionDecisionAnswer(checked);
        if (!sameQuestion || !last || last.scope_digest !== access.scopeDigest()) {
          throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The saved Read question or exact request changed. Its answer was not accepted.");
        }
        if (last.state === "answered") {
          // Counter updates retain the same acknowledged answer. They cannot
          // create another consent record or acknowledge another generation.
          if (last.answer !== answer || last.answer_context_digest !== currentContext) throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: The saved Read answer is no longer current.");
        } else {
          if (last.context_digest !== currentContext) throw new Error("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: Source or permissions changed before the Read answer was accepted.");
          const sources = access.readConversation()?.policySources;
          if (q.decision?.state === "answered" && sources && activePolicySource(sources)) {
            await access.appendSourceMessage(sources, answer, { permit, expectedDigest: canonicalJsonDigest(sources) });
          }
          const acceptedContext = await access.contextDigest(permit);
          const next = answerOwnerHandoff(last, answer, acceptedContext);
          if (last.completion) access.install({ recovery: authoringQuestionAnswerCheckpoint(access.readRecovery(),
            ownerHandoffCheckpoint(last), { digest: canonicalJsonDigest(next), operator_messages: [answer] }) });
          access.readHandoffs()[access.readHandoffs().length - 1] = next;
          if (q.decision?.state === "answered") rememberModelAuthoringClarification(access.readConversation(), last.question, answer);
        }
      }
      access.install({ revision: { ...access.readRevision()!, checkpoint: checked } });
      await access.save(permit, "The Read edit question and decision");
    });
  };
  return { persist };
}
