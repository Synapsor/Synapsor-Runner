import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { readBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { loadActionRuleIntentSkeletons, loadActionRuleIntentSkeletonsHeld } from "./action-rule-intent-skeleton.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { readActionRuleAuthorityActivation } from "./action-rule-authority.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([false, true])("exports the actual reviewed setup with saved intents/Source=%s under existing authority access without activation or revision adoption", async (savedIntent) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "structured-held-export-")); roots.push(root);
  await fs.chmod(root, 0o700);
  const fixture = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const before = await loadBoundaryReviewContext(root);
  const policy = newPolicySourceSession();
  policy.snapshots.push(policyTextSnapshot(Buffer.from("The declared item label may be reviewed."), "business-policy.txt")); policy.active = 1;
  const binding = boundaryAuthoringResumeBinding(before.bundle);
  const resume = savedIntent ? buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Review my item labels", provider: "openai", model: "offline",
    authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION }, policySourceSession: policy.id,
    action: { intent: "Update an item label", intents: ["Update an item label"], strategy: "rule_derived" } }) : undefined;
  if (resume) { await savePolicySources(root, policy, { expectedDigest: null }); await writeBoundaryAuthoringResumeState(root, resume, { expectedRevisionDigest: null }); }
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { output += value.toString(); return true; }) as typeof process.stdout.write);
  const result = await structuredBoundaryAuthoringCommand(["--project-root", root, "--export-draft", "proposal.json", "--json"], async () => fixture.inspection);
  expect(result, output).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ ok: true, state: "exported", source_database_changed: false, active_authority_changed: false, disabled_authority_changed: false });
  const proposal = await readBoundaryDraftExchange(root, "proposal.json") as { review_bundle_digest: string; bindings: unknown; read: { resources: unknown[] }; actions: unknown[]; action_skeletons: Array<{ intent: string; state: string; continuation: unknown }>; attached_sources?: Array<{ text: string }> };
  expect(proposal.review_bundle_digest).toBe(before.bundle.bundle_digest);
  expect(proposal.bindings).toEqual(before.bundle.mutation_bindings);
  expect(proposal.read.resources).toEqual([{ resource_id: "work.items", include: true }]);
  expect(proposal.actions).toEqual([]);
  if (resume) {
    expect(proposal.action_skeletons).toHaveLength(1);
    expect(proposal.action_skeletons[0]).toMatchObject({ intent: "Update an item label", state: "incomplete", continuation: { state: "unprepared" } });
    expect(proposal.attached_sources?.map(source => source.text)).toEqual([policy.snapshots[0]!.text]);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: resume });
    expect(await loadPolicySources(root, policy.id)).toEqual(policy);
  } else { expect(proposal.action_skeletons).toEqual([]); expect(proposal.attached_sources).toBeUndefined(); }
  expect((await loadBoundaryReviewContext(root)).bundle).toEqual(before.bundle);
  expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
});

it("requires genuine current Held access for skeleton reads even when no saved job exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "structured-skeleton-access-")); roots.push(root);
  const fixture = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label", review: { allow_reviewed_fields: ["label"] } });
  const input = { projectRoot: root, binding: boundaryAuthoringResumeBinding(fixture.context.bundle),
    builtCatalog: buildActionRuleAuthoringCatalog({ boundary: fixture.context.candidate, inspection: fixture.inspection }),
    readBoundaryDigest: fixture.context.bundle.candidate_digest, preparedDrafts: [] };
  let expired!: ProjectAuthorityMutationPermit;
  await withProjectAuthorityMutation(root, async permit => {
    expired = permit;
    await expect(loadActionRuleIntentSkeletons(input)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_REQUIRED" });
    await expect(loadActionRuleIntentSkeletonsHeld(input, permit)).resolves.toEqual({ resume: undefined, skeletons: [] });
    await expect(loadActionRuleIntentSkeletonsHeld(input, JSON.parse(JSON.stringify(permit)))).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    await expect(loadActionRuleIntentSkeletonsHeld(input, undefined as never)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  });
  await expect(loadActionRuleIntentSkeletonsHeld(input, expired)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
  await expect(loadActionRuleIntentSkeletons(input)).resolves.toEqual({ resume: undefined, skeletons: [] });
  if (false) {
    // @ts-expect-error Held reads cannot omit their current explicit access.
    await loadActionRuleIntentSkeletonsHeld(input);
  }
});
