import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionModelSuggestionSession } from "./action-tui.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { createOwnerHandoff, answerOwnerHandoff, ownerHandoffCheckpoint } from "./authoring-owner-handoff.js";
import { authoringQuestionAnswerCheckpoint, authoringQuestionCheckpoint, authoringTransportCheckpoint,
  configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { captureOperatorAnswer, confirmOperatorAnswer, createOperatorQuestion, presentOperatorQuestion,
  reopenOperatorQuestion, leaveOperatorQuestionPending, parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { activePolicySource, loadPolicySources, newPolicySourceSession, policySourceSavedDigest,
  policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import { makeSourceInputReview } from "./authoring-input-policy.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { reusableSourceInputConversationReview, runSourceInputConversation, type SourceInputConversationPorts } from "./authoring-input-policy-conversation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const text = "Each parcel needs a note.\nThe note length is from 1 through 64 UTF-16 units.";
const binding = { boundary_name: "controlled_input_review", generation_lock_fingerprint: canonicalJsonDigest("lock"),
  schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("role") };
const validValue = (q: OperatorQuestion) => ({ kind: "input_bounds", requirements: [{ outcomes: q.target.outcomes,
  input: "note", start: 1, end: 2, min_length: 1, max_length: 64 }] });
const proposal = (q: OperatorQuestion, value = validValue(q)) => ({ question_id: q.id, revision: q.revision,
  ...(q.source_binding ? { source_reference: canonicalJsonDigest(q.source_binding) } : { answer_id: q.raw_answer!.id }),
  status: "proposal", disposition: "proposed", value });
const information = (q: OperatorQuestion) => ({ question_id: q.id, revision: q.revision,
  source_reference: canonicalJsonDigest(q.source_binding), status: "needs_information", question: "How short or long may the note be?",
  source_passages: [{ start: 1, end: 2, identifiers: ["note"] }] });
type Reply = (q: OperatorQuestion) => unknown;

async function fixture(replies: Reply[] = [proposal], outcomes = ["work.hold"], sourceText = text) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "owned-source-input-conversation-")); roots.push(projectRoot);
  const sources = newPolicySourceSession(); sources.snapshots.push(policyTextSnapshot(Buffer.from(sourceText), "rules.txt")); sources.active = 1;
  await savePolicySources(projectRoot, sources, { expectedDigest: null });
  const source = activePolicySource(sources)!, store = canonicalJsonDigest("effective store");
  const root = createOperatorQuestion({ id: randomUUID(), revision: 1, kind: "input_bounds", assistedLocalConsumer: true,
    scope_digest: canonicalJsonDigest({ source: source.digest, store, outcomes }), context_digest: canonicalJsonDigest(sources),
    source_binding: { source_session: sources.id, source_digest: source.digest as `sha256:${string}`, store_digest: store,
      lines: source.lines, agenda_digest: canonicalJsonDigest({ source_session: sources.id, source_digest: source.digest, store_digest: store, outcomes }) },
    target: { phase: "input policy", outcomes }, material: ["No requiredness, nullability, enums, authority or other business rule changes."],
    evidence: [], continuation: "input_policy_review" });
  const base = { binding, stage: "authority_review" as const, jobIntent: "Hold a parcel with its note.", provider: "openai" as const,
    model: "controlled-model", policySourceSession: sources.id };
  let resume = buildBoundaryAuthoringResumeState({ ...base, operatorQuestions: [root] });
  await writeBoundaryAuthoringResumeState(projectRoot, resume, { expectedRevisionDigest: null });
  let index = 0, schemaDrift = false, failAck = false, failBeforeWrite = false, acknowledgementCount = 0;
  const acknowledged = new Set<string>();
  const persist = async (fields: Partial<Parameters<typeof buildBoundaryAuthoringResumeState>[0]>, permit?: ProjectAuthorityMutationPermit) => {
    const next = buildBoundaryAuthoringResumeState({ ...base, previous: resume, ...fields });
    await writeBoundaryAuthoringResumeState(projectRoot, next, { expectedRevisionDigest: resume.revision_digest, permit }); resume = next;
  };
  const readQuestions = () => ({ root: resume.operator_questions![0]!, children: resume.operator_questions!.slice(1) });
  const selected = () => [...resume.operator_questions!].sort((a, b) => b.revision - a.revision)[0]!;
  const prompt = vi.fn(async (_text: string, _options: { preserveWhitespace: true }): Promise<string | null> => "  one through 64 — 😀\t ");
  const confirm = vi.fn(async (_readback: string[], _options: { defaultValue: false }): Promise<boolean | null> => true);
  const assertCurrent: SourceInputConversationPorts["assertCurrent"] = async (_permit, recovery) => {
    const loaded = await readBoundaryAuthoringResumeState(projectRoot, binding);
    if (loaded.status !== "ready" || loaded.value.revision_digest !== resume.revision_digest) throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED");
    if (schemaDrift) throw new AskError("OPERATOR_INPUT_CONTEXT_CHANGED", "Controlled schema drift.", 409);
    if (recovery?.mode === "append_recovery") {
      expect(canonicalJsonDigest(recovery.sourceBeforeAppend)).toBe(root.context_digest);
    } else if (!recovery && await policySourceSavedDigest(projectRoot, sources.id) !== root.context_digest) throw new Error("POLICY_SOURCE_CHANGED");
    if (failBeforeWrite && selected().confirmation && !recovery) throw new Error("Controlled pre-write interruption.");
  };
  const saveQuestion: SourceInputConversationPorts["saveQuestion"] = async (next, expected, options) => {
    expect(resume.operator_questions!.find(q => q.id === next.id)!.digest).toBe(expected);
    await persist({ operatorQuestions: resume.operator_questions!.map(q => q.id === next.id ? next : q),
      ...(options.completion ? { generationRecovery: authoringTransportCheckpoint(resume.generation_recovery) } : {}) }, options.permit);
  };
  const ports: SourceInputConversationPorts = { readQuestions, assertCurrent, saveQuestion, prompt, confirm,
    createMissingQuestion: async (currentRoot, question, completion, options) => {
      expect(readQuestions().root.digest).toBe(options.expectedRootDigest);
      const h = createOwnerHandoff({ consumer: "input_policy", question, scope_digest: currentRoot.scope_digest,
        context_digest: currentRoot.context_digest, completion });
      const child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: currentRoot.revision + 1,
        handoff_id: h.id, budget_owner_id: currentRoot.id, kind: "input_bounds", scope_digest: currentRoot.scope_digest,
        context_digest: currentRoot.context_digest, target: currentRoot.target, material: currentRoot.material,
        evidence: currentRoot.evidence, continuation: "input_policy_review", naming_passages: options.sourcePassages }), question);
      await persist({ operatorQuestions: [...resume.operator_questions!, child], ownerHandoffs: [...(resume.owner_handoffs ?? []), h],
        generationRecovery: authoringQuestionCheckpoint(resume.generation_recovery, ownerHandoffCheckpoint(h)) }, options.permit);
    },
    recordRawAnswer: async (q, raw, expected, options) => {
      expect(selected().digest).toBe(expected);
      const next = captureOperatorAnswer(q, raw), h = resume.owner_handoffs!.find(h => h.id === q.handoff_id)!;
      const answered = raw.trim() ? answerOwnerHandoff(h, raw, q.context_digest) : h;
      await persist({ operatorQuestions: resume.operator_questions!.map(old => old.id === q.id ? next : old),
        ownerHandoffs: resume.owner_handoffs!.map(old => old.id === h.id ? answered : old),
        generationRecovery: raw.trim() && h.completion ? authoringQuestionAnswerCheckpoint(resume.generation_recovery, ownerHandoffCheckpoint(h),
          { digest: canonicalJsonDigest(answered), operator_messages: [raw] }) : resume.generation_recovery }, options.permit);
    },
    acknowledge: async (q, review, saved, permit) => {
      expect(await policySourceSavedDigest(projectRoot, sources.id)).toBe(canonicalJsonDigest(saved));
      expect(review.question_reference!.digest).toBe(q.digest);
      if (failAck) throw new Error("Controlled acknowledgement interruption.");
      if (!acknowledged.has(review.digest)) { await persist({}, permit); acknowledged.add(review.digest); acknowledgementCount++; }
    },
  };
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => ({ status: 200,
    body: { status: "completed", output: [{ type: "function_call", call_id: `controlled-${index}`, name: "runner__propose_operator_decision",
      arguments: JSON.stringify(replies[Math.min(index++, replies.length - 1)]!(selected())) }] } }));
  const input = { projectRoot, sources, session: { provider: "openai" as const, model: "controlled-model",
    apiKey: "inert-controlled-credential", dependencies: { requestJson } }, outcomes, store, actor: "local_installation_operator",
    ports, egressAcknowledged: true, env: {} };
  const run = async (override: Partial<Omit<typeof input, "session">> & { session?: ActionModelSuggestionSession;
    businessContext?: Parameters<typeof runSourceInputConversation>[0]["businessContext"] } = {},
    options: { checkpointTypedRefusal?: boolean } = {}) => withAuthoringGenerationRecovery(async () => {
    const configured = { ...input, ...override };
    if (typeof configured.session.dependencies?.requestJson !== "function" || "baseUrl" in configured.session) {
      throw new Error("TEST_LOCAL_DECODER_REQUIRED: No default HTTP or alternate provider route is permitted in this fixture.");
    }
    const loaded = await readBoundaryAuthoringResumeState(projectRoot, binding);
    if (loaded.status !== "ready") throw new Error("Missing real resume."); resume = loaded.value;
    configureAuthoringGenerationRecovery({ available: () => true, read: () => resume.generation_recovery,
      current: async () => { await assertCurrent(); return root.context_digest; },
      write: recovery => persist({ generationRecovery: recovery }), progress: () => {} });
    try { return await runSourceInputConversation(configured); }
    catch (error) {
      // Faithful optional public outer save: the real frame still owns these
      // known consumed turns. Never acknowledge received/uncertain responses.
      if (options.checkpointTypedRefusal && error instanceof AskError && error.code === "ASK_TOOL_ARGUMENTS_INVALID") {
        await persist({ generationRecovery: authoringTransportCheckpoint(resume.generation_recovery) });
      }
      throw error;
    }
  });
  const resumePending = (choice: "keep" | "reopen" | "replace") => {
    ports.resumePending = vi.fn(async (q, currentRoot, options) => {
      expect(options).toEqual({ defaultValue: false });
      if (choice === "keep") return choice;
      await withProjectAuthorityMutation(projectRoot, async permit => {
        await assertCurrent(permit);
        if (choice === "reopen") await saveQuestion(reopenOperatorQuestion(q), q.digest, { permit });
        else {
          const oldH = resume.owner_handoffs!.find(h => h.id === q.handoff_id)!;
          const h = oldH.state === "waiting" ? oldH : createOwnerHandoff({ consumer: "input_policy", question: q.presentation!.text,
            scope_digest: currentRoot.scope_digest, context_digest: currentRoot.context_digest });
          const child = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: selected().revision + 1,
            handoff_id: h.id, budget_owner_id: currentRoot.id, kind: "input_bounds", scope_digest: currentRoot.scope_digest,
            context_digest: currentRoot.context_digest, target: currentRoot.target, material: currentRoot.material,
            evidence: currentRoot.evidence, continuation: "input_policy_review", naming_passages: q.naming_passages }), q.presentation!.text);
          await persist({ operatorQuestions: [...resume.operator_questions!, child],
            ownerHandoffs: oldH.state === "waiting" ? resume.owner_handoffs : [...resume.owner_handoffs!, h] }, permit);
        }
      });
      return choice;
    });
  };
  return { input, run, ports, requestJson, prompt, confirm, readQuestions, selected, persist, resumePending,
    readResume: () => resume, acknowledgementCount: () => acknowledgementCount,
    schemaDrift: (v: boolean) => { schemaDrift = v; }, failAck: (v: boolean) => { failAck = v; }, failBeforeWrite: (v: boolean) => { failBeforeWrite = v; } };
}

describe("specific assisted Source Input controller, real Source/Resume CAS and controlled decoders", () => {
  it("raw-saves the original Input wording before correction without a handoff or completed result", async () => {
    const original = "Should work.parcels.status be optional and never exceed 64 characters?";
    const f = await fixture([q => ({ ...information(q), question: original })]);
    const save = vi.spyOn(f.ports, "saveQuestion"), before = f.selected();
    f.requestJson.mockImplementationOnce(async () => ({ status: 200, body: { status: "completed", output: [{
      type: "function_call", call_id: "wording-first", name: "runner__propose_operator_decision",
      arguments: JSON.stringify({ ...information(f.selected()), question: original }),
    }] } })).mockImplementationOnce(async () => {
      const saved = f.selected();
      expect(saved.wording_state?.gate.original_question).toBe(original);
      expect(saved.presentation).toBeUndefined(); expect(saved.raw_answer).toBeUndefined();
      expect(f.readResume().owner_handoffs).toBeUndefined();
      expect(saved.id).toBe(before.id); expect(saved.source_binding).toEqual(before.source_binding);
      expect(saved.budget?.correction_used).toBe(true);
      expect(save.mock.calls.some(([, , options]) => options.rawCheckpoint === true && !options.completion)).toBe(true);
      throw new AskError("ASK_CANCELLED", "Controlled interruption before the correction response.", 499);
    });
    await expect(f.run({ businessContext: { references: [{ resource: "work.parcels", field: "status", label: "parcel note", origin: "policy_term" }] } }))
      .rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(f.selected().wording_state?.gate.original_question).toBe(original);
    expect(f.prompt).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it.each([4_000, 4_002])("retains exact long Unicode input evidence or refuses before mapping at %s UTF-16 units", async units => {
    const sourceText = "Hold a parcel with its note.\nAgree the lower and upper note-length bounds and the counting unit before preparing its input contract.";
    const prefix = "  The note needs one through 64 UTF-16 units, counting spaces; emoji counts as two. ";
    const repeated = prefix + "😀e\u0301".repeat(Math.floor((4_000 - prefix.length) / 4));
    const exact = repeated.padEnd(4_000, " ");
    const raw = units === 4_000 ? exact : exact + "😀";
    expect(raw.length).toBe(units);
    const f = await fixture([information, proposal], ["work.hold"], sourceText);
    f.prompt.mockResolvedValueOnce(raw); f.confirm.mockResolvedValueOnce(false);
    if (units === 4_002) {
      await expect(f.run()).rejects.toThrow("Invalid trusted answer reference");
      expect(f.selected().raw_answer).toBeUndefined();
      expect(f.selected().proposal).toBeUndefined();
      expect(f.selected().confirmation).toBeUndefined();
      expect(f.readResume().owner_handoffs![0]!.state).toBe("waiting");
      expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.confirm).not.toHaveBeenCalled();
    } else {
      expect((await f.run()).state).toBe("pending");
      const saved = structuredClone(f.selected());
      expect(saved.raw_answer!.text).toBe(raw);
      expect(saved.proposal!.answer_id).toBe(saved.raw_answer!.id);
      expect(saved.confirmation).toBeUndefined(); expect(saved.disposition).toBe("declined");
      expect(JSON.stringify(f.requestJson.mock.calls[1]![0].body)).toContain(raw);
      expect(f.confirm.mock.calls[0]![1]).toEqual({ defaultValue: false });
      expect((await f.run()).state).toBe("pending");
      expect(f.selected()).toEqual(saved);
      expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.confirm).toHaveBeenCalledOnce();
    }
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
    expect(f.readQuestions().root.budget).toEqual({ iterations_used: units === 4_000 ? 2 : 1,
      tool_calls_used: units === 4_000 ? 2 : 1, correction_used: false });
  });
  it("keeps a partial compound answer pending, rejects a wrong-phase interpretation, then saves only an explicitly confirmed scoped replacement", async () => {
    const sourceText = "There are two Actions: mark a parcel ready and set its priority.\nOnly setting priority requires priority_note. Its lower and upper text-length bounds must be agreed with the operator before review.";
    const question = "What are the lower and upper text-length bounds for the priority note, and which unit counts its length?";
    const partialRaw = "The upper bound is seven UTF-16 units.";
    const completeRaw = "Empty text is allowed. Seven UTF-16 units is the maximum, including spaces; emoji counts as two units.";
    const scoped = (q: OperatorQuestion) => proposal(q, { kind: "input_bounds", requirements: [{
      outcomes: ["parcel.set_priority"], input: "priority_note", start: 2, end: 2, min_length: 0, max_length: 7 }] });
    const f = await fixture([
      q => ({ ...information(q), question, source_passages: [{ start: 2, end: 2, identifiers: ["priority_note"] }] }),
      q => ({ ...proposal(q), disposition: "pending", value: undefined }),
      q => ({ ...proposal(q), value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }),
      scoped, scoped,
    ], ["parcel.mark_ready", "parcel.set_priority"], sourceText);
    f.prompt.mockResolvedValueOnce(partialRaw).mockResolvedValue(completeRaw);
    f.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);

    expect((await f.run()).state).toBe("pending");
    const partial = structuredClone(f.selected()), partialHandoff = structuredClone(f.readResume().owner_handoffs![0]!);
    expect(partial.raw_answer!.text).toBe(partialRaw); expect(partial.presentation!.text).toBe(question);
    expect(partial.proposal).toMatchObject({ disposition: "pending" }); expect(partial.proposal!.value).toBeUndefined();
    expect(partial.confirmation).toBeUndefined(); expect(f.confirm).not.toHaveBeenCalled();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
    expect(f.readQuestions().root.budget).toEqual({ iterations_used: 2, tool_calls_used: 2, correction_used: false });
    expect((await f.run()).state).toBe("pending"); expect(f.requestJson).toHaveBeenCalledTimes(2);

    f.resumePending("replace");
    expect((await f.run()).state).toBe("pending");
    const declined = structuredClone(f.selected()), declinedHandoff = structuredClone(f.readResume().owner_handoffs![1]!);
    expect(declined.raw_answer!.text).toBe(completeRaw); expect(declined.disposition).toBe("declined");
    expect(declined.confirmation).toBeUndefined(); expect(f.requestJson).toHaveBeenCalledTimes(4);
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.confirm.mock.calls[0]![1]).toEqual({ defaultValue: false });
    const readback = f.confirm.mock.calls[0]![0].join("\n");
    expect(readback).toContain("priority_note"); expect(readback).toContain("parcel.set_priority");
    expect(readback).toContain("0"); expect(readback).toContain("7"); expect(readback).toContain("UTF-16");
    expect(readback).not.toContain("all_writers_increment");
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
    expect(f.readQuestions().root.budget).toEqual({ iterations_used: 4, tool_calls_used: 4, correction_used: true });

    f.resumePending("replace");
    const savedResult = await f.run(); expect(savedResult.state).toBe("saved");
    expect(f.selected().confirmation).toBeDefined(); expect(f.selected().raw_answer!.text).toBe(completeRaw);
    const saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    expect(saved.input_policy_reviews).toHaveLength(1);
    expect(saved.input_policy_reviews![0]!.requirements).toEqual([{
      outcomes: ["parcel.set_priority"], input: "priority_note", start: 2, end: 2, min_length: 0, max_length: 7,
    }]);
    expect(f.readQuestions().children.find(q => q.id === partial.id)).toEqual(partial);
    expect(f.readQuestions().children.find(q => q.id === declined.id)).toEqual(declined);
    expect(f.readResume().owner_handoffs![0]).toEqual(partialHandoff);
    expect(f.readResume().owner_handoffs![1]).toEqual(declinedHandoff);
    expect(f.readQuestions().root.budget).toEqual({ iterations_used: 5, tool_calls_used: 5, correction_used: true });
    expect(f.readResume().authority_granted).toBe(false); expect(f.readResume().source_database_changed).toBe(false);
    expect((await f.run({ sources: saved })).state).toBe("reused");
    expect(f.requestJson).toHaveBeenCalledTimes(5); expect(f.confirm).toHaveBeenCalledTimes(2);
  });
  it("saves Source-derived interpretation only after authoritative default-No readback, then reuses without a call", async () => {
    const f = await fixture();
    const first = await f.run(); expect(first.state).toBe("saved");
    expect(f.confirm.mock.calls[0]![1]).toEqual({ defaultValue: false }); expect(f.prompt).not.toHaveBeenCalled();
    expect(f.selected().confirmation).toBeDefined(); expect(f.requestJson).toHaveBeenCalledOnce();
    const saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    expect(saved.input_policy_reviews).toHaveLength(1); expect(saved.input_policy_reviews![0]!.question_reference!.basis).toBe("policy_source");
    expect((await f.run({ sources: saved })).state).toBe("reused");
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce(); expect(f.acknowledgementCount()).toBe(1);
  });
  it.each(["policy_source", "operator_answer"] as const)("saved Review reuses the exact confirmed %s without changing Source, Resume or acknowledgement", async basis => {
    const f = await fixture(basis === "policy_source" ? [proposal] : [information, proposal], ["work.hold", "work.priority"]);
    await f.run();
    const sources = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const beforeSources = structuredClone(sources), beforeResume = structuredClone(f.readResume());
    const acknowledgementCount = f.acknowledgementCount(), calls = f.requestJson.mock.calls.length;
    const review = reusableSourceInputConversationReview({ sources, questions: f.readQuestions(),
      outcomes: f.input.outcomes, store: f.input.store, actor: f.input.actor });
    expect(review).toEqual(sources.input_policy_reviews![0]);
    expect(review!.question_reference!.basis).toBe(basis);
    expect(sources).toEqual(beforeSources); expect(f.readResume()).toEqual(beforeResume);
    expect(await loadPolicySources(f.input.projectRoot, f.input.sources.id)).toEqual(beforeSources);
    expect((await readBoundaryAuthoringResumeState(f.input.projectRoot, binding)).status).toBe("ready");
    expect(f.requestJson).toHaveBeenCalledTimes(calls); expect(f.acknowledgementCount()).toBe(acknowledgementCount);
  });
  it.each(["source", "store", "inventory", "actor", "answer-reference", "newer-peer-review"] as const)("saved Review refuses reuse after %s changes without writing or generating", async change => {
    const f = await fixture([information, proposal], ["work.hold", "work.priority"]);
    await f.run();
    const sources = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const beforeSources = structuredClone(sources), beforeResume = structuredClone(f.readResume());
    const candidate = structuredClone(sources);
    const input = { sources: candidate, questions: f.readQuestions(), outcomes: f.input.outcomes,
      store: f.input.store, actor: f.input.actor };
    if (change === "source") {
      candidate.snapshots.push(policyTextSnapshot(Buffer.from("The note rule has changed."), "changed.txt"));
      candidate.active = candidate.snapshots.length;
    } else if (change === "store") input.store = canonicalJsonDigest("different effective store");
    else if (change === "inventory") input.outcomes = ["work.hold"];
    else if (change === "actor") input.actor = "different_local_operator";
    else if (change === "answer-reference") candidate.input_policy_reviews![0]!.question_reference!.answer_id = randomUUID();
    else candidate.input_policy_reviews!.push(makeSourceInputReview({ source: activePolicySource(candidate)!,
      session: candidate, store: f.input.store, outcomes: ["work.priority"], requirements: [],
      actor: f.input.actor, decision: "deferred" }));
    expect(() => reusableSourceInputConversationReview(input)).toThrow(expect.objectContaining({ code: "OPERATOR_INPUT_CONTEXT_CHANGED" }));
    expect(await loadPolicySources(f.input.projectRoot, f.input.sources.id)).toEqual(beforeSources);
    expect(f.readResume()).toEqual(beforeResume); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(f.acknowledgementCount()).toBe(1);
  });
  it.each([false, null])("saved Review cannot adopt an unconfirmed interpretation after confirmation %s", async decision => {
    const f = await fixture(); f.confirm.mockResolvedValueOnce(decision);
    await f.run();
    const sources = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const before = structuredClone(f.readResume());
    expect(reusableSourceInputConversationReview({ sources, questions: f.readQuestions(),
      outcomes: f.input.outcomes, store: f.input.store, actor: f.input.actor })).toBeUndefined();
    expect(sources.input_policy_reviews).toBeUndefined(); expect(f.readResume()).toEqual(before);
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.acknowledgementCount()).toBe(0);
  });
  it("creates a real B33 child, captures exact raw first, and shares the root pool across both model stages", async () => {
    const f = await fixture([information, proposal]); const result = await f.run();
    expect(result.state).toBe("saved"); expect(f.prompt.mock.calls[0]![1]).toEqual({ preserveWhitespace: true });
    const q = f.selected(), root = f.readQuestions().root;
    expect(q.raw_answer!.text).toBe("  one through 64 — 😀\t "); expect(q.confirmation).toBeDefined();
    expect(q.budget_owner_id).toBe(root.id); expect(q.budget).toBeUndefined();
    expect(root.budget).toEqual({ iterations_used: 2, tool_calls_used: 2, correction_used: false });
    expect(f.readResume().owner_handoffs![0]!).toMatchObject({ state: "answered", answer: q.raw_answer!.text });
    expect(f.readResume().generation_recovery!.operations[0]!.question_handoff!.answered!.answer).toBe(q.raw_answer!.text);
    if (result.state !== "pending") expect(result.review.question_reference!.answer_id).toBe(q.raw_answer!.id);
    expect(f.readResume().authority_granted).toBe(false); expect(f.readResume().source_database_changed).toBe(false);
  });
  it.each(["no", "eof"])("keeps proposed interpretation unadopted when readback confirmation is %s", async decision => {
    const f = await fixture(); f.confirm.mockResolvedValue(decision === "no" ? false : null);
    expect((await f.run()).state).toBe("pending"); expect(f.selected().confirmation).toBeUndefined();
    expect(f.selected().disposition).toBe(decision === "no" ? "declined" : "cancelled");
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
    expect((await f.run()).state).toBe("pending"); expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce();
  });
  it("EOF before answer retains the real saved question; explicit Resume reopens it without source-stage replay", async () => {
    const f = await fixture([information, proposal]); f.prompt.mockResolvedValueOnce(null);
    expect((await f.run()).state).toBe("pending"); const old = f.selected();
    expect(old.raw_answer).toBeUndefined(); expect(f.readResume().owner_handoffs![0]!.state).toBe("waiting");
    f.resumePending("reopen"); expect((await f.run()).state).toBe("saved");
    expect(f.selected().id).toBe(old.id); expect(f.selected().disposition_history).toEqual(old.disposition_history);
    expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.readResume().owner_handoffs).toHaveLength(1);
  });
  it("blank raw is retained; explicit new child reuses still-waiting handoff without fabricated completion or renewed budget", async () => {
    const f = await fixture([information, proposal]); f.prompt.mockResolvedValueOnce(" \t ");
    expect((await f.run()).state).toBe("pending"); const old = f.selected();
    expect(old.raw_answer!.text).toBe(" \t "); expect(old.disposition).toBe("unknown");
    expect(f.readResume().owner_handoffs![0]!.state).toBe("waiting"); expect(f.requestJson).toHaveBeenCalledOnce();
    f.resumePending("replace"); expect((await f.run()).state).toBe("saved");
    expect(f.selected().id).not.toBe(old.id); expect(f.selected().handoff_id).toBe(old.handoff_id);
    expect(f.readQuestions().children.find(q => q.id === old.id)).toEqual(old);
    expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.readResume().owner_handoffs).toHaveLength(1);
    expect(f.readQuestions().root.budget!.iterations_used).toBe(2);
  });
  it("explicit replacement after answered/declined raw creates a local handoff and retains old answer/completion", async () => {
    const f = await fixture([information, proposal]); f.confirm.mockResolvedValueOnce(false);
    expect((await f.run()).state).toBe("pending"); const old = f.selected(), oldH = structuredClone(f.readResume().owner_handoffs![0]!);
    f.resumePending("replace"); expect((await f.run()).state).toBe("saved");
    expect(f.readQuestions().children.find(q => q.id === old.id)).toEqual(old);
    expect(f.readResume().owner_handoffs![0]!).toEqual(oldH); expect(f.readResume().owner_handoffs![1]!.completion).toBeUndefined();
    expect(f.requestJson).toHaveBeenCalledTimes(3); expect(f.readQuestions().root.budget!.iterations_used).toBe(3);
  });
  it("real domain failure gets one consumed correction and shares saved root counts", async () => {
    const f = await fixture([q => proposal(q, { ...validValue(q), requirements: [{ ...validValue(q).requirements[0]!, input: "constructor" }] }), proposal]);
    expect((await f.run()).state).toBe("saved"); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(f.readQuestions().root.budget).toEqual({ iterations_used: 2, tool_calls_used: 2, correction_used: true });
    expect(f.readResume().generation_recovery!.operations.every(op => op.state === "checkpointed")).toBe(true);
  });
  it.each(["source-root", "child-answer-map"] as const)("does not resend an unchanged terminal typed-invalid %s episode after real disk reload", async stage => {
    const bad: Reply = q => proposal(q, { ...validValue(q),
      requirements: [{ ...validValue(q).requirements[0]!, input: "constructor" }] });
    const f = await fixture(stage === "source-root" ? [bad, bad] : [information, bad, bad]);
    await expect(f.run({}, { checkpointTypedRefusal: true })).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    const loaded = await readBoundaryAuthoringResumeState(f.input.projectRoot, binding);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("Missing saved terminal episode.");
    const before = structuredClone(loaded.value), originalCalls = f.requestJson.mock.calls.length;
    const beforeSource = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    expect(before.operator_questions![0]!.budget).toEqual({ iterations_used: originalCalls,
      tool_calls_used: originalCalls, correction_used: true });
    expect(before.operator_questions!.at(-1)!.proposal).toBeUndefined();
    expect(before.operator_questions!.at(-1)!.confirmation).toBeUndefined();
    expect(before.generation_recovery!.operations.every(op => op.state === "checkpointed")).toBe(true);
    if (stage === "child-answer-map") {
      expect(before.operator_questions!.at(-1)!.raw_answer!.text).toBe("  one through 64 — 😀\t ");
      expect(before.owner_handoffs![0]!.state).toBe("answered");
    }

    // f.run loads the same disk Resume again. There is no new operator answer,
    // replacement choice, changed Source or fresh question episode here.
    const reentry = await f.run({}, { checkpointTypedRefusal: true }).then(result => ({ state: result.state }),
      error => ({ code: error instanceof AskError ? error.code : String(error) }));
    const after = await readBoundaryAuthoringResumeState(f.input.projectRoot, binding);
    expect(after.status).toBe("ready");
    if (after.status !== "ready") throw new Error("Missing reloaded terminal episode.");
    const afterSource = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    console.info("OWNED unchanged terminal Input reentry", JSON.stringify({ stage, originalCalls,
      afterCalls: f.requestJson.mock.calls.length, reentry,
      before: { questions: before.operator_questions, handoffs: before.owner_handoffs,
        generations: before.generation_recovery },
      after: { questions: after.value.operator_questions, handoffs: after.value.owner_handoffs,
        generations: after.value.generation_recovery } }));
    expect(afterSource).toEqual(beforeSource); expect(afterSource.input_policy_reviews).toBeUndefined();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.prompt).toHaveBeenCalledTimes(stage === "source-root" ? 0 : 1);
    expect(after.value.owner_handoffs).toEqual(before.owner_handoffs);
    expect(after.value.generation_recovery!.operations.slice(0, before.generation_recovery!.operations.length))
      .toEqual(before.generation_recovery!.operations);
    expect(f.requestJson).toHaveBeenCalledTimes(originalCalls);
    expect(after.value.operator_questions).toEqual(before.operator_questions);
    expect(after.value.generation_recovery).toEqual(before.generation_recovery);
  });
  it("retains an immutable terminal Input refusal and refuses direct adoption or erasure", async () => {
    const bad: Reply = q => proposal(q, { ...validValue(q), requirements: [{ ...validValue(q).requirements[0]!, input: "constructor" }] });
    const f = await fixture([bad, bad]);
    await expect(f.run({}, { checkpointTypedRefusal: true })).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
    const stopped = f.selected(), before = structuredClone(f.readResume());
    expect(stopped.terminal_failure).toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID", stage: "source-review" });
    expect(() => confirmOperatorAnswer(stopped)).toThrow(/stopped/);
    expect(() => reopenOperatorQuestion(stopped)).toThrow(/stopped/);
    expect(() => leaveOperatorQuestionPending(stopped, "unknown")).toThrow(/stopped/);
    const erased = structuredClone(stopped); delete erased.terminal_failure;
    const { digest: _, ...body } = erased; erased.digest = canonicalJsonDigest(body);
    await expect(f.ports.saveQuestion(erased, stopped.digest, {})).rejects.toThrow(/changed outside/);
    expect(f.readResume()).toEqual(before);
    const altered = structuredClone(stopped); altered.terminal_failure!.completion.request_digest = canonicalJsonDigest("different request");
    const { digest: __, ...alteredBody } = altered; altered.digest = canonicalJsonDigest(alteredBody);
    expect(() => parseOperatorQuestion(altered)).not.toThrow(); // An envelope digest is not a generation association.
    await expect(f.ports.saveQuestion(altered, stopped.digest, {})).rejects.toThrow(/consumed generation/);
    expect(f.readResume()).toEqual(before); expect(f.requestJson).toHaveBeenCalledTimes(2);
  });
  it("does not infer a consumed terminal result from an injected matching transport error code", async () => {
    const f = await fixture();
    f.requestJson.mockRejectedValue(new AskError("ASK_TOOL_ARGUMENTS_INVALID", "Unclassified controlled delivery failure.", 422));
    await expect(f.run({}, { checkpointTypedRefusal: true })).rejects.toThrow();
    expect(f.selected().terminal_failure).toBeUndefined(); expect(f.selected().confirmation).toBeUndefined();
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.requestJson).toHaveBeenCalledOnce();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it("failed terminal persistence retains the ordinary unfinished-result fence on restart", async () => {
    const bad: Reply = q => proposal(q, { ...validValue(q), requirements: [{ ...validValue(q).requirements[0]!, input: "constructor" }] });
    const f = await fixture([bad, bad]), originalSave = f.ports.saveQuestion;
    f.ports.saveQuestion = async (next, expected, options) => {
      if (next.terminal_failure) throw new Error("Controlled terminal save failure.");
      await originalSave(next, expected, options);
    };
    await expect(f.run({}, { checkpointTypedRefusal: true })).rejects.toThrow("Controlled terminal save failure.");
    expect(f.selected().terminal_failure).toBeUndefined(); expect(f.selected().confirmation).toBeUndefined();
    expect(f.readResume().generation_recovery!.operations.every(op => op.state === "handled")).toBe(true);
    await expect(f.run()).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
    expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.confirm).not.toHaveBeenCalled();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it("genuine unknown stays pending without repeating generation or silently inventing bounds", async () => {
    const f = await fixture([information, q => ({ ...proposal(q), disposition: "pending", value: undefined })]); f.prompt.mockResolvedValue("I don't know");
    expect((await f.run()).state).toBe("pending"); expect(f.selected().proposal?.value).toBeUndefined();
    expect((await f.run()).state).toBe("pending"); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it("Source-only pending without a missing-business question remains honest pending, with no invented handoff", async () => {
    const f = await fixture([q => ({ ...proposal(q), disposition: "pending", value: undefined })]);
    expect((await f.run()).state).toBe("pending"); expect(f.readResume().owner_handoffs).toBeUndefined();
    expect(f.selected().raw_answer).toBeUndefined(); expect(f.selected().proposal?.value).toBeUndefined();
    expect((await f.run()).state).toBe("pending"); expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("explicit raw replacements cannot reset the root six-iteration allowance on restart", async () => {
    const f = await fixture([information, q => ({ ...proposal(q), disposition: "pending", value: undefined })]);
    f.prompt.mockResolvedValue("I still don't know"); await f.run(); f.resumePending("replace");
    for (let n = 0; n < 4; n++) expect((await f.run()).state).toBe("pending");
    expect(f.readQuestions().root.budget!.iterations_used).toBe(6); expect(f.requestJson).toHaveBeenCalledTimes(6);
    await expect(f.run()).rejects.toMatchObject({ code: "ASK_TOOL_BUDGET_EXCEEDED" });
    expect(f.requestJson).toHaveBeenCalledTimes(6); expect(f.readQuestions().root.budget!.iterations_used).toBe(6);
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it("the test fixture itself rejects absent local decoder rather than falling back to HTTP", async () => {
    const f = await fixture();
    await expect(f.run({ session: { provider: "openai", model: "controlled-model", apiKey: "inert-controlled-credential", dependencies: undefined } })).rejects.toThrow("TEST_LOCAL_DECODER_REQUIRED");
    expect(f.requestJson).not.toHaveBeenCalled(); expect(f.readQuestions().root.budget!.iterations_used).toBe(0);
  });
  it("Source drift before admission refuses with no controlled request", async () => {
    const f = await fixture(), changed = structuredClone(f.input.sources); changed.operator_messages = ["An explicitly recorded different policy context."];
    await savePolicySources(f.input.projectRoot, changed, { expectedDigest: canonicalJsonDigest(f.input.sources) });
    await expect(f.run()).rejects.toThrow(); expect(f.requestJson).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
  });
  it("currentness after response refuses before proposal/readback/adoption", async () => {
    const f = await fixture(), original = f.requestJson.getMockImplementation()!;
    f.requestJson.mockImplementation(async request => { const reply = await original(request); f.schemaDrift(true); return reply; });
    await expect(f.run()).rejects.toThrow(); expect(f.selected().proposal).toBeUndefined(); expect(f.confirm).not.toHaveBeenCalled();
    expect(f.requestJson).toHaveBeenCalledOnce(); expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
  it("confirmed question without a Source record finishes same write locally after a safe pre-write interruption", async () => {
    const f = await fixture(); f.failBeforeWrite(true);
    await expect(f.run()).rejects.toThrow("Controlled pre-write interruption"); expect(f.selected().confirmation).toBeDefined();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
    f.failBeforeWrite(false); expect((await f.run()).state).toBe("saved");
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce();
  });
  it("saved exact last append with missing ack reuses immutable record, timestamps and hashes", async () => {
    const f = await fixture(); f.failAck(true);
    await expect(f.run()).rejects.toThrow("Controlled acknowledgement interruption");
    const saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id), first = structuredClone(saved.input_policy_reviews![0]!);
    f.failAck(false); expect((await f.run()).state).toBe("reused");
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toEqual([first]);
    expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce(); expect(f.acknowledgementCount()).toBe(1);
  });
  it("unrelated saved decisions do not invalidate completed review; newer applicable deferred record does", async () => {
    const f = await fixture(); expect((await f.run()).state).toBe("saved");
    let saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const unrelated = makeSourceInputReview({ source: activePolicySource(saved)!, session: saved, store: f.input.store,
      outcomes: ["work.other"], requirements: [], actor: f.input.actor });
    const next = structuredClone(saved); next.input_policy_reviews!.push(unrelated); next.operator_messages = ["Unrelated current-context record."];
    await savePolicySources(f.input.projectRoot, next, { expectedDigest: canonicalJsonDigest(saved) });
    expect((await f.run({ sources: next })).state).toBe("reused"); expect(f.requestJson).toHaveBeenCalledOnce();
    saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const conflicting = makeSourceInputReview({ source: activePolicySource(saved)!, session: saved, store: f.input.store,
      outcomes: f.input.outcomes, requirements: [], actor: f.input.actor, decision: "deferred" });
    const changed = structuredClone(saved); changed.input_policy_reviews!.push(conflicting);
    await savePolicySources(f.input.projectRoot, changed, { expectedDigest: canonicalJsonDigest(saved) });
    await expect(f.run({ sources: changed })).rejects.toMatchObject({ code: "OPERATOR_INPUT_CONTEXT_CHANGED" });
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("last applicable history must hold for every covered outcome, not just the first", async () => {
    const f = await fixture([proposal], ["work.hold", "work.priority"]); await f.run();
    const saved = await loadPolicySources(f.input.projectRoot, f.input.sources.id);
    const later = makeSourceInputReview({ source: activePolicySource(saved)!, session: saved, store: f.input.store,
      outcomes: ["work.priority"], requirements: [], actor: f.input.actor, decision: "deferred" });
    const next = structuredClone(saved); next.input_policy_reviews!.push(later);
    await savePolicySources(f.input.projectRoot, next, { expectedDigest: canonicalJsonDigest(saved) });
    await expect(f.run({ sources: next })).rejects.toMatchObject({ code: "OPERATOR_INPUT_CONTEXT_CHANGED" });
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("competing confirmation cannot be silently rebased by the paused readback", async () => {
    const f = await fixture();
    f.confirm.mockImplementation(async () => { const q = f.selected(); await f.ports.saveQuestion(confirmOperatorAnswer(q), q.digest, {}); return true; });
    await expect(f.run()).rejects.toMatchObject({ code: "OPERATOR_INPUT_CONTEXT_CHANGED" });
    expect(f.selected().confirmation).toBeDefined(); expect(f.requestJson).toHaveBeenCalledOnce();
    expect((await loadPolicySources(f.input.projectRoot, f.input.sources.id)).input_policy_reviews).toBeUndefined();
  });
});
