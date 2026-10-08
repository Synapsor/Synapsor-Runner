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
import { createReadMeaningHost } from "./authoring-read-meaning-host.js";
import type { ReadMeaningInteraction } from "./authoring-read-meaning-interaction.js";

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
  return { root, boundary, host, access, run, saves, saveFault, append, readContext: () => context, state: () => state,
    driftContext: () => { context = canonicalJsonDigest("different Source binding"); },
    driftCandidate: () => { candidate = canonicalJsonDigest("different Read candidate"); },
    setRecovery: (value: AuthoringTransportState) => { state.recovery = structuredClone(value); },
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

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

async function pendingScope(responses: Array<string | null>) {
  const h = await harness();
  const binding = { request_digest: canonicalJsonDigest("List my orders"), source_digest: canonicalJsonDigest("policy"),
    catalog_digest: canonicalJsonDigest("catalog"), meaning_digest: canonicalJsonDigest("meaning"),
    applicability_digest: canonicalJsonDigest("purpose"), operation_digest: canonicalJsonDigest("read") };
  await expect(withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery, current: async () => h.readContext(),
      write: async value => h.setRecovery(value), progress: () => {} });
    return generateModelReadWorkload({ name: "typed_scope", allowedQuestions: ["List my orders"], provider: "openai", model: "controlled",
      generatedBoundary: h.boundary, apiKey: "inert-test-key", egressAcknowledged: true, deferNarration: true, onCheckpoint: h.host.persist,
      structuredScope: { protocol: "synapsor.read-scope.v1", current: () => ({ binding,
        references: [{ id: "job", kind: "request", digest: binding.request_digest, text: "List my orders" }],
        catalog: { resources: [{ id: "public.orders", fields: [{ id: "status" }] }], relationships: [] } }) },
      dependencies: { requestJson: async () => response({ allowed: [], forbidden: [], read_scope: {
        protocol: "synapsor.read-scope.v1", applicability: "read_requested", original_request: "job", requirements: [{
          id: "order-meaning", intended_use: "List my orders", references: ["job"], disposition: "unresolved", targets: [],
          unresolved: "Which orders should appear?" }],
      } }) } });
  })).rejects.toThrow("AUTHORING_PAUSED");
  const cp = h.state().checkpoint!;
  if (cp.pending_question?.kind !== "scope") throw new Error("Missing actual native scope wait");
  let inMutation = false;
  const hooks: { duringPrompt?: () => void; pendingChoice?: "keep" | "review" | "replace" } = {};
  const seen: ReadMeaningInteraction[] = [];
  const host = createReadMeaningHost({ access: {
    readQuestions: () => h.state().questions, readHandoffs: () => h.state().handoffs,
    readCheckpoint: () => h.state().checkpoint, readRecovery: () => h.state().recovery, readConversationTurns: () => undefined,
    scopeDigest: h.access.scopeDigest, contextDigest: async () => h.readContext(), assertFresh: async () => {},
    mutate: async operation => h.access.mutate(async permit => { inMutation = true; try { return await operation(permit); } finally { inMutation = false; } }),
    install: update => Object.assign(h.state(), update), save: h.access.save, checkpointFailure: h.access.checkpointFailure,
  }, interact: async (view, assertCurrent) => {
    expect(inMutation).toBe(false); await assertCurrent(); seen.push(view);
    if (view.kind === "pending") return { kind: "pending", binding: view.binding, choice: hooks.pendingChoice ?? "keep" };
    if (view.kind !== "question") throw new Error("Unexpected semantic confirmation before mapping");
    hooks.duringPrompt?.();
    return { kind: "answer", binding: view.binding, raw: responses.shift() ?? null };
  }, answerTooLarge: () => {} });
  return { ...h, hooks, answer: () => host.answerScope(cp.pending_question!.kind === "scope" ? cp.pending_question!.request : neverRequest()),
    resolve: (reference: Parameters<typeof host.resolveScopeAnswer>[0]) => host.resolveScopeAnswer(reference,
      cp.pending_question!.kind === "scope" ? cp.pending_question!.request : neverRequest()), seen };
}
function neverRequest(): never { throw new Error("Not a scope wait"); }

describe("B64 actual missing-scope raw-answer host", () => {
  it.each(["I'm not sure", "  Only my open orders.  "])("retains %s as testimony without lexical classification or semantic consent", async raw => {
    const h = await pendingScope([raw]);
    try {
      const ref = await h.answer(); expect(ref).toBeTruthy();
      const q = h.state().questions.at(-1)!;
      expect(q.raw_answer?.text).toBe(raw); expect(q.proposal).toBeUndefined(); expect(q.confirmation).toBeUndefined();
      expect(h.state().handoffs.at(-1)?.state).toBe("answered"); expect(h.state().checkpoint?.stage).toBe("decided");
      expect(h.resolve(ref!)).toMatchObject({ kind: "answer", text: raw, digest: canonicalJsonDigest(q.raw_answer), answer_id: q.raw_answer!.id });
      expect(h.resolve({ ...ref!, answer_id: "another-answer" })).toBeUndefined();
      expect(await h.answer()).toEqual(ref); expect(h.seen).toHaveLength(1);
      expect(h.state().recovery?.operations).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("leaves a blank pending and replaces it at the next native revision without a new model call", async () => {
    const h = await pendingScope([" \t ", "Open orders"]);
    try {
      expect(await h.answer()).toBeUndefined();
      expect(h.state().checkpoint?.stage).toBe("waiting"); const old = structuredClone(h.state().questions[0]!);
      const ref = await h.answer(); expect(ref?.revision).toBe(2);
      expect(h.state().questions[0]).toEqual(old); expect(h.state().questions[1]!.read_scope?.predecessor_id).toBe(old.id);
      expect(h.resolve(ref!)?.text).toBe("Open orders"); expect(h.state().recovery?.operations).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("keeps cancel pending and rejects changed Source before capture", async () => {
    const h = await pendingScope([null]);
    try {
      expect(await h.answer()).toBeUndefined(); expect(h.state().checkpoint?.stage).toBe("waiting");
      expect(h.state().questions[0]!.raw_answer).toBeUndefined();
      h.driftContext(); await expect(h.answer()).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(h.seen).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("rolls back raw capture, acknowledgement and decided checkpoint together if save fails", async () => {
    const h = await pendingScope(["Open orders"]);
    try {
      const before = structuredClone(h.state()); h.saveFault.subject = "The unconfirmed raw scope answer";
      await expect(h.answer()).rejects.toThrow("TEST_NATIVE_SAVE_ACK_LOST");
      expect(h.state()).toEqual(before); expect(h.state().handoffs.at(-1)?.state).toBe("waiting");
      expect(h.state().questions.at(-1)?.raw_answer).toBeUndefined();
    } finally { await h.cleanup(); }
  });
  it("replaces a retained unaccepted answer only after the explicit pending choice", async () => {
    const h = await pendingScope(["x".repeat(1_001), "Open orders"]);
    try {
      expect(await h.answer()).toBeUndefined(); const old = structuredClone(h.state().questions[0]!);
      expect(await h.answer()).toBeUndefined(); expect(h.state().questions).toHaveLength(1);
      h.hooks.pendingChoice = "replace";
      const ref = await h.answer(); expect(ref?.revision).toBe(2); expect(h.state().questions[0]).toEqual(old);
      expect(h.resolve(ref!)?.text).toBe("Open orders"); expect(h.state().recovery?.operations).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it("rejects drift during an unlocked operator wait before saving any words", async () => {
    const h = await pendingScope(["Open orders"]);
    try {
      h.hooks.duringPrompt = h.driftContext;
      await expect(h.answer()).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(h.state().questions.at(-1)?.raw_answer).toBeUndefined(); expect(h.state().checkpoint?.stage).toBe("waiting");
    } finally { await h.cleanup(); }
  });
  it("resumes a durably captured answer through actual remapping without a second prompt", async () => {
    const h = await pendingScope(["Show the status field for my orders."]);
    try {
      const reference = await h.answer(), cp = h.state().checkpoint!;
      if (!reference || cp.pending_question?.kind !== "scope") throw new Error("Missing captured native answer");
      const request = cp.pending_question.request, answer = h.resolve(reference)!;
      const inventory = { binding: request.scope.binding, references: request.scope.references,
        catalog: { resources: [{ id: "public.orders", fields: [{ id: "status" }] }], relationships: [] } };
      h.access.scopeInventory = async () => ({ ...inventory, references: [...inventory.references, answer] });
      const answerAgain = vi.fn(async () => { throw new Error("Must resume mapping without another prompt"); });
      const send = vi.fn(async wire => {
        expect(JSON.stringify(wire.body)).toContain(answer.id);
        expect(JSON.stringify(wire.body)).toContain(answer.text);
        return response({ ...mapping, read_scope: { ...request.scope.proposal, requirements: [{
          id: "order-meaning", intended_use: "List my orders", references: ["job", answer.id], disposition: "include", targets: [
            { root_resource: "public.orders", resource: "public.orders", operation: "resource" },
            { root_resource: "public.orders", resource: "public.orders", operation: "return", field: "status" },
          ],
        }] } });
      });
      const result = await withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => h.state().recovery, current: async () => h.readContext(),
          write: async value => h.setRecovery(value), progress: () => {} });
        return generateModelReadWorkload({ name: "typed_scope", allowedQuestions: ["List my orders"], provider: "openai", model: "controlled",
          generatedBoundary: h.boundary, apiKey: "inert-test-key", egressAcknowledged: true, deferNarration: true,
          resumeCheckpoint: cp, onCheckpoint: h.host.persist, dependencies: { requestJson: send },
          structuredScope: { protocol: "synapsor.read-scope.v1", current: () => inventory,
            answer: answerAgain, resolveAnswer: ref => h.resolve(ref) } });
      });
      expect(result.analysis.status).toBe("ready"); expect(send).toHaveBeenCalledOnce(); expect(answerAgain).not.toHaveBeenCalled();
      expect(h.state().checkpoint).toBeUndefined(); expect(h.state().questions.at(-1)?.read_scope?.mode).toBe("review");
      expect(h.state().questions.at(-1)?.confirmation).toBeUndefined(); expect(h.state().questions[0]?.raw_answer?.text).toBe(answer.text);
    } finally { await h.cleanup(); }
  });
});
