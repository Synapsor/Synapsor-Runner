import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { reloadReadReviewForModelRevision, reloadReadReviewForModelRevisionHeld } from "./authoring-read-review-currentness.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { readAuthoringGenerationContext, readAuthoringGenerationContextHeld } from "./authoring-generation-context.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "main-current-review-")); roots.push(root);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  return { root, ...prepared };
}
it("reads the exact reviewed candidate through entry and explicit held routes without nested acquisition", async () => {
  const f = await fixture();
  expect(await reloadReadReviewForModelRevision(f.root, f.context)).toEqual(f.context);
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(reloadReadReviewForModelRevision(f.root, f.context)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await reloadReadReviewForModelRevisionHeld(f.root, f.context, permit)).toEqual(f.context);
  });
});
it("rejects expired and foreign live permits without adopting another project", async () => {
  const a = await fixture(), b = await fixture();
  let expired!: ProjectAuthorityMutationPermit;
  await withProjectAuthorityMutation(a.root, async permit => {
    expired = permit;
    await expect(reloadReadReviewForModelRevisionHeld(b.root, b.context, permit)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  });
  await expect(reloadReadReviewForModelRevisionHeld(a.root, a.context, expired)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
});
it("refuses an actual changed Read revision instead of substituting its current state", async () => {
  const f = await fixture();
  const preview = await prepareBoundaryResourceReviewMutation(f.root, { resource_id: "work.items", include: false,
    actor: "declared fixture operator", reason: "Remove the declared item Read while its old review is pending" }, async () => f.inspection);
  await commitBoundaryResourceReviewMutation(f.root, preview);
  await expect(reloadReadReviewForModelRevision(f.root, f.context)).rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED");
  await withProjectAuthorityMutation(f.root, permit => expect(reloadReadReviewForModelRevisionHeld(f.root, f.context, permit)).rejects.toThrow("READ_BOUNDARY_REVISION_CHANGED"));
});
it("generation context retains the acknowledged Resume baseline and rejects a later save", async () => {
  const f = await fixture(), binding = boundaryAuthoringResumeBinding(f.context.bundle);
  const state = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Read the declared item labels",
    provider: "openai", model: "offline", authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } });
  await writeBoundaryAuthoringResumeState(f.root, state, { expectedRevisionDigest: null });
  const before = await readAuthoringGenerationContext(f.root, state);
  await withProjectAuthorityMutation(f.root, async permit => expect(await readAuthoringGenerationContextHeld(f.root, state, permit)).toEqual(before));
  const next = buildBoundaryAuthoringResumeState({ binding, stage: "read_mapping", jobIntent: state.job_intent,
    provider: "openai", model: "offline", authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION }, previous: state });
  await writeBoundaryAuthoringResumeState(f.root, next, { expectedRevisionDigest: state.revision_digest });
  await expect(readAuthoringGenerationContext(f.root, state)).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
});
