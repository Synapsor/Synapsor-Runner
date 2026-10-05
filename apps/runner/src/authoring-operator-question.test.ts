import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint } from "./authoring-owner-handoff.js";
import { authoringQuestionCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import { AskError, askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn,
  type AskToolDefinition, type AskToolGateway } from "./model-ask.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending,
  operatorQuestionEpisode, operatorQuestionReadback, parseOperatorQuestion, parseOperatorQuestions,
  presentOperatorQuestion, proposeOperatorAnswer, reopenOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

// Prospective question contract, local delivery only. These exercise the real
// record/required-tool/provider boundaries; no upstream request is possible.
const tools: AskToolDefinition[] = [{ name: "runner.map_operator_answer", title: "Propose an answer mapping",
  description: "Untrusted mapping; no authority.", input_schema: { type: "object", additionalProperties: false,
    properties: {}, required: [] } }];

function controlledTurn(provider: "openai" | "anthropic", count: number, used: number,
  options: { initialIterations?: number; noImmediateCompletion?: boolean; callbackFails?: boolean } = {}) {
  let iterations = options.initialIterations ?? 0;
  let reserved = used;
  const callTool = vi.fn(async () => {
    if (options.callbackFails) throw new Error("CONTROLLED_CALLBACK_OUTCOME_UNCERTAIN");
    return { ok: true, value: { pending: true } };
  });
  const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools, callTool, close: async () => {} };
  let requests = 0;
  const requestJson = vi.fn(async () => ({ status: 200, body: ++requests === 1
    ? provider === "openai"
      ? { output: Array.from({ length: count }, (_, n) => ({ type: "function_call", call_id: `local-${n}`,
          name: "runner__map_operator_answer", arguments: "{}" })) }
      : { content: Array.from({ length: count }, (_, n) => ({ type: "tool_use", id: `local-${n}`,
          name: "runner__map_operator_answer", input: {} })) }
    : provider === "openai"
      ? { output: [{ type: "message", content: [{ type: "output_text", text: "Pending." }] }] }
      : { content: [{ type: "text", text: "Pending." }] } }));
  const episodeBudget = {
    admitIteration: async () => { if (iterations >= 6) throw new AskError("ASK_TOOL_BUDGET_EXCEEDED", "Saved episode exhausted.", 422); iterations++; },
    reserveToolBatch: async (n: number) => {
      if (reserved + n > 8) throw new AskError("ASK_TOOL_BUDGET_EXCEEDED", "Saved episode tool allowance exhausted.", 422);
      reserved += n;
    },
  };
  const run = () => runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider,
    model: "local-controlled", api_key: "inert-local-credential", egress_acknowledged: true,
    authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()), question: "Propose this saved answer's mapping.",
    history: [], gateway, tools, signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools),
    ...(count === 1 && !options.noImmediateCompletion ? { requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true } : {}),
    dependencies: { requestJson }, episodeBudget });
  return { run, callTool, requestJson, reserved: () => reserved };
}

describe("operator-question evidence and owning episode", () => {
  it("keeps exact trusted raw words, including surrounding whitespace and Unicode", () => {
    const pending = createOwnerHandoff({ consumer: "read_clarification", question: "What does the handling stage mean?",
      scope_digest: canonicalJsonDigest("job"), context_digest: canonicalJsonDigest("current") });
    const raw = "  11 means waiting; 😀 e\u0301 stays as written.  \n";
    const answered = answerOwnerHandoff(pending, raw, pending.context_digest);
    expect(answered.state).toBe("answered");
    if (answered.state === "answered") expect(answered.answer).toBe(raw);
  });

  it("shares one durably reserved required-tool correction across presentation and mapping", async () => {
    let correctionUsed = false;
    const reserveCorrection = vi.fn(async () => {
      if (correctionUsed) return false;
      correctionUsed = true; return true;
    });
    const malformed = () => new AskError("ASK_TOOL_ARGUMENTS_INVALID", "Controlled complete invalid content.");
    const presentation = vi.fn().mockRejectedValueOnce(malformed()).mockResolvedValueOnce("question");
    await runRequiredAuthoringToolCall({ run: presentation, question: "Present", toolName: "runner.present_question", reserveCorrection });
    const mappingFailure = malformed();
    const mapping = vi.fn().mockRejectedValueOnce(mappingFailure).mockResolvedValueOnce("forbidden extra repair");
    await expect(runRequiredAuthoringToolCall({ run: mapping, question: "Map", toolName: tools[0]!.name, reserveCorrection }))
      .rejects.toBe(mappingFailure);
    expect(mapping).toHaveBeenCalledOnce();
    expect(reserveCorrection).toHaveBeenCalledTimes(2);
  });

  it.each(["openai", "anthropic"] as const)("checks the whole resumed batch before any callback (%s)", async provider => {
    const turn = controlledTurn(provider, 2, 7);
    await expect(turn.run()).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
    expect(turn.callTool).not.toHaveBeenCalled();
    expect(turn.reserved()).toBe(7);
  });

  it.each(["openai", "anthropic"] as const)("allows exactly the eighth tool without resetting the saved count (%s)", async provider => {
    const turn = controlledTurn(provider, 1, 7);
    await turn.run();
    expect(turn.callTool).toHaveBeenCalledOnce();
    expect(turn.reserved()).toBe(8);
  });
  it.each(["openai", "anthropic"] as const)("reports known next-iteration exhaustion after completed handling (%s)", async provider => {
    const turn = controlledTurn(provider, 1, 0, { initialIterations: 5, noImmediateCompletion: true });
    await expect(turn.run()).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
    expect(turn.requestJson).toHaveBeenCalledOnce(); expect(turn.callTool).toHaveBeenCalledOnce();
  });
  it("keeps a genuinely thrown callback fenced for inspection", async () => {
    const turn = controlledTurn("openai", 1, 0, { callbackFails: true });
    await expect(turn.run()).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
    expect(turn.requestJson).toHaveBeenCalledOnce(); expect(turn.callTool).toHaveBeenCalledOnce();
  });
});

function record(kind: OperatorQuestion["kind"] = "attributed_meaning", assisted = false) {
  const h = createOwnerHandoff({ consumer: kind === "input_bounds" ? "input_policy" : kind === "writer_maintenance" ? "version_maintenance" : "read_clarification",
    question: "What should the handling stage mean for this task?", scope_digest: canonicalJsonDigest("job"), context_digest: canonicalJsonDigest("current") });
  const q = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: h.id, kind,
    scope_digest: h.scope_digest, context_digest: h.context_digest,
    target: { phase: "Read mapping", resource: "work.orders", field: kind === "writer_maintenance" ? "version" : "status", outcomes: ["work.hold"] },
    evidence: [{ id: "policy:current", digest: canonicalJsonDigest("policy") }], material: ["Only this task; no access or execution grant."],
    continuation: kind === "input_bounds" ? "input_policy_review" : kind === "writer_maintenance" ? "version_mapping" : "read_mapping", assistedLocalConsumer: assisted });
  return { h, q };
}
const mapping = (q: OperatorQuestion, value: unknown = { kind: q.kind }) => ({ question_id: q.id, revision: q.revision,
  answer_id: q.raw_answer!.id, disposition: "proposed", value });
function seal(value: OperatorQuestion): OperatorQuestion {
  const { digest: _, ...body } = value; return { ...body, digest: canonicalJsonDigest(body) };
}

function sourceRecord() {
  const { q } = record("input_bounds", true);
  const { handoff_id: _, ...body } = q;
  const source_binding = { source_session: randomUUID(), source_digest: canonicalJsonDigest("saved policy"),
    store_digest: canonicalJsonDigest("store"), lines: 3, agenda_digest: "" };
  source_binding.agenda_digest = canonicalJsonDigest({ source_session: source_binding.source_session,
    source_digest: source_binding.source_digest, store_digest: source_binding.store_digest, outcomes: q.target.outcomes });
  return parseOperatorQuestion(seal({ ...body, source_binding } as unknown as OperatorQuestion));
}

// Genuine consumed controlled-provider/B35 provenance. This setup generation
// is recorded separately from the root's counter-primitive assertions below;
// the integrated controller tests reserve its real owning root allowance.
async function sourceQuestionFixture() {
  const root = sourceRecord();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-input-source-episode-"));
  const binding = { boundary_name: "work", generation_lock_fingerprint: canonicalJsonDigest("lock"),
    schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("roles") };
  const input = { binding, stage: "action_drafting" as const, jobIntent: "Review parcel note", provider: "openai" as const, model: "local-controlled" };
  let state = buildBoundaryAuthoringResumeState({ ...input, operatorQuestions: [root] });
  await writeBoundaryAuthoringResumeState(dir, state, { expectedRevisionDigest: null });
  const persist = async (next: BoundaryAuthoringResumeState) => {
    await writeBoundaryAuthoringResumeState(dir, next, { expectedRevisionDigest: state.revision_digest }); state = next;
  };
  const produced = await withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery,
      current: async () => root.context_digest, progress: () => {}, write: recovery => persist(
        buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery: recovery })) });
    const local = controlledTurn("openai", 1, 0);
    const result = await local.run();
    const completion = completedAuthoringQuestion(result);
    if (!completion) throw new Error("Controlled turn did not complete.");
    const h = createOwnerHandoff({ consumer: "input_policy", question: "How short or long may the parcel note be?",
      scope_digest: root.scope_digest, context_digest: root.context_digest, completion });
    const child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: root.revision + 1,
      handoff_id: h.id, budget_owner_id: root.id, kind: root.kind, scope_digest: root.scope_digest,
      context_digest: root.context_digest, target: root.target, material: root.material, evidence: root.evidence,
      continuation: root.continuation }), h.question);
    await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, operatorQuestions: [root, child], ownerHandoffs: [h],
      generationRecovery: authoringQuestionCheckpoint(state.generation_recovery, ownerHandoffCheckpoint(h)) }));
    expect(local.requestJson).toHaveBeenCalledTimes(1);
    expect(state.generation_recovery!.operations).toHaveLength(1);
    return { h, child };
  });
  return { root, dir, binding, input, state, ...produced };
}

describe("source-bound input interpretation without invented owner testimony", () => {
  it("binds actual missing-answer children to one saved Source episode across restart", async () => {
    const fixture = await sourceQuestionFixture();
    const { root, h, child, dir, binding, input } = fixture;
    expect(parseOperatorQuestions([root, child], [h])).toEqual([root, child]);
    let state = fixture.state;
    try {
      const episode = operatorQuestionEpisode({ read: () => state.operator_questions![0]!, save: async (next, expected) => {
        expect(state.operator_questions![0]!.digest).toBe(expected);
        const updated = buildBoundaryAuthoringResumeState({ ...input, previous: state,
          operatorQuestions: [next, state.operator_questions![1]!] });
        await writeBoundaryAuthoringResumeState(dir, updated, { expectedRevisionDigest: state.revision_digest }); state = updated;
      } });
      await episode.admitIteration(); await episode.reserveToolBatch(4); await episode.reserveToolBatch(3);
      expect(await episode.reserveCorrection()).toBe(true);
      const reopened = await readBoundaryAuthoringResumeState(dir, binding);
      expect(reopened.status).toBe("ready");
      if (reopened.status !== "ready") throw new Error("Owned episode is not saved");
      state = reopened.value;
      expect(state.operator_questions![1]).toEqual(child);
      await expect(episode.reserveToolBatch(2)).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
      expect(await episode.reserveCorrection()).toBe(false);
      await episode.reserveToolBatch(1);
      const erased = buildBoundaryAuthoringResumeState({ ...input, previous: state, operatorQuestions: [root, child] });
      await expect(writeBoundaryAuthoringResumeState(dir, erased, { expectedRevisionDigest: state.revision_digest })).rejects.toThrow();
      for (const changed of [{ budget_owner_id: child.id }, { budget_owner_id: randomUUID() },
        { budget: { iterations_used: 0, tool_calls_used: 0, correction_used: false } },
        { target: { ...child.target, outcomes: ["work.other"] } }, { context_digest: canonicalJsonDigest("stale") }])
        expect(() => parseOperatorQuestions([state.operator_questions![0]!, seal({ ...child, ...changed } as OperatorQuestion)], [h])).toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("refuses a first missing-answer child without genuine completed-question provenance", async () => {
    const f = await sourceQuestionFixture();
    try {
      const { completion: _, ...bare } = f.h;
      expect(() => parseOperatorQuestions([f.root, f.child], [bare])).toThrow("AUTHORING_QUESTION_INVALID");
      expect(parseOperatorQuestions([f.root], [])).toEqual([f.root]);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("refuses changed presentation, missing presentation, skipped revisions and material in a Source child", async () => {
    const f = await sourceQuestionFixture();
    try {
      const { presentation: _, ...unpresented } = f.child;
      for (const changed of [seal(unpresented as OperatorQuestion), seal({ ...f.child, revision: 3 }),
        seal({ ...f.child, presentation: { ...f.child.presentation!, text: "A different question." } }),
        seal({ ...f.child, material: ["Invented requirement."] })])
        expect(() => parseOperatorQuestions([f.root, changed], [f.h])).toThrow("AUTHORING_QUESTION_INVALID");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("refuses replacement over an unanswered nonblank child and over an accepted decision", async () => {
    const f = await sourceQuestionFixture();
    try {
      const prior = leaveOperatorQuestionPending(captureOperatorAnswer(f.child, "one through 64"), "unknown");
      const h = createOwnerHandoff({ consumer: "input_policy", question: f.h.question,
        scope_digest: f.root.scope_digest, context_digest: f.root.context_digest });
      const next = seal({ ...f.child, id: randomUUID(), handoff_id: h.id, revision: 3 });
      expect(() => parseOperatorQuestions([f.root, prior, next], [f.h, h])).toThrow("AUTHORING_QUESTION_INVALID");
      const accepted = confirmOperatorAnswer(proposeOperatorAnswer(reopenOperatorQuestion(prior), mapping(prior, { kind: "input_bounds", requirements: [] })));
      const answered = answerOwnerHandoff(f.h, prior.raw_answer!.text, f.h.context_digest);
      expect(() => parseOperatorQuestions([f.root, accepted, next], [answered, h])).toThrow("AUTHORING_QUESTION_INVALID");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("accepts exact saved Source evidence, with no raw answer or owner handoff", () => {
    const q = sourceRecord();
    const source = (q as unknown as { source_binding: unknown }).source_binding;
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
      source_reference: canonicalJsonDigest(source), disposition: "proposed", value: { kind: "input_bounds", requirements: [{
        outcomes: q.target.outcomes, input: "note", start: 1, end: 3, min_length: 0, max_length: 64 }] } });
    expect(proposed.raw_answer).toBeUndefined();
    expect(proposed.confirmation).toBeUndefined();
    const confirmed = confirmOperatorAnswer(proposed);
    expect(parseOperatorQuestions([confirmed], [])).toEqual([confirmed]);
    expect(confirmed.raw_answer).toBeUndefined();
  });
  it("refuses foreign Source, stale revision, mixed raw evidence and out-of-Source ranges", () => {
    const q = sourceRecord();
    const source = (q as unknown as { source_binding: unknown }).source_binding;
    const proposal = { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(source),
      disposition: "proposed", value: { kind: "input_bounds", requirements: [{
        outcomes: q.target.outcomes, input: "note", start: 1, end: 3, min_length: 0, max_length: 64 }] } };
    for (const changed of [{ source_reference: canonicalJsonDigest("foreign Source") }, { revision: 2 },
      { answer_id: randomUUID() }, { value: { kind: "input_bounds", requirements: [{ ...proposal.value.requirements[0], end: 4 }] } }])
      expect(() => proposeOperatorAnswer(q, { ...proposal, ...changed })).toThrow("AUTHORING_QUESTION_INVALID");
    expect(() => captureOperatorAnswer(presentOperatorQuestion(q, "What does this mean?"), "invented Source answer")).toThrow();
  });
});

describe("typed operator decision staging and actual resume persistence", () => {
  it.each([101, 128])("preserves the existing Source input-name domain at %i characters", length => {
    const { q, h } = record("input_bounds");
    const raw = captureOperatorAnswer(presentOperatorQuestion(q, h.question), "Use the range stated in the current policy.");
    const value = { kind: "input_bounds", requirements: [{ outcomes: q.target.outcomes,
      input: "n".repeat(length), start: 1, end: 1, min_length: 0, max_length: 64 }] };
    expect(proposeOperatorAnswer(raw, mapping(raw, value)).proposal?.value).toEqual(value);
  });
  it.each([65, 128])("preserves the existing Source input-review scope of %i outcomes", length => {
    const { q, h } = record("input_bounds");
    const outcomes = Array.from({ length }, (_, n) => `work.hold_${n}`);
    const scoped = createOperatorQuestion({ id: q.id, revision: q.revision, handoff_id: h.id, kind: q.kind,
      scope_digest: q.scope_digest, context_digest: q.context_digest,
      target: { ...q.target, outcomes }, material: q.material, evidence: q.evidence, continuation: q.continuation });
    const raw = captureOperatorAnswer(presentOperatorQuestion(scoped, h.question), "Use the same range for these listed Actions.");
    const value = { kind: "input_bounds", requirements: [{ outcomes, input: "note", start: 1, end: 1, min_length: 0, max_length: 64 }] };
    expect(proposeOperatorAnswer(raw, mapping(raw, value)).proposal?.value).toEqual(value);
  });
  it("refuses input names and input-review scopes beyond the existing domain", () => {
    const { q, h } = record("input_bounds");
    const raw = captureOperatorAnswer(presentOperatorQuestion(q, h.question), "Use the stated range.");
    expect(() => proposeOperatorAnswer(raw, mapping(raw, { kind: "input_bounds", requirements: [{
      outcomes: q.target.outcomes, input: "n".repeat(129), start: 1, end: 1, min_length: 0, max_length: 64 }] }))).toThrow();
    expect(() => createOperatorQuestion({ id: q.id, revision: q.revision, handoff_id: h.id, kind: q.kind,
      scope_digest: q.scope_digest, context_digest: q.context_digest,
      target: { ...q.target, outcomes: Array.from({ length: 129 }, (_, n) => `work.hold_${n}`) },
      material: q.material, evidence: q.evidence, continuation: q.continuation })).toThrow();
  });
  it("retains an unresolved earlier response when the same saved handoff receives a new confirmed answer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-answer-history-"));
    const { q, h } = record();
    const unknown = leaveOperatorQuestionPending(captureOperatorAnswer(presentOperatorQuestion(q, h.question), "I do not know."), "unknown");
    const next = createOperatorQuestion({ id: randomUUID(), revision: 2, handoff_id: h.id, kind: q.kind,
      scope_digest: q.scope_digest, context_digest: q.context_digest, target: q.target, material: q.material,
      evidence: q.evidence, continuation: q.continuation });
    const binding = { boundary_name: "work", generation_lock_fingerprint: canonicalJsonDigest("lock"),
      schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("roles") };
    const input = { binding, stage: "read_mapping" as const, jobIntent: "Read the handling stage", provider: "openai" as const, model: "local-controlled" };
    let state = buildBoundaryAuthoringResumeState({ ...input, ownerHandoffs: [h], operatorQuestions: [unknown] });
    try {
      await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
      const pending = buildBoundaryAuthoringResumeState({ ...input, previous: state, operatorQuestions: [unknown, next] });
      await writeBoundaryAuthoringResumeState(root, pending, { expectedRevisionDigest: state.revision_digest });
      const reopened = await readBoundaryAuthoringResumeState(root, binding);
      expect(reopened).toEqual({ status: "ready", value: pending }); state = pending;
      const raw = "  11 means waiting — 22 means ready — 33 means closed. \t ";
      const captured = captureOperatorAnswer(presentOperatorQuestion(next, h.question), raw);
      const accepted = confirmOperatorAnswer(proposeOperatorAnswer(captured, mapping(captured)));
      const answered = answerOwnerHandoff(h, raw, h.context_digest);
      const saved = buildBoundaryAuthoringResumeState({ ...input, previous: state, ownerHandoffs: [answered], operatorQuestions: [unknown, accepted] });
      await writeBoundaryAuthoringResumeState(root, saved, { expectedRevisionDigest: state.revision_digest });
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: saved });
      expect(saved.operator_questions![0]).toEqual(unknown);
      expect(() => parseOperatorQuestions([unknown, seal({ ...accepted,
        raw_answer: { ...accepted.raw_answer!, id: randomUUID() } })], [answered])).toThrow();
      // A standalone parser has no previous target to compare. The actual
      // resume CAS must protect the accepted target against a resealed edit.
      const retargeted = buildBoundaryAuthoringResumeState({ ...input, previous: saved,
        operatorQuestions: [unknown, seal({ ...accepted, target: { ...accepted.target, field: "other" } })] });
      await expect(writeBoundaryAuthoringResumeState(root, retargeted, { expectedRevisionDigest: saved.revision_digest })).rejects.toThrow("AUTHORING_QUESTION_INVALID");
      expect(() => parseOperatorQuestions([unknown, accepted], [answerOwnerHandoff(h, "another response", h.context_digest)])).toThrow();
      const erased = buildBoundaryAuthoringResumeState({ ...input, previous: saved, operatorQuestions: [accepted] });
      await expect(writeBoundaryAuthoringResumeState(root, erased, { expectedRevisionDigest: saved.revision_digest })).rejects.toThrow("AUTHORING_QUESTION_INVALID");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rejects wrong kind/continuation, field, question revision and raw-answer reference", () => {
    const { q, h } = record(); const raw = captureOperatorAnswer(presentOperatorQuestion(q, h.question), "  11 means waiting. 😀  ");
    expect(raw.raw_answer!.text).toBe("  11 means waiting. 😀  ");
    for (const changed of [{ ...q, continuation: "version_mapping" }, { ...q, target: { phase: q.target.phase, outcomes: q.target.outcomes } }])
      expect(() => parseOperatorQuestion(seal(changed as OperatorQuestion))).toThrow("AUTHORING_QUESTION_INVALID");
    for (const change of [{ question_id: randomUUID() }, { revision: 2 }, { answer_id: randomUUID() },
      { value: { kind: "attributed_meaning", quote: "invented model quote" } }, { value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }])
      expect(() => proposeOperatorAnswer(raw, { ...mapping(raw), ...change })).toThrow("AUTHORING_QUESTION_INVALID");
    expect(() => parseOperatorQuestions([raw], [{ ...h, context_digest: canonicalJsonDigest("different") }])).toThrow();
  });
  it("keeps blank and cancelled answers distinct; a model proposal grants no decision", () => {
    const { q, h } = record("writer_maintenance");
    const shown = presentOperatorQuestion(q, h.question), blank = captureOperatorAnswer(shown, "  ");
    expect(blank.raw_answer!.text).toBe("  ");
    expect(() => proposeOperatorAnswer(blank, mapping(blank, { kind: "writer_maintenance", maintenance: "all_writers_increment" }))).toThrow();
    const vague = captureOperatorAnswer(shown, "I do not know whether every writer does that.");
    const proposed = proposeOperatorAnswer(vague, mapping(vague, { kind: "writer_maintenance", maintenance: "all_writers_increment" }));
    expect(proposed.confirmation).toBeUndefined();
    expect(operatorQuestionReadback(proposed).join("\n")).toContain("new, unverified operator assertion");
    expect(() => confirmOperatorAnswer(leaveOperatorQuestionPending(proposed, "unknown"))).toThrow();
    const cancelled = leaveOperatorQuestionPending(shown, "cancelled"); expect(cancelled.raw_answer).toBeUndefined();
    expect(() => captureOperatorAnswer(shown, "x".repeat(4001))).toThrow();
  });
  it("reads back exact bounds and rejects changed units or unauthorized Action scope", () => {
    const { q, h } = record("input_bounds");
    const raw = captureOperatorAnswer(presentOperatorQuestion(q, h.question), "A note of zero to sixty-four units; keep spaces.");
    const value = { kind: "input_bounds", requirements: [{ outcomes: ["work.hold"], input: "note", start: 1, end: 3, min_length: 0, max_length: 64 }] };
    const proposed = proposeOperatorAnswer(raw, mapping(raw, value));
    const shown = operatorQuestionReadback(proposed).join("\n");
    expect(shown).toContain("0 to 64 UTF-16 units"); expect(shown).toContain("Empty text is allowed");
    expect(shown).toContain("Null is not a string"); expect(shown).toContain("nothing is trimmed");
    expect(shown).toContain("If this input is supplied as a string");
    expect(shown).toContain("does not change whether the input is required, whether null is allowed, or its allowed enum values");
    for (const requirements of [[{ ...value.requirements[0], outcomes: ["work.other"] }], [{ ...value.requirements[0], unit: "visible_characters" }],
      [{ ...value.requirements[0], min_length: 65 }]]) expect(() => proposeOperatorAnswer(raw, mapping(raw, { ...value, requirements }))).toThrow();
  });
  it("persists counters across real restart and refuses competing saves, erased history and reset budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-operator-question-"));
    const { q, h } = record("input_bounds", true);
    const binding = { boundary_name: "work", generation_lock_fingerprint: canonicalJsonDigest("lock"),
      schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("roles") };
    const input = { binding, stage: "authority_review" as const, jobIntent: "Review note bounds", provider: "openai" as const, model: "local-controlled" };
    let state: BoundaryAuthoringResumeState = buildBoundaryAuthoringResumeState({ ...input, ownerHandoffs: [h], operatorQuestions: [q] });
    try {
      await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
      const save = async (next: OperatorQuestion, expected: string) => {
        expect(state.operator_questions![0]!.digest).toBe(expected);
        const updated = buildBoundaryAuthoringResumeState({ ...input, previous: state, operatorQuestions: [next] });
        await writeBoundaryAuthoringResumeState(root, updated, { expectedRevisionDigest: state.revision_digest }); state = updated;
      };
      const episode = operatorQuestionEpisode({ read: () => state.operator_questions![0]!, save });
      await episode.admitIteration(); await episode.reserveToolBatch(4); await episode.reserveToolBatch(3);
      expect(await episode.reserveCorrection()).toBe(true); const stale = state;
      const reopened = await readBoundaryAuthoringResumeState(root, binding); expect(reopened.status).toBe("ready");
      if (reopened.status !== "ready") throw new Error("Owned saved fixture unavailable"); state = reopened.value;
      const resumed = operatorQuestionEpisode({ read: () => state.operator_questions![0]!, save });
      await expect(resumed.reserveToolBatch(2)).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
      expect(await resumed.reserveCorrection()).toBe(false); await resumed.reserveToolBatch(1);
      await expect(writeBoundaryAuthoringResumeState(root, stale, { expectedRevisionDigest: stale.revision_digest })).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
      for (const questions of [[], [q]]) {
        const erased = buildBoundaryAuthoringResumeState({ ...input, previous: state, operatorQuestions: questions });
        await expect(writeBoundaryAuthoringResumeState(root, erased, { expectedRevisionDigest: state.revision_digest })).rejects.toThrow("AUTHORING_QUESTION_INVALID");
      }
      expect((await readBoundaryAuthoringResumeState(root, binding))).toEqual({ status: "ready", value: state });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains exact proposed history and refuses modification of an adopted answer", async () => {
    const { q, h } = record(); const raw = captureOperatorAnswer(presentOperatorQuestion(q, h.question), "  11 means waiting.  ");
    const pending = proposeOperatorAnswer(raw, { question_id: raw.id, revision: 1, answer_id: raw.raw_answer!.id, disposition: "pending" });
    const proposed = proposeOperatorAnswer(pending, mapping(raw));
    expect(proposed.proposal_history).toEqual([pending.proposal]);
    const accepted = confirmOperatorAnswer(proposed);
    expect(parseOperatorQuestions([accepted], [answerOwnerHandoff(h, raw.raw_answer!.text, h.context_digest)])[0]!.raw_answer!.text).toBe(raw.raw_answer!.text);
    expect(() => proposeOperatorAnswer(accepted, mapping(raw))).toThrow();
    expect(() => parseOperatorQuestions([accepted], [answerOwnerHandoff(h, "different answer", h.context_digest)])).toThrow();
  });
});
