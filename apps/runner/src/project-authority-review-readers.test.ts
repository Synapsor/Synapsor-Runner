import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import * as requirements from "./saved-execution-requirements.js";
import * as policy from "./authoring-saved-review.js";
import * as job from "./saved-action-job-review.js";
import * as successor from "./boundary-draft-successor.js";
import * as receipt from "./semantic-receipt-setup.js";
import * as configuration from "./authoring-receipt-configuration.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "protected-review-readers-")); roots.push(root);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const sources = newPolicySourceSession();
  sources.snapshots.push(policyTextSnapshot(Buffer.from("Completion receipts must remain reviewable."), "policy.txt")); sources.active = 1;
  await savePolicySources(root, sources, { expectedDigest: null });
  const binding = boundaryAuthoringResumeBinding(prepared.context.bundle);
  const state = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Read the declared item labels",
    provider: "openai", model: "offline", authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION }, policySourceSession: sources.id });
  await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
  return { root, prepared, sources, binding, state };
}

it("loads exact saved requirements under genuine held access and rejects a dropped permit", async () => {
  const f = await fixture(), input = { projectRoot: f.root, boundaryName: f.binding.boundary_name };
  const before = await requirements.readSavedExecutionRequirements(input);
  expect(before.source_digest).toBe(f.sources.snapshots[0]!.digest);
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(requirements.readSavedExecutionRequirements(input)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await requirements.readSavedExecutionRequirementsHeld(input, permit)).toEqual(before);
  });
});

it("loads saved policy and whole-job status within one explicit context without granting review", async () => {
  const f = await fixture(), input = { projectRoot: f.root, binding: f.binding, readDigest: digest("unreviewed") };
  const before = await policy.savedAuthoringPolicyReview(input);
  expect(before?.ready).toBe(false);
  const jobInput = { projectRoot: f.root, boundaryName: f.binding.boundary_name, currentOutcomes: [] };
  const beforeJob = await job.readSavedActionJobReview(jobInput);
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(policy.savedAuthoringPolicyReview(input)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await policy.savedAuthoringPolicyReviewHeld(input, permit)).toEqual(before);
    await expect(job.readSavedActionJobReview(jobInput)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await job.readSavedActionJobReviewHeld(jobInput, permit)).toEqual(beforeJob);
  });
});

it("does not turn missing successor inventory into implicit permission to use an entry inside a held scope", async () => {
  const f = await fixture();
  expect(await successor.readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(successor.readStructuredDraftSuccessorInventory(f.root)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await successor.readStructuredDraftSuccessorInventoryHeld(f.root, permit)).toEqual({ status: "none" });
  });
});

it("keeps receipt absence read-only while nested configuration readers propagate held access", async () => {
  const f = await fixture(), input = { projectRoot: f.root, configPath: path.join(f.root, "synapsor.runner.json") };
  const before = await receipt.inspectSemanticReceiptSetup(input);
  const beforeConfiguration = await configuration.authoringReceiptConfiguration(f.root, [f.prepared.context.candidate.source]);
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(receipt.inspectSemanticReceiptSetup(input)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await receipt.inspectSemanticReceiptSetupHeld(input, permit)).toEqual(before);
    expect(await configuration.authoringReceiptConfigurationHeld(f.root, [f.prepared.context.candidate.source], permit)).toEqual(beforeConfiguration);
  });
});
