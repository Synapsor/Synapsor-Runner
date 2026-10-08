import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { createReadAssistanceCheckpointHost, type ReadAssistanceCheckpointAccess } from "./authoring-read-assistance-checkpoint-host.js";
import { generateModelReadWorkload, type ModelReadWorkloadInput } from "./read-workload-model.js";
import type { ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { BoundaryAuthoringResumeRead } from "./boundary-authoring-resume.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { withAuthoringGenerationRecovery, configureAuthoringGenerationRecovery, validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { secureAskJsonRequest, type AskProviderDependencies } from "./model-ask.js";
import { storeReadWorkloadAnalysis, listReadWorkloadAnalyses } from "./read-workloads.js";

const question = { resource: "public.orders", field: "status", reason: "Meaning missing from this view", question: "Which fulfillment stages should this view describe?" };
const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "read_host_control", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
const mapping = { allowed: [{ id: "my_orders", description: "List my orders", plan: { kind: "rows", resource: "public.orders", select: ["status"] } }], forbidden: [] };
async function harness(relativeTime = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-checkpoint-host-"));
  const boundary = generatedBoundary();
  if (relativeTime) {
    boundary.pack.resources[0]!.field_types.created_at = "timestamptz";
    boundary.pack.resources[0]!.selectable_fields.push("created_at");
    boundary.pack.resources[0]!.time_bucket_fields.created_at = ["day"];
  }
  let context = canonicalJsonDigest("declared current Source and reader"), candidate = explorationBoundaryCandidateDigest(boundary);
  let state: { checkpoint?: ReadWorkloadAssistanceCheckpoint; read?: BoundaryAuthoringResumeRead; handoffs: AuthoringOwnerHandoff[]; questions: OperatorQuestion[]; recovery?: AuthoringTransportState } = { handoffs: [], questions: [] };
  const permit = Object.freeze({ testPermit: "identity-only mock native mutation port" }) as never;
  const saves: Array<{ subject: string; acknowledge?: false; state: typeof state }> = [];
  const saveFault = { subject: "" };
  const append = vi.fn(async () => {});
  const access: ReadAssistanceCheckpointAccess = {
    // This port models the existing caller's rollback, not another persistence implementation.
    mutate: async operation => { const before = structuredClone(state); try { return await operation(permit); } catch (error) { state = before; throw error; } },
    scopeDigest: () => canonicalJsonDigest("owned Read stage"), contextDigest: async got => { expect(got).toBe(permit); return context; },
    currentCandidate: async () => ({ candidate_digest: candidate }), readCheckpoint: () => state.checkpoint,
    readHandoffs: () => state.handoffs, readQuestions: () => state.questions, readRecovery: () => state.recovery,
    readConversation: () => undefined, readReviewedRelationshipAnswer: () => undefined,
    install: update => { for (const key of ["checkpoint", "recovery", "read"] as const) if (Object.prototype.hasOwnProperty.call(update, key)) Object.assign(state, { [key]: update[key] }); },
    storeAnalysis: input => storeReadWorkloadAnalysis({ projectRoot: root, ...input }), appendSourceMessage: append,
    save: async (got, subject, acknowledge) => { expect(got).toBe(permit); if (subject === saveFault.subject) throw new Error("TEST_NATIVE_SAVE_ACK_LOST"); saves.push({ subject, acknowledge, state: structuredClone(state) }); },
    checkpointFailure: subject => new Error("CHECKPOINT_NOT_SAVED: " + subject),
  };
  const host = createReadAssistanceCheckpointHost({ access });
  const run = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>, extra: Partial<ModelReadWorkloadInput> = {}) => generateModelReadWorkload({
    name: "owned_assistance", allowedQuestions: ["List my orders"], provider: "openai", model: "owned-local-fixture", generatedBoundary: boundary,
    apiKey: "inert-test-key", egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, onCheckpoint: host.persist,
    clarificationHandler: async () => undefined, ...extra,
  });
  return { root, boundary, host, access, run, saves, saveFault, append, state: () => state,
    driftContext: () => { context = canonicalJsonDigest("different Source binding"); },
    driftCandidate: () => { candidate = canonicalJsonDigest("different Read candidate"); },
    setRecovery: (value: AuthoringTransportState) => { state.recovery = structuredClone(value); },
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("initial Read assistance checkpoint host native producer boundary", () => {
  it("commits a valid relative-window mapping when the clock advances between producer and host validation", async () => {
    const h = await harness(true);
    let clock = Date.parse("2026-10-07T15:00:00Z");
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const send = vi.fn(async () => response({ ...mapping, allowed: [{ ...mapping.allowed[0], plan: {
      ...mapping.allowed[0]!.plan, time_window: { field: "created_at", window: "last_30_days" },
    } }] }));
    try {
      const result = await h.run(send);
      expect(result.analysis.status).toBe("ready"); expect(send).toHaveBeenCalledOnce();
      expect(h.state().checkpoint).toBeUndefined(); expect(h.state().read?.analysis_id).toBeTruthy();
      const records = await listReadWorkloadAnalyses({ projectRoot: h.root, generatedBoundary: h.boundary });
      expect(records).toHaveLength(1); expect(records[0]!.analysis).toEqual(result.analysis);
      expect(records[0]!.authority_granted).toBe(false); expect(h.append).not.toHaveBeenCalled();
    } finally { now.mockRestore(); await h.cleanup(); }
  });
  it("stops a failed pre-I/O dispatch save without sending, clearing or renewing producer limits", async () => {
    const h = await harness(), send = vi.fn(async () => response(mapping));
    try { h.saveFault.subject = "The Read dispatch checkpoint";
      await expect(h.run(send)).rejects.toThrow("TEST_NATIVE_SAVE_ACK_LOST");
      expect(send).not.toHaveBeenCalled(); expect(h.state()).toEqual({ handoffs: [], questions: [] }); expect(h.saves).toEqual([]);
    } finally { await h.cleanup(); }
  });
  it("retains spent dispatch before I/O and explicitly clears the wait only after accepted native analysis", async () => {
    const h = await harness();
    try { const result = await h.run(async () => { expect(h.state().checkpoint?.stage).toBe("dispatching"); return response(mapping); });
      expect(result.analysis.status).toBe("ready"); expect(h.saves.map(x => x.acknowledge)).toEqual([false, false, undefined]);
      expect(h.state()).toHaveProperty("checkpoint", undefined); expect(h.state().read?.analysis_id).toBeTruthy();
      const records = await listReadWorkloadAnalyses({ projectRoot: h.root, generatedBoundary: h.boundary });
      expect(records).toHaveLength(1); expect(records[0]!.analysis_digest).toBe(h.state().read!.analysis_digest);
      expect(records[0]!.authority_granted).toBe(false); expect(h.append).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });
  it("retains the last dispatch on accepted Resume acknowledgement loss; stored analysis remains inert", async () => {
    const h = await harness();
    try { h.saveFault.subject = "The Read assistance checkpoint";
      await expect(h.run(async () => response(mapping))).rejects.toThrow("TEST_NATIVE_SAVE_ACK_LOST");
      expect(h.state().checkpoint?.stage).toBe("dispatching"); expect(h.state().read).toBeUndefined();
      expect(h.saves).toHaveLength(2); expect(h.saves.every(x => x.acknowledge === false)).toBe(true);
      const records = await listReadWorkloadAnalyses({ projectRoot: h.root, generatedBoundary: h.boundary });
      expect(records).toHaveLength(1); expect(records[0]!.authority_granted).toBe(false);
    } finally { await h.cleanup(); }
  });
  it("refuses a stale exact candidate before provider or store activity", async () => {
    const h = await harness(), send = vi.fn(async () => response(mapping));
    try { h.driftCandidate(); await expect(h.run(send)).rejects.toThrow("CHECKPOINT_STALE");
      expect(send).not.toHaveBeenCalled(); expect(h.saves).toEqual([]); expect(h.state().read).toBeUndefined();
    } finally { await h.cleanup(); }
  });
  it("refuses changed Source context when replaying the actual retained wait", async () => {
    const h = await harness();
    try { await expect(h.run(async () => response({ clarification_request: question }))).rejects.toThrow("AUTHORING_PAUSED");
      const before = structuredClone(h.state()), checkpoint = before.checkpoint!; expect(checkpoint.stage).toBe("waiting");
      h.driftContext(); await expect(h.host.persist(checkpoint, h.boundary)).rejects.toThrow("OWNER_QUESTION_CONTEXT_CHANGED");
      expect(h.state()).toEqual(before); expect(h.state().questions).toHaveLength(1); expect(h.append).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });
  it("binds the actual transport completion and refuses same text from another completed call", async () => {
    const h = await harness(); let sends = 0; const server = createServer(async (req, res) => { for await (const _ of req) {} sends++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response({ clarification_request: question }).body)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    h.setRecovery({ version: 1, operations: [] });
    const enter = () => withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery!, current: async () => canonicalJsonDigest("fixed transport context"), write: async value => { validateAuthoringTransportState(value); h.setRecovery(value); } }); return h.run(r => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })); });
    try { await expect(enter()).rejects.toThrow("AUTHORING_PAUSED");
      const first = structuredClone(h.state()); expect(first.handoffs[0]!.completion).toEqual(first.checkpoint?.pending_question?.completion);
      expect(first.handoffs[0]!.completion?.operation_id).toBe(first.recovery!.operations.at(-1)!.id);
      await expect(enter()).rejects.toThrow("AUTHORING_OWNER_QUESTION_PENDING");
      expect(sends).toBe(2);
      expect(h.state().handoffs).toEqual(first.handoffs); expect(h.state().questions).toEqual(first.questions);
      expect(h.state().read).toBeUndefined();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await h.cleanup(); }
  });
});

// Declared metadata fixture shared in shape with the producer's existing tests.
function generatedBoundary(): ExplorationBoundaryDraft {
  const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.7.0",
    spec_version: "1.9.0",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL_ID",
    },
    generation_lock_fingerprint: hash("1"),
    role_posture_fingerprint: hash("2"),
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        schema: "public",
        table: "orders",
        label: "Customer orders",
        description: "One reviewed order per purchase.",
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {
          id: "uuid",
          tenant_id: "text",
          principal_id: "text",
          status: "text",
          amount: "numeric",
          secret_note: "text",
        },
        field_enums: { status: ["open", "closed"] },
        selectable_fields: ["id", "status", "amount"],
        filterable_fields: { status: ["eq", "neq", "in"] },
        sortable_fields: ["amount"],
        groupable_fields: ["status"],
        aggregate_measures: ["amount"],
        aggregate_measure_functions: { amount: ["sum", "avg"] },
        count_distinct_fields: ["status"],
        time_bucket_fields: {},
        kept_out_fields: ["secret_note"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),
    unresolved_decisions: [],
  };
}

describe("B64 typed missing-scope question host", () => {
  it("persists the real scope and consumed question before presenting, without manufacturing an answer", async () => {
    const h = await harness();
    const binding = { request_digest: canonicalJsonDigest("List my orders"), source_digest: canonicalJsonDigest("policy"),
      catalog_digest: canonicalJsonDigest("catalog"), meaning_digest: canonicalJsonDigest("meaning"),
      applicability_digest: canonicalJsonDigest("purpose"), operation_digest: canonicalJsonDigest("read") };
    let answered = 0;
    try {
      await expect(withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery,
          current: async () => canonicalJsonDigest("declared current Source and reader"),
          write: async value => h.setRecovery(value), progress: () => {} });
        return generateModelReadWorkload({ name: "typed_scope", allowedQuestions: ["List my orders"], provider: "openai", model: "controlled",
          generatedBoundary: h.boundary, apiKey: "inert-test-key", egressAcknowledged: true, deferNarration: true,
          onCheckpoint: h.host.persist,
          structuredScope: { protocol: "synapsor.read-scope.v1", current: () => ({ binding,
            references: [{ id: "job", kind: "request", digest: binding.request_digest, text: "List my orders" }],
            catalog: { resources: [{ id: "public.orders", fields: [{ id: "status" }] }], relationships: [] } }),
            answer: async (request, completion) => {
              answered++;
              const q = h.state().questions.at(-1)!;
              expect(q).toMatchObject({ version: 2, kind: "read_scope", read_scope: { mode: "missing_answer", record: request.scope, completion } });
              expect(q.raw_answer).toBeUndefined(); expect(q.confirmation).toBeUndefined();
              expect(h.state().recovery?.operations.at(-1)?.read_checkpoint?.material_digest).toBe(canonicalJsonDigest(request.scope));
              expect(h.saves.at(-1)?.state.questions.at(-1)?.digest).toBe(q.digest);
              return undefined;
            } },
          dependencies: { requestJson: async () => response({ allowed: [], forbidden: [], read_scope: {
            protocol: "synapsor.read-scope.v1", applicability: "read_requested", original_request: "job", requirements: [{
              id: "order-meaning", intended_use: "List my orders", references: ["job"], disposition: "unresolved", targets: [],
              unresolved: "Which orders should appear?",
            }],
          } }) },
        });
      })).rejects.toThrow("AUTHORING_PAUSED");
      expect(answered).toBe(1); expect(h.state().checkpoint?.stage).toBe("waiting");
      expect(h.state().handoffs.at(-1)?.state).toBe("waiting");
    } finally { await h.cleanup(); }
  });
});

// The host port below is the existing rollback model, not installed/native CAS acceptance.
describe("B64 full scope review handoff", () => {
  it("stores the real submitted proposal beside its exact analysis, still unconfirmed", async () => {
    const h = await harness();
    const original = "Show order status";
    const binding = { request_digest: canonicalJsonDigest(original), source_digest: canonicalJsonDigest("policy"),
      catalog_digest: canonicalJsonDigest("catalog"), meaning_digest: canonicalJsonDigest("meaning"),
      applicability_digest: canonicalJsonDigest("purpose"), operation_digest: canonicalJsonDigest("read") };
    const inventory = { binding, references: [{ id: "job", kind: "request" as const, digest: binding.request_digest, text: original }],
      catalog: { resources: [{ id: "public.orders", fields: [{ id: "status" }] }], relationships: [] } };
    h.access.scopeInventory = async () => inventory;
    const scope = { protocol: "synapsor.read-scope.v1", applicability: "read_requested", original_request: "job", requirements: [{
      id: "status", intended_use: original, references: ["job"], disposition: "include", targets: [
        { root_resource: "public.orders", resource: "public.orders", operation: "resource" },
        { root_resource: "public.orders", resource: "public.orders", operation: "return", field: "status" },
      ],
    }] };
    try {
      const result = await withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery,
          current: async () => canonicalJsonDigest("declared current Source and reader"), write: async value => h.setRecovery(value), progress: () => {} });
        return h.run(async request => {
          expect(JSON.stringify(request.body)).toContain("job");
          return response({ ...mapping, read_scope: scope });
        }, { allowedQuestions: [original], structuredScope: { protocol: "synapsor.read-scope.v1", current: () => inventory } });
      });
      const q = h.state().questions.at(-1)!;
      expect(q.kind).toBe("read_scope"); expect(q.read_scope?.mode).toBe("review");
      expect(q.proposal?.disposition).toBe("proposed"); expect(q.raw_answer).toBeUndefined(); expect(q.confirmation).toBeUndefined();
      expect(q.read_scope?.record.proposal).toEqual(scope);
      expect(q.read_scope?.record.analysis_digest).toBe(canonicalJsonDigest(result.analysis));
      expect(h.state().read?.scope_question_id).toBe(q.id);
      expect(h.state().recovery?.operations.at(-1)?.read_checkpoint?.material_digest).toBe(canonicalJsonDigest(q.read_scope!.record));
      expect(h.saves.at(-1)?.state.questions.at(-1)?.digest).toBe(q.digest);
    } finally { await h.cleanup(); }
  });
});
