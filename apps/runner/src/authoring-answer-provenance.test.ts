import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createOperatorQuestion, presentOperatorQuestion, captureOperatorAnswer,
  proposeOperatorAnswer, confirmOperatorAnswer, type OperatorQuestion } from "./authoring-operator-question.js";
import { runOperatorQuestionModel } from "./authoring-operator-question-model.js";
import { makeSourceInputReview } from "./authoring-input-policy.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import type { AskProviderDependencies } from "./model-ask.js";

const policy = "Setting a parcel priority also takes priority_note as caller evidence.\nAsk the operator how short or long it may be.";
function records(sourceText = policy) {
  const sources = newPolicySourceSession();
  const source = policyTextSnapshot(Buffer.from(sourceText), "current rules");
  sources.snapshots.push(source); sources.active = 1;
  const store = canonicalJsonDigest("current store"), outcomes = ["parcel.set_priority"];
  const root = createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", assistedLocalConsumer: true,
    scope_digest: canonicalJsonDigest("current job"), context_digest: canonicalJsonDigest(sources),
    target: { phase: "input_policy", outcomes }, material: ["No access or source effect is granted."], evidence: [],
    source_binding: { source_session: sources.id, source_digest: source.digest as `sha256:${string}`,
      store_digest: store, lines: source.lines, agenda_digest: canonicalJsonDigest({
        source_session: sources.id, source_digest: source.digest, store_digest: store, outcomes }) },
    continuation: "input_policy_review" });
  const child = captureOperatorAnswer(presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 2,
    handoff_id: randomUUID(), budget_owner_id: root.id, kind: "input_bounds", scope_digest: root.scope_digest,
    context_digest: root.context_digest, target: root.target, material: root.material, evidence: root.evidence,
    continuation: "input_policy_review" }), "How short or long may the priority note be?"),
    "Empty text is allowed, up to 64 UTF-16 units, counting spaces. Do not trim or default it.");
  return { root, child, sources, source, store, outcomes };
}
function model(q: OperatorQuestion, args: unknown) {
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => ({ status: 200,
    body: { status: "completed", output: [{ type: "function_call", call_id: randomUUID(),
      name: "runner__propose_operator_decision", arguments: JSON.stringify(args) }] } }));
  const episodeBudget = { admitIteration: async () => {}, reserveToolBatch: async () => {} };
  return { requestJson, run: (extra: { inputContext?: { root: OperatorQuestion; policyText: string } } = {}) => runOperatorQuestionModel({ question: q,
    stage: q.source_binding ? "source-review" : "answer-map",
    session: { provider: "openai", model: "controlled-grounding-model", apiKey: "inert-control",
      dependencies: { requestJson } }, episodeBudget, reserveCorrection: async () => false,
    authorityGuard: expected => expected, env: {}, egressAcknowledged: true,
    ...(q.source_binding ? { policyText: policy } : {}), ...extra }) };
}
const requirement = { outcomes: ["parcel.set_priority"], input: "priority_note", min_length: 0, max_length: 64 };
const mapping = (q: OperatorQuestion, requirements: Array<typeof requirement & { start?: number; end?: number }> = [requirement]) => ({ question_id: q.id, revision: q.revision,
  status: "proposal", ...(q.source_binding ? { source_reference: canonicalJsonDigest(q.source_binding) } : { answer_id: q.raw_answer!.id }),
  disposition: "proposed", value: { kind: "input_bounds", requirements } });

describe("answer-owned versus Source-owned Input provenance, real controlled producer", () => {
  it("maps a captured answer without inventing a policy-line citation and saves only after confirmation", async () => {
    const f = records(), before = structuredClone(f.child), m = model(f.child, mapping(f.child));
    const result = await m.run();
    expect(result.state).toBe("proposed"); expect(f.child).toEqual(before);
    if (result.state === "question") throw new Error("Unexpected missing question");
    const proposed = proposeOperatorAnswer(f.child, result.proposal);
    expect(proposed.confirmation).toBeUndefined();
    expect(() => makeSourceInputReview({ source: f.source, session: f.sources, store: f.store,
      outcomes: f.outcomes, requirements: [requirement], actor: "local_installation_operator",
      operatorQuestion: proposed, questionRoot: f.root })).toThrow();
    const confirmed = confirmOperatorAnswer(proposed);
    const review = makeSourceInputReview({ source: f.source, session: f.sources, store: f.store,
      outcomes: f.outcomes, requirements: [requirement], actor: "local_installation_operator",
      operatorQuestion: confirmed, questionRoot: f.root });
    expect(review.question_reference).toMatchObject({ basis: "operator_answer", answer_id: f.child.raw_answer!.id });
    expect(review.requirements).toEqual([requirement]); expect(review.verified).toBe(false);
  });
  it("still rejects a Source-derived proposal without a valid policy span", async () => {
    const f = records(), m = model(f.root, mapping(f.root));
    await expect(m.run()).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    expect(m.requestJson).toHaveBeenCalledOnce();
  });
  it("still rejects an unattributed span-free review", () => {
    const f = records();
    expect(() => makeSourceInputReview({ source: f.source, session: f.sources, store: f.store,
      outcomes: f.outcomes, requirements: [requirement], actor: "local_installation_operator" })).toThrow();
  });
  it("preserves valid legacy raw-answer spans and refuses a partial span", async () => {
    const f = records();
    await expect(model(f.child, mapping(f.child, [{ ...requirement, start: 1, end: 2 }])).run()).resolves.toMatchObject({ state: "proposed" });
    await expect(model(f.child, mapping(f.child, [{ ...requirement, start: 1 }])).run()).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
  });
  it.each(["input_bounds", "attributed_meaning", "writer_maintenance"] as const)("includes the exact saved %s question beside its answer without injecting Source", async kind => {
    const f = records();
    const q = kind === "input_bounds" ? f.child : captureOperatorAnswer(presentOperatorQuestion(createOperatorQuestion({
      id: randomUUID(), revision: 1, handoff_id: randomUUID(), kind,
      scope_digest: f.root.scope_digest, context_digest: f.root.context_digest,
      target: { phase: "current question", resource: "dispatch.parcels", field: kind === "writer_maintenance" ? "revision" : "stage",
        outcomes: f.outcomes }, material: ["No private rows or authority."], evidence: [],
      continuation: kind === "writer_maintenance" ? "version_mapping" : "read_mapping" }),
      "Is this the condition needed for the current parcel task?"), "I do not know.");
    const m = model(q, { question_id: q.id, revision: q.revision, answer_id: q.raw_answer!.id,
      status: "proposal", disposition: "pending" });
    expect((await m.run()).state).toBe("pending");
    const body = JSON.stringify(m.requestJson.mock.calls[0]![0].body);
    expect(body).toContain(q.presentation!.text);
    expect(body).toContain(q.raw_answer!.id);
    expect(body).not.toContain("Complete saved Source text");
    expect(q.confirmation).toBeUndefined();
  });
  it("retrieves the literal input identity from current policy without dumping unrelated policy", async () => {
    const sourceText = "Unrelated archive requirement: UNRELATED_PRIVATE_FACT_SENTINEL.\n" + policy;
    const f = records(sourceText), m = model(f.child, mapping(f.child));
    expect((await m.run({ inputContext: { root: f.root, policyText: sourceText } })).state).toBe("proposed");
    const body = JSON.stringify(m.requestJson.mock.calls[0]![0].body);
    expect(body).toContain("priority_note"); expect(body).toContain("naming_context_only");
    expect(body).toContain("complete_policy_review"); expect(body).toContain(f.source.digest);
    expect(body).not.toContain("UNRELATED_PRIVATE_FACT_SENTINEL");
    expect(body).not.toContain("Complete saved Source text");
    expect(f.child.source_binding).toBeUndefined(); expect(f.child.confirmation).toBeUndefined();
  });
  it.each(["changed Source", "wrong root", "too many matching lines", "oversized whole line", "no match"])("refuses unavailable bounded identity before egress without truncation: %s", async fault => {
    const sourceText = fault === "too many matching lines" ? Array(13).fill("The priority_note remains caller evidence.").join("\n")
      : fault === "oversized whole line" ? "priority_note " + "x".repeat(8_200)
      : fault === "no match" ? "Unrelated archived records." : policy;
    const f = records(sourceText), m = model(f.child, mapping(f.child));
    const root = fault === "wrong root" ? records(sourceText).root : f.root;
    await expect(m.run({ inputContext: { root, policyText: fault === "changed Source" ? sourceText + " changed" : sourceText } }))
      .rejects.toMatchObject({ code: "OPERATOR_QUESTION_CONTEXT_INVALID" });
    expect(m.requestJson).not.toHaveBeenCalled(); expect(f.child.confirmation).toBeUndefined();
  });
});
