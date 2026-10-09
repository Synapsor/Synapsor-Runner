import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { activateExplorationBoundary, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { boundaryReviewSubmissionForDecisions } from "./boundary-review-domain.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-activation-owner-"));
  await fs.chmod(root, 0o700);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label",
    review: { allow_reviewed_fields: ["label"] } });
  const { context } = prepared;
  return { root, input: { projectRoot: root, candidate: context.candidate, reviewDraft: context.draft,
    generationLock: context.lock, expectedAuthoring: context.bundle.mutation_bindings.authoring,
    expectedDigest: context.bundle.candidate_digest, actor: "declared fixture operator",
    confirmation: `ACTIVATE ${context.bundle.candidate_digest}`, currentInspection: prepared.inspection,
    reviewSubmission: boundaryReviewSubmissionForDecisions(context.candidate, context.bundle.decisions.map(d => d.id)) } };
}

it("activation obtains current meaning from its owner under the same held authority permit", async () => {
  const { root, input } = await fixture();
  let calls = 0;
  let observed: ProjectAuthorityMutationPermit | undefined;
  await expect(activateExplorationBoundary({ ...input,
    assessReadScope: async (candidate, permit) => {
      calls++; observed = permit;
      expect(candidate).toEqual(input.candidate);
      await expect(withProjectAuthorityMutation(root, async () => undefined, { waitMs: 0 }))
        .rejects.toMatchObject({ code: "POLICY_MUTATION_BUSY" });
      await withProjectAuthorityMutation(root, async () => undefined, { permit });
      return { kind: "missing", status: "pending", candidate_digest: input.expectedDigest };
    },
  })).rejects.toMatchObject({ code: "READ_SCOPE_REVIEW_REQUIRED" });
  expect(calls).toBe(1);
  await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(withProjectAuthorityMutation(root, async () => undefined, { permit: observed }))
    .rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
});

it("a current owner refusal is preserved and cannot activate a structurally reviewed draft", async () => {
  const { root, input } = await fixture();
  const refusal = Object.assign(new Error("The saved Read answer was replaced."), { code: "READ_OWNER_REPLACED" });
  await expect(activateExplorationBoundary({ ...input, assessReadScope: async () => { throw refusal; } }))
    .rejects.toBe(refusal);
  await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
});
