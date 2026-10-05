import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleAuthoringCheckpoint, parseActionRuleAuthoringCheckpoint, actionLogicalTurnBudget, assertActionLogicalTurnJournalAdvance, actionLogicalTurnMaterialDigest } from "./action-rule-authoring-checkpoint.js";
import { authoringQuestionCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery,
  type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { createOwnerHandoff, ownerHandoffCheckpoint } from "./authoring-owner-handoff.js";
import { createOperatorQuestion, presentOperatorQuestion } from "./authoring-operator-question.js";
import { askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn,
  type AskProviderDependencies, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";

const base = () => actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest("Prepare the disabled parcel Action."),
  context_digest: canonicalJsonDigest("Current controlled context."), components: {} });

describe("existing Action checkpoint parser controls", () => {
  it("retains a legacy checkpoint without inventing a turn or counter record", () => {
    const checkpoint = base();
    expect(parseActionRuleAuthoringCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
    expect(checkpoint).not.toHaveProperty("logical_turns");
  });
  it("refuses unsealed material tampering and unrelated unknown fields", () => {
    const checkpoint = base();
    expect(() => parseActionRuleAuthoringCheckpoint({ ...checkpoint, components: { effect: { operation: "update" } } })).toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
    expect(() => parseActionRuleAuthoringCheckpoint({ ...checkpoint, invented_admission: true })).toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
});

// Prospective structural contract only. These synthetic counter values are not
// observed admissions. Genuine rollover/currentness requires the producer/CAS
// fixture described in the accompanying plan, never a parser-only assertion.
const activeTurn = (iterations = 11, callbacks = 23) => ({ id: randomUUID(),
  origin_context_digest: base().context_digest, iterations_used: iterations, tool_calls_used: callbacks });
function seal(extra: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...body } = { ...base(), ...extra };
  return { ...body, digest: canonicalJsonDigest(body) };
}

async function genuinePendingVersion() {
  const context = base().context_digest;
  const tools: AskToolDefinition[] = [{ name: "runner.review_version_field", description: "Controlled metadata-only question stage.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } }];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "controlled-parser-model",
    api_key: "inert-parser-credential", egress_acknowledged: true, authority_digest: authorityDigest }, {}, new Date());
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => ({ status: 200,
    body: { status: "completed", output: [{ type: "function_call", call_id: "stage-version-question",
      name: "runner__review_version_field", arguments: "{}" }] } }));
  const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools,
    callTool: async () => ({ ok: true, value: { state: "pending", authority_granted: false } }), close: async () => {} };
  let state: AuthoringTransportState | undefined;
  return withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state,
      write: async next => { state = structuredClone(next); }, current: async () => context });
    const result = await runAskProviderTurn({ configuration, tools, authorityDigest, gateway,
      question: "Prepare the disabled parcel Action.", history: [], conversationalAuthoring: true,
      signal: new AbortController().signal, stopAfterAuthoringToolBatch: () => true, dependencies: { requestJson } });
    const completion = completedAuthoringQuestion(result);
    expect(completion).toBeDefined();
    if (!completion) throw new Error("The actual decoder did not provide a completed consumer association.");
    const wording = "Do all applications changing a parcel advance this counter?";
    const handoff = createOwnerHandoff({ consumer: "version_maintenance", question: wording,
      scope_digest: base().intent_digest, context_digest: context, completion });
    const question = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1,
      handoff_id: handoff.id, kind: "writer_maintenance", scope_digest: handoff.scope_digest,
      context_digest: context, target: { phase: "conflict counter", resource: "work.parcels", field: "revision", outcomes: ["work.hold"] },
      material: ["Mapping is not a verified implementation or permission."], evidence: [], continuation: "version_mapping" }), wording);
    state = authoringQuestionCheckpoint(state, ownerHandoffCheckpoint(handoff));
    expect(requestJson).toHaveBeenCalledOnce();
    expect(state!.operations[0]!.state).toBe("checkpointed");
    expect(state!.operations[0]!.question_handoff!.consumer).toBe("version_maintenance");
    expect(question.budget).toBeUndefined(); expect(question.raw_answer).toBeUndefined();
    const turn = activeTurn(1, 1);
    return { checkpoint: seal({ logical_turns: [turn], pending_question: {
      question: wording, operator_message: "Prepare the disabled parcel Action.", completion },
      pending_version: { turn_id: turn.id, root_question_id: question.id, question_id: question.id,
        handoff_id: handoff.id, resource: question.target.resource, field: question.target.field,
        proof_digest: canonicalJsonDigest("Controlled parser proof shape, not a catalog verdict.") } }),
      turn, question, handoff, completion, state };
  });
}

describe("prospective Version logical-turn checkpoint parser, not producer or authority acceptance", () => {
  it.each([[11, 23], [12, 24]])("retains synthetic active-tail counters %i/%i exactly through serialization", (iterations, callbacks) => {
    const record = seal({ logical_turns: [activeTurn(iterations, callbacks)] });
    expect(parseActionRuleAuthoringCheckpoint(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
  it("retains sparse correction-root IDs without inventing a second chain identity or local pool", () => {
    const turn = { ...activeTurn(), used_version_corrections: [randomUUID(), randomUUID()] };
    const record = seal({ logical_turns: [turn] });
    // Resolution to actual retained typed roots is a host/producer check.
    expect(parseActionRuleAuthoringCheckpoint(record)).toEqual(record);
  });
  it("retains an actual pending physical completion without closing the ordinary logical turn", async () => {
    const f = await genuinePendingVersion();
    const parsed = parseActionRuleAuthoringCheckpoint(f.checkpoint);
    expect(parsed).toEqual(f.checkpoint);
    expect(parsed).toMatchObject({ logical_turns: [f.turn], pending_version: { question_id: f.question.id } });
    expect(f.turn).not.toHaveProperty("completed");
    expect(parsed).not.toHaveProperty("reviewed_version_fields");
  });
  it.each([
    { iterations_used: 13 }, { iterations_used: -1 }, { iterations_used: 1.5 },
    { tool_calls_used: 25 }, { tool_calls_used: "24" },
    { used_version_corrections: ["not-a-root-id"] },
    { extra_turn_pool: { iterations_used: 0, tool_calls_used: 0 } },
  ])("refuses malformed/reopened turn fields after the valid positive is established: %j", bad => {
    const turn = activeTurn(), valid = seal({ logical_turns: [turn] });
    expect(parseActionRuleAuthoringCheckpoint(valid)).toEqual(valid);
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [{ ...turn, ...bad }] })))
      .toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
  it("refuses duplicate sparse correction roots rather than silently deduplicating them", () => {
    const root = randomUUID(), turn = { ...activeTurn(), used_version_corrections: [root] };
    const valid = seal({ logical_turns: [turn] }); expect(parseActionRuleAuthoringCheckpoint(valid)).toEqual(valid);
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [{ ...turn, used_version_corrections: [root, root] }] })))
      .toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
  it("refuses journal material tampering without a matching envelope digest", () => {
    const turn = activeTurn(), valid = seal({ logical_turns: [turn] });
    expect(parseActionRuleAuthoringCheckpoint(valid)).toEqual(valid);
    expect(() => parseActionRuleAuthoringCheckpoint({ ...valid, logical_turns: [{ ...turn, tool_calls_used: 0 }] }))
      .toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
  it("requires the pending association to point to its sole active owning turn", async () => {
    const f = await genuinePendingVersion(); expect(parseActionRuleAuthoringCheckpoint(f.checkpoint)).toEqual(f.checkpoint);
    const pending = f.checkpoint.pending_version as Record<string, unknown>;
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...f.checkpoint,
      pending_version: { ...pending, turn_id: randomUUID() } }))).toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
  it("refuses a pending marker with no actual pending-question completion", async () => {
    const f = await genuinePendingVersion(); expect(parseActionRuleAuthoringCheckpoint(f.checkpoint)).toEqual(f.checkpoint);
    const pending = f.checkpoint.pending_question as Record<string, unknown>;
    const { completion: _completion, ...withoutCompletion } = pending;
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...f.checkpoint, pending_question: withoutCompletion })))
      .toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
  it("refuses unsealed drift of the exact pending counter field", async () => {
    const f = await genuinePendingVersion(); expect(parseActionRuleAuthoringCheckpoint(f.checkpoint)).toEqual(f.checkpoint);
    const pending = f.checkpoint.pending_version as Record<string, unknown>;
    expect(() => parseActionRuleAuthoringCheckpoint({ ...f.checkpoint,
      pending_version: { ...pending, field: "other_revision" } })).toThrow("ACTION_AUTHORING_CHECKPOINT_INVALID");
  });
});


describe("Version owning journal structural transitions and real Resume CAS", () => {
  it("rejects zero-seeding an existing interrupted legacy checkpoint", () => {
    const previous = base(), next = parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [activeTurn(0, 0)] }));
    expect(() => assertActionLogicalTurnJournalAdvance(previous, next)).toThrow("LOGICAL_TURN_STALE");
    expect(() => assertActionLogicalTurnJournalAdvance(undefined, next)).not.toThrow();
  });
  it.each(["id", "origin", "decrease-iteration", "decrease-callback", "correction-root"] as const)("rejects active-tail drift: %s", kind => {
    const root = randomUUID(), turn = { ...activeTurn(5, 7), used_version_corrections: [root] };
    const previous = parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [turn] }));
    const changed = { ...turn, ...(kind === "id" ? { id: randomUUID() } : kind === "origin" ? { origin_context_digest: canonicalJsonDigest("changed") }
      : kind === "decrease-iteration" ? { iterations_used: 4 } : kind === "decrease-callback" ? { tool_calls_used: 6 }
      : { used_version_corrections: [randomUUID()] }) };
    const next = parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [changed] }));
    expect(() => assertActionLogicalTurnJournalAdvance(previous, next)).toThrow("LOGICAL_TURN_STALE");
  });
  it("cannot append a new tail behind an unresolved Version owner", async () => {
    const f = await genuinePendingVersion(), previous = parseActionRuleAuthoringCheckpoint(f.checkpoint);
    expect(() => parseActionRuleAuthoringCheckpoint(seal({ ...previous, logical_turns: [f.turn, activeTurn(0, 0)] })))
      .toThrow("CHECKPOINT_INVALID");
    expect(previous.logical_turns![0]!.completed).toBeUndefined();
  });
  it("keeps closed prefixes immutable and the material digest excludes own journal metadata", async () => {
    const f = await genuinePendingVersion();
    const material = base(), closed = { ...activeTurn(1, 1), completed: { kind: "compiled_draft" as const,
      completion: f.completion, material_digest: actionLogicalTurnMaterialDigest(material) } };
    const previous = parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [closed, activeTurn(0, 0)] }));
    expect(actionLogicalTurnMaterialDigest(previous)).toBe(actionLogicalTurnMaterialDigest(material));
    const turns = structuredClone(previous.logical_turns!); turns[0]!.iterations_used = 2;
    const next = parseActionRuleAuthoringCheckpoint(seal({ logical_turns: turns }));
    expect(() => assertActionLogicalTurnJournalAdvance(previous, next)).toThrow("LOGICAL_TURN_STALE");
    // This structural record does not prove ordinary closure or INPUT consent.
  });
  async function diskFixture(iterations = 0, callbacks = 0) {
    const resume = await import("./boundary-authoring-resume.js");
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-version-logical-cas-"));
    const binding = { boundary_name: "parcel_read", generation_lock_fingerprint: canonicalJsonDigest("controlled lock"),
      schema_fingerprint: canonicalJsonDigest("controlled schema"), role_posture_fingerprint: canonicalJsonDigest("controlled role") };
    let current = resume.buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Prepare the disabled parcel Action.",
      provider: "openai", model: "controlled", action: { intent: "Prepare the disabled parcel Action.",
        checkpoint: parseActionRuleAuthoringCheckpoint(seal({ logical_turns: [activeTurn(iterations, callbacks)] })) } });
    await resume.writeBoundaryAuthoringResumeState(projectRoot, current, { expectedRevisionDigest: null });
    const owner = (snapshot = current) => {
      let owned = structuredClone(snapshot);
      return { budget: actionLogicalTurnBudget({ read: () => owned.action!.checkpoint!, save: async (checkpoint, expected) => {
        if (owned.action!.checkpoint!.digest !== expected) throw new Error("ACTION_AUTHORING_LOGICAL_TURN_STALE");
        assertActionLogicalTurnJournalAdvance(owned.action!.checkpoint, checkpoint);
        const next = resume.buildBoundaryAuthoringResumeState({ binding, stage: owned.stage, jobIntent: owned.job_intent,
          provider: owned.model.provider, model: owned.model.name, previous: owned,
          action: { ...owned.action!, checkpoint } });
        await resume.writeBoundaryAuthoringResumeState(projectRoot, next, { expectedRevisionDigest: owned.revision_digest });
        owned = next; current = next;
      } }), read: () => owned };
    };
    const reload = async () => {
      const saved = await resume.readBoundaryAuthoringResumeState(projectRoot, binding);
      if (saved.status !== "ready") throw new Error("Real Resume did not retain the checkpoint");
      current = saved.value; return saved.value;
    };
    return { owner, reload, root: projectRoot, current: () => current };
  }
  it("retains 12/24 across actual disk restart and refuses the next admission", async () => {
    const f = await diskFixture();
    try {
      const first = f.owner();
      for (let i = 0; i < 12; i += 1) { await first.budget.admitIteration(); await first.budget.reserveToolBatch(2); }
      const saved = await f.reload(), restarted = f.owner(saved);
      expect(saved.action!.checkpoint!.logical_turns!.at(-1)).toMatchObject({ iterations_used: 12, tool_calls_used: 24 });
      await expect(restarted.budget.admitIteration()).rejects.toMatchObject({ code: "ASK_LOOP_LIMIT_EXCEEDED" });
      await expect(restarted.budget.reserveToolBatch(1)).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
      expect((await f.reload()).revision_digest).toBe(saved.revision_digest);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("real competing Resume admissions cannot both consume one old counter baseline", async () => {
    const f = await diskFixture(10, 20);
    try {
      const a = f.owner(), b = f.owner();
      const results = await Promise.allSettled([a.budget.admitIteration(), b.budget.admitIteration()]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason:
        expect.objectContaining({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" }) })]);
      expect((await f.reload()).action!.checkpoint!.logical_turns!.at(-1)!.iterations_used).toBe(11);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("reserves an entire batch atomically, preserving the disk on overflow", async () => {
    const f = await diskFixture(11, 23);
    try {
      const owner = f.owner(), before = f.current().revision_digest;
      await expect(owner.budget.reserveToolBatch(2)).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
      expect((await f.reload()).revision_digest).toBe(before);
      await owner.budget.reserveToolBatch(1);
      expect((await f.reload()).action!.checkpoint!.logical_turns!.at(-1)!.tool_calls_used).toBe(24);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
