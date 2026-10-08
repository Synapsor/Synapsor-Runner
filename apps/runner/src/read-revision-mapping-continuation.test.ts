import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { projectAuthoringReadScopeContext, projectAuthoringReadScopePreview } from "./authoring-read-scope-context.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringReadCheckpoint } from "./authoring-generation-recovery.js";
import { createReadScopeQuestion, proposeReadScopeReview } from "./authoring-read-scope-question.js";
import { createReadAssistanceCheckpointHost, type ReadAssistanceCheckpointUpdate } from "./authoring-read-assistance-checkpoint-host.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { createReadRevisionCheckpointHost, type ReadRevisionCheckpointAccess } from "./authoring-read-revision-checkpoint-host.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { readWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { generateModelReadWorkload, type ModelReadWorkloadInput } from "./read-workload-model.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
import { storeReadWorkloadAnalysis, type ReadWorkloadView } from "./read-workloads.js";
import type { ReadRevisionMappingOwner } from "./read-revision-mapping-continuation.js";
import { prepareReadRevisionAnalysis, storeCommittedReadRevisionAnalysis } from "./authoring-read-revision-scope.js";

// The setup, mapping, revision, consumed records and commit are real owners.
// Fake model replies use only actual transmitted refs/catalog + declared facts.
function lines(body: unknown): string[] {
  if (typeof body === "string") return body.split("\n");
  return body && typeof body === "object" ? Object.values(body).flatMap(lines) : [];
}
function visible(body: unknown, prefix: string) {
  const line = lines(body).find(line => line.startsWith(prefix));
  if (!line) throw new Error(`Missing actual request inventory ${prefix}`);
  return JSON.parse(line.slice(prefix.length));
}
function proposal(refs: Array<{kind:string;id:string;text:string}>, subjects: Array<{root_resource:string;reference:string}>): ReadScopeProposal {
  const request = refs.find(ref => ref.kind === "request")!, subject = subjects.find(item => item.root_resource === "work.items")!;
  return { protocol: READ_SCOPE_PROTOCOL, original_request: request.id, applicability: "read_requested", requirements: [{
    id: "labels", intended_use: request.text, references: [request.id], disposition: "include",
    subjects: [{ root_resource: "work.items", mode: "reviewed_resource", scope_reference: subject.reference }],
    targets: [{ root_resource: "work.items", resource: "work.items", operation: "resource" },
      { root_resource: "work.items", resource: "work.items", operation: "return", field: "label" },
      { root_resource: "work.items", resource: "work.items", operation: "filter", field: "label", qualifier: "eq" }],
  }] };
}
const response = (tool: string, args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: randomUUID(), name: tool, arguments: JSON.stringify(args) }] } });
it.each(["ordinary", "native_adapter", "native_analyzed", "native_checkpoint", "native_checkpoint_absent", "native_checkpoint_foreign", "native_checkpoint_commit_drift", "native_wrong_commit", "native_foreign_commit", "native_no_ack", "native_save_failure", "changed_model", "changed_task", "changed_provider_destination", "missing_binding", "wrong_saved_candidate", "foreign_question"] as const)("continues only the exact actually committed revision: %s", async mode => {
  const nativeCase = mode.startsWith("native_"), checkpointCase = mode.startsWith("native_checkpoint");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-read-revision-continuation-"));
  try {
    const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { filterable_fields: ["label"] } });
    let structural = prepared.context, boundary = structural.candidate;
    const job = 'Show the signed-in person their item labels equal to the declared business value "Visible".';
    const originalInput = { binding: boundaryAuthoringResumeBinding(structural.bundle), stage: "read_mapping" as const,
      jobIntent: job, provider: "openai" as const, model: "controlled" };
    let state = buildBoundaryAuthoringResumeState(originalInput), stored: ReadWorkloadView | undefined;
    await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
    const persist = async (next: typeof state) => { await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: state.revision_digest }); state = next; };
    const save = async (fields: Partial<Parameters<typeof buildBoundaryAuthoringResumeState>[0]>) => persist(buildBoundaryAuthoringResumeState({
      ...originalInput, binding: state.binding, previous: state, read: state.read, pendingReadRevision: state.pending_read_revision, pendingReadRevisionState: state.pending_read_revision_state,
      ...fields }));
    const records = () => ({ questions: state.operator_questions ?? [], handoffs: state.owner_handoffs ?? [], generation: state.generation_recovery });
    const scope = () => projectAuthoringReadScopeContext({ resume: state, boundary, structuralReview: structural, records: records() });
    const contextDigest = () => d(scope().binding), scopeDigest = d(job);
    const generation = <T,>(run: () => Promise<T>) => withAuthoringGenerationRecovery(async () => {
      configureAuthoringGenerationRecovery({ available: () => true, current: async () => contextDigest(), read: () => state.generation_recovery,
        write: generationRecovery => save({ generationRecovery }) }); return run();
    });
    let calls = 0;
    const mapping = (owner?: ReadRevisionMappingOwner) => generation(() => generateModelReadWorkload({ name: "labels", allowedQuestions: [owner && mode === "changed_task" ? "Show every person all labels" : job],
      operatorNamingContext: job, provider: owner && mode === "changed_provider_destination" ? "openai_compatible" : "openai", model: owner && mode === "changed_model" ? "other-model" : "controlled",
      ...(owner && mode === "changed_provider_destination" ? { baseUrl: "https://different.example/v1" } : {}), apiKey: "inert-test-key", egressAcknowledged: true,
      deferNarration: true, generatedBoundary: boundary, ...(owner ? { postRevisionMapping: owner } : {}),
      structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => ({ ...scope(), ...(owner ? { native: { ...records(), question_id: owner.question_id } } : {}) }) },
      onCheckpoint: async (cp, current, result, completion) => {
        if (owner && checkpointCase) {
          const questions = structuredClone(state.operator_questions ?? []), handoffs = structuredClone(state.owner_handoffs ?? []);
          let staged: ReadAssistanceCheckpointUpdate = {};
          const host = createReadAssistanceCheckpointHost({ access: {
            mutate: async op => { expect(locked).toBe(false); locked = true; try { return await op({ owned: true } as never); } finally { locked = false; } },
            scopeDigest: () => scopeDigest, contextDigest: async () => contextDigest(),
            currentCandidate: async () => ({ candidate_digest: explorationBoundaryCandidateDigest(boundary) }),
            readCheckpoint: () => state.read_assistance, readPreparedRead: () => state.read,
            readPendingRevision: async () => mode === "native_checkpoint_absent" ? undefined : ({ ...owner, ...records(), read: state.read!,
              question_id: mode === "native_checkpoint_foreign" ? randomUUID() : owner.question_id,
              revision: mode === "native_checkpoint_commit_drift" ? { ...state.pending_read_revision_state!, saved_read_digest: d("foreign commit") } : state.pending_read_revision_state!,
              currentBoundary: boundary }),
            scopeInventory: async () => scope(), readHandoffs: () => handoffs, readQuestions: () => questions,
            readRecovery: () => staged.recovery ?? state.generation_recovery,
            readConversation: () => undefined, readReviewedRelationshipAnswer: () => undefined,
            install: update => { if (update.completedReadRevision) expect(update.completedReadRevision.question_id).toBe(state.pending_read_revision_state!.scope_question_id);
              staged = { ...staged, ...update }; },
            storeAnalysis: args => storeReadWorkloadAnalysis({ projectRoot: root, ...args }),
            appendSourceMessage: async () => { throw new Error("No Source answer mutation"); },
            save: async () => save({ operatorQuestions: questions, ownerHandoffs: handoffs,
              generationRecovery: staged.recovery ?? state.generation_recovery, read: staged.read ?? state.read,
              ...(staged.completedReadRevision ? { pendingReadRevision: undefined, pendingReadRevisionState: null } : {}),
              readAssistanceCheckpoint: Object.hasOwn(staged, "checkpoint") ? staged.checkpoint ?? null : state.read_assistance }),
            checkpointFailure: subject => new Error(`MAPPING_CHECKPOINT_REFUSED: ${subject}`),
          } });
          await host.persist(cp, current, result, completion); return;
        }
        if (cp) { await save({ readAssistanceCheckpoint: cp }); return; }
        if (!result?.read_scope || !completion) throw new Error("Missing genuine mapped scope completion");
        const previousId = owner?.question_id ?? state.read?.scope_question_id;
        const predecessor = previousId ? state.operator_questions!.find(q => q.id === previousId)! : undefined;
        const q = proposeReadScopeReview(createReadScopeQuestion({ id: randomUUID(), revision: predecessor ? predecessor.revision + 1 : 1,
          scope_digest: scopeDigest, context_digest: contextDigest(), read_scope: { mode: "review", record: result.read_scope, completion,
            ...(predecessor ? { predecessor_id: predecessor.id } : {}) } }), scope().binding, result.analysis, scope());
        stored = await storeReadWorkloadAnalysis({ projectRoot: root, generatedBoundary: current, source: result.workload.source, analysis: result.analysis });
        await save({ generationRecovery: authoringReadCheckpoint(state.generation_recovery, completion, readScopeConsumption(q.read_scope!)),
          operatorQuestions: [...(state.operator_questions ?? []), q], readAssistanceCheckpoint: null,
          read: { analysis_id: stored.analysis_id, analysis_digest: stored.analysis_digest, scope_question_id: q.id, assistance_history: state.read_assistance } });
      },
      dependencies: { requestJson: async actual => {
        calls++; const refs = visible(actual.body, "Host scope reference inventory: "), subjects = visible(actual.body, "Host reviewed subject scope inventory: ");
        const request = refs.find((ref: {kind:string}) => ref.kind === "request"); expect(request.text).toBe(job);
        return response("runner__submit_read_workloads", { read_scope: proposal(refs, subjects), allowed: [{ id: "labels", description: "My Visible item labels",
          plan: { kind: "rows", resource: "work.items", select: ["label"], where: [{ field: "label", op: "eq", value: "Visible" }] } }], forbidden: [] });
      } },
    } as ModelReadWorkloadInput));
    const originalMapping = await mapping(); expect(calls).toBe(1); expect(state.read!.assistance_history!.state.call_count).toBe(1);
    const previousAnalysis = stored!, history = structuredClone(state.read!.assistance_history);
    const instruction = "Label the existing item register Customer items; keep all fields and restrictions unchanged.";
    const mutation = await prepareBoundaryResourceReviewMutation(root, { resource_id: "work.items", metadata: { label: "Customer items" },
      actor: "declared fixture operator", reason: instruction }, async () => prepared.inspection);
    const retained = prepareReadRevisionAnalysis({ selected: stored, expected: state.read!, currentBoundary: boundary, preparedCandidate: mutation.candidate,
      ...(mode === "native_analyzed" ? { originalWorkload: originalMapping.workload } : {}) });
    expect(retained).toMatchObject(mode === "native_analyzed" ? { state: "analyzed" } : { state: "pending_mapping", reason: "exact_plan_unavailable" });
    await save({ pendingReadRevision: instruction, pendingReadRevisionState: { instruction, provenance: "operator", privacy_only: false } });
    const native = createNativeReadScope({ projectRoot: root, ports: {
      snapshot: () => ({ resume: state, revision: state.revision_digest, blocked: false, ...records(), read: state.read }),
      assertCurrent: async () => { const actual = await readBoundaryAuthoringResumeState(root, state.binding); expect(actual.status).toBe("ready");
        if (actual.status !== "ready" || actual.value.revision_digest !== state.revision_digest) throw new Error("Fixture native context changed"); },
      questionContext: async () => contextDigest(), questionScope: () => scopeDigest,
      mutate: async op => { expect(locked).toBe(false); locked = true; try { return await op({ owned: true } as never); } finally { locked = false; } },
      failure: subject => new Error(`NATIVE_SCOPE_UNAVAILABLE: ${subject}`),
      save: async (update, permit) => { expect(locked).toBe(true); expect(permit).toBeTruthy();
        if (mode === "native_no_ack") return;
        if (mode === "native_save_failure") throw new Error("Fixture saved-commit acknowledgment unavailable");
        await save({ operatorQuestions: update.questions,
        generationRecovery: update.generation ?? state.generation_recovery, pendingReadRevisionState: update.completedReadRevision ? null : update.pendingReadRevisionState ?? state.pending_read_revision_state,
          ...(update.completedReadRevision ? { pendingReadRevision: undefined } : {}), read: update.read ?? state.read }); },
    }, interact: async () => { throw new Error("No fabricated review"); } });
    const preview = () => ({ scope: projectAuthoringReadScopePreview({ resume: state, boundary, structuralReview: structural,
      records: records(), preparedCandidate: mutation.candidate, preparedLock: mutation.build.lock }),
      ...(retained.state === "analyzed" ? { analysis: retained.analysis } : {}) });
    let locked = false;
    if (nativeCase) expect(await native.preview(boundary, mutation)).toEqual(preview().scope);
    let staged: Parameters<ReadRevisionCheckpointAccess["install"]>[0] & { questions?: typeof state.operator_questions } = {};
    const access: ReadRevisionCheckpointAccess = { mutate: async op => { expect(locked).toBe(false); locked = true; try { return await op({ owned: true } as never); } finally { locked = false; } },
      contextDigest: async () => contextDigest(), scopeDigest: () => scopeDigest,
      currentCandidate: async () => ({ candidate_digest: explorationBoundaryCandidateDigest(boundary) }), readRevision: () => staged.revision ?? state.pending_read_revision_state,
      readInstruction: () => instruction, scopePreview: async () => preview(), readQuestions: () => staged.questions ??= structuredClone(state.operator_questions!),
      readHandoffs: () => state.owner_handoffs ?? [], readRecovery: () => staged.recovery ?? state.generation_recovery, readConversation: () => undefined,
      install: update => { staged = { ...staged, ...update }; },
      appendSourceMessage: async () => { throw new Error("No Source edit"); }, save: async () => { await save({ pendingReadRevisionState: staged.revision ?? state.pending_read_revision_state,
        generationRecovery: staged.recovery ?? state.generation_recovery, operatorQuestions: staged.questions ?? state.operator_questions }); staged = {}; },
      checkpointFailure: subject => new Error(subject) };
    const host = createReadRevisionCheckpointHost({ access });
    const revision = await generation(() => generateModelReadBoundaryRevision({ instruction, provider: "openai", model: "controlled", apiKey: "inert-test-key",
      egressAcknowledged: true, boundary, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: scope },
      validateRevision: async () => preview(), onCheckpoint: host.persist,
      dependencies: { requestJson: async actual => { const inventory = visible(actual.body, "Host scope inventory: ");
        return response("runner__submit_read_boundary_revision", { read_scope: proposal(inventory.references, inventory.catalog.subject_scopes),
          resource_changes: [{ resource: "work.items", settings: { metadata: { label: "Customer items" } } }] }); } } }));
    expect(revision.read_scope_state).toBe(mode === "native_analyzed" ? "analyzed_proposal" : "pending_mapping"); expect(state.pending_read_revision_state?.result_received).toBe(true);
    await commitBoundaryResourceReviewMutation(root, mutation); structural = await loadBoundaryReviewContext(root); boundary = structural.candidate;
    await save({ binding: boundaryAuthoringResumeBinding(structural.bundle), pendingReadRevisionState: { ...state.pending_read_revision_state!, saved_read_digest: explorationBoundaryCandidateDigest(boundary) } });
    const old = state.operator_questions!.find(q => q.id === state.pending_read_revision_state!.scope_question_id)!;
    if (mode === "native_analyzed") {
      const saved = await storeCommittedReadRevisionAnalysis({ projectRoot: root, prepared: retained, expected: state.read!, committedCandidate: boundary });
      expect(saved.review).toBeUndefined();
      const priorRead = structuredClone(state.read), generationBefore = structuredClone(state.generation_recovery);
      const id = await native.commitAnalyzedRevisionScope({ boundary, questionId: old.id, savedReadDigest: explorationBoundaryCandidateDigest(boundary),
        analysis: { analysis_id: saved.analysis_id, analysis_digest: saved.analysis_digest } });
      const current = state.operator_questions!.find(q => q.id === id)!;
      expect(calls).toBe(1); expect(current.confirmation).toBeUndefined(); expect(current.proposal).toBeDefined();
      expect(current.read_scope!.completion).toEqual(old.read_scope!.completion); expect(current.read_scope!.record).toEqual(old.read_scope!.record);
      expect(state.read).toMatchObject({ analysis_id: saved.analysis_id, analysis_digest: saved.analysis_digest, scope_question_id: id,
        assistance_history: priorRead!.assistance_history });
      expect(state.pending_read_revision_state).toBeUndefined(); expect(state.pending_read_revision).toBeUndefined();
      expect(state.generation_recovery).toEqual(generationBefore); return;
    }
    let current = createReadScopeQuestion({ id: randomUUID(), revision: old.revision + 1, scope_digest: old.scope_digest, context_digest: contextDigest(),
      read_scope: { ...old.read_scope!, predecessor_id: old.id } });
    if (nativeCase) {
      const before = structuredClone(state.generation_recovery), priorRead = structuredClone(state.read);
      if (mode !== "native_adapter" && !checkpointCase) {
        const beforeState = d(state);
        await expect(native.commitPendingRevisionScope({ boundary,
          questionId: mode === "native_foreign_commit" ? randomUUID() : old.id,
          savedReadDigest: mode === "native_wrong_commit" ? d("wrong commit") : explorationBoundaryCandidateDigest(boundary),
        })).rejects.toThrow(mode === "native_save_failure" ? "acknowledgment unavailable" : "NATIVE_SCOPE_UNAVAILABLE");
        expect(d(state)).toBe(beforeState); expect(calls).toBe(1); return;
      }
      const id = await native.commitPendingRevisionScope({ boundary, questionId: old.id, savedReadDigest: explorationBoundaryCandidateDigest(boundary) });
      current = state.operator_questions!.find(q => q.id === id)!;
      expect(state.generation_recovery).toEqual(before); expect(state.read).toEqual(priorRead);
      expect(current.read_scope!.completion).toEqual(old.read_scope!.completion);
      expect(current.read_scope!.record).toEqual(old.read_scope!.record); expect(current.confirmation).toBeUndefined();
    } else await save({ operatorQuestions: [...state.operator_questions!, current], pendingReadRevisionState: { ...state.pending_read_revision_state!, scope_question_id: current.id } });
    const disk = await readBoundaryAuthoringResumeState(root, state.binding); expect(disk.status).toBe("ready"); if (disk.status !== "ready") throw new Error("Cold native read failed");
    state = disk.value;
    let owner: ReadRevisionMappingOwner = { ...records(), read: state.read!, revision: state.pending_read_revision_state!, question_id: current.id, currentBoundary: boundary, priorAnalysis: previousAnalysis };
    if (nativeCase) {
      const selected = await native.pendingRevision(boundary);
      owner = selected.owner;
      expect(selected.context.native?.question_id).toBe(current.id);
      expect((await native.context(boundary)).native?.question_id).toBe(state.read!.scope_question_id);
    }
    if (mode === "missing_binding") {
      const retained = structuredClone(owner.read.assistance_history!); delete retained.state.scope_invocation_binding;
      const { schema_version: _version, digest: _digest, ...body } = retained;
      owner.read = { ...owner.read, assistance_history: readWorkloadAssistanceCheckpoint(body) };
    }
    if (mode === "wrong_saved_candidate") owner.revision = { ...owner.revision, saved_read_digest: d("another committed Read") };
    if (mode === "foreign_question") owner.question_id = randomUUID();
    if (mode !== "ordinary" && !nativeCase) {
      const before = d(state);
      await expect(mapping(owner)).rejects.toThrow(mode === "missing_binding" ? "READ_REVISION_MAPPING_HISTORY_UNSUPPORTED"
        : mode === "foreign_question" ? "READ_SCOPE_QUESTION_MISSING" : mode === "wrong_saved_candidate" ? "READ_REVISION_MAPPING_STALE" : "READ_REVISION_MAPPING_INVOCATION_CHANGED");
      expect(calls).toBe(1); expect(d(state)).toBe(before); return;
    }
    const before = structuredClone(state.generation_recovery);
    if (checkpointCase && mode !== "native_checkpoint") {
      const beforeRead = structuredClone(state.read), beforeQuestions = structuredClone(state.operator_questions);
      await expect(mapping(owner)).rejects.toThrow(mode === "native_checkpoint_commit_drift" ? "READ_REVISION_MAPPING_STALE" : "MAPPING_CHECKPOINT_REFUSED");
      expect(calls).toBe(2); expect(state.read).toEqual(beforeRead); expect(state.operator_questions).toEqual(beforeQuestions);
      expect(state.pending_read_revision_state?.scope_question_id).toBe(current.id); return;
    }
    const result = await mapping(owner);
    if (checkpointCase) { expect(state.pending_read_revision_state).toBeUndefined(); expect(state.pending_read_revision).toBeUndefined(); }
    expect(calls).toBe(2); expect(result.read_scope_predecessor_id).toBe(current.id); expect(result.authority_granted).toBe(false);
    expect(state.read!.assistance_history!.state.call_count).toBe(2);
    expect(state.operator_questions!.find(q => q.id === current.id)).toEqual(current);
    expect(state.operator_questions!.at(-1)?.confirmation).toBeUndefined();
    expect(state.generation_recovery!.operations.slice(0, before!.operations.length)).toEqual(before!.operations);
    expect(history?.state.call_count).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
