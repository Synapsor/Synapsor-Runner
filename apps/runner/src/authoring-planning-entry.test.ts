import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { runPlanningEntry } from "./authoring-planning-entry.js";
import type { BoundaryJobPlanningInput, BoundaryJobPlan } from "./boundary-job-model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "planning-entry-current-"));
  await fs.chmod(root, 0o700); roots.push(root);
  const { context } = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const state = buildBoundaryAuthoringResumeState({ binding: boundaryAuthoringResumeBinding(context.bundle),
    stage: "planning", jobIntent: "Review the declared task.", provider: "openai", model: "inert" });
  await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
  const unexpected = () => { throw new Error("UNEXPECTED_ACCEPTED_RECORD_OR_REVIEW"); };
  const native = createNativeReadScope({ projectRoot: root, ports: {
    snapshot: () => ({ resume: state, revision: state.revision_digest, blocked: false, questions: [], handoffs: [] }),
    assertCurrent: async () => {
      const loaded = await readBoundaryAuthoringResumeState(root, state.binding);
      if (loaded.status !== "ready" || loaded.value.revision_digest !== state.revision_digest) throw new Error("SAVED_JOB_CHANGED");
    },
    questionScope: unexpected, questionContext: async () => unexpected(),
    mutate: run => withProjectAuthorityMutation(root, run), failure: subject => new Error(`NATIVE_CHECKPOINT_NOT_SAVED: ${subject}`),
    save: async () => unexpected(),
  }, interact: async () => unexpected() });
  const request: BoundaryJobPlanningInput = { session: { provider: "openai", model: "inert", apiKey: "unused-local" },
    jobIntent: state.job_intent, availableResourceIds: ["work.items"], egressAcknowledged: true,
    currentState: { read: { boundary_name: context.candidate.pack.name, authority: "disabled", fully_reviewed: false,
      resource_ids: ["work.items"], exact_reusable_revision_count: 0 }, actions: [] } };
  // This deliberately lacks live consumption; it is never imported as evidence.
  const unconsumed: BoundaryJobPlan = { state: "planned", read_mode: "none", action_mode: "none",
    summary: "A response without a genuine completion cannot advance.", correction_used: false,
    authority_granted: false, source_database_changed: false };
  return { root, state, request, native, unconsumed };
}
it("does not skip the native capture fence for a planned result lacking genuine consumption", async () => {
  const f = await fixture(), before = await readBoundaryAuthoringResumeState(f.root, f.state.binding);
  await expect(runPlanningEntry({ request: f.request, produce: async () => f.unconsumed, scope: f.native }))
    .rejects.toThrow("NATIVE_CHECKPOINT_NOT_SAVED");
  expect(await readBoundaryAuthoringResumeState(f.root, f.state.binding)).toEqual(before);
});
it("checks the actual saved revision before considering an unconsumed plan", async () => {
  const f = await fixture();
  const newer = buildBoundaryAuthoringResumeState({ binding: f.state.binding, stage: "planning", jobIntent: f.state.job_intent,
    provider: "openai", model: "inert", previous: f.state, pendingJobRevision: "Review an explicitly changed task." });
  await writeBoundaryAuthoringResumeState(f.root, newer, { expectedRevisionDigest: f.state.revision_digest });
  const before = await readBoundaryAuthoringResumeState(f.root, f.state.binding);
  await expect(runPlanningEntry({ request: f.request, produce: async () => f.unconsumed, scope: f.native })).rejects.toThrow("SAVED_JOB_CHANGED");
  expect(await readBoundaryAuthoringResumeState(f.root, f.state.binding)).toEqual(before);
});
