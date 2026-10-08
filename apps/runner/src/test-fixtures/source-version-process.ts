/** Native Action producer / extracted Version host cold-process control.
 * Synthetic structural inputs are declared; no DB, active authority, copied
 * presenter, constructed completion or Version record is used. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildAutoBoundary } from "../auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "../action-rule-authoring.js";
import { generateModelActionRuleDraft, type ModelActionRuleDraftInput } from "../action-rule-model.js";
import { prepareActionVersionField } from "../action-rule-version-review.js";
import { createVersionQuestionHost, type VersionQuestionRecordUpdate } from "../authoring-version-host.js";
import { runVersionConversation } from "../authoring-version-conversation.js";
import { actionVersionMaterialDigest, assertActionVersionQuestionHandoff, buildBoundaryAuthoringResumeState,
  assertBoundaryAuthoringResumeCurrent, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import { assertActionLogicalTurnJournalAdvance, type ActionRuleAuthoringCheckpoint } from "../action-rule-authoring-checkpoint.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringActionCheckpoint,
  authoringQuestionCheckpoint, authoringQuestionAnswerCheckpoint, authoringQuestionSequenceCompletion } from "../authoring-generation-recovery.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources,
  type PolicySourceSession } from "../authoring-policy-source.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "../project-authority-mutation.js";
import { VERSION_PROCESS_FACTS as facts, versionProcessInspection } from "./source-version-process-contract.js";
import { modelVisibleJsonLine, modelVisibleUserText } from "./model-visible-frame.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "../authoring-protocol.js";

type Stop = "root" | "unanswered" | "raw" | "proposal" | "confirmed" | "mapped" | "returned" | "none";
type Controls = { raw?: string | null; accepted?: boolean | null; pendingChoice?: "keep" | "answer" };
const [root, mode, stopping, controlFile] = process.argv.slice(2);
assert(root && ["start", "restart"].includes(mode!));
assert(["root", "unanswered", "raw", "proposal", "confirmed", "mapped", "returned", "none"].includes(stopping!));
const stop = stopping as Stop, controls: Controls = controlFile ? JSON.parse(await fs.readFile(controlFile, "utf8")) : {};
const inspection = versionProcessInspection();
const build = buildAutoBoundary({ inspection, project: { root, package_manager: "npm", frameworks: ["node"],
  schema_inputs: [], database_env_names: ["DATABASE_URL"] }, sourceEnv: "DATABASE_URL", inspectedSchema: "public" });
const readBoundary = build.exploration_boundary;
const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: readBoundary, inspection });
const binding = { boundary_name: readBoundary.pack.name, generation_lock_fingerprint: readBoundary.generation_lock_fingerprint,
  schema_fingerprint: build.lock.schema_fingerprint, role_posture_fingerprint: build.lock.role_posture_fingerprint };
const fixtureDigest = canonicalJsonDigest({ inspection, readBoundary, builtCatalog, facts });
const scope = canonicalJsonDigest(facts.intent);
let resume: BoundaryAuthoringResumeState, committed: BoundaryAuthoringResumeState, sources: PolicySourceSession;
let cp: ActionRuleAuthoringCheckpoint | undefined, borrowed: ProjectAuthorityMutationPermit | undefined;
let held = 0;
const counts = { requests: 0, prompts: 0, confirmations: 0, pendingViews: 0, commits: 0, ordinaryPrompts: 0 };
const event = (kind: string, value: unknown = {}) => fs.appendFile(path.join(root!, "process-events.jsonl"),
  `${JSON.stringify({ pid: process.pid, kind, value })}\n`, { mode: 0o600 });
const interrupted = () => Object.assign(new Error(`CONTROLLED_VERSION_PROCESS_INTERRUPTION:${stop}`), { controlledStop: stop });
const selected = () => resume.operator_questions?.find(q => q.id === cp?.pending_version?.question_id);
const context = () => canonicalJsonDigest({ fixtureDigest, source: sources, scope });
const base = { binding, stage: "action_drafting" as const, jobIntent: facts.intent, provider: "openai" as const,
  model: "controlled-version-process", authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } };
async function persist(permit?: ProjectAuthorityMutationPermit) {
  const next = buildBoundaryAuthoringResumeState({ ...base, previous: committed, policySourceSession: sources.id,
    action: { intent: facts.intent, strategy: "rule_derived", intents: [facts.intent], intended_outcomes: [...facts.outcomes], ...(cp ? { checkpoint: cp } : {}) },
    conversation: resume.conversation, operatorQuestions: resume.operator_questions, ownerHandoffs: resume.owner_handoffs,
    generationRecovery: resume.generation_recovery, reviewedVersionFields: resume.reviewed_version_fields });
  await writeBoundaryAuthoringResumeState(root!, next, { expectedRevisionDigest: committed.revision_digest, permit });
  resume = next; committed = structuredClone(next); counts.commits++;
}
async function assertFresh(permit?: ProjectAuthorityMutationPermit) {
  await assertBoundaryAuthoringResumeCurrent(root!, committed, undefined, { permit });
  assert.equal(canonicalJsonDigest(await loadPolicySources(root!, sources.id)), canonicalJsonDigest(sources), "SOURCE_CHANGED");
  const manifest = JSON.parse(await fs.readFile(path.join(root!, "fixture-context.json"), "utf8"));
  assert.equal(manifest.fixtureDigest, fixtureDigest, "STRUCTURE_READ_ROLE_SCOPE_CHANGED");
  // This file is the declared current structural adapter input, independent of
  // both the saved Resume and its original immutable fixture origin. It lets
  // controls change current metadata without rewriting a saved question.
  const current = JSON.parse(await fs.readFile(path.join(root!, "current-context.json"), "utf8"));
  assert.equal(canonicalJsonDigest(current), canonicalJsonDigest({ inspection, readBoundary, scope }), "CURRENT_STRUCTURE_READ_ROLE_SCOPE_CHANGED");
}
async function mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T> {
  const before = structuredClone(resume), previousCp = cp && structuredClone(cp);
  try { return await withProjectAuthorityMutation(root!, async permit => {
    await assertFresh(permit); const previous = borrowed; borrowed = permit; held++;
    try { return await operation(permit); } finally { borrowed = previous; held--; }
  }, { permit: borrowed }); } catch (error) { resume = before; cp = previousCp; throw error; }
}
async function checkpointBoundary() {
  const q = selected();
  const hit = stop === "root" && !!cp?.pending_version && !q?.presentation
    || stop === "unanswered" && !!q?.presentation && !q.raw_answer
    || stop === "raw" && !!q?.raw_answer && !q.proposal
    || stop === "proposal" && !!q?.proposal && !q.confirmation
    || stop === "confirmed" && !!q?.confirmation
    || stop === "mapped" && !cp?.pending_version && !!cp?.reviewed_version_fields?.length && !cp.pending_question;
  if (hit) { await event("stop-after-durable-save", { stop, digest: resume.revision_digest }); throw interrupted(); }
}
const onCheckpoint: NonNullable<ModelActionRuleDraftInput["onCheckpoint"]> = async (next, metadata) => mutate(async permit => {
  if (metadata?.expected_checkpoint_digest) assert.equal(cp?.digest, metadata.expected_checkpoint_digest);
  assertActionLogicalTurnJournalAdvance(cp, next);
  if (metadata?.ordinary_completion) {
    const closed = metadata.ordinary_completion;
    assert.equal(canonicalJsonDigest(authoringQuestionSequenceCompletion([closed.completion])), canonicalJsonDigest(closed.completion));
    assert.equal(canonicalJsonDigest(next.logical_turns?.at(-1)?.completed), canonicalJsonDigest(closed));
    assert.equal(closed.material_digest, actionVersionlessMaterial(next));
    resume.generation_recovery = closed.kind === "ordinary_clarification"
      ? authoringQuestionCheckpoint(resume.generation_recovery, next)
      : authoringActionCheckpoint(resume.generation_recovery!, closed.completion,
        { consumer: "action_rule_components", kind: "compiled_draft", material_digest: closed.material_digest });
  } else if (next.pending_version) {
    const q = resume.operator_questions?.find(q => q.id === next.pending_version!.question_id); assert(q);
    if (metadata?.version_completion && (q.presentation || q.terminal_failure)) {
      const phase = q.terminal_failure?.stage === "present" ? "present" : q.proposal || q.terminal_failure ? "answer-map" : "present";
      resume.generation_recovery = authoringActionCheckpoint(resume.generation_recovery!, metadata.version_completion,
        { consumer: "action_rule_components", kind: "version_interpretation", material_digest: actionVersionMaterialDigest(next, q, phase) });
    }
    assertActionVersionQuestionHandoff(resume, next);
  } else if (!cp?.pending_version) {
    if (next.pending_question && canonicalJsonDigest(next.pending_question) !== canonicalJsonDigest(cp?.pending_question ?? null))
      resume.generation_recovery = authoringQuestionCheckpoint(resume.generation_recovery, next);
    else if (cp?.pending_question && !next.pending_question)
      resume.generation_recovery = authoringQuestionAnswerCheckpoint(resume.generation_recovery, cp, next);
  }
  cp = next; await persist(permit); await checkpointBoundary();
});
// Reuse the producer's material function; never synthesize a completion.
import { actionLogicalTurnMaterialDigest as actionVersionlessMaterial } from "../action-rule-authoring-checkpoint.js";
const stageVersionQuestion: NonNullable<ModelActionRuleDraftInput["stageVersionQuestion"]> = request => ({
  ...prepareActionVersionField({ ...request, inspection, generationLock: build.lock }), question: facts.question,
});
const requestJson: NonNullable<NonNullable<ModelActionRuleDraftInput["session"]["dependencies"]>["requestJson"]> = async request => {
  assert.equal(held, 0, "No provider callback holds a writer lease"); counts.requests++;
  const body = request.body as { tools: Array<{ name: string; parameters: any }> };
  const visible = modelVisibleUserText(body);
  let name: string, args: unknown;
  if (body.tools.some(tool => tool.name === "runner__propose_operator_decision")) {
    name = "runner__propose_operator_decision";
    const q = modelVisibleJsonLine<{ question_id: string; revision: number; raw_answer?: string; answer_id?: string }>(body, "Current question");
    if (q.raw_answer === undefined) args = { question_id: q.question_id, revision: q.revision, status: "needs_information", question: facts.question };
    else {
      assert.equal(q.raw_answer, facts.raw, "Only the declared exact statement supports the positive scripted mapping");
      args = { question_id: q.question_id, revision: q.revision, answer_id: q.answer_id, status: "proposal", disposition: "proposed",
        value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } };
    }
  } else {
    assert(visible.includes("public.service_visits") && visible.includes("c09"), "Actual transmitted catalog required");
    // The producer explicitly renders its reviewed Version context. The response
    // is selected from this frame, never from the persisted question/marker.
    const catalog = modelVisibleJsonLine<{ resources: Array<{ name: string; selected_version_field?: string; version_field_options?: string[] }> }>(body, "Current normalized structural catalog");
    const resource = catalog.resources.find(row => row.name === "public.service_visits"); assert(resource); assert(resource.version_field_options?.includes("c09"));
    if (resource.selected_version_field === "c09") {
      name = "runner__submit_action_rule_draft";
      const snapshot = modelVisibleJsonLine<{ clarification_context: { context_digest: string; targets: Array<{ kind: string; phase: string }> } }>(body, "Current disabled draft");
      const tool = body.tools.find(item => item.name === name)!;
      const branch = tool.parameters.oneOf.find((item: any) => item.properties?.status?.const === "clarification");
      const phase = branch?.properties.target.properties.phase.const;
      const target = snapshot.clarification_context.targets.find(item => item.phase === phase); assert(target);
      args = { status: "clarification", question: facts.nextQuestion,
        context_digest: snapshot.clarification_context.context_digest, target };
    } else {
      name = "runner__review_version_field"; args = { resource: "public.service_visits", field: "c09" };
    }
  }
  assert(body.tools.some(tool => tool.name === name), "Tool must be in actual native frame");
  await event("request", { body, response: { name, arguments: args } });
  return { status: 200, body: { status: "completed", output: [{ type: "function_call", call_id: `local-${process.pid}-${counts.requests}`,
    name, arguments: JSON.stringify(args) }] } };
};
const session: ModelActionRuleDraftInput["session"] = { provider: "openai", model: "controlled-version-process",
  apiKey: "inert-local-decoder-only", dependencies: { requestJson } };
const reviewVersionQuestion: NonNullable<ModelActionRuleDraftInput["reviewVersionQuestion"]> = async request => {
  await assertFresh();
  const marker = request.checkpoint().pending_version;
  const prepared = request.staged ?? (marker && stageVersionQuestion({ context: request.context, resource: marker.resource, field: marker.field }));
  assert(prepared);
  const host = await createVersionQuestionHost({ question: prepared.question, review: prepared.review, outcomes: [...facts.outcomes],
    completion: request.completion, initialPendingQuestion: { operator_message: facts.intent }, access: {
      readQuestions: () => resume.operator_questions ?? [], readHandoffs: () => resume.owner_handoffs ?? [],
      readRecovery: () => resume.generation_recovery, readConversationTurns: () => resume.conversation,
      readCheckpoint: () => cp, scopeDigest: () => scope, contextDigest: async permit => { await assertFresh(permit); return context(); },
      assertFresh, assertPreparedProof: current => assert.equal(canonicalJsonDigest(prepareActionVersionField({ context: request.context,
        inspection, generationLock: build.lock, resource: current.resource, field: current.field }).review), canonicalJsonDigest(prepared.review)),
      mutate, install: (update: VersionQuestionRecordUpdate) => {
        if (update.questions) resume.operator_questions = update.questions;
        if (update.handoffs) resume.owner_handoffs = update.handoffs;
        if (Object.prototype.hasOwnProperty.call(update, "recovery")) resume.generation_recovery = update.recovery;
        if (update.conversationTurns) resume.conversation = update.conversationTurns;
      }, savePendingVersion: request.savePendingVersion, saveRawCheckpoint: async permit => { await persist(permit); await checkpointBoundary(); },
    }, interact: async (view, current) => {
      assert.equal(held, 0); await current(); await event("view", view);
      if (view.kind === "question") { counts.prompts++; assert.equal(view.preserveWhitespace, true);
        return { kind: "answer", binding: view.binding, raw: Object.hasOwn(controls, "raw") ? controls.raw! : facts.raw }; }
      if (view.kind === "readback") { counts.confirmations++; assert.equal(view.defaultValue, false);
        return { kind: "decision", binding: view.binding, accepted: Object.hasOwn(controls, "accepted") ? controls.accepted! : true }; }
      counts.pendingViews++; assert.equal(view.defaultValue, "keep");
      return { kind: "pending", binding: view.binding, choice: controls.pendingChoice ?? "keep" };
    } });
  const initial = host.ports.readQuestion();
  const result = await runVersionConversation({ binding: { ...prepared.review, scope_digest: initial.scope_digest,
    context_digest: initial.context_digest, outcomes: initial.target.outcomes }, rootQuestionId: host.rootQuestionId,
    session, actionLogicalTurnBudget: request.episodeBudget, reserveCorrection: request.reserveCorrection,
    egressAcknowledged: true, env: {}, ports: host.ports });
  if (result.state !== "confirmed") return undefined;
  await mutate(async permit => { await host.assertCurrent(permit); assert.equal(host.ports.readQuestion().digest, result.question.digest);
    resume.reviewed_version_fields = [prepared.review]; await persist(permit); });
  return prepared;
};
async function run() {
  await fs.mkdir(root!, { recursive: true, mode: 0o700 });
  if (mode === "start") {
    sources = newPolicySourceSession(); sources.snapshots.push(policyTextSnapshot(Buffer.from(facts.source), "declared-rules.txt")); sources.active = 1;
    await savePolicySources(root!, sources, { expectedDigest: null });
    await fs.writeFile(path.join(root!, "fixture-context.json"), JSON.stringify({ sourceId: sources.id, fixtureDigest, binding, inspection,
      readBoundary, facts, scope: "SYNTHETIC_NATIVE_PRODUCER_HOST_CALLER_NO_DB_NO_ACTIVE_AUTHORITY" }), { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(root!, "current-context.json"), JSON.stringify({ inspection, readBoundary, scope }), { flag: "wx", mode: 0o600 });
    resume = buildBoundaryAuthoringResumeState({ ...base, policySourceSession: sources.id,
      action: { intent: facts.intent, strategy: "rule_derived", intents: [facts.intent], intended_outcomes: [...facts.outcomes] } });
    await writeBoundaryAuthoringResumeState(root!, resume, { expectedRevisionDigest: null });
    committed = structuredClone(resume);
  } else {
    const manifest = JSON.parse(await fs.readFile(path.join(root!, "fixture-context.json"), "utf8"));
    sources = await loadPolicySources(root!, manifest.sourceId);
    const loaded = await readBoundaryAuthoringResumeState(root!, binding); assert.equal(loaded.status, "ready");
    if (loaded.status !== "ready") throw new Error("Actual saved Resume required"); resume = loaded.value; committed = structuredClone(resume); cp = resume.action?.checkpoint;
  }
  return withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => resume.generation_recovery,
      current: async () => { await assertFresh(); return context(); }, write: async recovery => {
        resume.generation_recovery = recovery;
        try { await persist(); } catch (error) { await event("native-journal-save-failed", { error: String(error) }); throw error; }
      }, progress: () => undefined });
    return generateModelActionRuleDraft({ authoringProtocol: base.authoringProtocol, session, intent: facts.intent, operatorStatements: [facts.intent, facts.source],
      builtCatalog, readBoundary, readBoundaryDigest: canonicalJsonDigest(readBoundary), egressAcknowledged: true, env: {},
      checkpoint: cp, onCheckpoint, stageVersionQuestion, reviewVersionQuestion,
      reviewVersionField: async request => { await assertFresh(); const prepared = prepareActionVersionField({ ...request, inspection, generationLock: build.lock });
        assert.equal(canonicalJsonDigest(prepared.review), canonicalJsonDigest(request.previousReview)); return prepared; },
      assertLogicalTurnBoundary: async request => { await assertFresh(); assert.equal(cp?.digest, request.checkpoint.digest);
        assert(!request.checkpoint.pending_version && !request.checkpoint.pending_question, "No skipped pending consumer"); },
      askClarification: async question => { counts.ordinaryPrompts++; assert.equal(question, facts.nextQuestion);
        assert(cp?.pending_question?.completion && !cp.pending_version && cp.reviewed_version_fields?.length === 1);
        const completion = cp.pending_question.completion;
        const op = resume.generation_recovery?.operations.find(op => op.id === completion.operation_id);
        assert.equal(op?.state, "checkpointed"); assert.equal(op?.question_handoff?.consumer, "action_rule_clarification");
        await event("returned-to-action-caller", { checkpoint: cp.digest, completion, question });
        if (stop === "returned") throw interrupted(); return undefined;
      } });
  });
}
let state = "returned", errorMessage: string | undefined;
try { await run(); } catch (error) {
  if ((error as { controlledStop?: string }).controlledStop === stop || String(error).includes(`CONTROLLED_VERSION_PROCESS_INTERRUPTION:${stop}`)) state = "interrupted";
  else if ((error as { code?: string }).code === "ASK_CANCELLED") state = "pending";
  else { state = "failed"; errorMessage = String(error); }
}
const durable = await readBoundaryAuthoringResumeState(root!, binding);
assert.equal(durable.status, "ready", `Durable Resume unavailable after ${state}: ${errorMessage}`); if (durable.status !== "ready") throw new Error("Durable Resume unavailable");
await event("closed", { state, counts, errorMessage });
console.log(JSON.stringify({ pid: process.pid, state, counts, errorMessage, resume: durable.value,
  sources: await loadPolicySources(root!, sources!.id), fixtureDigest }));
if (state === "failed") process.exitCode = 1;
