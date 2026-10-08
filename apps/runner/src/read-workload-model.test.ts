import { operatorBusinessContext, operatorClarificationGate } from "./authoring-operator-presentation.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, authoringTransportCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, prepareAuthoringInterruptedRecovery, permitAuthoringInterruptedRecovery, validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { parseReadWorkloadAssistanceCheckpoint, readWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, presentOperatorQuestion,
  proposeOperatorAnswer, type OperatorQuestion } from "./authoring-operator-question.js";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { AskError, secureAskJsonRequest, type AskProviderDependencies } from "./model-ask.js";
import {
  createModelAuthoringConversation,
  rememberModelAuthoringClarification,
  rememberModelAuthoringTurn,
} from "./model-authoring-conversation.js";
import { generateModelReadWorkload, readWorkloadCatalog, type ModelReadWorkloadInput } from "./read-workload-model.js";
import { ReadWorkloadDraftError } from "./read-workload-diagnostics.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeBinding, type ReadScopeProposal, type ReadScopeReference } from "./read-structured-scope.js";

describe("B64 structured Read producer adapter", () => {
  const original = "Show order status. Use public.orders.status for the order status; no other fields.";
  const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "structured_read",
    name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
  const scope = (): ReadScopeProposal => ({ protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested", requirements: [{
    id: "order-status", intended_use: "Show order status", references: ["job"], disposition: "include", targets: [
      { root_resource: "public.orders", resource: "public.orders", operation: "resource" },
      { root_resource: "public.orders", resource: "public.orders", operation: "return", field: "status" },
    ],
  }] });
  const args = () => ({ allowed: [{ id: "order_status", description: "Show order status", plan: {
    kind: "rows", resource: "public.orders", select: ["status"],
  } }], forbidden: [], read_scope: scope() });
  function setup(requestJson: NonNullable<AskProviderDependencies["requestJson"]>) {
    const boundary = generatedBoundary();
    const catalog = readWorkloadCatalog(boundary);
    const binding: ReadScopeBinding = { request_digest: canonicalJsonDigest(original), source_digest: canonicalJsonDigest(null),
      catalog_digest: catalog.digest, meaning_digest: canonicalJsonDigest(original), applicability_digest: canonicalJsonDigest("this-job"),
      operation_digest: canonicalJsonDigest(boundary) };
    const context = { binding, references: [{ kind: "request" as const, id: "job", digest: binding.request_digest, text: original }],
      catalog: { resources: catalog.resources, relationships: [] } };
    return { input: { name: "structured_scope", allowedQuestions: [original], operatorNamingContext: original,
      provider: "openai" as const, model: "local-scripted", generatedBoundary: boundary, apiKey: "test-key",
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson },
      structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => context } }, context };
  }
  it("uses the actual typed tool, returns unconfirmed scope, and never asks a lexical root question", async () => {
    const requests: unknown[] = [];
    const send = vi.fn(async request => { requests.push(request.body); return response(args()); });
    const result = await generateModelReadWorkload(setup(send).input);
    expect(send).toHaveBeenCalledOnce();
    expect(result.analysis.status).toBe("ready");
    expect(result.read_scope?.proposal).toEqual(scope());
    expect(result.read_scope?.analysis_digest).toBe(canonicalJsonDigest(result.analysis));
    expect(result.read_scope).not.toHaveProperty("confirmation");
    expect(result.authority_granted).toBe(false);
    expect(JSON.stringify(requests)).toContain(READ_SCOPE_PROTOCOL);
    expect(JSON.stringify(requests)).not.toContain("Runner refuses guessed business meaning");
  });
  it("corrects an exact omitted operation within the existing one-correction allowance", async () => {
    let call = 0;
    const send = vi.fn(async () => {
      const value = args(); if (call++ === 0) value.read_scope.requirements[0]!.targets.pop();
      return response(value);
    });
    const result = await generateModelReadWorkload(setup(send).input);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.analysis.status).toBe("ready");
    expect(result.diagnostics?.some(diagnostic => diagnostic.code === "READ_SCOPE_DELTA_REQUIRED")).toBe(true);
  });
  it("never falls back to legacy English handling after a missing typed scope", async () => {
    const send = vi.fn(async () => { const { read_scope: _scope, ...legacy } = args(); return response(legacy); });
    await expect(generateModelReadWorkload(setup(send).input)).rejects.toThrow(/READ_SCOPE_INVALID/u);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects scope context drift during a real provider turn before accepting its proposal", async () => {
    let change = () => {};
    const send = vi.fn(async () => { change(); return response(args()); });
    const configured = setup(send);
    change = () => { configured.context.binding.operation_digest = canonicalJsonDigest("changed-baseline"); };
    await expect(generateModelReadWorkload(configured.input)).rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("saves an unresolved typed question and reopens it without replay or a legacy question", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const send = vi.fn(async () => {
      const value = args(); value.read_scope.requirements[0]!.disposition = "unresolved";
      value.allowed = [];
      value.read_scope.requirements[0]!.unresolved = "Which order status should customers see?";
      return response(value);
    });
    const initial = setup(send);
    await expect(generateModelReadWorkload({ ...initial.input, onCheckpoint: async value => { checkpoint = value; } }))
      .rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(checkpoint?.stage).toBe("waiting");
    expect(checkpoint?.pending_question?.kind).toBe("scope");
    expect(checkpoint?.state.correction_used).toBe(false);
    const noSend = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(noSend).input, resumeCheckpoint: checkpoint,
      onCheckpoint: async value => { checkpoint = value; } })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(send).toHaveBeenCalledOnce(); expect(noSend).not.toHaveBeenCalled();
  });
  it("resumes a captured native answer after its durable decision without reasking or confirming its meaning", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const reference = { question_id: "question-native", revision: 1, answer_id: "answer-native" };
    const answer: ReadScopeReference = { kind: "answer", id: "captured-answer", digest: canonicalJsonDigest("Current fulfillment status."),
      question_id: reference.question_id, answer_id: reference.answer_id, question_revision: 1, text: "Current fulfillment status." };
    const first = setup(vi.fn(async () => {
      const value = args(); value.read_scope.requirements[0]!.disposition = "unresolved";
      value.read_scope.requirements[0]!.unresolved = "Which status?"; return response(value);
    }));
    const capture = vi.fn(async () => reference);
    await expect(generateModelReadWorkload({ ...first.input,
      structuredScope: { ...first.input.structuredScope, answer: capture, resolveAnswer: () => answer },
      onCheckpoint: async value => { checkpoint = value; if (value?.stage === "decided") throw new Error("CAPTURE_SAVED_RESTART"); },
    })).rejects.toThrow("CAPTURE_SAVED_RESTART");
    expect(checkpoint?.stage).toBe("decided"); expect(capture).toHaveBeenCalledOnce();
    const bodies: unknown[] = [], second = setup(vi.fn(async request => {
      bodies.push(request.body); const value = args(); value.read_scope.requirements[0]!.references.push(answer.id); return response(value);
    }));
    const dontAsk = vi.fn();
    const result = await generateModelReadWorkload({ ...second.input, resumeCheckpoint: checkpoint,
      structuredScope: { ...second.input.structuredScope, answer: dontAsk, resolveAnswer: () => answer }, onCheckpoint: async () => {},
    });
    expect(dontAsk).not.toHaveBeenCalled(); expect(second.input.dependencies.requestJson).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies)).toContain(answer.text);
    expect(result.analysis.status).toBe("ready"); expect(result.read_scope).not.toHaveProperty("confirmation");
  });
});

// Labeled fixture successor: these are additional declared operator root facts,
// never inferred from metadata. Preserve the complete original request/context;
// field meaning, Source approval and every native response remain independent.
function withDeclaredRoot(input: ModelReadWorkloadInput, definition: string): ModelReadWorkloadInput {
  const original = input.operatorNamingContext ?? input.allowedQuestions.join("\n");
  return { ...input, operatorNamingContext: `${original}\n${definition}` };
}

function diagnosticResponse(kind: "invalid_id" | "valid" | "missing" | "malformed" | "arguments" | "blocked") {
  if (kind === "malformed") return { status: 200, body: { output: [] } };
  if (kind === "missing") return { status: 200, body: {
    choices: [{ message: { role: "assistant", content: "I can help with that." } }],
  } };
  return { status: 200, body: { output: [{
    type: "function_call", call_id: "call_read_diagnostic", name: "runner__submit_read_workloads",
    arguments: kind === "arguments" ? "{broken" : JSON.stringify({
      allowed: [{
        id: kind === "invalid_id" ? "INVALID ID" : "my_orders",
        description: "List my orders",
        plan: { kind: "rows", resource: "public.orders", select: [kind === "blocked" ? "nonexistent" : "status"] },
      }], forbidden: [],
    }),
  }] } };
}

describe("durable Read assistance producer checkpoint", () => {
  const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "owned_read_assistance", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
  const request = { resource: "public.orders", field: "status", reason: "Missing business explanation for this view", question: "Which fulfillment stages should this view describe?" };
  const setup = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>) => ({ name: "owned_assistance", allowedQuestions: ["List my orders"],
    operatorNamingContext: "List my orders\npublic.orders means orders.",
    provider: "openai" as const, model: "owned-local-fixture", generatedBoundary: generatedBoundary(), apiKey: "test-key", egressAcknowledged: true,
    deferNarration: true, dependencies: { requestJson } });

  it("saves the completed question before pause and reopens its wait without an initial provider resend", async () => {
    let checkpoint: any;
    const events: string[] = [], requestJson = vi.fn(async () => { events.push("provider"); return response({ clarification_request: request }); });
    await expect(generateModelReadWorkload({ ...setup(requestJson), onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); events.push(value.stage); },
      clarificationHandler: async () => { events.push("handler"); expect(checkpoint?.stage).toBe("waiting"); return undefined; } } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(events).toEqual(["dispatching", "provider", "dispatching", "waiting", "handler"]);
    expect(checkpoint.pending_question.request).toEqual(request);
    expect(checkpoint.state.call_count).toBe(1);
    const noSend = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: checkpoint, onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); },
      clarificationHandler: async () => undefined } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(noSend).not.toHaveBeenCalled();
  });

  it("saves a canonical answer separately and resumes its real next mapping without reprompting", async () => {
    let checkpoint: any;
    const firstSend = vi.fn(async () => response({ clarification_request: request }));
    const answer = "Show the current purchase fulfillment stage";
    await expect(generateModelReadWorkload({ ...setup(firstSend), onCheckpoint: async (value: any) => { checkpoint = structuredClone(value);
      if (value.stage === "decided") throw new Error("OWNED_CRASH_AFTER_DECISION_COMMIT"); },
      clarificationHandler: async () => ({ state: "answered", answer }) } as any)).rejects.toThrow("OWNED_CRASH_AFTER_DECISION_COMMIT");
    expect(checkpoint.stage).toBe("decided"); expect(checkpoint.pending_question.decision).toEqual({ state: "answered", answer });
    const bodies: unknown[] = [], requestJson = vi.fn(async r => { bodies.push(r.body); return diagnosticResponse("valid"); }), handler = vi.fn();
    const result = await generateModelReadWorkload({ ...setup(requestJson), resumeCheckpoint: checkpoint, onCheckpoint: async () => {}, clarificationHandler: handler } as any);
    expect(handler).not.toHaveBeenCalled(); expect(firstSend).toHaveBeenCalledOnce(); expect(requestJson).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies[0])).toContain(answer); expect(JSON.stringify(bodies[0])).toContain("Reviewed business clarification");
    expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false);
  });

  it("leaves Escape or EOF at the value wait pending and accepts intentional without_values only as its typed decision", async () => {
    let checkpoint: any;
    const valueRequest = { ...request, reason: "Exact status vocabulary is indispensable", question: "May Runner use the separately reviewed status vocabulary?" };
    const first = vi.fn(async () => response({ value_request: valueRequest }));
    const boundary = generatedBoundaryWithoutStatusEnum();
    await expect(generateModelReadWorkload({ ...setup(first), generatedBoundary: boundary, onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); }, valueRequestHandler: async () => undefined } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(checkpoint.stage).toBe("waiting"); expect(checkpoint.pending_question).not.toHaveProperty("decision"); expect(first).toHaveBeenCalledOnce();
    const bodies: unknown[] = [], next = vi.fn(async r => { bodies.push(r.body); return diagnosticResponse("valid"); });
    await generateModelReadWorkload({ ...setup(next), generatedBoundary: boundary, resumeCheckpoint: checkpoint, onCheckpoint: async (value: any) => { if (value && value.stage !== "dispatching") checkpoint = structuredClone(value); },
      valueRequestHandler: async () => ({ state: "without_values" }) } as any);
    expect(checkpoint.stage).toBe("decided"); expect(checkpoint.pending_question.decision).toEqual({ state: "without_values" }); expect(next).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies[0])).toContain("declined observed-value context");
  });

  it("stops at a failed coordinated checkpoint save before dispatching the human handler or another generation", async () => {
    const requestJson = vi.fn(async () => response({ clarification_request: request })), handler = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(requestJson), onCheckpoint: async (value:ReadWorkloadAssistanceCheckpoint|undefined) => { if (value?.stage === "waiting") throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED"); }, clarificationHandler: handler } as any)).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(handler).not.toHaveBeenCalled(); expect(requestJson).toHaveBeenCalledOnce();
  });

  it.each(["name", "questions", "catalog", "roots", "model"] as const)("refuses changed canonical %s before reopened handler or provider dispatch", async change => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const first = setup(async () => response({ clarification_request: request }));
    await expect(generateModelReadWorkload({ ...first, onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: async () => undefined })).rejects.toThrow("AUTHORING_PAUSED");
    const noSend = vi.fn(), handler = vi.fn(), resumed = { ...setup(noSend), resumeCheckpoint: checkpoint, clarificationHandler: handler };
    if (change === "name") resumed.name = "different_read_job";
    if (change === "questions") resumed.allowedQuestions = ["A different business read"];
    if (change === "catalog") resumed.generatedBoundary.pack.resources[0]!.label = "Changed meaning";
    if (change === "model") resumed.model = "different-local-fixture";
    const extra = change === "roots" ? { principalScopedRootResources: [] } : {};
    await expect(generateModelReadWorkload({ ...resumed, ...extra })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noSend).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

  it("reparses a retained target against the actual current catalog even when storage hashes are well formed", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    await expect(generateModelReadWorkload({ ...setup(async () => response({ clarification_request: request })), onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: async () => undefined })).rejects.toThrow("AUTHORING_PAUSED");
    const { digest: _digest, schema_version: _schema, ...core } = checkpoint!;
    if(core.stage!=="waiting")throw new Error("Expected the actual waiting target checkpoint");
    if(core.pending_question.kind!=="clarification")throw new Error("Expected the original field clarification checkpoint");
    core.pending_question.request.field = "never_inspected_field";
    const changed = readWorkloadAssistanceCheckpoint(core), noSend = vi.fn(), handler = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: changed, clarificationHandler: handler })).rejects.toThrow("exact model-visible field");
    expect(noSend).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(() => parseReadWorkloadAssistanceCheckpoint({ ...changed, state: { ...changed.state, arbitrary_failed_args: { secret: "not_persisted" } } })).toThrow("CHECKPOINT_INVALID");
  });

  it("keeps a used correction across resume and does not buy another invalid mapping attempt", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const first = vi.fn().mockResolvedValueOnce(diagnosticResponse("missing")).mockResolvedValueOnce(response({ clarification_request: request }));
    await expect(generateModelReadWorkload({ ...setup(first), onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: async () => undefined })).rejects.toThrow("AUTHORING_PAUSED");
    expect(first).toHaveBeenCalledTimes(2); expect(checkpoint?.state.correction_used).toBe(true); expect(checkpoint?.state.attempt).toBe(2);
    const next = vi.fn(async () => diagnosticResponse("blocked"));
    const result = await generateModelReadWorkload({ ...setup(next), resumeCheckpoint: checkpoint, onCheckpoint: async value => { checkpoint = value; },
      clarificationHandler: async () => ({ state: "answered", answer: "The purchase fulfillment stage" }) });
    expect(result.analysis.status).toBe("blocked"); expect(checkpoint?.stage).toBe("dispatching");
    expect(checkpoint?.state.clarified_targets).toMatchObject([{ resource: request.resource, field: request.field, answer: "The purchase fulfillment stage" }]);
    expect(next).toHaveBeenCalledOnce();
  });

  it("exposes a cleared checkpoint only with the actual accepted Read result and stops if its CAS commit fails", async () => {
    const seen: Array<{ checkpoint: ReadWorkloadAssistanceCheckpoint | undefined; result: unknown }> = [];
    const valid = vi.fn(async () => diagnosticResponse("valid"));
    await expect(generateModelReadWorkload({ ...setup(valid), onCheckpoint: async (checkpoint, _boundary, result) => {
      seen.push({ checkpoint, result }); if (!checkpoint) throw new Error("OWNED_ACCEPTED_READ_CAS_CHANGED");
    } })).rejects.toThrow("OWNED_ACCEPTED_READ_CAS_CHANGED");
    expect(seen).toHaveLength(3); expect(seen.slice(0,2).every(event => event.checkpoint?.stage === "dispatching" && event.result === undefined)).toBe(true); expect(seen[2]!.checkpoint).toBeUndefined();
    expect(seen[2]!.result).toHaveProperty("analysis.status", "ready"); expect(valid).toHaveBeenCalledOnce();
  });

  it("retains approved values and the one-value-request limit when a later business question pauses", async () => {
    const boundary = generatedBoundaryWithoutStatusEnum(); let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const first = vi.fn().mockResolvedValueOnce(response({ value_request: { ...request, question: "Use the separately approved exact vocabulary?" } })).mockResolvedValueOnce(response({ clarification_request: request }));
    await expect(generateModelReadWorkload({ ...setup(first), generatedBoundary: boundary, onCheckpoint: async value => { checkpoint = value; },
      valueRequestHandler: async () => ({ state: "provided", resource: request.resource, field: request.field, values: ["queued"], egressAcknowledged: true }),
      clarificationHandler: async () => undefined })).rejects.toThrow("AUTHORING_PAUSED");
    expect(checkpoint?.state.value_request_resolved).toBe(true); expect(checkpoint?.state.approved_value_context?.values).toEqual(["queued"]);
    const values = vi.fn(), next = vi.fn(async () => response({ value_request: request }));
    await expect(generateModelReadWorkload({ ...setup(next), generatedBoundary: boundary, resumeCheckpoint: checkpoint, onCheckpoint: async value => { checkpoint = value; },
      clarificationHandler: async () => ({ state: "answered", answer: "The fulfillment stage" }), valueRequestHandler: values })).rejects.toThrow("READ_WORKLOAD_DRAFT_FAILED");
    expect(values).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
  });

  it("retains four business answers and stops a fifth request across pauses without re-asking accepted targets", async () => {
    const boundary = generatedBoundary();
    for (const field of ["region", "category", "description"]) { boundary.pack.resources[0]!.field_types[field] = "text"; boundary.pack.resources[0]!.selectable_fields.push(field); }
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const fields = ["status", "amount", "region", "category", "description"];
    const questionFor = (field: string) => ({ ...request, field, question: `Which business explanation belongs to ${field}?` });
    let sent = 0;
    const sends = vi.fn(async () => response({ clarification_request: questionFor(fields[sent++]!) }));
    let answers = 0;
    await expect(generateModelReadWorkload({ ...setup(sends), generatedBoundary: boundary, onCheckpoint: async value => { checkpoint = value; },
      clarificationHandler: async () => ++answers <= 2 ? { state: "answered", answer: "Reviewed business meaning" } : undefined })).rejects.toThrow("AUTHORING_PAUSED");
    expect(checkpoint?.state.clarified_targets.map(t => t.field)).toEqual(["status", "amount"]); expect(sent).toBe(3);
    const nextHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Reviewed business meaning" }));
    await expect(generateModelReadWorkload({ ...setup(sends), generatedBoundary: boundary, resumeCheckpoint: checkpoint, onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: nextHandler })).rejects.toThrow("READ_WORKLOAD_DRAFT_FAILED");
    expect(nextHandler.mock.calls).toHaveLength(2); expect(sent).toBe(5);
    expect(checkpoint?.state.clarified_targets.map(t => t.field)).toEqual(["status", "amount", "region", "category"]); // Fourth answer retained in the pre-dispatch mapping snapshot.
  });

  it.each(["initial", "remap"] as const)("carries the real completed %s transport sidecar into the waiting checkpoint before its owner handler", async mode => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined, state: AuthoringTransportState = { version: 1, operations: [] };
    let sends = 0;
    const followupRequest = { ...request, field: "amount", question: "Which business meaning belongs to this amount?" };
    const server = createServer(async (req, res) => { for await (const _chunk of req) {} sends++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response({ clarification_request: sends === 1 ? request : followupRequest }).body)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    const host = { available: () => true, read: () => state, current: async () => canonicalJsonDigest("owned immutable Read target"),
      write: async (value: AuthoringTransportState) => { validateAuthoringTransportState(value); state = structuredClone(value); } };
    const entering = () => withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery(host); return generateModelReadWorkload({
      ...setup(r => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })), onCheckpoint: async value => { checkpoint = structuredClone(value); },
      clarificationHandler: async asked => { const op = state.operations.at(-1)!;
        if(!checkpoint || checkpoint.stage!=="waiting")throw new Error("Expected the actual waiting question checkpoint");
        expect(checkpoint.pending_question.completion).toMatchObject({ operation_id: op.id, request_digest: op.request_digest,
          response_digest: canonicalJsonDigest(response({ clarification_request: asked }).body) });
        if (mode === "remap" && asked.field === "status") return { state: "answered", answer: "The purchase fulfillment stage" };
        return undefined; } }); });
    try { await expect(entering()).rejects.toThrow("AUTHORING_PAUSED"); expect(sends).toBe(mode === "initial" ? 1 : 2); expect(state.operations.at(-1)?.state).toBe("handled"); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("checkpoints the exact bounded Read correction sequence before its question and continues once after restart", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    let state: AuthoringTransportState = { version: 1, operations: [] }, sends = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {}
      sends++;
      const args = sends === 1 ? { allowed: [{ id: "orders", description: "Read purchase stage",
        plan: { kind: "rows", resource: "public.orders", select: ["absent_field"] } }], forbidden: [] }
        : sends === 2 ? { clarification_request: request }
        : { allowed: [{ id: "orders", description: "Read purchase stage",
          plan: { kind: "rows", resource: "public.orders", select: ["status"] } }], forbidden: [] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "completed", ...response(args).body }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    const host = { available: () => true, read: () => state,
      current: async () => canonicalJsonDigest("owned immutable Read target"),
      write: async (value: AuthoringTransportState) => { validateAuthoringTransportState(value); state = structuredClone(value); } };
    const save = async (next: ReadWorkloadAssistanceCheckpoint | undefined) => {
      if (next?.stage === "waiting" && next.digest !== checkpoint?.digest) state = authoringTransportCheckpoint(authoringQuestionCheckpoint(state,
        { digest: next.digest, consumer: "read_clarification", pending_question: next.pending_question }))!;
      if (next?.stage === "decided") state = authoringQuestionAnswerCheckpoint(state,
        { digest: checkpoint!.digest, consumer: "read_clarification", pending_question: checkpoint!.pending_question },
        { digest: next.digest, operator_messages: [(next.pending_question.decision as { answer: string }).answer] })!;
      checkpoint = structuredClone(next);
    };
    const entering = (resume: boolean) => withAuthoringGenerationRecovery(() => {
      configureAuthoringGenerationRecovery(host);
      return generateModelReadWorkload({ ...setup(r => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })),
        ...(resume ? { resumeCheckpoint: checkpoint } : {}), onCheckpoint: save,
        clarificationHandler: async () => resume ? { state: "answered", answer: "The purchase fulfillment stage" } : undefined });
    });
    try {
      await expect(entering(false)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
      expect(sends).toBe(2);
      expect(checkpoint?.stage).toBe("waiting");
      expect(state.operations.map(op => op.state)).toEqual(["checkpointed", "checkpointed"]);
      const result = await entering(true);
      expect(result.analysis.status).toBe("ready");
      expect(sends).toBe(3);
      expect(checkpoint).toBeUndefined();
      expect(state.operations[1]?.question_handoff?.answered).toMatchObject({ answer: "The purchase fulfillment stage", actor: "local_installation_operator" });
      expect(state.operations.flatMap(op => op.attempts).every(attempt => attempt.outcome === "response")).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("restores the pending relationship review counter without resending or charging the same review slot twice", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const linkRequest = { resource: request.resource, category: "relationship_support" as const, reason: "The related business detail needs an inspected link", question: "Prepare the missing related business detail path." };
    const first = vi.fn(async () => response({ clarification_request: linkRequest })), review = vi.fn(async () => undefined);
    await expect(generateModelReadWorkload({ ...setup(first), relationshipReviewHandler: review,
      onCheckpoint: async value => { checkpoint = value; } })).rejects.toThrow("READ_RELATIONSHIP_REVIEW_PENDING");
    if(!checkpoint || checkpoint.stage!=="waiting")throw new Error("Expected the actual pending relationship checkpoint");
    expect(checkpoint.pending_question.kind).toBe("relationship"); expect(checkpoint?.state.relationship_reviews).toBe(1);
    const noSend = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: checkpoint, relationshipReviewHandler: review,
      onCheckpoint: async value => { checkpoint = value; } })).rejects.toThrow("READ_RELATIONSHIP_REVIEW_PENDING");
    expect(checkpoint?.state.relationship_reviews).toBe(1); expect(noSend).not.toHaveBeenCalled(); expect(review).toHaveBeenCalledTimes(2);
    const { digest: _digest, schema_version: _schema, ...core } = checkpoint!;
    expect(() => readWorkloadAssistanceCheckpoint({ ...core, state: { ...core.state, relationship_reviews: 4 } })).toThrow("CHECKPOINT_INVALID");
  });

  it("retains exact typed history through dispatch without reopening the decided value request", async () => {
    let decided: ReadWorkloadAssistanceCheckpoint | undefined; const dispatches: ReadWorkloadAssistanceCheckpoint[] = [];
    const value = { ...request, question: "May Runner use separately reviewed fulfillment words?" };
    const sends = vi.fn().mockResolvedValueOnce(response({ value_request: value })).mockResolvedValueOnce(diagnosticResponse("valid"));
    const result = await generateModelReadWorkload({ ...setup(sends), generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      valueRequestHandler: async () => ({ state: "without_values" }), onCheckpoint: async cp => {
        if(cp?.stage === "decided") decided = structuredClone(cp);
        if(cp?.stage === "dispatching") dispatches.push(structuredClone(cp));
      } });
    expect(result.analysis.status).toBe("ready"); expect(sends).toHaveBeenCalledTimes(2);
    const final = dispatches.at(-1)!;
    if(!decided || decided.stage !== "decided" || final.stage !== "dispatching") throw new Error("Expected actual decided and dispatching records");
    expect(final.previous_question).toEqual({ stage: "decided", pending_question: decided.pending_question }); expect(final).not.toHaveProperty("pending_question");
    const {digest:_d,schema_version:_s,...body}=final, previous = decided.pending_question;
    expect(() => readWorkloadAssistanceCheckpoint({ ...body, previous_question: { stage: "waiting" as const, pending_question: previous } })).toThrow("CHECKPOINT_INVALID");
  });

  it("outer controller callback reservation survives a raw save acknowledgement loss without accepting its result", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined, state: AuthoringTransportState = { version: 1, operations: [] }, sends = 0;
    const snapshots: ReadWorkloadAssistanceCheckpoint[] = [];
    const server = createServer(async (req, res) => { for await (const _chunk of req) {} sends++;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "completed", ...diagnosticResponse("valid").body })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    const host = { available: () => true, read: () => state, current: async () => canonicalJsonDigest("fixed current workload business input"),
      write: async (value: AuthoringTransportState) => { validateAuthoringTransportState(value); state = structuredClone(value); } };
    const entering = (resume: boolean) => withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery(host);
      return generateModelReadWorkload({ ...setup(r => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })),
        ...(resume ? { resumeCheckpoint: checkpoint } : {}), onCheckpoint: async value => {
          checkpoint = structuredClone(value); if (value) snapshots.push(structuredClone(value));
          if (!resume && value?.stage === "dispatching" && value.state.call_count === 1) throw new Error("OWNED_RAW_COUNTER_ACK_LOST");
        } }); });
    try {
      await expect(entering(false)).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
      expect(sends).toBe(1); expect(checkpoint).toMatchObject({ stage: "dispatching", state: { call_count: 1 } });
      expect(state.operations[0]?.state).toBe("partial"); const old = JSON.stringify(state.operations[0]);
      await withAuthoringGenerationRecovery(async () => { configureAuthoringGenerationRecovery(host); await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint!.digest)); });
      const result = await entering(true); expect(result.analysis.status).toBe("ready"); expect(sends).toBe(2);
      expect(snapshots.at(-1)?.state.call_count).toBe(2); expect(JSON.stringify(state.operations[0])).toBe(old);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("outer controller callback limit refuses an exhausted checkpoint before another HTTP request", async () => {
    let saved: ReadWorkloadAssistanceCheckpoint | undefined;
    const never = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(never), onCheckpoint: async value => {
      if(value?.stage === "dispatching") { saved = value; throw new Error("OWNED_FIRST_DISPATCH_CAPTURED"); }
    } })).rejects.toThrow("OWNED_FIRST_DISPATCH_CAPTURED"); expect(never).not.toHaveBeenCalled();
    if(!saved || saved.stage !== "dispatching") throw new Error("Expected the actual initial dispatch checkpoint");
    const { digest: _digest, schema_version: _schema, ...body } = saved;
    // Pure controller boundary fixture, not historical evidence or business authority.
    const exhausted = readWorkloadAssistanceCheckpoint({ ...body, state: { ...body.state, call_count: 8 } });
    const noHttp = vi.fn(); await expect(generateModelReadWorkload({ ...setup(noHttp), resumeCheckpoint: exhausted }))
      .rejects.toThrow("READ_WORKLOAD_SUBMISSION_REFUSED"); expect(noHttp).not.toHaveBeenCalled(); expect(exhausted.state.call_count).toBe(8);
  });

  it("records mechanical limits before a native interrupted dispatch and restores them without another redirect", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined, state: AuthoringTransportState = { version: 1, operations: [] }, sends = 0;
    const mechanical = { resource: request.resource, reason: "Need the opaque selection reference", question: "Which column supplies the opaque selection reference?" };
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {} sends++;
      if (sends === 2) { res.writeHead(200, { "content-type": "application/json", "content-length": "9999" }); res.write('{"unfinished":'); setTimeout(() => res.destroy(), 10); return; }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "completed", ...response({ clarification_request: mechanical }).body }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    const host = { available: () => true, read: () => state, current: async () => canonicalJsonDigest("fixed current Read metadata and ordinary input"),
      write: async (value: AuthoringTransportState) => { validateAuthoringTransportState(value); state = structuredClone(value); } };
    const entering = (resume: boolean) => withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery(host);
      return generateModelReadWorkload({ ...setup(r => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })),
        ...(resume ? { resumeCheckpoint: checkpoint } : {}), onCheckpoint: async value => { checkpoint = structuredClone(value); } }); });
    try {
      await expect(entering(false)).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
      expect(sends).toBe(2); expect(state.operations.at(-1)?.state).toBe("partial");
      expect(checkpoint).toMatchObject({ stage: "dispatching", state: { call_count: 1, attempt: 2, correction_used: true, mechanical_clarification_resolved: true, resolved_mechanical_request: mechanical } });
      expect(checkpoint).not.toHaveProperty("pending_question");
      const old = JSON.stringify(state.operations.at(-1));
      await withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery(host);
        await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint!.digest, undefined, state.operations[0]!.id), { mode: "local_review" });
        await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint!.digest));
      });
      await expect(entering(true)).rejects.toThrow("READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED");
      expect(sends).toBe(3); expect(JSON.stringify(state.operations[1])).toBe(old);
      expect(checkpoint?.state.call_count).toBe(2); expect(checkpoint?.state.attempt).toBe(3);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("preserves its one mechanical redirect after a later business wait resumes", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const mechanical = { resource: request.resource, reason: "Need the opaque selection reference", question: "Which column supplies the opaque selection reference?" };
    const first = vi.fn().mockResolvedValueOnce(response({ clarification_request: mechanical })).mockResolvedValueOnce(response({ clarification_request: request }));
    await expect(generateModelReadWorkload({ ...setup(first), onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: async () => undefined })).rejects.toThrow("AUTHORING_PAUSED");
    expect(checkpoint?.state.mechanical_clarification_resolved).toBe(true); expect(checkpoint?.state.correction_used).toBe(true);
    const next = vi.fn(async () => response({ clarification_request: mechanical }));
    await expect(generateModelReadWorkload({ ...setup(next), resumeCheckpoint: checkpoint, onCheckpoint: async value => { checkpoint = value; },
      clarificationHandler: async () => ({ state: "answered", answer: "The fulfillment stage" }) })).rejects.toThrow("READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED");
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("B41 host-owned Read meaning resolution", () => {
  const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "b41_read",
    name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
  const mapped = { allowed: [{ id: "shipments", description: "Read shipment lifecycle",
    plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [] };
  const setup = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>, boundary = opaqueGeneratedBoundary()) => {
    boundary.pack.resources[0]!.label = "Shipments";
    return { name: "b41_read", allowedQuestions: ["Read shipment lifecycle"], generatedBoundary: boundary,
      operatorNamingContext: "Read shipment lifecycle\npublic.tbl_7 means shipments.",
      provider: "openai" as const, model: "gpt-test", apiKey: "test-key", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson } };
  };
  const policy = (text: string) => {
    const conversation = createModelAuthoringConversation(), session = newPolicySourceSession();
    const snapshot = policyTextSnapshot(Buffer.from(text), "Rules.txt");
    session.snapshots.push(snapshot); session.active = snapshot.version;
    session.approvals.push({ digest: snapshot.digest, destination: authoringDestination({ provider: "openai", model: "gpt-test" }) });
    conversation.policySources = session;
    return conversation;
  };
  it("901 retains an explicitly unknown answer as pending and resumes without an initial replay", async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }))
      .mockResolvedValue(response(mapped));
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const save = async (value: ReadWorkloadAssistanceCheckpoint | undefined) => { checkpoint = value; };
    await expect(generateModelReadWorkload({ ...setup(requestJson), onCheckpoint: save,
      clarificationHandler: async () => ({ state: "answered", answer: "I don't know" }) })).rejects.toThrow("AUTHORING_PAUSED");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(checkpoint?.stage).toBe("waiting");
    expect(checkpoint!.state).toMatchObject({ unresolved_answers: [expect.objectContaining({ answer: "I don't know", actor: "local_installation_operator" })] });
    const result = await generateModelReadWorkload({ ...setup(requestJson), resumeCheckpoint: checkpoint, onCheckpoint: save,
      clarificationHandler: async () => ({ state: "answered", answer: "Shipment lifecycle status" }) });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.source.meaning_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "col_2", reference: expect.objectContaining({ text: "Shipment lifecycle status" }) }) ]));
    expect(result.workload.source.meaning_attempts).toEqual([
      expect.objectContaining({ answer: "I don't know", actor: "local_installation_operator", field: "col_2" }) ]);
  });
  it("retains the four-answer budget across unknown-answer pauses, with no fifth answer or generation", async () => {
    const requestJson = vi.fn().mockResolvedValue(response(mapped));
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const save = async (value: ReadWorkloadAssistanceCheckpoint | undefined) => { checkpoint = structuredClone(value); };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const handler = vi.fn(async () => ({ state: "answered" as const, answer: "I don't know" }));
      await expect(generateModelReadWorkload({ ...setup(requestJson), ...(checkpoint ? { resumeCheckpoint: checkpoint } : {}),
        onCheckpoint: save, clarificationHandler: handler })).rejects.toThrow("AUTHORING_PAUSED");
      expect(handler).toHaveBeenCalledOnce();
      expect(checkpoint?.stage).toBe("waiting");
      expect(checkpoint?.state.unresolved_answers).toHaveLength(attempt);
      expect(checkpoint?.pending_question).not.toHaveProperty("decision");
      expect(checkpoint?.state.call_count).toBe(1);
      expect(checkpoint?.state.attempt).toBe(1);
      expect(requestJson).toHaveBeenCalledOnce();
    }
    const before = structuredClone(checkpoint), handler = vi.fn(async () => ({ state: "answered" as const, answer: "The shipment lifecycle" }));
    await expect(generateModelReadWorkload({ ...setup(requestJson), resumeCheckpoint: checkpoint,
      onCheckpoint: save, clarificationHandler: handler })).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_LIMIT");
    expect(handler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledOnce();
    expect(checkpoint).toEqual(before);
  });
  it.each(["save_failed", "acknowledgement_uncertain"])("does not dispatch after an unknown-answer %s", async mode => {
    const requestJson = vi.fn().mockResolvedValue(response(mapped));
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const handler = vi.fn(async () => ({ state: "answered" as const, answer: "I don't know" }));
    await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
      onCheckpoint: async value => {
        if (value?.state.unresolved_answers?.length) {
          if (mode === "acknowledgement_uncertain") checkpoint = structuredClone(value);
          throw new Error("OWNED_UNKNOWN_ANSWER_SAVE_NOT_ACKNOWLEDGED");
        }
        checkpoint = structuredClone(value);
      } })).rejects.toThrow("OWNED_UNKNOWN_ANSWER_SAVE_NOT_ACKNOWLEDGED");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(checkpoint?.stage).toBe("waiting");
    expect(checkpoint?.pending_question).not.toHaveProperty("decision");
    expect(checkpoint?.state.unresolved_answers?.length ?? 0).toBe(mode === "acknowledgement_uncertain" ? 1 : 0);
    const before = structuredClone(checkpoint), noSend = vi.fn();
    await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: checkpoint,
      onCheckpoint: async value => { checkpoint = structuredClone(value); }, clarificationHandler: async () => undefined }))
      .rejects.toThrow("AUTHORING_PAUSED");
    expect(noSend).not.toHaveBeenCalled();
    expect(checkpoint).toEqual(before);
  });
  it.each(["verbatim_conflicting_quote", "no_model_quote"])("requires a new attributed interpretation for %s rather than selecting a Source definition", async mode => {
    const first = "public.tbl_7.col_2 is the shipment lifecycle stage.";
    const text = `${first}\npublic.tbl_7.col_2 is the customer credit band.`;
    const requestJson = vi.fn().mockResolvedValue(response({ ...mapped, ...(mode === "verbatim_conflicting_quote"
      ? { operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: first }] } : {}) }));
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const handler = vi.fn(async () => undefined);
    await expect(generateModelReadWorkload({ ...setup(requestJson), conversation: policy(text),
      onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: handler })).rejects.toThrow("AUTHORING_PAUSED");
    expect(handler).toHaveBeenCalledOnce();
    if(!checkpoint || checkpoint.stage!=="waiting")throw new Error("Expected the actual pending interpretation checkpoint");
    expect(checkpoint.pending_question.question).toContain("new interpretation");
    expect(checkpoint?.stage).toBe("waiting");
    expect(requestJson).toHaveBeenCalledOnce();
  });
  it.each(["unknown", "conflicting"])("901 routes %s Source knowledge to a plain attributed decision, not first-match meaning", async kind => {
    const text = kind === "unknown" ? "public.tbl_7.col_2 is unknown to the owner; ask before assigning business meaning."
      : "public.tbl_7.col_2 is the shipment lifecycle stage.\npublic.tbl_7.col_2 is the customer credit band.\nThese descriptions conflict; no reviewed precedence exists.";
    const conversation = policy(text);
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }))
      .mockResolvedValue(response(mapped));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Shipment lifecycle status" }));
    const result = await generateModelReadWorkload({ ...setup(requestJson), conversation, clarificationHandler });
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(conversation.policySources!.snapshots[0]!.text).toBe(text);
    expect(result.workload.source.meaning_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "col_2", reference: expect.objectContaining({ kind: "answered_clarification", text: "Shipment lifecycle status" }) }) ]));
  });
  it("repairs a misquoted established Source meaning without requiring quote echo or another owner answer", async () => {
    const quote = "public.tbl_7.col_2 means shipment lifecycle status.";
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: `Invented prefix: ${quote}` }] }))
      .mockResolvedValue(response(mapped));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    const result = await generateModelReadWorkload({ ...setup(requestJson), conversation: policy(quote), clarificationHandler });
    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(result.diagnostics?.some(item => item.code === "READ_WORKLOAD_NAMING_EVIDENCE_INVALID")).toBe(true);
    expect(JSON.stringify(requestJson.mock.calls[1])).toContain(quote);
    expect(result.authority_granted).toBe(false);
  });
  it("keeps a repeat fabricated claim terminal instead of asking the owner to repeat established meaning", async () => {
    const quote = "public.tbl_7.col_2 means shipment lifecycle status.";
    const requestJson = vi.fn().mockResolvedValue(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "It contains a private credit balance" }] }));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    await expect(generateModelReadWorkload({ ...setup(requestJson), conversation: policy(quote), clarificationHandler }))
      .rejects.toThrow("READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).not.toHaveBeenCalled();
  });
  it("does not let an incomplete model plan erase an exact operator-requested field", async () => {
    const omitted = { allowed: [{ id: "shipments", description: "Read shipments",
      plan: { kind: "rows", resource: "public.tbl_7", select: ["col_1"] } }], forbidden: [] };
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...omitted,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }))
      .mockResolvedValue(response(omitted));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Shipment lifecycle status" }));
    await expect(generateModelReadWorkload({ ...setup(requestJson), operatorNamingContext: "Read public.tbl_7.col_2 for this job.", clarificationHandler }))
      .rejects.toThrow("READ_WORKLOAD_REQUIRED_TASK_FIELD_OMITTED");
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledTimes(3);
  });
  it.each([
    "Read the dispatch review stage in public.tbl_7.col_2; no activation or execution.",
    "Read the current workflow state in public.tbl_7.col_2; no Action draft or execution.",
    "Read public.tbl_7.col_2 with no execution permission.",
    "Read public.tbl_7.col_2 without executing any Action.",
  ])("refuses an omitted operator-requested field after plain meaning resolution: %s", async operatorNamingContext => {
    const boundary = opaqueGeneratedBoundary();
    // Use an ordinary identity field so this negative exercises the requested
    // business-field question, not an unrelated opaque-PK naming question.
    boundary.pack.resources[0]!.primary_key = "id";
    boundary.pack.resources[0]!.field_types.id = "uuid";
    boundary.pack.resources[0]!.selectable_fields.push("id");
    const omitted = { allowed: [{ id: "shipments", description: "Read shipment stage",
      plan: { kind: "rows", resource: "public.tbl_7", select: ["id"] } }], forbidden: [] };
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...omitted,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }))
      .mockResolvedValue(response(omitted));
    const clarificationHandler = vi.fn(async question => {
      expect(question).toMatchObject({ resource: "public.tbl_7", field: "col_2" });
      return { state: "answered" as const, answer: "The shipment workflow state" };
    });
    await expect(generateModelReadWorkload({ ...setup(requestJson, boundary), operatorNamingContext, clarificationHandler }))
      .rejects.toThrow("READ_WORKLOAD_REQUIRED_TASK_FIELD_OMITTED");
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledTimes(3);
  });
  it("allows the same ordinary requested-use wording when the proposed Read retains the required field", async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }))
      .mockResolvedValue(response(mapped));
    const events: string[] = [];
    const result = await generateModelReadWorkload({ ...setup(async request => {
      events.push("local_reply"); return requestJson(request);
    }), operatorNamingContext: "Read the current workflow state in public.tbl_7.col_2; no Action draft or execution.",
    onCheckpoint: async checkpoint => { events.push(checkpoint?.stage ?? "accepted"); },
    clarificationHandler: async () => { events.push("answer"); return { state: "answered", answer: "The shipment workflow state" }; } });
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed[0]!.plan).toMatchObject({ select: ["col_2"] });
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["dispatching", "local_reply", "dispatching", "waiting", "answer", "decided", "dispatching", "local_reply", "dispatching", "accepted"]);
  });
  it("exposes the same typed pending meaning in a durable headless path before spending a correction", async () => {
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const requestJson = vi.fn().mockResolvedValue(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }));
    await expect(generateModelReadWorkload({ ...setup(requestJson), onCheckpoint: async value => { checkpoint = value; } }))
      .rejects.toThrow("READ_WORKLOAD_CLARIFICATION_REQUIRED");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(checkpoint).toMatchObject({ stage: "waiting", state: { call_count: 1, correction_used: false },
      pending_question: { kind: "clarification", request: { resource: "public.tbl_7", field: "col_2" } } });
  });
  it("does not equate a generated label with meaning when an opaque field has no model quote", async () => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.field_metadata = { col_2: { label: "Lifecycle" } };
    const requestJson = vi.fn().mockResolvedValue(response(mapped));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "The shipment lifecycle status" }));
    const result = await generateModelReadWorkload({ ...setup(requestJson, boundary), clarificationHandler });
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.source.meaning_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "public.tbl_7", field: "col_2", reference: expect.objectContaining({ kind: "answered_clarification" }) }) ]));
  });
  it("refuses a competing Source change in the actual question handler before follow-up egress", async () => {
    const conversation = policy("Use the shipment lifecycle for this task.");
    const requestJson = vi.fn().mockResolvedValue(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "Invented meaning" }] }));
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    await expect(generateModelReadWorkload({ ...setup(requestJson), conversation,
      onCheckpoint: async value => { checkpoint = value; }, clarificationHandler: async () => {
        conversation.policySources!.snapshots[0]!.text = "Changed source";
        return { state: "answered", answer: "The lifecycle stage" };
      } })).rejects.toThrow("CHECKPOINT_STALE");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(checkpoint?.stage).toBe("waiting");
  });
  it("does not let a generated field label suppress a necessary plain business question", async () => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.field_metadata = { col_2: { label: "Lifecycle" } };
    const requestJson = vi.fn().mockResolvedValueOnce(response({ ...mapped,
      operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "The field means shipment lifecycle status" }] }))
      .mockResolvedValue(response(mapped));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "The shipment lifecycle status" }));
    const result = await generateModelReadWorkload({ ...setup(requestJson, boundary), clarificationHandler });
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({ resource: "public.tbl_7", field: "col_2" }));
    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

describe("model-assisted Read workload mapping", () => {
  it.each(["corrected", "fabricated", "changed_workload"])("repairs quoted meanings for ordinary fields before asking the operator (%s)", async mode => {
    const boundary = generatedBoundary(), before = structuredClone(boundary);
    const quote = "public.orders.status means the current fulfillment stage of the purchase.";
    const allowed = [{ id: "order_status", description: "Read purchase fulfillment stage",
      plan: { kind: "rows", resource: "public.orders", select: ["status"] } }];
    let calls = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "ordinary_meaning",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({
        allowed: ++calls > 1 && mode === "changed_workload" ? [] : allowed, forbidden: [],
        operator_meanings: [{ resource: "public.orders", field: "status",
          operator_quote: calls > 1 && mode === "corrected" ? quote : "This field means purchase fulfillment." }],
      }) }] } }));
    const clarificationHandler = vi.fn().mockResolvedValue({ state: "declined" });
    const result = generateModelReadWorkload({ name: "order_read", allowedQuestions: ["Read my purchase status"],
      operatorNamingContext: quote, provider: "openai", model: "gpt-test", generatedBoundary: boundary,
      apiKey: "test-key", egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    if (mode === "corrected") {
      expect((await result).analysis.status).toBe("ready");
      expect(clarificationHandler).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toThrow(mode === "changed_workload"
        ? "READ_WORKLOAD_NAMING_CORRECTION_CHANGED_WORKLOAD" : "READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
      expect(clarificationHandler).not.toHaveBeenCalled();
    }
    expect(calls).toBe(2);
    expect(JSON.stringify(requestJson.mock.calls[1])).toContain("Rejected naming submission");
    expect(boundary).toEqual(before);
  });
  it.each(["omission", "question"])("corrects omitted exact naming evidence from approved policy before asking a business question (%s)", async attempt => {
    const boundary = opaqueGeneratedBoundary(), before = structuredClone(boundary);
    const conversation = createModelAuthoringConversation(), policy = newPolicySourceSession();
    const quotes = ["public.tbl_7 contains shipment requests", "col_2 means shipment lifecycle status"];
    const snapshot = policyTextSnapshot(Buffer.from(quotes.join("\n")), "Rules.txt");
    policy.snapshots.push(snapshot); policy.active = snapshot.version;
    policy.approvals.push({ digest: snapshot.digest, destination: authoringDestination({ provider: "openai", model: "gpt-test" }) });
    conversation.policySources = policy;
    const allowed = [{ id: "shipments", description: "Read shipment lifecycle", plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }];
    let calls = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "naming",
      name: "runner__submit_read_workloads", arguments: JSON.stringify(++calls === 1 && attempt === "question"
        ? { clarification_request: { resource: "public.tbl_7", reason: "The table has a coded name.", question: "What business records does this view contain?" } }
        : { allowed, forbidden: [],
        ...(calls > 1 ? { operator_meanings: [
          { resource: "public.tbl_7", operator_quote: quotes[0] },
          { resource: "public.tbl_7", field: "col_2", operator_quote: quotes[1] },
        ] } : {}) }) }] } }));
    const clarificationHandler = vi.fn().mockResolvedValue({ state: "declined" });
    const result = await generateModelReadWorkload({ name: "shipment_read", allowedQuestions: ["Read my shipment lifecycle"],
      operatorNamingContext: "Use the attached rules.", provider: "openai", model: "gpt-test", generatedBoundary: boundary,
      apiKey: "test-key", egressAcknowledged: true, conversation, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(attempt === "omission" ? 1 : 2); expect(clarificationHandler).not.toHaveBeenCalled();
    if (attempt === "question") expect(JSON.stringify(requestJson.mock.calls[1])).toContain("Rejected naming submission");
    expect(boundary).toEqual(before); expect(result.authority_granted).toBe(false);
  });

  it.each(["missing_quote", "fabricated_quote", "changed_workload", "unknown_field", "withheld_field"])("bounds naming correction without accepting missing evidence or changed access (%s)", async failure => {
    const boundary = opaqueGeneratedBoundary(), before = structuredClone(boundary);
    const tableQuote = "public.tbl_7 contains shipment requests", fieldQuote = "col_2 means shipment lifecycle status";
    const allowed = [{ id: "shipments", description: "Read shipment lifecycle", plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }];
    let calls = 0;
    const requestJson = vi.fn(async () => {
      calls++;
      const operator_meanings = [{ resource: "public.tbl_7", operator_quote: tableQuote },
        { resource: "public.tbl_7", field: failure === "unknown_field" ? "col_200" : failure === "withheld_field" ? "tenant_id" : "col_2",
          operator_quote: failure === "fabricated_quote" ? "col_2 means private credit balance" : fieldQuote }];
      return { status: 200, body: { output: [{ type: "function_call", call_id: "bounded_naming", name: "runner__submit_read_workloads",
        arguments: JSON.stringify({ allowed: calls > 1 && failure === "changed_workload" ? [] : allowed, forbidden: [],
          ...(calls === 1 ? { operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: `Invented prefix: ${fieldQuote}` }] }
            : failure !== "missing_quote" ? { operator_meanings } : {}) }) }] } };
    });
    const clarificationHandler = vi.fn().mockResolvedValue({ state: "declined" });
    const result = generateModelReadWorkload({ name: "shipment_read", allowedQuestions: ["Read my shipment lifecycle"],
      operatorNamingContext: `${tableQuote}. ${fieldQuote}.`, provider: "openai", model: "gpt-test", generatedBoundary: boundary,
      apiKey: "test-key", egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    if (failure === "missing_quote") {
      const accepted = await result;
      expect(accepted.analysis.status).toBe("ready");
      expect(accepted.workload.source.meaning_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: "public.tbl_7", field: "col_2", origin: "HOST-RESOLVED" }) ]));
      expect(accepted.authority_granted).toBe(false);
    } else await expect(result).rejects.toThrow(failure === "changed_workload" ? "READ_WORKLOAD_NAMING_CORRECTION_CHANGED_WORKLOAD"
      : "READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
    expect(calls).toBe(2);
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(boundary).toEqual(before);
  });

  it("still asks for a genuinely missing field meaning after reusing the table quote", async () => {
    const boundary = opaqueGeneratedBoundary(), before = structuredClone(boundary);
    const quote = "public.tbl_7 contains shipment requests";
    let calls = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "missing_field_meaning",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({
        allowed: [{ id: "shipments", description: "Read shipment lifecycle", plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }],
        forbidden: [], ...(++calls > 1 ? { operator_meanings: [{ resource: "public.tbl_7", operator_quote: quote }] } : {}),
      }) }] } }));
    const clarificationHandler = vi.fn().mockResolvedValue({ state: "answered", answer: "The shipment lifecycle status" });
    const result = await generateModelReadWorkload({ name: "shipment_read", allowedQuestions: ["Read my shipment lifecycle"],
      operatorNamingContext: quote, provider: "openai", model: "gpt-test", generatedBoundary: boundary, apiKey: "test-key",
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    expect(calls).toBe(2); expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({ resource: "public.tbl_7", field: "col_2" }));
    expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false); expect(boundary).toEqual(before);
  });

  it("does not reuse a stale Read catalog during naming correction", async () => {
    const boundary = opaqueGeneratedBoundary();
    let calls = 0;
    const requestJson = vi.fn(async () => {
      if (++calls === 2) boundary.pack.resources[0]!.selectable_fields = [];
      return { status: 200, body: { output: [{ type: "function_call", call_id: "stale_naming", name: "runner__submit_read_workloads",
        arguments: JSON.stringify({ allowed: [{ id: "shipments", description: "Read shipment lifecycle",
          plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
          ...(calls === 1 ? { operator_meanings: [{ resource: "public.tbl_7", operator_quote: "Invented prefix: public.tbl_7 contains shipment requests" }] } : {}) }) }] } };
    });
    await expect(generateModelReadWorkload({ name: "shipment_read", allowedQuestions: ["Read my shipment lifecycle"],
      operatorNamingContext: "public.tbl_7 contains shipment requests", provider: "openai", model: "gpt-test", generatedBoundary: boundary,
      apiKey: "test-key", egressAcknowledged: true, deferNarration: true, dependencies: { requestJson } }))
      .rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    expect(calls).toBe(2);
  });

  it("corrects shared-table reads into owned-root related projections without a scope-review detour", async () => {
    const boundary = generatedBoundary();
    const orders = boundary.pack.resources[0]!;
    const products = { ...structuredClone(orders), id: "public.products", table: "products", label: "Product details",
      description: "Shared product information attached to a purchase." };
    delete products.principal_key;
    orders.field_types.product_id = "uuid";
    const link = { constraint_name: "orders_product_fkey", source_resource: orders.id, target_resource: products.id,
      source_columns: ["tenant_id", "product_id"], target_columns: ["tenant_id", "id"],
      target_uniqueness: { kind: "unique_constraint" as const, name: "products_tenant_id_key", columns: ["tenant_id", "id"] },
      nullable: false, cardinality: "many_to_one" as const, max_fan_out: 1 as const };
    orders.relationships.push({ id: link.constraint_name, target_resource: products.id,
      local_columns: link.source_columns, target_columns: link.target_columns, counted_entity: orders.id,
      cardinality: "many_to_one", max_fan_out: 1, path_depth: 1,
      proof: { source: "database_catalog", links: [link], digest: canonicalJsonDigest([link]) } });
    boundary.pack.resources.push(products);
    const before = structuredClone(boundary);
    const response = (plan: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "scope_fix",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "my_purchases",
        description: "My purchases with related product details", plan }], forbidden: [] }) }] } });
    const requestJson = vi.fn().mockResolvedValueOnce(response({ kind: "rows", resource: products.id, select: ["status"] }))
      .mockResolvedValueOnce(response({ kind: "rows", resource: orders.id, select: ["status"],
        related: [{ relationship: link.constraint_name, select: ["amount"] }] }));
    const clarificationHandler = vi.fn();
    const result = await generateModelReadWorkload({ name: "my_purchases", allowedQuestions: ["Show my purchases with product details"],
      // Additional declared root facts; the relationship proof still governs
      // products access. Neither a name nor this statement grants a root read.
      operatorNamingContext: "Show my purchases with product details\npublic.orders means purchases. public.products means product details.",
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, principalScopedRootResources: [orders.id],
      egressAcknowledged: true, env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requestJson.mock.calls[1])).toContain("READ_WORKLOAD_OWN_RECORD_ROOT_REQUIRED");
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(result.analysis.candidate?.pack.resources.find(resource => resource.id === products.id)).toMatchObject({ relationship_only: true });
    expect(result.analysis.candidate?.pack.resources.find(resource => resource.id === orders.id)?.relationships).toEqual(orders.relationships);
    expect(result.authority_granted).toBe(false);
    expect(boundary).toEqual(before);
  });

  it("refuses a repeated independent read of a related-only resource without dropping the job or weakening scope", async () => {
    const boundary = generatedBoundary();
    const before = structuredClone(boundary);
    const requestJson = vi.fn().mockResolvedValue(diagnosticResponse("valid"));
    await expect(generateModelReadWorkload({ name: "owned_only", allowedQuestions: ["My orders"], provider: "openai",
      model: "gpt-5.6-terra", generatedBoundary: boundary, principalScopedRootResources: [], egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson } }))
      .rejects.toMatchObject({ message: expect.stringContaining("READ_WORKLOAD_OWN_RECORD_ROOT_REQUIRED") });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(boundary).toEqual(before);
    expect(readWorkloadCatalog(boundary).resources[0]).not.toHaveProperty("relationship_only");
    expect(readWorkloadCatalog(boundary, []).resources[0]).toMatchObject({ relationship_only: true });
  });

  it("does not let a table-only clarification establish an unexplained coded field meaning", async () => {
    const boundary = opaqueGeneratedBoundary();
    const before = structuredClone(boundary);
    const response = (meanings: unknown[] = []) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "table_then_field",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read lifecycle",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [], operator_meanings: meanings }) }] } });
    const requestJson = vi.fn().mockResolvedValueOnce(response([{ resource: "public.tbl_7", operator_quote: "public.tbl_7 contains orders" }]))
      .mockResolvedValue(response());
    const clarificationHandler = vi.fn().mockResolvedValueOnce({ state: "answered", answer: "Order records" })
      .mockResolvedValue({ state: "answered", answer: "Order lifecycle status" });
    const result = await generateModelReadWorkload({ name: "separate_meanings", allowedQuestions: ["Read my order lifecycle"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler });
    expect(result.analysis.status).toBe("ready");
    expect(clarificationHandler).toHaveBeenCalledTimes(2);
    expect(clarificationHandler.mock.calls[0]![0]).not.toHaveProperty("field");
    expect(clarificationHandler.mock.calls[0]![0]).toMatchObject({ resource: "public.tbl_7",
      reason_binding: { kind: "requested_read_scope", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) } });
    expect(clarificationHandler.mock.calls[0]![0].question).toMatch(/information|records/iu);
    expect(clarificationHandler.mock.calls[1]![0]).toMatchObject({ resource: "public.tbl_7", field: "col_2" });
    expect(clarificationHandler.mock.calls[1]![0]).not.toHaveProperty("reason_binding");
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(boundary).toEqual(before);
  });

  it.each(["approved_attachment", "unapproved_attachment", "model_summary", "saved_answer", "saved_model_question", "saved_model_answer"])("uses only actual authorized operator naming sources: %s", async (source) => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    const before = structuredClone(boundary);
    const quote = "col_2 means the order lifecycle status";
    const conversation = createModelAuthoringConversation();
    if (source.endsWith("attachment")) {
      const policy = newPolicySourceSession(), snapshot = policyTextSnapshot(Buffer.from(quote), "Rules.txt");
      policy.snapshots.push(snapshot); policy.active = snapshot.version;
      if (source === "approved_attachment") policy.approvals.push({ digest: snapshot.digest,
        destination: authoringDestination({ provider: "openai", model: "gpt-5.6-terra" }) });
      conversation.policySources = policy;
    }
    if (source === "saved_answer") rememberModelAuthoringClarification(conversation, "What does the coded field represent?", quote);
    if (source === "saved_model_question") rememberModelAuthoringClarification(conversation, quote, "I do not know.");
    if (source === "saved_model_answer") rememberModelAuthoringTurn(conversation, "Read my records", quote);
    const requestJson = vi.fn().mockResolvedValue({ status: 200, body: { output: [{ type: "function_call", call_id: "source",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read lifecycle",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
        operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: quote }] }) }] } });
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "source_provenance", allowedQuestions: [source === "model_summary" ? quote : "Read lifecycle"],
      operatorNamingContext: "Read my orders", provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary,
      egressAcknowledged: true, env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, conversation,
      dependencies: { requestJson } }, "public.tbl_7 means orders.")).catch(error => error);
    if (source === "approved_attachment" || source === "saved_answer") {
      expect(result.analysis.status).toBe("ready");
      expect(requestJson).toHaveBeenCalledOnce();
    } else {
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain(source === "unapproved_attachment" ? "POLICY_TEXT_EGRESS_REQUIRED" : "READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
      expect(requestJson).toHaveBeenCalledTimes(source === "unapproved_attachment" ? 0 : 2);
    }
    expect(boundary).toEqual(before);
  });

  it.each(["col_2", "q_av"])("asks for %s meaning instead of accepting or trapping a fabricated naming quote", async (field) => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    if (field === "q_av") {
      boundary.pack.resources[0]!.selectable_fields.push(field);
      boundary.pack.resources[0]!.field_types[field] = boundary.pack.resources[0]!.field_types.col_2!;
    }
    const before = structuredClone(boundary);
    const response = (operator_quote: string) => ({ status: 200, body: { output: [{ type: "function_call",
      call_id: "meaning", name: "runner__submit_read_workloads", arguments: JSON.stringify({
        allowed: [{ id: "orders", description: "Read order status", plan: { kind: "rows", resource: "public.tbl_7", select: [field] } }],
        forbidden: [], operator_meanings: [{ resource: "public.tbl_7", field, operator_quote }],
      }) }] } });
    const requestJson = vi.fn().mockResolvedValueOnce(response("col_2 is order status"))
      .mockResolvedValue(response("Order lifecycle status"));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Order lifecycle status" }));
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "recover_meaning", allowedQuestions: ["Read my order status"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler }, "public.tbl_7 means orders."));
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({ resource: "public.tbl_7", field }));
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.analysis.status).toBe("ready");
    expect(result.authority_granted).toBe(false);
    expect(boundary).toEqual(before);
  });

  it("delivers a model clarification requested by the bounded validation correction", async () => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    const before = structuredClone(boundary);
    const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call",
      call_id: "mapping", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
    const requestJson = vi.fn().mockResolvedValueOnce(response({ allowed: [{ id: "orders", description: "Read orders",
      plan: { kind: "rows", resource: "public.tbl_7", select: ["unknown_field"] } }], forbidden: [] }))
      .mockResolvedValueOnce(response({ clarification_request: { resource: "public.tbl_7", field: "col_2",
        reason: "The proposed field did not exist", question: "What does the selected business detail represent?" } }))
      .mockResolvedValue(response({ allowed: [{ id: "orders", description: "Read order lifecycle",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [] }));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Order lifecycle status" }));
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "correct_then_clarify", allowedQuestions: ["Read my orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler }, "public.tbl_7 means orders."));
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(result.analysis.status).toBe("ready");
    expect(result.diagnostics?.[0]?.code).toBe("READ_WORKLOAD_BLOCKED");
    expect(boundary).toEqual(before);
  });

  it.each(["declined", "fabricated_again", "unknown_target"])("keeps naming recovery fail-closed: %s", async (kind) => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    const before = structuredClone(boundary);
    const requestJson = vi.fn().mockResolvedValue({ status: 200, body: { output: [{ type: "function_call",
      call_id: "unproven_meaning", name: "runner__submit_read_workloads", arguments: JSON.stringify({
        allowed: [{ id: "orders", description: "Read order status", plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }],
        forbidden: [], operator_meanings: [{ resource: "public.tbl_7", field: kind === "unknown_target" ? "unknown_field" : "col_2",
          operator_quote: "col_2 is private payment eligibility" }],
      }) }] } });
    const clarificationHandler = vi.fn(async () => kind === "declined" ? { state: "declined" as const }
      : { state: "answered" as const, answer: "Order lifecycle status" });
    const error = await generateModelReadWorkload({ name: "refused_meaning", allowedQuestions: ["Read my orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(kind === "declined" ? "READ_WORKLOAD_CLARIFICATION_DECLINED" : "READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
    expect(clarificationHandler).toHaveBeenCalledTimes(kind === "unknown_target" ? 0 : 1);
    expect(requestJson).toHaveBeenCalledTimes(kind === "declined" ? 1 : kind === "unknown_target" ? 2 : 3);
    expect(boundary).toEqual(before);
  });

  it.each(["col_2", "tbl_7.col_2", "public.tbl_7.col_2"])("reuses a coded field meaning for %s without another question or metadata mutation", async (identifier) => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    const before = structuredClone(boundary);
    const quote = `${identifier} means the order lifecycle status`;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "known_meaning",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read order lifecycle",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
        operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: quote }],
      }),
    }] } }));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "known_meaning", allowedQuestions: ["Read order lifecycle"],
      operatorNamingContext: `Read my own orders. ${quote}. Do not change any source rows.`, provider: "openai", model: "gpt-5.6-terra",
      generatedBoundary: boundary, egressAcknowledged: true, env: { OPENAI_API_KEY: "test-key" }, deferNarration: true,
      dependencies: { requestJson }, clarificationHandler }, "public.tbl_7 means orders."));
    expect(result.analysis.status).toBe("ready");
    expect(result.authority_granted).toBe(false);
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledOnce();
    expect(boundary).toEqual(before);
  });

  it.each(["fabricated_quote", "unknown_field", "withheld_field", "ambiguous_leaf", "ambiguous_table", "identifier_prefix"])(
    "refuses invalid operator naming evidence before accepting a plan: %s", async (kind) => {
      const boundary = opaqueGeneratedBoundary();
      boundary.pack.resources[0]!.label = "Orders";
      if (kind === "ambiguous_leaf") boundary.pack.resources.push({ ...structuredClone(boundary.pack.resources[0]!), id: "public.other", table: "other" });
      if (kind === "ambiguous_table") boundary.pack.resources.push({ ...structuredClone(boundary.pack.resources[0]!), id: "other.tbl_7", schema: "other" });
      if (kind === "withheld_field") boundary.pack.resources[0]!.model_withheld_fields = ["col_2"];
      const quote = `${kind === "ambiguous_table" ? "tbl_7.col_2" : "col_2"} means the lifecycle status`;
      const args = { allowed: [{ id: "orders", description: "Read order lifecycle", plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
        operator_meanings: [{ resource: "public.tbl_7", field: kind === "unknown_field" ? "absent" : "col_2",
          operator_quote: kind === "identifier_prefix" ? "col_2_private means the lifecycle status" : quote }] };
      const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "bad_meaning",
        name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } }));
      const result = await generateModelReadWorkload({ name: "bad_meaning", allowedQuestions: ["Read order lifecycle"],
        operatorNamingContext: kind === "fabricated_quote" ? "Only read my orders" : kind === "identifier_prefix" ? args.operator_meanings[0]!.operator_quote : quote,
        provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
        env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson } }).catch((error) => error);
      expect(result).toBeInstanceOf(ReadWorkloadDraftError);
      expect(result.diagnostics.some((entry: { code: string }) => entry.code === "READ_WORKLOAD_NAMING_EVIDENCE_INVALID")).toBe(true);
      expect(requestJson).toHaveBeenCalledTimes(2);
    },
  );

  it("does not treat an explained resource name as an explanation of every coded field", async () => {
    const boundary = opaqueGeneratedBoundary();
    const quote = "public.tbl_7 contains customer orders";
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "table_meaning",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read order lifecycle",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
        operator_meanings: [{ resource: "public.tbl_7", operator_quote: quote }],
      }) }] } }));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    await generateModelReadWorkload({ name: "table_meaning", allowedQuestions: [quote], provider: "openai", model: "gpt-5.6-terra",
      generatedBoundary: boundary, egressAcknowledged: true, env: { OPENAI_API_KEY: "test-key" }, deferNarration: true,
      dependencies: { requestJson }, clarificationHandler }).catch(() => undefined);
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({ resource: "public.tbl_7", field: "col_2" }));
  });

  it.each(["valid", "wrong_revision", "foreign_answer", "wrong_target"])(
    "uses an exact host answer reference without asking the model to copy raw words (%s)", async variant => {
      const boundary = opaqueGeneratedBoundary(); boundary.pack.resources[0]!.label = "Orders";
      const raw = "  Order lifecycle status — 😀 e\u0301. \t ";
      let saved: OperatorQuestion | undefined;
      const bodies: string[] = [];
      const requestJson = vi.fn(async (request) => {
        bodies.push(JSON.stringify(request.body));
        const args = !saved ? { clarification_request: { resource: "public.tbl_7", field: "col_2",
          reason: "Its task meaning is missing.", question: "What does this order stage mean for your task?" } }
          : { allowed: [{ id: "orders", description: "Read order lifecycle",
              plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
            operator_meanings: [{ resource: "public.tbl_7", field: "col_2", answer_reference: {
              question_id: saved.id, revision: variant === "wrong_revision" ? 2 : saved.revision,
              answer_id: variant === "foreign_answer" ? randomUUID() : saved.raw_answer!.id } }] };
        return { status: 200, body: { output: [{ type: "function_call", call_id: `local-${bodies.length}`,
          name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } };
      });
      const clarificationHandler = vi.fn(async (request) => {
        const q = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: randomUUID(),
          kind: "attributed_meaning", scope_digest: canonicalJsonDigest("job"), context_digest: canonicalJsonDigest("current"),
          target: { phase: "read_mapping", resource: request.resource,
            field: variant === "wrong_target" ? "id" : request.field, outcomes: [] },
          material: ["Only this task; no authority."], evidence: [], continuation: "read_mapping" });
        const captured = captureOperatorAnswer(presentOperatorQuestion(q, request.question), raw);
        saved = confirmOperatorAnswer(proposeOperatorAnswer(captured, { question_id: q.id, revision: 1,
          answer_id: captured.raw_answer!.id, disposition: "proposed", value: { kind: "attributed_meaning" } }));
        return { state: "answered" as const, answer: raw };
      });
      const input = { name: "host_answer_reference", allowedQuestions: ["Read my order lifecycle"], provider: "openai" as const,
        model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
        env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler,
        operatorQuestions: () => saved ? [saved] : [] };
      if (variant === "valid") {
        const result = await generateModelReadWorkload(withDeclaredRoot(input, "public.tbl_7 means orders."));
        expect(result.analysis.status).toBe("ready"); expect(requestJson).toHaveBeenCalledTimes(2);
        expect(bodies[1]).toContain(saved!.raw_answer!.id);
        expect(saved!.raw_answer!.text).toBe(raw);
      } else await expect(generateModelReadWorkload(withDeclaredRoot(input, "public.tbl_7 means orders."))).rejects.toThrow();
      expect(clarificationHandler).toHaveBeenCalledOnce();
    });

  it.each(["col_2 means the order lifecycle status", "Order lifecycle status"])(
    "accepts verbatim naming evidence from the answered clarification: %s", async (answer) => {
      const boundary = opaqueGeneratedBoundary();
      boundary.pack.resources[0]!.label = "Orders";
      const before = structuredClone(boundary);
      const requestJson = vi.fn().mockResolvedValueOnce({ status: 200, body: { output: [{
        type: "function_call", call_id: "naming_question", name: "runner__submit_read_workloads",
        arguments: JSON.stringify({ clarification_request: { resource: "public.tbl_7", field: "col_2",
          reason: "Unknown coded field meaning", question: "What does the selected business detail represent?" } }),
      }] } }).mockResolvedValue({ status: 200, body: { output: [{
        type: "function_call", call_id: "answered_mapping", name: "runner__submit_read_workloads",
        arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read order lifecycle",
          plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
          operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: answer }] }),
      }] } });
      const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer }));
      const result = await generateModelReadWorkload(withDeclaredRoot({ name: "answered_meaning", allowedQuestions: ["Read my order lifecycle"],
        provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
        env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson }, clarificationHandler }, "public.tbl_7 means orders."));
      expect(clarificationHandler).toHaveBeenCalledOnce();
      expect(requestJson).toHaveBeenCalledTimes(2);
      expect(result.analysis.status).toBe("ready");
      expect(boundary).toEqual(before);
    },
  );

  it.each(["model_question", "unanswered_field"])("does not manufacture naming evidence from %s", async (kind) => {
    const boundary = opaqueGeneratedBoundary();
    boundary.pack.resources[0]!.label = "Orders";
    const answer = "Order lifecycle status";
    const question = "Does col_2 mean payment eligibility?";
    const requestJson = vi.fn().mockResolvedValueOnce({ status: 200, body: { output: [{
      type: "function_call", call_id: "naming_question", name: "runner__submit_read_workloads",
      arguments: JSON.stringify({ clarification_request: { resource: "public.tbl_7", field: "col_2", reason: "Unknown meaning", question } }),
    }] } }).mockResolvedValue({ status: 200, body: { output: [{
      type: "function_call", call_id: "fabricated_answer", name: "runner__submit_read_workloads",
      arguments: JSON.stringify({ allowed: [{ id: "orders", description: "Read orders",
        plan: { kind: "rows", resource: "public.tbl_7", select: ["col_2"] } }], forbidden: [],
        operator_meanings: [{ resource: "public.tbl_7", field: kind === "unanswered_field" ? "col_1" : "col_2",
          operator_quote: kind === "model_question" ? question : answer }] }),
    }] } });
    const error = await generateModelReadWorkload({ name: "invalid_answered_meaning", allowedQuestions: ["Read my orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, egressAcknowledged: true,
      env: { OPENAI_API_KEY: "test-key" }, deferNarration: true, dependencies: { requestJson },
      clarificationHandler: async () => ({ state: "answered", answer }) }).catch((error) => error);
    expect(error).toBeInstanceOf(ReadWorkloadDraftError);
    expect(error.message).toContain("READ_WORKLOAD_NAMING_EVIDENCE_INVALID");
  });

  it("keeps a long original job while requesting concise schema-compatible plan descriptions", async () => {
    const job = "Help customers read their account, bills, services, support history, and eligible plan offers. ".repeat(4).trim();
    expect(job.length).toBeGreaterThan(280);
    const requestJson = vi.fn().mockResolvedValue(diagnosticResponse("valid"));
    await expect(generateModelReadWorkload({
      name: "long_job", allowedQuestions: [job],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    })).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_REQUIRED");
    const sent = JSON.stringify(requestJson.mock.calls[0]?.[0].body);
    expect(sent).toContain(job);
    expect(sent).toContain("1 through 280 characters");
    expect(sent).not.toContain("Preserve each question in description");
    expect(requestJson).toHaveBeenCalledOnce();
  });
  it.each([
    ["invalid_id", "validation", "READ_WORKLOAD_BLOCKED", "READ_WORKLOAD_ID_INVALID"],
    ["missing", "required_tool", "ASK_REQUIRED_TOOL_NOT_CALLED", "required structured tool call"],
    ["malformed", "provider_response", "ASK_PROVIDER_RESPONSE_INVALID", "no assistant text or function call"],
    ["arguments", "provider_response", "ASK_TOOL_ARGUMENTS_INVALID", "malformed tool arguments"],
  ] as const)("retains initial and correction diagnostics for %s without mutating the boundary", async (kind, category, code, reason) => {
    const boundary = generatedBoundary();
    const before = structuredClone(boundary);
    const requests: string[] = [];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      return diagnosticResponse(kind);
    });
    const error = await generateModelReadWorkload(withDeclaredRoot({
      name: "diagnostic_test", allowedQuestions: ["List my orders"],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: boundary, egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    }, "public.orders means orders.")).catch((error) => error);
    expect(error).toBeInstanceOf(ReadWorkloadDraftError);
    expect(error.diagnostics).toEqual([
      expect.objectContaining({ attempt: 1, phase: "initial", category, code }),
      expect.objectContaining({ attempt: 2, phase: "correction", category, code }),
    ]);
    expect(error.message).toContain(reason);
    if (kind === "invalid_id") expect(requests[1]).toContain("READ_WORKLOAD_ID_INVALID");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(boundary).toEqual(before);
  });

  it.each(["invalid_id", "malformed", "arguments", "missing"] as const)("recovers %s with one valid correction", async (kind) => {
    const requestJson = vi.fn().mockResolvedValueOnce(diagnosticResponse(kind))
      .mockResolvedValueOnce(diagnosticResponse("valid"));
    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "corrected_read", allowedQuestions: ["List my orders"],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    }, "public.orders means orders."));
    expect(result.analysis.status).toBe("ready");
    expect(result.authority_granted).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "malformed"] as const)("does not lose rejected draft details when correction returns %s", async (kind) => {
    const requestJson = vi.fn().mockResolvedValueOnce(diagnosticResponse("invalid_id"))
      .mockResolvedValueOnce(diagnosticResponse(kind));
    const error = await generateModelReadWorkload(withDeclaredRoot({
      name: "mixed_failure", allowedQuestions: ["List my orders"],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    }, "public.orders means orders.")).catch((error) => error);
    expect(error).toBeInstanceOf(ReadWorkloadDraftError);
    expect(error.diagnostics[0]).toMatchObject({ phase: "initial", category: "validation" });
    expect(error.diagnostics[1]).toMatchObject({ phase: "correction", category: kind === "missing" ? "required_tool" : "provider_response" });
    expect(error.message).toContain("READ_WORKLOAD_ID_INVALID");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("retains compiler blockers from both submitted attempts in a blocked result", async () => {
    const requestJson = vi.fn().mockResolvedValue(diagnosticResponse("blocked"));
    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "blocked_reads", allowedQuestions: ["List my orders"],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    }, "public.orders means orders."));
    expect(result.analysis.status).toBe("blocked");
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics?.every((diagnostic) => diagnostic.category === "validation")).toBe(true);
    expect(result.authority_granted).toBe(false);
  });

  it("preserves a validation refusal when its correction times out without another automatic retry", async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(diagnosticResponse("invalid_id"))
      .mockRejectedValueOnce(new AskError("ASK_PROVIDER_TIMEOUT", "The provider did not respond within the Ask timeout.", 504));
    const error = await generateModelReadWorkload(withDeclaredRoot({
      name: "timed_out_correction", allowedQuestions: ["List my orders"],
      provider: "openai", model: "gpt-5.6-terra", env: { OPENAI_API_KEY: "test-key" },
      generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true,
      dependencies: { requestJson },
    }, "public.orders means orders.")).catch((error) => error);
    expect(error.diagnostics).toEqual([
      expect.objectContaining({ phase: "initial", category: "validation" }),
      expect.objectContaining({ phase: "correction", category: "provider_request", code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" }),
    ]);
    expect(error.code).toBe("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION");
    expect(error).not.toBeInstanceOf(ReadWorkloadDraftError);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
  it("carries prior authoring history into mapping and returns actual validated model prose", async () => {
    const conversation = createModelAuthoringConversation();
    rememberModelAuthoringTurn(
      conversation,
      "Help customers understand their support history.",
      "I will map that job to reviewed structure.",
    );
    const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          body: {
            output: [{
              type: "function_call",
              call_id: "call_read_history",
              name: "runner__submit_read_workloads",
              arguments: JSON.stringify({
                allowed: [{
                  id: "orders_by_status",
                  description: "Count orders by status",
                  plan: {
                    kind: "aggregate",
                    resource: "public.orders",
                    measures: [{ function: "count" }],
                    dimensions: [{ field: "status" }],
                  },
                }],
                forbidden: [],
              }),
            }],
          },
        };
      }
      return {
        status: 200,
        body: {
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I mapped one reviewed status summary. It is not active yet." }],
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["How many orders are in each status?"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { TEST_PROVIDER_KEY: "provider-test-key" },
      apiKeyEnv: "TEST_PROVIDER_KEY",
      egressAcknowledged: true,
      dependencies: { requestJson },
      conversation,
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.model_message).toBe("I mapped one reviewed status summary. It is not active yet.");
    expect(JSON.stringify(requests[0]?.body)).toContain("Help customers understand their support history.");
    expect(JSON.stringify(requests[1]?.body)).toContain("Count orders by status");
    expect(JSON.stringify(requests[1]?.body)).not.toContain("provider-test-key");
  });

  it("defers narration to the retained outer authoring session without another provider call", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_read_deferred",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            allowed: [{
              id: "orders_by_status",
              description: "Count orders by status",
              plan: {
                kind: "aggregate",
                resource: "public.orders",
                measures: [{ function: "count" }],
                dimensions: [{ field: "status" }],
              },
            }],
            forbidden: [],
          }),
        }],
      },
    }));

    const result = await generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["How many orders are in each status?"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { TEST_PROVIDER_KEY: "provider-test-key" },
      apiKeyEnv: "TEST_PROVIDER_KEY",
      egressAcknowledged: true,
      dependencies: { requestJson },
      conversation: createModelAuthoringConversation(),
      deferNarration: true,
    });

    expect(result.model_message).toBeUndefined();
    expect(requestJson).toHaveBeenCalledOnce();
    expect(result.analysis.status).toBe("ready");
  });

  it.each(["openai", "anthropic"] as const)(
    "uses one ephemeral structured workload tool with %s and grants no authority",
    async (provider) => {
      const requests: string[] = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(JSON.stringify(request.body));
        const input = {
          allowed: [{
            id: "orders_by_status",
            description: "Average order amount by status",
            plan: {
              kind: "aggregate",
              resource: "public.orders",
              measures: [{ function: "avg", field: "amount" }],
              dimensions: [{ field: "status" }],
            },
          }],
          forbidden: [{
            id: "raw_secret_notes",
            description: "Do not return secret notes",
            plan: { kind: "rows", resource: "public.orders", select: ["secret_note"] },
          }],
        };
        if (provider === "openai") {
          return {
            status: 200,
            body: {
              output: [{
                type: "function_call",
                call_id: "call_read_workload",
                name: "runner__submit_read_workloads",
                arguments: JSON.stringify(input),
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            content: [{
              type: "tool_use",
              id: "toolu_read_workload",
              name: "runner__submit_read_workloads",
              input,
            }],
          },
        };
      });

      const result = await generateModelReadWorkload({
        name: "support_reads",
        allowedQuestions: ["What is average order amount by status?"],
        forbiddenQuestions: ["Show private row text."],
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        generatedBoundary: generatedBoundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result).toMatchObject({
        provider,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
        analysis: {
          status: "ready",
          authority_granted: false,
          coverage: {
            allowed_supported: 1,
            forbidden_denied: 1,
          },
        },
      });
      expect(requestJson).toHaveBeenCalledTimes(1);
      const body = requests[0]!;
      expect(body).toContain("public.orders");
      expect(body).toContain("amount");
      expect(body).not.toContain("provider-test-key");
      expect(body).not.toContain("tenant_id");
      expect(body).not.toContain("principal_id");
      expect(body).not.toContain("secret_note");
      expect(body).toContain("schema_declared_values");
      expect(body).toContain("schema_declared_enum_or_check");
      expect(body).toContain("open");
      expect(body).toContain("closed");
      expect(body).not.toContain("sampled-status-from-row");
      const firstBody = JSON.parse(requests[0]!) as Record<string, unknown>;
      expect(firstBody.tool_choice).toEqual(provider === "openai"
        ? { type: "function", name: "runner__submit_read_workloads" }
        : { type: "tool", name: "runner__submit_read_workloads" });
    },
  );

  it("requires explicit structural-metadata egress acknowledgement before any provider request", async () => {
    const requestJson = vi.fn();
    await expect(generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["Average order amount by status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: false,
      dependencies: { requestJson },
    })).rejects.toThrow(/Acknowledge that reviewed visible data/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("blocks obvious secret material in operator-authored questions before provider egress", async () => {
    const requestJson = vi.fn();
    await expect(generateModelReadWorkload({
      name: "secret_question_refused",
      allowedQuestions: ["Use API key = sk-do-not-send-this-value"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_SECRET_BLOCKED/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("gives a local model one bounded correction when it returns prose instead of the required tool", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      if (attempt === 1) {
        return {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "Here is a prose summary instead." } }],
          },
        };
      }
      return {
        status: 200,
        body: {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_local_read_workload",
                type: "function",
                function: {
                  name: "runner__submit_read_workloads",
                  arguments: JSON.stringify({
                    allowed: [{
                      id: "orders_by_status",
                      description: "Average order amount by status",
                      plan: {
                        kind: "aggregate",
                        resource: "public.orders",
                        measures: [{ function: "avg", field: "amount" }],
                        dimensions: [{ field: "status" }],
                      },
                    }],
                    forbidden: [],
                  }),
                },
              }],
            },
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["What is average order amount by status?"],
      provider: "openai_compatible",
      model: "qwen-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      generatedBoundary: generatedBoundary(),
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("previous response did not contain exactly the required structured tool call");
    expect(requests[1]).toContain("Call runner.submit_read_workloads exactly once now");
  });

  it.each(["openai", "anthropic"] as const)(
    "gives %s one bounded correction after deterministic workload validation refuses the first plan",
    async (provider) => {
      let attempt = 0;
      const requests: string[] = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(JSON.stringify(request.body));
        attempt += 1;
        const input = {
          allowed: [{
            id: "orders_by_status",
            description: "Average order amount by status",
            plan: attempt === 1
              ? {
                  kind: "aggregate",
                  resource: "public.orders",
                  measures: [{ function: "avg" }],
                  dimensions: [{ field: "status" }],
                }
              : {
                  kind: "aggregate",
                  resource: "public.orders",
                  measures: [{ function: "avg", field: "amount" }],
                  dimensions: [{ field: "status" }],
                },
          }],
          forbidden: [],
        };
        return provider === "openai"
          ? {
              status: 200,
              body: {
                output: [{
                  type: "function_call",
                  call_id: `call_read_workload_${attempt}`,
                  name: "runner__submit_read_workloads",
                  arguments: JSON.stringify(input),
                }],
              },
            }
          : {
              status: 200,
              body: {
                content: [{
                  type: "tool_use",
                  id: `toolu_read_workload_${attempt}`,
                  name: "runner__submit_read_workloads",
                  input,
                }],
              },
            };
      });

      const result = await generateModelReadWorkload({
        name: "support_reads",
        allowedQuestions: ["What is average order amount by status?"],
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        generatedBoundary: generatedBoundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(requestJson).toHaveBeenCalledTimes(2);
      expect(result.analysis.status).toBe("ready");
      expect(result.workload.allowed[0]?.plan).toMatchObject({ kind: "aggregate" });
      expect(requests[1]).toContain("Your first non-authoritative workload was refused");
      expect(requests[0]).toContain('"enum":["rows"]');
      expect(requests[0]).toContain('"required":["function","field"]');
      expect(requests[1]).toContain("(missing) is not reviewed for avg");
      expect(result).toMatchObject({
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      });
    },
  );

  it("keeps an invalid model mapping blocked and non-authoritative", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_bad_read_workload",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            allowed: [{
              id: "invented_field",
              description: "Invented access",
              plan: { kind: "rows", resource: "public.orders", select: ["not_a_field"] },
            }],
            forbidden: [],
          }),
        }],
      },
    }));

    const result = await generateModelReadWorkload({
      name: "blocked_mapping",
      allowedQuestions: ["Show an invented field"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(result.analysis.status).toBe("blocked");
    expect(result.analysis.candidate).toBeUndefined();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("asks one operator clarification for opaque reviewed metadata instead of guessing", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            clarification_request: {
              resource: "public.orders",
              field: "status",
              reason: "The field name does not explain its business meaning.",
              question: "What does this reviewed status field represent?",
            },
          }
        : {
            allowed: [{
              id: "orders_by_status",
              description: "Count orders by lifecycle status",
              plan: {
                kind: "aggregate",
                resource: "public.orders",
                measures: [{ function: "count" }],
                dimensions: [{ field: "status" }],
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_clarification_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "It is the order lifecycle status used for operational grouping.",
    }));

    const result = await generateModelReadWorkload({
      name: "opaque_reads",
      allowedQuestions: ["Count orders by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    });

    expect(clarificationHandler).toHaveBeenCalledWith({
      resource: "public.orders",
      field: "status",
      reason: "The field name does not explain its business meaning.",
      question: "What does this reviewed status field represent?",
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("order lifecycle status used for operational grouping");
    expect(result.analysis.status).toBe("ready");
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("resolves trusted ownership mechanics without asking the operator", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            clarification_request: {
              resource: "public.orders",
              reason: "Need to enforce that each order belongs to the authenticated customer account.",
              question: "Which exact reviewed field or relationship defines the customer account that owns an order?",
            },
          }
        : {
            allowed: [{
              id: "own_orders",
              description: "List the authenticated customer's reviewed order fields",
              plan: {
                kind: "rows",
                resource: "public.orders",
                select: ["id", "status", "amount"],
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_scope_mechanics_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "The operator should never have to identify trusted scope fields.",
    }));

    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "own_order_reads",
      allowedQuestions: ["Show an authenticated customer their own orders"],
      provider: "openai",
      model: "gpt-5.6-terra",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    }, "public.orders means orders."));

    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("Scope keys are deliberately absent from the model catalog");
    expect(requests[1]).toContain("Do not ask the operator about trusted ownership or scope mechanics again");
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed[0]?.plan).not.toHaveProperty("tenant_id");
    expect(result.workload.allowed[0]?.plan).not.toHaveProperty("principal_id");
  });

  it.each([
    "Is public.orders.id an approved opaque record reference for signed-in users, or is there another reviewed field that should be used for that reference?",
    "Which reviewed public.orders field provides the opaque record reference for users to select an order?",
  ])("resolves opaque selection mechanics without exposing a database key: %s", async (question) => {
    const boundary = generatedBoundary();
    boundary.pack.resources[0]!.model_withheld_fields = ["id"];
    const before = structuredClone(boundary);
    const requestJson = vi.fn().mockResolvedValueOnce({ status: 200, body: { output: [{
      type: "function_call", call_id: "selection_question", name: "runner__submit_read_workloads",
      arguments: JSON.stringify({ clarification_request: { resource: "public.orders",
        reason: "The user must select a record without exposing its internal database identity.", question } }),
    }] } }).mockResolvedValueOnce(diagnosticResponse("valid"));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "private_selection", allowedQuestions: ["Show my orders using opaque selection references"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, env: { OPENAI_API_KEY: "test-key" },
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler }, "public.orders means orders."));
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(2);
    const initialPrompt = JSON.stringify(requestJson.mock.calls[0]?.[0].body);
    const repairPrompt = JSON.stringify(requestJson.mock.calls[1]?.[0].body);
    expect(initialPrompt).toContain("obj_");
    expect(repairPrompt).toContain("not a database field");
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed[0]?.plan).toEqual({ kind: "rows", resource: "public.orders", select: ["status"] });
    expect(boundary).toEqual(before);
  });

  it.each([
    "Does this field identify the customer-facing invoice reference or the order lifecycle status?",
    "Does this opaque reference printed on the customer's bill mean the invoice number or the support case number?",
  ])("keeps ambiguous customer-facing reference meaning as an operator decision: %s", async (question) => {
    const requestJson = vi.fn().mockResolvedValueOnce({ status: 200, body: { output: [{
      type: "function_call", call_id: "business_reference_question", name: "runner__submit_read_workloads",
      arguments: JSON.stringify({ clarification_request: { resource: "public.orders", field: "status",
        reason: "This business reference has an ambiguous meaning.",
        question } }),
    }] } }).mockResolvedValueOnce(diagnosticResponse("valid"));
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "It is the order lifecycle status." }));
    const result = await generateModelReadWorkload(withDeclaredRoot({ name: "business_reference", allowedQuestions: ["Show my order status"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: generatedBoundary(), env: { OPENAI_API_KEY: "test-key" },
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler }, "public.orders means orders."));
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(result.analysis.status).toBe("ready");
  });

  it("bounds a repeated opaque-reference repair without asking the operator or accepting a draft", async () => {
    const boundary = generatedBoundary();
    const before = structuredClone(boundary);
    const requestJson = vi.fn().mockResolvedValue({ status: 200, body: { output: [{
      type: "function_call", call_id: "repeated_reference_question", name: "runner__submit_read_workloads",
      arguments: JSON.stringify({ clarification_request: { resource: "public.orders",
        reason: "Need the opaque record reference.", question: "Which column supplies the opaque selection reference?" } }),
    }] } });
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    const error = await generateModelReadWorkload({ name: "repeated_reference", allowedQuestions: ["Show my orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, env: { OPENAI_API_KEY: "test-key" },
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson }, clarificationHandler }).catch((error) => error);
    expect(error).toBeInstanceOf(ReadWorkloadDraftError);
    expect(error.message).toContain("READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED");
    expect(error.message).toContain("Original question for public.orders: Which column supplies the opaque selection reference?");
    expect(error.message).toContain("Repeated question for public.orders: Which column supplies the opaque selection reference?");
    expect(error.message).toContain("Available links:");
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(boundary).toEqual(before);
  });

  it("intercepts a guessed opaque plan and requires a resource clarification before accepting it", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            allowed: [{
              id: "guessed_opaque_status",
              description: "Count records by guessed status",
              plan: {
                kind: "aggregate",
                resource: "public.tbl_7",
                measures: [{ function: "count" }],
                dimensions: [{ field: "col_2" }],
              },
            }],
            forbidden: [],
          }
        : {
              allowed: [{
                id: "tickets_by_status",
                description: "Count support tickets by lifecycle status",
                plan: {
                  kind: "aggregate",
                  resource: "public.tbl_7",
                  measures: [{ function: "count" }],
                  dimensions: [{ field: "col_2" }],
                },
              }],
              forbidden: [],
              operator_meanings: [{ resource: "public.tbl_7", field: "col_2", operator_quote: "col_2 is lifecycle status" }],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_opaque_guard_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "tbl_7 contains support tickets; col_1 is the ticket id and col_2 is lifecycle status.",
    }));

    const result = await generateModelReadWorkload({
      name: "opaque_support_reads",
      allowedQuestions: ["Count support tickets by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: opaqueGeneratedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({
      resource: "public.tbl_7",
      reason: expect.stringContaining("Runner intercepted"),
      question: expect.stringContaining("business information"),
    }));
    expect(requests[1]).toContain("tbl_7 contains support tickets");
    expect(result.analysis.status).toBe("ready");
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("refuses repeating the same answered clarification without asking the operator again", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_repeat_opaque_clarification",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            clarification_request: {
              resource: "public.tbl_7",
              reason: "Need the same metadata again",
              question: "Explain the selected business records again",
            },
          }),
        }],
      },
    }));
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "tbl_7 contains support tickets and col_2 is lifecycle status.",
    }));

    await expect(generateModelReadWorkload({
      name: "opaque_guess_refused",
      allowedQuestions: ["Count support tickets by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: opaqueGeneratedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_CLARIFICATION_REFUSED/);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).toHaveBeenCalledOnce();
  });

  it("retains two independent coded-field answers through the final validated mapping", async () => {
    const boundary = generatedBoundary();
    const resource = boundary.pack.resources[0]!;
    resource.field_types.col_8 = "text";
    resource.field_types.col_9 = "text";
    resource.selectable_fields.push("col_8", "col_9");
    const requests: string[] = [];
    let attempt = 0;
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      const index = attempt++;
      const args = index < 2 ? { clarification_request: { resource: "public.orders", field: `col_${index + 8}`,
        reason: "The reviewed code has ambiguous business meaning.", question: "What does this selected business detail mean?" } }
        : { allowed: [{ id: "order_details", description: "Review order delivery details", plan: {
          kind: "rows", resource: "public.orders", select: ["col_8", "col_9"],
        } }], forbidden: [] };
      return { status: 200, body: { output: [{ type: "function_call", call_id: `clarification_${index}`,
        name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } };
    });
    const answers = ["Delivery preference", "Gift wrapping preference"];
    const handler = vi.fn(async () => ({ state: "answered" as const, answer: answers.shift()! }));
    const result = await generateModelReadWorkload({ name: "coded_customer_details", allowedQuestions: ["Review delivery and gift wrapping preferences"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true, clarificationHandler: handler, dependencies: { requestJson }, deferNarration: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requests[2]).toContain("Delivery preference");
    expect(requests[2]).toContain("Gift wrapping preference");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
    expect(result.authority_granted).toBe(false);
  });

  it("keeps two technical clarifications on their own target after the one wording correction", async () => {
    const boundary = generatedBoundary(), resource = boundary.pack.resources[0]!;
    resource.field_types.col_8 = "text"; resource.field_types.col_9 = "text";
    resource.selectable_fields.push("col_8", "col_9");
    resource.field_metadata = { ...resource.field_metadata,
      col_8: { label: "Delivery preference" }, col_9: { label: "Gift wrapping preference" } };
    const questions: string[] = [], bodies: string[] = [];
    let calls = 0;
    const requestJson = vi.fn(async request => {
      bodies.push(JSON.stringify(request.body));
      const field = calls++ < 2 ? "col_8" : "col_9";
      const args = calls <= 3 ? { clarification_request: { resource: "public.orders", field,
        reason: "Missing the business meaning", question: `What does orders.${field} mean for this view?` } }
        : { allowed: [{ id: "order_preferences", description: "Review delivery and wrapping preferences",
          plan: { kind: "rows", resource: "public.orders", select: ["col_8", "col_9"] } }], forbidden: [] };
      return { status: 200, body: { output: [{ type: "function_call", call_id: `preference_${calls}`,
        name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } };
    });
    const answers = ["The stated delivery preference", "The stated gift wrapping preference"];
    const result = await generateModelReadWorkload({ name: "order_preferences", allowedQuestions: ["Review both preferences"],
      provider: "openai", model: "gpt-test", generatedBoundary: boundary, env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true, dependencies: { requestJson }, deferNarration: true,
      clarificationHandler: async request => { questions.push(request.question); return { state: "answered", answer: answers.shift()! }; } });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain("Delivery preference");
    expect(questions[1]).toContain("Gift wrapping preference"); expect(questions[1]).not.toContain("Delivery preference");
    expect(bodies[3]).toContain("The stated delivery preference"); expect(bodies[3]).toContain("The stated gift wrapping preference");
    expect(requestJson).toHaveBeenCalledTimes(4);
    expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false);
  });

  it("bounds distinct follow-up questions and retains an explicit failure without accepting a draft", async () => {
    let count = 0;
    const boundary = generatedBoundary();
    const fields = ["status", "amount", "id", "delivery_kind", "gift_kind"];
    boundary.pack.resources[0]!.field_types.delivery_kind = "text";
    boundary.pack.resources[0]!.field_types.gift_kind = "text";
    boundary.pack.resources[0]!.selectable_fields.push("delivery_kind", "gift_kind");
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call",
      call_id: `clarification_${count}`, name: "runner__submit_read_workloads", arguments: JSON.stringify({ clarification_request: {
        resource: "public.orders", field: fields[count], reason: "Need business meaning", question: `What is this field's meaning number ${++count}?`,
      } }) }] } }));
    const handler = vi.fn(async () => ({ state: "answered" as const, answer: "This is the order lifecycle status." }));
    await expect(generateModelReadWorkload({ name: "bounded_clarifications", allowedQuestions: ["Count orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: boundary, env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true, clarificationHandler: handler, dependencies: { requestJson }, deferNarration: true,
    })).rejects.toThrow("Four business questions were answered");
    expect(handler).toHaveBeenCalledTimes(4);
    expect(requestJson).toHaveBeenCalledTimes(5);
  });

  it("does not ask the operator to answer paraphrases of an already answered business question", async () => {
    let count = 0;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call",
      call_id: `clarification_${count++}`, name: "runner__submit_read_workloads", arguments: JSON.stringify({ clarification_request: {
        resource: "public.orders", field: "status", reason: "Need business meaning",
        question: count === 1 ? "What does status mean?" : "Could you clarify the meaning of status again?",
      } }) }] } }));
    const handler = vi.fn(async () => ({ state: "answered" as const, answer: "The order lifecycle state." }));
    await expect(generateModelReadWorkload({ name: "repeated_clarification", allowedQuestions: ["Count orders"],
      provider: "openai", model: "gpt-5.6-terra", generatedBoundary: generatedBoundary(), env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true, clarificationHandler: handler, dependencies: { requestJson }, deferNarration: true,
    })).rejects.toThrow(/same business question.*already answered/i);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("allows one naming clarification followed by one separately approved value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            clarification_request: {
              resource: "public.orders",
              field: "status",
              reason: "Need the business meaning before choosing a status code.",
              question: "What business state does status represent?",
            },
          }
        : attempt === 2
          ? {
              value_request: {
                resource: "public.orders",
                field: "status",
                reason: "The active code is not schema-declared.",
                question: "Which exact status code means active?",
              },
            }
          : {
              allowed: [{
                id: "active_orders",
                description: "List active orders",
                plan: {
                  kind: "rows",
                  resource: "public.orders",
                  select: ["id", "status"],
                  where: [{ field: "status", op: "eq", value: "OPN" }],
                },
              }],
              forbidden: [],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_two_step_help_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "status is the order lifecycle state; active is one database-specific code.",
    }));
    const valueRequestHandler = vi.fn(async () => ({
      state: "provided" as const,
      resource: "public.orders",
      field: "status",
      values: ["OPN"],
      egressAcknowledged: true as const,
    }));

    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "two_step_read_help",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      valueRequestHandler,
      dependencies: { requestJson },
    }, "public.orders means orders."));

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(valueRequestHandler).toHaveBeenCalledOnce();
    expect(requests[1]).toContain("one value_request now");
    expect(requests[2]).toContain("separately approved these exact values");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("preserves approved values when one naming clarification follows the value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The active code is not schema-declared.",
              question: "Which exact status code means active?",
            },
          }
        : attempt === 2
          ? {
              clarification_request: {
                resource: "public.orders",
                field: "status",
                reason: "Need the field's business meaning before using the approved code.",
                question: "What business state does status represent?",
              },
            }
          : {
              allowed: [{
                id: "active_orders",
                description: "List active orders",
                plan: {
                  kind: "rows",
                  resource: "public.orders",
                  select: ["id", "status"],
                  where: [{ field: "status", op: "eq", value: "OPN" }],
                },
              }],
              forbidden: [],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_value_then_name_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });

    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "value_then_name_help",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler: async () => ({
        state: "provided",
        resource: "public.orders",
        field: "status",
        values: ["OPN"],
        egressAcknowledged: true,
      }),
      clarificationHandler: async () => ({
        state: "answered",
        answer: "status is the order lifecycle state.",
      }),
      dependencies: { requestJson },
    }, "public.orders means orders."));

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requests[2]).toContain("approved these exact values");
    expect(requests[2]).toContain("OPN");
    expect(requests[2]).toContain("plan.where");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
  });

  it("sends only separately approved exact values after a model value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The question refers to a business status whose exact stored code is not declared by the schema.",
              question: "Which exact reviewed status values represent active work?",
            },
          }
        : {
            allowed: [{
              id: "active_orders",
              description: "List orders in active status",
              plan: {
                kind: "rows",
                resource: "public.orders",
                select: ["id", "status"],
                where: [{ field: "status", op: "in", value: ["open"] }],
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_values_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const valueRequestHandler = vi.fn(async () => ({
      state: "provided" as const,
      resource: "public.orders",
      field: "status",
      values: ["open"],
      egressAcknowledged: true as const,
    }));

    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "value_assisted_reads",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler,
      dependencies: { requestJson },
    }, "public.orders means orders."));

    expect(valueRequestHandler).toHaveBeenCalledWith(expect.objectContaining({
      resource: "public.orders",
      field: "status",
    }));
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[0]).not.toContain("separately approved these exact values");
    expect(requests[1]).toContain("separately approved these exact values");
    expect(requests[1]).toContain("open");
    expect(requests.join("\n")).not.toContain("provider-test-key");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("corrects a non-grammar filters key without requesting approved values again", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The active status code is not declared by the schema.",
              question: "Which exact status code means active?",
            },
          }
        : {
            allowed: [{
              id: "active_orders",
              description: "List active orders",
              plan: {
                kind: "rows",
                resource: "public.orders",
                select: ["id", "status"],
                ...(attempt === 2
                  ? { filters: [{ field: "status", op: "eq", value: "OPN" }] }
                  : { where: [{ field: "status", op: "eq", value: "OPN" }] }),
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_value_grammar_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });

    const result = await generateModelReadWorkload(withDeclaredRoot({
      name: "correct_value_filter_grammar",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler: async () => ({
        state: "provided",
        resource: "public.orders",
        field: "status",
        values: ["OPN"],
        egressAcknowledged: true,
      }),
      dependencies: { requestJson },
    }, "public.orders means orders."));

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requests[2]).toContain("Do not request them again");
    expect(requests[2]).toContain("plan.where");
    expect(requests[2]).toContain("OPN");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
  });

  it("refuses a value request for a field outside the exact model-visible catalog", async () => {
    const valueRequestHandler = vi.fn();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_read_secret_values",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            value_request: {
              resource: "public.orders",
              field: "secret_note",
              reason: "Need hidden values",
              question: "Send hidden notes",
            },
          }),
        }],
      },
    }));

    await expect(generateModelReadWorkload({
      name: "refused_values",
      allowedQuestions: ["Show hidden notes"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_VALUE_REQUEST_REFUSED/);
    expect(valueRequestHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("requires an interactive decision before any requested Read value context can leave", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_read_value_without_handler",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "Need exact codes",
              question: "Which status codes are active?",
            },
          }),
        }],
      },
    }));

    await expect(generateModelReadWorkload({
      name: "noninteractive_values",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_VALUE_CONTEXT_REQUIRED.*No source query ran/);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("publishes only model-visible structural catalog fields", () => {
    const catalog = readWorkloadCatalog(generatedBoundary());
    const serialized = JSON.stringify(catalog);
    expect(serialized).toContain("public.orders");
    expect(serialized).not.toContain("tenant_id");
    expect(serialized).not.toContain("principal_id");
    expect(serialized).not.toContain("secret_note");
    expect(serialized).toContain('"schema_declared_values":["open","closed"]');
    expect(serialized).toContain('"value_source":"schema_declared_enum_or_check"');
    expect(serialized).not.toContain("sampled-status-from-row");
    expect(catalog.trust).toEqual({
      model_supplies_tenant: false,
      model_supplies_principal: false,
      model_supplies_object_scope: false,
      raw_rows_included: false,
      database_values_included: false,
    });
  });
});

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

function opaqueGeneratedBoundary(): ExplorationBoundaryDraft {
  const boundary = structuredClone(generatedBoundary());
  const resource = boundary.pack.resources[0]!;
  resource.id = "public.tbl_7";
  resource.schema = "public";
  resource.table = "tbl_7";
  delete resource.label;
  delete resource.description;
  resource.primary_key = "col_1";
  resource.tenant_key = "tenant_id";
  delete resource.principal_key;
  resource.field_types = {
    col_1: "uuid",
    col_2: "text",
    tenant_id: "text",
  };
  resource.field_enums = { col_2: ["A1", "B2"] };
  resource.selectable_fields = ["col_1", "col_2"];
  resource.filterable_fields = { col_2: ["eq", "neq", "in"] };
  resource.sortable_fields = [];
  resource.groupable_fields = ["col_2"];
  resource.aggregate_measures = [];
  resource.aggregate_measure_functions = {};
  resource.count_distinct_fields = ["col_2"];
  resource.time_bucket_fields = {};
  resource.kept_out_fields = [];
  resource.field_metadata = {};
  return boundary;
}

function generatedBoundaryWithoutStatusEnum(): ExplorationBoundaryDraft {
  const boundary = structuredClone(generatedBoundary());
  boundary.pack.resources[0]!.field_enums = {};
  return boundary;
}


it("retains the original wording constraints across native interruption of its single rephrase", async () => {
  const boundary=generatedBoundary(); boundary.pack.resources[0]!.field_metadata={status:{label:"Fulfillment stage"}};
  const declaredTask="List at most 5 purchases, never including canceled purchases; clarify the current fulfillment stage meaning.";
  const original="Should public.orders.status identify current fulfillment stage for a view of at most 5 purchases that must never include canceled purchases?";
  const changed="Should public.orders.status identify current fulfillment stage for a view of at most 9 purchases that may include canceled purchases?";
  const target={resource:"public.orders",field:"status"};
  const context=operatorBusinessContext(readWorkloadCatalog(boundary).resources);
  const control=operatorClarificationGate({stage:"read",context,target});
  expect(control(original).state).toBe("rephrase");
  const ordinary=control(changed);expect(ordinary).toMatchObject({state:"question",fallback:true});
  if(ordinary.state!=="question")throw new Error("Expected the existing local constraint fallback");
  const requests:unknown[]=[],asked:string[]=[],checkpoints:ReadWorkloadAssistanceCheckpoint[]=[];
  let state:AuthoringTransportState={version:1,operations:[]},checkpoint:ReadWorkloadAssistanceCheckpoint|undefined,sends=0;
  const response=(question:string)=>({status:"completed",output:[{type:"function_call",call_id:"bounded_wording",name:"runner__submit_read_workloads",arguments:JSON.stringify({clarification_request:{...target,question,reason:"Current fulfillment stage meaning is unresolved."}})}]});
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=String(chunk);requests.push(JSON.parse(raw));sends++;
    if(sends===2){res.writeHead(200,{"content-type":"application/json","content-length":"9999"});res.write('{"unfinished":');setTimeout(()=>res.destroy(),10);return;}
    res.setHeader("content-type","application/json");res.end(JSON.stringify(response(sends===1?original:changed)));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
  const host={available:()=>true,read:()=>state,current:async()=>canonicalJsonDigest({declaredTask,catalog:readWorkloadCatalog(boundary).digest}),write:async(value:AuthoringTransportState)=>{validateAuthoringTransportState(value);state=structuredClone(value);}};
  const entering=(resume:boolean)=>withAuthoringGenerationRecovery(()=>{configureAuthoringGenerationRecovery(host);return generateModelReadWorkload({
    name:"owned_wording_resume",allowedQuestions:[declaredTask],provider:"openai",model:"owned-local-fixture",generatedBoundary:boundary,apiKey:"test-key",egressAcknowledged:true,deferNarration:true,
    dependencies:{requestJson:r=>secureAskJsonRequest({...r,endpoint,scope:"custom_loopback"})},...(resume?{resumeCheckpoint:checkpoint}:{}),
    onCheckpoint:async value=>{checkpoint=structuredClone(value);if(value)checkpoints.push(structuredClone(value));},
    clarificationHandler:async request=>{asked.push(request.question);return undefined;}
  });});
  let old="",firstOutcome="",resumeOutcome="";
  try{
    await entering(false).catch(error=>{firstOutcome=error.code??error.message;});
    expect(firstOutcome).toBe("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION");expect(sends).toBe(2);
    expect(state.operations.at(-1)?.state).toBe("partial");expect(checkpoint).toMatchObject({stage:"dispatching",state:{correction_used:true,call_count:1,attempt:2}});
    expect(JSON.stringify(requests[0])).toContain("Fulfillment stage");expect(JSON.stringify(requests[0])).toContain(declaredTask);
    expect(JSON.stringify(requests[1])).toContain("Rephrase the same missing business question once");expect(asked).toEqual([]);
    old=JSON.stringify(state.operations[1]);
    await withAuthoringGenerationRecovery(async()=>{configureAuthoringGenerationRecovery(host);
      await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint!.digest,undefined,state.operations[0]!.id),{mode:"local_review"});
      await permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(checkpoint!.digest));
    });
    await entering(true).catch(error=>{resumeOutcome=error.code??error.message;});
    expect(resumeOutcome).toContain("READ_WORKLOAD_AUTHORING_PAUSED");expect(sends).toBe(3);expect(JSON.stringify(state.operations[1])).toBe(old);
    expect(asked).toHaveLength(1);expect(asked[0]).toBe(ordinary.question);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));

  }
});
