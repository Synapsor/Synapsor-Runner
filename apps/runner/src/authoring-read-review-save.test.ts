import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { reloadReadReviewAfterCommitHeld, reloadReadReviewAfterCommit, saveReadReviewSignoff } from "./authoring-read-review-save.js";

import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-signoff-binding-")); roots.push(root);
  const { context } = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  if (!context.progress) throw new Error("Expected real ordinary structural signoff");
  return { root, context, progress: { ...structuredClone(context.progress), revision: context.progress.revision + 1 } };
}

describe("Read signoff actual predecessor boundary", () => {
  it("refuses an inapplicable expected review before its protected save", async () => {
    const { root, context, progress } = await fixture();
    const before = canonicalJsonDigest(await loadBoundaryReviewContext(root));
    const continued = vi.fn();
    const options = { projectRoot: root, context, progress,
      assertBeforeSave: () => { throw new Error("EXACT_SUBJECT_REVIEW_PREDECESSOR_CHANGED"); },
      onReviewSignoff: continued };
    await expect(saveReadReviewSignoff(options)).rejects.toThrow("EXACT_SUBJECT_REVIEW_PREDECESSOR_CHANGED");
    expect(continued).not.toHaveBeenCalled();
    expect(canonicalJsonDigest(await loadBoundaryReviewContext(root))).toBe(before);
  });

  it("reports the actual checked predecessor separately from the acknowledged successor", async () => {
    const { root, context, progress } = await fixture();
    const checked = vi.fn(), continued = vi.fn(async (...args: unknown[]) => {
      const prior = args[2] as typeof context | undefined;
      expect(prior).toBeDefined();
      expect(canonicalJsonDigest(prior)).toBe(canonicalJsonDigest(context));
      const after = args[0] as typeof context;
      expect(after.progress?.revision).toBe(progress.revision);
      expect(prior!.progress?.revision).toBe(progress.revision - 1);
    });
    const options = { projectRoot: root, context, progress, assertBeforeSave: checked, onReviewSignoff: continued };
    await saveReadReviewSignoff(options);
    expect(checked).toHaveBeenCalledOnce();
    expect(continued).toHaveBeenCalledOnce();
  });

  it("still refuses a competing actual native save without continuation or another save", async () => {
    const { root, context, progress } = await fixture();
    await saveReadReviewSignoff({ projectRoot: root, context, progress });
    const current = canonicalJsonDigest(await loadBoundaryReviewContext(root));
    const continued = vi.fn();
    const options = { projectRoot: root, context, progress, assertBeforeSave: () => undefined, onReviewSignoff: continued };
    await expect(saveReadReviewSignoff(options)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    expect(continued).not.toHaveBeenCalled();
    expect(canonicalJsonDigest(await loadBoundaryReviewContext(root))).toBe(current);
  });
});

it("reloads the acknowledged native Read commit inside an existing protected continuation", async () => {
  const { root, context, progress } = await fixture();
  const committed = await saveReadReviewSignoff({ projectRoot: root, context, progress });
  const current = await withProjectAuthorityMutation(root, permit => reloadReadReviewAfterCommitHeld(root, committed, permit));
  expect(current.bundle.candidate_digest).toBe(committed.candidate_digest);
  expect(current.bundle.mutation_bindings.review_revision).toBe(committed.review_revision);
  expect(current.bundle.mutation_bindings.authoring).toEqual(committed.authoring_binding);
  expect(current.progress).toEqual(committed.progress);
});

it("refuses missing/forged/expired Held access and an unrelated acknowledged Read revision", async () => {
  const { root, context, progress } = await fixture();
  const committed = await saveReadReviewSignoff({ projectRoot: root, context, progress });
  const before = await loadBoundaryReviewContext(root);
  // @ts-expect-error Held access is mandatory, including in JavaScript callers.
  await expect(reloadReadReviewAfterCommitHeld(root, committed)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  await expect(reloadReadReviewAfterCommitHeld(root, committed, { projectRoot: root } as ProjectAuthorityMutationPermit))
    .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  let expired!: ProjectAuthorityMutationPermit;
  await withProjectAuthorityMutation(root, async permit => { expired = permit; });
  await expect(reloadReadReviewAfterCommitHeld(root, committed, expired)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  await withProjectAuthorityMutation(root, async permit => {
    await expect(reloadReadReviewAfterCommit(root, committed)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    await expect(reloadReadReviewAfterCommitHeld(root, { ...committed, review_revision: committed.review_revision - 1 }, permit))
      .rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE");
    await expect(reloadReadReviewAfterCommitHeld(root, { ...committed, authoring_binding: undefined }, permit))
      .rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE");
    await expect(reloadReadReviewAfterCommitHeld(root, { ...committed, progress: { ...committed.progress, revision: committed.progress.revision - 1 } }, permit))
      .rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE");
  });
  expect(await loadBoundaryReviewContext(root)).toEqual(before);
});
