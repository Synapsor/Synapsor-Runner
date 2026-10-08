import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { randomUUID } from "node:crypto";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import type { BoundaryAuthoringReadRevision, BoundaryAuthoringResumeRead, BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { authoringReadCheckpoint, type AuthoringQuestionCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { projectAuthoringReadScopeContext, projectAuthoringReadScopePreview } from "./authoring-read-scope-context.js";
import { createReadScopeHost, type ReadScopeHostAccess, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
import { createReadScopeQuestion, proposeReadScopeReview, resolveNativeReadScope } from "./authoring-read-scope-question.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { assertReadScopeProvenance, assessReadScopeRecordCurrentness, parseReadScopeRecord, type ReadScopeRecord } from "./read-structured-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { readReadWorkloadAnalysis, type ReadWorkloadView, readStoredReadWorkloadAnalysis } from "./read-workloads.js";
import type { ReadScopeReplacementOwner } from "./read-current-evidence.js";
import { readRevisionMappingContinuation, type ReadRevisionMappingOwner } from "./read-revision-mapping-continuation.js";
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
    pendingReadRevisionState?: BoundaryAuthoringReadRevision;
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
    return questions.filter(q => (q.read_scope?.mode === "missing_answer" || q.read_scope?.mode === "replacement_answer") && q.raw_answer?.text.trim() && !q.disposition
      && !questions.some(next => next.read_scope?.predecessor_id === q.id)).map(q => q.id);
  };
  const project = (boundary: ExplorationBoundaryDraft, structuralReview: Awaited<ReturnType<typeof loadBoundaryReviewContext>>,
    answerQuestionIds = answerIds(), state = snapshot(),
    native?: Parameters<typeof projectAuthoringReadScopeContext>[0]["native"]) => {
    return projectAuthoringReadScopeContext({ resume: state.resume, boundary, structuralReview, sources: state.sources,
      records: { questions: state.questions, handoffs: state.handoffs, generation: state.generation }, answerQuestionIds, native });
  };
  const context = async (boundary: ExplorationBoundaryDraft, answerQuestionIds = answerIds(), permit?: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot();
    const selected = state.read?.scope_question_id;
    const stored = selected && state.read ? await readStoredReadWorkloadAnalysis({
      projectRoot: input.projectRoot, analysisId: state.read.analysis_id }) : undefined;
    if (stored && stored.analysis_digest !== state.read!.analysis_digest)
      return unavailable("The exact saved Read scope analysis");
    const projected = project(boundary, current, answerQuestionIds, state,
      selected && stored ? { question_id: selected, analysis: stored.analysis } : undefined);
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent native Read scope projection");
    return projected;
  };
  /** Project the actual prepared mutation against current protected records.
   * A preview is neither a structural signoff nor a saved scope selection. */
  const preview = async (boundary: ExplorationBoundaryDraft,
    prepared: { candidate: ExplorationBoundaryDraft; build: { lock: GenerationLock } },
    answerQuestionIds = answerIds(), permit?: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot();
    const projected = projectAuthoringReadScopePreview({ resume: state.resume, boundary, structuralReview: current,
      sources: state.sources, records: { questions: state.questions, handoffs: state.handoffs, generation: state.generation },
      answerQuestionIds, preparedCandidate: prepared.candidate, preparedLock: prepared.build.lock });
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent native Read revision preview");
    return projected;
  };
  /** The prior mapped Read remains in its native slot. Only this explicit port
   * selects the separately saved, consumed revision for ordinary new mapping. */
  const pendingRevision = async (boundary: ExplorationBoundaryDraft, permit?: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot();
    const revision = state.resume.pending_read_revision_state, saved = state.read;
    if (!revision?.scope_question_id || !saved) return unavailable("The exact pending Read revision and prior mapping");
    const priorAnalysis = await readStoredReadWorkloadAnalysis({ projectRoot: input.projectRoot, analysisId: saved.analysis_id });
    const projected = project(boundary, current, answerIds(), state, { question_id: revision.scope_question_id });
    const owner: ReadRevisionMappingOwner = { questions: state.questions, handoffs: state.handoffs,
      generation: state.generation, read: saved, revision, question_id: revision.scope_question_id,
      currentBoundary: boundary, priorAnalysis };
    readRevisionMappingContinuation(owner, { expectedBinding: projected.binding, ...projected });
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent pending Read revision projection");
    return { owner, context: projected };
  };
  /** Recontext the same genuinely consumed proposal after its exact disabled
   * commit. No generation is consumed again and no analysis/Yes is fabricated. */
  const commitPendingRevisionScope = async (expected: { boundary: ExplorationBoundaryDraft; questionId: string; savedReadDigest: Digest }) =>
    input.ports.mutate(async permit => {
      await input.ports.assertCurrent(permit);
      const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot();
      const revision = state.resume.pending_read_revision_state;
      if (!revision?.result_received || revision.checkpoint || revision.terminal_reason
        || revision.scope_question_id !== expected.questionId || revision.saved_read_digest !== expected.savedReadDigest
        || explorationBoundaryCandidateDigest(expected.boundary) !== expected.savedReadDigest
        || explorationBoundaryCandidateDigest(current.candidate) !== expected.savedReadDigest)
        return unavailable("The exact recorded disabled Read revision commit");
      const inventory = project(expected.boundary, current, answerIds(), state);
      const resolved = resolveNativeReadScope({ questions: state.questions, handoffs: state.handoffs, generation: state.generation,
        question_id: expected.questionId, expectedBinding: inventory.binding, ...inventory });
      const old = resolved.question;
      if (old.id !== expected.questionId || old.read_scope?.mode !== "review" || old.read_scope.record.analysis_digest !== undefined
        || old.read_scope.record.proposal.applicability !== "read_requested" || old.confirmation || old.proposal || old.disposition
        || resolved.status !== "pending" || resolved.replacement_pending)
        return unavailable("The exact consumed pending Read revision proposal");
      const contextDigest = await input.ports.questionContext(permit);
      const successor = createReadScopeQuestion({ id: randomUUID(), revision: old.revision + 1,
        scope_digest: input.ports.questionScope(), context_digest: contextDigest,
        read_scope: { ...old.read_scope, predecessor_id: old.id } });
      await input.ports.assertCurrent(permit);
      if (snapshot().revision !== state.revision) return unavailable("The unchanged committed Read revision checkpoint");
      const requestedQuestions = [...state.questions, successor];
      const expectedQuestionsDigest = canonicalJsonDigest(requestedQuestions), successorId = successor.id;
      const requestedRevision = { ...revision, scope_question_id: successorId };
      const expectedRevisionDigest = canonicalJsonDigest(requestedRevision);
      const expectedReadDigest = canonicalJsonDigest(state.read), expectedGenerationDigest = canonicalJsonDigest(state.generation);
      await input.ports.save({ questions: structuredClone(requestedQuestions),
        pendingReadRevisionState: structuredClone(requestedRevision), stage: state.resume.stage,
        acknowledgeCompletedTurn: false, subject: "The committed Read scope awaiting mapping" }, permit);
      const acknowledged = snapshot();
      if (canonicalJsonDigest(acknowledged.resume.pending_read_revision_state) !== expectedRevisionDigest
        || canonicalJsonDigest(acknowledged.questions) !== expectedQuestionsDigest
        || canonicalJsonDigest(acknowledged.read) !== expectedReadDigest
        || canonicalJsonDigest(acknowledged.generation) !== expectedGenerationDigest)
        return unavailable("The acknowledged committed Read scope successor");
      return successorId;
    });
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
  // Resume chooses among existing owners from current native records. A declined
  // mapped review keeps its consumed history; it is never an active dispatch.
  const restore = async (boundary: ExplorationBoundaryDraft): Promise<
    | { state: "pending" }
    | { state: "restored"; workload: ReadWorkloadView; reuse: boolean; disabled: boolean }
    | { state: "replacement"; owner: ReadScopeReplacementOwner }> => {
    await input.ports.assertCurrent();
    const saved = snapshot().read;
    if (!saved) return unavailable("The exact saved Read analysis");
    const workload = await readReadWorkloadAnalysis({ projectRoot: input.projectRoot,
      analysisId: saved.analysis_id, generatedBoundary: boundary });
    if (workload.analysis_digest !== saved.analysis_digest)
      throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED: the saved Read analysis no longer matches this authoring checkpoint.");
    await input.ports.assertCurrent();
    if (saved.scope_question_id && !workload.review) {
      const decision = await host.review(saved.scope_question_id);
      if (decision.state === "replace_requested") {
        await input.ports.assertCurrent();
        const current = snapshot();
        if (current.read?.analysis_digest !== saved.analysis_digest
          || current.read.scope_question_id !== saved.scope_question_id)
          return unavailable("The exact declined Read mapping");
        return { state: "replacement", owner: { read: current.read, questions: current.questions,
          handoffs: current.handoffs, generation: current.generation,
          question_id: saved.scope_question_id, analysis: workload.analysis } };
      }
      if (decision.state !== "confirmed") return { state: "pending" };
      return { state: "restored", workload, reuse: false, disabled: false };
    }
    const reuse = snapshot().resume.stage === "authority_review" || Boolean(workload.review);
    return { state: "restored", workload, reuse, disabled: !reuse };
  };
  const principalRequirement = async (resources: readonly string[], proposed?: ReadScopeRecord) => {
    const roots = [...new Set(resources)].sort();
    const current = await loadBoundaryReviewContext(input.projectRoot), state = snapshot();
    const scope = await context(current.candidate);
    const saved = state.read?.scope_question_id ? state.questions.find(q => q.id === state.read!.scope_question_id) : undefined;
    const record = saved?.read_scope?.record ?? proposed;
    if (!record || saved?.disposition || state.questions.some(q => q.read_scope?.predecessor_id === saved?.id && saved))
      return { required: [], unresolved: roots };
    const parsed = parseReadScopeRecord(record);
    if (assessReadScopeRecordCurrentness({ record: parsed, expectedBinding: scope.binding }).status === "stale")
      return { required: [], unresolved: roots };
    assertReadScopeProvenance(parsed, { ...scope, expectedBinding: scope.binding });
    const required: string[] = [], unresolved: string[] = [];
    for (const root of roots) {
      const requirements = parsed.proposal.requirements.filter(r => r.targets.some(t => t.root_resource === root));
      const subjects = requirements.filter(r => r.disposition === "include").flatMap(r => r.subjects.filter(s => s.root_resource === root));
      if (!subjects.length || requirements.some(r => r.disposition === "unresolved") || subjects.some(s => s.mode === "unresolved")) unresolved.push(root);
      else if (subjects.some(s => s.mode === "trusted_principal")
        || parsed.subject_bindings.some(binding => binding.root_resource === root && binding.kind === "principal")) required.push(root);
    }
    return { required, unresolved };
  };
  return { context, preview, pendingRevision, commitPendingRevisionScope, answerIds, review: host.review, restore, recordNoRead, principalRequirement };
}
