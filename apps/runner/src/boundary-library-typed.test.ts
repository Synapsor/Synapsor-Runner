import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, BOUNDARY_REVIEW_SUBMISSION_VERSION, boundaryReviewDecisionRefs,
  buildAutoBoundary, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { READ_REVIEW_PROTOCOL } from "./control-policy-read-authoring.js";
import * as native from "./control-policy-read-authoring-project.js";
import { initializeGuidedProject } from "./guided-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { readRuntimeConfig } from "./cli-project.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { saveReadReviewSignoff } from "./authoring-read-review-save.js";
import { createSavedBoundary, deleteSavedBoundary, discardOnlySavedBoundaryReview, renameSavedBoundary,
  switchSavedBoundary, synchronizeBoundaryLibrary } from "./boundary-library.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

afterEach(() => vi.restoreAllMocks());
const roots: string[] = [];
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "read-library-typed-")); roots.push(value);
  await fs.mkdir(path.join(value, ".git"), { mode: 0o700 });
  return value;
}
// Declared schema/structural settings only; no source rows, activation actor,
// native confirmation or immutable review origin is fabricated.
function build(root: string) {
  const declared = { actor: "declared library operator", reason: "Explicit declared tenant/person/label fields for this isolated schema.", decided_at: "2026-10-08T00:00:00.000Z" };
  return buildAutoBoundary({ inspection: ownedProgramInspection(), inspectedSchema: "studio", sourceEnv: "DATABASE_URL", deploymentProfile: "staging",
    overrides: { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "studio.parcels": {
      tenant_key: { ...declared, value: "tenant_id" }, principal_key: { ...declared, value: "principal_id" },
      fields: { label: { ...declared, exposure: "allow_reviewed_use" } },
    } } }, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}
async function context(projectRoot: string) {
  const loaded = await loadBoundaryReviewContext(projectRoot);
  return { projectRoot, draft: loaded.draft, currentCandidate: loaded.candidate,
    currentProgress: loaded.progress, expectedAuthoring: loaded.bundle.mutation_bindings.authoring };
}
async function setup() {
  const projectRoot = await root(); const prepared = build(projectRoot);
  const guided = await initializeGuidedProject({ projectRoot, build: prepared, runnerVersion: "1.8.0", instantOnboarding: true });
  const config = await readRuntimeConfig(guided.config_path);
  await initializeFreshGovernedAuthoring({ projectRoot, build: prepared, config, storePath: guided.store_path, actor: "declared library operator" });
  const before = await loadBoundaryReviewContext(projectRoot);
  const submission = { schema_version: BOUNDARY_REVIEW_SUBMISSION_VERSION, candidate_digest: before.bundle.candidate_digest,
    decisions: boundaryReviewDecisionRefs(before.candidate) };
  const reviewed = createBoundaryReviewProgress({ draft: before.draft, candidate: before.candidate, previous: before.progress,
    submission, resolvedOrigins: before.resolvedOrigins, revision: before.progress!.revision + 1, actor: "declared library operator",
    reason: "Explicitly submit the displayed exact structural settings for the library fixture." });
  await saveReadReviewSignoff({ projectRoot, context: before, progress: reviewed, submission });
  const saved = (await native.readProjectReadAuthoring(projectRoot))!;
  expect(saved.selected!.progress.confirmations.length).toBeGreaterThan(0);
  expect(saved.selected!.progress.confirmations.every(item => item.origin)).toBe(true);
  await expect(loadActivatedExplorationBoundaries(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
  return { projectRoot, prepared, saved };
}

it("renames a real native disabled review without creating acknowledgments or losing applicable origins", async () => {
  const f = await setup(); const previous = f.saved.selected!.progress;
  const result = await renameSavedBoundary({ ...await context(f.projectRoot), name: previous.candidate.pack.name,
    newName: "renamed_review", actor: "declared library operator", reason: "Change the saved review name only." });
  const saved = (await native.readProjectReadAuthoring(f.projectRoot))!;
  expect(result).toEqual(saved.selected!.progress);
  expect(result.boundary_id).toBe(previous.boundary_id);
  expect(result.confirmations).toEqual(previous.confirmations);
  expect(result.confirmed_decisions.length).toBeGreaterThan(0);
  expect(saved.resolvedOrigins).toEqual(f.saved.resolvedOrigins);
  expect(saved.authoring.review_protocol).toBe(READ_REVIEW_PROTOCOL);
  expect(saved.bindings.epoch).toBe(f.saved.bindings.epoch + 1);
});

it("creates a new disabled identity unconfirmed, then selects and deletes it without importing old Yes", async () => {
  const f = await setup(); const old = f.saved.selected!.progress;
  const created = await createSavedBoundary({ ...await context(f.projectRoot), name: "new_review", resourceId: "studio.parcels", actor: "declared library operator" });
  expect(created.boundary_id).not.toBe(old.boundary_id);
  expect(created.confirmations).toEqual([]); expect(created.confirmed_decisions).toEqual([]);
  const after = (await native.readProjectReadAuthoring(f.projectRoot))!;
  expect(after.selected!.progress).toEqual(created);
  expect(after.authoring.entries.find(entry => entry.progress.boundary_id === old.boundary_id)!.progress).toEqual(old);
  const selected = await switchSavedBoundary({ ...await context(f.projectRoot), name: old.candidate.pack.name });
  expect(selected).toEqual(old);
  await deleteSavedBoundary({ ...await context(f.projectRoot), name: "new_review" });
  expect((await native.readProjectReadAuthoring(f.projectRoot))!.authoring.entries.map(entry => entry.progress)).toEqual([old]);
});

it("discard keeps the exact new native review protocol and removes only its disabled record selection", async () => {
  const f = await setup(); const current = await context(f.projectRoot);
  const result = await discardOnlySavedBoundaryReview({ ...current, name: current.currentCandidate.pack.name,
    boundaryRoot: path.join(f.projectRoot, "synapsor/generated") });
  expect(result.removed).toEqual([]);
  const saved = (await native.readProjectReadAuthoring(f.projectRoot))!;
  expect(saved.authoring).toEqual({ type: "read_authoring", review_protocol: READ_REVIEW_PROTOCOL, selected_boundary_id: null, entries: [] });
  expect(saved.bindings.epoch).toBe(f.saved.bindings.epoch + 1);
});

it("rejects a stale library context after an actual native edit instead of adopting latest", async () => {
  const f = await setup(); const stale = await context(f.projectRoot);
  const changed = structuredClone(f.saved.authoring); changed.entries[0]!.progress.updated_at = "2026-10-08T10:00:00.000Z";
  await native.saveProjectReadAuthoring({ projectRoot: f.projectRoot, expected: f.saved.bindings,
    authoring: changed, actor: "another declared operator", operation: "test_intervening_review" });
  const exact = await native.readProjectReadAuthoring(f.projectRoot);
  await expect(renameSavedBoundary({ ...stale, name: stale.currentCandidate.pack.name, newName: "stale_name", actor: "declared library operator", reason: "Old view" }))
    .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
  expect(await native.readProjectReadAuthoring(f.projectRoot)).toEqual(exact);
});

it("refuses an inexact protected writer receipt after the real commit and preserves that saved state", async () => {
  const f = await setup(); const original = native.saveProjectReadAuthoring;
  vi.spyOn(native, "saveProjectReadAuthoring").mockImplementation(async (...args) => {
    const committed = await original(...args);
    return { ...committed, epoch: committed.epoch + 1 };
  });
  await expect(renameSavedBoundary({ ...await context(f.projectRoot), name: f.saved.selected!.progress.candidate.pack.name,
    newName: "committed_but_unacknowledged", actor: "declared library operator", reason: "Actual guarded commit before receipt mismatch." }))
    .rejects.toMatchObject({ code: "BOUNDARY_LIBRARY_SAVE_ACK_CHANGED" });
  const saved = (await native.readProjectReadAuthoring(f.projectRoot))!;
  expect(saved.selected!.progress.candidate.pack.name).toBe("committed_but_unacknowledged");
  expect(saved.bindings.epoch).toBe(f.saved.bindings.epoch + 1);
  expect(saved.selected!.progress.confirmations).toEqual(f.saved.selected!.progress.confirmations);
});

it("refuses an old file-only library without rewriting it or creating a native repository", async () => {
  const projectRoot = await root(); const prepared = build(projectRoot);
  const candidate = recommendedBoundaryReviewCandidate(prepared.exploration_boundary);
  const progress = createBoundaryReviewProgress({ draft: candidate, candidate, revision: 1, actor: "declared library operator" });
  const filename = path.join(projectRoot, ".synapsor/boundary-library.json");
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const old = JSON.stringify({ schema_version: "synapsor.boundary-library.v1", selected_name: candidate.pack.name,
    boundaries: { [candidate.pack.name]: progress }, updated_at: progress.updated_at });
  await fs.writeFile(filename, old);
  await expect(synchronizeBoundaryLibrary({ projectRoot, draft: candidate, currentCandidate: candidate, currentProgress: progress }))
    .rejects.toMatchObject({ code: "BOUNDARY_LIBRARY_PROTOCOL_REQUIRED" });
  expect(await fs.readFile(filename, "utf8")).toBe(old);
  expect(await native.readProjectReadAuthoring(projectRoot)).toBeUndefined();
});
