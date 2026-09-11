import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";

const resource = "coded.r2", parentResource = "coded.r1";
const lock = `sha256:${"a".repeat(64)}` as const;
const parentKeys = ["k0", "k1", "k2"], childKeys = ["f0", "f1", "f2"];

function column(name: string, data_type = "varchar(64)"): TableInfo["columns"][number] {
  return { name, data_type, nullable: false, generated: false, identity: false, ordinal_position: 1,
    suggestions: { tenant: false, conflict: name === "version", sensitive: false, immutable: false, large_or_binary: false } };
}

function table(name: string, names: string[]): TableInfo {
  return { schema: "coded", name, type: "table", writable: true, columns: names.map(name => column(name)),
    primary_key: [names[0]!], unique_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: names } };
}

function fixture() {
  const parent = table("r1", [...parentKeys, "state", "version"]);
  parent.columns.find(field => field.name === "version")!.data_type = "integer";
  parent.suggestions.conflict_columns = ["version"];
  parent.unique_constraints = [{ name: "parent_tuple", columns: parentKeys }];
  const child = table("r2", ["row_key", ...childKeys, "tenant_id", "principal_id", "state", "effective_at"]);
  child.columns.find(field => field.name === "state")!.enum_values = ["admitted", "withdrawn"];
  child.columns.find(field => field.name === "effective_at")!.data_type = "timestamp with time zone";
  child.foreign_keys = [{ name: "r2_r1_fk", columns: childKeys, referenced_schema: "coded", referenced_table: "r1",
    referenced_columns: parentKeys, delete_rule: "RESTRICT" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "16", current_user: "reader", inspected_at: "2026-09-10T00:00:00.000Z",
    schemas: ["coded"], warnings: [], tables: [parent, child, table("unselected", ["id", "secret"])] };
  const boundary: ExplorationBoundaryDraft = {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "production",
    source: "database", compiler_version: "test", spec_version: "test", generation_lock_fingerprint: lock,
    role_posture_fingerprint: rolePostureFingerprint(inspection),
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    pack: { name: "coded_read", resources: [{ id: parentResource, schema: "coded", table: "r1", primary_key: "k0", tenant_key: "k1", principal_key: "k2",
      field_types: Object.fromEntries(parent.columns.map(field => [field.name, "text"])), field_enums: {}, selectable_fields: ["k0", "state"],
      filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {},
      kept_out_fields: ["k1", "k2", "version"], relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true }] },
    budgets: { max_rows: 50, max_groups: 50, max_top_n: 25, max_measures: 3, max_dimensions: 3, max_time_ranges: 2,
      max_relationship_hops: 2, max_response_cells: 500, max_response_bytes: 65536, statement_timeout_ms: 3000, max_complexity: 24,
      max_queries_per_session: 1000, max_extracted_cells_per_session: 4000, max_differencing_queries: 16, rate_limit_per_minute: 120 },
    unresolved_decisions: [],
  };
  const built = buildActionRuleAuthoringCatalog({ boundary, inspection });
  return { built, boundary, inspection, resource, parentResource };
}

describe("pure private Action source preparation", () => {
  it("derives coded guards only from a full composite FK, without changing Read or existing Action authority", () => {
    const input = fixture(), before = structuredClone(input);
    const result = preparePrivateActionSource(input);
    expect(input).toEqual(before);
    expect(result.built.catalog.resources.map(item => item.name)).toEqual([parentResource, resource]);
    expect(result.built.catalog.resources[0]).toEqual(input.built.catalog.resources[0]);
    expect(result.built.authoring.resources[0]).toEqual(input.built.authoring.resources[0]);
    expect(result.built.catalog.resources[1]).toMatchObject({ name: resource, primary_key: "row_key", tenant_key: "f1", principal_scope_key: "f2", verification_only: true });
    expect(result.built.catalog.resources[1]!.version_field).toBeUndefined();
    expect(result.built.authoring.resources[1]).toMatchObject({ verification_only: true, operations: { insert: false, update: false } });
    expect(result.built.authoring.resources[1]!.fields.every(field => !field.writable && field.role !== "model_visible")).toBe(true);
    expect(result.built.authoring.diagnostics.some(item => item.resource === resource && item.code === "ACTION_RULE_VERSION_REQUIRED")).toBe(false);
    expect(result.built.catalog.relationships).toEqual([{ name: "r2_r1_fk", from_resource: resource, to_resource: parentResource,
      field_pairs: childKeys.map((local_field, index) => ({ local_field, target_field: parentKeys[index] })),
      cardinality: "many_to_one", nullable: false, target_unique: true }]);
    expect(result.review).toMatchObject({ resource, parent_resource: parentResource, relationship: "r2_r1_fk", proof_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    const details = result.details.join("\n");
    for (const value of ["Operator-only", "egress consent", "admitted", "withdrawn", "effective_at", "f1", "f2", result.review.proof_digest]) expect(details).toContain(value);
    for (const section of ["Source and purpose", "Reviewed scope proof", "Private field metadata:", "Review fingerprints"]) expect(details).toContain(section);
    for (let index = 0; index < childKeys.length; index++) expect(details).toContain(`Pair ${index + 1}: ${resource}."${childKeys[index]}" -> ${parentResource}."${parentKeys[index]}"`);
    expect(details).not.toContain('"proof": {');
    const { digest, ...authoring } = result.built.authoring;
    expect(digest).toBe(canonicalJsonDigest(authoring));
    result.built.catalog.resources[0]!.fields[0]!.name = "caller_mutation";
    expect(input).toEqual(before);
  });

  it("replays idempotently, including after unrelated catalog expansion and an ordinary catalog rebuild", () => {
    const input = fixture(), first = preparePrivateActionSource(input);
    const replay = preparePrivateActionSource({ ...input, built: first.built });
    expect(replay).toEqual(first);
    const expanded = structuredClone(first.built);
    expanded.catalog.resources.push({ ...structuredClone(input.built.catalog.resources[0]!), name: "coded.unrelated", table: "unrelated" });
    expect(preparePrivateActionSource({ ...input, built: expanded }).review).toEqual(first.review);
    const rebuilt = buildActionRuleAuthoringCatalog({ ...input, retainedCatalog: first.built.catalog });
    expect(preparePrivateActionSource({ ...input, built: rebuilt }).review).toEqual(first.review);
    expect(rebuilt.authoring.resources.find(item => item.name === resource)!.operations).toEqual({ update: false, insert: false });
  });

  it("keeps an inverse relationship a collection even with a unique child FK tuple", () => {
    const input = fixture();
    input.inspection.tables[1]!.unique_constraints = [{ name: "one_per_parent", columns: childKeys }];
    expect(preparePrivateActionSource(input).built.catalog.relationships[0]!.cardinality).toBe("many_to_one");
  });

  it("binds proof to current private metadata, Read revision and lock, not just source names", () => {
    const input = fixture(), first = preparePrivateActionSource(input);
    const changedMetadata = structuredClone(input);
    changedMetadata.inspection.tables[1]!.columns.find(field => field.name === "state")!.enum_values!.push("expired");
    expect(preparePrivateActionSource(changedMetadata).review.proof_digest).not.toBe(first.review.proof_digest);
    expect(() => preparePrivateActionSource({ ...changedMetadata, built: first.built })).toThrow("previously reviewed private metadata changed");
    const changedRead = structuredClone(input);
    changedRead.boundary.pack.resources[0]!.selectable_fields = ["k0"];
    expect(preparePrivateActionSource(changedRead).review.proof_digest).not.toBe(first.review.proof_digest);
    const changedLock = structuredClone(input), nextLock = `sha256:${"c".repeat(64)}` as const;
    changedLock.boundary.generation_lock_fingerprint = nextLock;
    changedLock.built.catalog.generation_lock_fingerprint = nextLock;
    changedLock.built.authoring.generation_lock_fingerprint = nextLock;
    expect(preparePrivateActionSource(changedLock).review.proof_digest).not.toBe(first.review.proof_digest);
  });

  it.each(["missing_fk", "partial_tuple", "duplicate_pair", "nullable_child", "nullable_parent", "nonportable_pk", "nullable_pk", "composite_pk",
    "nonunique_parent", "partial_unique", "unusable_unique", "deferred", "unvalidated", "inexact", "wrong_type", "ambiguous", "duplicate_fk_name", "self_fk"])("rejects %s without mutating input", failure => {
    const input = fixture(), parent = input.inspection.tables[0]!, child = input.inspection.tables[1]!, fk = child.foreign_keys[0]!;
    if (failure === "missing_fk") child.foreign_keys = [];
    if (failure === "partial_tuple") fk.columns = ["f0"];
    if (failure === "duplicate_pair") fk.columns = ["f0", "f0", "f2"];
    if (failure === "nullable_child") child.columns.find(field => field.name === "f1")!.nullable = true;
    if (failure === "nullable_parent") parent.columns.find(field => field.name === "k2")!.nullable = true;
    if (failure === "nonportable_pk") child.columns[0]!.data_type = "jsonb";
    if (failure === "nullable_pk") child.columns[0]!.nullable = true;
    if (failure === "composite_pk") child.primary_key.push("f1");
    if (failure === "nonunique_parent") parent.unique_constraints = [];
    if (failure === "partial_unique" || failure === "unusable_unique") parent.indexes = [{ name: "parent_tuple", unique: true,
      ...(failure === "partial_unique" ? { catalog_partial: true } : { catalog_usable: false }) }];
    if (failure === "deferred") fk.deferrable = true;
    if (failure === "unvalidated") fk.action_rule_issue = "unvalidated_foreign_key";
    if (failure === "inexact") fk.action_rule_issue = "non_exact_collation";
    if (failure === "wrong_type") child.columns.find(field => field.name === "f1")!.data_type = "boolean";
    if (failure === "ambiguous" || failure === "duplicate_fk_name") child.foreign_keys.push({ ...structuredClone(fk), name: failure === "ambiguous" ? "other_fk" : fk.name });
    if (failure === "self_fk") { fk.referenced_table = "r2"; child.columns.push(...parentKeys.map(name => column(name))); child.unique_constraints = [{ name: "self_tuple", columns: parentKeys }]; }
    const before = structuredClone(input);
    expect(() => preparePrivateActionSource(input)).toThrow("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED");
    expect(input).toEqual(before);
  });

  it.each(["unknown_source", "unknown_parent", "unreviewed_parent", "public_source", "retained_writable", "lock", "role", "read_scope", "catalog_scope", "derived_scope"])("rejects invalid review binding %s", failure => {
    const input = fixture();
    if (failure === "unknown_source") input.resource = "coded.absent";
    if (failure === "unknown_parent") input.parentResource = "coded.absent";
    if (failure === "unreviewed_parent") input.parentResource = "coded.unselected";
    if (failure === "public_source") input.boundary.pack.resources.push({ ...input.boundary.pack.resources[0]!, id: resource });
    if (failure === "retained_writable") input.built.catalog.resources.push({ ...input.built.catalog.resources[0]!, name: resource });
    if (failure === "lock") input.boundary.generation_lock_fingerprint = `sha256:${"b".repeat(64)}`;
    if (failure === "role") input.inspection.current_user = "another_reader";
    if (failure === "read_scope") input.boundary.pack.resources[0]!.principal_key = "k0";
    if (failure === "catalog_scope") delete input.built.catalog.resources[0]!.principal_scope_key;
    if (failure === "derived_scope") input.built.authoring.resources[0]!.principal_scope = "unsupported_derived";
    expect(() => preparePrivateActionSource(input)).toThrow("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED");
  });

  it("does not let an already-private source acquire a different reviewed parent", () => {
    const input = fixture(), first = preparePrivateActionSource(input);
    const otherTable = { ...structuredClone(input.inspection.tables[0]!), name: "other_parent" };
    input.inspection.tables.push(otherTable);
    input.boundary.role_posture_fingerprint = rolePostureFingerprint(input.inspection);
    first.built.catalog.resources.push({ ...structuredClone(first.built.catalog.resources[0]!), name: "coded.other_parent", table: "other_parent" });
    first.built.authoring.resources.push({ ...structuredClone(first.built.authoring.resources[0]!), name: "coded.other_parent" });
    input.inspection.tables[1]!.foreign_keys.push({ ...structuredClone(input.inspection.tables[1]!.foreign_keys[0]!), name: "other_parent_fk", referenced_table: "other_parent" });
    expect(() => preparePrivateActionSource({ ...input, built: first.built, parentResource: "coded.other_parent" })).toThrow("exact reviewed parent relationship must be retained");
  });

  it.each(["resources", "fields"])("bounds private %s without counting ordinary retained writable targets", limit => {
    const input = fixture();
    if (limit === "resources") for (let index = 0; index < 16; index++) input.built.catalog.resources.push({
      ...structuredClone(input.built.catalog.resources[0]!), name: `coded.private_${index}`, verification_only: true });
    else input.inspection.tables[1]!.columns.push(...Array.from({ length: 129 }, (_, index) => column(`extra_${index}`)));
    expect(() => preparePrivateActionSource(input)).toThrow("bounded to 16 resources and 128 inspected fields");
  });

  it("allows the exact 16-source bound and replays the sixteenth without counting it twice", () => {
    const input = fixture();
    for (let index = 0; index < 15; index++) input.built.catalog.resources.push({
      ...structuredClone(input.built.catalog.resources[0]!), name: `coded.private_${index}`, verification_only: true });
    const result = preparePrivateActionSource(input);
    expect(result.built.catalog.resources.filter(item => item.verification_only)).toHaveLength(16);
    expect(preparePrivateActionSource({ ...input, built: result.built }).review).toEqual(result.review);
  });

  it("allows exactly 128 private fields without expanding to any unselected table", () => {
    const input = fixture(), child = input.inspection.tables[1]!;
    child.columns.push(...Array.from({ length: 128 - child.columns.length }, (_, index) => column(`extra_${index}`)));
    const result = preparePrivateActionSource(input);
    expect(result.built.catalog.resources.find(item => item.name === resource)!.fields).toHaveLength(128);
    expect(result.built.catalog.resources.some(item => item.name === "coded.unselected")).toBe(false);
  });
});
