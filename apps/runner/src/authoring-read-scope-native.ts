import { randomUUID } from "node:crypto";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryAuthoringResumeRead, BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { authoringReadCheckpoint, type AuthoringQuestionCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { projectAuthoringReadScopeContext } from "./authoring-read-scope-context.js";
import { createReadScopeHost, type ReadScopeHostAccess, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
import { createReadScopeQuestion, proposeReadScopeReview } from "./authoring-read-scope-question.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import type { ReadScopeRecord } from "./read-structured-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { readStoredReadWorkloadAnalysis } from "./read-workloads.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
export type NativeReadScopeSnapshot = {
  resume?: BoundaryAuthoringResumeState; revision?: Digest; blocked: boolean;
  questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState; read?: BoundaryAuthoringResumeRead; sources?: PolicySourceSession;
};
export type NativeReadScopePorts = {
  snapshot(): NativeReadScopeSnapshot;
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  questionContext(permit?: ProjectAuthorityMutationPermit): Promise<Digest>;
  questionScope(): Digest;
  mutate: ReadScopeHostAccess["mutate"];
  failure(subject: string): Error;
  /** Existing owner alone installs records and acknowledges Resume CAS. The
   * generation patch is the actual consumed completion, never a fake answer. */
  save(input: { questions: OperatorQuestion[]; generation?: AuthoringTransportState;
    stage: BoundaryAuthoringResumeState["stage"]; acknowledgeCompletedTurn: boolean; subject: string },
    permit: ProjectAuthorityMutationPermit): Promise<void>;
};
/** Native assembly for existing scope handlers. Reads are fresh projections;
 * no session object, second store or lock is retained across an interaction. */
export function createNativeReadScope(input: { projectRoot: string; ports: NativeReadScopePorts;
  interact(view: ReadScopeInteraction, assertCurrent: () => Promise<void>): Promise<ReadScopeInteractionResponse> }) {
  const unavailable = (subject: string): never => { throw input.ports.failure(subject); };
  const snapshot = () => {
    const state = input.ports.snapshot();
    if (!state.resume || !state.revision || state.blocked) unavailable("The native typed Read context");
    return { ...state, resume: state.resume!, revision: state.revision! };
  };
  const answerIds = () => {
    const { questions } = snapshot();
    return questions.filter(q => q.read_scope?.mode === "missing_answer" && q.raw_answer?.text.trim() && !q.disposition
      && !questions.some(next => next.read_scope?.predecessor_id === q.id)).map(q => q.id);
  };
  const project = (boundary: ExplorationBoundaryDraft, structuralReview: Awaited<ReturnType<typeof loadBoundaryReviewContext>>,
    answerQuestionIds = answerIds()) => {
    const state = snapshot();
    return projectAuthoringReadScopeContext({ resume: state.resume, boundary, structuralReview, sources: state.sources,
      records: { questions: state.questions, handoffs: state.handoffs, generation: state.generation }, answerQuestionIds });
  };
  const context = async (boundary: ExplorationBoundaryDraft, answerQuestionIds = answerIds(), permit?: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContext(input.projectRoot);
    const projected = project(boundary, current, answerQuestionIds);
    await input.ports.assertCurrent(permit);
    return projected;
  };
  const host = createReadScopeHost({ access: {
    mutate: input.ports.mutate,
    load: async (questionId, permit) => {
      await input.ports.assertCurrent(permit);
      const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot(), scope = project(current.candidate, current);
      const question = state.questions.find(q => q.id === questionId);
      if (!question?.read_scope) return unavailable("The exact native Read question");
      const stored = question.read_scope.record.analysis_digest && state.read?.scope_question_id === questionId
        ? await readStoredReadWorkloadAnalysis({ projectRoot: input.projectRoot, analysisId: state.read.analysis_id }) : undefined;
      if (question.read_scope.record.analysis_digest && !stored) unavailable("The exact analyzed Read proposal");
      const context_digest = await input.ports.questionContext(permit);
      await input.ports.assertCurrent(permit);
      return { questions: state.questions, handoffs: state.handoffs, generation: state.generation, question_id: questionId,
        expectedBinding: scope.binding, references: scope.references, catalog: scope.catalog,
        ...(stored ? { analysis: stored.analysis } : {}), resume_revision_digest: state.revision,
        context_digest, scope_digest: input.ports.questionScope() };
    },
    save: async (question, options) => {
      const state = snapshot();
      await input.ports.save({ questions: state.questions.map(q => q.id === question.id ? question : q),
        stage: state.resume.stage, acknowledgeCompletedTurn: true, subject: options.subject }, options.permit);
    },
  }, interact: input.interact });
  const recordNoRead = async (record: ReadScopeRecord, completion: AuthoringQuestionCompletion) => input.ports.mutate(async permit => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot(), inventory = project(current.candidate, current);
    const question = proposeReadScopeReview(createReadScopeQuestion({ id: randomUUID(), revision: 1,
      scope_digest: input.ports.questionScope(), context_digest: await input.ports.questionContext(permit),
      read_scope: { mode: "review", record, completion } }), inventory.binding, undefined, inventory);
    const generation = authoringReadCheckpoint(state.generation, completion, readScopeConsumption(question.read_scope!));
    await input.ports.save({ questions: [...state.questions, question], generation, stage: "planning",
      acknowledgeCompletedTurn: false, subject: "The no-Read scope proposal" }, permit);
    return question.id;
  });
  return { context, answerIds, review: host.review, recordNoRead };
}
