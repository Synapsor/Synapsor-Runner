/** Declared existing manual Action fixture shared by bounded B64 component tests.
 * Hoisted unchanged from authoring-action-parameter-review.test.ts. */
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { ExplorationBoundaryDraft } from "../auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "../action-rule-authoring.js";
import type { ManualActionValues } from "../manual-semantic-action-editor.js";
const lock = `sha256:${"a".repeat(64)}` as const;
export const readDigest = `sha256:${"b".repeat(64)}` as const;
export function values(): ManualActionValues {
  return {
    intent: "Set an eligible warehouse item's reorder threshold.",
    name: "warehouse.set_reorder_threshold",
    outcome: "warehouse.set_reorder_threshold",
    binding: "item",
    resource: "warehouse.items",
    field: "reorder_threshold",
    input_type: { kind: "integer" },
    input_name: "threshold",
    input_description: "Requested reorder threshold in units.",
    minimum: 1,
    maximum: 1000,
    eligibility_field: "reorder_enabled",
    eligibility_value: 1,
    eligibility_type: { kind: "integer" },
    approval_mode: "policy",
    required_role: "warehouse_reviewer",
    required_approvals: 1,
    auto_maximum: 100,
    overall_maximum: 10,
    overall_window_seconds: 86_400,
    customer_maximum: 3,
    customer_window_seconds: 86_400,
    review: {
      when: "The selected item has reorder settings enabled and the requested threshold is in range.",
      then: "Create a proposal to set that item's reorder threshold.",
      refused: ["The item is not eligible or the threshold is outside the reviewed range."],
      human_review: "A warehouse reviewer handles valid requests above the automatic threshold.",
      examples: [{ kind: "eligible", scenario: "Enabled item with a routine threshold", result: "Automatic approval if rolling limits remain." }],
    },
  };
}

export function catalog(): BuiltActionRuleAuthoringCatalogV1 {
  const integer = { kind: "integer" as const };
  const text = { kind: "string" as const, max_length: 64, comparison: "exact" as const };
  const fields = [
    { name: "item_id", type: text, nullable: false },
    { name: "tenant_id", type: text, nullable: false },
    { name: "principal_id", type: text, nullable: false },
    { name: "reorder_threshold", type: integer, nullable: false },
    { name: "reorder_enabled", type: integer, nullable: false },
    { name: "is_reorder_enabled", type: { kind: "boolean" as const }, nullable: false },
    { name: "reorder_state", type: { kind: "string" as const, max_length: 16, comparison: "exact" as const, enum: ["enabled", "paused"] }, nullable: false },
    { name: "version", type: integer, nullable: false },
  ];
  const actionCatalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "warehouse.items", source: "local_postgres", engine: "postgres", schema: "warehouse", table: "items",
      primary_key: "item_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", fields,
    }],
    relationships: [],
  };
  return {
    catalog: actionCatalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres", engine: "postgres", read_boundary_name: "warehouse_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "warehouse.items", primary_key: "item_id", tenant_scope: "direct", tenant_key: "tenant_id",
        principal_scope: "direct", principal_key: "principal_id", version_candidates: ["version"], selected_version_field: "version",
        operations: { update: true, insert: false },
        fields: fields.map((field) => ({
          ...field,
          role: ["item_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : ["reorder_enabled", "is_reorder_enabled", "reorder_state"].includes(field.name) ? "runner_verification_only" as const : "model_visible" as const,
          writable: field.name === "reorder_threshold",
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: ["count", "sum", "min", "max"],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

export function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "production",
    source: "local_postgres", compiler_version: "test", spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock, role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    unresolved_decisions: [],
    pack: { name: "warehouse_read", resources: [{
      id: "warehouse.items", schema: "warehouse", table: "items", primary_key: "item_id", tenant_key: "tenant_id", principal_key: "principal_id",
      field_types: {}, field_enums: {}, selectable_fields: ["reorder_threshold"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
      aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["reorder_enabled", "version"], relationships: [],
      minimum_cohort_size: 5, suppression_aware_totals: true,
    }] },
    budgets: { max_rows: 50, max_groups: 50, max_top_n: 25, max_measures: 3, max_dimensions: 3, max_time_ranges: 2,
      max_relationship_hops: 2, max_response_cells: 500, max_response_bytes: 65_536, statement_timeout_ms: 3_000,
      max_complexity: 24, max_queries_per_session: 1_000, max_extracted_cells_per_session: 4_000, max_differencing_queries: 16,
      rate_limit_per_minute: 120 },
  };
}
