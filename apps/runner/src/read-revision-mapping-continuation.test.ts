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
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { createReadRevisionCheckpointHost, type ReadRevisionCheckpointAccess } from "./authoring-read-revision-checkpoint-host.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { readWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { generateModelReadWorkload, type ModelReadWorkloadInput } from "./read-workload-model.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
import { storeReadWorkloadAnalysis, type ReadWorkloadView } from "./read-workloads.js";
import { prepareReadRevisionAnalysis } from "./authoring-read-revision-scope.js";

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
it.each(["ordinary", "changed_model", "changed_task", "changed_provider_destination", "missing_binding", "wrong_saved_candidate", "foreign_question"] as const)("continues only the exact actually committed revision: %s", async mode => {
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
    const mapping = (owner?: { question_id: string } & Record<string, unknown>) => generation(() => generateModelReadWorkload({ name: "labels", allowedQuestions: [owner && mode === "changed_task" ? "Show every person all labels" : job],
      operatorNamingContext: job, provider: owner && mode === "changed_provider_destination" ? "openai_compatible" : "openai", model: owner && mode === "changed_model" ? "other-model" : "controlled",
      ...(owner && mode === "changed_provider_destination" ? { baseUrl: "https://different.example/v1" } : {}), apiKey: "inert-test-key", egressAcknowledged: true,
      deferNarration: true, generatedBoundary: boundary, ...(owner ? { postRevisionMapping: owner } : {}),
      structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => ({ ...scope(), ...(owner ? { native: { ...records(), question_id: owner.question_id } } : {}) }) },
      onCheckpoint: async (cp, current, result, completion) => {
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
    await mapping(); expect(calls).toBe(1); expect(state.read!.assistance_history!.state.call_count).toBe(1);
    const previousAnalysis = stored!, history = structuredClone(state.read!.assistance_history);
    const instruction = "Label the existing item register Customer items; keep all fields and restrictions unchanged.";
    const mutation = await prepareBoundaryResourceReviewMutation(root, { resource_id: "work.items", metadata: { label: "Customer items" },
      actor: "declared fixture operator", reason: instruction }, async () => prepared.inspection);
    const retained = prepareReadRevisionAnalysis({ selected: stored, expected: state.read!, currentBoundary: boundary, preparedCandidate: mutation.candidate });
    expect(retained).toMatchObject({ state: "pending_mapping", reason: "exact_plan_unavailable" });
    await save({ pendingReadRevision: instruction, pendingReadRevisionState: { instruction, provenance: "operator", privacy_only: false } });
    const preview = () => ({ scope: projectAuthoringReadScopePreview({ resume: state, boundary, structuralReview: structural,
      records: records(), preparedCandidate: mutation.candidate, preparedLock: mutation.build.lock }) });
    let locked = false;
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
    expect(revision.read_scope_state).toBe("pending_mapping"); expect(state.pending_read_revision_state?.result_received).toBe(true);
    await commitBoundaryResourceReviewMutation(root, mutation); structural = await loadBoundaryReviewContext(root); boundary = structural.candidate;
    await save({ binding: boundaryAuthoringResumeBinding(structural.bundle), pendingReadRevisionState: { ...state.pending_read_revision_state!, saved_read_digest: explorationBoundaryCandidateDigest(boundary) } });
    const old = state.operator_questions!.find(q => q.id === state.pending_read_revision_state!.scope_question_id)!;
    const current = createReadScopeQuestion({ id: randomUUID(), revision: old.revision + 1, scope_digest: old.scope_digest, context_digest: contextDigest(),
      read_scope: { ...old.read_scope!, predecessor_id: old.id } });
    await save({ operatorQuestions: [...state.operator_questions!, current], pendingReadRevisionState: { ...state.pending_read_revision_state!, scope_question_id: current.id } });
    const disk = await readBoundaryAuthoringResumeState(root, state.binding); expect(disk.status).toBe("ready"); if (disk.status !== "ready") throw new Error("Cold native read failed");
    state = disk.value;
    const owner = { ...records(), read: state.read!, revision: state.pending_read_revision_state!, question_id: current.id, currentBoundary: boundary, priorAnalysis: previousAnalysis };
    if (mode === "missing_binding") {
      const retained = structuredClone(owner.read.assistance_history!); delete retained.state.scope_invocation_binding;
      const { schema_version: _version, digest: _digest, ...body } = retained;
      owner.read = { ...owner.read, assistance_history: readWorkloadAssistanceCheckpoint(body) };
    }
    if (mode === "wrong_saved_candidate") owner.revision = { ...owner.revision, saved_read_digest: d("another committed Read") };
    if (mode === "foreign_question") owner.question_id = randomUUID();
    if (mode !== "ordinary") {
      const before = d(state);
      await expect(mapping(owner)).rejects.toThrow(mode === "missing_binding" ? "READ_REVISION_MAPPING_HISTORY_UNSUPPORTED"
        : mode === "foreign_question" ? "READ_SCOPE_QUESTION_MISSING" : mode === "wrong_saved_candidate" ? "READ_REVISION_MAPPING_STALE" : "READ_REVISION_MAPPING_INVOCATION_CHANGED");
      expect(calls).toBe(1); expect(d(state)).toBe(before); return;
    }
    const before = structuredClone(state.generation_recovery);
    const result = await mapping(owner);
    expect(calls).toBe(2); expect(result.read_scope_predecessor_id).toBe(current.id); expect(result.authority_granted).toBe(false);
    expect(state.read!.assistance_history!.state.call_count).toBe(2);
    expect(state.operator_questions!.find(q => q.id === current.id)).toEqual(current);
    expect(state.operator_questions!.at(-1)?.confirmation).toBeUndefined();
    expect(state.generation_recovery!.operations.slice(0, before!.operations.length)).toEqual(before!.operations);
    expect(history?.state.call_count).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
