import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "../authoring-protocol.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./reviewed-read-scope.js";
import { projectReadSubjectContext } from "../authoring-read-subject-context.js";
import { projectReadScopeHostContext } from "../read-current-evidence.js";
import { explorationBoundaryCandidateDigest } from "../auto-boundary.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import { createReadAssistanceCheckpointHost, type ReadAssistanceCheckpointUpdate } from "../authoring-read-assistance-checkpoint-host.js";
import { createReadMeaningHost, type ReadMeaningRecordUpdate } from "../authoring-read-meaning-host.js";
import { generateModelReadWorkload, readWorkloadCatalog, type ModelReadWorkloadInput } from "../read-workload-model.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "../authoring-generation-recovery.js";
import { createReadScopeHost, type ReadScopeInteraction, type ReadScopeInteractionResponse } from "../authoring-read-scope-host.js";
import { storeReadWorkloadAnalysis, readStoredReadWorkloadAnalysis } from "../read-workloads.js";
import { READ_SCOPE_PROTOCOL } from "../read-structured-scope.js";

/** Ordinary declared structural preparation, actual producer completion, native
 * question/answer owners and disk Resume CAS. No preseeded mapping or answer. */
export async function typedReadAssistanceFixture(request: string, answer: (() => Promise<string | null>) | undefined, model = "gpt-5.6-luna",
  additionalFields: Record<string, { type: string }> = {},
  domain = { resource: "public.orders", field: "status", primaryKey: "id" }, additionalFilterFields: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typed-read-assistance-"));
  const prepared = await prepareReviewedReadScope(root, { resources: [domain.resource], field: domain.field, primaryKey: domain.primaryKey,
    fields: { [domain.primaryKey]: { type: "uuid" }, [domain.field]: { type: "text" }, ...additionalFields },
    review: { selectable_fields: [...new Set([domain.primaryKey, domain.field, ...Object.keys(additionalFields)])], filterable_fields: [domain.field, ...additionalFilterFields], allow_reviewed_fields: Object.keys(additionalFields) } });
  const boundary = prepared.context.candidate;
  const input = { binding: { boundary_name: boundary.pack.name, generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    schema_fingerprint: prepared.context.lock.schema_fingerprint, role_posture_fingerprint: boundary.role_posture_fingerprint },
    stage: "read_mapping" as const, jobIntent: request, provider: "openai" as const, model };
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } });
  await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
  const persist = async (next: typeof state) => { await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: state.revision_digest }); state = next; };
  let staged: ReadAssistanceCheckpointUpdate & ReadMeaningRecordUpdate = {}, locked = false;
  const catalog = readWorkloadCatalog(boundary), contextDigest = d({ source: input.binding, task: request }), scopeDigest = d({ request });
  const references = () => {
    const questions = staged.questions ?? state.operator_questions ?? [], handoffs = staged.handoffs ?? state.owner_handoffs ?? [];
    return projectReadScopeHostContext({ request: { id: "job", text: request },
      catalog: { digest: catalog.digest, resources: catalog.resources, relationships: [],
        subject_scopes: projectReadSubjectContext({ context: prepared.context, sourceDigest: d(null) }).subject_scopes },
      binding: { meaning_digest: contextDigest, applicability_digest: scopeDigest, operation_digest: d(boundary) },
      records: { questions, handoffs, generation: staged.recovery ?? state.generation_recovery },
      answerQuestionIds: questions.filter(q => q.raw_answer?.text.trim() && !q.disposition
        && !questions.some(next => next.read_scope?.predecessor_id === q.id)).map(q => q.id) });
  };
  const mutate = async <T,>(fn: (permit: never) => Promise<T>) => {
    if (locked) throw new Error("Nested test mutation"); locked = true; const previous = staged;
    try { return await fn({ fixturePermit: true } as never); } catch (error) { staged = previous; throw error; } finally { locked = false; }
  };
  const faults: { rawSave?: "before_write" | "after_write" } = {};
  const save = async () => {
    if (!locked) throw new Error("Native save outside protected fixture port");
    const rawWrite = staged.questions?.some(q => q.raw_answer && !state.operator_questions?.find(old => old.id === q.id)?.raw_answer);
    if (rawWrite && faults.rawSave === "before_write") throw new Error("OWNED_RAW_SAVE_NOT_ACKNOWLEDGED");
    await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state,
      readAssistanceCheckpoint: "checkpoint" in staged ? staged.checkpoint ?? null : state.read_assistance,
      read: staged.read ?? state.read, generationRecovery: staged.recovery ?? state.generation_recovery,
      operatorQuestions: staged.questions ?? state.operator_questions, ownerHandoffs: staged.handoffs ?? state.owner_handoffs })); staged = {};
    if (rawWrite && faults.rawSave === "after_write") throw new Error("OWNED_RAW_SAVE_NOT_ACKNOWLEDGED");
  };
  const common = { mutate, scopeDigest: () => scopeDigest, contextDigest: async () => contextDigest,
    readQuestions: () => staged.questions ??= structuredClone(state.operator_questions ?? []), readHandoffs: () => staged.handoffs ??= structuredClone(state.owner_handoffs ?? []),
    readCheckpoint: () => "checkpoint" in staged ? staged.checkpoint : state.read_assistance,
    readRecovery: () => staged.recovery ?? state.generation_recovery,
    install: (update: ReadAssistanceCheckpointUpdate & ReadMeaningRecordUpdate) => { staged = { ...staged, ...update }; }, save,
    checkpointFailure: (message: string) => new Error(message) };
  const checkpoint = createReadAssistanceCheckpointHost({ access: { ...common, scopeInventory: async () => references(),
    currentCandidate: async () => ({ candidate_digest: explorationBoundaryCandidateDigest(boundary) }),
    readPreparedRead: () => state.read, readConversation: () => undefined, readReviewedRelationshipAnswer: () => undefined,
    storeAnalysis: value => storeReadWorkloadAnalysis({ projectRoot: root, ...value }),
    appendSourceMessage: async () => { throw new Error("No Source mutation expected"); } } });
  const meaning = createReadMeaningHost({ access: { ...common, readConversationTurns: () => [], assertFresh: async () => {} },
    answerTooLarge: () => {}, interact: async view => {
      if (locked || view.kind !== "question" || !answer) throw new Error("Expected unlocked actual raw question");
      return { kind: "answer", binding: view.binding, raw: await answer() };
    } });
  const structuredScope = { protocol: READ_SCOPE_PROTOCOL, current: references,
    answer: answer ? meaning.answerScope : undefined, resolveAnswer: meaning.resolveScopeAnswer };
  const currentReview = async () => {
    const disk = await readBoundaryAuthoringResumeState(root, input.binding);
    if (disk.status !== "ready" || !disk.value.read?.scope_question_id) throw new Error("Actual native review is missing");
    const saved = disk.value, question = saved.operator_questions!.find(q => q.id === saved.read!.scope_question_id)!;
    const stored = await readStoredReadWorkloadAnalysis({ projectRoot: root, analysisId: saved.read!.analysis_id });
    const inventory = references();
    return { ...inventory, native: { questions: saved.operator_questions!, handoffs: saved.owner_handoffs ?? [],
      generation: saved.generation_recovery, question_id: question.id, analysis: stored.analysis },
      resume_revision_digest: saved.revision_digest, context_digest: question.context_digest, scope_digest: question.scope_digest };
  };
  const reviewScope = (interact: (view: ReadScopeInteraction) => Promise<ReadScopeInteractionResponse>,
    controls: { failSave?: boolean; changedSource?: boolean } = {}) => {
    const loadSnapshot = async (questionId: string) => {
        const current = await currentReview();
        if (current.native.question_id !== questionId) throw new Error("Wrong actual scope question");
        return { ...current.native, references: current.references, catalog: current.catalog,
          expectedBinding: { ...current.binding, ...(controls.changedSource ? { source_digest: d("unacknowledged Source change") } : {}) },
          resume_revision_digest: current.resume_revision_digest, context_digest: current.context_digest, scope_digest: current.scope_digest };
      };
    const host = createReadScopeHost({ access: { mutate,
      load: loadSnapshot,
      // This fixture's existing mutation port models ownership, not a real mutex.
      // Genuine held-access proof is in the native scope/activation fixtures.
      loadHeld: async questionId => { if (!locked) throw new Error("Missing modeled protected owner"); return loadSnapshot(questionId); },
      save: async (question, { expected }) => {
        if (!locked || state.revision_digest !== expected.resume_revision_digest) throw new Error("Unacknowledged native revision");
        if (controls.failSave) throw new Error("NATIVE_REVIEW_SAVE_FAILED");
        await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, read: state.read,
          generationRecovery: state.generation_recovery, ownerHandoffs: state.owner_handoffs,
          operatorQuestions: state.operator_questions!.map(q => q.id === question.id ? question : q) }));
      },
    }, interact: async view => { if (locked) throw new Error("Lease over human wait"); return interact(view); } });
    return host.review(state.read!.scope_question_id!);
  };
  return { boundary, structuredScope, currentReview, reviewScope, faults, state: () => state, coldState: () => readBoundaryAuthoringResumeState(root, input.binding),
    reload: async () => {
      if (locked) throw new Error("Cannot reload across an owned mutation");
      const disk = await readBoundaryAuthoringResumeState(root, input.binding);
      if (disk.status !== "ready") throw new Error("Exact native cold state unavailable");
      state = disk.value; staged = {}; return disk.value;
    },
    run: (options: ModelReadWorkloadInput, scopeAdapter: NonNullable<ModelReadWorkloadInput["structuredScope"]> = structuredScope) => withAuthoringGenerationRecovery(async () => {
      configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery,
        current: async () => contextDigest, progress: () => {},
        write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery, read: state.read,
          operatorQuestions: state.operator_questions, ownerHandoffs: state.owner_handoffs })) });
      return generateModelReadWorkload({ ...options, generatedBoundary: boundary, structuredScope: scopeAdapter,
        onCheckpoint: async (cp, current, result, completion) => { await checkpoint.persist(cp, current, result, completion);
          await options.onCheckpoint?.(cp, current, result, completion); } });
    }), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
