import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { applicableBoundaryReviewConfirmations } from "./boundary-review-domain.js";

it("public grouped structural signoff persists exact typed references with writer-owned origins", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typed-public-signoff-"));
  await fs.chmod(root, 0o700);
  // Retain failed state for inspection; no Source rows or model calls.
  const { context, shown } = await prepareReviewedReadScope(root);
  expect(shown.length).toBeGreaterThan(0);
  expect(context.bundle.outstanding_decision_ids).toEqual([]);
  const applicable = applicableBoundaryReviewConfirmations(context.candidate,
    context.progress!.confirmations, context.resolvedOrigins);
  expect(applicable.map(item => item.current.id).sort()).toEqual(context.bundle.decisions.map(item => item.id).sort());
  for (const { confirmation } of applicable) {
    expect(confirmation.origin?.boundary_id).toBe(context.progress!.boundary_id);
    expect(confirmation.origin?.revision_id).toBeTruthy();
  }
  expect(context.candidate.activation).toBe("disabled_unreviewed");
});
