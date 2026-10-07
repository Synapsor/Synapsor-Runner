import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { afterEach, expect, it } from "vitest";
import { createBusinessStatementHost, type BusinessStatementRecordUpdate } from "./authoring-business-statement-host.js";
import type { BusinessStatementInteraction, BusinessStatementResponse } from "./authoring-business-statement-interaction.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { AskError, secureAskJsonRequest, type ProviderHttpInput } from "./model-ask.js";
import { authoringGenerationHandled, authoringTransportCheckpoint, configureAuthoringGenerationRecovery,
  permitAuthoringInterruptedRecovery, prepareAuthoringInterruptedRecovery, recoverAuthoringGeneration,
  validateAuthoringTransportState, withAuthoringGenerationRecovery, type AuthoringTransportState } from "./authoring-generation-recovery.js";

// Local host port characterization with real short exclusion and literal disk
// writes. No native producer, generation journal or accepted Action is seeded.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "business-statement-host-")); roots.push(root);
  const file = path.join(root, "host-port-record.json"), source = path.join(root, "source-port-statements.json");
  let state: BusinessStatementRecordUpdate = { questions: [], handoffs: [], conversationTurns: [] }, statements: string[] = [];
  let failure: "raw-before-write" | "raw-after-write" | "answer-before-write" | undefined;
  const events: string[] = [], digest = canonicalJsonDigest("declared selected Action");
  let insideMutation: (() => void) | undefined;
  const context = () => canonicalJsonDigest({ declared: "Source/schema/role", statements });
  const inspect = () => structuredClone(state), reload = async () => { state = JSON.parse(await fs.readFile(file, "utf8")); };
  const host = (interact: (view: BusinessStatementInteraction) => Promise<BusinessStatementResponse>, assertCurrent = async () => {}) => createBusinessStatementHost({
    question: "How many reviewers are needed?", stage: "action_drafting", producerQuestionDigest: canonicalJsonDigest("declared producer question"),
    assertCurrent,
    access: {
      readQuestions: () => state.questions!, readHandoffs: () => state.handoffs!, readRecovery: () => state.recovery,
      readConversationTurns: () => state.conversationTurns, readCheckpointDigest: () => undefined,
      scopeDigest: () => digest, contextDigest: async () => context(),
      mutate: operation => withProjectAuthorityMutation(root, async permit => { insideMutation?.(); return operation(permit); }),
      install: update => { state = { ...state, ...update }; },
      save: async (_permit, _stage, subject) => {
        const rawOnly = !!state.questions!.at(-1)?.raw_answer && !state.questions!.at(-1)?.proposal;
        if (failure === "raw-before-write" && rawOnly || failure === "answer-before-write" && subject === "The owner answer")
          throw new Error("port save before write");
        await fs.writeFile(file, JSON.stringify(state)); events.push(subject);
        if (failure === "raw-after-write" && rawOnly) throw new Error("port save after write");
      },
      appendSourceStatement: async (_permit, answer) => {
        statements.push(answer); await fs.writeFile(source, JSON.stringify(statements)); events.push("Source append");
      },
      prepareReadDecision: async () => ({}), checkpointFailure: subject => new Error(`${subject} checkpoint incomplete`),
    }, interact,
  });
  return { root, file, source, host, events, inspect, reload, setFailure: (next: typeof failure) => { failure = next; },
    statements: () => [...statements], install: (update: BusinessStatementRecordUpdate) => { state = { ...state, ...update }; },
    setMutationHook: (hook: () => void) => { insideMutation = hook; } };
}

const answer = (raw: string | null, accepted: boolean | null = true) => async (view: BusinessStatementInteraction): Promise<BusinessStatementResponse> =>
  view.kind === "question" ? { kind: "answer", binding: view.binding, raw }
    : view.kind === "readback" ? { kind: "decision", binding: view.binding, accepted }
      : { kind: "pending", binding: view.binding, choice: "keep" };

it('checks the full consumer currentness under the adoption permit after the readback wait', async () => {
  const f = await fixture(); let armed = false, configurationChanged = false;
  f.setMutationHook(() => { if (armed) configurationChanged = true; });
  await expect(f.host(async view => {
    if (view.kind === 'readback') armed = true;
    return answer('Use the worker completion receipt.')(view);
  }, async () => { if (configurationChanged) throw new PolicySourceChangedError(); }).review()).rejects.toBeInstanceOf(PolicySourceChangedError);
  expect(f.inspect().questions!.at(-1)?.confirmation).toBeUndefined();
  expect(f.inspect().handoffs!.at(-1)?.state).toBe('waiting');
  expect(f.statements()).toEqual([]);
});

// Real native transport/disposition records; the business host still uses local
// ports. This is not a public authoring or model semantic-fidelity proof.
async function recoveredJournal(companion?: "unknown" | "handled") {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the actual request */ }
    calls++;
    if (calls === 1 || companion === "unknown" && calls === 3) { request.socket.destroy(); return; }
    response.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
  let state: AuthoringTransportState = { version: 1, operations: [] };
  const context = canonicalJsonDigest("declared unchanged business context");
  const enter = <T,>(run: () => Promise<T>) => withAuthoringGenerationRecovery(() => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state,
      current: async () => context, write: async next => {
        validateAuthoringTransportState(next); state = structuredClone(next);
      } });
    return run();
  });
  const request = (): ProviderHttpInput => ({ endpoint, scope: "custom_loopback", headers: {},
    body: { model: "declared-offline-model", input: "Inspect only the declared metadata.", tools: [], max_output_tokens: 10 },
    signal: new AbortController().signal, timeoutMs: 2_000, stream: { format: "openai_responses" } });
  try {
    await expect(enter(() => recoverAuthoringGeneration(request(), secureAskJsonRequest))).rejects.toBeInstanceOf(AskError);
    const origin = structuredClone(state.operations[0]!);
    await enter(async () => permitAuthoringInterruptedRecovery(await prepareAuthoringInterruptedRecovery(canonicalJsonDigest("saved producer checkpoint"))));
    await enter(async () => {
      const result = await recoverAuthoringGeneration(request(), secureAskJsonRequest);
      await authoringGenerationHandled([result]); state = authoringTransportCheckpoint(state)!;
    });
    expect(calls).toBe(2); expect(state.operations[0]).toEqual(origin);
    expect(state.operations[1]!.state).toBe("checkpointed");
    expect(state.interrupted_dispositions![0]!.status).toBe("admitted");
    if (companion) {
      const separate = () => recoverAuthoringGeneration({ ...request(),
        body: { ...request().body, input: "Inspect separate declared metadata." } }, secureAskJsonRequest);
      if (companion === "unknown") await expect(enter(separate)).rejects.toBeInstanceOf(AskError);
      else await enter(async () => authoringGenerationHandled([await separate()]));
      expect(calls).toBe(3); expect(state.operations.at(-1)!.state).toBe(companion);
      expect(state.operations.at(-1)!.recovery_of).toBeUndefined();
    }
    return { state, origin };
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it("an explicitly disposed interruption does not block the next ordinary business question or rewrite its history", async () => {
  const f = await fixture(), { state, origin } = await recoveredJournal();
  f.install({ recovery: state });
  expect(await f.host(answer(null)).review()).toBeUndefined();
  expect(f.inspect().questions!.at(-1)?.presentation?.text).toBe("How many reviewers are needed?");
  expect(f.inspect().recovery).toEqual(state); expect(f.inspect().recovery!.operations[0]).toEqual(origin);
  expect(f.statements()).toEqual([]);
});

it.each(["unknown", "handled"] as const)("a genuinely unresolved %s still blocks an uncompleted business question", async status => {
  const f = await fixture(), { state } = await recoveredJournal(status);
  // A separately dispatched native operation remains undisposed. No borrowed
  // completion or disposition comes from the earlier recovered chain.
  f.install({ recovery: state }); const before = f.inspect(); let asked = false;
  await expect(f.host(async view => { asked = true; return answer(null)(view); }).review())
    .rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
  expect(asked).toBe(false); expect(f.inspect()).toEqual(before); expect(f.events).toEqual([]);
});

it("preserves exact raw testimony and appends Source before the acceptance save, without holding exclusion during a wait", async () => {
  const f = await fixture(), raw = "  Two reviewers. 🧭\t";
  expect(await f.host(async view => {
    await withProjectAuthorityMutation(f.root, async () => {}, { waitMs: 0 });
    if (view.kind === "readback") {
      expect(view.defaultValue).toBe(false); expect(view.lines.some(line => line.includes(raw))).toBe(true);
      expect(f.inspect().questions!.at(-1)?.raw_answer?.text).toBe(raw);
      expect(f.statements()).toEqual([]);
    }
    return answer(raw)(view);
  }).review()).toBe(raw);
  const s = f.inspect();
  expect(s.handoffs!.at(-1)).toMatchObject({ state: "answered", answer: raw, actor: "local_installation_operator" });
  expect(s.questions!.at(-1)?.confirmation?.decision).toBe("new_attributed_decision");
  expect(f.events.slice(-2)).toEqual(["Source append", "The owner answer"]);
  expect(s.recovery).toBeUndefined();
});

it.each([
  { raw: null, accepted: true, disposition: "cancelled", captured: false },
  { raw: " \t", accepted: true, disposition: "unknown", captured: true },
  { raw: "I'm not sure", accepted: true, disposition: "unknown", captured: true },
  { raw: "Two reviewers", accepted: false, disposition: "declined", captured: true },
  { raw: "Two reviewers", accepted: null, disposition: "cancelled", captured: true },
])("retains distinct pending behavior: $disposition / $raw / $accepted", async ({ raw, accepted, disposition, captured }) => {
  const f = await fixture(); expect(await f.host(answer(raw, accepted)).review()).toBeUndefined();
  const q = f.inspect().questions!.at(-1)!;
  expect(q.disposition).toBe(disposition); expect(!!q.raw_answer).toBe(captured);
  if (captured) expect(q.raw_answer!.text).toBe(raw);
  expect(f.inspect().handoffs!.at(-1)?.state).toBe("waiting"); expect(f.statements()).toEqual([]);
});

it("Keep saves nothing and Review reuses the exact retained raw event", async () => {
  const f = await fixture(); await f.host(answer("Two reviewers", false)).review();
  const old = f.inspect(), events = [...f.events];
  expect(await f.host(answer("unused")).review()).toBeUndefined(); expect(f.inspect()).toEqual(old); expect(f.events).toEqual(events);
  expect(await f.host(async view => {
    expect(view.kind).not.toBe("question");
    return view.kind === "pending" ? { kind: "pending", binding: view.binding, choice: "review" } : answer("unused")(view);
  }).review()).toBe("Two reviewers");
  expect(f.inspect().questions!.at(-1)?.raw_answer).toEqual(old.questions!.at(-1)?.raw_answer);
  expect(f.statements()).toEqual(["Two reviewers"]);
});

it.each([" \t", "I'm not sure"])("Replace retains earlier words and distinct blank/nonblank handoff history: %s", async raw => {
  const f = await fixture(); await f.host(answer(raw)).review(); const old = f.inspect();
  expect(await f.host(async view => view.kind === "pending" ? { kind: "pending", binding: view.binding, choice: "replace" }
    : answer("Two reviewers")(view)).review()).toBe("Two reviewers");
  const s = f.inspect(); expect(s.questions![0]).toEqual(old.questions![0]);
  expect(s.questions![1]!.revision).toBe(2); expect(s.questions![1]!.id).not.toBe(s.questions![0]!.id);
  expect(s.handoffs).toHaveLength(raw.trim() ? 2 : 1);
  expect(f.statements()).toEqual(["Two reviewers"]);
  if (raw.trim()) expect(s.handoffs![0]).toMatchObject({ state: "answered", answer: raw });
});

it("rejects a late decision after a competing question save and preserves the winner", async () => {
  const f = await fixture(); let winner: BusinessStatementRecordUpdate | undefined;
  await expect(f.host(async view => {
    if (view.kind === "readback") {
      const s = f.inspect(), q = s.questions!.at(-1)!;
      const { leaveOperatorQuestionPending } = await import("./authoring-operator-question.js");
      winner = { ...s, questions: [leaveOperatorQuestionPending(q, "declined")] };
      await withProjectAuthorityMutation(f.root, async () => { f.install(winner!); await fs.writeFile(f.file, JSON.stringify(winner)); });
    }
    return answer("Two reviewers")(view);
  }).review()).rejects.toBeInstanceOf(PolicySourceChangedError);
  expect(f.inspect()).toEqual(winner); expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual(winner);
  expect(f.statements()).toEqual([]);
});

it.each(["raw-before-write", "raw-after-write"] as const)("a literal raw port fault preserves the acknowledged state: %s", async failure => {
  const f = await fixture(); f.setFailure(failure); await expect(f.host(answer("  Two 🧭\t")).review()).rejects.toThrow("port save");
  f.setFailure(undefined); await f.reload(); const before = f.inspect(); let asks = 0;
  expect(!!before.questions!.at(-1)?.raw_answer).toBe(failure === "raw-after-write");
  expect(await f.host(async view => { if (view.kind === "question") asks++; return answer("  Two 🧭\t")(view); }).review()).toBe("  Two 🧭\t");
  expect(asks).toBe(failure === "raw-after-write" ? 0 : 1);
  if (failure === "raw-after-write") expect(f.inspect().questions!.at(-1)?.raw_answer).toEqual(before.questions!.at(-1)?.raw_answer);
});

it("a failed acceptance save retains the committed Source append and fences a reopened old context", async () => {
  const f = await fixture(); f.setFailure("answer-before-write");
  await expect(f.host(answer("Two reviewers")).review()).rejects.toThrow("port save before write");
  expect(JSON.parse(await fs.readFile(f.source, "utf8"))).toEqual(["Two reviewers"]);
  await f.reload(); const before = f.inspect(); expect(before.handoffs!.at(-1)?.state).toBe("waiting");
  f.setFailure(undefined); await expect(f.host(answer("Two reviewers")).review()).rejects.toThrow("POLICY_SOURCE_CHANGED");
  expect(f.inspect()).toEqual(before); expect(f.statements()).toEqual(["Two reviewers"]);
});
