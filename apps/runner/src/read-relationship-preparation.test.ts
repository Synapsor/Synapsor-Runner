import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { prepareExactBoundaryCandidateMutation, commitExactBoundaryCandidateMutation } from "./boundary-review-mutation.js";
import { projectReadSubjectContext } from "./authoring-read-subject-context.js";
import { projectReadScopeHostContext } from "./read-current-evidence.js";
import { READ_SCOPE_PROTOCOL } from "./read-structured-scope.js";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, emptyReviewOverrides, reviewExplorationBoundaryCandidate, explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { applyManagedBoundaryReviewDecision } from "./boundary-review-domain.js";
import { generateModelReadWorkload, readWorkloadCatalog } from "./read-workload-model.js";
import { prepareReadWorkloadRelationship, validateReadWorkloadRelationshipPreparation } from "./read-relationship-preparation.js";
import { isReadRelationshipScopePair } from "./read-relationship-scope.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { AskProviderDependencies } from "./model-ask.js";

function fixture(renamed = false) {
  const schema = renamed ? "catalog" : "editorial";
  const names = renamed ? ["releases", "assessments", "licenses"] : ["manuscripts", "final_reviews", "rights_clearances"];
  const tenant = renamed ? "organization_code" : "publisher_id";
  const principal = renamed ? "operator_code" : "editor_id";
  const column = (name: string, data_type = "text") => ({ name, data_type, nullable: false, generated: false,
    ordinal_position: 1, suggestions: { tenant: false, sensitive: false, conflict: false, immutable: false, large_or_binary: false } });
  const tables: SchemaInspection["tables"] = names.map(name => ({ schema, name: name!, type: "table", writable: false,
    columns: [column("id", "uuid"), column(tenant), column(principal), column("business_ref")], primary_key: ["id"],
    unique_constraints: [{ name: `${name}_scope_key`, columns: ["id", tenant, principal] }], indexes: [], foreign_keys: [],
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["id", tenant, principal, "business_ref"] },
    row_level_security: true,
    row_level_security_policies: [{ name: "scoped_reader", command: "SELECT", permissive: true, roles: ["reader"],
      using_expression: `${tenant} = current_setting('app.organization', true) AND ${principal} = current_setting('app.person', true)` }],
    role_posture: { owner: "fixture_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: true, row_security_effective_for_current_role: true,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } },
  }));
  const root = tables[0]!;
  for (const [index, target] of tables.slice(1).entries()) {
    const field = `selected_${index + 1}_id`;
    root.columns.push(column(field, "uuid"));
    root.suggestions.default_visible_columns.push(field);
    root.foreign_keys.push({ name: `${root.name}_${target.name}_fk`, columns: [field, tenant, principal],
      referenced_schema: schema, referenced_table: target.name, referenced_columns: ["id", tenant, principal], delete_rule: "RESTRICT" });
  }
  const inspection: SchemaInspection = { engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00.000Z", schemas: [schema], warnings: [], tables,
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
  let overrides = emptyReviewOverrides();
  for (const table of tables) {
    for (const [kind, value] of [["tenant_key", tenant], ["principal_key", principal]] as const) {
      overrides = applyManagedBoundaryReviewDecision(overrides, { kind, value, resource_id: `${schema}.${table.name}`,
        actor: "synthetic-reviewer", reason: "Review exact fixture identity roles.", decided_at: inspection.inspected_at });
    }
    for (const field of ["id", ...table.foreign_keys.flatMap(link => link.columns.filter(c => c !== tenant && c !== principal))]) {
      overrides = applyManagedBoundaryReviewDecision(overrides, { kind: "field_exposure", field,
        exposure: "withhold_from_model", resource_id: `${schema}.${table.name}`, actor: "synthetic-reviewer",
        reason: "Keep identity keys private; only business references are requested.", decided_at: inspection.inspected_at });
    }
  }
  const build = (projectRoot = "/synthetic/read-relationship-preparation") => buildAutoBoundary({ inspection, overrides, sourceEnv: "DATABASE_URL", inspectedSchema: schema,
    project: { root: projectRoot, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  return { build, inspection, tenant, principal, root: `${schema}.${root.name}`, targets: tables.slice(1).map(t => `${schema}.${t.name}`) };
}

const nativeRoots: string[] = [];
afterEach(async () => { for (const root of nativeRoots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function nativeRelationshipContext(f: ReturnType<typeof fixture>, original = "Read the release and both selected business references.", principalRoots?: readonly string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typed-relationship-transition-")); nativeRoots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const build = f.build(root), generated = build.exploration_boundary, pending = withoutLinks(generated);
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  let context = await loadBoundaryReviewContext(root);
  const commit = async (candidate: ExplorationBoundaryDraft) => {
    const preview = await prepareExactBoundaryCandidateMutation(root, { candidate,
      expected_generated_boundary_digest: context.bundle.candidate_digest,
      expected_candidate_digest: explorationBoundaryCandidateDigest(candidate), expected_bindings: context.bundle.mutation_bindings,
      actor: "declared structural operator", reason: "Review the exact inspected path for the declared test job." }, async () => f.inspection);
    await commitExactBoundaryCandidateMutation(root, preview); context = await loadBoundaryReviewContext(root); return context.candidate;
  };
  await commit(pending);
  await boundaryReviewCommand(["--project-root", root, "--confirm", "--actor", "declared structural operator", "--output", path.join(root, "review.json")],
    async () => f.inspection, { ...session(async () => undefined), confirm: async (_message, options) => {
      if (!options?.context?.length) throw new Error("Actual structural review must display current settings"); return true;
    } });
  context = await loadBoundaryReviewContext(root);
  const current = () => {
    const catalog = readWorkloadCatalog(context.candidate, principalRoots);
    return projectReadScopeHostContext({ request: { id: "job", text: original },
      catalog: { digest: catalog.digest, resources: catalog.resources,
        relationships: catalog.resources.flatMap(resource => resource.relationships.map(link => ({ id: link.id, from: resource.id, to: link.target_resource }))),
        subject_scopes: projectReadSubjectContext({ context, sourceDigest: canonicalJsonDigest(null) }).subject_scopes },
      binding: { meaning_digest: canonicalJsonDigest(original), applicability_digest: canonicalJsonDigest("selected reference use"),
        operation_digest: canonicalJsonDigest(context.candidate) } });
  };
  return { current, commit, generated: context.draft, pending: context.candidate, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current } };
}

describe("Read relationship preparation orchestration", () => {
  it("recognizes only matching tenant or principal roles, not arbitrary or crossed private fields", () => {
    const a = { tenant_key: "tenant_a", principal_key: "person_a" }, b = { tenant_key: "tenant_b", principal_key: "person_b" };
    expect(isReadRelationshipScopePair(a, b, "tenant_a", "tenant_b")).toBe(true);
    expect(isReadRelationshipScopePair(a, b, "person_a", "person_b")).toBe(true);
    expect(isReadRelationshipScopePair(a, b, "person_a", "tenant_b")).toBe(false);
    expect(isReadRelationshipScopePair(a, {}, "person_a", "person_b")).toBe(false);
    expect(isReadRelationshipScopePair(a, b, "private_a", "private_b")).toBe(false);
  });
  it.each([false, true])("keeps inspected composite principal pairs after exact scope review (renamed=%s)", renamed => {
    const f = fixture(renamed), result = f.build();
    const graph = result.graph.resources.find(r => r.id === f.root)!;
    expect(graph.relationships).toHaveLength(2);
    expect(graph.relationships.every(r => r.cardinality_proven && !r.nullable)).toBe(true);
    const resource = result.exploration_boundary.pack.resources.find(r => r.id === f.root)!;
    expect(resource.kept_out_fields).toEqual(expect.arrayContaining([f.tenant, f.principal]));
    expect(resource.relationships).toHaveLength(2);
    expect(resource.relationships.every(r => r.proof!.links[0]!.source_columns.length === 3)).toBe(true);
    expect(() => reviewExplorationBoundaryCandidate(result.exploration_boundary, structuredClone(result.exploration_boundary))).not.toThrow();
    const catalog = readWorkloadCatalog(result.exploration_boundary);
    expect(catalog.resources.find(r => r.id === f.root)!.fields.map(f => f.id)).not.toContain(f.principal);
  });

  it("routes an unavailable-link question to exact host review instead of repeating Available links []", async () => {
    const f = fixture(), native = await nativeRelationshipContext(f, "Read the release and its two associated business references."), boundary = native.pending;
    const question = { relationship_review_request: { resource: f.root,
      reason: "The requested associated business references need exact reviewed links.",
      question: "Which available links return the selected review and clearance references?" } };
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "relationship_question",
      name: "runner__submit_read_workloads", arguments: JSON.stringify(question) }] } }));
    const relationshipReviewHandler = vi.fn(async () => undefined);
    const input = { name: "release_references", allowedQuestions: ["Read the release and its two associated business references."],
      generatedBoundary: boundary, provider: "openai" as const, model: "gpt-test", apiKey: "test-key", egressAcknowledged: true,
      deferNarration: true, structuredScope: native.structuredScope, dependencies: { requestJson }, relationshipReviewHandler };
    await expect(generateModelReadWorkload(input)).rejects.toThrow("READ_RELATIONSHIP_REVIEW_PENDING");
    expect(relationshipReviewHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reviews two exact paths and rebuilds the model catalog without private key exposure (renamed=%s)", async renamed => {
    const f = fixture(renamed), native = await nativeRelationshipContext(f);
    const generated = native.generated, pending = native.pending;
    const before = structuredClone(generated), pendingBefore = structuredClone(pending);
    const choices: string[] = [];
    const assertCurrent = vi.fn(async () => {});
    const relationshipReviewHandler = vi.fn<NonNullable<Parameters<typeof generateModelReadWorkload>[0]["relationshipReviewHandler"]>>(async (request, boundary) => {
      const prepared = await prepareReadWorkloadRelationship({ projectRoot: "/synthetic/read-relationship-preparation", boundary, generatedBoundary: generated,
        fromResource: request.resource, modelLabel: "test provider", assertCurrent,
        session: session(async (_title, options, details) => {
          expect(details?.initialValue).toBe("pending");
          expect(details?.requireExplicitSelection).toBe(true);
          expect(JSON.stringify(details?.exactDetails)).toContain(`${f.principal} = ${f.principal}`);
          const selected = options.find(option => option.value !== "pending")!;
          choices.push(selected.detail!);
          return selected.value;
        }) });
      if (!prepared) return undefined;
      const candidate = await native.commit(prepared.candidate);
      return { ...prepared, candidate };
    });
    let calls = 0;
    const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async request => {
      const body = JSON.stringify(request.body);
      const catalogText = body.slice(body.lastIndexOf("Structural catalog:"));
      expect(catalogText).not.toContain('\\"id\\":\\"id\\"');
      expect(catalogText).not.toContain(f.principal);
      expect(catalogText).not.toContain(f.tenant);
      for (const privateKey of ["selected_1_id", "selected_2_id"]) expect(catalogText).not.toContain(privateKey);
      calls++;
      if (calls === 2) expect(body).toContain(generated.pack.resources.find(r => r.id === f.root)!.relationships[0]!.id);
      if (calls === 3) {
        expect(body).toContain(generated.pack.resources.find(r => r.id === f.root)!.relationships[1]!.id);
      }
      return response(calls < 3 ? { relationship_review_request: { resource: f.root,
        reason: "The complete request still needs its selected related reference.", question: "Prepare the remaining exact business reference link." } }
        : { read_scope: { protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested", requirements: [{
          id: "references", intended_use: "Read the release and both selected business references.", references: ["job"], disposition: "include",
          subjects: [{ root_resource: f.root, mode: "trusted_principal" }], targets: [
            { root_resource: f.root, resource: f.root, operation: "resource" },
            { root_resource: f.root, resource: f.root, operation: "return", field: "business_ref" },
            ...generated.pack.resources.find(r => r.id === f.root)!.relationships.flatMap(link => [
              { root_resource: f.root, resource: f.root, operation: "relationship", relationship: link.id, qualifier: link.target_resource },
              { root_resource: f.root, resource: link.target_resource, operation: "return", field: "business_ref", relationship: link.id },
            ]),
          ],
        }] }, allowed: [{ id: "references", description: "Read selected business references", plan: { kind: "rows", resource: f.root,
          select: ["business_ref"], related: generated.pack.resources.find(r => r.id === f.root)!.relationships.map(link => ({ relationship: link.id, select: ["business_ref"] })) } }], forbidden: [] });
    });
    const result = await generateModelReadWorkload({ name: "references", allowedQuestions: ["Read the release and both selected business references."],
      provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true, deferNarration: true,
      generatedBoundary: pending, structuredScope: native.structuredScope, dependencies: { requestJson }, relationshipReviewHandler });
    expect(result.analysis.status).toBe("ready");
    expect(result.analysis.candidate!.pack.resources.find(r => r.id === f.root)!.relationships).toHaveLength(2);
    expect(relationshipReviewHandler).toHaveBeenCalledTimes(2);
    expect(new Set(choices).size).toBe(2);
    expect(calls).toBe(3);
    expect(generated).toEqual(before);
    expect(pending).toEqual(pendingBefore);
    expect(result).toMatchObject({ authority_granted: false, source_query_executed: false, source_database_changed: false });
  });

  it.each(["pending", undefined])("keeps a declined or cancelled exact review unchanged (%s)", async choice => {
    const f = fixture(), generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    const before = structuredClone(pending);
    const chooseOption = vi.fn(async () => choice);
    await expect(prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: f.root, modelLabel: "test provider", assertCurrent: async () => {},
      session: session(chooseOption) })).resolves.toBeUndefined();
    expect(chooseOption).toHaveBeenCalledOnce();
    expect(pending).toEqual(before);
  });

  it("requires explicit exact selection when two catalog constraints reach the same target", async () => {
    const f = fixture();
    const original = f.inspection.tables[0]!.foreign_keys[0]!;
    f.inspection.tables[0]!.foreign_keys.push({ ...original, name: "alternate_review_fk" });
    const generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    const chooseOption = vi.fn<NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>>(async (_title, choices, options) => {
      expect(choices.filter(c => c.value !== "pending")).toHaveLength(2);
      expect(options?.initialValue).toBe("pending");
      return choices.find(c => c.detail?.includes("alternate_review_fk"))!.value;
    });
    const result = await prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: f.root, toResource: f.targets[0], modelLabel: "test provider",
      assertCurrent: async () => {}, session: session(chooseOption) });
    expect(result!.reviewed_relationship.relationship_id).toBe("alternate_review_fk");
    expect(result!.candidate.pack.resources.find(r => r.id === f.root)!.relationships).toHaveLength(1);
    expect(pending.pack.resources.every(r => r.relationships.length === 0)).toBe(true);
  });

  it.each(["inverse", "excluded_target", "nullable", "missing_uniqueness"])("refuses unsupported or unreviewed paths before consent (%s)", async mode => {
    const f = fixture();
    if (mode === "nullable") f.inspection.tables[0]!.columns.find(c => c.name === "selected_1_id")!.nullable = true;
    if (mode === "missing_uniqueness") f.inspection.tables[1]!.unique_constraints = [];
    const generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    if (mode === "excluded_target") pending.pack.resources = pending.pack.resources.filter(r => r.id !== f.targets[0]);
    const chooseOption = vi.fn(async () => "0");
    await expect(prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: mode === "inverse" ? f.targets[0]! : f.root,
      toResource: mode === "inverse" ? f.root : f.targets[0], modelLabel: "test provider", assertCurrent: async () => {},
      session: session(chooseOption) })).rejects.toThrow("READ_RELATIONSHIP_RESTORE_UNAVAILABLE");
    expect(chooseOption).not.toHaveBeenCalled();
  });

  it.each(["candidate", "proof", "lock", "host"])("rejects concurrent changes during exact consent (%s)", async mode => {
    const f = fixture(), generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    let selected = false;
    await expect(prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: f.root, toResource: f.targets[0], modelLabel: "test provider",
      assertCurrent: async () => { if (mode === "host" && selected) throw new Error("TEST_CONCURRENT_HOST_CHANGE"); },
      session: session(async () => {
        selected = true;
        if (mode === "candidate") pending.budgets.max_rows = 3;
        if (mode === "proof") generated.pack.resources.find(r => r.id === f.root)!.relationships[0]!.proof!.links[0]!.constraint_name = "changed_fk";
        if (mode === "lock") generated.generation_lock_fingerprint = canonicalJsonDigest("new inspection");
        return "0";
      }) })).rejects.toThrow(mode === "host" ? "TEST_CONCURRENT_HOST_CHANGE" : "READ_RELATIONSHIP_PROOF_STALE");
    expect(pending.pack.resources.every(r => r.relationships.length === 0)).toBe(true);
  });

  it("rejects changes to field privacy in a host relationship callback", async () => {
    const f = fixture(), generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    const prepared = await prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: f.root, modelLabel: "test provider", assertCurrent: async () => {}, session: session(async () => "0") });
    prepared!.candidate.pack.resources[0]!.model_withheld_fields = [];
    expect(() => validateReadWorkloadRelationshipPreparation(prepared!, pending)).toThrow("READ_RELATIONSHIP_PREPARATION_WIDENED");
  });

  it.each(["failed_save", "noop_save", "wrong_root", "stale_return"])("does not remap against an uncommitted or mismatched callback result (%s)", async mode => {
    const f = fixture(), native = await nativeRelationshipContext(f, "Read selected related references."), generated = native.generated, pending = native.pending;
    const before = structuredClone(pending);
    const requestJson = vi.fn(async () => response({ relationship_review_request: { resource: f.root,
      reason: "A selected record link is unavailable.", question: "Prepare the exact selected record association." } }));
    const relationshipReviewHandler: NonNullable<Parameters<typeof generateModelReadWorkload>[0]["relationshipReviewHandler"]> = async (_request, boundary) => {
      const prepared = await prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary,
        generatedBoundary: generated, fromResource: f.root, modelLabel: "test provider", assertCurrent: async () => {}, session: session(async () => "0") });
      if (mode === "failed_save") throw new Error("TEST_SAVE_FAILED");
      if (mode === "noop_save") prepared!.candidate = structuredClone(boundary);
      if (mode === "wrong_root") prepared!.reviewed_relationship = { ...prepared!.reviewed_relationship, resource: f.targets[0]! };
      if (mode === "stale_return") prepared!.previous_candidate_digest = canonicalJsonDigest("stale review");
      return prepared;
    };
    await expect(generateModelReadWorkload({ name: "references", allowedQuestions: ["Read selected related references."],
      provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true, deferNarration: true,
      generatedBoundary: pending, structuredScope: native.structuredScope, dependencies: { requestJson }, relationshipReviewHandler }))
      .rejects.toThrow(mode === "failed_save" ? "TEST_SAVE_FAILED" : mode === "noop_save" ? "READ_RELATIONSHIP_PREPARATION_WIDENED"
        : mode === "wrong_root" ? "READ_RELATIONSHIP_REVIEW_MISMATCH" : "READ_RELATIONSHIP_CANDIDATE_STALE");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(pending).toEqual(before);
  });

  it("refuses a kept-out non-scope join field without promoting it to readable or internal use", async () => {
    const f = fixture(), generated = f.build().exploration_boundary, pending = withoutLinks(generated);
    const root = pending.pack.resources.find(r => r.id === f.root)!;
    root.kept_out_fields.push("selected_1_id");
    root.selectable_fields = root.selectable_fields.filter(field => field !== "selected_1_id");
    root.model_withheld_fields = root.model_withheld_fields?.filter(field => field !== "selected_1_id");
    const before = structuredClone(pending);
    await expect(prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary: pending,
      generatedBoundary: generated, fromResource: f.root, toResource: f.targets[0], modelLabel: "test provider",
      assertCurrent: async () => {}, session: session(async () => "0") })).rejects.toThrow(/kept-out field/);
    expect(pending).toEqual(before);
  });

  it("detects proof drift during the model follow-up even though the public catalog shape is unchanged", async () => {
    const f = fixture(), native = await nativeRelationshipContext(f, "Read related references."), generated = native.generated, pending = native.pending;
    let prepared: Awaited<ReturnType<typeof prepareReadWorkloadRelationship>>;
    let calls = 0;
    const requestJson = vi.fn(async () => {
      if (++calls === 1) return response({ relationship_review_request: { resource: f.root,
        reason: "A selected record link is unavailable.", question: "Prepare its exact record link." } });
      const current = prepared!.candidate;
      const catalogBefore = readWorkloadCatalog(current);
      current.pack.resources.find(r => r.id === f.root)!.relationships[0]!.proof!.links[0]!.constraint_name = "changed_during_model";
      expect(readWorkloadCatalog(current)).toEqual(catalogBefore);
      return response({ read_scope: relatedScope(f, [prepared!.reviewed_relationship.relationship_id], "Read related references."), allowed: [{ id: "references", description: "Read related reference", plan: { kind: "rows", resource: f.root,
        select: ["business_ref"], related: [{ relationship: prepared!.reviewed_relationship.relationship_id, select: ["business_ref"] }] } }], forbidden: [] });
    });
    await expect(generateModelReadWorkload({ name: "references", allowedQuestions: ["Read related references."],
      provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true, deferNarration: true,
      generatedBoundary: pending, structuredScope: native.structuredScope, dependencies: { requestJson }, relationshipReviewHandler: async (_request, boundary) => {
        prepared = await prepareReadWorkloadRelationship({ projectRoot: "/synthetic/review", boundary,
          generatedBoundary: generated, fromResource: f.root, modelLabel: "test provider", assertCurrent: async () => {}, session: session(async () => "0") });
        if (prepared) prepared = { ...prepared, candidate: await native.commit(prepared.candidate) };
        return prepared;
      } })).rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    expect(calls).toBe(2);
  });

  it("retains the existing model-catalog guard when the host's own-record root projection changes", async () => {
    const f = fixture(), roots = [f.root], native = await nativeRelationshipContext(f, "Read my business reference.", roots), generated = native.pending;
    const requestJson = vi.fn(async () => {
      roots.push(f.targets[0]!);
      return response({ read_scope: relatedScope(f, [], "Read my business reference."), allowed: [{ id: "references", description: "Read a business reference",
        plan: { kind: "rows", resource: f.root, select: ["business_ref"] } }], forbidden: [] });
    });
    await expect(generateModelReadWorkload({ name: "references", allowedQuestions: ["Read my business reference."],
      provider: "openai", model: "gpt-test", apiKey: "test-key", egressAcknowledged: true, deferNarration: true,
      generatedBoundary: generated, principalScopedRootResources: roots, structuredScope: native.structuredScope, dependencies: { requestJson } }))
      .rejects.toMatchObject({ code: "ASK_AUTHORITY_CHANGED" });
    expect(requestJson).toHaveBeenCalledOnce();
  });
});

// Exact test-request mapping, declared independently of the provider's plan.
function relatedScope(f: ReturnType<typeof fixture>, relationshipIds: string[], request: string) {
  const links = f.build().exploration_boundary.pack.resources.find(resource => resource.id === f.root)!.relationships;
  return { protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested", requirements: [{
    id: "references", intended_use: request, references: ["job"], disposition: "include", subjects: [{ root_resource: f.root, mode: "trusted_principal" }],
    targets: [{ root_resource: f.root, resource: f.root, operation: "resource" },
      { root_resource: f.root, resource: f.root, operation: "return", field: "business_ref" },
      ...relationshipIds.flatMap(id => {
        const link = links.find(link => link.id === id); if (!link) throw new Error("Only the declared inspected relationship may be mapped");
        return [{ root_resource: f.root, resource: f.root, operation: "relationship", relationship: id, qualifier: link.target_resource },
          { root_resource: f.root, resource: link.target_resource, operation: "return", relationship: id, field: "business_ref" }];
      })],
  }] };
}

function withoutLinks(generated: ExplorationBoundaryDraft) {
  const pending = structuredClone(generated);
  for (const resource of pending.pack.resources) resource.relationships = [];
  return pending;
}

function session(chooseOption: NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>): BoundaryReviewInteractiveSession {
  return { chooseOption, promptText: async () => undefined, confirm: async () => false,
    chooseResource: async () => undefined, editFieldTiers: async () => undefined };
}

function response(payload: unknown) {
  return { status: 200, body: { output: [{ type: "function_call", call_id: "relationship_mapping",
    name: "runner__submit_read_workloads", arguments: JSON.stringify(payload) }] } };
}
