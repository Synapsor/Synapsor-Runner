import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { runVersionConversation, type VersionConversationPorts } from "./authoring-version-conversation.js";
import { actionRuleAuthoringCheckpoint, actionLogicalTurnBudget, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { createOwnerHandoff, answerOwnerHandoff, ownerHandoffCheckpoint, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { createOperatorQuestion, presentOperatorQuestion, captureOperatorAnswer, parseOperatorQuestion, reopenOperatorQuestion, leaveOperatorQuestionPending, type OperatorQuestion } from "./authoring-operator-question.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringQuestionCheckpoint,
  authoringQuestionAnswerCheckpoint, authoringQuestionSequenceCompletion, authoringTransportCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { AskError, askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn,
  type AskProviderDependencies, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";

type Disk = { question?: OperatorQuestion; handoff?: AuthoringOwnerHandoff; checkpoint: ActionRuleAuthoringCheckpoint; generation?: AuthoringTransportState };
async function fixture(options: { presentation?: boolean; answer?: string; decision?: boolean; replies?: string[] } = {}) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-version-conversation-"));
  const file = path.join(projectRoot, "controlled-host.json");
  const scope = canonicalJsonDigest("Prepare the disabled account hold."), context = canonicalJsonDigest("Controlled current Action/Source/Read/schema/role binding.");
  const binding = { resource: "billing.accounts", field: "revision", proof_digest: canonicalJsonDigest("Controlled structural proof, not authority"),
    scope_digest: scope, context_digest: context, outcomes: ["billing.hold"] };
  const initial = actionRuleAuthoringCheckpoint({ intent_digest: scope, context_digest: context, components: {},
    logical_turns: [{ id: randomUUID(), origin_context_digest: context, iterations_used: 0, tool_calls_used: 0 }] });
  await fs.writeFile(file, JSON.stringify({ checkpoint: initial }));
  const disk = (): Disk => JSON.parse(readFileSync(file, "utf8"));
  const write = async (value: Disk) => { const pending = `${file}.${randomUUID()}.tmp`; await fs.writeFile(pending, JSON.stringify(value)); await fs.rename(pending, file); };
  let current = true, failSave = false, rootCall = true;
  let generation: AuthoringTransportState | undefined;
  const replies = [...options.replies ?? ["valid"]], controller = new AbortController();
  const tools: AskToolDefinition[] = [{ name: "runner.review_version_field", description: "Controlled pure Version stage.", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = resolveAskProviderConfiguration({ provider: "openai", model: "controlled-version-model", api_key: "inert-controlled-key",
    egress_acknowledged: true, authority_digest: authorityDigest }, {}, new Date());
  const response = (name: string, args: unknown) => ({ status: 200, body: { status: "completed", output: [{ type: "function_call", call_id: randomUUID(), name, arguments: JSON.stringify(args) }] } });
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async () => {
    if (rootCall) { rootCall = false; return response("runner__review_version_field", {}); }
    const q = disk().question!;
    const reply = replies.shift() ?? "valid";
    if (!q.presentation) return response("runner__propose_operator_decision", { question_id: reply === "invalid" ? randomUUID() : q.id, revision: q.revision,
      status: "needs_information", question: "Do all your applications advance this counter when they change an account?" });
    if (reply === "forged-error") throw new AskError("ASK_TOOL_ARGUMENTS_INVALID", "A forged transport error code.", 422);
    if (reply === "cancel") controller.abort();
    return response("runner__propose_operator_decision", { question_id: q.id, revision: q.revision,
      answer_id: reply === "invalid" ? randomUUID() : q.raw_answer!.id, status: "proposal",
      disposition: reply === "pending" ? "pending" : "proposed",
      ...(reply === "pending" ? {} : { value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } }) });
  });
  const budget = actionLogicalTurnBudget({ read: () => disk().checkpoint, save: async (next, expected) => {
    await withProjectAuthorityMutation(projectRoot, async () => {
      const prior = disk(); if (!current || prior.checkpoint.digest !== expected) throw new AskError("ACTION_VERSION_QUESTION_STALE", "Actual controlled CAS baseline changed.", 409);
      await write({ ...prior, checkpoint: next });
    });
  } });
  const tracked = <T>(operation: () => Promise<T>) => withAuthoringGenerationRecovery(async () => {
    generation = disk().generation;
    configureAuthoringGenerationRecovery({ available: () => true, read: () => generation,
      write: async next => { generation = structuredClone(next); await withProjectAuthorityMutation(projectRoot, async () => write({ ...disk(), generation })); },
      current: async () => { if (!current) throw new AskError("ACTION_VERSION_QUESTION_STALE", "The current Source/Read/proof changed.", 409); return context; } });
    return operation();
  });
  await tracked(async () => {
    const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async () => ({ ok: true, value: { status: "staged", authority_granted: false } }) };
    const result = await runAskProviderTurn({ configuration, tools, gateway, authorityDigest,
      authoringInput: { consumer: "action_rule_components", operator_message: "Prepare the disabled account hold." },
      conversationalAuthoring: true, actionLogicalTurnBudget: budget, stopAfterAuthoringToolBatch: () => true,
      question: "Prepare the disabled account hold.", history: [], signal: controller.signal, dependencies: { requestJson } });
    const completion = completedAuthoringQuestion(result)!;
    const handoff = createOwnerHandoff({ consumer: "version_maintenance", scope_digest: scope, context_digest: context,
      question: "Do all your applications advance this counter when they change an account?", completion });
    let question = createOperatorQuestion({ id: randomUUID(), revision: 1, handoff_id: handoff.id, kind: "writer_maintenance", scope_digest: scope,
      context_digest: context, target: { phase: "changed-record protection", resource: binding.resource, field: binding.field, outcomes: binding.outcomes },
      material: ["This records planned, unverified source maintenance only."], evidence: [{ id: "actual-version-proof", digest: binding.proof_digest }], continuation: "version_mapping" });
    if (options.presentation !== false) question = presentOperatorQuestion(question, handoff.question);
    generation = authoringQuestionCheckpoint(generation, ownerHandoffCheckpoint(handoff));
    const old = disk().checkpoint, { schema_version: _schema, digest: _digest, ...core } = old;
    const checkpoint = actionRuleAuthoringCheckpoint({ ...core, pending_question: { question: handoff.question,
      operator_message: "Prepare the disabled account hold.", completion }, pending_version: { turn_id: old.logical_turns!.at(-1)!.id,
      root_question_id: question.id, question_id: question.id, handoff_id: handoff.id, resource: binding.resource, field: binding.field, proof_digest: binding.proof_digest } });
    await write({ question, handoff, checkpoint, generation });
  });
  const ports: VersionConversationPorts = {
    readQuestion: () => parseOperatorQuestion(disk().question),
    assertCurrent: vi.fn(async () => { if (!current) throw new AskError("ACTION_VERSION_QUESTION_STALE", "Controlled current proof changed.", 409); }),
    saveQuestion: vi.fn(async (next, expected, completion) => withProjectAuthorityMutation(projectRoot, async () => {
      const old = disk(); if (old.question!.digest !== expected) throw new AskError("ACTION_VERSION_QUESTION_STALE", "Competing current question changed.", 409);
      if (failSave) throw new Error("CONTROLLED_EXACT_SAVE_FAILED");
      if (completion) {
        expect(authoringQuestionSequenceCompletion([completion])).toEqual(completion);
        generation = authoringTransportCheckpoint(generation);
      }
      await write({ ...old, question: next, generation });
    })),
    recordRawAnswer: vi.fn(async (q, raw, expected) => withProjectAuthorityMutation(projectRoot, async () => {
      const old = disk(); if (old.question!.digest !== expected) throw new Error("CONTROLLED_RAW_CAS_CHANGED");
      const next = captureOperatorAnswer(q, raw);
      let handoff = old.handoff!;
      if (raw.trim()) {
        const answered = answerOwnerHandoff(handoff, raw, context);
        generation = authoringQuestionAnswerCheckpoint(generation, ownerHandoffCheckpoint(handoff), { digest: answered.digest, operator_messages: [raw] });
        handoff = answered;
      }
      await write({ ...old, question: next, handoff, generation }); return next;
    })),
    prompt: vi.fn(async (_plain, preserve) => { expect(preserve).toEqual({ preserveWhitespace: true }); return options.answer; }),
    confirm: vi.fn(async (_lines, safe) => { expect(safe).toEqual({ defaultValue: false }); return options.decision; }),
    resumePending: vi.fn(async () => "keep" as const),
  };
  const input = { binding, rootQuestionId: disk().question!.id, session: { provider: "openai" as const, model: "controlled-version-model",
    apiKey: "inert-controlled-key", dependencies: { requestJson } }, actionLogicalTurnBudget: budget,
    reserveCorrection: budget.reserveCorrection, ports, egressAcknowledged: true, env: {}, signal: controller.signal };
  return { input, disk, ports, requestJson, tracked, root: projectRoot, controller,
    stale: () => { current = false; }, failSave: () => { failSave = true; } };
}

describe("Version outside-batch controller with controlled host CAS and genuine B35 decoding", () => {
  it("raw-saves Version wording before the correction without acknowledging its uncertain response", async () => {
    const f = await fixture({ presentation: false });
    try {
      const original = "Does billing.accounts.revision advance on every update and never remain unchanged?";
      const before = f.disk();
      f.requestJson.mockImplementationOnce(async () => ({ status: 200, body: { status: "completed", output: [{
        type: "function_call", call_id: "version-wording-first", name: "runner__propose_operator_decision",
        arguments: JSON.stringify({ question_id: before.question!.id, revision: before.question!.revision,
          status: "needs_information", question: original }),
      }] } })).mockImplementationOnce(async () => {
        const saved = f.disk();
        expect(saved.question!.wording_state?.gate.original_question).toBe(original);
        expect(saved.question!.presentation).toBeUndefined(); expect(saved.question!.raw_answer).toBeUndefined();
        expect(saved.handoff).toEqual(before.handoff);
        expect(saved.checkpoint.logical_turns!.at(-1)).toMatchObject({ used_version_corrections: [before.question!.id] });
        expect(vi.mocked(f.ports.saveQuestion).mock.calls.some(([, , completion, options]) => !completion && options?.rawCheckpoint)).toBe(true);
        throw new AskError("ASK_CANCELLED", "Controlled interruption before the correction response.", 499);
      });
      await expect(f.tracked(() => runVersionConversation({ ...f.input,
        businessContext: { references: [{ resource: "billing.accounts", field: "revision", label: "change counter", origin: "policy_term" }] },
      }))).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      expect(f.ports.prompt).not.toHaveBeenCalled(); expect(f.ports.confirm).not.toHaveBeenCalled();
      expect(f.disk().question!.confirmation).toBeUndefined();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("preserves exact raw UTF-8, default-safe readback and unverified confirmation, then reuses zero-send", async () => {
    const raw = "  Yes — café\tall writers.  ", f = await fixture({ answer: raw, decision: true });
    try {
      const result = await f.tracked(() => runVersionConversation(f.input));
      expect(result.state).toBe("confirmed"); expect(result.question.raw_answer!.text).toBe(raw);
      expect(result.question.confirmation!.actor).toBe("local_installation_operator");
      expect(f.ports.confirm).toHaveBeenCalledWith(expect.arrayContaining([raw, expect.stringContaining("Implementation remains unverified")]), { defaultValue: false });
      const before = f.disk(); expect(before.handoff!.state).toBe("answered");
      const result2 = await f.tracked(() => runVersionConversation(f.input));
      expect(result2).toEqual(result); expect(f.disk()).toEqual(before); expect(f.requestJson).toHaveBeenCalledTimes(2);
      expect(before.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined(); expect(before.checkpoint.reviewed_version_fields).toBeUndefined();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("saves model presentation outside the original batch before raw and uses the same owning turn", async () => {
    const f = await fixture({ presentation: false, answer: "All applications advance it.", decision: true });
    try {
      const original = f.disk().handoff!;
      expect((await f.tracked(() => runVersionConversation(f.input))).state).toBe("confirmed");
      expect(f.requestJson).toHaveBeenCalledTimes(3);
      expect(f.disk().checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 3, tool_calls_used: 3 });
      expect(f.disk().handoff!.digest).toBe(original.digest); expect(f.disk().handoff!.question).toBe(original.question);
      expect(f.disk().question!.budget).toBeUndefined();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it.each(["I'm not sure", "  I’m not sure.\t "])("keeps a typed uncertainty mapping pending with exact raw history and one counted interpretation: %s", async answer => {
    const f = await fixture({ answer, decision: true, replies: ["pending"] });
    try {
      const calls = f.requestJson.mock.calls.length;
      expect((await f.tracked(() => runVersionConversation(f.input))).state).toBe("pending");
      const saved = f.disk();
      expect(saved.question!.raw_answer!.text).toBe(answer);
      expect(saved.question!.disposition).toBe("unknown");
      expect(saved.question!.proposal?.disposition).toBe("pending"); expect(saved.question!.confirmation).toBeUndefined();
      expect(f.requestJson).toHaveBeenCalledTimes(calls + 1); expect(f.ports.confirm).not.toHaveBeenCalled();
      await f.tracked(() => runVersionConversation(f.input));
      expect(f.disk()).toEqual(saved); expect(f.requestJson).toHaveBeenCalledTimes(calls + 1);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it.each(["no", "eof", "blank", "unknown"] as const)("%s preserves pending evidence and does not silently adopt", async kind => {
    const f = await fixture({ answer: kind === "eof" ? undefined : kind === "blank" ? " \t " : "All applications advance it.",
      decision: false, replies: kind === "unknown" ? ["pending"] : undefined });
    try {
      expect((await f.tracked(() => runVersionConversation(f.input))).state).toBe("pending");
      const before = f.disk(), calls = f.requestJson.mock.calls.length;
      expect(before.question!.confirmation).toBeUndefined(); expect(before.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
      if (kind === "blank") expect(before.question!.raw_answer!.text).toBe(" \t ");
      if (kind === "eof") expect(before.question!.raw_answer).toBeUndefined();
      await f.tracked(() => runVersionConversation(f.input));
      expect(f.requestJson).toHaveBeenCalledTimes(calls); expect(f.disk()).toEqual(before);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("corrects one known invalid map through the existing root correction and confirms normally", async () => {
    const f = await fixture({ answer: "All applications advance it.", decision: true, replies: ["invalid", "valid"] });
    try {
      expect((await f.tracked(() => runVersionConversation(f.input))).state).toBe("confirmed");
      expect(f.disk().checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 3, tool_calls_used: 3, used_version_corrections: [f.input.rootQuestionId] });
      expect(f.disk().question!.terminal_failure).toBeUndefined(); expect(f.requestJson).toHaveBeenCalledTimes(3);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("persists actual exhausted invalidity and disk re-entry sends and asks nothing", async () => {
    const f = await fixture({ answer: "All applications advance it.", replies: ["invalid", "invalid"] });
    try {
      await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
      const before = f.disk();
      expect(before.question!.terminal_failure).toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID", stage: "answer-map" });
      expect(before.question!.raw_answer!.text).toBe("All applications advance it.");
      expect(before.checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 3, tool_calls_used: 3, used_version_corrections: [f.input.rootQuestionId] });
      expect(before.checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
      const prompts = vi.mocked(f.ports.prompt).mock.calls.length;
      expect(await f.tracked(() => runVersionConversation(f.input))).toMatchObject({ state: "pending", terminal: true });
      expect(f.disk()).toEqual(before); expect(f.requestJson).toHaveBeenCalledTimes(3); expect(f.ports.prompt).toHaveBeenCalledTimes(prompts);
      expect(f.ports.confirm).not.toHaveBeenCalled(); expect(f.ports.resumePending).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("exhausted invalid presentation saves its own terminal before any raw prompt and re-entry sends nothing", async () => {
    const f = await fixture({ presentation: false, answer: "All applications advance it.", replies: ["invalid", "invalid"] });
    try {
      await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
      const before = f.disk(); expect(before.question!.terminal_failure).toMatchObject({ stage: "present" });
      expect(before.question!.presentation).toBeUndefined(); expect(before.question!.raw_answer).toBeUndefined();
      expect(before.checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 3, tool_calls_used: 3, used_version_corrections: [f.input.rootQuestionId] });
      expect(await f.tracked(() => runVersionConversation(f.input))).toMatchObject({ state: "pending", terminal: true });
      expect(f.disk()).toEqual(before); expect(f.requestJson).toHaveBeenCalledTimes(3); expect(f.ports.prompt).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("presentation and mapping share one actual root correction rather than separate correction pools", async () => {
    const f = await fixture({ presentation: false, answer: "All applications advance it.", replies: ["invalid", "valid", "invalid"] });
    try {
      await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toMatchObject({ code: "ASK_TOOL_ARGUMENTS_INVALID" });
      expect(f.disk().question!.terminal_failure).toMatchObject({ stage: "answer-map" });
      expect(f.disk().question!.presentation).toBeDefined(); expect(f.disk().question!.raw_answer).toBeDefined();
      expect(f.disk().checkpoint.logical_turns!.at(-1)).toMatchObject({ iterations_used: 4, tool_calls_used: 4, used_version_corrections: [f.input.rootQuestionId] });
      expect(f.requestJson).toHaveBeenCalledTimes(4); expect(f.ports.confirm).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it.each(["forged-error", "cancel"] as const)("%s cannot manufacture a consumed terminal verdict", async reply => {
    const f = await fixture({ answer: "All applications advance it.", replies: [reply] });
    try {
      await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toBeDefined();
      expect(f.disk().question!.terminal_failure).toBeUndefined(); expect(f.disk().question!.confirmation).toBeUndefined();
      expect(f.ports.confirm).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("explicit EOF Resume reopens the same saved wording and allowance without presentation generation", async () => {
    const f = await fixture({ decision: true });
    try {
      const first = await f.tracked(() => runVersionConversation(f.input)); expect(first.state).toBe("pending");
      const original = f.disk().question!, owner = f.disk().checkpoint.logical_turns!.at(-1)!.id;
      vi.mocked(f.ports.prompt).mockResolvedValue("All applications advance it.");
      vi.mocked(f.ports.resumePending).mockImplementation(async q => {
        await f.ports.saveQuestion(reopenOperatorQuestion(q), q.digest); return "reopen";
      });
      const result = await f.tracked(() => runVersionConversation(f.input));
      expect(result.state).toBe("confirmed"); expect(result.question.id).toBe(original.id);
      expect(result.question.presentation).toEqual(original.presentation); expect(result.question.disposition_history).toEqual(original.disposition_history);
      expect(f.disk().checkpoint.logical_turns!.at(-1)).toMatchObject({ id: owner, iterations_used: 2, tool_calls_used: 2 });
      expect(f.requestJson).toHaveBeenCalledTimes(2);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("a competing confirmation keeps its exact winner and rejects late adoption", async () => {
    const f = await fixture({ answer: "All applications advance it.", decision: true });
    try {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
      vi.mocked(f.ports.confirm).mockImplementation(async () => { enter(); await held; return true; });
      const running = f.tracked(() => runVersionConversation(f.input));
      const refusal = expect(running).rejects.toMatchObject({ code: "ACTION_VERSION_QUESTION_STALE" });
      await entered;
      const previous = f.disk().question!, winner = leaveOperatorQuestionPending(previous, "declined");
      await f.ports.saveQuestion(winner, previous.digest);
      release(); await refusal;
      expect(f.disk().question).toEqual(winner); expect(f.disk().question!.confirmation).toBeUndefined();
      expect(f.requestJson).toHaveBeenCalledTimes(2); expect(f.disk().checkpoint.logical_turns!.at(-1)!.completed).toBeUndefined();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("changed current proof refuses before UI or another request", async () => {
    const f = await fixture({ answer: "All applications advance it.", decision: true });
    try {
      f.stale(); await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toMatchObject({ code: "ACTION_VERSION_QUESTION_STALE" });
      expect(f.requestJson).toHaveBeenCalledOnce(); expect(f.ports.prompt).not.toHaveBeenCalled(); expect(f.ports.confirm).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("failed consumed terminal save retains refusal without inventing a durable stop or consent", async () => {
    const f = await fixture({ answer: "All applications advance it.", replies: ["invalid", "invalid"] });
    try {
      f.failSave(); await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toThrow("CONTROLLED_EXACT_SAVE_FAILED");
      expect(f.disk().question!.terminal_failure).toBeUndefined(); expect(f.disk().question!.raw_answer).toBeDefined(); expect(f.ports.confirm).not.toHaveBeenCalled();
      expect(f.disk().checkpoint.logical_turns!.at(-1)!.used_version_corrections).toEqual([f.input.rootQuestionId]);
      await expect(f.tracked(() => runVersionConversation(f.input))).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
      expect(f.requestJson).toHaveBeenCalledTimes(3); expect(f.ports.confirm).not.toHaveBeenCalled();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
