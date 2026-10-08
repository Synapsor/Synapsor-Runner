import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  assertBoundaryAuthoringResumeState, buildBoundaryAuthoringResumeState, clearBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeState, revalidateBoundaryAuthoringResume, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding, type BoundaryAuthoringResumeState,
} from "./boundary-authoring-resume.js";
import {
  readWorkloadAssistanceCheckpoint, readWorkloadAssistanceDecisionAnswer,
  type ReadWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceQuestion,
} from "./read-workload-assistance-checkpoint.js";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import {
  authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint, configureAuthoringGenerationRecovery,
  withAuthoringGenerationRecovery,
} from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn } from "./model-ask.js";

const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "owned_read", generation_lock_fingerprint: canonicalJsonDigest("owned generation"),
  schema_fingerprint: canonicalJsonDigest("owned schema"), role_posture_fingerprint: canonicalJsonDigest("owned role"),
};
const questionText = "Which fulfillment stages belong to this Read view?";
const request = { resource: "public.orders", field: "status", reason: "Explain the exact business view", question: questionText };
const roots: string[] = [];
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-assistance-resume-")); roots.push(root); return root; }
const resumeFile = (root: string) => path.join(root, ".synapsor/boundary-authoring/resume.json");
function checkpoint(question: ReadWorkloadAssistanceQuestion = { kind: "clarification", request, question: questionText }): ReadWorkloadAssistanceCheckpoint {
  return readWorkloadAssistanceCheckpoint({ input_digest: canonicalJsonDigest("owned input"), boundary_digest: canonicalJsonDigest(binding),
    catalog_digest: canonicalJsonDigest("owned catalog"), tool_digest: canonicalJsonDigest("owned tools"),
    stage: question.decision ? "decided" : "waiting", pending_question: question,
    state: { call_count: 2, attempt: 3, phase: "follow-up", correction_used: true, relationship_reviews: 1, relationship_review_limit: 3,
      clarified_targets: [{ ...request, answer: "Earlier reviewed explanation" }], clarification_answers: ["Earlier retained answer"],
      clarification_from_invalid_naming: false, clarification_resolved: true, mechanical_clarification_resolved: false,
      value_request_resolved: false, repeated_assistance_request: false, naming_evidence_correction_used: false, diagnostics: [],
      usage: { input_tokens: 43, output_tokens: 12, total_tokens: 55 } } });
}
type BuildInput = Parameters<typeof buildBoundaryAuthoringResumeState>[0];
function build(readAssistanceCheckpoint?: ReadWorkloadAssistanceCheckpoint | null, input: Partial<BuildInput> = {}) {
  return buildBoundaryAuthoringResumeState({ binding, stage: "read_mapping", jobIntent: "Inspect the owned order view.",
    provider: "openai", model: "offline-test", readAssistanceCheckpoint, ...input });
}
function resign<T extends { digest: `sha256:${string}` }>(value: T): T {
  const { digest: _digest, ...body } = value; return { ...value, digest: canonicalJsonDigest(body) };
}
function resignResume(value: BoundaryAuthoringResumeState): BoundaryAuthoringResumeState {
  const { revision_digest: _digest, ...body } = value; return { ...value, revision_digest: canonicalJsonDigest(body) };
}
function localOwner(consumer: AuthoringOwnerHandoff["consumer"] = "read_clarification", question = questionText) {
  return createOwnerHandoff({ consumer, scope_digest: canonicalJsonDigest("owned scope"), context_digest: canonicalJsonDigest("owned context"), question });
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("canonical bounded Read assistance decision attribution", () => {
  it.each([
    [{ kind: "clarification", request, question: questionText, decision: { state: "answered", answer: "Reviewed fulfillment stages" } }, "Reviewed fulfillment stages"],
    [{ kind: "clarification", request, question: questionText, decision: { state: "declined" } }, "Declined the exact Read clarification."],
    [{ kind: "value", request, question: questionText, decision: { state: "provided", resource: request.resource, field: request.field, values: ["queued", "done"], egressAcknowledged: true } }, '["queued","done"]'],
    [{ kind: "value", request, question: questionText, decision: { state: "without_values" } }, "Declined the requested Read value context."],
    [{ kind: "relationship", request, question: questionText, decision: { state: "relationship_reviewed" } }, "Confirmed the exact generated Read relationship review."],
  ] as Array<[ReadWorkloadAssistanceQuestion, string]>)("attributes the typed decision %j", (question, answer) => {
    expect(readWorkloadAssistanceDecisionAnswer(question)).toBe(answer);
  });

  it("keeps a permitted near-4K values answer bounded even when full decision JSON exceeds 4K", () => {
    const values = Array.from({ length: 19 }, (_, i) => `${i}:` + "v".repeat(197));
    const longRequest = { ...request, resource: "r".repeat(256), field: "f".repeat(256) };
    const question: ReadWorkloadAssistanceQuestion = { kind: "value", request: longRequest, question: questionText,
      decision: { state: "provided", resource: longRequest.resource, field: longRequest.field, values, egressAcknowledged: true } };
    expect(JSON.stringify(question.decision).length).toBeGreaterThan(4000);
    expect(readWorkloadAssistanceDecisionAnswer(question)).toBe(JSON.stringify(values));
    expect(readWorkloadAssistanceDecisionAnswer(question).length).toBeLessThanOrEqual(4000);
  });

  it("refuses missing, unknown and oversize decisions without inferring a decline", () => {
    const saved = checkpoint();
    if (saved.stage === "dispatching") throw new Error("The fixture must contain a waiting question.");
    const waiting = saved.pending_question;
    expect(() => readWorkloadAssistanceDecisionAnswer(waiting)).toThrow("CHECKPOINT_INVALID");
    expect(() => readWorkloadAssistanceDecisionAnswer({ kind: "clarification", request, question: questionText,
      decision: { state: "answered", answer: "a".repeat(1001) } })).toThrow("CHECKPOINT_INVALID");
    expect(() => readWorkloadAssistanceDecisionAnswer({ ...waiting, decision: { state: "declined", authority_granted: true } } as unknown as ReadWorkloadAssistanceQuestion)).toThrow("CHECKPOINT_INVALID");
  });
});

describe("durable Read assistance resume storage", () => {
  it("serializes the complete bounded producer state and retains it across repeated Read/planning saves", async () => {
    const root = await project(), cp = checkpoint(), first = build(cp);
    await writeBoundaryAuthoringResumeState(root, first, { expectedRevisionDigest: null });
    expect(JSON.parse(await fs.readFile(resumeFile(root), "utf8")).read_assistance).toEqual(cp);
    let loaded = await readBoundaryAuthoringResumeState(root, binding);
    expect(loaded).toEqual({ status: "ready", value: first });
    for (const stage of ["read_mapping", "planning", "read_mapping"] as const) {
      if (loaded.status !== "ready") throw new Error("Expected owned saved state");
      const next = build(undefined, { previous: loaded.value, stage });
      expect(next.read_assistance).toEqual(cp);
      await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: loaded.value.revision_digest });
      loaded = await readBoundaryAuthoringResumeState(root, binding);
      expect(loaded).toEqual({ status: "ready", value: next });
    }
    expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
  });

  it("retains old input/catalog context during explicit binding revalidation for the producer to check", () => {
    const cp = checkpoint(), saved = build(cp), changed = { ...binding, schema_fingerprint: canonicalJsonDigest("rescanned schema") };
    const revalidated = revalidateBoundaryAuthoringResume(saved, changed);
    expect(revalidated.stage).toBe("planning"); expect(revalidated.binding).toEqual(changed);
    expect(revalidated.read_assistance).toEqual(cp); expect(revalidated.read).toBeUndefined();
  });

  it("only explicit null clears assistance while retaining the structured setup", async () => {
    const root = await project(), saved = build(checkpoint());
    await writeBoundaryAuthoringResumeState(root, saved);
    const cleared = build(null, { previous: saved });
    expect(cleared.read_assistance).toBeUndefined();
    await writeBoundaryAuthoringResumeState(root, cleared, { expectedRevisionDigest: saved.revision_digest });
    expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: cleared });
  });

  it.each(["job", "boundary"])("does not inherit assistance after a changed %s", change => {
    const saved = build(checkpoint());
    const next = build(undefined, { previous: saved, ...(change === "job" ? { jobIntent: "Inspect a different job." }
      : { binding: { ...binding, boundary_name: "other_read" } }) });
    expect(next.read_assistance).toBeUndefined();
  });

  it.each([false, 0, "", {}])("refuses explicit invalid shape %j instead of treating it as a clear", invalid => {
    expect(() => build(invalid as unknown as ReadWorkloadAssistanceCheckpoint)).toThrow("CHECKPOINT_INVALID");
  });

  it.each(["digest", "calls", "attempts", "extra", "values"])("rejects %s checkpoint mutation at construction and reload without losing the file", async change => {
    const root = await project(), cp = checkpoint(), saved = build(cp);
    const bad = structuredClone(cp);
    if (change === "digest") bad.input_digest = canonicalJsonDigest("changed input");
    else if (change === "calls") bad.state.call_count = 12;
    else if (change === "attempts") bad.state.attempt = 17;
    else if (change === "extra") Object.assign(bad.state, { unknown_failed_args: {} });
    else { bad.stage = "decided"; bad.pending_question = { kind: "value", request, question: questionText,
      decision: { state: "provided", resource: request.resource, field: request.field, values: ["v".repeat(201)], egressAcknowledged: true } }; }
    const candidate = change === "digest" ? bad : resign(bad);
    expect(() => build(candidate)).toThrow("CHECKPOINT_INVALID");
    await writeBoundaryAuthoringResumeState(root, saved);
    const corrupt = resignResume({ ...saved, read_assistance: candidate });
    await fs.writeFile(resumeFile(root), JSON.stringify(corrupt));
    expect((await readBoundaryAuthoringResumeState(root, binding)).status).toBe("invalid");
    expect(await fs.readFile(resumeFile(root), "utf8")).toBe(JSON.stringify(corrupt));
  });

  it("requires supplied local owner ledgers to match and allows only isolated completionless fixtures without one", () => {
    const cp = checkpoint(), handoff = localOwner();
    expect(build(cp).read_assistance).toEqual(cp);
    expect(build(cp, { ownerHandoffs: [handoff] }).read_assistance).toEqual(cp);
    expect(() => build(cp, { ownerHandoffs: [localOwner("planning")] })).toThrow("matching owner-question");
    expect(() => build(cp, { ownerHandoffs: [localOwner("read_clarification", "A different question?")] })).toThrow("matching owner-question");
    expect(() => build(cp, { generationRecovery: { version: 1, operations: [] } })).toThrow("matching owner-question");
    const decided = checkpoint({ ...cp.pending_question, decision: { state: "answered", answer: "Scoped stages" } } as ReadWorkloadAssistanceQuestion);
    const answered = answerOwnerHandoff(handoff, "Scoped stages", handoff.context_digest);
    expect(build(decided, { ownerHandoffs: [answered] }).read_assistance).toEqual(decided);
    expect(() => build(decided, { ownerHandoffs: [handoff] })).toThrow("attributable owner answer");
    expect(() => build(decided, { ownerHandoffs: [answerOwnerHandoff(handoff, "Other stages", handoff.context_digest)] })).toThrow("attributable owner answer");
    expect(() => build(cp, { ownerHandoffs: [answered] })).toThrow("already answered");
  });
});

// Real offline decoder -> actual completed question -> owner handoff -> resume
// CAS. No historical generation is fabricated or acknowledged by these fixtures.
async function completedPair(kind: ReadWorkloadAssistanceQuestion["kind"] = "clarification") {
  const root = await project(); let current = build();
  await writeBoundaryAuthoringResumeState(root, current);
  return withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => current.generation_recovery,
      current: async () => canonicalJsonDigest(binding), write: async recovery => {
        const next = build(undefined, { previous: current, generationRecovery: recovery });
        await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: current.revision_digest }); current = next;
      } });
    const tools = [{ name: "runner.inspect", description: "OWNED OFFLINE", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
    const authorityDigest = askToolSurfaceDigest(tools);
    const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "offline-test", api_key: "OWNED-key", authority_digest: authorityDigest, egress_acknowledged: true }, {}, new Date());
    const result = await runAskProviderTurn({ configuration, question: "OWNED OFFLINE", history: [], tools, authorityDigest, signal: new AbortController().signal,
      gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async () => { throw new Error("No callback allowed"); } },
      dependencies: { requestJson: async () => ({ status: 200, body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: questionText }] }] } }) } });
    const completion = completedAuthoringQuestion(result);
    const cp = checkpoint({ kind, request, question: result.answer, completion } as ReadWorkloadAssistanceQuestion);
    const handoff = createOwnerHandoff({ consumer: kind === "value" ? "read_value_context" : "read_clarification",
      scope_digest: cp.input_digest, context_digest: cp.boundary_digest, question: result.answer, completion });
    const generation = authoringQuestionCheckpoint(current.generation_recovery, ownerHandoffCheckpoint(handoff));
    const next = build(cp, { previous: current, ownerHandoffs: [handoff], generationRecovery: generation });
    return { root, base: current, next, cp, handoff };
  });
}
function decidedPair(pair: Awaited<ReturnType<typeof completedPair>>, decision: ReadWorkloadAssistanceQuestion["decision"]) {
  const cp = checkpoint({ ...pair.cp.pending_question, decision } as ReadWorkloadAssistanceQuestion);
  if (cp.stage !== "decided") throw new Error("The fixture must contain a decided question.");
  const answer = readWorkloadAssistanceDecisionAnswer(cp.pending_question);
  const handoff = answerOwnerHandoff(pair.handoff, answer, pair.handoff.context_digest);
  const generation = authoringQuestionAnswerCheckpoint(pair.next.generation_recovery, ownerHandoffCheckpoint(pair.handoff),
    { digest: canonicalJsonDigest(handoff), operator_messages: [answer] });
  const next = build(cp, { previous: pair.next, ownerHandoffs: [handoff], generationRecovery: generation });
  return { next, cp, handoff };
}

describe("Read assistance actual completion linkage and atomic persistence", () => {
  it("preserves a dispatch reservation without inventing a question or acknowledging an uncertain local save", async () => {
    const pair = await completedPair();
    const { digest: _digest, pending_question: _pending, dispatch_question: _dispatch, ...body } = checkpoint();
    const raw = readWorkloadAssistanceCheckpoint({ ...body, stage: "dispatching",
      dispatch_question: "Map the selected visit stages using the current reviewed inputs." });
    const next = build(raw, { previous: pair.base, generationRecovery: pair.base.generation_recovery });
    await writeBoundaryAuthoringResumeState(pair.root, next, { expectedRevisionDigest: pair.base.revision_digest });
    const loaded = await readBoundaryAuthoringResumeState(pair.root, binding);
    if (loaded.status !== "ready") throw new Error("Expected the reserved Read input to remain inspectable.");
    expect(loaded.value.read_assistance).toEqual(raw);
    expect(loaded.value.read_assistance).not.toHaveProperty("pending_question");
    expect(loaded.value.owner_handoffs ?? []).toEqual([]);
    expect(loaded.value.read).toBeUndefined();
    expect(loaded.value.generation_recovery).toEqual(pair.base.generation_recovery);
    expect(loaded.value.generation_recovery!.operations[0]).toMatchObject({ state: "handled" });
    expect(loaded.value.generation_recovery!.operations[0]).not.toHaveProperty("checkpoint_seen", true);
    expect(() => build(resign({ ...raw, pending_question: checkpoint().pending_question }) as ReadWorkloadAssistanceCheckpoint))
      .toThrow("CHECKPOINT_INVALID");
  });

  it("keeps exact prior consent as inert dispatch history and refuses a substituted answer or receipt", async () => {
    const pair = await completedPair();
    await writeBoundaryAuthoringResumeState(pair.root, pair.next, { expectedRevisionDigest: pair.base.revision_digest });
    const answered = decidedPair(pair, { state: "answered", answer: "Reviewed stages" });
    await writeBoundaryAuthoringResumeState(pair.root, answered.next, { expectedRevisionDigest: pair.next.revision_digest });
    if (answered.cp.stage !== "decided") throw new Error("Expected the actual answered fixture.");
    const { digest: _digest, pending_question, ...body } = answered.cp;
    const raw = readWorkloadAssistanceCheckpoint({ ...body, stage: "dispatching", dispatch_question: "Continue the current reviewed mapping.",
      previous_question: { stage: "decided", pending_question }, state: { ...body.state, attempt: body.state.attempt + 1 } });
    const saved = build(raw, { previous: answered.next });
    await writeBoundaryAuthoringResumeState(pair.root, saved, { expectedRevisionDigest: answered.next.revision_digest });
    expect(saved.owner_handoffs).toEqual(answered.next.owner_handoffs);
    expect(saved.generation_recovery).toEqual(answered.next.generation_recovery);
    for (const bad of [{ ...pending_question, decision: { state: "answered", answer: "Different stages" } },
      { ...pending_question, completion: { ...pending_question.completion!, response_digest: canonicalJsonDigest("another response") } }]) {
      expect(() => build(readWorkloadAssistanceCheckpoint({ ...body, stage: "dispatching", dispatch_question: raw.dispatch_question!,
        previous_question: { stage: "decided", pending_question: bad as ReadWorkloadAssistanceQuestion } }), { previous: answered.next }))
        .toThrow("RESUME_INVALID");
    }
  });

  it.each(["clarification", "value", "relationship"] as const)("binds %s to the actual consumer and canonical answered owner record", async kind => {
    const pair = await completedPair(kind);
    expect(pair.base.generation_recovery!.operations[0]!.state).toBe("handled");
    expect(pair.next.generation_recovery!.operations[0]!.question_handoff!.checkpoint_digest).toBe(pair.handoff.digest);
    expect(pair.handoff.digest).not.toBe(pair.cp.digest);
    await writeBoundaryAuthoringResumeState(pair.root, pair.next, { expectedRevisionDigest: pair.base.revision_digest });
    const decision = kind === "value" ? { state: "without_values" as const }
      : kind === "relationship" ? { state: "relationship_reviewed" as const } : { state: "answered" as const, answer: "Reviewed stages" };
    const answered = decidedPair(pair, decision);
    await writeBoundaryAuthoringResumeState(pair.root, answered.next, { expectedRevisionDigest: pair.next.revision_digest });
    expect(await readBoundaryAuthoringResumeState(pair.root, binding)).toEqual({ status: "ready", value: answered.next });
    expect(answered.next.generation_recovery!.operations[0]!.question_handoff!.answered!.checkpoint_digest).toBe(canonicalJsonDigest(answered.handoff));
  });

  it.each(["missing_owner", "stale_consumer", "response", "owner_digest"])("refuses waiting actual completion with %s at construction and parsing", async change => {
    const pair = await completedPair(); let handoffs = [pair.handoff]; let generation = structuredClone(pair.next.generation_recovery!);
    if (change === "missing_owner") handoffs = [];
    else if (change === "stale_consumer") {
      const { digest: _digest, state: _state, ...body } = pair.handoff;
      handoffs = [{ ...pair.handoff, consumer: "planning", digest: canonicalJsonDigest({ ...body, consumer: "planning" }) }];
      generation.operations[0]!.question_handoff!.consumer = "planning";
      generation.operations[0]!.question_handoff!.checkpoint_digest = handoffs[0]!.digest;
    } else if (change === "response") generation.operations[0]!.question_handoff!.response_digest = canonicalJsonDigest("another response");
    else generation.operations[0]!.question_handoff!.checkpoint_digest = pair.cp.digest;
    expect(() => build(pair.cp, { ownerHandoffs: handoffs, generationRecovery: generation })).toThrow("RESUME_INVALID");
    expect(() => assertBoundaryAuthoringResumeState(resignResume({ ...pair.next, owner_handoffs: handoffs, generation_recovery: generation }))).toThrow("RESUME_INVALID");
  });

  it("rejects an independently changed typed decision, answer or answer attribution digest", async () => {
    const pair = await completedPair(), answered = decidedPair(pair, { state: "answered", answer: "Reviewed stages" });
    const changed = checkpoint({ ...answered.cp.pending_question, decision: { state: "answered", answer: "Changed stages" } } as ReadWorkloadAssistanceQuestion);
    expect(() => build(changed, { ownerHandoffs: [answered.handoff], generationRecovery: answered.next.generation_recovery })).toThrow("attributable owner answer");
    const wrongGeneration = structuredClone(answered.next.generation_recovery!);
    wrongGeneration.operations[0]!.question_handoff!.answered!.checkpoint_digest = answered.cp.digest;
    expect(() => build(answered.cp, { ownerHandoffs: [answered.handoff], generationRecovery: wrongGeneration })).toThrow("committed consumer");
    expect(() => assertBoundaryAuthoringResumeState(resignResume({ ...answered.next, read_assistance: changed }))).toThrow("attributable owner answer");
  });

  it.each([false, true])("keeps whole waiting or decided checkpoint after lost answer acknowledgement (rename committed=%s)", async committed => {
    const pair = await completedPair(); await writeBoundaryAuthoringResumeState(pair.root, pair.next, { expectedRevisionDigest: pair.base.revision_digest });
    const answered = decidedPair(pair, { state: "declined" }), rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      if (committed) await rename(from, to); throw Object.assign(new Error("OWNED lost acknowledgement"), { code: "EACCES" });
    });
    await expect(writeBoundaryAuthoringResumeState(pair.root, answered.next, { expectedRevisionDigest: pair.next.revision_digest })).rejects.toMatchObject({ code: "EACCES" });
    expect(await readBoundaryAuthoringResumeState(pair.root, binding)).toEqual({ status: "ready", value: committed ? answered.next : pair.next });
    if (committed) await expect(writeBoundaryAuthoringResumeState(pair.root, answered.next, { expectedRevisionDigest: pair.next.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    else await writeBoundaryAuthoringResumeState(pair.root, answered.next, { expectedRevisionDigest: pair.next.revision_digest });
    const loaded = await readBoundaryAuthoringResumeState(pair.root, binding);
    if (loaded.status !== "ready") throw new Error("Expected exact resumed answer");
    expect(build(undefined, { previous: loaded.value }).read_assistance).toEqual(answered.cp);
  });
});
