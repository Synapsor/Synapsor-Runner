import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseSharedSumDesignation } from "@synapsor-runner/action-rules";
import { experimentalSharedSumFixture } from "../../../packages/action-rules/src/testing/experimental-shared-sum-fixture.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { READ_REVIEW_PROTOCOL, OPERATOR_READ_REVIEW_PROTOCOL, parseReadAuthoringDocument,
  parseOperatorReadEntryQuestions, assertOperatorReadQuestionInventoryAdvance } from "./control-policy-read-authoring.js";
import { encodeOperatorAuthority, decodeOperatorAuthority } from "./control-policy-authority-codec.js";
import { OPERATOR_READ_POLICY_RECORD_VERSION } from "./control-policy-record.js";
import { parseOperatorSubmissionOrigin } from "./authoring-operator-submission-origin.js";
import { parseReadScopeQuestionBinding, readScopeModelCompletion } from "./authoring-read-scope-binding.js";
import { createReadScopeQuestion } from "./authoring-read-scope-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal } from "./read-structured-scope.js";
import { READ_WORKLOAD_SET_VERSION, normalizeReadWorkloadSet, analyzeReadWorkloadSet, readWorkloadSetDigest } from "./read-workload-assist.js";
import { storeReadWorkloadAnalysis, readStoredReadWorkloadAnalysis } from "./read-workloads.js";
import { buildBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { parseOperatorQuestion, parseOperatorQuestions } from "./authoring-operator-question.js";
import { parseSharedSumQuestionBinding, assertSharedSumQuestionGeneration } from "./authoring-shared-sum-binding.js";
import { prepareSharedSumOperatorQuestion, projectReviewedSharedSumQuestion } from "./authoring-shared-sum-question.js";
import { structuredTestAction } from "./structured-authoring-test-fixture.js";

// Format/compatibility controls. Ordinary structural setup supplies the native
// document, and the actual compiler/store supply immutable workload records.
// Syntax fixtures below do NOT prove native submission custody, confirmation,
// public routing, installed behavior, activation or source effects.
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-codec-")); await fs.chmod(root, 0o700);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const native = await readProjectReadAuthoring(root); if (!native?.selected) throw new Error("Native structural entry missing");
  const workload = normalizeReadWorkloadSet({ schema_version: READ_WORKLOAD_SET_VERSION, name: "Exact declared label workload",
    source: { kind: "operator_exact_plan" }, allowed: [{ id: "labels", description: "Return the reviewed item label",
      plan: { kind: "rows", resource: "work.items", select: ["label"] } }],
    forbidden: [{ id: "private_notes", description: "Keep private notes outside the task",
      plan: { kind: "rows", resource: "work.items", select: ["internal_note"] } }] });
  const analysis = analyzeReadWorkloadSet({ workload, generatedBoundary: prepared.context.candidate });
  const stored = await storeReadWorkloadAnalysis({ projectRoot: root, generatedBoundary: prepared.context.candidate, source: workload.source, analysis });
  const text = "Show item labels for the signed-in person", request = { kind: "request" as const, id: "declared_request", digest: d(text), text };
  const hash = d("declared syntax binding"), scopeBinding = { request_digest: request.digest, source_digest: hash,
    catalog_digest: hash, meaning_digest: hash, applicability_digest: hash, operation_digest: hash };
  const record = resolveReadScopeProposal({ protocol: READ_SCOPE_PROTOCOL, original_request: request.id, applicability: "read_requested",
    requirements: [{ id: "labels", intended_use: text, references: [request.id], disposition: "include", subjects: [{ root_resource: "work.items", mode: "trusted_principal" }],
      targets: [{ root_resource: "work.items", resource: "work.items", operation: "resource" },
        { root_resource: "work.items", resource: "work.items", operation: "return", field: "label" }] }] },
    { expectedBinding: scopeBinding, references: [request], catalog: { resources: [{ id: "work.items", fields: [{ id: "label" }] }], relationships: [] }, analysis });
  const origin = parseOperatorSubmissionOrigin({ kind: "operator_submission", route: "structured_file", submission_digest: d({ workload, record }),
    review_bundle_digest: d({ workload, record }), bindings: native.bindings, entry_id: native.selected.progress.boundary_id,
    candidate_digest: native.selected.progress.candidate_digest, action_baseline_digest: null });
  const binding = parseReadScopeQuestionBinding({ version: 2, mode: "review", origin, workload, record,
    analysis: { analysis_id: stored.analysis_id, analysis_digest: stored.analysis_digest, workload_digest: readWorkloadSetDigest(workload) } });
  const q = createReadScopeQuestion({ id: randomUUID(), revision: 1, scope_digest: d(text), context_digest: hash, read_scope: binding });
  const document = { schema_version: OPERATOR_READ_POLICY_RECORD_VERSION, ...structuredClone(native.authoring) };
  const withQuestions = { ...document, review_protocol: OPERATOR_READ_REVIEW_PROTOCOL,
    entries: document.entries.map(e => ({ ...e, operator_questions: [q] })) };
  return { root, native, workload, stored, record, binding, q, document, withQuestions, hash };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 30_000);
afterAll(async () => { if (f) await fs.rm(f.root, { recursive: true, force: true }); });
const reseal = (q: Record<string, unknown>) => { const { digest: _, ...body } = q; return { ...body, digest: d(body) }; };

describe("co-located operator Read codec", () => {
  it("keeps v2 structure unchanged and uses explicit v3 with pending Q5 inventory", () => {
    expect(f.document.review_protocol).toBe(READ_REVIEW_PROTOCOL);
    expect(parseReadAuthoringDocument(f.document)).toEqual(f.native.authoring);
    const parsed = parseReadAuthoringDocument(f.withQuestions);
    expect(parsed.entries[0]!.operator_questions).toEqual([f.q]);
    expect(decodeOperatorAuthority(encodeOperatorAuthority(parsed))).toEqual(parsed);
    expect(decodeOperatorAuthority(encodeOperatorAuthority(f.native.authoring))).toEqual(f.native.authoring);
    expect(f.q.version).toBe(5); expect(f.q.confirmation).toBeUndefined(); expect(f.q.raw_answer).toBeUndefined();
    expect(f.q.read_scope).not.toHaveProperty("completion");
  });
  it("keeps legacy assisted Read Q2 bytes and completion checks distinct", () => {
    const completion = { operation_id: "declared-legacy-operation", request_digest: f.hash, context_digest: f.hash, response_digest: f.hash };
    const binding = { mode: "review" as const, record: f.record, completion };
    const q = createReadScopeQuestion({ id: randomUUID(), revision: 1, scope_digest: f.q.scope_digest, context_digest: f.q.context_digest, read_scope: binding });
    expect(q.version).toBe(2); expect(q.read_scope).toEqual(binding);
    expect(readScopeModelCompletion(binding)).toEqual(completion);
    expect(() => parseOperatorQuestions([q], [])).toThrow("no exact committed native result");
    expect(() => parseOperatorQuestion(reseal({ ...q, version: 5 }))).toThrow();
  });
  it("retains full exact allowed and forbidden plans and distinct payload/envelope digests", async () => {
    const cold = await readStoredReadWorkloadAnalysis({ projectRoot: f.root, analysisId: f.stored.analysis_id });
    expect(cold.analysis_digest).toBe(f.stored.analysis_digest);
    expect(f.record.analysis_digest).toBe(d(cold.analysis));
    expect(f.record.analysis_digest).not.toBe(cold.analysis_digest);
    expect(f.q.read_scope).toMatchObject({ workload: f.workload, analysis: { analysis_id: cold.analysis_id, analysis_digest: cold.analysis_digest } });
    expect(f.q.read_scope!.record.proposal.requirements[0]!.intended_use).toBe("Show item labels for the signed-in person");
  });
  it("refuses changed plan/text, mismatched immutable id, fake model origin and completion", () => {
    if (!("version" in f.binding)) throw new Error("Operator fixture required");
    const changed = structuredClone(f.binding); changed.workload.forbidden[0]!.description = "Different retained intention";
    const plan = structuredClone(f.binding); plan.workload.allowed[0]!.plan.select = ["internal_note"];
    for (const value of [changed, plan, { ...f.binding, completion: { operation_id: randomUUID() } },
      { ...f.binding, analysis: { ...f.binding.analysis, analysis_id: `rw_${"a".repeat(32)}` } },
      { ...f.binding, workload: { ...f.workload, source: { kind: "model", provider: "openai", model: "invented" } } },
      { ...f.binding, origin: { ...f.binding.origin, job_id: randomUUID() } },
      { ...f.binding, mode: "replacement_answer", review_question_id: randomUUID() }])
      expect(() => parseReadScopeQuestionBinding(value)).toThrow();
    expect(() => readScopeModelCompletion(f.binding)).toThrow("no model completion");
  });
  it("refuses foreign entries, duplicates, branch histories and version relabeling", () => {
    const foreign = { ...f.withQuestions, entries: f.withQuestions.entries.map(e => ({ ...e,
      operator_questions: [reseal({ ...f.q, read_scope: { ...f.binding, origin: { ...("version" in f.binding ? f.binding.origin : {}), entry_id: `bnd_${"0".repeat(32)}` } } })] })) };
    expect(() => parseReadAuthoringDocument(foreign)).toThrow("FOREIGN");
    expect(() => parseOperatorReadEntryQuestions([f.q, f.q], f.native.selected!.progress.boundary_id)).toThrow("Duplicate");
    const next = createReadScopeQuestion({ id: randomUUID(), revision: 2, scope_digest: f.q.scope_digest,
      context_digest: f.q.context_digest, read_scope: { ...f.binding, predecessor_id: f.q.id } });
    const branch = { ...next, id: randomUUID() };
    expect(() => parseOperatorReadEntryQuestions([f.q, next, reseal(branch)], f.native.selected!.progress.boundary_id)).toThrow("branching");
    expect(() => parseOperatorQuestion(reseal({ ...f.q, version: 2 }))).toThrow();
    expect(() => parseReadAuthoringDocument({ ...f.withQuestions, review_protocol: READ_REVIEW_PROTOCOL })).toThrow("VERSION_UNSUPPORTED");
  });
  it("preserves immutable historical origin through an acknowledged successor and refuses erased history", () => {
    const previous = parseReadAuthoringDocument(f.withQuestions);
    const next = structuredClone(previous); next.entries[0]!.progress.revision++;
    assertOperatorReadQuestionInventoryAdvance(previous, next);
    expect(next.entries[0]!.operator_questions![0]!.read_scope).toEqual(f.binding);
    for (const changed of [{ ...next, review_protocol: READ_REVIEW_PROTOCOL },
      { ...next, entries: [] }, { ...next, entries: next.entries.map(e => ({ ...e, operator_questions: [] })) }])
      expect(() => assertOperatorReadQuestionInventoryAdvance(previous, changed)).toThrow();
  });
  it("explicitly refuses constructor and parser Resume borrowing of Q5", () => {
    const input = { binding: { boundary_name: "declared", generation_lock_fingerprint: f.hash, schema_fingerprint: f.hash,
      role_posture_fingerprint: f.hash }, stage: "planning" as const, jobIntent: "Declared compatibility fixture", provider: "openai" as const, model: "not-called" };
    expect(() => buildBoundaryAuthoringResumeState({ ...input, operatorQuestions: [f.q] })).toThrow("native Read entry");
    const state = buildBoundaryAuthoringResumeState(input);
    const { revision_digest: _, ...body } = { ...state, operator_questions: [f.q] };
    expect(() => assertBoundaryAuthoringResumeState({ ...body, revision_digest: d(body) })).toThrow("native governed Read entry");
  });
});

function sumFixture() {
  const original = experimentalSharedSumFixture().designation;
  const { schema_version: _, kind: _kind, ...fields } = original;
  const designation = parseSharedSumDesignation({ ...fields, schema_version: "synapsor.shared-sum-designation.v1", kind: "shared_sum",
    unit: { kind: "integer", unit: "declared_credits", meaning: "One declared service unit" } });
  if (!("version" in f.binding)) throw new Error("Operator fixture required");
  const actions = [structuredTestAction("first", "quantity", 20, 10), structuredTestAction("second", "quantity", 20, 10)];
  actions[0] = { ...actions[0]!, schema_version: "synapsor.action-rule-model-draft.v2", shared_sum_proposal: designation };
  const binding = parseSharedSumQuestionBinding({ version: 2, designation, actions, origin: { ...f.binding.origin, action_baseline_digest: d("disabled baseline") },
    dependencies: { context_digest: f.hash, source_digest: f.hash, catalog_digest: f.hash, generation_lock_fingerprint: f.hash,
      read_dependencies: [{ name: "declared.read", digest: f.hash }], participating_outcomes: actions.map(a => a.outcome) } });
  return { binding, designation, actions };
}
describe("operator shared SUM full-bundle codec", () => {
  it("retains mixed proposal/legacy Actions without granting technical or meaning acceptance", () => {
    const s = sumFixture(), q = prepareSharedSumOperatorQuestion({ binding: s.binding });
    expect(q.version).toBe(5); expect(parseOperatorQuestions([q], [])).toEqual([q]);
    expect(parseOperatorReadEntryQuestions([q], f.native.selected!.progress.boundary_id)).toEqual([q]);
    expect(q.shared_sum).toMatchObject({ version: 2, actions: s.actions });
    expect(q.confirmation).toBeUndefined(); expect(() => projectReviewedSharedSumQuestion(q)).toThrow("UNCONFIRMED");
    expect(() => assertSharedSumQuestionGeneration(s.binding)).toThrow();
  });
  it("refuses conflicting, absent, partial, duplicated and unsupported proposal bundles", () => {
    const { binding, designation, actions } = sumFixture();
    const conflicting = { ...actions[1], schema_version: "synapsor.action-rule-model-draft.v2",
      shared_sum_proposal: { ...designation, unit: { ...designation.unit, meaning: "Conflicting service unit" } } };
    for (const value of [{ ...binding, actions: [actions[0], conflicting] },
      { ...binding, actions: [structuredTestAction("first", "quantity", 20, 10), actions[1]] },
      { ...binding, actions: [actions[0]] }, { ...binding, actions: [actions[0], actions[0]] },
      { ...binding, actions: [{ ...actions[0], schema_version: "synapsor.action-rule-model-draft.v3" }, actions[1]] },
      { ...binding, actions: [{ ...actions[0], confirmed: true }, actions[1]] }])
      expect(() => parseSharedSumQuestionBinding(value)).toThrow();
  });
});
