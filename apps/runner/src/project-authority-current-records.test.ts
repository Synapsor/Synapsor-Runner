import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import * as resume from "./boundary-authoring-resume.js";
import * as source from "./authoring-policy-source.js";
import * as action from "./action-rule-authority.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

const roots: string[] = [];
const binding = { boundary_name: "current-records", generation_lock_fingerprint: digest("lock"),
  schema_fingerprint: digest("schema"), role_posture_fingerprint: digest("role") };
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "held-current-records-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function records() {
  const root = await project();
  const input = { binding, stage: "planning" as const, jobIntent: "Read the declared records", provider: "openai" as const,
    model: "offline", authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } };
  const state = resume.buildBoundaryAuthoringResumeState(input);
  await resume.writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
  const sources = source.newPolicySourceSession();
  sources.snapshots.push(source.policyTextSnapshot(Buffer.from("Declared owner policy."), "policy.txt")); sources.active = 1;
  await source.savePolicySources(root, sources, { expectedDigest: null });
  return { root, state, sources, input };
}

it("requires explicit held access for actual current Resume and retains its CAS rejection", async () => {
  const f = await records();
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(resume.readBoundaryAuthoringResumeState(f.root, binding)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await resume.readBoundaryAuthoringResumeStateHeld(f.root, binding, permit)).toEqual({ status: "ready", value: f.state });
    await resume.assertBoundaryAuthoringResumeCurrentHeld(f.root, f.state, permit);
    const next = resume.buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state, stage: "authority_review" });
    await resume.writeBoundaryAuthoringResumeState(f.root, next, { expectedRevisionDigest: f.state.revision_digest, permit });
    await expect(resume.writeBoundaryAuthoringResumeState(f.root, f.state, { expectedRevisionDigest: f.state.revision_digest, permit }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await resume.readBoundaryAuthoringResumeStateHeld(f.root, binding, permit)).toEqual({ status: "ready", value: next });
  });
});

it("requires explicit held access for exact Source material and digest without weakening save CAS", async () => {
  const f = await records();
  await withProjectAuthorityMutation(f.root, async permit => {
    await expect(source.loadPolicySources(f.root, f.sources.id)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    await expect(source.policySourceSavedDigest(f.root, f.sources.id)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await source.loadPolicySourcesHeld(f.root, f.sources.id, permit)).toEqual(f.sources);
    const before = await source.policySourceSavedDigestHeld(f.root, f.sources.id, permit);
    const next = { ...f.sources, operator_messages: ["An exact new owner statement."] };
    await source.savePolicySources(f.root, next, { expectedDigest: before, permit });
    await expect(source.savePolicySources(f.root, f.sources, { expectedDigest: before, permit })).rejects.toThrow("POLICY_SOURCE_CHANGED");
    expect(await source.loadPolicySourcesHeld(f.root, f.sources.id, permit)).toEqual(next);
    expect(await source.policySourceSavedDigestHeld(f.root, f.sources.id, permit)).toBe(digest(next));
  });
});

it("requires held current Action subject and baseline reads even when the selection is empty", async () => {
  const root = await project();
  const baseline = await action.readActionRuleAuthorityRevisionBaseline(root);
  await withProjectAuthorityMutation(root, async permit => {
    await expect(action.readActionRuleAuthorityRevisionBaseline(root)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    await expect(action.readActionRuleReviewSubjects(root)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    expect(await action.readActionRuleAuthorityRevisionBaselineHeld(root, permit)).toEqual(baseline);
    expect(await action.readActionRuleReviewSubjectsHeld(root, permit)).toEqual([]);
  });
});

it("rejects foreign, forged and expired tokens at all six current reader boundaries", async () => {
  const f = await records(), other = await project();
  const readers = (root: string, permit: ProjectAuthorityMutationPermit) => [
    () => resume.readBoundaryAuthoringResumeStateHeld(root, binding, permit),
    () => resume.assertBoundaryAuthoringResumeCurrentHeld(root, f.state, permit),
    () => source.loadPolicySourcesHeld(root, f.sources.id, permit),
    () => source.policySourceSavedDigestHeld(root, f.sources.id, permit),
    () => action.readActionRuleAuthorityRevisionBaselineHeld(root, permit),
    () => action.readActionRuleReviewSubjectsHeld(root, permit),
  ];
  let expired!: ProjectAuthorityMutationPermit;
  await withProjectAuthorityMutation(f.root, async permit => {
    expired = permit;
    for (const read of readers(other, permit)) await expect(read()).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    for (const read of readers(f.root, JSON.parse(JSON.stringify(permit)))) await expect(read()).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  });
  for (const read of readers(f.root, expired)) await expect(read()).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  expect(await resume.readBoundaryAuthoringResumeState(f.root, binding)).toEqual({ status: "ready", value: f.state });
  expect(await source.loadPolicySources(f.root, f.sources.id)).toEqual(f.sources);
});
