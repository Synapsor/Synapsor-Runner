import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { projectAuthoringReadScopeContext } from "./authoring-read-scope-context.js";
import { ownerQuestionScopeDigest, ownerQuestionContextDigest } from "./authoring-owner-question-binding.js";
import { authoringDestination } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { planModelBoundaryJob, prepareBoundaryJobPlanningInvocation, type BoundaryJobCurrentState, type StructuredReadPlanningContext } from "./boundary-job-model.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringPlanningCheckpoint } from "./authoring-generation-recovery.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { READ_SCOPE_PROTOCOL } from "./read-structured-scope.js";
import { appendBoundaryPlanningResult, assertBoundaryPlanningHistoryAdvance, parseBoundaryPlanningResult, type BoundaryPlanningResult } from "./authoring-planning-result.js";
import { assertCurrentAuthoringEnvelope, STRUCTURED_AUTHORING_PROTOCOL_VERSION, STRUCTURED_AUTHORING_RESUME_VERSION } from "./authoring-protocol.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture(noRead = false, program = false, correction = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "planning-native-")); dirs.push(root); await fs.chmod(root, 0o700);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const { context } = prepared, boundary = context.candidate;
  const base = { binding: boundaryAuthoringResumeBinding(context.bundle), stage: "planning" as const,
    jobIntent: noRead ? "Keep this job without reading any records." : program ? "Use Cursor. Show my item labels and prepare independent record_one and record_two effects." : "Show my item labels.", provider: "openai" as const, model: "controlled" };
  let state = buildBoundaryAuthoringResumeState(base);
  await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
  const conversation = createModelAuthoringConversation();
  let calls = 0, fault: "none" | "before" | "after" | "mutate" = "none";
  const session = { provider: base.provider, model: base.model, apiKey: "inert-local-credential", conversation };
  const scope = () => ownerQuestionScopeDigest({ job: base.jobIntent, model: { provider: session.provider,
    model: session.model, destination: authoringDestination(session) } });
  const qcontext = () => ownerQuestionContextDigest({ scope: scope(), binding: state.binding, candidate: boundary,
    readerSchema: context.lock.schema_fingerprint, readerRole: context.lock.role_posture_fingerprint });
  const persist = async (next: typeof state, permit?: ProjectAuthorityMutationPermit) => {
    await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: state.revision_digest, permit }); state = next;
  };
  const project = async () => projectAuthoringReadScopeContext({ resume: state, boundary,
    structuralReview: await loadBoundaryReviewContext(root), records: { questions: state.operator_questions ?? [],
      handoffs: state.owner_handoffs ?? [], generation: state.generation_recovery }, answerQuestionIds: [] });
  const native = createNativeReadScope({ projectRoot: root, ports: {
    snapshot: () => ({ resume: state, revision: state.revision_digest, blocked: false, questions: state.operator_questions ?? [],
      handoffs: state.owner_handoffs ?? [], generation: state.generation_recovery, read: state.read }),
    assertCurrent: async permit => { const loaded = await readBoundaryAuthoringResumeState(root, state.binding);
      if (loaded.status !== "ready" || loaded.value.revision_digest !== state.revision_digest) throw new Error("CURRENT_CHANGED"); },
    questionScope: scope, questionContext: async () => qcontext(), failure: text => new Error(`CHECKPOINT_NOT_SAVED: ${text}`),
    mutate: run => withProjectAuthorityMutation(root, run),
    save: async (next, permit) => {
      if (fault === "before") throw new Error("INJECTED_BEFORE_SAVE");
      if (fault === "mutate") { const q = next.questions.at(-1)!; q.context_digest = d("foreign context"); const { digest: _digest, ...body } = q; q.digest = d(body); }
      await persist(buildBoundaryAuthoringResumeState({ ...base, previous: state, conversation: conversation.turns,
        operatorQuestions: next.questions, generationRecovery: next.generation, planningResult: next.planningResult,
        stage: next.stage }), permit);
      if (fault === "after") throw new Error("INJECTED_ACK_LOST");
    },
  }, interact: async view => ({ kind: "decision", accepted: false, binding: view.binding }) });
  const currentState: BoundaryJobCurrentState = { read: { boundary_name: boundary.pack.name, authority: "disabled",
    fully_reviewed: false, resource_ids: ["work.items"], exact_reusable_revision_count: 0 }, actions: [],
    control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger", model_may_supply_scope_values: false, model_may_supply_approval_history: false } };
  const input = { session: { ...session, dependencies: { requestJson: async (actual: { body: unknown }) => {
    calls++;
    const find = (value: unknown): StructuredReadPlanningContext | undefined => {
      if (typeof value === "string") for (const line of value.split("\n")) if (line.startsWith("Host Read context: ")) return JSON.parse(line.slice("Host Read context: ".length));
      if (value && typeof value === "object") for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
      return undefined;
    };
    const visible = find(actual.body); if (!visible) throw new Error("ACTUAL_CONTEXT_MISSING");
    const ref = visible.references.find(ref => ref.kind === "request")!;
    const resource = visible.catalog.resources.find(r => r.id === "work.items")!;
    const subject = visible.catalog.subject_scopes?.find(s => s.root_resource === resource.id)!;
    const read_scope = { protocol: READ_SCOPE_PROTOCOL, original_request: ref.id, applicability: noRead ? "no_read_requested" : "read_requested",
      requirements: noRead ? [] : [{ id: "labels", references: [ref.id], intended_use: base.jobIntent, disposition: "include",
        subjects: [{ root_resource: resource.id, mode: "reviewed_resource", scope_reference: subject.reference }],
        targets: [{ root_resource: resource.id, resource: resource.id, operation: "resource" },
          { root_resource: resource.id, resource: resource.id, operation: "return", field: "label" }] }] };
    return { status: 200, body: { output: [{ type: "function_call", call_id: `plan${calls}`, name: "runner__plan_boundary_job",
      arguments: JSON.stringify({ status: "planned", read_mode: noRead ? "none" : "create", ...(noRead ? {} : { read_intent: base.jobIntent }),
        action_mode: correction && calls === 1 ? "invalid_route" : program ? "create" : "none", ...(program ? { action_intent: "Prepare record_one effect.", action_intents: ["Prepare record_one effect.", "Prepare record_two effect."], action_outcomes: ["record_one", "record_two"], action_strategy: "rule_derived", intended_client: "cursor" } : {}), read_scope, summary: "Keep the declared interpretation pending for its ordinary review." }) }] } };
  } } }, jobIntent: base.jobIntent, ...(program ? { workflow: "program" as const } : {}), currentState, availableResourceIds: ["work.items"], egressAcknowledged: true,
    structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: project } };
  const produce = () => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery,
      current: async () => qcontext(), progress: () => {}, write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...base,
        previous: state, conversation: conversation.turns, generationRecovery })) });
    const plan = await planModelBoundaryJob(input); if (plan.state !== "planned") throw new Error("EXPECTED_PLAN");
    return { plan, stored: await native.recordPlanning(plan) };
  });
  return { root, native, input, produce, calls: () => calls, state: () => state, fault: (value: typeof fault) => { fault = value; },
    reload: async () => { const loaded = await readBoundaryAuthoringResumeState(root, state.binding); if (loaded.status !== "ready") throw new Error(loaded.status);
      state = loaded.value; conversation.turns = structuredClone(state.conversation); return state; } };
}

describe("prospective complete planning checkpoint", () => {
  it("stores the genuine plan and consumed sequence together and reloads without another planner call", async () => {
    const f = await fixture(), { stored } = await f.produce();
    expect(f.state().schema_version).toBe("synapsor.boundary-authoring-resume.v4");
    expect(f.state().authoring_protocol?.version).toBe("synapsor.structured-authoring.v3");
    const before = structuredClone(f.state().generation_recovery); await f.reload();
    const invocation = await prepareBoundaryJobPlanningInvocation(f.input, stored);
    const restored = await f.native.restorePlanning(invocation);
    expect(restored.read_scope).toEqual(stored.plan.read_scope); expect(restored.read_scope?.analysis_digest).toBeUndefined();
    expect(f.state().operator_questions?.at(-1)?.confirmation).toBeUndefined(); expect(f.state().read).toBeUndefined();
    expect(f.calls()).toBe(1); expect(f.state().generation_recovery).toEqual(before);
    await expect(f.native.recordPlanning(structuredClone(restored))).rejects.toThrow(/INVALID/);
    expect(await f.native.pendingPlanning((await loadBoundaryReviewContext(f.root)).candidate)).toMatchObject({ result: stored });
  });
  it("retains the complete declared multi-Action routing and client preference across native reload", async () => {
    const f = await fixture(false, true), { stored } = await f.produce(); await f.reload();
    const restored = await f.native.restorePlanning(await prepareBoundaryJobPlanningInvocation(f.input, stored));
    expect(restored).toMatchObject({ action_mode: "create", action_outcomes: ["record_one", "record_two"],
      action_intents: ["Prepare record_one effect.", "Prepare record_two effect."], intended_client: "cursor", authority_granted: false });
    expect(f.state().action).toBeUndefined(); expect(f.calls()).toBe(1);
  });
  it("retains both real consumed turns and spent correction allowance across cold native continuation", async () => {
    const f = await fixture(false, false, true), { stored } = await f.produce();
    expect(stored.plan.correction_used).toBe(true); expect(f.calls()).toBe(2);
    const before = structuredClone(f.state().generation_recovery); expect(before?.operations).toHaveLength(2);
    expect(before?.operations.every(op => op.state === "checkpointed")).toBe(true);
    expect(before?.episodes?.some(episode => episode.correction_used)).toBe(true);
    await f.reload(); await f.native.restorePlanning(await prepareBoundaryJobPlanningInvocation(f.input, stored));
    expect(f.state().generation_recovery).toEqual(before); expect(f.calls()).toBe(2);
  });
  it("keeps no-Read unconfirmed until its separate explicit default-No review", async () => {
    const f = await fixture(true), { stored } = await f.produce();
    expect(f.state().operator_questions?.at(-1)?.proposal).toBeUndefined();
    expect(await f.native.review(stored.read_scope_question_id)).toMatchObject({ state: "pending" });
    expect(f.calls()).toBe(1); expect(f.state().operator_questions?.at(-1)?.confirmation).toBeUndefined();
  });
  it.each(["model", "job", "clarification", "history"])("refuses changed %s without replay", async change => {
    const f = await fixture(), { stored } = await f.produce();
    const input = { ...f.input, session: { ...f.input.session } };
    if (change === "model") input.session.model = "different";
    if (change === "job") input.jobIntent = "Show a different scope.";
    if (change === "clarification") Object.assign(input, { clarificationAnswer: "A new operator answer." });
    if (change === "history") input.session.conversation.turns.push({ question: "New question", answer: "New answer", kind: "clarification" });
    await expect((async () => f.native.restorePlanning(await prepareBoundaryJobPlanningInvocation(input, stored)))()).rejects.toThrow(/STALE/);
    expect(f.calls()).toBe(1);
  });
  it.each(["before", "after", "mutate"] as const)("preserves actual save outcome on %s fault", async fault => {
    const f = await fixture(); f.fault(fault);
    await expect(f.produce()).rejects.toThrow(fault === "mutate" ? /CHECKPOINT_NOT_SAVED/ : /INJECTED_/);
    await f.reload(); expect(f.calls()).toBe(1);
    if (fault === "before") expect(f.state().planning_result).toBeUndefined();
    else expect(f.state().planning_result).toBeDefined();
    if (fault === "after") {
      f.fault("none"); const stored = f.state().planning_result!;
      expect(await f.native.restorePlanning(await prepareBoundaryJobPlanningInvocation(f.input, stored))).toMatchObject({ state: "planned" });
      expect(f.calls()).toBe(1);
    }
    if (fault === "mutate") expect(f.state().operator_questions?.at(-1)?.context_digest).toBe(d("foreign context"));
  });
  it("rejects old format and malformed material rather than migrating or acknowledging historical completion", async () => {
    expect(STRUCTURED_AUTHORING_RESUME_VERSION).toBe("synapsor.boundary-authoring-resume.v4");
    expect(STRUCTURED_AUTHORING_PROTOCOL_VERSION).toBe("synapsor.structured-authoring.v3");
    expect(() => assertCurrentAuthoringEnvelope({ schema_version: "synapsor.boundary-authoring-resume.v3", authoring_protocol: { version: "synapsor.structured-authoring.v2" } })).toThrow(/older version/);
    const f = await fixture(), { stored } = await f.produce();
    expect(() => parseBoundaryPlanningResult({ ...stored, plan: { ...stored.plan, approved: true } })).toThrow(/INVALID/);
    const contradictory = { ...stored.plan, operation: "review_rules" };
    expect(() => parseBoundaryPlanningResult({ ...stored, plan: contradictory, material_digest: d(contradictory) })).toThrow();
    expect(() => authoringPlanningCheckpoint(f.state().generation_recovery, stored.completion, stored.material_digest)).toThrow();
    expect(f.calls()).toBe(1);
    // Execute the actual immutable old discriminator, not a reimplemented predicate.
    const old = execFileSync("git", ["show", "9f8fe16f:apps/runner/src/authoring-protocol.ts"], { encoding: "utf8" });
    const js = ts.transpileModule(old, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
    const original = JSON.stringify(f.state());
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const old = await import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(js).toString("base64"))});
       let refused=false; try { old.assertCurrentAuthoringEnvelope(JSON.parse(process.argv[1])); } catch { refused=true; }
       if(!refused)process.exit(2); process.stdout.write("REFUSED");`, original], { encoding: "utf8" });
    expect(output).toBe("REFUSED"); expect(JSON.stringify(f.state())).toBe(original);
    expect(f.state().planning_results).toEqual([stored]);
    expect(appendBoundaryPlanningResult([stored], stored)).toEqual([stored]);
    expect(() => assertBoundaryPlanningHistoryAdvance([stored], [])).toThrow(/INVALID/);
    const mutated = { ...stored, plan: { ...stored.plan, summary: "Altered historical result" } };
    mutated.material_digest = d(mutated.plan);
    expect(() => appendBoundaryPlanningResult([stored], mutated)).toThrow(/INVALID/);
  });
});
