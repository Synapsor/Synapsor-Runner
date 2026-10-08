import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { createNativeReadScope } from "./authoring-read-scope-native.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";

it("native Read context publishes actual acknowledged subjects and reloads structural drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-b64-native-subject-"));
  try {
    const f = await prepareReviewedReadScope(root);
    const resume = buildBoundaryAuthoringResumeState({ binding: { boundary_name: f.context.candidate.pack.name,
      schema_fingerprint: f.context.lock.schema_fingerprint, role_posture_fingerprint: f.context.lock.role_posture_fingerprint,
      generation_lock_fingerprint: f.context.candidate.generation_lock_fingerprint },
      stage: "planning", jobIntent: "Show the declared labels", provider: "openai", model: "offline" });
    await writeBoundaryAuthoringResumeState(root, resume, { expectedRevisionDigest: null });
    let checks = 0;
    const native = createNativeReadScope({ projectRoot: root, ports: {
      snapshot: () => ({ resume, revision: resume.revision_digest, blocked: false, questions: [], handoffs: [] }),
      assertCurrent: async () => { checks++; expect(await readBoundaryAuthoringResumeState(root, resume.binding)).toEqual({ status: "ready", value: resume }); },
      questionContext: async () => canonicalJsonDigest("unused"), questionScope: () => canonicalJsonDigest("unused"),
      mutate: async () => { throw new Error("Projection must not mutate"); },
      save: async () => { throw new Error("Projection must not save"); }, failure: s => new Error(s),
    }, interact: async () => { throw new Error("Projection must not ask"); } });
    const before = await native.context(f.context.candidate);
    expect(checks).toBe(2);
    expect(before.catalog.subject_scopes).toEqual([expect.objectContaining({ root_resource: "work.items", kind: "principal" })]);
    const change = await prepareBoundaryResourceReviewMutation(root, { resource_id: "work.items", principal_key: null,
      actor: "declared fixture operator", reason: "Withdraw person scope for a structural drift control" }, async () => f.inspection);
    await commitBoundaryResourceReviewMutation(root, change);
    await expect(native.context(f.context.candidate)).rejects.toThrow("READ_SUBJECT_CONTEXT_CHANGED");
    const current = await loadBoundaryReviewContext(root), after = await native.context(current.candidate);
    expect(after.catalog.subject_scopes).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "principal" })]));
    expect(after.binding.operation_digest).not.toBe(before.binding.operation_digest);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
