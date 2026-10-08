import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { projectReadSubjectContext } from "./authoring-read-subject-context.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";

describe("native acknowledged Read subject inventory", () => {
  let root: string, fixture: Awaited<ReturnType<typeof prepareReviewedReadScope>>;
  beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "read-subject-projector-")); await fs.chmod(root, 0o700); fixture = await prepareReviewedReadScope(root); });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  it("projects only actual ordinary structural acknowledgments with no source rows or subject values", () => {
    const projected = projectReadSubjectContext({ context: fixture.context, sourceDigest: d(null) });
    expect(projected.subject_scopes, JSON.stringify(fixture.context.bundle.decisions.map(({id, kind, resource_id, input_digest, confirmed}) => ({id,kind,resource_id,input_digest,confirmed})))).toHaveLength(1);
    expect(projected.subject_scopes[0]).toMatchObject({ root_resource: "work.items", kind: "principal", source_digest: d(null) });
    expect(projected.descriptions[0]?.text).toContain("signed-in person");
    expect(JSON.stringify(projected)).not.toMatch(/declared fixture operator|DATABASE_URL|principal_id|tenant_id/);
  });
  it.each(["principal_scope", "tenant_scope", "trusted_context"])("keeps missing %s acknowledgment pending", kind => {
    const context = structuredClone(fixture.context);
    context.progress!.confirmations = context.progress!.confirmations.filter(item => item.kind !== kind);
    expect(projectReadSubjectContext({ context, sourceDigest: d(null) }).subject_scopes).toEqual([]);
  });
  it("refuses an incoherent bundle and rejects a copied stale decision input", () => {
    const context = structuredClone(fixture.context);
    context.progress!.confirmations.find(item => item.kind === "principal_scope")!.input_digest = d("different reviewed principal input");
    expect(projectReadSubjectContext({ context, sourceDigest: d(null) }).subject_scopes).toEqual([]);
    context.bundle.candidate_digest = d("different candidate");
    expect(() => projectReadSubjectContext({ context, sourceDigest: d(null) })).toThrow("READ_SUBJECT_CONTEXT_CHANGED");
  });
  it("binds exact Source provenance without exposing its content", () => {
    const first = projectReadSubjectContext({ context: fixture.context, sourceDigest: d(null) });
    const next = projectReadSubjectContext({ context: fixture.context, sourceDigest: d("changed operator-consented Source") });
    expect(next.subject_scopes[0]?.reference).not.toBe(first.subject_scopes[0]?.reference);
    expect(JSON.stringify(next)).not.toContain("changed operator-consented Source");
  });
  it("retains subject identity through an ordinary unrelated metadata edit and newer progress revision", async () => {
    const first = projectReadSubjectContext({ context: fixture.context, sourceDigest: d(null) });
    const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: "work.items", metadata: { label: "Reviewed item register" },
      actor: "declared fixture operator", reason: "Change only the display label, keeping trusted subject scope." }, async () => fixture.inspection);
    await commitBoundaryResourceReviewMutation(root, preview);
    const current = await loadBoundaryReviewContext(root);
    expect(current.progress!.revision).toBeGreaterThan(fixture.context.progress!.revision);
    expect(projectReadSubjectContext({ context: current, sourceDigest: d(null) }).subject_scopes).toEqual(first.subject_scopes);
  });
});
