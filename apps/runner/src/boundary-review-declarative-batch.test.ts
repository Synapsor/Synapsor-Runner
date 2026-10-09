import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import {
  prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation,
  prepareBoundaryReviewMutationBatch, commitBoundaryReviewMutationBatch, projectBoundaryReviewPreparationFailure,
} from "./boundary-review-mutation.js";
import { buildAutoBoundary, loadActivatedExplorationBoundary, assertCurrentExplorationBoundaryAuthority } from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { readRuntimeConfig } from "./cli-project.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import * as readOwner from "./control-policy-read-authoring-project.js";
import type { BoundaryResourceReviewRequest } from "./read-authoring-contract-types.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const actor = "declared batch reviewer";
async function fixture(schema = "work") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "declarative-review-batch-")); roots.push(root);
  const bootstrap = `${schema}.bootstrap`, replacement = `${schema}.replacement`;
  const f = await prepareReviewedReadScope(root, { resources: [bootstrap, replacement], field: "label",
    review: { allow_reviewed_fields: ["label"] } });
  const remove = await prepareBoundaryResourceReviewMutation(root, { resource_id: replacement, exclude: true, actor, reason: "Replace the declared bootstrap membership." }, async () => f.inspection);
  await commitBoundaryResourceReviewMutation(root, remove);
  const before = await loadBoundaryReviewContext(root);
  expect(before.candidate.pack.resources.map(r => r.id)).toEqual([bootstrap]);
  const requests: BoundaryResourceReviewRequest[] = [
    { resource_id: bootstrap, exclude: true, actor, reason: "Replace the declared bootstrap membership." },
    { resource_id: replacement, include: true, tenant_key: "tenant_id", principal_key: "principal_id",
      selectable_fields: ["label"], allow_reviewed_fields: ["label"], actor, reason: "Show replacement labels in the same trusted tenant and principal scope." },
  ];
  return { root, bootstrap, replacement, inspection: f.inspection, before, requests };
}

describe("declarative review batch uses one complete prospective candidate", () => {
  it.each(["work", "warehouse"])("replaces the sole saved resource in either order on %s without an intermediate save", async schema => {
    const f = await fixture(schema);
    const initial = canonicalJsonDigest(f.before);
    const forward = await prepareBoundaryReviewMutationBatch(f.root, f.requests, async () => f.inspection);
    const reverse = await prepareBoundaryReviewMutationBatch(f.root, [...f.requests].reverse(), async () => f.inspection);
    expect(forward.candidate).toEqual(reverse.candidate);
    expect(forward.candidate.pack.resources.map(r => r.id)).toEqual([f.replacement]);
    expect(canonicalJsonDigest(await loadBoundaryReviewContext(f.root))).toBe(initial);
    const saved = await commitBoundaryReviewMutationBatch(f.root, forward);
    const after = await loadBoundaryReviewContext(f.root);
    expect(after.candidate).toEqual(forward.candidate);
    expect(after.bundle.candidate_digest).toBe(saved.candidate_digest);
    expect(after.candidate.activation).toBe("disabled_unreviewed");
  });

  it("rejects a genuinely empty final candidate, duplicate targets and conflicting global declarations without saving", async () => {
    const f = await fixture();
    for (const requests of [
      [f.requests[0]!],
      [f.requests[1]!, { ...f.requests[1]!, selectable_fields: [] }],
      [{ ...f.requests[0]!, max_queries_per_session: 2 }, { ...f.requests[1]!, max_queries_per_session: 3 }],
    ]) await expect(prepareBoundaryReviewMutationBatch(f.root, requests, async () => f.inspection)).rejects.toThrow();
    expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  });
});

async function relationshipFixture(initialMembership = ["anchor", "retained"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "declarative-relationship-batch-")); roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const inspection = ownedProgramInspection();
  const template = inspection.tables[0]!;
  inspection.schemas = ["shipping"];
  inspection.tables = ["anchor", "left_items", "right_items", "retained"].map(name => {
    const table = structuredClone(template); table.schema = "shipping"; table.name = name;
    if (name === "left_items") {
      table.columns.push({ ...structuredClone(table.columns[0]!), name: "join_key", ordinal_position: 9 });
      table.foreign_keys = [{ name: "items_link", columns: ["join_key"], referenced_schema: "shipping",
        referenced_table: "right_items", referenced_columns: ["parcel_id"], delete_rule: "RESTRICT" }];
    }
    return table;
  });
  const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "shipping",
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
  await initializeFreshGovernedAuthoring({ projectRoot: root, build, config: await readRuntimeConfig(guided.config_path),
    storePath: guided.store_path, actor });
  const request = (name: string): BoundaryResourceReviewRequest => ({ resource_id: `shipping.${name}`, actor,
    reason: "Expose the declared item identity and label for this test policy inside trusted tenant and principal scope.",
    include: true, tenant_key: "tenant_id", principal_key: "principal_id", keep_out_fields: ["internal_note"],
    selectable_fields: name === "left_items" ? ["label", "parcel_id", "join_key"] : ["label", "parcel_id"],
    allow_reviewed_fields: name === "left_items" ? ["label", "parcel_id", "join_key"] : ["label", "parcel_id"],
    filterable_fields: [], sortable_fields: [], max_queries_per_session: 2 });
  for (const name of initialMembership) {
    await commitBoundaryResourceReviewMutation(root, await prepareBoundaryResourceReviewMutation(root, request(name), async () => inspection));
  }
  return { root, inspection, request, before: await loadBoundaryReviewContext(root) };
}

it("constructs disjoint multi-add/remove relationships in every order while retaining unrelated restrictions", async () => {
  const f = await relationshipFixture();
  const remove = { resource_id: "shipping.anchor", exclude: true, actor, reason: "Replace anchor with the explicitly declared related item resources." };
  const left = { ...f.request("left_items"), relationship_ids: ["items_link"] };
  const right = f.request("right_items");
  const variants = [[remove, left, right], [remove, right, left], [left, remove, right], [left, right, remove], [right, left, remove], [right, remove, left]];
  const previews = [];
  for (const requests of variants) previews.push(await prepareBoundaryReviewMutationBatch(f.root, requests, async () => f.inspection));
  for (const preview of previews) {
    expect(preview.candidate).toEqual(previews[0]!.candidate);
    expect(preview.candidate.pack.resources.map(r => r.id)).toEqual(["shipping.left_items", "shipping.retained", "shipping.right_items"]);
    expect(preview.candidate.pack.resources.find(r => r.id === "shipping.left_items")!.relationships.map(r => r.id)).toContain("items_link");
    expect(preview.candidate.pack.resources.find(r => r.id === "shipping.retained")).toEqual(f.before.candidate.pack.resources.find(r => r.id === "shipping.retained"));
    expect(preview.candidate.budgets.max_queries_per_session).toBe(2);
    for (const resource of preview.candidate.pack.resources) {
      expect(resource.kept_out_fields).toContain("internal_note");
      expect(resource.selectable_fields).not.toContain("internal_note");
      expect(resource.sortable_fields).toEqual([]);
      expect(resource.filterable_fields).toEqual({});
    }
  }
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  await commitBoundaryReviewMutationBatch(f.root, previews[0]!);
  const added = await loadBoundaryReviewContext(f.root);
  const removalRequests = ["left_items", "right_items"].map(name => ({ resource_id: `shipping.${name}`, exclude: true, actor, reason: "Remove the two related resources together." }));
  const first = await prepareBoundaryReviewMutationBatch(f.root, removalRequests, async () => f.inspection);
  const second = await prepareBoundaryReviewMutationBatch(f.root, removalRequests.reverse(), async () => f.inspection);
  expect(first.candidate).toEqual(second.candidate);
  expect(first.candidate.pack.resources.map(r => r.id)).toEqual(["shipping.retained"]);
  expect(await loadBoundaryReviewContext(f.root)).toEqual(added);
});

it("uses the same single-request path and refuses stale or failed native commits without activating or replacing the saved baseline", async () => {
  const f = await fixture();
  const request = { resource_id: f.bootstrap, actor, reason: "Narrow only the currently saved resource sort access.", sortable_fields: [] };
  const capturedRequest = structuredClone(request);
  const single = await prepareBoundaryResourceReviewMutation(f.root, request, async () => {
    request.reason = "A caller changed its mutable request after preparation began.";
    return f.inspection;
  });
  expect(single.request).toEqual(capturedRequest);
  const batch = await prepareBoundaryReviewMutationBatch(f.root, [capturedRequest], async () => f.inspection);
  expect(single.candidate).toEqual(batch.candidate);
  expect(single.candidate_digest).toBe(batch.candidate_digest);
  expect(single.semantic_diff).toEqual(batch.semantic_diff[0]);
  const save = vi.spyOn(readOwner, "saveProjectReadProgress").mockRejectedValueOnce(new Error("TEST_NATIVE_SAVE_FAILED_BEFORE_WRITE"));
  await expect(commitBoundaryReviewMutationBatch(f.root, batch)).rejects.toThrow("TEST_NATIVE_SAVE_FAILED_BEFORE_WRITE");
  expect(save).toHaveBeenCalledOnce(); save.mockRestore();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  await commitBoundaryResourceReviewMutation(f.root, single);
  const current = await loadBoundaryReviewContext(f.root);
  await expect(commitBoundaryReviewMutationBatch(f.root, batch)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
  expect(await loadBoundaryReviewContext(f.root)).toEqual(current);
  await expect(loadActivatedExplorationBoundary(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(current.candidate.activation).toBe("disabled_unreviewed");
});

it("checks each request and current inspected permissions against the whole envelope before any save", async () => {
  const f = await fixture();
  const include = f.requests[1]!;
  for (const bad of [
    { ...include, resource_id: "work.foreign" },
    { ...include, selectable_fields: ["never_inspected"] },
    { ...include, include: true, exclude: true },
    { ...include, keep_out_fields: ["label"] },
    { ...include, relationship_ids: ["never_inspected_path"] },
  ]) {
    await expect(prepareBoundaryReviewMutationBatch(f.root, [f.requests[0]!, bad], async () => f.inspection)).rejects.toThrow();
    expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  }
  const currentInspection = structuredClone(f.inspection);
  currentInspection.tables.find(t => `${t.schema}.${t.name}` === f.replacement)!.role_posture!.privileges.select = false;
  // Disabled staging is permitted; actual access still requires the unchanged
  // production activation/current-authority validator's SELECT-only proof.
  const pending = await prepareBoundaryReviewMutationBatch(f.root, f.requests, async () => currentInspection);
  expect(pending.build.graph.resources.find(resource => resource.id === f.replacement)!.role_posture.read_only).toBe(false);
  expect(pending.candidate.activation).toBe("disabled_unreviewed");
  expect(() => assertCurrentExplorationBoundaryAuthority({candidate:pending.candidate,lock:pending.build.lock,inspection:currentInspection}))
    .toThrow("SELECT-only");
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  const invalid = await prepareBoundaryReviewMutationBatch(f.root, [f.requests[0]!], async () => f.inspection).catch(error => error);
  expect(projectBoundaryReviewPreparationFailure(invalid)).toMatchObject({domain:"boundary_review",code:"READ_REVIEW_CANDIDATE_INVALID",local_outcome:"not_attempted"});
  const serialized = JSON.parse(JSON.stringify(projectBoundaryReviewPreparationFailure(invalid)));
  expect(projectBoundaryReviewPreparationFailure(serialized)).toBeUndefined();
  expect(projectBoundaryReviewPreparationFailure(Object.assign(new Error(invalid.message),serialized))).toBeUndefined();
});

it("validates surviving dependencies after an explicit same-batch metric removal, while a retained metric still blocks removal", async () => {
  const f = await relationshipFixture();
  const adding = await prepareBoundaryReviewMutationBatch(f.root, [f.request("left_items"), f.request("right_items")], async () => f.inspection);
  await commitBoundaryReviewMutationBatch(f.root, adding);
  const measure = { name:"item_count", label:"Item count", shape:"child_count_total" as const, child_resource:"shipping.left_items", relationship:"items_link" };
  const definition = {resource_id:"shipping.right_items",derived_measure:measure,actor,reason:"Count the declared related item rows inside their scoped resource."};
  await commitBoundaryResourceReviewMutation(f.root, await prepareBoundaryResourceReviewMutation(f.root, definition, async () => f.inspection));
  const before = await loadBoundaryReviewContext(f.root);
  expect(before.candidate.pack.resources.find(r=>r.id==="shipping.right_items")!.derived_measures).toEqual([measure]);
  const remove = {resource_id:"shipping.left_items",exclude:true,actor,reason:"Remove child availability and its dependent count together."};
  await expect(prepareBoundaryReviewMutationBatch(f.root,[remove],async()=>f.inspection)).rejects.toThrow("reviewed metric item_count");
  const removeMeasure = {...definition,derived_measure:{...measure,remove:true}};
  const forward = await prepareBoundaryReviewMutationBatch(f.root,[remove,removeMeasure],async()=>f.inspection);
  const reverse = await prepareBoundaryReviewMutationBatch(f.root,[removeMeasure,remove],async()=>f.inspection);
  expect(forward.candidate).toEqual(reverse.candidate);
  expect(forward.candidate.pack.resources.some(r=>r.id==="shipping.left_items")).toBe(false);
  expect(forward.candidate.pack.resources.find(r=>r.id==="shipping.right_items")!.derived_measures).toBeUndefined();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(before);
});

it("preserves native scope-only disabled staging without allowing a removal batch to publish an empty authority", async () => {
  const f = await relationshipFixture([]);
  expect(f.before.candidate.pack.resources).toEqual([]);
  const request = {resource_id:"shipping.anchor",tenant_key:"tenant_id",principal_key:"principal_id",actor,
    reason:"Record only the explicit structural scope while resource admission remains pending."};
  const single = await prepareBoundaryResourceReviewMutation(f.root, request, async()=>f.inspection);
  const batch = await prepareBoundaryReviewMutationBatch(f.root,[request],async()=>f.inspection);
  expect(single.candidate).toEqual(batch.candidate);
  expect(batch.candidate.pack.resources).toEqual([]);
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
  await commitBoundaryReviewMutationBatch(f.root,batch);
  expect((await readOwner.readProjectReadAuthoring(f.root))!.selected!.stage).toBe("metadata_only");
  await expect(loadActivatedExplorationBoundary(f.root)).rejects.toMatchObject({code:"ENOENT"});
});

it("refuses an unrequested retained resource disappearing from fresh inspection without changing the saved baseline", async () => {
  const f = await relationshipFixture();
  const before = await loadBoundaryReviewContext(f.root);
  expect(before.candidate.pack.resources.map(resource => resource.id)).toEqual(["shipping.anchor", "shipping.retained"]);
  const currentInspection = structuredClone(f.inspection);
  currentInspection.tables = currentInspection.tables.filter(table => table.name !== "retained");
  const requests = [
    {resource_id:"shipping.anchor",exclude:true,actor,reason:"Replace only anchor; preserve the retained resource and all its reviewed restrictions."},
    f.request("right_items"),
  ];
  const save = vi.spyOn(readOwner,"saveProjectReadProgress");
  let failure: unknown;
  try { await prepareBoundaryReviewMutationBatch(f.root,requests,async()=>currentInspection); }
  catch (error) { failure = error; }
  expect(projectBoundaryReviewPreparationFailure(failure)).toMatchObject({
    domain:"boundary_review",code:"READ_REVIEW_RETAINED_RESOURCE_UNAVAILABLE",local_outcome:"not_attempted",
  });
  expect(save).not.toHaveBeenCalled();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(before);
  await expect(loadActivatedExplorationBoundary(f.root)).rejects.toMatchObject({code:"ENOENT"});
});

it("refuses a retained resource blocked in the fresh generated envelope through the same single-request path", async () => {
  const f = await relationshipFixture();
  const currentInspection = structuredClone(f.inspection);
  const retained = currentInspection.tables.find(table => table.name === "retained")!;
  retained.primary_key = [];
  retained.unique_constraints = [];
  const before = await loadBoundaryReviewContext(f.root);
  const save = vi.spyOn(readOwner,"saveProjectReadProgress");
  let failure: unknown;
  try {
    await prepareBoundaryResourceReviewMutation(f.root, {
      resource_id:"shipping.anchor",sortable_fields:[],actor,
      reason:"Narrow only anchor sorting; do not remove the retained resource.",
    }, async()=>currentInspection);
  } catch (error) { failure = error; }
  expect(projectBoundaryReviewPreparationFailure(failure)).toMatchObject({
    domain:"boundary_review",code:"READ_REVIEW_RETAINED_RESOURCE_UNAVAILABLE",local_outcome:"not_attempted",
  });
  expect((failure as Error).message).toContain("generated_envelope");
  expect(save).not.toHaveBeenCalled();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(before);
});
