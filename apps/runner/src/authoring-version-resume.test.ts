import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionLogicalTurnBudget, actionRuleAuthoringCheckpoint, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { actionVersionMaterialDigest, resolveActionVersionConsumption, assertActionVersionQuestionHandoff, assertBoundaryAuthoringResumeState,
  buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { answerOwnerHandoff, createOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, leaveOperatorQuestionPending, presentOperatorQuestion, proposeOperatorAnswer,
  stopOperatorVersionQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { consumedOperatorQuestionFailure, runOperatorQuestionModel } from "./authoring-operator-question-model.js";
import { authoringActionCheckpoint, authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint,
  configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn,
  type AskProviderDependencies, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";

const binding: BoundaryAuthoringResumeBinding = { boundary_name: "controlled_version_resume",
  generation_lock_fingerprint: canonicalJsonDigest("Controlled exact generation lock."),
  schema_fingerprint: canonicalJsonDigest("Controlled schema binding."),
  role_posture_fingerprint: canonicalJsonDigest("Controlled read-only role binding.") };
const intent = "Prepare the disabled parcel hold.";
const wording = "Do all applications changing a parcel advance this counter?";

function reseal<T extends { digest: `sha256:${string}` }>(record: T): T {
  const { digest: _old, ...body } = record;
  return { ...body, digest: canonicalJsonDigest(body) } as T;
}
function revise(state: BoundaryAuthoringResumeState, change: (next: BoundaryAuthoringResumeState) => void) {
  const next = structuredClone(state); change(next);
  const { revision_digest: _old, ...body } = next;
  return { ...body, revision_digest: canonicalJsonDigest(body) };
}

/** Actual local normal decoder, live consumed-sequence registry and B35
 * checkpoints. No saved operation is rewritten into a successful phase. */
async function genuineVersion(options: { terminal?: "present" | "answer-map"; raw?: boolean; rawText?: string;
  mapping?: "proposed" | "pending"; duplicate?: "present" | "answer-map" } = {}) {
  const scope = canonicalJsonDigest(intent), context = canonicalJsonDigest("Exact current Action, Read, Source and structural proof."),
    proof = canonicalJsonDigest("Labelled structural Version proof; not authority or writer behavior.");
  let checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: scope, context_digest: context, components: {},
    logical_turns: [{ id: randomUUID(), origin_context_digest: context, iterations_used: 0, tool_calls_used: 0 }] });
  let generation: AuthoringTransportState | undefined;
  let question: OperatorQuestion, handoff: AuthoringOwnerHandoff;
  const budget = actionLogicalTurnBudget({ read: () => checkpoint, save: async (next, expected) => {
    if (checkpoint.digest !== expected) throw new Error("CONTROLLED_CHECKPOINT_CAS_CHANGED"); checkpoint = next;
  } });
  let initial = true;
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => ({ status: 200,
    body: { status: "completed", output: [{ type: "function_call", call_id: randomUUID(),
      name: initial ? "runner__review_version_field" : "runner__propose_operator_decision",
      arguments: JSON.stringify(initial ? (initial = false, {}) : !question.presentation
        ? { question_id: options.terminal === "present" ? randomUUID() : question.id, revision: question.revision, status: "needs_information", question: wording }
        : { question_id: question.id, revision: question.revision, status: "proposal",
          answer_id: options.terminal === "answer-map" ? randomUUID() : question.raw_answer!.id,
          disposition: options.mapping ?? "proposed", ...(options.mapping === "pending" ? {} : {
            value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }) }) }] } }));
  await withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => generation,
      write: async next => { generation = structuredClone(next); }, current: async () => context });
    const tools: AskToolDefinition[] = [{ name: "runner.review_version_field", description: "Controlled pure structural question stage.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } }];
    const authorityDigest = askToolSurfaceDigest(tools);
    const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "controlled-version-resume",
      api_key: "inert-controlled-key", egress_acknowledged: true, authority_digest: authorityDigest }, {}, new Date());
    const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools, close: async () => {},
      callTool: async () => ({ ok: true, value: { status: "staged", authority_granted: false } }) };
    const turn = await runAskProviderTurn({ configuration, tools, authorityDigest, gateway, question: intent, history: [],
      signal: new AbortController().signal, conversationalAuthoring: true, actionLogicalTurnBudget: budget,
      stopAfterAuthoringToolBatch: () => true, dependencies: { requestJson },
      authoringInput: { consumer: "action_rule_components", operator_message: intent } });
    const completion = completedAuthoringQuestion(turn);
    if (!completion) throw new Error("Controlled decoder did not yield genuine consumed completion.");
    handoff = createOwnerHandoff({ consumer: "version_maintenance", scope_digest: scope, context_digest: context, question: wording, completion });
    question = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: handoff.id, kind: "writer_maintenance",
      scope_digest: scope, context_digest: context, target: { phase: "changed-record protection", resource: "work.parcels", field: "revision", outcomes: ["work.hold"] },
      material: ["Only planned, unverified writer maintenance; no authority or implementation is established."],
      evidence: [{ id: "version-structure", digest: proof }], continuation: "version_mapping" });
    generation = authoringQuestionCheckpoint(generation, ownerHandoffCheckpoint(handoff));
    const { schema_version: _schema, digest: _digest, ...core } = checkpoint;
    checkpoint = actionRuleAuthoringCheckpoint({ ...core, pending_question: { question: wording, operator_message: intent, completion },
      pending_version: { turn_id: checkpoint.logical_turns!.at(-1)!.id, root_question_id: question.id, question_id: question.id,
        handoff_id: handoff.id, resource: "work.parcels", field: "revision", proof_digest: proof } });
    const model = (stage: "present" | "answer-map", current = question) => runOperatorQuestionModel({ question: current, stage,
      session: { provider: "openai", model: "controlled-version-resume", apiKey: "inert-controlled-key", dependencies: { requestJson } },
      actionLogicalTurnBudget: budget, reserveCorrection: () => budget.reserveCorrection(current.id),
      authorityGuard: async expected => expected, egressAcknowledged: true, env: {} });
    if (options.terminal !== "present") {
      const unpresented = question, result = await model("present");
      if (result.state !== "question" || !result.completion) throw new Error("No actual presentation completion.");
      question = presentOperatorQuestion(question, result.question);
      generation = authoringActionCheckpoint(generation!, result.completion, { consumer: "action_rule_components",
        kind: "version_interpretation", material_digest: actionVersionMaterialDigest(checkpoint, question, "present") });
      if (options.duplicate === "present") {
        // A labelled component ambiguity control: two real consumed replies,
        // never a copied operation or a second public controller invocation.
        const presented = question; question = unpresented;
        const duplicate = await model("present"); question = presented;
        if (!duplicate.completion) throw new Error("No actual duplicate consumed presentation.");
        generation = authoringActionCheckpoint(generation!, duplicate.completion, { consumer: "action_rule_components",
          kind: "version_interpretation", material_digest: actionVersionMaterialDigest(checkpoint, question, "present") });
      }
    }
    if (options.raw || options.terminal === "answer-map" || options.mapping) {
      const raw = options.rawText ?? "  All parcel writers — café\tadvance the counter.  ";
      question = captureOperatorAnswer(question, raw);
      if (raw.trim()) {
        const answered = answerOwnerHandoff(handoff, raw, context);
        generation = authoringQuestionAnswerCheckpoint(generation, ownerHandoffCheckpoint(handoff),
          { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
        handoff = answered;
      } else question = leaveOperatorQuestionPending(question, "unknown");
    }
    if (options.mapping) {
      const unmapped = question, result = await model("answer-map");
      if (result.state === "question" || !result.completion) throw new Error("No actual mapping completion.");
      question = proposeOperatorAnswer(question, result.proposal);
      generation = authoringActionCheckpoint(generation!, result.completion, { consumer: "action_rule_components",
        kind: "version_interpretation", material_digest: actionVersionMaterialDigest(checkpoint, question, "answer-map") });
      if (options.duplicate === "answer-map") {
        const mapped = question; question = unmapped;
        const duplicate = await model("answer-map"); question = mapped;
        if (!duplicate.completion) throw new Error("No actual duplicate consumed mapping.");
        generation = authoringActionCheckpoint(generation!, duplicate.completion, { consumer: "action_rule_components",
          kind: "version_interpretation", material_digest: actionVersionMaterialDigest(checkpoint, question, "answer-map") });
      }
    }
    if (options.terminal) {
      let caught: unknown;
      try {
        await model(options.terminal);
      } catch (error) { caught = error; }
      const failure = consumedOperatorQuestionFailure(caught, question, options.terminal);
      if (!failure) throw new Error("No actual consumed invalid-plus-correction terminal proof was produced.");
      question = stopOperatorVersionQuestion(question, { stage: options.terminal, completion: failure.completion });
      generation = authoringActionCheckpoint(generation!, failure.completion, { consumer: "action_rule_components",
        kind: "version_interpretation", material_digest: actionVersionMaterialDigest(checkpoint, question, options.terminal) });
    }
  });
  const state = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: intent, provider: "openai", model: "controlled-version-resume",
    action: { intent, checkpoint }, generationRecovery: generation, operatorQuestions: [question!], ownerHandoffs: [handoff!] });
  return { state, checkpoint, question: question!, handoff: handoff!, generation: generation!, requestJson };
}

/** Supported model-free host replacement primitives. Blank evidence reuses the
 * still-waiting handoff; nonblank evidence creates a fresh completion-free h.
 * No presentation response or authoring allowance is minted on either route. */
function replacementChild(state: BoundaryAuthoringResumeState, raw?: string) {
  return revise(state, next => {
    const cp = next.action!.checkpoint!, marker = cp.pending_version!;
    const index = next.operator_questions!.findIndex(q => q.id === marker.question_id), current = next.operator_questions![index]!;
    if (!current.raw_answer) throw new Error("The fixture cannot replace an uncaptured answer.");
    const previous = current.disposition ? current : leaveOperatorQuestionPending(current, "declined");
    next.operator_questions![index] = previous;
    const hIndex = next.owner_handoffs!.findIndex(h => h.id === previous.handoff_id), oldH = next.owner_handoffs![hIndex]!;
    let handoff = oldH;
    if (previous.raw_answer!.text.trim()) {
      handoff = createOwnerHandoff({ consumer: "version_maintenance", scope_digest: previous.scope_digest,
        context_digest: previous.context_digest, question: previous.presentation!.text });
      next.owner_handoffs!.push(handoff);
    }
    let child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: previous.revision + 1,
      handoff_id: handoff.id, kind: "writer_maintenance", scope_digest: previous.scope_digest, context_digest: previous.context_digest,
      target: previous.target, material: previous.material, evidence: previous.evidence, continuation: "version_mapping" }), previous.presentation!.text);
    if (raw !== undefined) {
      child = captureOperatorAnswer(child, raw);
      if (!raw.trim()) child = leaveOperatorQuestionPending(child, "unknown");
      else {
        const answered = answerOwnerHandoff(handoff, raw, child.context_digest);
        if (handoff.completion) next.generation_recovery = authoringQuestionAnswerCheckpoint(next.generation_recovery,
          ownerHandoffCheckpoint(handoff), { digest: canonicalJsonDigest(answered), operator_messages: [raw] });
        next.owner_handoffs![next.owner_handoffs!.findIndex(h => h.id === handoff.id)] = answered;
      }
    }
    next.operator_questions!.push(child);
    cp.pending_version = { ...marker, question_id: child.id, handoff_id: handoff.id };
    next.action!.checkpoint = reseal(cp);
  });
}

describe("Version outer Resume guard with genuine consumed local decoder fixtures", () => {
  it("parses the exact unfinished owning turn without adopting maintenance or closing its allowance", async () => {
    const f = await genuineVersion();
    expect(() => assertBoundaryAuthoringResumeState(JSON.parse(JSON.stringify(f.state)))).not.toThrow();
    expect(() => assertActionVersionQuestionHandoff(f.state, f.checkpoint)).not.toThrow();
    expect(f.checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 2, tool_calls_used: 2 });
    expect(f.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
    expect(f.state.authority_granted).toBe(false); expect(f.checkpoint.reviewed_version_fields).toBeUndefined();
    expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it.each(["present", "answer-map"] as const)("%s terminal saves and restarts with the exact outer action checkpoint, without further generation", async terminal => {
    const f = await genuineVersion({ terminal });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "controlled-version-resume-"));
    try {
      expect(() => assertBoundaryAuthoringResumeState(f.state)).not.toThrow();
      const before = structuredClone(f.state);
      await writeBoundaryAuthoringResumeState(root, f.state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: before });
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: before });
      const count = terminal === "present" ? 3 : 4;
      expect(f.requestJson).toHaveBeenCalledTimes(count);
      expect(f.checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: count, tool_calls_used: count, used_version_corrections: [f.question.id] });
      expect(f.question.confirmation).toBeUndefined(); expect(f.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
      expect(f.generation.operations.at(-1)!.action_checkpoint).toMatchObject({ consumer: "action_rule_components", kind: "version_interpretation" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("keeps Version material stable across counters and checksum-only metadata, while binding exact raw, target, proof, revision and stage", async () => {
    const f = await genuineVersion({ raw: true }), original = actionVersionMaterialDigest(f.checkpoint, f.question, "answer-map");
    const cp = structuredClone(f.checkpoint); cp.logical_turns![0]!.iterations_used++; cp.logical_turns![0]!.tool_calls_used++;
    expect(actionVersionMaterialDigest(reseal(cp), f.question, "answer-map")).toBe(original);
    for (const change of [
      (q: OperatorQuestion) => { q.raw_answer!.text += " "; },
      (q: OperatorQuestion) => { q.target.field = "another_revision"; },
      (q: OperatorQuestion) => { q.evidence[0]!.digest = canonicalJsonDigest("Another proof."); },
      (q: OperatorQuestion) => { q.revision++; },
    ]) { const q = structuredClone(f.question); change(q); expect(actionVersionMaterialDigest(f.checkpoint, reseal(q), "answer-map")).not.toBe(original); }
    expect(actionVersionMaterialDigest(f.checkpoint, f.question, "present")).not.toBe(original);
  });
  it.each(["missing-root", "missing-handoff", "wrong-turn", "wrong-field", "wrong-proof"] as const)("%s refuses before public Resume can offer continuation", async kind => {
    const f = await genuineVersion();
    const bad = revise(f.state, next => {
      const cp = next.action!.checkpoint!;
      if (kind === "missing-root") next.operator_questions = [];
      if (kind === "missing-handoff") next.owner_handoffs = [];
      if (kind === "wrong-turn") cp.pending_version!.turn_id = randomUUID();
      if (kind === "wrong-field") cp.pending_version!.field = "another_revision";
      if (kind === "wrong-proof") cp.pending_version!.proof_digest = canonicalJsonDigest("Another currentness proof.");
      next.action!.checkpoint = reseal(cp);
    });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow(/BOUNDARY_AUTHORING_RESUME_INVALID|ACTION_AUTHORING_CHECKPOINT_INVALID|AUTHORING_QUESTION_INVALID/);
    expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it("retains a real answered root prefix for a host-created replacement and refuses removal or evidence rebind", async () => {
    const f = await genuineVersion({ raw: true });
    const original = leaveOperatorQuestionPending(f.question, "declined");
    const nextH = createOwnerHandoff({ consumer: "version_maintenance", scope_digest: f.question.scope_digest,
      context_digest: f.question.context_digest, question: wording });
    const child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 2, handoff_id: nextH.id,
      kind: "writer_maintenance", scope_digest: original.scope_digest, context_digest: original.context_digest,
      target: original.target, material: original.material, evidence: original.evidence, continuation: "version_mapping" }), wording);
    const state = revise(f.state, next => {
      next.operator_questions = [original, child]; next.owner_handoffs = [f.handoff, nextH];
      const cp = next.action!.checkpoint!; cp.pending_version = { ...cp.pending_version!, question_id: child.id, handoff_id: nextH.id };
      next.action!.checkpoint = reseal(cp);
    });
    expect(() => assertBoundaryAuthoringResumeState(state)).not.toThrow();
    expect(() => assertBoundaryAuthoringResumeState(revise(state, next => { next.operator_questions!.shift(); }))).toThrow();
    expect(() => assertBoundaryAuthoringResumeState(revise(state, next => {
      const q = next.operator_questions![1]!; q.evidence[0]!.digest = canonicalJsonDigest("Different child proof."); next.operator_questions![1] = reseal(q);
    }))).toThrow();
  });
  it("retains exact blank evidence and the original waiting h while a new child reuses the consumed root presentation", async () => {
    const blank = " \t  ", f = await genuineVersion({ raw: true, rawText: blank });
    const childState = replacementChild(f.state), child = childState.operator_questions!.at(-1)!;
    expect(() => assertBoundaryAuthoringResumeState(childState)).not.toThrow();
    expect(child.raw_answer).toBeUndefined(); expect(child.presentation!.text).toBe(f.question.presentation!.text);
    expect(child.handoff_id).toBe(f.handoff.id); expect(childState.owner_handoffs).toEqual([f.handoff]);
    expect(childState.operator_questions![0]!.raw_answer!.text).toBe(blank);
    expect(childState.operator_questions![0]).toEqual(f.question);
    expect(childState.action!.checkpoint!.logical_turns).toEqual(f.checkpoint.logical_turns);
    expect(childState.generation_recovery).toEqual(f.generation);
    expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it("anchors two prior blank answers to the exact final Unicode child that actually answered their shared B35 handoff", async () => {
    const f = await genuineVersion({ raw: true, rawText: " \t " }), second = replacementChild(f.state, "\t  ");
    const raw = "  Tous les auteurs — café 😀\taugmentent le compteur.  ", final = replacementChild(second, raw);
    expect(() => assertBoundaryAuthoringResumeState(final)).not.toThrow();
    expect(final.operator_questions!.map(q => q.raw_answer!.text)).toEqual([" \t ", "\t  ", raw]);
    expect(new Set(final.operator_questions!.map(q => q.handoff_id)).size).toBe(1);
    expect(final.owner_handoffs).toHaveLength(1);
    expect(final.owner_handoffs![0]).toMatchObject({ state: "answered", answer: raw, actor: "local_installation_operator" });
    expect(final.operator_questions![0]).toEqual(second.operator_questions![0]);
    expect(final.operator_questions![1]).toEqual(second.operator_questions![1]);
    expect(final.action!.checkpoint!.logical_turns).toEqual(f.checkpoint.logical_turns);
    const bad = revise(final, next => {
      const q = next.operator_questions!.at(-1)!; q.raw_answer!.text += " "; next.operator_questions![next.operator_questions!.length - 1] = reseal(q);
    });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow();
    expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it("requires every immediate replacement edge and refuses missing/reordered prefix, changed wording or completion copied to a new h", async () => {
    const f = await genuineVersion({ raw: true, rawText: " \t " }), second = replacementChild(f.state, "All writers advance it."),
      final = replacementChild(second);
    expect(() => assertBoundaryAuthoringResumeState(final)).not.toThrow();
    const newestH = final.owner_handoffs!.at(-1)!;
    expect(newestH.completion).toBeUndefined(); expect(newestH.id).not.toBe(f.handoff.id);
    for (const kind of ["missing-prefix", "reordered-prefix", "changed-wording", "copied-completion"] as const) {
      const bad = revise(final, next => {
        if (kind === "missing-prefix") next.operator_questions!.splice(1, 1);
        if (kind === "reordered-prefix") [next.operator_questions![0], next.operator_questions![1]] = [next.operator_questions![1]!, next.operator_questions![0]!];
        if (kind === "changed-wording") {
          const q = next.operator_questions!.at(-1)!; q.presentation!.text += " Another claim."; next.operator_questions![next.operator_questions!.length - 1] = reseal(q);
        }
        if (kind === "copied-completion") {
          const h = next.owner_handoffs!.at(-1)!; h.completion = f.handoff.completion; next.owner_handoffs![next.owner_handoffs!.length - 1] = reseal(h);
        }
      });
      expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow();
    }
    expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it.each(["present", "answer-map"] as const)("%s terminal refuses an absent owning marker or a removed sparse correction root", async terminal => {
    const f = await genuineVersion({ terminal });
    for (const kind of ["marker", "correction"] as const) {
      const bad = revise(f.state, next => {
        const cp = next.action!.checkpoint!;
        if (kind === "marker") delete cp.pending_version;
        else delete cp.logical_turns![0]!.used_version_corrections;
        next.action!.checkpoint = reseal(cp);
      });
      expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow();
    }
    expect(f.requestJson).toHaveBeenCalledTimes(terminal === "present" ? 3 : 4);
  });
  it.each(["material", "response", "ordinary-kind", "missing-record"] as const)("%s cannot substitute an ordinary or unbound checkpoint for terminal Version consumption", async kind => {
    const f = await genuineVersion({ terminal: "answer-map" });
    const bad = revise(f.state, next => {
      const op = next.generation_recovery!.operations.at(-1)!;
      if (kind === "material") op.action_checkpoint!.material_digest = canonicalJsonDigest("A different Version answer.");
      if (kind === "response") op.action_checkpoint!.response_digest = canonicalJsonDigest("Different response.");
      if (kind === "ordinary-kind") op.action_checkpoint!.kind = "compiled_draft";
      if (kind === "missing-record") delete op.action_checkpoint;
    });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow();
  });
  it("refuses a re-bound original completion even when both stored checksums are resealed", async () => {
    const f = await genuineVersion();
    const bad = revise(f.state, next => {
      const q = next.operator_questions![0]!, h = next.owner_handoffs![0]!;
      const rewritten = reseal({ ...h, question: "Another original question." }); next.owner_handoffs![0] = rewritten;
      const cp = next.action!.checkpoint!; cp.pending_question!.question = rewritten.question; next.action!.checkpoint = reseal(cp);
      expect(q.handoff_id).toBe(rewritten.id);
    });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow();
  });
  it("resolves the distinct exact consumed presentation and mapping records, not the first or last convenient operation", async () => {
    const f = await genuineVersion({ mapping: "proposed" });
    expect(() => assertBoundaryAuthoringResumeState(f.state)).not.toThrow();
    const present = resolveActionVersionConsumption(f.generation, f.checkpoint, f.question, "present"),
      mapped = resolveActionVersionConsumption(f.generation, f.checkpoint, f.question, "answer-map");
    expect(present.id).toBe(f.generation.operations[1]!.id);
    expect(mapped.id).toBe(f.generation.operations[2]!.id);
    expect(present.id).not.toBe(mapped.id);
    expect(present.action_checkpoint!.material_digest).toBe(actionVersionMaterialDigest(f.checkpoint, f.question, "present"));
    expect(mapped.action_checkpoint!.material_digest).toBe(actionVersionMaterialDigest(f.checkpoint, f.question, "answer-map"));
    expect(f.requestJson).toHaveBeenCalledTimes(3);
  });
  it.each(["present", "answer-map"] as const)("%s refuses a missing exact consumed semantic record despite a healthy decoded operation", async stage => {
    const f = await genuineVersion({ mapping: "proposed" });
    const consumed = resolveActionVersionConsumption(f.generation, f.checkpoint, f.question, stage);
    const bad = revise(f.state, next => { delete next.generation_recovery!.operations.find(op => op.id === consumed.id)!.action_checkpoint; });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow("unique consumed response");
    expect(f.requestJson).toHaveBeenCalledTimes(3);
  });
  it.each(["present", "answer-map"] as const)("%s rejects two genuinely consumed component records for identical material instead of selecting one", async duplicate => {
    const f = await genuineVersion({ mapping: "proposed", duplicate });
    const material = actionVersionMaterialDigest(f.checkpoint, f.question, duplicate);
    const matches = f.generation.operations.filter(op => op.action_checkpoint?.material_digest === material);
    expect(matches).toHaveLength(2); expect(new Set(matches.map(op => op.id)).size).toBe(2);
    expect(matches.every(op => op.state === "checkpointed" && op.checkpoint_seen && op.attempts.at(-1)?.outcome === "response")).toBe(true);
    expect(() => resolveActionVersionConsumption(f.generation, f.checkpoint, f.question, duplicate)).toThrow("unique consumed response");
    expect(() => assertBoundaryAuthoringResumeState(f.state)).toThrow("unique consumed response");
    expect(f.requestJson).toHaveBeenCalledTimes(4);
  });
  it.each(["present", "answer-map"] as const)("%s is typed and cannot use the other stage's retained material", async stage => {
    const f = await genuineVersion({ mapping: "proposed" });
    const consumed = resolveActionVersionConsumption(f.generation, f.checkpoint, f.question, stage);
    const bad = revise(f.state, next => {
      next.generation_recovery!.operations.find(op => op.id === consumed.id)!.action_checkpoint!.material_digest =
        actionVersionMaterialDigest(f.checkpoint, f.question, stage === "present" ? "answer-map" : "present");
    });
    expect(() => assertBoundaryAuthoringResumeState(bad)).toThrow("unique consumed response");
  });
  it.each(["raw", "target", "proof", "marker-proof", "intent", "context", "revision"] as const)("mapping consumption cannot authorize changed %s material", async kind => {
    const f = await genuineVersion({ mapping: "proposed" });
    const cp = structuredClone(f.checkpoint), q = structuredClone(f.question);
    if (kind === "raw") q.raw_answer!.text += " ";
    if (kind === "target") q.target.field = "another_counter";
    if (kind === "proof") q.evidence[0]!.digest = canonicalJsonDigest("Another structural proof.");
    if (kind === "marker-proof") cp.pending_version!.proof_digest = canonicalJsonDigest("A changed marker proof.");
    if (kind === "intent") cp.intent_digest = canonicalJsonDigest("A changed Action intent.");
    if (kind === "context") cp.context_digest = canonicalJsonDigest("A changed current Source context.");
    if (kind === "revision") q.revision++;
    expect(() => resolveActionVersionConsumption(f.generation, reseal(cp), reseal(q), "answer-map")).toThrow("unique consumed response");
  });
  it.each(["checkpoint-seen", "state", "last-attempt", "response-format"] as const)("resolver refuses adverse %s even when the material digest matches", async kind => {
    const f = await genuineVersion({ mapping: "proposed" }), state = structuredClone(f.generation);
    const consumed = resolveActionVersionConsumption(state, f.checkpoint, f.question, "answer-map");
    if (kind === "checkpoint-seen") delete consumed.checkpoint_seen;
    if (kind === "state") consumed.state = "handled";
    if (kind === "last-attempt") consumed.attempts.at(-1)!.outcome = "C";
    if (kind === "response-format") consumed.action_checkpoint!.response_digest = "sha256:invalid" as `sha256:${string}`;
    expect(() => resolveActionVersionConsumption(state, f.checkpoint, f.question, "answer-map")).toThrow("unique consumed response");
    expect(f.requestJson).toHaveBeenCalledTimes(3);
  });
  it.each(["confirmed", "declined", "pending"] as const)("%s preserves the original exact consumed projection without a new opinion", async disposition => {
    const f = await genuineVersion({ mapping: disposition === "pending" ? "pending" : "proposed" });
    const changed = disposition === "confirmed" ? confirmOperatorAnswer(f.question) : leaveOperatorQuestionPending(f.question, disposition === "declined" ? "declined" : "unknown");
    for (const stage of ["present", "answer-map"] as const)
      expect(actionVersionMaterialDigest(f.checkpoint, changed, stage)).toBe(actionVersionMaterialDigest(f.checkpoint, f.question, stage));
    const next = revise(f.state, state => { state.operator_questions![0] = changed; });
    expect(() => assertBoundaryAuthoringResumeState(next)).not.toThrow();
    expect(f.requestJson).toHaveBeenCalledTimes(3);
    expect(f.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
    expect(f.checkpoint.reviewed_version_fields).toBeUndefined();
  });
  it("keeps a legacy checkpoint with no mediated Version or fabricated completion valid", () => {
    const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(intent), context_digest: canonicalJsonDigest("Legacy exact context."), components: {} });
    const state = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: intent, provider: "openai", model: "controlled-version-resume", action: { intent, checkpoint } });
    expect(() => assertBoundaryAuthoringResumeState(state)).not.toThrow();
    expect(() => assertActionVersionQuestionHandoff(state, checkpoint)).not.toThrow();
    expect(state.generation_recovery).toBeUndefined(); expect(checkpoint.logical_turns).toBeUndefined();
  });
});
