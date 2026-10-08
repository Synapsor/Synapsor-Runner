import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { createReadRevisionCheckpointHost, type ReadRevisionCheckpointAccess } from "./authoring-read-revision-checkpoint-host.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import type { BoundaryAuthoringReadRevision } from "./boundary-authoring-resume.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { createModelAuthoringConversation, type ModelAuthoringConversation } from "./model-authoring-conversation.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { secureAskJsonRequest, type AskProviderDependencies } from "./model-ask.js";

const instruction = "Review the exact status visibility; preserve other access.";
const question = { question: "Should order status stay visible or become private to Runner?", reason: "Confirm the current owner exposure choice." };
const answer = "Keep status private to Runner with no model analysis.";
const revision = { resource_changes: [{ resource: "public.orders", field_exposure: [{ field: "status", exposure: "runner_only", model_operations: "none" }] }] };
const response = (value: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "owned_revision_host", name: "runner__submit_read_boundary_revision", arguments: JSON.stringify(value) }] } });
import { parseOperatorQuestions, type OperatorQuestion } from "./authoring-operator-question.js";

type State = { questions?: OperatorQuestion[]; revision?: BoundaryAuthoringReadRevision; handoffs: AuthoringOwnerHandoff[]; recovery?: AuthoringTransportState; conversation: ModelAuthoringConversation };
function harness() {
  const boundary = generatedBoundary(), sources = newPolicySourceSession();
  sources.snapshots.push(policyTextSnapshot(Buffer.from("The owner chooses the status field's visibility."), "declared-rules.txt")); sources.active = 1;
  let state: State = { revision: { instruction, provenance: "operator", privacy_only: false }, handoffs: [], conversation: { ...createModelAuthoringConversation(), policySources: sources } };
  let currentInstruction = instruction, candidate = explorationBoundaryCandidateDigest(boundary), contextVersion = 0;
  const context = () => canonicalJsonDigest({ source: sources, reader: contextVersion });
  const permit = Object.freeze({ testPermit: "identity-only mock native mutation port" }) as never;
  const saves: Array<{ subject: string; acknowledge?: false; state: State }> = [], events: string[] = [];
  const fault = { subject: "" };
  const append = vi.fn(async (source, message, options) => {
    expect(options.permit).toBe(permit); expect(options.expectedDigest).toBe(canonicalJsonDigest(source));
    events.push("source-append"); (sources.operator_messages ??= []).push(message);
  });
  const access: ReadRevisionCheckpointAccess = {
    // Native caller rollback is a port here. Source testimony is deliberately
    // outside its local snapshot, as in the production cross-file boundary.
    mutate: async operation => { const before = structuredClone(state); try { return await operation(permit); } catch (error) { state = before; throw error; } },
    contextDigest: async got => { expect(got).toBe(permit); events.push("context"); return context(); },
    scopeDigest: () => canonicalJsonDigest("declared current Read-edit scope"), currentCandidate: async () => ({ candidate_digest: candidate }),
    readRevision: () => state.revision, readInstruction: () => currentInstruction, readHandoffs: () => state.handoffs,
    readQuestions: () => state.questions ??= [],
    readRecovery: () => state.recovery, readConversation: () => state.conversation,
    install: update => { for (const key of ["revision", "recovery"] as const) if (Object.prototype.hasOwnProperty.call(update, key)) Object.assign(state, { [key]: update[key] }); },
    appendSourceMessage: append,
    save: async (got, subject, acknowledge) => { expect(got).toBe(permit); events.push("save:" + subject); if (subject === fault.subject) throw new Error("OWNED_NATIVE_ACK_LOST"); saves.push({ subject, acknowledge, state: structuredClone(state) }); },
    checkpointFailure: subject => new Error("CHECKPOINT_NOT_SAVED: " + subject),
  };
  const host = createReadRevisionCheckpointHost({ access });
  type Input = Parameters<typeof generateModelReadBoundaryRevision>[0];
  const run = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>, overrides: Partial<Input> = {}) => generateModelReadBoundaryRevision({
    instruction, provider: "openai", model: "owned-local-fixture", apiKey: "inert-test-key", boundary,
    egressAcknowledged: true, dependencies: { requestJson }, onCheckpoint: host.persist, clarificationHandler: async () => undefined, ...overrides,
  });
  return { boundary, host, run, access, saves, events, fault, append, sources, context, state: () => state,
    driftInstruction: () => { currentInstruction += " Different request."; },
    driftCandidate: () => { candidate = canonicalJsonDigest("another Read"); },
    driftContext: () => { contextVersion++; },
    setRecovery: (value: AuthoringTransportState) => { state.recovery = structuredClone(value); } };
}

describe("Read revision checkpoint host at the native producer boundary", () => {
  it("refuses lost dispatch ACK before I/O and keeps the original pending request through native rollback", async () => {
    const h = harness(), send = vi.fn(async () => response(revision));
    h.fault.subject = "The Read edit dispatch checkpoint";
    await expect(h.run(send)).rejects.toThrow("OWNED_NATIVE_ACK_LOST");
    expect(send).not.toHaveBeenCalled(); expect(h.saves).toEqual([]);
    expect(h.state().revision).toEqual({ instruction, provenance: "operator", privacy_only: false });
    expect(h.state().handoffs).toEqual([]); expect(h.append).not.toHaveBeenCalled();
  });
  it.each(["instruction", "candidate"] as const)("refuses stale %s before producer send", async mode => {
    const h = harness(), send = vi.fn(async () => response(revision));
    if (mode === "instruction") h.driftInstruction(); else h.driftCandidate();
    await expect(h.run(send)).rejects.toThrow(mode === "instruction" ? /pending Read revision/ : /CHECKPOINT_STALE/);
    expect(send).not.toHaveBeenCalled(); expect(h.saves).toEqual([]);
  });
  it("records parsed consumption with the actual dispatch history, not a disabled save or active authority", async () => {
    const h = harness();
    const result = await h.run(async () => { expect(h.state().revision?.checkpoint?.stage).toBe("dispatching"); return response(revision); });
    expect(result.authority_granted).toBe(false); expect(result.source_database_changed).toBe(false);
    expect(h.saves.map(record => record.acknowledge)).toEqual([false, false, undefined]);
    expect(h.state().revision).toMatchObject({ result_received: true, checkpoint_history: { stage: "dispatching", state: { call_count: 1 } } });
    expect(h.state().revision).not.toHaveProperty("checkpoint"); expect(h.state().revision).not.toHaveProperty("saved_read_digest");
    expect(h.append).not.toHaveBeenCalled();
  });
  it("propagates consumed-result ACK loss and does not locally clear the actual last dispatch", async () => {
    const h = harness(); h.fault.subject = "The consumed Read revision result";
    await expect(h.run(async () => response(revision))).rejects.toThrow("OWNED_NATIVE_ACK_LOST");
    expect(h.state().revision?.checkpoint).toMatchObject({ stage: "dispatching", state: { call_count: 1 } });
    expect(h.state().revision).not.toHaveProperty("result_received");
    expect(h.saves.every(record => record.acknowledge === false)).toBe(true);
  });
  it("appends ordinary testimony before answer-context capture and reuses the actual answered checkpoint without duplicate consent", async () => {
    const h = harness();
    await expect(h.run(async () => response({ clarification_request: question }))).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    const waiting = h.state().revision!.checkpoint!;
    const noSend = vi.fn();
    await expect(h.run(noSend, { resumeCheckpoint: waiting, clarificationHandler: async () => ({ state: "answered", answer }),
      onCheckpoint: async (...args) => { await h.host.persist(...args); if (args[0]?.stage === "decided") throw new Error("OWNED_AFTER_DECISION_STOP"); } })).rejects.toThrow("OWNED_AFTER_DECISION_STOP");
    expect(noSend).not.toHaveBeenCalled(); expect(h.append).toHaveBeenCalledOnce();
    const decided = h.state().revision!.checkpoint!, retained = structuredClone(h.state().handoffs);
    expect(h.events.slice(h.events.indexOf("source-append"), h.events.indexOf("source-append") + 3)).toEqual(["source-append", "context", "save:The Read edit question and decision"]);
    expect(retained[0]).toMatchObject({ state: "answered", answer, answer_context_digest: h.context() });
    await h.host.persist(decided, h.boundary);
    expect(h.append).toHaveBeenCalledOnce(); expect(h.state().handoffs).toEqual(retained);
    expect(h.state().conversation.turns).toHaveLength(1);
  });
  it("preserves durable Source testimony across a later Resume failure and fences the old wait on changed context", async () => {
    const h = harness();
    await expect(h.run(async () => response({ clarification_request: question }))).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    const waiting = h.state().revision!.checkpoint!;
    h.fault.subject = "The Read edit question and decision";
    await expect(h.run(vi.fn(), { resumeCheckpoint: waiting, clarificationHandler: async () => {
      // Waiting checkpoint revalidation already succeeded; fail the answer save.
      h.fault.subject = "The Read edit question and decision"; return { state: "answered", answer };
    }, onCheckpoint: async (...args) => {
      if (args[0]?.stage === "waiting") { h.fault.subject = ""; await h.host.persist(...args); h.fault.subject = "The Read edit question and decision"; }
      else await h.host.persist(...args);
    } })).rejects.toThrow("OWNED_NATIVE_ACK_LOST");
    expect(h.sources.operator_messages).toEqual([answer]); expect(h.state().handoffs[0]?.state).toBe("waiting");
    h.fault.subject = "";
    await expect(h.host.persist(waiting, h.boundary)).rejects.toThrow("AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED");
    expect(h.append).toHaveBeenCalledOnce();
  });
  it.each(["eof", "decline"] as const)("retains %s without Source testimony or a consumed result", async mode => {
    const h = harness();
    await expect(h.run(async () => response({ clarification_request: question }))).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    const waiting = h.state().revision!.checkpoint!, send = vi.fn();
    const run = h.run(send, { resumeCheckpoint: waiting,
      clarificationHandler: async () => mode === "eof" ? undefined : { state: "declined" } });
    if (mode === "eof") await expect(run).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    else await expect(run).rejects.toThrow("READ_BOUNDARY_REVISION_CLARIFICATION_DECLINED");
    expect(send).not.toHaveBeenCalled(); expect(h.append).not.toHaveBeenCalled();
    expect(h.state().revision?.checkpoint?.stage).toBe(mode === "eof" ? "waiting" : "decided");
    expect(h.state().handoffs[0]?.state).toBe(mode === "eof" ? "waiting" : "answered");
    expect(h.state().revision).not.toHaveProperty("result_received");
  });
  it("saves the real native private-parent completion without creating a question or Source testimony", async () => {
    const h = harness(), payload = response({ private_prerequisite_request: { reason: "Current admission is required before every read." } });
    let sends = 0;
    const server = createServer(async (request, reply) => { for await (const _ of request) {} sends++; reply.setHeader("content-type", "application/json"); reply.end(JSON.stringify(payload.body)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    try {
      await expect(withAuthoringGenerationRecovery(() => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery, current: async () => h.context(),
          write: async next => { validateAuthoringTransportState(next); h.setRecovery(next); } });
        return h.run(request => secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback" }), {
          reviewPrivatePrerequisite: async (_request, controls) => {
            const cp = h.state().revision!.checkpoint!, op = h.state().recovery!.operations.at(-1)!;
            expect(cp.pending_question?.kind).toBe("private_prerequisite");
            expect(cp.pending_question).not.toHaveProperty("question");
            expect(controls.parentCompletion).toEqual({ operation_id: op.id, request_digest: op.request_digest, context_digest: op.context_digest,
              response_digest: canonicalJsonDigest(payload.body) });
            expect(op.read_checkpoint).toMatchObject({ consumer: "read_revision", kind: "private_prerequisite" });
            return undefined;
          },
        });
      })).rejects.toThrow("READ_PREREQUISITE_REVIEW_PENDING");
      expect(sends).toBe(1); expect(h.append).not.toHaveBeenCalled(); expect(h.state().handoffs).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

// Declared metadata fixture only; no database or activation proof is claimed.
function generatedBoundary(): ExplorationBoundaryDraft {
  const digest = canonicalJsonDigest("declared metadata fixture");
  return { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging", source: "local_postgres",
    compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC", trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: digest, role_posture_fingerprint: digest, pack: { name: "owned_read_revision", resources: [{ id: "public.orders", schema: "public", table: "orders", primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id",
      field_types: { id: "uuid", status: "text", tenant_id: "text", principal_id: "text" }, field_enums: { status: ["open", "closed"] }, selectable_fields: ["id", "status"], filterable_fields: { status: ["eq"] }, sortable_fields: ["status"],
      groupable_fields: [], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["tenant_id", "principal_id"], relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true }] },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [] };
}


describe("typed Read revision result retention", () => {
  it.each(["pending", "preview_changed", "save_fault"] as const)("preserves actual consumed scope through %s", async mode => {
    const h = harness();
    const scope = { binding: { request_digest: canonicalJsonDigest(instruction), source_digest: canonicalJsonDigest("policy"),
      catalog_digest: canonicalJsonDigest(h.boundary.pack), meaning_digest: canonicalJsonDigest("meaning"),
      applicability_digest: canonicalJsonDigest("this-job"), operation_digest: canonicalJsonDigest("edit") },
      references: [{ id: "job", kind: "request" as const, digest: canonicalJsonDigest(instruction), text: instruction }],
      catalog: { resources: [{ id: "public.orders", fields: [{ id: "status" }] }], relationships: [] } };
    const proposal = { protocol: "synapsor.read-scope.v1", applicability: "read_requested", original_request: "job", requirements: [{
      id: "order-status", references: ["job"], intended_use: "Show order status", disposition: "unresolved", targets: [],
      unresolved: "Which status should be shown?" }] };
    h.access.scopePreview = async () => ({ scope: mode === "preview_changed" ? { ...scope,
      binding: { ...scope.binding, operation_digest: canonicalJsonDigest("different current edit") } } : scope });
    if (mode === "save_fault") h.fault.subject = "The consumed Read revision result";
    let calls = 0;
    const run = () => withAuthoringGenerationRecovery(async () => {
      configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery,
        current: async () => h.context(), write: async value => h.setRecovery(value), progress: () => {} });
      return h.run(async request => { calls++; expect(JSON.stringify(request.body)).toContain("job");
        return response({ read_scope: proposal }); },
        { structuredScope: { protocol: "synapsor.read-scope.v1", current: () => scope } });
    });
    if (mode !== "pending") {
      await expect(run()).rejects.toThrow(mode === "save_fault" ? "OWNED_NATIVE_ACK_LOST" : "CHECKPOINT_STALE");
      expect(h.state().revision?.result_received).toBeUndefined(); expect(h.state().questions ?? []).toEqual([]);
      expect(h.state().recovery?.operations.at(-1)?.read_checkpoint).toBeUndefined();
    } else {
      await run();
      const q = h.state().questions!.at(-1)!;
      expect(q.read_scope?.record.proposal).toEqual(proposal);
      expect(q.proposal).toBeUndefined(); expect(q.confirmation).toBeUndefined(); expect(q.raw_answer).toBeUndefined();
      expect(q.read_scope?.record.analysis_digest).toBeUndefined();
      expect(h.state().revision).toMatchObject({ result_received: true, scope_question_id: q.id });
      expect(h.state().revision?.saved_read_digest).toBeUndefined();
      expect(parseOperatorQuestions(h.state().questions, h.state().handoffs, h.state().recovery)).toEqual([q]);
      expect(h.saves.at(-1)?.state.questions).toEqual([q]);
    }
    expect(calls).toBe(1);
  });
});
