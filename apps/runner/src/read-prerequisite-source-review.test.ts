import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { listSupportedReadCurrentStatePrerequisiteCandidates } from "./read-prerequisite.js";
import { loadReadPrerequisiteSourceReview } from "./read-prerequisite-source-review.js";

const stored = vi.hoisted(() => ({ drafts: vi.fn(), active: vi.fn(), lock: vi.fn() }));
vi.mock("./action-rule-authority.js", async importOriginal => ({
  ...await importOriginal<typeof import("./action-rule-authority.js")>(),
  listActionRuleAuthorityDrafts: stored.drafts,
  readActionRuleAuthorityActivation: stored.active,
}));
vi.mock("./auto-boundary.js", async importOriginal => ({
  ...await importOriginal<typeof import("./auto-boundary.js")>(), loadGenerationLockSnapshot: stored.lock,
}));

function table(name: string, names: string[]): TableInfo {
  return { schema: "workshop", name, type: "table", writable: false,
    columns: names.map((name, index) => ({ name, data_type: "uuid", nullable: false, generated: false, ordinal_position: index + 1,
      suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } })),
    primary_key: ["row"], unique_constraints: [], foreign_keys: [], indexes: [], row_level_security: false,
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] },
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: false, row_security_effective_for_current_role: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } } };
}

function fixture(withRls = false) {
  const task = table("t9", ["row", "a", "b"]);
  const parent = table("p3", ["row", "a", "b"]);
  parent.unique_constraints = [{ name: "parent_pair", columns: ["a", "b"] }];
  const child = table("r7", ["row", "x", "y", "s", "d0", "d1"]);
  child.columns.find(field => field.name === "s")!.data_type = "text";
  child.columns.find(field => field.name === "s")!.enum_values = ["yes", "no"];
  for (const name of ["d0", "d1"]) child.columns.find(field => field.name === name)!.data_type = "timestamptz";
  child.unique_constraints = [{ name: "subject_pair", columns: ["x", "y"] }];
  child.foreign_keys = [{ name: "exact_parent", columns: ["y", "x"], referenced_schema: "workshop", referenced_table: "p3",
    referenced_columns: ["b", "a"], delete_rule: "RESTRICT" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "17", current_user: "reader", inspected_at: "2026-09-11T00:00:00Z",
    schemas: ["workshop"], warnings: [], tables: [task, parent, child],
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
  if (withRls) for (const table of inspection.tables) {
    const tenant = table.name === "r7" ? "x" : "a", principal = table.name === "r7" ? "y" : "b";
    table.row_level_security = true;
    table.row_level_security_policies = [{ name: "reader_scope", command: "SELECT", permissive: true, roles: ["reader"],
      using_expression: `${tenant} = current_setting('app.tenant')::uuid AND ${principal} = current_setting('app.person')::uuid` }];
    Object.assign(table.role_posture!, { row_security_forced: true, row_security_effective_for_current_role: true,
      row_security_applicable_policies: ["reader_scope"] });
  }
  const generated = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "workshop",
    project: { root: "/owned-synthetic-unit-only", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const originalRead = generated.exploration_boundary;
  originalRead.trusted_context = { provider: "environment", tenant_env: "FIXTURE_ORG", principal_env: "FIXTURE_PERSON" };
  originalRead.pack.resources = inspection.tables.map(table => ({ id: `${table.schema}.${table.name}`, schema: table.schema, table: table.name,
    primary_key: "row", tenant_key: table.name === "r7" ? "x" : "a", principal_key: table.name === "r7" ? "y" : "b",
    field_types: Object.fromEntries(table.columns.map(column => [column.name, column.data_type])), field_enums: {},
    selectable_fields: [], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
    count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: table.columns.map(column => column.name), relationships: [],
    minimum_cohort_size: 5, suppression_aware_totals: true }));
  const catalog = buildActionRuleAuthoringCatalog({ boundary: originalRead, inspection }).catalog;
  const boundary = structuredClone(originalRead);
  boundary.pack.resources = boundary.pack.resources.filter(resource => resource.table === "t9");
  const saved = { digest: canonicalJsonDigest("saved disabled Action bundle"), authority: { catalog,
    rules: ["reserve", "restore"].map(outcome => ({ rule: { outcome: `workshop.${outcome}` },
      read_boundary_name: boundary.pack.name, read_boundary_digest: canonicalJsonDigest(originalRead) })) } };
  stored.drafts.mockResolvedValue([saved]);
  stored.lock.mockImplementation(async (_root, digest) => {
    if (digest !== canonicalJsonDigest(generated.lock)) throw new Error("missing snapshot");
    return structuredClone(generated.lock);
  });
  return { input: { projectRoot: "/owned-synthetic-unit-only", boundary, inspection, generationLock: generated.lock },
    originalRead, catalog, saved, parent, child };
}

function refreshWriterMetadata(f: ReturnType<typeof fixture>) {
  f.input.inspection = structuredClone(f.input.inspection);
  f.input.inspection.tables.find(table => table.name === "r7")!.row_level_security_policies!.push({
    name: "separate_writer_scope", command: "UPDATE", permissive: true, roles: ["separate_writer"],
    using_expression: "x = current_setting('app.tenant')::uuid AND y = current_setting('app.person')::uuid",
    check_expression: "x = current_setting('app.tenant')::uuid AND y = current_setting('app.person')::uuid",
  });
  f.input.generationLock = { ...f.input.generationLock,
    schema_fingerprint: schemaFingerprintForInspection(f.input.inspection),
    role_posture_fingerprint: rolePostureFingerprint(f.input.inspection) };
  f.input.boundary.generation_lock_fingerprint = canonicalJsonDigest(f.input.generationLock);
  f.input.boundary.role_posture_fingerprint = f.input.generationLock.role_posture_fingerprint;
}

describe("private Read source review from older saved dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.drafts.mockResolvedValue([]);
    stored.active.mockResolvedValue(undefined);
  });

  it("recovers an orphaned disabled Read dependency only as fresh private scope proof", async () => {
    const f = fixture(), before = structuredClone(f);
    expect(() => listSupportedReadCurrentStatePrerequisiteCandidates(f.input.inspection, f.input.boundary))
      .toThrow("READ_PREREQUISITE_SCOPE_PROOF_MISSING");
    const review = await loadReadPrerequisiteSourceReview(f.input);
    const candidates = listSupportedReadCurrentStatePrerequisiteCandidates(f.input.inspection, { ...f.input.boundary, scopeEvidence: review.scopeEvidence });
    expect(candidates).toHaveLength(2);
    expect(candidates.every(candidate => candidate.subject.tenant_column === "x" && candidate.subject.principal_column === "y")).toBe(true);
    expect(f).toEqual(before);
    expect(f.input.boundary.pack.resources.map(resource => resource.table)).toEqual(["t9"]);
    await expect(review.assertCurrent()).resolves.toBeUndefined();
  });

  it.each(["schema", "role", "scope", "guard", "relationship", "snapshot", "source", "mixed_boundary"])("refuses stale saved proof without mutating either revision (%s)", async change => {
    const f = fixture();
    if (change === "schema") f.child.columns.find(field => field.name === "x")!.nullable = true;
    if (change === "role") f.input.inspection.role_posture!.bypass_rls = true;
    if (change === "scope") f.input.boundary.pack.resources[0]!.principal_key = "a";
    if (change === "guard") f.catalog.resources.find(resource => resource.table === "r7")!.fields.find(field => field.name === "x")!.nullable = true;
    if (change === "relationship") f.catalog.relationships[0]!.target_unique = false;
    if (change === "snapshot") stored.lock.mockRejectedValueOnce(new Error("missing snapshot"));
    if (change === "source") f.catalog.resources[0]!.source = "different_source";
    if (change === "mixed_boundary") f.saved.authority.rules[0]!.read_boundary_name = "another_boundary";
    const before = structuredClone(f);
    await expect(loadReadPrerequisiteSourceReview(f.input)).rejects.toThrow();
    expect(f).toEqual(before);
  });

  it.each(["removed", "changed", "new"])("refuses a saved-Action change during metadata review (%s)", async change => {
    const f = fixture();
    const review = await loadReadPrerequisiteSourceReview(f.input);
    if (change === "removed") stored.drafts.mockResolvedValue([]);
    if (change === "changed") stored.drafts.mockResolvedValue([{ ...f.saved, digest: canonicalJsonDigest("changed") }]);
    if (change === "new") stored.drafts.mockResolvedValue([f.saved, { ...f.saved, digest: canonicalJsonDigest("another disabled rule") }]);
    await expect(review.assertCurrent()).rejects.toThrow("READ_PREREQUISITE_SOURCE_REVIEW_CHANGED");
  });

  it("allows an evidence-only lock change while preserving every private dependency", async () => {
    const f = fixture();
    f.input.generationLock = { ...f.input.generationLock, reviewed_overrides_digest: canonicalJsonDigest("narrower Read review") };
    f.input.boundary.generation_lock_fingerprint = canonicalJsonDigest(f.input.generationLock);
    const before = structuredClone(f);
    const result = await loadReadPrerequisiteSourceReview(f.input);
    expect(result.scopeEvidence.retained_action_catalogs).toEqual([
      { ...f.catalog, generation_lock_fingerprint: f.input.boundary.generation_lock_fingerprint },
    ]);
    expect(f).toEqual(before);
  });

  it.each(["schema", "role", "context", "source"])("does not silently refresh changed source authority (%s)", async change => {
    const f = fixture();
    const nextLock = structuredClone(f.input.generationLock);
    if (change === "schema") {
      f.child.columns.find(field => field.name === "s")!.enum_values!.push("maybe");
      nextLock.schema_fingerprint = schemaFingerprintForInspection(f.input.inspection);
    }
    if (change === "role") {
      f.input.inspection.role_posture!.bypass_rls = true;
      nextLock.role_posture_fingerprint = rolePostureFingerprint(f.input.inspection);
      f.input.boundary.role_posture_fingerprint = nextLock.role_posture_fingerprint;
    }
    if (change === "context") nextLock.trusted_context_fingerprint = canonicalJsonDigest("different identity provider");
    if (change === "source") nextLock.source_env = "OTHER_DATABASE_URL";
    f.input.generationLock = nextLock;
    f.input.boundary.generation_lock_fingerprint = canonicalJsonDigest(nextLock);
    await expect(loadReadPrerequisiteSourceReview(f.input)).rejects.toThrow("ACTION_RULE_REVISION_STALE");
  });

  it("uses an exact retained parent proof without adding the private source to its catalog or Read", async () => {
    const f = fixture();
    f.catalog.resources = f.catalog.resources.filter(resource => resource.table !== "r7");
    f.catalog.relationships = [];
    const before = structuredClone(f);
    const review = await loadReadPrerequisiteSourceReview(f.input);
    expect(review.scopeEvidence.retained_action_catalogs[0]!.resources.some(resource => resource.table === "r7")).toBe(false);
    expect(listSupportedReadCurrentStatePrerequisiteCandidates(f.input.inspection, { ...f.input.boundary, scopeEvidence: review.scopeEvidence })).toHaveLength(2);
    expect(f).toEqual(before);
  });

  it("retains active dependencies as evidence without converting them to drafts", async () => {
    const f = fixture(), before = structuredClone(f);
    stored.drafts.mockResolvedValue([]);
    stored.active.mockResolvedValue(f.saved);
    const review = await loadReadPrerequisiteSourceReview(f.input);
    expect(review.scopeEvidence.retained_action_catalogs).toEqual([f.catalog]);
    expect(f).toEqual(before);
    stored.active.mockResolvedValue(undefined);
    await expect(review.assertCurrent()).rejects.toThrow("READ_PREREQUISITE_SOURCE_REVIEW_CHANGED");
  });

  it("does not recover withdrawn dependencies from history or infer them from source names", async () => {
    const f = fixture();
    stored.drafts.mockResolvedValue([]);
    const review = await loadReadPrerequisiteSourceReview(f.input);
    expect(review.scopeEvidence.retained_action_catalogs).toEqual([]);
    expect(() => listSupportedReadCurrentStatePrerequisiteCandidates(f.input.inspection, { ...f.input.boundary, scopeEvidence: review.scopeEvidence }))
      .toThrow("READ_PREREQUISITE_SCOPE_PROOF_MISSING");
    expect(stored.lock).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "alias", "derived", "conflicting_catalog", "too_many"])("refuses ambiguous scope evidence (%s)", async change => {
    const f = fixture();
    let retainedCatalogs;
    if (change === "duplicate") f.catalog.resources.push(structuredClone(f.catalog.resources[0]!));
    if (change === "alias") f.input.boundary.pack.resources.push({ ...f.originalRead.pack.resources.find(resource => resource.table === "p3")!,
      id: "reversed_alias", tenant_key: "b", principal_key: "a" });
    if (change === "derived") f.input.boundary.pack.resources[0]!.principal_scope = { mode: "derived", path_id: "other_scope",
      ancestor_resource: "workshop.p3", ancestor_column: "b",
      proof: { source: "database_catalog", links: [], digest: canonicalJsonDigest("different scoped path") } };
    if (change === "conflicting_catalog") {
      const other = structuredClone(f.catalog);
      other.resources.find(resource => resource.table === "r7")!.tenant_key = "y";
      other.resources.find(resource => resource.table === "r7")!.principal_scope_key = "x";
      retainedCatalogs = [other];
    }
    if (change === "too_many") retainedCatalogs = Array.from({ length: 17 }, (_, index) => ({ ...f.catalog,
      generation_lock_fingerprint: canonicalJsonDigest(`generation ${index}`) }));
    await expect(loadReadPrerequisiteSourceReview({ ...f.input, retainedCatalogs })).rejects.toThrow();
  });

  it("revalidates writer-only RLS additions after explicit rescan without widening Read or source purpose", async () => {
    const f = fixture(true);
    refreshWriterMetadata(f);
    const before = structuredClone(f);
    expect(f.catalog.generation_lock_fingerprint).not.toBe(f.input.boundary.generation_lock_fingerprint);
    const review = await loadReadPrerequisiteSourceReview({ ...f.input, revalidateMetadata: true });
    expect(review.scopeEvidence.retained_action_catalogs).toEqual([
      { ...f.catalog, generation_lock_fingerprint: f.input.boundary.generation_lock_fingerprint },
    ]);
    expect(listSupportedReadCurrentStatePrerequisiteCandidates(f.input.inspection, { ...f.input.boundary, scopeEvidence: review.scopeEvidence })).toHaveLength(2);
    expect(f).toEqual(before);
    expect(JSON.stringify(review.scopeEvidence)).not.toContain("separate_writer_scope");
    await expect(review.assertCurrent()).resolves.toBeUndefined();
  });

  it.each(["ordinary_edit", "field", "relationship", "reader", "writer_credential", "scope", "snapshot_credential", "stale_inspection"])("keeps writer-rescan proof bounded (%s)", async change => {
    const f = fixture(true), oldInspection = structuredClone(f.input.inspection);
    if (change === "snapshot_credential") {
      const prior = structuredClone(f.input.generationLock);
      delete prior.authority_dependencies;
      f.catalog.generation_lock_fingerprint = canonicalJsonDigest(prior);
      stored.lock.mockResolvedValue(prior);
    }
    refreshWriterMetadata(f);
    if (change === "field") f.input.inspection.tables.find(table => table.name === "r7")!.columns.find(column => column.name === "x")!.data_type = "integer";
    if (change === "relationship") f.input.inspection.tables.find(table => table.name === "r7")!.foreign_keys = [];
    if (change === "reader") f.input.inspection.current_user = "different_reader";
    if (change === "writer_credential") {
      f.input.inspection.role_posture!.read_only = false;
      f.input.inspection.role_posture!.writable_relations = ["workshop.r7"];
    }
    if (change === "scope") f.input.generationLock = { ...f.input.generationLock, trusted_context_fingerprint: canonicalJsonDigest("different trusted person mapping") };
    f.input.generationLock = { ...f.input.generationLock,
      schema_fingerprint: schemaFingerprintForInspection(f.input.inspection),
      role_posture_fingerprint: rolePostureFingerprint(f.input.inspection) };
    f.input.boundary.generation_lock_fingerprint = canonicalJsonDigest(f.input.generationLock);
    f.input.boundary.role_posture_fingerprint = f.input.generationLock.role_posture_fingerprint;
    if (change === "stale_inspection") f.input.inspection = oldInspection;
    const before = structuredClone(f);
    await expect(loadReadPrerequisiteSourceReview({ ...f.input, revalidateMetadata: change !== "ordinary_edit" })).rejects.toThrow();
    expect(f).toEqual(before);
  });
});
