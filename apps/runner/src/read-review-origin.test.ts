import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { resolveReadReviewOrigin } from "./read-review-origin.js";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import { encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { readAuthoringCatalog } from "./control-policy-read-authoring.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-review-origin-")); roots.push(root);
  const f = await prepareReviewedReadScope(root);
  // The structural fixture is file-backed. Explicitly preserve its actual
  // draft/progress in a new owned native repository; do not fabricate a Yes.
  const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
  const migrated = await migrateProjectControlPolicies({ projectRoot: root, config: {} as RuntimeConfig,
    storePath: path.join(root, "control.db"), actor: "declared fixture operator",
    readLegacySnapshot: async () => ({ revisions: [selection], active: [{ scope: selection.scope,
      kind: selection.kind, name: selection.name, revision_id: selection.revision_id }], drafts: [], provenance: [] }),
    validateSnapshot: async snapshot => validateOperatorPolicySnapshot(snapshot) });
  try {
    const repository = new OperatorAuthorityRepository(migrated.binding);
    await repository.commitReadAuthoring({ expected_epoch: (await repository.current()).epoch, expected_revision_id: null,
      authoring: { type: "read_authoring", selected_boundary_id: f.context.progress!.boundary_id,
        entries: [{ draft: f.context.draft, draft_lock: f.context.lock, candidate_lock: f.context.lock,
          progress: f.context.progress!, catalog: readAuthoringCatalog(f.build) }] },
      actor: "declared fixture operator", operation: "preserve_actual_structural_review" });
  } finally { await migrated.binding.close(); }
  const saved = await readProjectReadAuthoring(root);
  if (!saved?.selected) throw new Error("Fixture must use the actual native Read authoring repository");
  const reference = { revision_id: saved.bindings.revision_id, boundary_id: saved.selected.progress.boundary_id,
    candidate_digest: saved.selected.progress.candidate_digest };
  return { ...f, root, saved, reference };
}
it("resolves the exact immutable original candidate after a later native revision without changing either", async () => {
  const f = await fixture(), original = structuredClone(f.saved);
  const preview = await prepareBoundaryResourceReviewMutation(f.root, { resource_id: "work.items",
    metadata: { label: "Later item label" }, actor: "declared fixture operator", reason: "Edit the display label only." }, async () => f.inspection);
  await commitBoundaryResourceReviewMutation(f.root, preview);
  const current = await readProjectReadAuthoring(f.root);
  expect(current!.bindings.revision_id).not.toBe(f.reference.revision_id);
  const resolved = await resolveReadReviewOrigin(f.root, f.reference);
  expect(resolved.reference).toEqual(f.reference);
  expect(resolved.candidate).toEqual(original.selected!.progress.candidate);
  expect(await readProjectReadAuthoring(f.root)).toEqual(current);
  expect(f.saved).toEqual(original);
});
it.each(["revision", "boundary", "candidate", "unknown_key"])("refuses %s origin substitution without falling back to latest", async kind => {
  const f = await fixture(), changed: Record<string, unknown> = { ...f.reference };
  if (kind === "revision") changed.revision_id = `policy:${"0".repeat(64)}`;
  if (kind === "boundary") changed.boundary_id = `bnd_${"0".repeat(32)}`;
  if (kind === "candidate") changed.candidate_digest = `sha256:${"0".repeat(64)}`;
  if (kind === "unknown_key") changed.confirmed = true;
  await expect(resolveReadReviewOrigin(f.root, changed)).rejects.toThrow();
  expect(await readProjectReadAuthoring(f.root)).toEqual(f.saved);
});
