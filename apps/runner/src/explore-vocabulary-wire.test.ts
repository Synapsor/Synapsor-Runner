import { describe, expect, it } from "vitest";
import { scopedExploreDescribeOutputSchema, scopedExploreDescribeToolOutputSchema } from "../../../packages/mcp-server/src/analytics-output-schema.js";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, type AutoBoundaryReviewOverrides } from "./auto-boundary.js";
import { describeBoundary } from "./scoped-explore.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

// Real compiler and discovery producer, synthetic inspected structure and declared
// review inputs only. This disabled draft does not claim native review/activation.
function discovery(labelled: boolean) {
  const inspection = ownedProgramInspection();
  const root = inspection.tables[0]!;
  const target = structuredClone(root);
  target.name = "destinations";
  target.unique_constraints.push({ name: "destination_tenant_pk", columns: ["tenant_id", "parcel_id"] });
  root.columns.push({ ...structuredClone(root.columns[0]!), name: "destination_id", ordinal_position: 9 });
  root.foreign_keys.push({ name: "parcel_destination", columns: ["tenant_id", "destination_id"],
    referenced_schema: "studio", referenced_table: "destinations", referenced_columns: ["tenant_id", "parcel_id"], delete_rule: "RESTRICT" });
  inspection.tables.push(target);
  const decision = { actor: "declared metadata fixture operator", reason: "Declared synthetic display contract.", decided_at: "2026-10-09T00:00:00.000Z" };
  const overrides: AutoBoundaryReviewOverrides = { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: {} };
  for (const table of inspection.tables) {
    overrides.resources[`studio.${table.name}`] = {
      row_identity: { ...decision, value: "parcel_id" }, tenant_key: { ...decision, value: "tenant_id" },
      principal_key: { ...decision, value: "principal_id" },
      fields: Object.fromEntries(table.columns.map(column => [column.name, { ...decision,
        exposure: column.name === "internal_note" ? "keep_out" : "allow_reviewed_use" }])),
      ...(labelled ? { metadata: { ...decision, label: "Reviewed display" }, field_metadata: {
        label: { ...decision, label: "Display label", description: "Reviewed description" },
        internal_note: { ...decision, label: "PRIVATE DISPLAY", description: "PRIVATE DESCRIPTION" },
      } } : {}),
    };
  }
  const build = buildAutoBoundary({ inspection, overrides, sourceEnv: "DATABASE_URL", inspectedSchema: "studio",
    project: { root: "/synthetic/vocabulary-wire", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const before = structuredClone(build.exploration_boundary);
  const output = describeBoundary(build.exploration_boundary, { resource: "studio.parcels" });
  expect(build.exploration_boundary).toEqual(before);
  expect(build.exploration_boundary.activation).toBe("disabled_unreviewed");
  const resources = output.resources as Array<Record<string, any>>;
  expect(resources).toHaveLength(1);
  expect(resources[0]!.relationships).toHaveLength(1);
  return { output, resource: resources[0]! };
}

describe("actual discovery presentation metadata wire contract", () => {
  it.each([false, true])("validates actual root and relationship discovery (labels=%s)", labelled => {
    const { output, resource } = discovery(labelled);
    expect(output).toMatchObject({ raw_sql_available: false, source_rows_available_before_activation: false });
    expect(resource.vocabulary).toMatchObject({ kind: "presentation_metadata", resource_has_reviewed_vocabulary: labelled });
    expect(resource.relationships[0].vocabulary.kind).toBe("presentation_metadata");
    expect(resource.vocabulary.fields_without_reviewed_vocabulary).not.toContain("internal_note");
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE DISPLAY|PRIVATE DESCRIPTION/);
    expect(resource.fields.every((field: Record<string, unknown>) => ["reviewed_metadata", "unspecified"].includes(field.vocabulary_status as string))).toBe(true);
    const result = scopedExploreDescribeOutputSchema.safeParse(output);
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(true);
    expect(scopedExploreDescribeToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it("keeps strict presentation field bounds and rejects unknown properties on producer output", () => {
    const { output } = discovery(true);
    expect(scopedExploreDescribeOutputSchema.safeParse(output).success).toBe(true);
    const mutate = (change: (value: Record<string, any>) => void) => {
      const value = structuredClone(output); change(value);
      expect(scopedExploreDescribeOutputSchema.safeParse(value).success).toBe(false);
    };
    for (const count of ["model_facing_fields", "fields_with_labels", "fields_with_descriptions", "fields_with_reviewed_vocabulary"]) {
      for (const invalid of [-1, 0.5, "1"]) mutate(value => { value.resources[0].vocabulary[count] = invalid; });
    }
    mutate(value => { value.resources[0].vocabulary.kind = "ready"; });
    mutate(value => { value.resources[0].vocabulary.extra = true; });
    mutate(value => { value.resources[0].vocabulary.resource_has_reviewed_vocabulary = "true"; });
    mutate(value => { value.resources[0].vocabulary.fields_without_reviewed_vocabulary = [1]; });
    mutate(value => { value.resources[0].relationships[0].vocabulary.extra = true; });
    mutate(value => { value.resources[0].fields[0].vocabulary_status = "meaning_ready"; });
    mutate(value => { value.resources[0].fields[0].extra = true; });
    mutate(value => { value.resources[0].fields[0].label = "x".repeat(65); });
    mutate(value => { value.resources[0].fields[0].description = "x".repeat(281); });
    mutate(value => { value.vocabulary_policy.metadata_grants_authority = true; });
    mutate(value => { value.vocabulary_policy.extra = true; });
  });
});
