import { appendBoundaryPlanningResult, createBoundaryPlanningResult, assertBoundaryPlanningResultNative, restoreBoundaryPlanningResult, type BoundaryPlanningInvocation, type BoundaryPlanningResult } from "./authoring-planning-result.js";
import type { BoundaryJobPlan } from "./boundary-job-model.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { randomUUID } from "node:crypto";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import type { BoundaryAuthoringReadRevision, BoundaryAuthoringResumeRead, BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { authoringPlanningCheckpoint, authoringReadCheckpoint, type AuthoringQuestionCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { projectAuthoringReadScopeContext, projectAuthoringReadScopePreview } from "./authoring-read-scope-context.js";
import { createReadScopeHost, type ReadScopeHostAccess, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
import { createReadScopeQuestion, proposeReadScopeReview, resolveNativeReadScope } from "./authoring-read-scope-question.js";
import { loadHistoricalReadScopeInventoryHeld } from "./authoring-read-scope-history.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { assertReadScopeProvenance, assessReadScopeDraft, assessReadScopeRecordCurrentness, parseReadScopeRecord, type ReadScopeRecord } from "./read-structured-scope.js";
import { loadBoundaryReviewContextHeld, type BoundaryReviewContext } from "./boundary-review-context.js";
import { readReadWorkloadAnalysis, type ReadWorkloadView, readStoredReadWorkloadAnalysis } from "./read-workloads.js";
import type { ReadScopeReplacementOwner } from "./read-current-evidence.js";
import { readRevisionMappingContinuation, type ReadRevisionMappingOwner } from "./read-revision-mapping-continuation.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
/** Semantic readiness is derived from the exact native question/analysis, never labels. */
export type NativeReadScopeAssessment =
  | { kind: "missing"; status: "pending"; candidate_digest: Digest }
  | { kind: "native"; status: "pending" | "proposed" | "confirmed" | "stale";
      candidate_digest: Digest; question_id: string; record: ReadScopeRecord;
      requirements: ReadScopeRecord["proposal"]["requirements"]; replacement_pending: boolean;
      analysis_assessment?: ReturnType<typeof assessReadScopeDraft> };
export type NativeReadScopeSnapshot = {
  resume?: BoundaryAuthoringResumeState; revision?: Digest; blocked: boolean;
  questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState; read?: BoundaryAuthoringResumeRead; sources?: PolicySourceSession;
};
export type NativeReadScopePorts = {
  snapshot(): NativeReadScopeSnapshot;
  assertCurrent(permit: ProjectAuthorityMutationPermit): Promise<void>;
  questionContext(permit: ProjectAuthorityMutationPermit): Promise<Digest>;
  questionScope(): Digest;
  mutate: ReadScopeHostAccess["mutate"];
  failure(subject: string): Error;
  /** Existing owner alone installs records and acknowledges Resume CAS. The
   * generation patch is the actual consumed completion, never a fake answer. */
  save(input: { questions: OperatorQuestion[]; generation?: AuthoringTransportState;
    planningResult?: BoundaryPlanningResult;
    pendingReadRevisionState?: BoundaryAuthoringReadRevision;
    read?: BoundaryAuthoringResumeRead;
    completedReadRevision?: { question_id: string };
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
  const project = (boundary: ExplorationBoundaryDraft, structuralReview: BoundaryReviewContext,
    answerQuestionIds = answerIds(), state = snapshot(),
    native?: Parameters<typeof projectAuthoringReadScopeContext>[0]["native"]) => {
    return projectAuthoringReadScopeContext({ resume: state.resume, boundary, structuralReview, sources: state.sources,
      records: { questions: state.questions, handoffs: state.handoffs, generation: state.generation }, answerQuestionIds, native });
  };
  const contextUnlocked = async (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit, answerQuestionIds = answerIds()) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot();
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
  const previewUnlocked = async (boundary: ExplorationBoundaryDraft,
    prepared: { candidate: ExplorationBoundaryDraft; build: { lock: GenerationLock } },
    permit: ProjectAuthorityMutationPermit, answerQuestionIds = answerIds()) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot();
    const projected = projectAuthoringReadScopePreview({ resume: state.resume, boundary, structuralReview: current,
      sources: state.sources, records: { questions: state.questions, handoffs: state.handoffs, generation: state.generation },
      answerQuestionIds, preparedCandidate: prepared.candidate, preparedLock: prepared.build.lock });
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent native Read revision preview");
    return projected;
  };
  /** The prior mapped Read remains in its native slot. Only this explicit port
   * selects the separately saved, consumed revision for ordinary new mapping. */
  const pendingRevisionUnlocked = async (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot();
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
  type CommittedRevision = { boundary: ExplorationBoundaryDraft; questionId: string; savedReadDigest: Digest };
  const commitRevisionScope = async (expected: CommittedRevision,
    selected?: Pick<BoundaryAuthoringResumeRead, "analysis_id" | "analysis_digest">) =>
    input.ports.mutate(async permit => {
      await input.ports.assertCurrent(permit);
      const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot();
      const revision = state.resume.pending_read_revision_state;
      if (!revision?.result_received || revision.checkpoint || revision.terminal_reason
        || revision.scope_question_id !== expected.questionId || revision.saved_read_digest !== expected.savedReadDigest
        || explorationBoundaryCandidateDigest(expected.boundary) !== expected.savedReadDigest
        || explorationBoundaryCandidateDigest(current.candidate) !== expected.savedReadDigest)
        return unavailable("The exact recorded disabled Read revision commit");
      const inventory = project(expected.boundary, current, answerIds(), state);
      const stored = selected ? await readReadWorkloadAnalysis({ projectRoot: input.projectRoot,
        analysisId: selected.analysis_id, generatedBoundary: current.candidate }) : undefined;
      if (stored && (stored.analysis_digest !== selected!.analysis_digest || !state.read
        || stored.state === "stale" || stored.state === "blocked" || stored.analysis.status !== "ready"))
        return unavailable("The exact stored analyzed Read revision");
      const resolved = resolveNativeReadScope({ questions: state.questions, handoffs: state.handoffs, generation: state.generation,
        question_id: expected.questionId, expectedBinding: inventory.binding, ...inventory,
        ...(stored ? { analysis: stored.analysis } : {}) });
      const old = resolved.question;
      if (old.id !== expected.questionId || old.read_scope?.mode !== "review"
        || old.read_scope.record.proposal.applicability !== "read_requested" || old.confirmation || old.disposition
        || resolved.replacement_pending || (stored
          ? old.read_scope.record.analysis_digest !== canonicalJsonDigest(stored.analysis) || resolved.status !== "proposed"
          : old.read_scope.record.analysis_digest !== undefined || old.proposal || resolved.status !== "pending"))
        return unavailable("The exact consumed pending Read revision proposal");
      const contextDigest = await input.ports.questionContext(permit);
      let successor = createReadScopeQuestion({ id: randomUUID(), revision: old.revision + 1,
        scope_digest: input.ports.questionScope(), context_digest: contextDigest,
        read_scope: { ...old.read_scope, predecessor_id: old.id } });
      if (stored) successor = proposeReadScopeReview(successor, inventory.binding, stored.analysis, inventory);
      await input.ports.assertCurrent(permit);
      if (snapshot().revision !== state.revision) return unavailable("The unchanged committed Read revision checkpoint");
      const requestedQuestions = [...state.questions, successor];
      const expectedQuestionsDigest = canonicalJsonDigest(requestedQuestions), successorId = successor.id;
      const requestedRevision = stored ? undefined : { ...revision, scope_question_id: successorId };
      const requestedRead = stored ? { analysis_id: stored.analysis_id, analysis_digest: stored.analysis_digest,
        scope_question_id: successorId, ...(state.read!.assistance_history ? { assistance_history: state.read!.assistance_history } : {}) } : state.read;
      const expectedRevisionDigest = canonicalJsonDigest(requestedRevision ?? null);
      const expectedReadDigest = canonicalJsonDigest(requestedRead), expectedGenerationDigest = canonicalJsonDigest(state.generation);
      await input.ports.save({ questions: structuredClone(requestedQuestions),
        ...(stored ? { read: structuredClone(requestedRead!), completedReadRevision: { question_id: old.id } }
          : { pendingReadRevisionState: structuredClone(requestedRevision!) }), stage: state.resume.stage,
        acknowledgeCompletedTurn: false, subject: stored ? "The committed analyzed Read scope awaiting review" : "The committed Read scope awaiting mapping" }, permit);
      const acknowledged = snapshot();
      if (canonicalJsonDigest(acknowledged.resume.pending_read_revision_state ?? null) !== expectedRevisionDigest
        || canonicalJsonDigest(acknowledged.questions) !== expectedQuestionsDigest
        || canonicalJsonDigest(acknowledged.read) !== expectedReadDigest
        || canonicalJsonDigest(acknowledged.resume.read) !== expectedReadDigest
        || canonicalJsonDigest(acknowledged.generation) !== expectedGenerationDigest
        || stored && acknowledged.resume.pending_read_revision !== undefined)
        return unavailable("The acknowledged committed Read scope successor");
      return successorId;
    });
  const commitPendingRevisionScope = (expected: CommittedRevision) => commitRevisionScope(expected);
  const commitAnalyzedRevisionScope = (expected: CommittedRevision & {
    analysis: Pick<BoundaryAuthoringResumeRead, "analysis_id" | "analysis_digest">;
  }) => commitRevisionScope(expected, expected.analysis);
  const loadScopeUnlocked = async (questionId: string, permit: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot(), scope = project(current.candidate, current);
    const question = resolveNativeReadScope({ questions: state.questions, handoffs: state.handoffs,
      generation: state.generation, question_id: questionId, expectedBinding: scope.binding,
      references: scope.references, catalog: scope.catalog }).question;
    if (!question?.read_scope) return unavailable("The exact native Read question");
    const stored = question.read_scope.record.analysis_digest
      && (state.read?.scope_question_id === questionId || state.read?.scope_question_id === question.id)
      ? await readStoredReadWorkloadAnalysis({ projectRoot: input.projectRoot, analysisId: state.read.analysis_id }) : undefined;
    if (question.read_scope.record.analysis_digest && (!stored || stored.analysis_digest !== state.read?.analysis_digest))
      unavailable("The exact analyzed Read proposal");
    const context_digest = await input.ports.questionContext(permit);
    const historical_inventory = await loadHistoricalReadScopeInventoryHeld({ projectRoot: input.projectRoot,
      record: question.read_scope.record, current, resume: state.resume,
      sources: state.sources, questions: state.questions, handoffs: state.handoffs, generation: state.generation }, permit);
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent native Read assessment");
    return { candidate_digest: explorationBoundaryCandidateDigest(current.candidate), questions: state.questions, handoffs: state.handoffs, generation: state.generation, question_id: questionId,
      expectedBinding: scope.binding, references: scope.references, catalog: scope.catalog,
      historical_inventory,
      ...(stored ? { analysis: stored.analysis } : {}), resume_revision_digest: state.revision,
      context_digest, scope_digest: input.ports.questionScope() };
  };
  const assessUnlocked = async (boundary: ExplorationBoundaryDraft,
    permit: ProjectAuthorityMutationPermit): Promise<NativeReadScopeAssessment> => {
    await input.ports.assertCurrent(permit);
    const before = snapshot(), candidateDigest = explorationBoundaryCandidateDigest(boundary);
    const pending = before.resume.pending_read_revision_state?.scope_question_id;
    const questionId = pending ?? before.read?.scope_question_id;
    if (!questionId) {
      const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit);
      await input.ports.assertCurrent(permit);
      if (snapshot().revision !== before.revision || explorationBoundaryCandidateDigest(current.candidate) !== candidateDigest)
        return unavailable("The unchanged current Read candidate");
      return { kind: "missing", status: "pending", candidate_digest: candidateDigest };
    }
    // A consumed settings-only revision has a separate exact owner. It may not
    // borrow the old mapped selection or imply an analyzed/confirmed result.
    if (pending) await pendingRevisionUnlocked(boundary, permit);
    const loaded = await loadScopeUnlocked(questionId, permit);
    if (loaded.resume_revision_digest !== before.revision || loaded.candidate_digest !== candidateDigest)
      return unavailable("The unchanged selected native Read scope");
    const resolved = resolveNativeReadScope(loaded), record = resolved.record;
    const exactContext = resolved.question.context_digest === loaded.context_digest
      && resolved.question.scope_digest === loaded.scope_digest && resolved.question.id === questionId;
    return { kind: "native", status: exactContext ? resolved.status : "stale", candidate_digest: candidateDigest,
      question_id: resolved.question.id, record, requirements: structuredClone(record.proposal.requirements),
      replacement_pending: resolved.replacement_pending,
      ...(loaded.analysis ? { analysis_assessment: assessReadScopeDraft(record, loaded.analysis) } : {}) };
  };
  const host = createReadScopeHost({ access: {
    mutate: input.ports.mutate,
    load: questionId => withProjectAuthorityMutation(input.projectRoot, held => loadScopeUnlocked(questionId, held)),
    loadHeld: (questionId, permit) => withHeldProjectAuthorityAccess(input.projectRoot, permit, held => loadScopeUnlocked(questionId, held)),
    save: async (question, options) => {
      const state = snapshot();
      const existing = state.questions.some(q => q.id === question.id);
      const expectedQuestion = resolveNativeReadScope(options.expected).question;
      const selected = state.read?.scope_question_id === options.expected.question_id
        || state.read?.scope_question_id === expectedQuestion.id;
      if (!existing && (question.read_scope?.mode !== "review"
        || question.read_scope.predecessor_id !== expectedQuestion.id || !selected))
        return unavailable("The exact selected Read scope replacement");
      await input.ports.save({ questions: existing ? state.questions.map(q => q.id === question.id ? question : q) : [...state.questions, question],
        ...(selected && state.read!.scope_question_id !== question.id ? { read: { ...state.read!, scope_question_id: question.id } } : {}),
        stage: state.resume.stage, acknowledgeCompletedTurn: true, subject: options.subject }, options.permit);
    },
  }, interact: input.interact });
  /** Capture the complete actual planner result before any human wait. The
   * question has no answer/confirmation, and a requested Read has no analysis. */
  const recordPlanning = async (plan: Extract<BoundaryJobPlan, { state: "planned" }>) => input.ports.mutate(async permit => {
    await input.ports.assertCurrent(permit);
    if (!plan.completion || !plan.read_scope) return unavailable("The actual complete planning result");
    const state = snapshot(), current = await loadBoundaryReviewContextHeld(input.projectRoot, permit);
    const inventory = project(current.candidate, current);
    assertReadScopeProvenance(plan.read_scope, { expectedBinding: inventory.binding, ...inventory });
    if (assessReadScopeRecordCurrentness({ record: plan.read_scope, expectedBinding: inventory.binding }).status === "stale")
      return unavailable("The exact current planning scope");
    const question = createReadScopeQuestion({ id: randomUUID(), revision: 1,
      scope_digest: input.ports.questionScope(), context_digest: await input.ports.questionContext(permit),
      read_scope: { mode: "review", record: plan.read_scope, completion: plan.completion } });
    const planningResult = createBoundaryPlanningResult(plan, question.id);
    const generation = authoringPlanningCheckpoint(authoringReadCheckpoint(state.generation, plan.completion,
      readScopeConsumption(question.read_scope!)), plan.completion, planningResult.material_digest);
    const questions = [...state.questions, question];
    const expected = canonicalJsonDigest({ stage: "planning", questions, generation, planningResult, planningResults: appendBoundaryPlanningResult(state.resume.planning_results ?? [], planningResult), read: state.read ?? null,
      pendingRevision: state.resume.pending_read_revision_state ?? null });
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The original planning checkpoint revision");
    await input.ports.save(structuredClone({ questions, generation, planningResult, stage: "planning" as const,
      acknowledgeCompletedTurn: false, subject: "The exact completed planning result" }), permit);
    const acknowledged = snapshot();
    if (canonicalJsonDigest({ stage: acknowledged.resume.stage, questions: acknowledged.questions, generation: acknowledged.generation,
      planningResult: acknowledged.resume.planning_result, planningResults: acknowledged.resume.planning_results, read: acknowledged.read ?? null,
      pendingRevision: acknowledged.resume.pending_read_revision_state ?? null }) !== expected)
      return unavailable("The exact acknowledged planning checkpoint");
    return structuredClone(planningResult);
  });
  const restorePlanningUnlocked = async (invocation: BoundaryPlanningInvocation, permit: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const state = snapshot(), result = state.resume.planning_result;
    if (!result) return unavailable("The saved complete planning result");
    const plan = restoreBoundaryPlanningResult(result, state.generation, state.questions, invocation);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), inventory = project(current.candidate, current);
    assertReadScopeProvenance(plan.read_scope!, { expectedBinding: inventory.binding, ...inventory });
    const q = state.questions.find(q => q.id === result.read_scope_question_id)!;
    if (q.scope_digest !== input.ports.questionScope() || q.context_digest !== await input.ports.questionContext(permit)
      || q.disposition && plan.read_scope!.proposal.applicability !== "no_read_requested"
      || state.questions.some(next => next.read_scope?.predecessor_id === q.id))
      return unavailable("The current planning continuation");
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent planning continuation");
    return plan;
  };
  const pendingPlanningUnlocked = async (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit) => {
    await input.ports.assertCurrent(permit);
    const state = snapshot(), result = state.resume.planning_result;
    if (!result || result.plan.read_scope?.proposal.applicability !== "read_requested") return undefined;
    assertBoundaryPlanningResultNative(result, state.generation, state.questions);
    const question = state.questions.find(q => q.id === result.read_scope_question_id)!;
    if (question.confirmation || question.disposition || state.questions.some(q => q.read_scope?.predecessor_id === question.id)) return undefined;
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), inventory = project(boundary, current);
    assertReadScopeProvenance(question.read_scope!.record, { expectedBinding: inventory.binding, ...inventory });
    if (question.scope_digest !== input.ports.questionScope()
      || question.context_digest !== await input.ports.questionContext(permit)) return unavailable("The exact pending planning scope");
    await input.ports.assertCurrent(permit);
    if (snapshot().revision !== state.revision) return unavailable("The coherent pending planning scope");
    return { result: structuredClone(result), question: structuredClone(question) };
  };
  const recordNoRead = async (record: ReadScopeRecord, completion: AuthoringQuestionCompletion) => input.ports.mutate(async permit => {
    await input.ports.assertCurrent(permit);
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot(), inventory = project(current.candidate, current);
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
    const { saved, workload, stage } = await withProjectAuthorityMutation(input.projectRoot, async permit => {
      await input.ports.assertCurrent(permit);
      const before = snapshot(), saved = before.read;
      if (!saved) return unavailable("The exact saved Read analysis");
      const workload = await readReadWorkloadAnalysis({ projectRoot: input.projectRoot,
        analysisId: saved.analysis_id, generatedBoundary: boundary });
      if (workload.analysis_digest !== saved.analysis_digest)
        throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED: the saved Read analysis no longer matches this authoring checkpoint.");
      await input.ports.assertCurrent(permit);
      if (snapshot().revision !== before.revision) return unavailable("The coherent saved Read mapping");
      return { saved, workload, stage: before.resume.stage };
    });
    if (saved.scope_question_id) {
      const decision = await host.review(saved.scope_question_id);
      if (decision.state === "replace_requested") {
        return withProjectAuthorityMutation(input.projectRoot, async permit => {
          await input.ports.assertCurrent(permit);
          const current = snapshot();
          if (current.read?.analysis_digest !== saved.analysis_digest
            || current.read.scope_question_id !== decision.question_id)
            return unavailable("The exact declined Read mapping");
          return { state: "replacement" as const, owner: { read: current.read, questions: current.questions,
            handoffs: current.handoffs, generation: current.generation,
            question_id: decision.question_id, analysis: workload.analysis } };
        });
      }
      if (decision.state !== "confirmed") return { state: "pending" };
      return { state: "restored", workload, reuse: Boolean(workload.review), disabled: false };
    }
    const reuse = stage === "authority_review" || Boolean(workload.review);
    return { state: "restored", workload, reuse, disabled: !reuse };
  };
  const principalRequirement = async (resources: readonly string[], proposed?: ReadScopeRecord) => withProjectAuthorityMutation(input.projectRoot, async permit => {
    const roots = [...new Set(resources)].sort();
    const current = await loadBoundaryReviewContextHeld(input.projectRoot, permit), state = snapshot();
    const scope = await contextUnlocked(current.candidate, permit);
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
  });
  // Entry versus held access is explicit at the public native owner boundary.
  // Only these read projections are scoped; the review/restore UI never is.
  const context = (boundary: ExplorationBoundaryDraft, answerQuestionIds?: string[]) =>
    withProjectAuthorityMutation(input.projectRoot, held => contextUnlocked(boundary, held, answerQuestionIds));
  const contextHeld = (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit, answerQuestionIds?: string[]) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => contextUnlocked(boundary, held, answerQuestionIds));
  type PreparedPreview = { candidate: ExplorationBoundaryDraft; build: { lock: GenerationLock } };
  const preview = (boundary: ExplorationBoundaryDraft, prepared: PreparedPreview, answerQuestionIds?: string[]) =>
    withProjectAuthorityMutation(input.projectRoot, held => previewUnlocked(boundary, prepared, held, answerQuestionIds));
  const previewHeld = (boundary: ExplorationBoundaryDraft, prepared: PreparedPreview, permit: ProjectAuthorityMutationPermit, answerQuestionIds?: string[]) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => previewUnlocked(boundary, prepared, held, answerQuestionIds));
  const assess = (boundary: ExplorationBoundaryDraft) =>
    withProjectAuthorityMutation(input.projectRoot, held => assessUnlocked(boundary, held));
  const assessHeld = (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => assessUnlocked(boundary, held));
  const pendingRevision = (boundary: ExplorationBoundaryDraft) =>
    withProjectAuthorityMutation(input.projectRoot, held => pendingRevisionUnlocked(boundary, held));
  const pendingRevisionHeld = (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => pendingRevisionUnlocked(boundary, held));
  const restorePlanning = (invocation: BoundaryPlanningInvocation) =>
    withProjectAuthorityMutation(input.projectRoot, held => restorePlanningUnlocked(invocation, held));
  const restorePlanningHeld = (invocation: BoundaryPlanningInvocation, permit: ProjectAuthorityMutationPermit) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => restorePlanningUnlocked(invocation, held));
  const pendingPlanning = (boundary: ExplorationBoundaryDraft) =>
    withProjectAuthorityMutation(input.projectRoot, held => pendingPlanningUnlocked(boundary, held));
  const pendingPlanningHeld = (boundary: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, held => pendingPlanningUnlocked(boundary, held));
  return { recordPlanning, restorePlanning, restorePlanningHeld, pendingPlanning, pendingPlanningHeld, context, contextHeld, assess, assessHeld, preview, previewHeld, pendingRevision, pendingRevisionHeld, commitPendingRevisionScope, commitAnalyzedRevisionScope, answerIds, review: host.review, restore, recordNoRead, principalRequirement };
}
