import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import {
  prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation,
  prepareBoundaryReviewMutationBatch, commitBoundaryReviewMutationBatch,
} from "./boundary-review-mutation.js";
import type { BoundaryResourceReviewRequest } from "./read-authoring-contract-types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
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
