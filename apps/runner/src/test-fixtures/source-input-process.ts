/** Fresh-process fixture for the production Input host. No Input transition or
 * successful model result is reconstructed here. The adapter owns only record
 * installation, real Source/Resume CAS, and controlled local I/O. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createSourceInputHost, type SourceInputHostAccess, type SourceInputRecordUpdate } from "../authoring-input-host.js";
import { runSourceInputConversation } from "../authoring-input-policy-conversation.js";
import { buildBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeCurrent,
  readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources, newPolicySourceSession, policyTextSnapshot,
  savePolicySources, PolicySourceChangedError, type PolicySourceSession } from "../authoring-policy-source.js";
import { authoringTransportCheckpoint, configureAuthoringGenerationRecovery,
  withAuthoringGenerationRecovery, type AuthoringTransportState } from "../authoring-generation-recovery.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "../project-authority-mutation.js";
import type { OperatorQuestion } from "../authoring-operator-question.js";
import type { InputInteraction } from "../authoring-input-interaction.js";
import { INPUT_PROCESS_FACTS, INPUT_PROCESS_BINDING } from "./source-input-process-contract.js";
import { modelVisibleJsonLine, modelVisibleUserText } from "./model-visible-frame.js";

type Stop = "onset" | "unanswered" | "raw" | "proposal" | "confirmation" | "append-before-ack" | "ack-lost" | "returned" | "none";
type Mode = "start" | "restart";
type Controls = { accepted?: boolean | null; pendingChoice?: "keep" | "answer"; raw?: string | null;
  readbackGate?: { arrived: string; release: string }; responseBindingFile?: string };
const args = process.argv.slice(2);
const projectRoot = args[0]!, mode = args[1] as Mode, stop = args[2] as Stop;
assert(projectRoot && ["start", "restart"].includes(mode));
assert(["onset", "unanswered", "raw", "proposal", "confirmation", "append-before-ack", "ack-lost", "returned", "none"].includes(stop));
const controls: Controls = args[3] ? JSON.parse(await fs.readFile(args[3], "utf8")) : {};
const manifest = path.join(projectRoot, "fixture-source-id.json");
const eventPath = path.join(projectRoot, "process-events.jsonl");
const binding = INPUT_PROCESS_BINDING;
const store = canonicalJsonDigest("controlled exact effective store");
const outcomes = [...INPUT_PROCESS_FACTS.outcomes];
const base = { binding, stage: "action_drafting" as const, jobIntent: INPUT_PROCESS_FACTS.job,
  provider: "openai" as const, model: "controlled-input-process", actionWorkflow: "program" as const,
  action: { intent: INPUT_PROCESS_FACTS.job, strategy: "rule_derived" as const, intended_outcomes: outcomes,
    intents: [INPUT_PROCESS_FACTS.job] } };
let sources: PolicySourceSession;
let resume: BoundaryAuthoringResumeState;
let held = 0;
let counts = { requests: 0, prompts: 0, confirmations: 0, pendingViews: 0, commits: 0, acknowledgements: 0 };
const event = async (kind: string, value: Record<string, unknown> = {}) =>
  fs.appendFile(eventPath, `${JSON.stringify({ pid: process.pid, kind, ...value })}\n`, { mode: 0o600 });
const interrupt = () => Object.assign(new Error(`CONTROLLED_INPUT_PROCESS_INTERRUPTION:${stop}`), { controlledStop: stop });

async function persist(fields: Partial<Parameters<typeof buildBoundaryAuthoringResumeState>[0]>, permit?: ProjectAuthorityMutationPermit) {
  const next = buildBoundaryAuthoringResumeState({ ...base, stage: resume.stage,
    policySourceSession: sources.id, previous: resume, conversation: resume.conversation,
    operatorQuestions: resume.operator_questions, ownerHandoffs: resume.owner_handoffs,
    generationRecovery: resume.generation_recovery, ...fields });
  await writeBoundaryAuthoringResumeState(projectRoot, next, { expectedRevisionDigest: resume.revision_digest, permit });
  resume = next;
  counts.commits++;
}

function selected(): OperatorQuestion | undefined {
  return [...(resume.operator_questions ?? [])].sort((a, b) => b.revision - a.revision)[0];
}

function isBoundary(subject: string): boolean {
  const q = selected();
  return stop === "onset" && Boolean(q?.source_binding) && !q?.proposal && !q?.presentation
    || stop === "unanswered" && Boolean(q?.handoff_id && q.presentation) && !q?.raw_answer
    || stop === "raw" && Boolean(q?.raw_answer) && !q?.proposal
    || stop === "proposal" && Boolean(q?.proposal) && !q?.confirmation
    || stop === "confirmation" && Boolean(q?.confirmation) && subject !== "The saved input-policy interpretation";
}

let commit: SourceInputHostAccess["commit"] = async (update, options) => {
  // Typed installation only: semantic transitions are exclusively in the host.
  const recovery = Object.prototype.hasOwnProperty.call(update, "recovery") ? update.recovery : resume.generation_recovery;
  await persist({ operatorQuestions: update.questions ?? resume.operator_questions,
    ownerHandoffs: update.handoffs ?? resume.owner_handoffs,
    conversation: update.conversationTurns ?? resume.conversation,
    generationRecovery: options.acknowledgeGeneration ? authoringTransportCheckpoint(recovery) : recovery }, options.permit);
  if (options.subject === "The saved input-policy interpretation") counts.acknowledgements++;
  await event("commit", { subject: options.subject, resumeDigest: resume.revision_digest });
  if (stop === "ack-lost" && options.subject === "The saved input-policy interpretation") throw interrupt();
  if (isBoundary(options.subject)) throw interrupt();
};

async function interact(view: InputInteraction, assertCurrent: () => Promise<void>) {
  assert.equal(held, 0, "No model/operator wait may hold the project writer lease.");
  await assertCurrent();
  await event("view", { view });
  if (view.kind === "question") {
    counts.prompts++;
    assert.equal(view.preserveWhitespace, true);
    assert.equal(view.recordPolicyAnswer, false);
    return { kind: "answer" as const, binding: view.binding,
      raw: Object.prototype.hasOwnProperty.call(controls, "raw") ? controls.raw! : INPUT_PROCESS_FACTS.raw };
  }
  if (view.kind === "readback") {
    counts.confirmations++;
    assert.equal(view.defaultValue, false);
    if (controls.readbackGate) {
      await fs.writeFile(controls.readbackGate.arrived, JSON.stringify(view), { mode: 0o600, flag: "wx" });
      const deadline = Date.now() + 20_000;
      while (true) {
        try { await fs.access(controls.readbackGate.release); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (Date.now() >= deadline) throw new Error("CONTROLLED_READBACK_GATE_DEADLINE");
        await wait(10);
      }
    }
    const responseBinding = controls.responseBindingFile ? JSON.parse(await fs.readFile(controls.responseBindingFile, "utf8")) : view.binding;
    return { kind: "decision" as const, binding: responseBinding,
      accepted: Object.prototype.hasOwnProperty.call(controls, "accepted") ? controls.accepted! : true };
  }
  counts.pendingViews++;
  assert.equal(view.defaultValue, "keep");
  return { kind: "pending" as const, binding: view.binding, choice: controls.pendingChoice ?? "keep" };
}

async function run() {
  await fs.mkdir(projectRoot, { recursive: true, mode: 0o700 });
  if (mode === "start") {
    sources = newPolicySourceSession();
    sources.snapshots.push(policyTextSnapshot(Buffer.from(INPUT_PROCESS_FACTS.sourceText), "rules.txt"));
    sources.active = 1;
    await savePolicySources(projectRoot, sources, { expectedDigest: null });
    await fs.writeFile(manifest, JSON.stringify({ sourceId: sources.id }), { mode: 0o600, flag: "wx" });
    resume = buildBoundaryAuthoringResumeState({ ...base, policySourceSession: sources.id });
    await writeBoundaryAuthoringResumeState(projectRoot, resume, { expectedRevisionDigest: null });
  } else {
    const { sourceId } = JSON.parse(await fs.readFile(manifest, "utf8"));
    sources = await loadPolicySources(projectRoot, sourceId);
    const saved = await readBoundaryAuthoringResumeState(projectRoot, binding);
    assert.equal(saved.status, "ready");
    if (saved.status !== "ready") throw new Error("Real saved Resume required.");
    resume = saved.value;
  }
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) =>
    assertBoundaryAuthoringResumeCurrent(projectRoot, resume, undefined, { permit });
  const contextDigest = async (permit?: ProjectAuthorityMutationPermit, sourceContext = sources, savedSourceContext = sources) => {
    await assertCurrent(permit);
    const actual = await loadPolicySources(projectRoot, sources.id);
    if (canonicalJsonDigest(actual) !== canonicalJsonDigest(savedSourceContext)) throw new PolicySourceChangedError();
    return canonicalJsonDigest({ scope: canonicalJsonDigest(INPUT_PROCESS_FACTS.job), store, outcomes, source: sourceContext });
  };
  const access: SourceInputHostAccess = {
    readQuestions: () => resume.operator_questions ?? [], readHandoffs: () => resume.owner_handoffs ?? [],
    readRecovery: () => resume.generation_recovery, readConversationTurns: () => resume.conversation,
    readOutcomes: () => resume.action?.intended_outcomes, scopeDigest: () => canonicalJsonDigest(INPUT_PROCESS_FACTS.job),
    contextDigest, assertResumeCurrent: assertCurrent,
    loadContext: async () => ({ store, inspectReader: async () => undefined }),
    mutate: (operation, parentPermit) => withProjectAuthorityMutation(projectRoot, async permit => {
      held++; try { return await operation(permit); } finally { held--; }
    }, { permit: parentPermit }), commit,
    checkpointFailure: subject => new Error(`CONTROLLED_CHECKPOINT_FAILURE:${subject}`),
  };
  return withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => resume.generation_recovery,
      current: () => contextDigest(), write: (recovery: AuthoringTransportState) => persist({ generationRecovery: recovery }),
      progress: () => undefined });
    const host = await createSourceInputHost({ projectRoot, sources, store, outcomes, actor: "local_installation_operator",
      access, interact, preserveCurrentReview: false });
    assert.equal(host.state, "ready");
    if (host.state !== "ready") throw new Error("Controller must inspect the actual stored review.");
    const result = await runSourceInputConversation({ projectRoot, sources, store, outcomes, actor: "local_installation_operator",
      egressAcknowledged: true, env: {}, ports: host.ports,
      session: { provider: "openai", model: "controlled-input-process", apiKey: "inert-local-decoder-only",
        dependencies: { requestJson: async request => {
          assert.equal(held, 0, "A model wait may not hold the project writer lease.");
          const body = request.body as { input: Array<{ role?: string; content?: Array<{ text?: string }> | string }>; tools: Array<any> };
          const tool = body.tools.find(tool => tool.name === "runner__propose_operator_decision");
          assert(tool);
          counts.requests++;
          // Derive response references exclusively from the actual transmitted
          // public frame/tool schema, never selected() or private fixture state.
          const frame = modelVisibleUserText(body);
          const q = modelVisibleJsonLine<{ question_id: string; revision: number; source_reference?: string;
            source_binding?: object; raw_answer?: string; answer_id?: string; target: { outcomes: string[] }; presented_question?: string }>(body, "Current question");
          assert(tool.parameters.oneOf.every((branch: any) => branch.properties.question_id.enum.includes(q.question_id)));
          assert(tool.parameters.oneOf.every((branch: any) => branch.properties.revision.enum.includes(q.revision)));
          let value: object;
          if (q.source_binding) value = { question_id: q.question_id, revision: q.revision,
            source_reference: q.source_reference, status: "needs_information", question: INPUT_PROCESS_FACTS.question,
            source_passages: [{ start: 1, end: 2, identifiers: ["note"] }] };
          else {
            assert(q.raw_answer?.includes("1 through 64 UTF-16 units"));
            assert(q.presented_question?.includes("note"));
            value = { question_id: q.question_id, revision: q.revision, answer_id: q.answer_id,
              status: "proposal", disposition: "proposed", value: { kind: "input_bounds", requirements: [{
                outcomes: q.target.outcomes, input: "note", min_length: 1, max_length: 64 }] } };
          }
          await event("request", { stage: q.source_binding ? "source-review" : "answer-map", questionId: q.question_id,
            visibleFrameDigest: canonicalJsonDigest(frame), responseReferences: { question_id: q.question_id, revision: q.revision,
              ...(q.source_reference ? { source_reference: q.source_reference } : { answer_id: q.answer_id }) } });
          return { status: 200, body: { status: "completed", output: [{ type: "function_call", call_id: `local-${process.pid}-${counts.requests}`,
            name: "runner__propose_operator_decision", arguments: JSON.stringify(value) }] } };
        } } } });
    if (result.state === "pending") return result.state;
    // The owning caller must persist its acknowledged records, not restore a
    // pre-host snapshot. No active-authority or success proof is invented.
    const acknowledgedQuestions = structuredClone(resume.operator_questions);
    const acknowledgedRecovery = structuredClone(resume.generation_recovery);
    await persist({ stage: "authority_review" });
    assert.deepEqual(resume.operator_questions, acknowledgedQuestions);
    assert.deepEqual(resume.generation_recovery, acknowledgedRecovery);
    await event("returned", { reviewDigest: result.review.digest, stage: resume.stage });
    if (stop === "returned") throw interrupt();
    return result.state;
  });
}

// This interruption occurs after the real Source append but before the host's
// Resume acknowledgement; the stored review/result is never fabricated.
if (stop === "append-before-ack") {
  // The access commit is the next durable boundary after the Source append.
  const original = commit;
  commit = async (update, options) => {
    if (options.subject === "The saved input-policy interpretation") {
      const actual = await loadPolicySources(projectRoot, sources.id);
      assert.equal(actual.input_policy_reviews?.length, 1);
      await event("source-append-before-ack", { reviewDigest: actual.input_policy_reviews![0]!.digest });
      throw interrupt();
    }
    return original(update, options);
  };
}

let state: string;
try { state = await run(); }
catch (error) {
  if ((error as { controlledStop?: string }).controlledStop !== stop) throw error;
  state = "interrupted";
}
const durable = await readBoundaryAuthoringResumeState(projectRoot, binding);
assert.equal(durable.status, "ready");
if (durable.status !== "ready") throw new Error("Durable checkpoint unavailable.");
const storedSources = await loadPolicySources(projectRoot, sources!.id);
await event("closed", { state, counts });
console.log(JSON.stringify({ pid: process.pid, state, counts, resume: durable.value,
  sources: storedSources, activeSource: activePolicySource(storedSources) }));
