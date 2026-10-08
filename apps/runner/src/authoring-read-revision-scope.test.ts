import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION, type ReadWorkloadSet } from "./read-workload-assist.js";
import { storeReadWorkloadAnalysis, readReadWorkloadAnalysis } from "./read-workloads.js";
import { prepareReadRevisionAnalysis, storeCommittedReadRevisionAnalysis } from "./authoring-read-revision-scope.js";

// Actual disposable native structural review and compiler, never hand-authored
// positive confirmations, stored workload hashes or candidate mutation receipts.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(filtered = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-revision-analysis-")); roots.push(root);
  const f = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { filterable_fields: ["label"] } });
  const original: ReadWorkloadSet = { schema_version: READ_WORKLOAD_SET_VERSION, name: "declared item labels",
    source: { kind: "operator_exact_plan" }, allowed: [{ id: "labels", description: "Show my item labels", plan: {
      kind: "rows", resource: "work.items", select: ["label"], ...(filtered ? { where: [{ field: "label", op: "eq", value: "Declared label" }] } : {}),
    } }], forbidden: [] };
  const analysis = analyzeReadWorkloadSet({ workload: original, generatedBoundary: f.context.candidate });
  expect(analysis.status).toBe("ready");
  const selected = await storeReadWorkloadAnalysis({ projectRoot: root, generatedBoundary: f.context.candidate, source: original.source, analysis });
  const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: "work.items", metadata: { label: "Customer items" },
    actor: "declared fixture operator", reason: "Change only the displayed register label; preserve all access." }, async () => f.inspection);
  const expected = { analysis_id: selected.analysis_id, analysis_digest: selected.analysis_digest };
  const input = { selected, expected, currentBoundary: f.context.candidate, preparedCandidate: preview.candidate };
  return { ...f, root, selected, preview, original, expected, input };
}
it("reanalyzes exact saved unredacted plans on the real preview and stores no review after a guarded disabled save", async () => {
  const f = await fixture(), prepared = prepareReadRevisionAnalysis(f.input);
  expect(prepared.state).toBe("analyzed");
  expect(prepared.analysis?.allowed).toHaveLength(1); expect(prepared.analysis?.authority_atoms).toEqual(f.selected.analysis.authority_atoms);
  expect(prepared.analysis?.candidate?.pack.resources[0]?.label).toBe("Customer items");
  expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.context.candidate);
  await commitBoundaryResourceReviewMutation(f.root, f.preview);
  const current = await loadBoundaryReviewContext(f.root);
  const saved = await storeCommittedReadRevisionAnalysis({ projectRoot: f.root, prepared, expected: f.expected, committedCandidate: current.candidate });
  expect(saved.analysis).toEqual(prepared.analysis); expect(saved.review).toBeUndefined();
  expect(saved.authority_granted).toBe(false); expect(saved.source_database_changed).toBe(false);
  const cold = await readReadWorkloadAnalysis({ projectRoot: f.root, analysisId: saved.analysis_id, generatedBoundary: current.candidate });
  expect(cold.analysis_digest).toBe(saved.analysis_digest); expect(cold.review).toBeUndefined();
});
it.each(["selection", "analysis", "current_candidate"] as const)("rejects %s drift before deriving a replacement analysis", async mode => {
  const f = await fixture(), changed = structuredClone(f.input);
  if (mode === "selection") changed.expected.analysis_id = "foreign_saved_analysis";
  if (mode === "analysis") changed.expected.analysis_digest = `sha256:${"0".repeat(64)}`;
  if (mode === "current_candidate") changed.currentBoundary.pack.resources[0]!.label = "Another concurrent revision";
  expect(() => prepareReadRevisionAnalysis(changed)).toThrow("READ_REVISION_WORKLOAD_CHANGED");
});
it("keeps missing or nonexact stored plans pending rather than turning settings into workload coverage", async () => {
  const f = await fixture();
  expect(prepareReadRevisionAnalysis({ ...f.input, selected: undefined })).toMatchObject({ state: "pending_mapping", reason: "no_saved_workload" });
  const changed = structuredClone(f.input); changed.selected.analysis.allowed[0]!.plan_shape!.select = ["tenant_id"];
  const result = prepareReadRevisionAnalysis(changed);
  expect(result).toMatchObject({ state: "pending_mapping", reason: "exact_plan_unavailable" }); expect(result.analysis).toBeUndefined();
  await expect(storeCommittedReadRevisionAnalysis({ projectRoot: f.root, prepared: result, expected: f.expected,
    committedCandidate: f.preview.candidate })).rejects.toThrow("READ_REVISION_MAPPING_PENDING");
});
it("never substitutes placeholder literals; only the exact still-live original input permits filtered reanalysis", async () => {
  const f = await fixture(true), pending = prepareReadRevisionAnalysis(f.input);
  expect(pending).toMatchObject({ state: "pending_mapping", reason: "exact_plan_unavailable" }); expect(pending.analysis).toBeUndefined();
  const actual = prepareReadRevisionAnalysis({ ...f.input, originalWorkload: f.original });
  expect(actual.state).toBe("analyzed"); expect(actual.analysis?.workload_digest).toBe(f.selected.analysis.workload_digest);
  const changed = structuredClone(f.original); (changed.allowed[0]!.plan.where as Array<{value:string}>)[0]!.value = "Different business literal";
  expect(() => prepareReadRevisionAnalysis({ ...f.input, originalWorkload: changed })).toThrow("READ_REVISION_WORKLOAD_CHANGED");
});
it("refuses a committed candidate different from the actual prepared revision", async () => {
  const f = await fixture(), prepared = prepareReadRevisionAnalysis(f.input);
  await expect(storeCommittedReadRevisionAnalysis({ projectRoot: f.root, prepared, expected: f.expected,
    committedCandidate: f.context.candidate })).rejects.toThrow("READ_REVISION_WORKLOAD_CHANGED");
});

it("keeps a real privacy-restricted preview pending when it no longer supports the retained workload", async () => {
  const f = await fixture();
  const narrower = await prepareBoundaryResourceReviewMutation(f.root, { resource_id: "work.items", selectable_fields: [],
    actor: "declared fixture operator", reason: "Remove model return of item labels; no replacement plan has been mapped." }, async () => f.inspection);
  const result = prepareReadRevisionAnalysis({ ...f.input, preparedCandidate: narrower.candidate });
  expect(result).toMatchObject({ state: "pending_mapping", reason: "retained_workload_blocked", analysis: { status: "blocked" } });
  expect(result.analysis?.allowed[0]?.status).toBe("blocked");
  expect(result.workload?.allowed[0]?.plan.select).toEqual(["label"]);
  await expect(storeCommittedReadRevisionAnalysis({ projectRoot: f.root, prepared: result, expected: f.expected,
    committedCandidate: narrower.candidate })).rejects.toThrow("READ_REVISION_MAPPING_PENDING");
});

import { buildBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { projectAuthoringReadScopeContext, projectAuthoringReadScopePreview } from "./authoring-read-scope-context.js";
function contextInput(f: Awaited<ReturnType<typeof fixture>>) {
  return { boundary: f.context.candidate, structuralReview: f.context, records: { questions: [], handoffs: [] },
    resume: buildBoundaryAuthoringResumeState({ binding: { boundary_name: f.context.candidate.pack.name,
      generation_lock_fingerprint: f.context.candidate.generation_lock_fingerprint, schema_fingerprint: f.context.lock.schema_fingerprint,
      role_posture_fingerprint: f.context.lock.role_posture_fingerprint }, stage: "authority_review",
      jobIntent: "Show the signed-in person's item labels; preserve every existing restriction.", provider: "openai", model: "scripted" }) };
}
it("projects the real label preview using only unchanged acknowledged subject bindings, without a future review bundle", async () => {
  const f = await fixture(), input = contextInput(f), current = projectAuthoringReadScopeContext(input);
  expect(current.catalog.subject_scopes).toHaveLength(1);
  const preview = projectAuthoringReadScopePreview({ ...input, preparedCandidate: f.preview.candidate, preparedLock: f.preview.build.lock });
  expect(preview.catalog.subject_scopes).toEqual(current.catalog.subject_scopes);
  expect(preview.references).toEqual(current.references);
  expect(preview.binding.meaning_digest).toBe(current.binding.meaning_digest);
  expect(preview.binding.applicability_digest).toBe(current.binding.applicability_digest);
  expect(preview.binding.operation_digest).not.toBe(current.binding.operation_digest);
  expect(preview).not.toHaveProperty("native"); expect(preview).not.toHaveProperty("confirmation");
  expect(() => projectAuthoringReadScopeContext({ ...input, boundary: f.preview.candidate })).toThrow("READ_SUBJECT_CONTEXT_CHANGED");
});
it.each(["removed", "changed_subject", "trusted_context"] as const)("drops old subject acknowledgment when the preview has %s", async mode => {
  const f = await fixture(), input = contextInput(f), preparedCandidate = structuredClone(f.preview.candidate);
  if (mode === "removed") preparedCandidate.pack.resources = [];
  if (mode === "changed_subject") delete preparedCandidate.pack.resources[0]!.principal_key;
  if (mode === "trusted_context") preparedCandidate.trusted_context.principal_env = "DIFFERENT_TRUSTED_PRINCIPAL";
  const preview = projectAuthoringReadScopePreview({ ...input, preparedCandidate, preparedLock: f.preview.build.lock });
  expect(preview.catalog.subject_scopes).toEqual([]); expect(preview).not.toHaveProperty("confirmation");
});
it.each(["current_review", "preview_role"] as const)("rejects %s drift rather than copying its old native acknowledgment", async mode => {
  const f = await fixture(), input = contextInput(f), preparedCandidate = structuredClone(f.preview.candidate);
  if (mode === "current_review") { input.structuralReview = structuredClone(f.context); input.structuralReview.progress!.confirmations.find(confirmation => confirmation.kind === "principal_scope")!.input_digest = `sha256:${"0".repeat(64)}`; }
  else preparedCandidate.role_posture_fingerprint = `sha256:${"0".repeat(64)}`;
  if (mode === "preview_role") expect(() => projectAuthoringReadScopePreview({ ...input, preparedCandidate, preparedLock: f.preview.build.lock })).toThrow("READ_SUBJECT_CONTEXT_CHANGED");
  else expect(projectAuthoringReadScopePreview({ ...input, preparedCandidate, preparedLock: f.preview.build.lock }).catalog.subject_scopes).toEqual([]);
});

it.each(["prepared_lock", "schema", "source", "role"] as const)("refuses %s drift even when a preview advertises unchanged subject configuration", async mode => {
  const f = await fixture(), input = contextInput(f), preparedCandidate = structuredClone(f.preview.candidate),
    preparedLock = structuredClone(f.preview.build.lock);
  if (mode === "prepared_lock") preparedLock.generated_contract_digest = `sha256:${"0".repeat(64)}`;
  if (mode === "schema") preparedLock.schema_fingerprint = `sha256:${"0".repeat(64)}`;
  if (mode === "source") preparedLock.source_env = "ANOTHER_SOURCE";
  if (mode === "role") {
    preparedLock.role_posture_fingerprint = `sha256:${"0".repeat(64)}`;
    preparedCandidate.role_posture_fingerprint = preparedLock.role_posture_fingerprint;
  }
  if (mode !== "prepared_lock") preparedCandidate.generation_lock_fingerprint = canonicalJsonDigest(preparedLock);
  expect(() => projectAuthoringReadScopePreview({ ...input, preparedCandidate, preparedLock })).toThrow("READ_SUBJECT_CONTEXT_CHANGED");
});
