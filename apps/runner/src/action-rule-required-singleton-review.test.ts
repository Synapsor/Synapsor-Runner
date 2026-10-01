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

describe("B36 required scoped singleton private preparation", () => {
  function ordinaryFixture() {
    const input = fixture(), child = input.inspection.tables[1]!;
    child.primary_key = ["f0"];
    child.foreign_keys[0]!.columns = ["f0"];
    child.foreign_keys[0]!.referenced_columns = ["k0"];
    // Synthetic positive catalogue qualification; not a live PostgreSQL observation.
    Object.assign(child.foreign_keys[0]!, { required_singleton_proof: {
      child_unique_key: "r2_pkey", child_unique_index: "r2_pkey",
      parent_unique_key: "r1_pkey", parent_unique_index: "r1_pkey",
    } });
    for (const table of input.inspection.tables) for (const column of table.columns) {
      column.postgres_declaration_digest = canonicalJsonDigest({ synthetic_only: true, name: column.name, type: column.data_type });
    }
    return input;
  }

  it("still refuses ordinary id-only metadata without independent scope review", () => {
    expect(() => preparePrivateActionSource(ordinaryFixture())).toThrow("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED");
  });

  it("represents reviewed required singleton evidence without claiming database-scoped or complete collection proof", () => {
    const input = ordinaryFixture(), before = structuredClone(input);
    const result = preparePrivateActionSource({ ...input, requiredSingletonScope: {
      relationship: "r2_r1_fk", tenant_field: "f1", principal_field: "f2",
    } } as Parameters<typeof preparePrivateActionSource>[0] & { requiredSingletonScope: {
      relationship: string; tenant_field: string; principal_field: string;
    } });
    expect(input).toEqual(before);
    expect(result.built.catalog.resources.find(value => value.name === resource)).toMatchObject({
      tenant_key: "f1", principal_scope_key: "f2", verification_only: true,
      private_evidence: { mode: "required_scoped_singleton", parent_resource: parentResource, relationship: "r2_r1_fk" },
    });
    expect(result.review).toMatchObject({ evidence_mode: "required_scoped_singleton" });
    expect(result.details.join("\n")).toContain("not database-enforced scope");
    expect(result.built.authoring.resources.find(value => value.name === resource)!.operations).toEqual({ update: false, insert: false });
    expect(result.built.catalog.resources.find(value => value.name === parentResource)).toEqual(before.built.catalog.resources[0]);
    expect(input.boundary.pack.resources).toEqual(before.boundary.pack.resources);
  });

  it("retains an unrelated enum in the ordinary catalog without fabricating its native proof", () => {
    const input = ordinaryFixture(), parent = input.inspection.tables[0]!;
    parent.columns.push({ ...column("status", "coded.unit_status"), enum_values: ["open", "ready", "held"] });
    input.built = buildActionRuleAuthoringCatalog({ boundary: input.boundary, inspection: input.inspection });
    const result = preparePrivateActionSource({ ...input, requiredSingletonScope: {
      relationship: "r2_r1_fk", tenant_field: "f1", principal_field: "f2",
    } });
    expect(result.built.catalog.resources.find(value => value.name === parentResource)!.fields)
      .toContainEqual(expect.objectContaining({ name: "status", type: expect.objectContaining({ enum: ["held", "open", "ready"] }) }));
    const purpose = result.built.catalog.resources.find(value => value.name === resource)!.private_evidence;
    expect(purpose!.column_declarations.parent.status).toBeUndefined();
    expect(purpose!.column_declarations.parent.k0).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(input.inspection.tables[0]!.columns.find(value => value.name === "status")!.postgres_declaration_digest).toBeUndefined();
  });

  it("refuses a missing native scope-column stamp rather than inventing it from the mapping", () => {
    const input = ordinaryFixture();
    delete input.inspection.tables[1]!.columns.find(value => value.name === "f1")!.postgres_declaration_digest;
    expect(() => preparePrivateActionSource({ ...input, requiredSingletonScope: {
      relationship: "r2_r1_fk", tenant_field: "f1", principal_field: "f2",
    } })).toThrow("native identities");
  });
});
