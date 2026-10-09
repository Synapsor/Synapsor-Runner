import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { captureOperatorAnswer, createOperatorQuestion, presentOperatorQuestion, retainOperatorQuestionWording,
  assertOperatorQuestionsAdvance, parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { makeSourceInputReview } from "./authoring-input-policy.js";
import { configureAuthoringGenerationRecovery, validateAuthoringTransportState, withAuthoringGenerationRecovery,
  type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { runOperatorQuestionModel } from "./authoring-operator-question-model.js";

const tool = "runner__propose_operator_decision";
function record(kind: OperatorQuestion["kind"] = "attributed_meaning", raw?: string): OperatorQuestion {
  let q = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: randomUUID(), kind,
    scope_digest: canonicalJsonDigest("current job"), context_digest: canonicalJsonDigest("current context"),
    target: { phase: "test", resource: "work.parcels", field: kind === "writer_maintenance" ? "version" : "status", outcomes: ["work.hold"] },
    material: ["Only this task; no data access or execution is granted."], evidence: [],
    continuation: kind === "attributed_meaning" ? "read_mapping" : kind === "input_bounds" ? "input_policy_review" : "version_mapping" });
  if (raw !== undefined) q = captureOperatorAnswer(presentOperatorQuestion(q, "What does this mean for this job?"), raw);
  return q;
}
const policyText = "Each parcel needs a note.\nUse a note from 1 through 64 characters.\nThis applies to every listed Action.";
function sourceRecord(outcomes = ["work.hold"], text = policyText): OperatorQuestion {
  const snapshot = policyTextSnapshot(Buffer.from(text), "sealed rules");
  const source_binding = { source_session: randomUUID(), source_digest: snapshot.digest as `sha256:${string}`,
    store_digest: canonicalJsonDigest("source store"), lines: snapshot.lines, agenda_digest: canonicalJsonDigest({}) };
  source_binding.agenda_digest = canonicalJsonDigest({ source_session: source_binding.source_session,
    source_digest: source_binding.source_digest, store_digest: source_binding.store_digest, outcomes });
  return createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", source_binding,
    scope_digest: canonicalJsonDigest("job"), context_digest: canonicalJsonDigest("current"),
    target: { phase: "input policy", outcomes }, material: ["Review the complete current policy; no authority."], evidence: [], continuation: "input_policy_review" });
}
function mapping(q: OperatorQuestion, value: unknown = { kind: q.kind }) {
  return { question_id: q.id, revision: q.revision, ...(q.source_binding
    ? { source_reference: canonicalJsonDigest(q.source_binding) } : { answer_id: q.raw_answer!.id }), status: "proposal", disposition: "proposed", value };
}
function information(q: OperatorQuestion) {
  return { question_id: q.id, revision: q.revision, ...(q.source_binding ? { source_reference: canonicalJsonDigest(q.source_binding),
      source_passages: [{ start: 1, end: 2, identifiers: ["note"] }] } : {}),
    status: "needs_information", question: "How short or long may the parcel note be?" };
}
function validateSourceProposal(root: OperatorQuestion) {
  const source = policyTextSnapshot(Buffer.from(policyText), "sealed rules");
  const session = { ...newPolicySourceSession(), id: root.source_binding!.source_session };
  return (proposed: OperatorQuestion): void => {
    const value = proposed.proposal?.value;
    if (value?.kind !== "input_bounds") throw new Error("Wrong input interpretation.");
    // Pure existing domain validation only. The discarded unverified record is
    // neither persisted nor an adoption of this unconfirmed model proposal.
    makeSourceInputReview({ source, session, store: root.source_binding!.store_digest,
      outcomes: root.target.outcomes, requirements: value.requirements, actor: "local_installation_operator" });
  };
}
function response(args: unknown, provider: "openai" | "anthropic" = "openai", count = 1) {
  return { status: 200, body: provider === "openai"
    ? { status: "completed", output: Array.from({ length: count }, (_, n) => ({ type: "function_call", call_id: `controlled-${n}`, name: tool, arguments: JSON.stringify(args) })) }
    : { content: Array.from({ length: count }, (_, n) => ({ type: "tool_use", id: `controlled-${n}`, name: tool, input: args })), stop_reason: "tool_use" } };
}
function budget(initialIterations = 0, initialTools = 0) {
  let iterations = initialIterations, tools = initialTools, correction = false;
  return { admitIteration: vi.fn(async () => { if (iterations === 6) throw new AskError("ASK_TOOL_BUDGET_EXCEEDED", "Saved iteration ceiling.", 422); iterations++; }),
    reserveToolBatch: vi.fn(async (n: number) => { if (tools + n > 8) throw new AskError("ASK_TOOL_BUDGET_EXCEEDED", "Saved tool ceiling.", 422); tools += n; }),
    reserveCorrection: vi.fn(async () => { if (correction) return false; correction = true; return true; }),
    counts: () => ({ iterations, tools, correction }) };
}
function fixture(q: OperatorQuestion, replies: unknown[], options: { provider?: "openai" | "anthropic"; episode?: ReturnType<typeof budget> } = {}) {
  const provider = options.provider ?? "openai", episode = options.episode ?? budget();
  let index = 0;
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => response(replies[Math.min(index++, replies.length - 1)], provider));
  const input = { question: q, stage: (q.source_binding ? "source-review" : q.raw_answer ? "answer-map" : "present") as "source-review" | "answer-map" | "present",
    session: { provider, model: "controlled-model", apiKey: "inert-controlled-credential", dependencies: { requestJson } },
    episodeBudget: episode, reserveCorrection: episode.reserveCorrection, authorityGuard: (expected: `sha256:${string}`) => expected,
    ...(q.source_binding ? { policyText } : {}), env: {}, egressAcknowledged: true };
  return { input, requestJson, episode };
}

describe("shared operator-question model adapter; controlled real decoders only", () => {
  it.each(["openai", "anthropic"] as const)("presents one plain business question without adoption (%s)", async provider => {
    const q = record(), f = fixture(q, [information(q)], { provider });
    const result = await runOperatorQuestionModel(f.input);
    expect(result).toMatchObject({ state: "question", question: "How short or long may the parcel note be?", correction_used: false });
    expect(result.completion).toBeUndefined(); expect(q.presentation).toBeUndefined();
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.episode.counts()).toEqual({ iterations: 1, tools: 1, correction: false });
  });
  it("maps exact raw words only by the current answer identity; excludes conversation/private context", async () => {
    const q = record("attributed_meaning", "  waiting — 😀 e\u0301\t "), f = fixture(q, [mapping(q)]), before = structuredClone(q);
    const result = await runOperatorQuestionModel({ ...f.input, session: { ...f.input.session, conversation: { turns: [{ question: "PRIVATE-HISTORY-SENTINEL", answer: "SECRET" }] } as never } });
    expect(result).toMatchObject({ state: "proposed", proposal: { answer_id: q.raw_answer!.id, value: { kind: "attributed_meaning" } } });
    expect(q).toEqual(before); expect(q.confirmation).toBeUndefined();
    const body = JSON.stringify(f.requestJson.mock.calls[0]![0].body);
    expect(body).toContain("waiting — 😀"); expect(body).not.toContain("PRIVATE-HISTORY-SENTINEL");
    expect(body).toContain("runner__propose_operator_decision"); expect(body).toContain("5000");
  });
  it("keeps a genuine unknown answer pending without a value or domain-validation hook", async () => {
    const q = record("writer_maintenance", "I don't know"), args = { ...mapping(q), disposition: "pending", value: undefined };
    const f = fixture(q, [args]), validateProposal = vi.fn();
    const result = await runOperatorQuestionModel({ ...f.input, validateProposal });
    expect(result).toMatchObject({ state: "pending", proposal: { disposition: "pending" } });
    if (result.state !== "question") expect(result.proposal.value).toBeUndefined();
    expect(validateProposal).not.toHaveBeenCalled(); expect(q.confirmation).toBeUndefined();
  });
  it("maps writer testimony without adopting or saving it", async () => {
    const q = record("writer_maintenance", "All applications maintain this counter.");
    const f = fixture(q, [mapping(q, { kind: "writer_maintenance", maintenance: "all_writers_increment" })]);
    expect(await runOperatorQuestionModel(f.input)).toMatchObject({ state: "proposed" });
    expect(q.proposal).toBeUndefined();
  });
  it("sends the exact complete source and permits the existing128-name/outcome domain", async () => {
    const outcomes = Array.from({ length: 128 }, (_, n) => `work.a${n}`), q = sourceRecord(outcomes);
    const value = { kind: "input_bounds", requirements: [{ outcomes, input: "n".repeat(128), start: 1, end: 3, min_length: 1, max_length: 64 }] };
    const f = fixture(q, [mapping(q, value)]), validateProposal = vi.fn(validateSourceProposal(q));
    expect(await runOperatorQuestionModel({ ...f.input, validateProposal })).toMatchObject({ state: "proposed", proposal: { source_reference: canonicalJsonDigest(q.source_binding), value } });
    expect(validateProposal).toHaveBeenCalledOnce(); expect(validateProposal.mock.calls[0]![0].confirmation).toBeUndefined();
    const promptStrings: string[] = [];
    const visit = (value: unknown): void => { if (typeof value === "string") promptStrings.push(value);
      else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") Object.values(value).forEach(visit); };
    visit(f.requestJson.mock.calls[0]![0].body);
    expect(promptStrings.some(value => value.includes(`Complete saved Source text (no truncation): ${JSON.stringify(policyText)}`))).toBe(true);
    expect(q.raw_answer).toBeUndefined(); expect(q.handoff_id).toBeUndefined();
  });
  it.each(["invalid name", "reserved name", "zero maximum", "duplicate requirement"])("real Source domain validator refuses and corrects before any preview: %s", async fault => {
    const q = sourceRecord(), requirement = { outcomes: q.target.outcomes, input: "note", start: 1, end: 3, min_length: 1, max_length: 64 };
    const valid = { kind: "input_bounds", requirements: [requirement] };
    const invalid = { ...valid, requirements: fault === "duplicate requirement" ? [requirement, requirement]
      : [{ ...requirement, ...(fault === "invalid name" ? { input: "bad name" } : fault === "reserved name" ? { input: "constructor" } : { min_length: 0, max_length: 0 }) }] };
    const f = fixture(q, [mapping(q, invalid), mapping(q, valid)]), before = structuredClone(q);
    const validateProposal = vi.fn(validateSourceProposal(q));
    expect(await runOperatorQuestionModel({ ...f.input, validateProposal })).toMatchObject({ state: "proposed", correction_used: true, proposal: { value: valid } });
    expect(validateProposal).toHaveBeenCalledTimes(2); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(f.episode.counts()).toEqual({ iterations: 2, tools: 2, correction: true });
    expect(q).toEqual(before); expect(q.confirmation).toBeUndefined();
  });
  it("persistent real-domain invalidity stops after one correction without an inspection fence or adoption", async () => {
    const q = sourceRecord(), value = { kind: "input_bounds", requirements: [{ outcomes: q.target.outcomes, input: "prototype", start: 1, end: 3, min_length: 1, max_length: 64 }] };
    const f = fixture(q, [mapping(q, value)]);
    await expect(runOperatorQuestionModel({ ...f.input, validateProposal: validateSourceProposal(q) })).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.episode.reserveCorrection).toHaveBeenCalledOnce();
    expect(q.proposal).toBeUndefined(); expect(q.confirmation).toBeUndefined();
  });
  it("asks a missing business question from Source without fabricating raw testimony", async () => {
    const q = sourceRecord(), f = fixture(q, [information(q)]);
    expect(await runOperatorQuestionModel(f.input)).toMatchObject({ state: "question" }); expect(q.raw_answer).toBeUndefined();
  });
  it.each(["missing", "wrong digest", "wrong lines", "oversized", "too many lines"])("refuses unusable Source before egress: %s", async fault => {
    const q = sourceRecord(), f = fixture(q, [information(q)]);
    const changed = fault === "missing" ? undefined : fault === "wrong digest" ? policyText + " changed"
      : fault === "oversized" ? "x".repeat(32_769) : fault === "too many lines" ? Array(601).fill("rule").join("\n") : policyText.replace(/\n/g, " ");
    await expect(runOperatorQuestionModel({ ...f.input, policyText: changed })).rejects.toMatchObject({ code: "OPERATOR_QUESTION_SOURCE_INVALID" });
    expect(f.requestJson).not.toHaveBeenCalled(); expect(f.episode.counts().iterations).toBe(0);
  });
  it.each(["question", "revision", "answer", "quote", "kind", "extra"])("known argument refusal stays outside the uncertain callback fence: %s", async fault => {
    const q = record("attributed_meaning", "Waiting means ready for review."), args = mapping(q);
    const bad = fault === "question" ? { ...args, question_id: randomUUID() } : fault === "revision" ? { ...args, revision: 2 }
      : fault === "answer" ? { ...args, answer_id: randomUUID() } : fault === "quote" ? { ...args, value: { kind: q.kind, quote: "model rewritten words" } }
      : fault === "kind" ? { ...args, value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } } : { ...args, extra: "PRIVATE-SENTINEL" };
    const f = fixture(q, [bad]);
    await expect(runOperatorQuestionModel({ ...f.input, reserveCorrection: async () => false })).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(q.proposal).toBeUndefined();
  });
  it.each(["source", "range", "outcome", "input"])("refuses source-reference/range/domain violations: %s", async fault => {
    const q = sourceRecord(), value = { kind: "input_bounds", requirements: [{ outcomes: q.target.outcomes, input: "note", start: 1, end: 3, min_length: 1, max_length: 64 }] };
    const args = mapping(q, value), bad = fault === "source" ? { ...args, source_reference: canonicalJsonDigest("wrong") }
      : { ...args, value: { ...value, requirements: [{ ...value.requirements[0], ...(fault === "range" ? { end: 4 } : fault === "outcome" ? { outcomes: ["work.other"] } : { input: "x".repeat(129) }) }] } };
    const f = fixture(q, [bad]);
    await expect(runOperatorQuestionModel({ ...f.input, reserveCorrection: async () => false })).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("uses one caller-owned correction after a fully consumed invalid response", async () => {
    const q = record("attributed_meaning", "Waiting means ready for review."), f = fixture(q, [{ ...mapping(q), revision: 2 }, mapping(q)]);
    expect(await runOperatorQuestionModel(f.input)).toMatchObject({ state: "proposed", correction_used: true });
    expect(f.episode.reserveCorrection).toHaveBeenCalledOnce(); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(f.episode.counts()).toEqual({ iterations: 2, tools: 2, correction: true });
  });
  it("stops persistent invalid content after the same one durable correction", async () => {
    const q = record("attributed_meaning", "Waiting means ready for review."), f = fixture(q, [{ ...mapping(q), revision: 2 }]);
    await expect(runOperatorQuestionModel(f.input)).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.episode.reserveCorrection).toHaveBeenCalledOnce();
    expect(q.proposal).toBeUndefined();
  });
  it("does not reset the shared correction at the next stage", async () => {
    const q = record(), shared = budget(), f = fixture(q, [{ ...information(q), revision: 2 }, information(q)], { episode: shared });
    await runOperatorQuestionModel(f.input);
    const child = record("attributed_meaning", "Waiting means queued."), g = fixture(child, [{ ...mapping(child), answer_id: randomUUID() }], { episode: shared });
    await expect(runOperatorQuestionModel(g.input)).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(g.requestJson).toHaveBeenCalledOnce(); expect(shared.counts()).toEqual({ iterations: 3, tools: 3, correction: true });
  });
  it("reserves the required callback batch before domain validation", async () => {
    const q = record("writer_maintenance", "Every writer increments it."), f = fixture(q, [mapping(q, { kind: q.kind, maintenance: "all_writers_increment" })], { episode: budget(0, 8) });
    const validateProposal = vi.fn();
    await expect(runOperatorQuestionModel({ ...f.input, validateProposal })).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
    expect(validateProposal).not.toHaveBeenCalled(); expect(f.episode.reserveToolBatch).toHaveBeenCalledWith(1); expect(f.episode.counts().tools).toBe(8);
  });
  it("rejects a multi-call batch before any callback instead of opening a larger pool", async () => {
    const q = record("attributed_meaning", "Waiting means queued."), f = fixture(q, [mapping(q)]), validateProposal = vi.fn();
    f.requestJson.mockImplementation(async () => response(mapping(q), "openai", 2));
    await expect(runOperatorQuestionModel({ ...f.input, validateProposal, reserveCorrection: async () => false })).rejects.toMatchObject({ code: "ASK_REQUIRED_TOOL_NOT_CALLED" });
    expect(validateProposal).not.toHaveBeenCalled(); expect(f.episode.reserveToolBatch).not.toHaveBeenCalled();
  });
  it("refuses an exhausted inherited iteration without a request or correction", async () => {
    const q = record(), f = fixture(q, [information(q)], { episode: budget(6) });
    await expect(runOperatorQuestionModel(f.input)).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
    expect(f.requestJson).not.toHaveBeenCalled(); expect(f.episode.reserveCorrection).not.toHaveBeenCalled();
  });
  it("accepts only current authority and refuses drift before callback", async () => {
    const q = record(), f = fixture(q, [information(q)]), guard = vi.fn().mockImplementationOnce((expected: `sha256:${string}`) => expected).mockReturnValue(canonicalJsonDigest("changed"));
    await expect(runOperatorQuestionModel({ ...f.input, authorityGuard: guard })).rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.episode.reserveCorrection).not.toHaveBeenCalled();
  });
  it("does not consume a late controlled response or invoke a validator after cancellation", async () => {
    const q = record("writer_maintenance", "Every writer increments it."), f = fixture(q, [mapping(q, { kind: q.kind, maintenance: "all_writers_increment" })]);
    const controller = new AbortController(), validateProposal = vi.fn();
    f.requestJson.mockImplementation(async () => { controller.abort(); return response(mapping(q, { kind: q.kind, maintenance: "all_writers_increment" })); });
    await expect(runOperatorQuestionModel({ ...f.input, signal: controller.signal, validateProposal })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(validateProposal).not.toHaveBeenCalled(); expect(f.episode.reserveCorrection).not.toHaveBeenCalled();
  });
  it("returns actual completed sequence provenance and preserves known-invalid handling", async () => {
    const q = record("attributed_meaning", "Waiting means queued."), f = fixture(q, [{ ...mapping(q), revision: 2 }, mapping(q)]);
    let saved: AuthoringTransportState = { version: 1, operations: [] };
    const result = await withAuthoringGenerationRecovery(async () => {
      configureAuthoringGenerationRecovery({ available: () => true, read: () => saved, current: async () => q.context_digest,
        write: async next => { validateAuthoringTransportState(next); saved = structuredClone(next); }, progress: () => {} });
      return runOperatorQuestionModel(f.input);
    });
    expect(result.completion).toBeDefined(); expect(saved.operations).toHaveLength(2);
    expect(saved.operations.every(op => op.state === "handled")).toBe(true); expect(result.correction_used).toBe(true);
  });
  it("does not convert an existing transport stop into another structured-content correction", async () => {
    const q = record(), f = fixture(q, [information(q)]);
    f.requestJson.mockRejectedValue(new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "Controlled partial outcome.", 409));
    await expect(runOperatorQuestionModel(f.input)).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.episode.reserveCorrection).not.toHaveBeenCalled();
  });
});


describe("B50 real Terra technical questions", () => {
  it("raw-saves original wording before correction and restores it on the same typed question", async () => {
    let q = record("input_bounds");
    const original = "Should work.parcels.status be optional and never exceed 64 characters?";
    const changed = "Should work.parcels.status be required and exceed 128 characters?";
    const businessContext = { references: [{ resource: "work.parcels", field: "status", label: "parcel note", origin: "policy_term" as const }] };
    const first = fixture(q, [{ ...information(q), question: original }]);
    const before = structuredClone(q);
    await expect(runOperatorQuestionModel({ ...first.input, businessContext, onWordingState: async state => {
      q = retainOperatorQuestionWording(q, state); throw new Error("OWNED_WORDING_RAW_ACK_LOST");
    } })).rejects.toThrow("OWNED_WORDING_RAW_ACK_LOST");
    expect(first.requestJson).toHaveBeenCalledOnce(); expect(first.episode.counts()).toEqual({ iterations: 1, tools: 1, correction: false });
    expect(q.wording_state?.gate.original_question).toBe(original); expect(q.presentation).toBeUndefined();
    expect(q.raw_answer).toBeUndefined(); expect(q.proposal).toBeUndefined(); expect(q.confirmation).toBeUndefined();
    expect(() => assertOperatorQuestionsAdvance([before], [q])).not.toThrow();
    const resumed = fixture(q, [{ ...information(q), question: changed }], { episode: first.episode });
    const result = await runOperatorQuestionModel({ ...resumed.input, businessContext });
    expect(result).toMatchObject({ state: "question", question: "Should parcel note be optional and never exceed 64 characters?" });
    expect(resumed.requestJson).toHaveBeenCalledOnce(); expect(first.episode.counts()).toEqual({ iterations: 2, tools: 2, correction: false });
    const { digest: _digest, ...body } = q;
    const removedBody = { ...body }; delete removedBody.wording_state;
    const removed = parseOperatorQuestion({ ...removedBody, digest: canonicalJsonDigest(removedBody) });
    expect(() => assertOperatorQuestionsAdvance([q], [removed])).toThrow("evidence changed");
    expect(() => retainOperatorQuestionWording(q, { ...q.wording_state!, stage: "source-review" })).toThrow("cannot be replaced");
    const noSend = fixture(q, [{ ...information(q), question: changed }]);
    await expect(runOperatorQuestionModel({ ...noSend.input, businessContext: { references: [] } })).rejects.toThrow("STATE_STALE");
    expect(noSend.requestJson).not.toHaveBeenCalled();
  });
  it.each([
    { field: "section_id", label: "course section", question: "Does registrations.section_id represent the student-facing course section that may be shown with each registration, or should the registration display instead use fields reached through the listed course-section relationship?" },
    { field: "status_reason", label: "optional acceptance note", question: "Should the optional acceptance note be stored in registrations.status_reason, or is there another authoritative field/source for it?" },
  ])("rephrases once then uses Runner's business label for $field", async ({ field, label, question }) => {
    const original = record(), { digest: _, ...body } = original;
    const changed = { ...body, target: { ...body.target, resource: "university.registrations", field } };
    const q = { ...changed, digest: canonicalJsonDigest(changed) };
    const f = fixture(q, [{ ...information(q), question }]);
    const result = await runOperatorQuestionModel({ ...f.input, businessContext: {
      references: [{ resource: "university.registrations", field, label, origin: "policy_term" }],
    } });
    expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ state: "question", correction_used: true });
    if (result.state === "question") {
      expect(result.question).not.toMatch(/\b[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/u);
      expect(result.question).toContain(label);
    }
    expect(q).toEqual({ ...changed, digest: canonicalJsonDigest(changed) });
    expect(q.raw_answer).toBeUndefined(); expect(q.confirmation).toBeUndefined();
    expect(f.episode.counts()).toEqual({ iterations: 2, tools: 2, correction: true });
  });
});
