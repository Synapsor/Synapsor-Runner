import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBoundaryAuthoringResumeMaterial,
  buildBoundaryAuthoringResumeState,
  consumeBoundaryReadRevisionResult,
  boundaryAuthoringVersionReviews,
  prepareBoundaryActionRevision,
  clearBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume,
  writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding,
} from "./boundary-authoring-resume.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
import { projectReadScopeHostContext } from "./read-current-evidence.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint,
  configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, completedAuthoringQuestion, AskError } from "./model-ask.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "reviewed_staging",
  generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
  schema_fingerprint: `sha256:${"2".repeat(64)}`,
  role_posture_fingerprint: `sha256:${"3".repeat(64)}`,
};

// Existing Read revision public fixture reduced to the declared model-visible catalog.
function ownedReadRevisionDraft(): ExplorationBoundaryDraft {
  return {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
      source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
      trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      generation_lock_fingerprint: binding.generation_lock_fingerprint, role_posture_fingerprint: binding.role_posture_fingerprint,
      pack: { name: binding.boundary_name, resources: [{ id: "public.orders", schema: "public", table: "orders", primary_key: "id",
        tenant_key: "tenant_id", principal_key: "principal_id", field_types: { id: "uuid", tenant_id: "text", principal_id: "text", status: "text" },
        field_enums: {}, selectable_fields: ["id", "status"], filterable_fields: { status: ["eq"] }, sortable_fields: ["status"], groupable_fields: [],
        aggregate_measures: [], aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {},
        kept_out_fields: ["tenant_id", "principal_id"], relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true }] },
      budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    };
}

// Declared status-only purpose and exact disabled privacy preview. No workload
// analysis or scope confirmation is fabricated by this history/CAS fixture.
function ownedReadRevisionScope(draft: ExplorationBoundaryDraft) {
  const originalRequest = "Read order status. Keep order identifiers private. Preserve unrelated access.";
  const context = (candidate: ExplorationBoundaryDraft) => {
    const catalog = readBoundaryRevisionCatalog(candidate);
    return projectReadScopeHostContext({ request: { id: "owned-original-request", text: originalRequest },
      catalog: { digest: catalog.digest, resources: catalog.resources, relationships: [] },
      binding: { meaning_digest: canonicalJsonDigest(originalRequest), applicability_digest: canonicalJsonDigest("owned status job"),
        operation_digest: canonicalJsonDigest(candidate) } });
  };
  const proposal: ReadScopeProposal = { protocol: READ_SCOPE_PROTOCOL, applicability: "read_requested", original_request: "owned-original-request",
    requirements: [{ id: "status", intended_use: "Read order status", references: ["owned-original-request"], disposition: "include", subjects: [{ root_resource: "public.orders", mode: "trusted_principal" }], targets: [
      { root_resource: "public.orders", resource: "public.orders", operation: "resource" },
      { root_resource: "public.orders", resource: "public.orders", operation: "return", field: "status" },
    ] }, { id: "private-id", intended_use: "Keep order identifiers private", references: ["owned-original-request"], disposition: "exclude", subjects: [], targets: [
      { root_resource: "public.orders", resource: "public.orders", operation: "return", field: "id" },
    ] }] };
  return { proposal, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => context(draft) },
    validateRevision: async () => {
      const preview = structuredClone(draft);
      preview.pack.resources[0]!.selectable_fields = ["status"];
      return { scope: context(preview) };
    } };
}

describe("Boundary authoring resume state", () => {
  it("records a parsed Read revision result with its exact dispatch as inert history and reopens without replay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-consumed-history-"));
    const instruction = "Keep order identifiers private. Preserve unrelated access.";
    const draft = ownedReadRevisionDraft();
    const typed = ownedReadRevisionScope(draft);
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read order status.",
      provider: "openai" as const, model: "offline-test", pendingReadRevision: instruction };
    let request: NonNullable<Parameters<typeof buildBoundaryAuthoringResumeState>[0]["pendingReadRevisionState"]> = {
      instruction, provenance: "operator", privacy_only: true,
    };
    let saved = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: request });
    let calls = 0, consumed = 0;
    try {
      await writeBoundaryAuthoringResumeState(root, saved, { expectedRevisionDigest: null });
      const result = await generateModelReadBoundaryRevision({ instruction, provider: "openai", model: "offline-test", apiKey: "OWNED-key",
        boundary: draft, egressAcknowledged: true, privacyOnly: true, structuredScope: typed.structuredScope, validateRevision: typed.validateRevision,
        dependencies: { requestJson: async () => { calls++; return { status: 200, body: { output: [{ type: "function_call",
          call_id: "owned_read_result", name: "runner__submit_read_boundary_revision",
          arguments: JSON.stringify({ read_scope: typed.proposal, resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] }) }] } }; } },
        onCheckpoint: async (checkpoint, _current, accepted) => {
          if (checkpoint) request = { ...request, checkpoint };
          else {
            expect(accepted?.changes).toEqual([expect.objectContaining({ resource: "public.orders", field: "id", after: "runner_only" })]);
            consumed++;
            request = consumeBoundaryReadRevisionResult(request);
          }
          const next = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: request, previous: saved });
          await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: saved.revision_digest }); saved = next;
        },
      });
      expect(result).toMatchObject({ authority_granted: false, source_database_changed: false });
      expect(calls).toBe(1); expect(consumed).toBe(1);
      expect(saved.pending_read_revision_state).not.toHaveProperty("checkpoint");
      expect(saved.pending_read_revision_state).toMatchObject({ result_received: true,
        checkpoint_history: { stage: "dispatching", state: { call_count: 1, correction_used: false } } });
      const reopened = await readBoundaryAuthoringResumeState(root, binding);
      expect(reopened).toEqual({ status: "ready", value: saved });
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: saved }).pending_read_revision_state).toEqual(saved.pending_read_revision_state);
      expect(saved.pending_read_revision_state).not.toHaveProperty("saved_read_digest");
      expect(saved.completed_policy_reviews).toBeUndefined(); expect(saved.authority_granted).toBe(false);
      expect(calls).toBe(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains an interrupted Read edit input without recording a consumed result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-dispatch-state-"));
    const instruction = "Keep units private and preserve unrelated access.";
    const checkpoint = readBoundaryRevisionCheckpoint({ stage: "dispatching", dispatch_question: instruction,
      input_digest: canonicalJsonDigest("exact input"), boundary_digest: canonicalJsonDigest(binding),
      catalog_digest: canonicalJsonDigest("exact catalog"), tool_digest: canonicalJsonDigest("exact tools"),
      state: { call_count: 2, correction_used: true, prerequisite_review_failed: false, issue: "",
        clarification_count: 0, clarification_answers: [], private_decisions: [] } });
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read the register.", provider: "openai" as const,
      model: "test", pendingReadRevision: instruction };
    const request = { instruction, provenance: "operator" as const, privacy_only: true, checkpoint };
    try {
      const saved = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: request });
      await writeBoundaryAuthoringResumeState(root, saved, { expectedRevisionDigest: null });
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: saved });
      expect(saved.pending_read_revision_state).toEqual(request);
      expect(saved.pending_read_revision_state).not.toHaveProperty("result_received");
      expect(saved.completed_policy_reviews).toBeUndefined();
      expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: { ...request, result_received: true } }))
        .toThrow("unfinished Read question or dispatch");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains native answered Read history, exact counters and CAS without acknowledging another result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-native-history-"));
    const instruction = "Use the operator's exact term and preserve unrelated access.";
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read order status.", provider: "openai" as const,
      model: "offline-test", pendingReadRevision: instruction };
    let current = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: { instruction, provenance: "operator", privacy_only: false } });
    try {
      await writeBoundaryAuthoringResumeState(root, current, { expectedRevisionDigest: null });
      await withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => current.generation_recovery,
          current: async () => canonicalJsonDigest(binding), write: async recovery => {
            const next = buildBoundaryAuthoringResumeState({ ...input, previous: current, generationRecovery: recovery });
            await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: current.revision_digest }); current = next;
          } });
        const tools = [{ name: "runner.inspect", description: "OWNED OFFLINE", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
        const authorityDigest = askToolSurfaceDigest(tools);
        const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "offline-test", api_key: "OWNED-key",
          authority_digest: authorityDigest, egress_acknowledged: true }, {}, new Date());
        const question = "What business term should identify the order's progress?";
        const result = await runAskProviderTurn({ configuration, question, history: [], tools, authorityDigest, signal: new AbortController().signal,
          gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async () => { throw new Error("No callback allowed"); } },
          dependencies: { requestJson: async () => ({ status: 200, body: { status: "completed", output: [{ type: "message",
            content: [{ type: "output_text", text: question }] }] } }) } });
        const completion = completedAuthoringQuestion(result);
        if (!completion) throw new Error("Expected the actual native question completion.");
        const cp = readBoundaryRevisionCheckpoint({ stage: "waiting", input_digest: canonicalJsonDigest(instruction),
          boundary_digest: canonicalJsonDigest(binding), catalog_digest: canonicalJsonDigest("declared current catalog"), tool_digest: authorityDigest,
          pending_question: { kind: "clarification", request: { question, reason: "The operator's preferred term is missing." }, question, completion },
          state: { call_count: 1, correction_used: false, prerequisite_review_failed: false, issue: "", clarification_count: 0,
            clarification_answers: [], private_decisions: [] } });
        if (cp.stage !== "waiting" || cp.pending_question.kind !== "clarification") throw new Error("Expected the actual waiting question.");
        const handoff = createOwnerHandoff({ consumer: "read_revision_clarification", scope_digest: cp.input_digest,
          context_digest: cp.boundary_digest, question, completion });
        const waiting = buildBoundaryAuthoringResumeState({ ...input, previous: current, ownerHandoffs: [handoff],
          generationRecovery: authoringQuestionCheckpoint(current.generation_recovery, ownerHandoffCheckpoint(handoff)),
          pendingReadRevisionState: { instruction, provenance: "operator", privacy_only: false, checkpoint: cp } });
        await writeBoundaryAuthoringResumeState(root, waiting, { expectedRevisionDigest: current.revision_digest }); current = waiting;
        const answer = "Order progress";
        const answered = answerOwnerHandoff(handoff, answer, handoff.context_digest);
        const generation = authoringQuestionAnswerCheckpoint(current.generation_recovery, ownerHandoffCheckpoint(handoff),
          { digest: canonicalJsonDigest(answered), operator_messages: [answer] });
        const { digest: _digest, ...body } = cp;
        const decided = readBoundaryRevisionCheckpoint({ ...body, stage: "decided", pending_question: { ...cp.pending_question,
          decision: { state: "answered", answer } }, state: { ...cp.state, clarification_count: 1, clarification_answers: [{ question, answer }] } });
        if (decided.stage !== "decided" || decided.pending_question.kind !== "clarification") throw new Error("Expected the native answered fixture.");
        const { digest: _decidedDigest, pending_question, ...dispatchBody } = decided;
        const dispatch = readBoundaryRevisionCheckpoint({ ...dispatchBody, stage: "dispatching", dispatch_question: "Apply the reviewed exact business term.",
          previous_question: { stage: "decided", pending_question }, state: { ...decided.state, call_count: 2, correction_used: true } });
        if (dispatch.stage !== "dispatching") throw new Error("Expected the exact dispatched producer input.");
        const pending = { instruction, provenance: "operator" as const, privacy_only: false, checkpoint: dispatch };
        const request = consumeBoundaryReadRevisionResult(pending);
        expect(request.checkpoint_history).toEqual(dispatch);
        expect(pending.checkpoint).toEqual(dispatch); expect(pending).not.toHaveProperty("result_received");
        const consumed = buildBoundaryAuthoringResumeState({ ...input, previous: current, ownerHandoffs: [answered], generationRecovery: generation,
          pendingReadRevisionState: request });
        expect(consumed.generation_recovery).toEqual(generation);
        expect(consumed.owner_handoffs).toEqual([answered]);
        expect(consumed.pending_read_revision_state?.checkpoint_history).toEqual(dispatch);
        expect(consumed.pending_read_revision_state).not.toHaveProperty("checkpoint");
        await writeBoundaryAuthoringResumeState(root, consumed, { expectedRevisionDigest: current.revision_digest });
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: consumed });
        await expect(writeBoundaryAuthoringResumeState(root, consumed, { expectedRevisionDigest: current.revision_digest })).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: consumed });
        const altered = readBoundaryRevisionCheckpoint({ ...dispatchBody, stage: "dispatching", dispatch_question: dispatch.dispatch_question,
          previous_question: { stage: "decided", pending_question: { ...pending_question, decision: { state: "answered", answer: "Invented progress" } } },
          state: { ...dispatch.state, clarification_answers: [{ question, answer: "Invented progress" }] } });
        expect(() => buildBoundaryAuthoringResumeState({ ...input, previous: consumed, pendingReadRevisionState: { ...request, checkpoint_history: altered } }))
          .toThrow("attributable answer");
        const changedCompletion = readBoundaryRevisionCheckpoint({ ...dispatchBody, stage: "dispatching", dispatch_question: dispatch.dispatch_question,
          previous_question: { stage: "decided", pending_question: { ...pending_question,
            completion: { ...completion, response_digest: canonicalJsonDigest("unowned response") } } }, state: dispatch.state });
        expect(() => buildBoundaryAuthoringResumeState({ ...input, previous: consumed, pendingReadRevisionState: { ...request, checkpoint_history: changedCompletion } }))
          .toThrow("matching owner-question handoff");
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["cancelled", "malformed", "stale", "late"] as const)("keeps %s Read results unconsumed through the native producer", async failure => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-result-refusal-"));
    const instruction = "Keep order identifiers private. Preserve unrelated access.", draft = ownedReadRevisionDraft();
    const typed = ownedReadRevisionScope(draft);
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read order status.", provider: "openai" as const,
      model: "offline-test", pendingReadRevision: instruction };
    let request: NonNullable<Parameters<typeof buildBoundaryAuthoringResumeState>[0]["pendingReadRevisionState"]> = {
      instruction, provenance: "operator", privacy_only: true };
    let current = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: request });
    let context = canonicalJsonDigest(binding), acceptedResults = 0, calls = 0;
    try {
      await writeBoundaryAuthoringResumeState(root, current, { expectedRevisionDigest: null });
      await withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => current.generation_recovery, current: async () => context,
          write: async recovery => withProjectAuthorityMutation(root, async permit => {
            const next = buildBoundaryAuthoringResumeState({ ...input, previous: current, pendingReadRevisionState: request, generationRecovery: recovery });
            await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: current.revision_digest, permit }); current = next;
          }) });
        const attempt = generateModelReadBoundaryRevision({ instruction, provider: "openai", model: "offline-test", apiKey: "OWNED-key",
          boundary: draft, egressAcknowledged: true, privacyOnly: true, structuredScope: typed.structuredScope, validateRevision: typed.validateRevision,
          dependencies: { requestJson: async () => {
            calls++;
            if (failure === "cancelled") throw new AskError("ASK_CANCELLED", "The owned fixture stopped without a response.", 499);
            if (failure === "late") context = canonicalJsonDigest("changed business context before response acceptance");
            return { status: 200, body: { output: [{ type: "function_call", call_id: `owned_read_result_${calls}`,
              name: "runner__submit_read_boundary_revision", arguments: failure === "malformed" ? "{" : JSON.stringify({
                read_scope: typed.proposal, resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "id", exposure: "runner_only" }] }] }) }] } };
          } },
          onCheckpoint: async (checkpoint, _draft, accepted) => withProjectAuthorityMutation(root, async permit => {
            if (!checkpoint) {
              if (!accepted) throw new Error("An accepted callback must contain its parsed result.");
              acceptedResults++; request = consumeBoundaryReadRevisionResult(request);
            } else request = { ...request, checkpoint };
            const next = buildBoundaryAuthoringResumeState({ ...input, previous: current, pendingReadRevisionState: request });
            await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: current.revision_digest, permit }); current = next;
            if (failure === "stale") draft.pack.resources[0]!.selectable_fields = ["status"];
          }),
        });
        await expect(attempt).rejects.toMatchObject({ code: failure === "malformed" ? "ASK_TOOL_ARGUMENTS_INVALID"
          : failure === "late" ? "ASK_GENERATION_CONTEXT_CHANGED" : failure === "stale" ? "ASK_AUTHORITY_CHANGED" : "ASK_CANCELLED" });
      });
      expect(acceptedResults).toBe(0);
      expect(current.pending_read_revision_state).not.toHaveProperty("result_received");
      expect(current.pending_read_revision_state).not.toHaveProperty("checkpoint_history");
      expect(current.pending_read_revision_state?.checkpoint).toMatchObject({ stage: "dispatching" });
      if (failure !== "stale") expect(current.generation_recovery?.operations.length).toBeGreaterThan(0);
      expect(current.generation_recovery?.operations.every(operation => operation.state !== "checkpointed" && !operation.checkpoint_seen)).not.toBe(false);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: current });
      // The existing required-tool path permits one bounded correction for a
      // complete malformed reply. Neither reply becomes a consumed revision.
      expect(calls).toBe(failure === "stale" ? 0 : failure === "malformed" ? 2 : 1);
      expect(current.authority_granted).toBe(false); expect(current.source_database_changed).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("refuses pending or malformed Read history and never promotes a result disposition twice", () => {
    const instruction = "Keep order identifiers private.";
    const request = { instruction, provenance: "operator" as const, privacy_only: true };
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read orders.", provider: "openai" as const, model: "offline-test", pendingReadRevision: instruction };
    const base = { input_digest: canonicalJsonDigest(instruction), boundary_digest: canonicalJsonDigest(binding),
      catalog_digest: canonicalJsonDigest("catalog"), tool_digest: canonicalJsonDigest("tool"),
      state: { call_count: 1, correction_used: false, prerequisite_review_failed: false, issue: "", clarification_count: 0,
        clarification_answers: [], private_decisions: [] } };
    const waiting = readBoundaryRevisionCheckpoint({ ...base, stage: "waiting", pending_question: { kind: "clarification",
      request: { question: "Which identifiers?", reason: "Missing scope." }, question: "Which identifiers?" } });
    if (waiting.stage !== "waiting") throw new Error("Expected the waiting storage fixture.");
    expect(() => consumeBoundaryReadRevisionResult({ ...request, checkpoint: waiting })).toThrow("unanswered Read question");
    const dispatch = readBoundaryRevisionCheckpoint({ ...base, stage: "dispatching", dispatch_question: instruction });
    const consumed = consumeBoundaryReadRevisionResult({ ...request, checkpoint: dispatch });
    expect(() => consumeBoundaryReadRevisionResult(consumed)).toThrow("already has a recorded result disposition");
    expect(() => consumeBoundaryReadRevisionResult({ ...request, terminal_reason: "READ_BOUNDARY_REVISION_NOT_SUBMITTED" })).toThrow("recorded result disposition");
    for (const state of [
      { ...request, checkpoint_history: dispatch },
      { ...consumed, checkpoint: dispatch },
      { ...consumed, checkpoint_history: waiting },
      { ...consumed, checkpoint_history: { ...dispatch, digest: canonicalJsonDigest("not this snapshot") } },
      { ...consumed, checkpoint_history: { ...dispatch, save: true } },
    ]) expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: state as any })).toThrow();
    const awaiting = readBoundaryRevisionCheckpoint({ ...base, stage: "dispatching", dispatch_question: instruction,
      previous_question: { stage: "waiting", pending_question: waiting.pending_question } });
    expect(() => consumeBoundaryReadRevisionResult({ ...request, checkpoint: awaiting })).toThrow("unanswered Read question");
    const privateIdentity = readBoundaryRevisionCheckpoint({ ...base, stage: "dispatching", dispatch_question: "Tenant is actual-tenant-42." });
    expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: {
      ...consumed, checkpoint_history: privateIdentity } })).toThrow("TRUSTED_IDENTITY_BLOCKED");
    expect(buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: consumed }).completed_policy_reviews).toBeUndefined();
  });
  it("retains exact Read revision mode and consumed-unsaved disposition without granting replay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-revision-state-"));
    const instruction = "Keep units private.\nPreserve all labels and unrelated access.";
    const input = { binding, stage: "authority_review" as const, jobIntent: "Read the current register.", provider: "openai" as const, model: "test", pendingReadRevision: instruction };
    const request = { instruction, provenance: "guided" as const, privacy_only: true, interpretation_instruction: "Only units must stay private.", result_received: true as const };
    try {
      const first = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: request });
      await writeBoundaryAuthoringResumeState(root, first);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: first });
      expect(first.pending_read_revision).toBe(instruction);
      expect(first.pending_read_revision_state).toEqual(request);
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: first }).pending_read_revision_state).toEqual(request);
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: first, pendingReadRevisionState: null }).pending_read_revision_state).toBeUndefined();
      expect(first.generation_recovery).toBeUndefined();
      expect(first.completed_policy_reviews).toBeUndefined();
      for (const changed of [{ ...request, instruction: "Another edit." }, { ...request, result_received: false }, { ...request, privacy_only: null },
        { ...request, approve: true }, { ...request, vocabulary_only: false }, { ...request, checkpoint: null },
        { ...request, terminal_reason: "READ_BOUNDARY_REVISION_NOT_SUBMITTED" }, { ...request, terminal_reason: "ASK_GENERATION_OUTCOME_UNKNOWN" },
        { ...request, saved_read_digest: "wrong" }, { ...request, result_received: undefined, saved_read_digest: canonicalJsonDigest("saved Read") }]) {
        expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: changed as any })).toThrow();
      }
      const terminal = { instruction, provenance: "guided" as const, privacy_only: true,
        terminal_reason: "READ_BOUNDARY_REVISION_NOT_SUBMITTED" as const };
      const exhausted = buildBoundaryAuthoringResumeState({ ...input, previous: first, pendingReadRevisionState: terminal });
      await writeBoundaryAuthoringResumeState(root, exhausted, { expectedRevisionDigest: first.revision_digest });
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: exhausted });
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: exhausted }).pending_read_revision_state).toEqual(terminal);
      const recorded = { ...request, saved_read_digest: canonicalJsonDigest("actual recorded commit") };
      const saved = buildBoundaryAuthoringResumeState({ ...input, pendingReadRevisionState: recorded });
      expect(saved.pending_read_revision_state).toEqual(recorded);
      expect(saved.completed_policy_reviews).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains prior pending review contexts as bounded history, never completions", async () => {
    const context = { source_session: "c9cfd018-ec47-4418-b06f-c21b2e6cba90", source_digest: canonicalJsonDigest("prior source"),
      read_digest: canonicalJsonDigest("prior Read"), action_name: "saved_rules", action_digest: canonicalJsonDigest("prior Action") };
    const request = { operation: "review_rules" as const, request: "Recheck the current disabled candidate.", ...context,
      read_digest: canonicalJsonDigest("current Read"), prior_contexts: [context] };
    const input = { binding, stage: "authority_review" as const, jobIntent: "Retain the saved job.", provider: "openai" as const, model: "test" };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prior-review-context-"));
    try {
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingPolicyReview: request });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.completed_policy_reviews).toBeUndefined();
      const rechecked = buildBoundaryAuthoringResumeState({ ...input, previous: state });
      expect(rechecked.pending_policy_review!.prior_contexts).toEqual([context]);
      for (const prior_contexts of [[], Array(17).fill(context), [{...context, success: true}], [{...context, action_digest: "bad"}]]) {
        expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingPolicyReview: { ...request, prior_contexts } as any })).toThrow(/BOUNDARY_AUTHORING_RESUME_INVALID|digest/);
      }
    } finally { await fs.rm(root, {recursive: true, force: true}); }
  });

  it("persists one unfinished Read relationship across recheck and clears it only explicitly or for another job", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'read-relationship-resume-'));
    const input={binding,stage:'read_mapping' as const,jobIntent:'Read the related reference.',provider:'openai' as const,model:'test'};
    try {
      const first=buildBoundaryAuthoringResumeState({...input,pendingReadRelationship:{resource:'work.items'}});
      await writeBoundaryAuthoringResumeState(root,first);
      expect(await readBoundaryAuthoringResumeState(root,binding)).toEqual({status:'ready',value:first});
      const rechecked=buildBoundaryAuthoringResumeState({...input,previous:first});
      expect(rechecked.pending_read_relationship).toEqual(first.pending_read_relationship);
      expect(revalidateBoundaryAuthoringResume(first,{...binding,schema_fingerprint:canonicalJsonDigest('new inspected metadata')}).pending_read_relationship).toEqual(first.pending_read_relationship);
      expect(buildBoundaryAuthoringResumeState({...input,previous:first,pendingReadRelationship:null}).pending_read_relationship).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({...input,previous:first,jobIntent:'A distinct job.'}).pending_read_relationship).toBeUndefined();
      for(const resource of ['', 'x'.repeat(257), 'a\nb']) expect(()=>buildBoundaryAuthoringResumeState({...input,pendingReadRelationship:{resource}})).toThrow('BOUNDARY_AUTHORING_RESUME_INVALID');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it("does not transfer generated-repair provenance into a genuine owner edit with the same words", () => {
    const request = { outcome: "work.finish", instruction: "Review the existing effect.", baseline_digest: canonicalJsonDigest("exact draft") };
    const generated = { ...request, coverage_repair: { source_digest: canonicalJsonDigest("source"),
      report_digest: canonicalJsonDigest("coverage"), source_ranges: [{ start: 1, end: 1 }] },
      checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: canonicalJsonDigest("intent"), context_digest: canonicalJsonDigest("context"), components: {} }) };
    expect(prepareBoundaryActionRevision({ ...request, coverage_repair: generated.coverage_repair }, generated)).toEqual(generated);
    const owner = prepareBoundaryActionRevision(request, generated);
    expect(owner).toEqual(request);
    expect(owner.coverage_repair).toBeUndefined();
    expect(owner.checkpoint).toBeUndefined();
  });
  it("retains scoped business decisions through rewrite, restart and rescan without upgrading history or consent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-decision-resume-"));
    try {
      const conversation = [{ kind: "clarification" as const, question: "Earlier ambiguous question?", answer: "Earlier unscoped business answer." }];
      const input = { binding, stage: "authority_review" as const, jobIntent: "Inspect equipment and close a visit; a separate automatic limit is unanswered.",
        provider: "openai" as const, model: "gpt-test", conversation };
      const records = [{ decision_id: canonicalJsonDigest("host exact scope"), applicability_digest: canonicalJsonDigest("host relevant meaning and fields"),
        question: "For this workflow, is the reviewed register authoritative?", answer: "The operator confirms its business ownership." }];
      const action = { intent: "Schedule follow-up; automatic limit remains unanswered.", intents: ["Close a visit.", "Schedule follow-up; automatic limit remains unanswered."],
        completed_outcomes: ["operations.close_visit"], checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: canonicalJsonDigest("unfinished intent"),
          context_digest: canonicalJsonDigest("old proof"), components: {}, operator_messages: ["Business limit remains unanswered."] }) };
      const original = buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: records, action,
        privateReadMetadataDigest: canonicalJsonDigest("old consent") });
      let state = original;
      let savedRevision: `sha256:${string}` | null = null;
      for (const stage of ["planning", "read_mapping", "action_drafting", "authority_review"] as const) {
        state = buildBoundaryAuthoringResumeState({ ...input, stage, previous: state });
        expect(state.read_prerequisite_decisions).toEqual(records);
        expect(state.action).toEqual(action);
        expect(state.conversation).toEqual(conversation);
        await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: savedRevision });
        savedRevision = state.revision_digest;
        expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      }
      const revalidated = revalidateBoundaryAuthoringResume(original, { ...binding, role_posture_fingerprint: canonicalJsonDigest("fresh writer role") });
      expect(revalidated.read_prerequisite_decisions).toEqual(records);
      expect(revalidated.private_read_metadata_digest).toBeUndefined();
      expect(revalidated.authority_granted).toBe(false);
      expect(revalidated.action).toEqual(action);
      expect(buildBoundaryAuthoringResumeState(input).read_prerequisite_decisions).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes omission, explicit replacement, explicit clear and another Boundary for scoped records", () => {
    const input = { binding, stage: "authority_review" as const, jobIntent: "Review the complete saved job.", provider: "openai" as const, model: "gpt-test" };
    const record = { decision_id: canonicalJsonDigest("decision"), applicability_digest: canonicalJsonDigest("applicability"), question: "Reviewed meaning?", answer: "Original answer." };
    const previous = buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: [record] });
    const replaced = { ...record, applicability_digest: canonicalJsonDigest("explicit revised meaning"), answer: "Explicit new answer." };
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, readPrerequisiteDecisions: [replaced] }).read_prerequisite_decisions).toEqual([replaced]);
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, readPrerequisiteDecisions: [] }).read_prerequisite_decisions).toBeUndefined();
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, binding: { ...binding, boundary_name: "other" } }).read_prerequisite_decisions).toBeUndefined();
    const edited = buildBoundaryAuthoringResumeState({ ...input, previous, jobIntent: "Explicitly edited job; retained answers are context until applicability is checked." });
    expect(edited.read_prerequisite_decisions).toEqual([record]);
    expect(previous.read_prerequisite_decisions).toEqual([record]);
    expect(() => buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: [record, replaced] })).toThrow("duplicate decision");
    expect(() => revalidateBoundaryAuthoringResume({ ...previous, read_prerequisite_decisions: [replaced] }, binding)).toThrow("digest");
  });

  it("retains two host counter confirmations after a no-op edit, restart and metadata rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counter-review-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Exchange the assignment and consume the selected offer atomically.",
        provider: "openai" as const, model: "gpt-test" };
      const reviews = ["operations.assignments", "operations.offers"].map((resource, i) => ({ resource, field: "counter",
        maintenance: "all_writers_increment" as const, proof_digest: `sha256:${String(i + 4).repeat(64)}` as const }));
      const checkpoint = actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: `sha256:${"6".repeat(64)}`,
        context_digest: `sha256:${"7".repeat(64)}`, components: {}, reviewed_version_fields: reviews });
      const old = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: { outcome: "operations.exchange",
        instruction: "Confirm the existing operating prerequisites.", baseline_digest: `sha256:${"8".repeat(64)}`, checkpoint } });
      expect(boundaryAuthoringVersionReviews(old)).toEqual(reviews);
      const completed = buildBoundaryAuthoringResumeState({ ...input, previous: old });
      expect(completed.pending_action_revision).toBeUndefined();
      expect(completed.reviewed_version_fields).toEqual(reviews);
      await writeBoundaryAuthoringResumeState(root, completed);
      const loaded = await readBoundaryAuthoringResumeState(root, binding);
      expect(loaded).toEqual({ status: "ready", value: completed });
      const refreshed = revalidateBoundaryAuthoringResume(old, { ...binding, schema_fingerprint: `sha256:${"9".repeat(64)}` });
      expect(refreshed.pending_action_revision?.checkpoint).toBeUndefined();
      expect(boundaryAuthoringVersionReviews(refreshed)).toEqual(reviews);
      expect(refreshed.authority_granted).toBe(false);
      expect(refreshed.source_database_changed).toBe(false);
      expect(() => boundaryAuthoringVersionReviews({ ...completed,
        reviewed_version_fields: [{ ...reviews[0]!, field: "other_counter" }] })).toThrow("digest");
      expect(buildBoundaryAuthoringResumeState({ ...input, jobIntent: "A different job.", previous: completed })
        .reviewed_version_fields).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, binding: { ...binding, boundary_name: "other" }, previous: completed })
        .reviewed_version_fields).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [], previous: completed })
        .reviewed_version_fields).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("keeps the latest host confirmation instead of an older component checkpoint", () => {
    const older = { resource: "operations.records", field: "v1", maintenance: "all_writers_increment" as const,
      proof_digest: `sha256:${"a".repeat(64)}` as const };
    const latest = { ...older, field: "v2", proof_digest: `sha256:${"b".repeat(64)}` as const };
    const input = { binding, stage: "authority_review" as const, jobIntent: "Change a record.", provider: "openai" as const, model: "gpt-test" };
    const state = buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [latest], action: { intent: input.jobIntent,
      checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: `sha256:${"c".repeat(64)}`, context_digest: `sha256:${"d".repeat(64)}`,
        components: {}, reviewed_version_fields: [older] }) } });
    expect(boundaryAuthoringVersionReviews(state)).toEqual([latest]);
    const records = Array.from({ length: 32 }, (_, i) => ({ ...latest, resource: `operations.record_${i}` }));
    expect(buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: records }).reviewed_version_fields).toEqual(records);
    expect(() => buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [...records, older] })).toThrow("CHECKPOINT_INVALID");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [older, latest] })).toThrow("CHECKPOINT_INVALID");
  });
  it.each([true, false])("preserves an omitted unfinished agenda on rewrite, clear and rescan (components %s)", async (components) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-partial-job-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Inspect assets, close a visit, and schedule follow-up when its limits are provided.",
        provider: "openai" as const, model: "gpt-test" };
      const action = { intent: "Inspect an asset.", intents: ["Inspect an asset.", "Close a visit.", "Schedule a follow-up; automatic limits remain unanswered."],
        outcome: "operations.close_visit", completed_outcomes: ["operations.inspect_asset", "operations.close_visit"], strategy: "rule_derived" as const,
        ...(components ? { checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: `sha256:${"4".repeat(64)}`,
          context_digest: `sha256:${"5".repeat(64)}`, components: { verification: { name: "private_facts", resources: [] } },
          operator_messages: ["The business owner has not supplied the automatic limit. Keep it pending."] }) } : {}),
      };
      let state = buildBoundaryAuthoringResumeState({ ...input, action });
      let savedRevision: `sha256:${string}` | null = null;
      for (const stage of ["planning", "read_mapping", "action_drafting", "authority_review"] as const) {
        state = buildBoundaryAuthoringResumeState({ ...input, stage, previous: state });
        expect(state.action).toEqual(action);
        await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: savedRevision });
        savedRevision = state.revision_digest;
        expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      }
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"6".repeat(64)}` }).action).toEqual(action);
      const complete = buildBoundaryAuthoringResumeState({ ...input, previous: state,
        action: { ...action, checkpoint: undefined, completed_outcomes: [...action.completed_outcomes, "operations.followup"] } });
      await writeBoundaryAuthoringResumeState(root, complete, { expectedRevisionDigest: state.revision_digest });
      expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: complete });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains an unclassified edit separately from the job through resume and rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-job-edit-resume-"));
    try {
      const input = { binding, stage: "planning" as const, jobIntent: "Review visits and complete approved follow-ups.",
        provider: "openai" as const, model: "gpt-test", intendedClient: "claude-code" as const };
      const pendingJobRevision = "Keep internal identifiers private and reduce automatic approval to one per day.";
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingJobRevision });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      const refreshed = revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"f".repeat(64)}` });
      expect(refreshed).toMatchObject({ job_intent: input.jobIntent, pending_job_revision: pendingJobRevision, intended_client: "claude-code" });
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_job_revision: "A different edit" }, binding)).toThrow("digest");
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).pending_job_revision).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains only a bound custom destination fingerprint and drops it on revalidation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-custom-destination-resume-"));
    try {
      const input = { binding, stage: "planning" as const, jobIntent: "Review records.", provider: "openai_compatible" as const, model: "local" };
      const metadataDestinationDigest = `sha256:${"d".repeat(64)}` as const;
      const state = buildBoundaryAuthoringResumeState({ ...input, metadataDestinationDigest });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(() => revalidateBoundaryAuthoringResume({ ...state, metadata_destination_digest: `sha256:${"e".repeat(64)}` }, binding)).toThrow("digest");
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"f".repeat(64)}` }).metadata_destination_digest).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).metadata_destination_digest).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain("http");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("binds private Read metadata permission to the saved mapping and discards it on rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-private-read-consent-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Require current admission.", provider: "openai" as const, model: "gpt-test" };
      const privateReadMetadataDigest = `sha256:${"a".repeat(64)}` as const;
      const state = buildBoundaryAuthoringResumeState({ ...input, privateReadMetadataDigest });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.private_read_metadata_digest).toBe(privateReadMetadataDigest);
      expect(() => revalidateBoundaryAuthoringResume({ ...state, private_read_metadata_digest: `sha256:${"b".repeat(64)}` }, binding)).toThrow("digest");
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"c".repeat(64)}` })
        .private_read_metadata_digest).toBeUndefined();
      expect(() => buildBoundaryAuthoringResumeState({ ...input, privateReadMetadataDigest: "unbound" as never })).toThrow("private Read metadata permission");
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).private_read_metadata_digest).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("saves an in-progress policy edit separately from initial action drafting and drops stale components on rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-revision-resume-"));
    try {
      const pendingActionRevision = { outcome: "university.accept_offer", instruction: "Require current admission without changing the other rules.",
        baseline_digest: `sha256:${"4".repeat(64)}` as const,
        checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: `sha256:${"5".repeat(64)}`,
          context_digest: `sha256:${"6".repeat(64)}`, components: {}, operator_messages: ["Save pending"] }),
      };
      const input = { binding, stage: "authority_review" as const, jobIntent: "Help students with registration.", provider: "openai" as const, model: "gpt-5.6-terra" };
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision, intendedClient: "claude-code" });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.pending_action_revision).toEqual(pendingActionRevision);
      expect(prepareBoundaryActionRevision(pendingActionRevision, pendingActionRevision)).toEqual(pendingActionRevision);
      const newInstruction = "Map the reviewed admission source; preserve existing limits.";
      expect(prepareBoundaryActionRevision({ ...pendingActionRevision, instruction: newInstruction }, pendingActionRevision))
        .toEqual({ outcome: pendingActionRevision.outcome, baseline_digest: pendingActionRevision.baseline_digest, instruction: newInstruction });
      expect(() => prepareBoundaryActionRevision({ ...pendingActionRevision, outcome: "university.other" }, pendingActionRevision))
        .toThrow("ACTION_REVISION_BASELINE_CHANGED");
      expect(() => prepareBoundaryActionRevision({ ...pendingActionRevision, baseline_digest: `sha256:${"f".repeat(64)}` }, pendingActionRevision))
        .toThrow("ACTION_REVISION_BASELINE_CHANGED");
      expect(state.action?.checkpoint).toBeUndefined();
      expect(state.authority_granted).toBe(false);
      const refreshed = revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"7".repeat(64)}` });
      expect(refreshed.pending_action_revision).toEqual({ ...pendingActionRevision, checkpoint: undefined });
      expect(refreshed.intended_client).toBe("claude-code");
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_revision: { ...pendingActionRevision,
        outcome: "university.other" } }, binding)).toThrow("digest");
      expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: {
        ...pendingActionRevision, baseline_digest: "unbound" as never,
      } })).toThrow();
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).pending_action_revision).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("binds pending removal to the exact replacement instead of just a missing outcome name", () => {
    const input = { binding, stage: "authority_review" as const, jobIntent: "Stop offering the obsolete action.", provider: "openai" as const, model: "gpt-test" };
    const pendingActionRemoval = { outcome: "clinic.obsolete", authority_name: "clinic_rules", draft_digest: `sha256:${"4".repeat(64)}` as const };
    const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRemoval });
    expect(state.pending_action_removal).toEqual(pendingActionRemoval);
    expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_removal: { ...pendingActionRemoval,
      draft_digest: `sha256:${"5".repeat(64)}` } }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRemoval: "clinic.obsolete" as never })).toThrow("removal review");
  });
  it("preserves exact operator provenance through revision save and invalidates a changed statement checkpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-repair-provenance-"));
    try {
      const revision = { outcome: "gym.freeze", instruction: "Generated repair diagnostic.",
        operator_statements: ["Original policy:\n\nKeep the cap per organization.\n", "Keep the existing reviewer."],
        baseline_digest: `sha256:${"4".repeat(64)}` as const,
        checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: `sha256:${"5".repeat(64)}`,
          context_digest: `sha256:${"6".repeat(64)}`, components: {}, operator_messages: [] }),
      };
      const input = { binding, stage: "authority_review" as const, jobIntent: "Apply the original policy.", provider: "openai" as const, model: "gpt-test" };
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: revision });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.pending_action_revision?.operator_statements).toEqual(revision.operator_statements);
      const changed = prepareBoundaryActionRevision({ ...revision, operator_statements: ["A different accepted policy."] }, revision);
      expect(changed.checkpoint).toBeUndefined();
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_revision: changed }, binding)).toThrow("digest");
      for (const statement of ["tenant_id = acme-corp", "Use postgres://operator:secret@db.example/app"]) {
        expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: { ...revision, operator_statements: [statement] } })).toThrow(/BLOCKED/u);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains a cited missing Action request and its exact existing identities through rescan", () => {
    const input = { binding, stage: "planning" as const, jobIntent: "Help admitted students manage enrollment.",
      provider: "openai" as const, model: "gpt-test" };
    const pendingActionAddition = {
      policy_source_digest: `sha256:${"a".repeat(64)}` as const,
      source_ranges: [{ start: 12, end: 14 }, { start: 28, end: 28 }],
      retained_action: {
        intent: "Update an eligible enrollment.",
        intents: ["Update an eligible enrollment.", "Record an approved withdrawal."],
        completed_outcomes: ["university.update_enrollment", "university.record_withdrawal"],
        outcome: "university.record_withdrawal",
        strategy: "rule_derived" as const,
      },
    };
    const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionAddition });
    expect(state.pending_action_addition).toEqual(pendingActionAddition);
    const refreshed = revalidateBoundaryAuthoringResume(state, {
      ...binding,
      schema_fingerprint: `sha256:${"b".repeat(64)}`,
    });
    expect(refreshed.pending_action_addition).toEqual(pendingActionAddition);
    expect(() => revalidateBoundaryAuthoringResume({
      ...state,
      pending_action_addition: { ...pendingActionAddition, source_ranges: [{ start: 12, end: 15 }] },
    }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionAddition: {
      ...pendingActionAddition,
      source_ranges: [{ start: 12, end: 14 }, { start: 12, end: 14 }],
    } })).toThrow("source ranges must be unique");
  });
  it("validates client preferences and includes them in the integrity digest", () => {
    const input = { binding, stage: "planning" as const, jobIntent: "Review customer records.", provider: "openai" as const, model: "gpt-test" };
    const state = buildBoundaryAuthoringResumeState({ ...input, intendedClient: "claude-code" });
    expect(() => revalidateBoundaryAuthoringResume({ ...state, intended_client: "cursor" }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, intendedClient: "unreviewed-launcher" as never })).toThrow("client preference");
    expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).intended_client).toBeUndefined();
  });
  it("retains untrusted unfinished components and exact completed outcomes without carrying stale analysis or consent", () => {
    const state = buildBoundaryAuthoringResumeState({ binding, stage: "client_setup",
      jobIntent: "Review visits and propose rescheduling.", provider: "openai", model: "gpt-5.6-terra",
      intendedClient: "claude-code",
      policySourceSession: "d2c11000-aaa1-4bbb-8ccc-111111111111",
      conversation: [{ question: "Who reviews exceptions?", answer: "The clinic manager." }],
      read: { analysis_id: "read_one", analysis_digest: `sha256:${"4".repeat(64)}` },
      action: {
        intent: "Reschedule visits.", outcome: "clinic.reschedule", strategy: "rule_derived",
        intents: ["Reschedule visits.", "Notify the clinic."],
        completed_outcomes: ["clinic.reschedule"],
        checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" },
          intent_digest: `sha256:${"7".repeat(64)}`,
          context_digest: `sha256:${"8".repeat(64)}`,
          components: { verification: { name: "clinic.verify_notification", resources: [] } },
          operator_messages: ["Notification approval limits are still undecided."],
        }),
      },
      clientHandoff: { read_digest: `sha256:${"5".repeat(64)}` },
    });
    const current = { ...binding, schema_fingerprint: `sha256:${"6".repeat(64)}` as const };
    const next = revalidateBoundaryAuthoringResume(state, current);
    expect(next).toMatchObject({ stage: "planning", binding: current, job_intent: state.job_intent,
      conversation: state.conversation, policy_source_session: state.policy_source_session, authority_granted: false });
    expect(next.read).toBeUndefined();
    expect(next.action).toEqual({
      intent: "Reschedule visits.", outcome: "clinic.reschedule", strategy: "rule_derived",
      intents: ["Reschedule visits.", "Notify the clinic."],
      completed_outcomes: ["clinic.reschedule"],
      checkpoint: state.action!.checkpoint,
    });
    expect(next.action?.checkpoint?.context_digest).toBe(`sha256:${"8".repeat(64)}`);
    expect(next.client_handoff).toBeUndefined();
    expect(next.intended_client).toBe("claude-code");
    expect(state.stage).toBe("client_setup");
    expect(() => revalidateBoundaryAuthoringResume(state, { ...current, boundary_name: "other" })).toThrow("different Read Boundary");
    expect(() => revalidateBoundaryAuthoringResume({ ...state, job_intent: "tampered" }, current)).toThrow("digest");
  });
  it("persists bounded symbolic context without credentials or trusted identities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "action_drafting",
        intendedClient: "claude-code",
        jobIntent: "Let customers review tickets and propose one bounded refund.",
        provider: "openai",
        model: "gpt-5.6-terra",
        conversation: [{
          question: "What is the largest refund the agent may propose?",
          answer: "Twenty-five dollars.",
          kind: "clarification",
        }],
        policySourceSession: "d2c11000-aaa1-4bbb-8ccc-111111111111",
        readIntent: "Let the authenticated customer inspect only their own tickets and charges.",
        read: {
          analysis_id: "read_analysis_1",
          analysis_digest: `sha256:${"4".repeat(64)}`,
        },
        action: {
          intent: "Propose one bounded refund.",
          outcome: "refund.request_submitted",
          strategy: "rule_derived",
        },
        now: "2026-09-03T12:00:00.000Z",
      });
      const saved = await writeBoundaryAuthoringResumeState(root, state);
      expect(saved).toBe("./.synapsor/boundary-authoring/resume.json");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "ready",
        value: state,
      });
      const raw = await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8");
      expect(raw).not.toContain("OPENAI_API_KEY");
      expect(raw).not.toContain("tenant_id");
      expect(raw).not.toContain("principal_id");
      expect(raw).not.toContain("DATABASE_URL");
      expect(state.policy_source_session).toBe("d2c11000-aaa1-4bbb-8ccc-111111111111");
      expect(state.read_intent).toBe(
        "Let the authenticated customer inspect only their own tickets and charges.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips clarification history and rejects unsupported saved turn kinds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-kind-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "planning",
        jobIntent: "Review visits without activating authority.",
        provider: "openai",
        model: "gpt-test",
        conversation: [{
          question: "Should customers see the visit status?",
          answer: "Visit status is customer-facing business information.",
          kind: "clarification",
        }],
      });
      await writeBoundaryAuthoringResumeState(root, state);
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({ status: "ready", value: state });
      const filePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { conversation: Array<Record<string, unknown>> };
      parsed.conversation[0]!.kind = "unsupported";
      await fs.writeFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "invalid",
        reason: "The saved authoring state failed its schema or integrity check.",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists a detailed job and Action intent beyond the old 500-character ceiling", () => {
    const jobIntent = "j".repeat(2_000);
    const actionIntent = "a".repeat(2_000);
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "action_drafting",
      jobIntent,
      provider: "openai",
      model: "gpt-test",
      action: { intent: actionIntent, strategy: "rule_derived" },
    });
    expect(state.job_intent).toBe(jobIntent);
    expect(state.action?.intent).toBe(actionIntent);
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "j".repeat(2_001),
      provider: "openai",
      model: "gpt-test",
    })).toThrow("job intent must be 1 through 2000 safe characters");
  });

  it("retains a concise Read intent for resuming a long job before analysis exists", () => {
    const readIntent = "Let the authenticated customer inspect only their own account, charges, refunds, and tickets.";
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "read_mapping",
      jobIntent: "j".repeat(637),
      readIntent,
      provider: "openai",
      model: "gpt-test",
    });
    expect(state.job_intent).toHaveLength(637);
    expect(state.read_intent).toBe(readIntent);
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "read_mapping",
      jobIntent: "Review customer support records.",
      readIntent: "r".repeat(501),
      provider: "openai",
      model: "gpt-test",
    })).toThrow("Read intent must be 1 through 500 safe characters");
  });

  it("refuses a digest-tampered resume record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-tamper-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "planning",
        jobIntent: "Review support tickets.",
        provider: "anthropic",
        model: "claude-test",
      });
      await writeBoundaryAuthoringResumeState(root, state);
      const filePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      parsed.job_intent = "Review every tenant.";
      await fs.writeFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "invalid",
        reason: "The saved authoring state changed after Runner wrote its integrity digest.",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("marks schema or role drift stale without silently clearing the structured setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-stale-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "read_mapping",
        jobIntent: "Review support tickets.",
        provider: "openai_compatible",
        model: "qwen-test",
      });
      await writeBoundaryAuthoringResumeState(root, state);
      const changed: BoundaryAuthoringResumeBinding = {
        ...binding,
        schema_fingerprint: `sha256:${"9".repeat(64)}`,
        role_posture_fingerprint: `sha256:${"8".repeat(64)}`,
      };
      const loaded = await readBoundaryAuthoringResumeState(root, changed);
      expect(loaded).toMatchObject({
        status: "stale",
        reason: expect.stringContaining("database schema changed"),
      });
      expect(loaded.status === "stale" ? loaded.reason : "").toContain("database role");
      expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
      await expect(readBoundaryAuthoringResumeState(root, changed)).resolves.toEqual(loaded);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses credentials, endpoint URLs, and concrete trusted identities", () => {
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "Use postgres://operator:secret@db.example/app to review tickets.",
      provider: "openai",
      model: "gpt-test",
    })).toThrow("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED");
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "Use tenant_id: acme-corp to review tickets.",
      provider: "openai",
      model: "gpt-test",
    })).toThrow("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED");
  });

  it.each([
    "Never infer customer scope from tenant isolation alone.",
    "Preserve tenant isolation and resolve each tenant issue through review.",
    "A principal isolation issue does not establish its business meaning.",
  ])("keeps privacy copula lexing exact in dispatch checkpoints: %s", (dispatchQuestion) => {
    expect(() => assertBoundaryAuthoringResumeMaterial({
      pending_read_revision_state: { checkpoint: { stage: "dispatching", dispatch_question: dispatchQuestion } },
    })).not.toThrow();
  });

  it.each([
    "tenant is acme-corp", "principal is person-123", "tenant = acme-corp", "principal=person-123",
    "tenant: acme-corp", '"tenant": "acme-corp"', "principal_id: person-123", "tenant is\nacme-corp",
    "tenant IS acme-corp", "tenant isolation is required. tenant is acme-corp",
    "A principal issue remains pending. principal_id = person-123",
  ])("keeps concrete identity fences in dispatch checkpoints: %s", (dispatchQuestion) => {
    expect(() => assertBoundaryAuthoringResumeMaterial({
      pending_read_revision_state: { checkpoint: { stage: "dispatching", dispatch_question: dispatchQuestion } },
    })).toThrow("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED");
  });

  it("retains bounded B35 producer origin without exempting it from saved-state privacy checks", () => {
    const generationRecovery = {version: 1 as const, operations: [{id: "11111111-1111-4111-8111-111111111111",
      request_digest: canonicalJsonDigest("encoded request"), context_digest: canonicalJsonDigest("current context"),
      deadline: new Date().toISOString(), state: "checkpointed" as const,
      attempts: [{id: "22222222-2222-4222-8222-222222222222", started_at: new Date().toISOString(), outcome: "response" as const}],
      producer_input: {consumer: "action_rule_components" as const, operator_message: "One billing reviewer.", program_resume_revision: canonicalJsonDigest("original frame")}}]};
    const input = {binding, stage: "planning" as const, jobIntent: "Retain the exact saved work.", provider: "openai" as const, model: "gpt-test", generationRecovery};
    expect(buildBoundaryAuthoringResumeState(input).generation_recovery?.operations[0]!.producer_input).toEqual(generationRecovery.operations[0]!.producer_input);
    for (const text of ["api_key=private-value", "https://private.example/endpoint", "BEGIN PRIVATE KEY", "tenant_id: concrete-customer"]) {
      const changed = structuredClone(input);changed.generationRecovery.operations[0]!.producer_input.operator_message = text;
      expect(() => buildBoundaryAuthoringResumeState(changed)).toThrow(/BLOCKED/);
    }
    const oversized = structuredClone(input);oversized.generationRecovery.operations[0]!.producer_input.operator_message = "a".repeat(4_001);
    expect(() => revalidateBoundaryAuthoringResume(buildBoundaryAuthoringResumeState(oversized), binding)).toThrow(/INVALID/);
  });

  it("permits symbolic trusted-scope explanations without persisting a concrete identity", () => {
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "action_drafting",
      jobIntent: "Review support tickets and propose a bounded update.",
      provider: "openai",
      model: "gpt-test",
      conversation: [{
        question: "Where does customer scope come from?",
        answer: "tenant_id is Runner-injected and principal_id is trusted runtime context.",
      }],
    });
    expect(state.conversation).toEqual([{
      question: "Where does customer scope come from?",
      answer: "tenant_id is Runner-injected and principal_id is trusted runtime context.",
    }]);
  });

  // Constructed formatting variants of the captured generated explanation.
  it.each([
    "The allowance is scoped to the tenant: maximum **2** in **86,400 seconds**, shared across principals.",
    "Tenant: maximum 2; boundary: maximum 6, within 86400 seconds.",
    "**tenant**: **at most 2** automatic approvals per day.",
    "principal: limit of two approvals per day; tenant: up to six.",
    "tenant: maximum 2\nprincipal: at most 1 per day",
  ])("saves complete quota-description checkpoints and retains meanings on restart: %s", async answer => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-quota-description-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Maintain reviewed limits.",
        provider: "openai" as const, model: "gpt-test" };
      const initial = buildBoundaryAuthoringResumeState({ ...input, conversation: [{ question: "Meaning?",
        answer: "Each tenant is exactly one organization; each principal is an assigned reviewer.", kind: "clarification" }] });
      await writeBoundaryAuthoringResumeState(root, initial);
      const next = buildBoundaryAuthoringResumeState({ ...input, previous: initial,
        conversation: [...initial.conversation, { question: "Describe the saved policy.", answer }],
        pendingActionRevision: { outcome: "operations.review", instruction: "Retain the original quotas.",
          baseline_digest: canonicalJsonDigest("baseline"), operator_statements: [initial.conversation[0]!.answer],
          checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" }, intent_digest: canonicalJsonDigest("intent"),
            context_digest: canonicalJsonDigest("context"), components: {}, operator_messages: [answer] }) } });
      await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: initial.revision_digest });
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: next });
      for (const prohibited of ["tenant: 2", "principal_id = 17", "tenant: customer123", "principal is a7", 'tenant: "maximum 2"', "principal: 'at most 1'", "tenant: `maximum 2`", '{"tenant": "7"}', "api_key=private"]) {
        expect(() => buildBoundaryAuthoringResumeState({ ...input, previous: next,
          conversation: [...next.conversation, { question: "Mixed material", answer: `${answer}; ${prohibited}` }] })).toThrow(/BLOCKED/);
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: next });
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    "Yes. Each tenant is exactly one league, and each principal is an assigned referee within that league. Referees in the same league share the limit of two automatic ratifications in the rolling 24 hours; all leagues share the overall limit of six.",
    "Each tenant is one organization. Each principal is a member of that organization; allow four approvals per day across members.",
    "A tenant is exactly one department, and a principal is an assigned reviewer. The allowance is seven per department and twenty overall.",
    "Before fixing the validation error, answer one question exactly. In the reviewed scope right now, which column is bound as the tenant - carrier_id or account_id? And is that 10-per-24-hours cap counted per carrier organisation or per customer account? If the tenant is bound to account_id then the cap is per account, which is not what I required.",
    "Which column is bound as the tenant - scope_a or scope_b? If the tenant is bound to scope_b then the cap has the wrong scope.",
    "Yes. app.person is the authenticated patron's trusted identity and filters c01. app.tenant is the trusted library/account identity and filters c02. They are distinct even though both source columns are UUID. Keep these bindings private and outside model arguments.",
    "The tenant is the trusted account context; the principal is the reviewed authenticated person.",
  ])("retains descriptive trusted identity clarification through checkpoint save: %s", async (answer) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-symbolic-scope-resume-"));
    try {
      const state = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting",
        jobIntent: "Let people collect eligible holds.", provider: "openai", model: "gpt-test",
        conversation: [{ question: "What do the identity bindings mean?", answer, kind: "clarification" }],
        action: { intent: "Collect an eligible hold.", checkpoint: actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v2" },
          intent_digest: `sha256:${"4".repeat(64)}`, context_digest: `sha256:${"5".repeat(64)}`, components: {},
          operator_messages: [answer],
        }) },
      });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.conversation[0]?.answer).toBe(answer);
      expect(state.authority_granted).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["tenant is acme-corp", "app.tenant = acme-corp", "principal_id: user-123", "tenant is the-account-123",
    "tenant is bound to customer123",
    "tenant = exactly one organization", "tenant: one organization", "tenant is exactly one customer123",
    "Each tenant is exactly one organization. principal_id = user-123",
    "Which column is bound as the tenant - scope_a or scope_b? tenant is bound to acme-corp",
    "Which column is bound as the tenant - scope_a or scope_b? tenant is bound to scope_b. principal_id = user-123",
    "Which column is bound as the tenant - scope_a or scope_b? tenant = bound",
    "tenant is the trusted identity. principal_id = 45000000-0000-4000-8000-000000000001"])("still refuses concrete identity assignment: %s", (answer) => {
    expect(() => buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Review records.",
      provider: "openai", model: "gpt-test", conversation: [{ question: "Scope?", answer }],
    })).toThrow("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED");
  });
});
