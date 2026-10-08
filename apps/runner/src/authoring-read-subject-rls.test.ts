import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { buildAutoBoundary, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { principalScopeReviewDecision } from "./boundary-principal-review.js";
import { boundaryReviewDecisions } from "./boundary-review-domain.js";
import { projectReadSubjectContext } from "./authoring-read-subject-context.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

describe("native typed PostgreSQL RLS subject acknowledgment", () => {
  let root: string, context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-rls-ack-"));
    await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"), { mode: 0o700 });
    const inspection = ownedProgramInspection();
    const table = inspection.tables[0]!;
    table.columns = table.columns.filter(column => column.name !== "principal_id");
    table.row_level_security = true;
    table.role_posture!.row_security_effective_for_current_role = true;
    table.row_level_security_policies = [{ name: "parcel_reader", command: "SELECT", permissive: true,
      roles: [inspection.current_user], using_expression: "tenant_id = current_setting('app.tenant_id') AND app.can_view(tenant_id, current_setting('app.viewer_context'))" }];
    const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "studio",
      project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
    await writeAutoBoundaryArtifacts({ projectRoot: root, build });
    const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: "studio.parcels", include: true,
      tenant_key: "tenant_id", principal_rls_setting: "app.viewer_context", selectable_fields: ["label"],
      actor: "declared RLS reviewer", reason: "The signed-in customer identity is supplied through the reviewed RLS session setting." }, async () => inspection);
    await commitBoundaryResourceReviewMutation(root, preview);
    await boundaryReviewCommand(["--project-root", root, "--confirm", "--actor", "declared RLS reviewer", "--output", path.join(root, "review.json")], async () => inspection, {
      presentationMode: "conversation", promptText: async () => undefined,
      confirm: async (_message, options) => { expect(options?.context?.length).toBeGreaterThan(0); return true; },
      chooseResource: async () => undefined, editFieldTiers: async () => undefined,
    });
    context = await loadBoundaryReviewContext(root);
  });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  it("records the actual RLS decision as principal scope and projects only its current acknowledgment", () => {
    expect(context.candidate.pack.resources[0]?.rls_session?.principal_setting).toBe("app.viewer_context");
    expect(boundaryReviewDecisions(context.candidate).find(item => item.id === "resource.studio.parcels.principal_scope")?.kind).toBe("principal_scope");
    expect(projectReadSubjectContext({ context, sourceDigest: d(null) }).subject_scopes).toHaveLength(1);
    expect(projectReadSubjectContext({ context, sourceDigest: d(null) }).subject_scopes[0]?.kind).toBe("principal");
  });
  it("does not establish RLS scope from configured settings without the actual acknowledgment", () => {
    const copy = structuredClone(context);
    copy.progress!.confirmations = copy.progress!.confirmations.filter(item => item.kind !== "principal_scope");
    expect(projectReadSubjectContext({ context: copy, sourceDigest: d(null) }).subject_scopes).toEqual([]);
  });
  it("keeps direct and absent-scope decision identities and historical input digests unchanged", () => {
    for (const principal_key of ["principal_id", undefined]) {
      const resource = { ...context.candidate.pack.resources[0]!, principal_key, rls_session: undefined };
      const decision = principalScopeReviewDecision(resource, context.candidate);
      expect(decision.id).toBe(`resource.${resource.id}.principal_scope`);
      expect(decision.decision).toBe(`${resource.id}: confirm principal scope ${principal_key ?? "not configured"}`);
      expect(decision.input_digest).toBe(d({ schema_version: "synapsor.boundary-review-input.v1", decision_kind: "principal_scope",
        reviewed_input: { principal_key: principal_key ?? null,
          trusted_principal_env: context.candidate.trusted_context.principal_env, rls_session: null } }));
    }
  });
  it("binds RLS setting, effective role and trusted context, never arbitrary displayed prose", () => {
    const resource = context.candidate.pack.resources[0]!;
    const baseline = principalScopeReviewDecision(resource, context.candidate);
    expect(principalScopeReviewDecision({ ...resource, rls_session: { ...resource.rls_session!, principal_setting: "app.other_context" } }, context.candidate).input_digest).not.toBe(baseline.input_digest);
    expect(principalScopeReviewDecision(resource, { ...context.candidate, role_posture_fingerprint: d("changed role") }).input_digest).not.toBe(baseline.input_digest);
    const trusted = context.candidate.trusted_context;
    if (trusted.provider !== "environment") throw new Error("Declared fixture requires the ordinary environment context");
    expect(principalScopeReviewDecision(resource, { ...context.candidate, trusted_context: { ...trusted, principal_env: "OTHER_REVIEWED_PRINCIPAL" } }).input_digest).not.toBe(baseline.input_digest);
    const prose = structuredClone(context.candidate);
    prose.unresolved_decisions = prose.unresolved_decisions.map(text => text === baseline.decision ? `${resource.id}: confirm principal scope arbitrary prose` : text);
    expect(boundaryReviewDecisions(prose).some(item => item.kind === "principal_scope")).toBe(false);
  });

});
