import type {
  ProtectedReadAggregateSpec,
} from "@synapsor/spec";
import {
  z,
  type ZodTypeAny,
} from "zod";
import {
  zodToJsonSchema,
} from "zod-to-json-schema";
import type {
  ResultFormat,
  RuntimeCapabilityConfig,
} from "./runtime-types.js";

export type JsonSchemaObject = Record<string, unknown>;

const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const runnerModeSchema = z.enum(["read_only", "shadow", "review", "cloud"]);
const safeRecordSchema = z.record(z.unknown());
const fieldEgressSchema = z.record(z.object({
  model_egress: z.enum(["visible", "withheld"]),
}).strict());
const reviewedFieldMetadataSchema = z.object({
  id: z.string(),
  label: z.string().max(64).optional(),
  description: z.string().max(280).optional(),
  plan_reference: z.literal("exact_id_only").optional(),
  semantic_status: z.enum([
    "reviewed_vocabulary",
    "descriptive_identifier",
    "coded_values",
    "opaque_identifier",
  ]).optional(),
  operations: z.object({
    return_value: z.boolean(),
    model_egress: z.enum(["visible", "withheld"]),
    filter_operators: z.array(z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"])),
    sortable: z.boolean(),
    groupable: z.boolean(),
    aggregate_functions: z.array(z.enum([
      "sum",
      "avg",
      "stddev_samp",
      "stddev_pop",
      "var_samp",
      "var_pop",
    ])),
    presence_functions: z.array(z.enum(["null_count", "non_null_count", "completion_rate"])),
    count_distinct: z.boolean(),
    time_buckets: z.array(z.enum([
      "hour",
      "day",
      "week",
      "month",
      "quarter",
      "year",
      "day_of_week",
    ])),
  }).strict().optional(),
  allowed_values: z.array(jsonScalarSchema).optional(),
}).strict();
const reviewedClientFieldMetadataSchema = z.object({
  id: z.string(),
  label: z.string().max(64).optional(),
  description: z.string().max(280).optional(),
}).passthrough();
const exploreVocabularyCoverageSchema = z.object({
  status: z.enum(["ready", "review_advised", "review_required"]),
  model_facing_fields: z.number().int().nonnegative(),
  fields_with_labels: z.number().int().nonnegative(),
  fields_with_descriptions: z.number().int().nonnegative(),
  fields_with_reviewed_vocabulary: z.number().int().nonnegative(),
  opaque_resource_without_vocabulary: z.boolean(),
  opaque_fields_without_vocabulary: z.array(z.string()),
  coded_fields_without_vocabulary: z.array(z.string()),
}).strict();
const modelWithheldTokenSchema = z.string().regex(/^\[withheld:[a-f0-9]{12}:[1-9][0-9]*\]$/);
const modelEgressResultSchema = z.object({
  values_withheld: z.literal(true),
  tokenized_columns: z.array(z.string()),
  token_scope: z.literal("this_tool_response_only"),
}).strict();

const scopedExploreMeasureFunctionSchema = z.enum([
  "count",
  "count_distinct",
  "sum",
  "avg",
  "stddev_samp",
  "stddev_pop",
  "var_samp",
  "var_pop",
  "null_count",
  "non_null_count",
  "completion_rate",
  "reviewed_derived",
]);
const sequentialDerivedGrain =
  "one reviewed ordered time_bucket; dimensions are optional partitions" as const;
const groupedDerivedGrain =
  "one or more reviewed dimensions and no time_bucket" as const;
const scopedDerivedMeasureSchema = z.object({
  name: z.string(),
  label: z.string(),
  shape: z.enum([
    "ratio",
    "percentage",
    "per_unit_average",
    "child_count_total",
    "child_count_average",
    "running_total",
    "lag_absolute_change",
    "lag_percentage_change",
    "moving_average",
    "rank",
    "share_of_released_total",
  ]),
  effective_minimum_cohort_size: z.number().int().min(5),
  calculation_stage: z.enum([
    "after cohort validation",
    "scoped child count aggregated over reviewed parent cohorts",
    "after small-group suppression",
  ]),
  null_behavior: z.literal("null when the reviewed denominator is zero or null").optional(),
  child_resource: z.string().optional(),
  relationship: z.string().optional(),
  parent_contributor_floor: z.literal("applied before release").optional(),
  raw_child_rows_returned: z.literal(false).optional(),
  required_grain: z.enum([sequentialDerivedGrain, groupedDerivedGrain]).optional(),
  records_without_reviewed_time: z.literal("omitted").optional(),
  suppressed_groups_included: z.literal(false).optional(),
  fixed_window_size: z.number().int().min(2).max(12).optional(),
  fixed_direction: z.enum(["asc", "desc"]).optional(),
}).strict().superRefine((value, context) => {
  const requireValue = (field: keyof typeof value, expected: unknown): void => {
    if (value[field] !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${String(field)} must match the reviewed derived-measure shape`,
      });
    }
  };
  if (["ratio", "percentage", "per_unit_average"].includes(value.shape)) {
    requireValue("calculation_stage", "after cohort validation");
    requireValue("null_behavior", "null when the reviewed denominator is zero or null");
    return;
  }
  if (value.shape === "child_count_total" || value.shape === "child_count_average") {
    requireValue("calculation_stage", "scoped child count aggregated over reviewed parent cohorts");
    if (!value.child_resource) requireValue("child_resource", "required");
    if (!value.relationship) requireValue("relationship", "required");
    requireValue("parent_contributor_floor", "applied before release");
    requireValue("raw_child_rows_returned", false);
    return;
  }
  requireValue("calculation_stage", "after small-group suppression");
  requireValue("suppressed_groups_included", false);
  if (["running_total", "lag_absolute_change", "lag_percentage_change", "moving_average"].includes(value.shape)) {
    requireValue("required_grain", sequentialDerivedGrain);
    requireValue("records_without_reviewed_time", "omitted");
    if (value.shape === "moving_average" && value.fixed_window_size === undefined) {
      requireValue("fixed_window_size", "required");
    }
    return;
  }
  requireValue("required_grain", groupedDerivedGrain);
  if (value.shape === "rank" && value.fixed_direction === undefined) {
    requireValue("fixed_direction", "required");
  }
});
const scopedNumericBandSchema = z.object({
  name: z.string(),
  label: z.string(),
  field: z.string(),
  relationship: z.string().nullable(),
  edges: z.array(z.number().finite()).min(1).max(16),
  bucket_labels: z.array(z.string()).min(2).max(17),
}).strict();
const scopedAutoBandSchema = z.object({
  field: z.string(),
  methods: z.array(z.enum(["quantile", "equal_width"])).min(1).max(2),
  min_buckets: z.number().int().min(2).max(16),
  max_buckets: z.number().int().min(2).max(16),
  min_bucket_width: z.number().positive().nullable().optional(),
  label_style: z.enum(["ordinal", "rounded"]),
  label_round_to: z.number().positive().nullable().optional(),
  model_selects: z.array(z.enum(["field", "method", "buckets"])).optional(),
  raw_edges_returned: z.literal(false),
}).strict();
const scopedAutoBandResultSchema = z.object({
  field: z.string(),
  method: z.enum(["quantile", "equal_width"]),
  requested_buckets: z.number().int().min(2).max(16),
  effective_buckets: z.number().int().nonnegative().max(16),
  reduced: z.boolean(),
  label_style: z.enum(["ordinal", "rounded"]),
  raw_edges_returned: z.literal(false),
}).strict();
const scopedExploreTimeBucketSchema = z.enum([
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "day_of_week",
]);

const reviewedValueControlsSchema = z.object({
  bucketed_fields: z.array(z.object({
    resource: z.string(),
    field: z.string(),
    output_field: z.string(),
    bucket_returned: z.boolean(),
    bucket_token: z.string()
      .regex(/^\[outside-reviewed-values(?:-[1-9][0-9]*)?\]$/)
      .optional(),
  }).strict()),
  excluded_fields: z.array(z.object({
    resource: z.string(),
    field: z.string(),
    effect: z.literal("rows_outside_reviewed_values_excluded"),
  }).strict()),
  source_values_exposed: z.literal(false),
}).strict();

const runtimeErrorFields = {
  ok: z.literal(false),
  code: z.string().min(1),
  error: z.string().min(1),
  retry_after_ms: z.number().int().positive().optional(),
};

const resultEnvelopeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().positive().optional(),
}).strict();

const evidenceHandleSchema = z.object({
  bundle_id: z.string().min(1),
  note: z.string(),
}).strict();

const resultEnvelopeMetaSchema = z.object({
  tenant_id: z.string().optional(),
  principal: z.string().optional(),
  provenance: z.string().optional(),
  canonical_capability: z.string().min(1),
  reporting_timezone: z.literal("UTC").optional(),
}).strict();

const protectedQueryAuditSchema = z.object({
  query_fingerprint: sha256Schema,
  result_values_persisted: z.literal(false),
  trusted_values_persisted: z.literal(false),
  returned_rows_or_groups: z.number().int().nonnegative(),
  returned_cells: z.number().int().nonnegative(),
}).strict();

const protectedTrustedContextSchema = z.object({
  tenant_bound: z.boolean(),
  organization_bound: z.boolean().optional(),
  principal_bound: z.boolean(),
  provenance: z.string(),
}).strict();

const legacyTrustedContextSchema = z.object({
  tenant_id: z.string(),
  principal: z.string(),
  provenance: z.string(),
}).strict();

const scopedExploreResultSchema = z.object({
  status: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
  counted_entity: z.object({
    resource: z.string(),
    primary_key: z.string(),
    semantics: z.string(),
  }).strict(),
  grain: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("rows"),
      selected_fields: z.array(z.string()),
      maximum_rows: z.number().int().positive(),
    }).strict(),
    z.object({
      kind: z.literal("aggregate_groups"),
      time_bucket: z.object({
        field: z.string(),
        bucket: scopedExploreTimeBucketSchema,
        relationship: z.string().nullable(),
        output_alias: z.string(),
      }).strict().nullable(),
    }).strict(),
    z.object({
      kind: z.literal("period_comparison"),
      reviewed_time_field: z.string(),
      reviewed_time_bucket: scopedExploreTimeBucketSchema.nullable(),
      periods: z.array(z.object({
        id: z.enum(["period_1", "period_2"]),
        start_inclusive: z.string().datetime(),
        end_exclusive: z.string().datetime(),
      }).strict()).length(2),
    }).strict(),
  ]),
  measures: z.array(z.object({
    alias: z.string(),
    function: scopedExploreMeasureFunctionSchema,
    field: z.string().nullable(),
    relationship: z.string().nullable(),
    derived_measure: z.string().optional(),
    contributor_cohort: z.enum([
      "non-null values for this reviewed field",
      "reviewed root rows",
    ]),
    comparison_outputs: z.object({
      period_1: z.string(),
      period_2: z.string(),
      absolute_change: z.string(),
      percentage_change: z.string(),
      percentage_change_denominator: z.literal("absolute period_1 value"),
      percentage_change_when_period_1_is_zero: z.null(),
    }).strict().optional(),
  }).strict()),
  dimensions: z.array(z.object({
    alias: z.string(),
    field: z.string(),
    relationship: z.string().nullable(),
    numeric_band: z.string().optional(),
    auto_band: z.object({
      method: z.enum(["quantile", "equal_width"]),
      requested_buckets: z.number().int().min(2).max(16),
      reviewed_bucket_range: z.tuple([
        z.number().int().min(2).max(16),
        z.number().int().min(2).max(16),
      ]),
      label_style: z.enum(["ordinal", "rounded"]),
      raw_edges_returned: z.literal(false),
    }).strict().optional(),
    null_label: z.literal("Not set (database null)"),
  }).strict()),
  filters: z.array(z.object({
    field: z.string(),
    operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
    relationship: z.string().nullable(),
    value_type: z.enum(["list", "null", "string", "number", "boolean"]),
    value_count: z.number().int().positive(),
    value_returned_in_metadata: z.literal(false),
  }).strict()),
  adaptive_numeric_bands: z.array(scopedAutoBandResultSchema).optional(),
  relationship_paths: z.array(z.object({
    id: z.string(),
    target_resource: z.string(),
    cardinality: z.literal("many_to_one"),
    path_depth: z.number().int().positive(),
    unmatched_rows: z.enum(["exclude", "keep_null"]),
  }).strict()),
  reporting_timezone: z.object({
    name: z.string(),
    authority_bound: z.boolean(),
    legacy_boundary_without_timezone_binding: z.boolean(),
  }).strict(),
  freshness: z.object({
    execution_started_at: z.string().datetime(),
    observed_at: z.string().datetime(),
    snapshot_consistency: z.literal("single_read_only_transaction"),
    upstream_source_freshness: z.literal("not_asserted"),
  }).strict(),
  suppression: z.object({
    minimum_cohort_size: z.number().int().positive().nullable(),
    effective_minimum_cohort_size: z.number().int().positive().nullable(),
    contributor_aware: z.boolean(),
    minimum_cohort_overridden: z.literal(true).optional(),
    outcome: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    suppressed_groups: z.number().int().nonnegative(),
    incomplete_comparison_groups: z.number().int().nonnegative(),
    suppression_aware_totals_returned: z.literal(false),
  }).strict(),
  reviewed_value_controls: reviewedValueControlsSchema.optional(),
  returned: z.object({
    rows_or_groups: z.number().int().nonnegative(),
    cells: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }).strict(),
  remaining_budgets: z.object({
    queries: z.number().int().nonnegative(),
    rate_window_requests: z.number().int().nonnegative(),
    extracted_cells: z.number().int().nonnegative(),
    differencing_queries: z.number().int().nonnegative().nullable(),
    differencing_variants_for_root_resource: z.object({
      resource: z.string().min(1),
      used: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      remaining: z.number().int().nonnegative(),
      window: z.literal("rolling_24_hours"),
      persists_across_sessions: z.literal(true),
    }).strict().nullable(),
  }).strict(),
  query_audit_handle: sha256Schema,
  source_database_changed: z.literal(false),
}).strict();

const scopedDescribeOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }).strict(),
  z.object({
    type: z.literal("refusal"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: safeRecordSchema.optional(),
  }).strict(),
]);

const scopedExploreOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    status: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    result: scopedExploreResultSchema,
  }).strict(),
  z.object({
    type: z.literal("refusal"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: safeRecordSchema.optional(),
  }).strict(),
]);

export const scopedExploreDescribeOutputSchema = z.object({
  ok: z.boolean(),
  outcome: scopedDescribeOutcomeSchema,
  error_code: z.string().optional(),
  message: z.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z.literal(false).optional(),
  boundary_digest: sha256Schema.optional(),
  active_boundary_set_digest: sha256Schema.optional(),
  boundary_name: z.string().optional(),
  organization_scope: z.object({
    mode: z.literal("single_organization"),
    tenant_filter: z.literal("not_applicable"),
    organization_identity: z.literal("fixed_outside_model_arguments"),
  }).strict().optional(),
  boundaries: z.array(z.object({
    name: z.string(),
    digest: sha256Schema,
    table_count: z.number().int().positive(),
    resources: z.array(z.string()),
  }).strict()).optional(),
  pack: z.string().optional(),
  reporting_timezone: z.object({
    name: z.string(),
    authority_bound: z.boolean(),
  }).strict().optional(),
  relative_time_windows: z.object({
    available: z.boolean(),
    reporting_timezone: z.literal("UTC").nullable(),
    windows: z.array(z.enum([
      "today",
      "yesterday",
      "last_7_days",
      "last_30_days",
      "last_90_days",
      "this_week",
      "previous_week",
      "this_month",
      "previous_month",
      "this_quarter",
      "previous_quarter",
      "this_year",
      "day_to_date",
      "week_to_date",
      "month_to_date",
      "quarter_to_date",
      "year_to_date",
    ])),
    comparison_partners: z.array(z.enum([
      "preceding_period",
      "same_period_last_year",
    ])),
    range_semantics: z.literal("half-open [start, end)"),
    week_starts_on: z.literal("Monday"),
    model_supplied_date_arithmetic: z.literal(false),
  }).strict().optional(),
  vocabulary_policy: z.object({
    reviewed_metadata_is_semantic_only: z.literal(true),
    exact_ids_required_in_plans: z.literal(true),
    opaque_identifier_behavior: z.literal(
      "do_not_guess; ask the operator to add a reviewed label or description",
    ),
    coded_value_behavior: z.literal(
      "do_not_infer_business_meaning_from_codes; use exact codes only when the question names them or reviewed metadata explains them",
    ),
  }).strict().optional(),
  resources: z.array(z.object({
    boundary_name: z.string().optional(),
    id: z.string(),
    label: z.string().max(64).optional(),
    description: z.string().max(280).optional(),
    vocabulary: exploreVocabularyCoverageSchema.optional(),
    primary_key: z.string(),
    fields: z.array(reviewedFieldMetadataSchema),
    field_egress: fieldEgressSchema,
    selectable_fields: z.array(z.string()),
    filterable_fields: z.array(z.string()),
    filter_operators: z.record(z.array(z.string())),
    sortable_fields: z.array(z.string()),
    groupable_fields: z.array(z.string()),
    aggregate_measures: z.array(z.string()),
    aggregate_measure_functions: z.record(z.array(scopedExploreMeasureFunctionSchema)),
    presence_measure_fields: z.array(z.string()),
    presence_measure_functions: z.array(scopedExploreMeasureFunctionSchema),
    derived_measures: z.array(scopedDerivedMeasureSchema),
    numeric_bands: z.array(scopedNumericBandSchema),
    auto_bands: z.array(scopedAutoBandSchema).optional(),
    count_distinct_fields: z.array(z.string()),
    time_bucket_fields: z.record(z.array(z.string())),
    relative_time_window_fields: z.array(z.string()).optional(),
    time_coverage: z.record(z.object({
      status: z.enum(["available", "empty", "withheld_below_minimum_cohort", "unavailable"]),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      reporting_timezone: z.enum(["UTC", "database_session"]).optional(),
    }).strict()),
    field_types: z.record(z.string()),
    field_enums: z.record(z.array(jsonScalarSchema)),
    kept_out_field_count: z.number().int().nonnegative(),
    relationships: z.array(z.object({
      id: z.string(),
      activation: z.enum(["active", "review_required"]),
      operator_review_required: z.boolean(),
      target_resource: z.string(),
      target_label: z.string().max(64).optional(),
      target_description: z.string().max(280).optional(),
      vocabulary: exploreVocabularyCoverageSchema.optional(),
      cardinality: z.literal("many_to_one"),
      counted_entity: z.string(),
      path_depth: z.number().int().positive(),
      path: z.object({
        resources: z.array(z.string()).min(2),
        via_columns: z.array(z.array(z.string()).min(1)).min(1),
      }).strict(),
      nullable: z.boolean(),
      unmatched_rows: z.enum(["exclude", "keep_null"]),
      structural_evidence: z.array(z.object({
        constraint_name: z.string(),
        source_resource: z.string(),
        target_resource: z.string(),
        source_columns: z.array(z.string()),
        target_columns: z.array(z.string()),
        target_uniqueness: z.object({
          kind: z.string(),
          name: z.string(),
          columns: z.array(z.string()),
        }).passthrough(),
        nullable: z.boolean(),
        cardinality: z.literal("many_to_one"),
      }).strict()),
      field_egress: fieldEgressSchema,
      fields: z.array(reviewedFieldMetadataSchema),
      filterable_fields: z.array(z.string()),
      filter_operators: z.record(z.array(z.string())),
      groupable_fields: z.array(z.string()),
      aggregate_measures: z.array(z.string()),
      aggregate_measure_functions: z.record(z.array(scopedExploreMeasureFunctionSchema)),
      presence_measure_fields: z.array(z.string()),
      presence_measure_functions: z.array(scopedExploreMeasureFunctionSchema),
      derived_measures: z.array(scopedDerivedMeasureSchema),
      count_distinct_fields: z.array(z.string()),
      time_bucket_fields: z.record(z.array(z.string())),
      relative_time_window_fields: z.array(z.string()).optional(),
      field_types: z.record(z.string()),
      field_enums: z.record(z.array(jsonScalarSchema)).optional(),
    }).strict()),
    minimum_cohort_size: z.number().int().positive(),
    minimum_cohort_overridden: z.literal(true).optional(),
    maximum_rows: z.number().int().positive(),
    maximum_groups: z.number().int().positive(),
    suggested_questions: z.array(z.object({
      text: z.string(),
      measure: z.object({
        function: scopedExploreMeasureFunctionSchema,
        field: z.string().optional(),
        relationship: z.string().optional(),
      }).strict(),
      dimension: z.union([
        z.string(),
        z.object({
          field: z.string(),
          relationship: z.string().optional(),
        }).strict(),
      ]).optional(),
      time_field: z.string().optional(),
      time_bucket: scopedExploreTimeBucketSchema.optional(),
      relationship_review_required: z.boolean().optional(),
    }).strict()),
  }).strict()).optional(),
  next_cursor: z.number().int().nonnegative().nullable().optional(),
  raw_sql_available: z.literal(false).optional(),
  source_rows_available_before_activation: z.literal(false).optional(),
}).strict();

// MCP discovery should describe the stable envelope, not repeat the complete
// analytics grammar. The canonical schema above remains the detailed contract;
// app.describe_data returns the reviewed per-resource grammar on demand.
const scopedExploreClientDescribeOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }).strict(),
  z.object({
    type: z.literal("refusal"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: safeRecordSchema.optional(),
  }).strict(),
]);

const scopedExploreClientDescribeResourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(64).optional(),
  description: z.string().max(280).optional(),
  fields: z.array(reviewedClientFieldMetadataSchema).optional(),
}).passthrough();

export const scopedExploreDescribeToolOutputSchema = z.object({
  ok: z.boolean(),
  outcome: scopedExploreClientDescribeOutcomeSchema.optional(),
  error_code: z.string().optional(),
  message: z.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z.literal(false).optional(),
  resources: z.array(scopedExploreClientDescribeResourceSchema).optional(),
  next_cursor: z.number().int().nonnegative().nullable().optional(),
  catalog_view: z.enum(["resource_index", "resource_detail"]).optional(),
  metadata_only: z.literal(true).optional(),
  contains_source_values: z.literal(false).optional(),
  next_action: z.string().optional(),
}).passthrough();

export const scopedExploreQueryOutputSchema = z.object({
  ok: z.boolean(),
  outcome: scopedExploreOutcomeSchema,
  error_code: z.string().optional(),
  message: z.string().optional(),
  details: safeRecordSchema.optional(),
  kind: z.enum(["rows", "aggregate"]).optional(),
  counted_entity: z.object({
    resource: z.string(),
    primary_key: z.string(),
    semantics: z.string(),
  }).strict().optional(),
  boundary_digest: sha256Schema.optional(),
  active_boundary_set_digest: sha256Schema.optional(),
  boundary_name: z.string().optional(),
  source_database_changed: z.literal(false),
  untrusted_data: z.literal(true).optional(),
  untrusted_data_notice: z.string().optional(),
  data: z.array(z.record(jsonScalarSchema)).optional(),
  model_egress: z.object({
    values_withheld: z.literal(true),
    tokenized_columns: z.array(z.string()),
    token_scope: z.literal("this_tool_response_only"),
  }).strict().optional(),
  privacy: z.object({
    minimum_cohort_size: z.number().int().positive().nullable(),
    effective_minimum_cohort_size: z.number().int().positive().nullable(),
    contributor_aware_measures: z.array(z.number().int().nonnegative()),
    minimum_cohort_overridden: z.literal(true).optional(),
    suppressed_groups: z.number().int().nonnegative(),
    totals_returned: z.literal(false),
    auto_bands: z.array(scopedAutoBandResultSchema).optional(),
    reviewed_value_controls: reviewedValueControlsSchema.optional(),
  }).strict().optional(),
  audit: z.object({
    query_fingerprint: sha256Schema,
    evidence_bundle_id: z.string().min(1),
    returned_rows_or_groups: z.number().int().nonnegative(),
    returned_cells: z.number().int().nonnegative(),
    persisted_result_values: z.literal(false),
  }).strict().optional(),
  evidence_bundle_id: z.string().min(1).optional(),
  evidence_resource: z.string().min(1).optional(),
  protect: z.object({
    token: z.string().min(1),
    expires_at: z.string().datetime(),
    action: z.string(),
  }).strict().optional(),
}).strict();

const scopedExploreClientResultEnvelopeSchema = z.object({
  query_audit_handle: sha256Schema.optional(),
}).passthrough();

const scopedExploreClientPrivacyEnvelopeSchema = z.object({
  reviewed_value_controls: reviewedValueControlsSchema.optional(),
}).passthrough();

const scopedExploreClientOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    status: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    result: scopedExploreClientResultEnvelopeSchema,
  }).strict(),
  z.object({
    type: z.literal("refusal"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: safeRecordSchema.optional(),
  }).strict(),
]);

export const scopedExploreQueryToolOutputSchema = z.object({
  ok: z.boolean(),
  outcome: scopedExploreClientOutcomeSchema,
  error_code: z.string().optional(),
  message: z.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z.literal(false),
  data: z.array(z.record(jsonScalarSchema)).optional(),
  privacy: scopedExploreClientPrivacyEnvelopeSchema.optional(),
  audit: safeRecordSchema.optional(),
}).passthrough();

export function analyticalToolOutputSchema(
  capability: RuntimeCapabilityConfig,
  resultFormat: ResultFormat,
): z.ZodObject<Record<string, ZodTypeAny>> | undefined {
  const dataSchema = analyticalDataSchema(capability);
  if (!dataSchema) return undefined;
  if (resultFormat === 2) {
    return z.object({
      ok: z.boolean(),
      summary: z.string(),
      action: z.literal(capability.name),
      kind: z.literal(capability.kind),
      data: dataSchema.nullable(),
      proposal: z.null(),
      error: resultEnvelopeErrorSchema.nullable(),
      evidence: evidenceHandleSchema.nullable(),
      source_database_changed: z.literal(false),
      _meta: resultEnvelopeMetaSchema,
      model_egress: modelEgressResultSchema.optional(),
    }).strict();
  }
  const successFields: Record<string, ZodTypeAny> = {
    status: capability.aggregate && !capability.protected_read
      ? z.enum(["ok", "suppressed"]).optional()
      : z.literal("ok").optional(),
    action: z.literal(capability.name).optional(),
    mode: runnerModeSchema.optional(),
    business_object: z.object({
      type: z.string(),
      id: z.string(),
    }).strict().optional(),
    data: dataSchema.optional(),
    trusted_context: (capability.protected_read
      ? protectedTrustedContextSchema
      : legacyTrustedContextSchema).optional(),
    evidence_bundle_id: z.string().optional(),
    evidence_resource: z.string().optional(),
    query_audit: protectedQueryAuditSchema.optional(),
    reporting_timezone: z.literal("UTC").optional(),
    source_database_changed: z.literal(false).optional(),
    source_database_mutated: z.literal(false).optional(),
    model_egress: modelEgressResultSchema.optional(),
  };
  return z.object({
    ...runtimeErrorFields,
    ok: z.literal(false).optional(),
    code: z.string().optional(),
    error: z.string().optional(),
    retry_after_ms: z.number().int().positive().optional(),
    ...successFields,
  }).strict();
}

export function schemaAsJsonSchema(schema: ZodTypeAny): JsonSchemaObject {
  return zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as JsonSchemaObject;
}

function analyticalDataSchema(capability: RuntimeCapabilityConfig): ZodTypeAny | undefined {
  if (capability.protected_read?.mode === "rows") {
    return z.object({
      rows: z.array(visibleRowSchema(capability)),
    }).strict();
  }
  if (capability.protected_read?.mode === "aggregate") {
    const aggregate = capability.protected_read.aggregate;
    if (!aggregate) return undefined;
    return protectedAggregateDataSchema(capability, aggregate);
  }
  if (capability.kind === "aggregate_read" && capability.aggregate) {
    return z.object({
      function: z.literal(capability.aggregate.function),
      column: z.string().nullable(),
      suppressed: z.boolean(),
      minimum_group_size: z.number().int().positive(),
      value: z.number().finite().nullable(),
      member_rows_included: z.literal(false),
    }).strict();
  }
  return undefined;
}

function visibleRowSchema(capability: RuntimeCapabilityConfig): z.ZodObject<Record<string, ZodTypeAny>> {
  const withheld = new Set(capability.model_withheld_fields ?? []);
  return z.object(Object.fromEntries(
    capability.visible_columns.map((field) => [
      field,
      withheld.has(field)
        ? z.union([jsonScalarSchema, modelWithheldTokenSchema])
          .describe("no_model_egress: true; full values are available only through the local human presentation channel")
        : jsonScalarSchema,
    ]),
  )).strict();
}

function protectedAggregateDataSchema(
  capability: RuntimeCapabilityConfig,
  aggregate: ProtectedReadAggregateSpec,
): ZodTypeAny {
  const withheld = new Set(capability.model_withheld_fields ?? []);
  const output = (field: string, schema: ZodTypeAny): ZodTypeAny =>
    withheld.has(field)
      ? z.union([schema, modelWithheldTokenSchema])
        .describe("no_model_egress: true; full values are available only through the local human presentation channel")
      : schema;
  const groupShape: Record<string, ZodTypeAny> = {};
  const periodMover = aggregate.order_by?.kind === "comparison_change";
  for (const dimension of aggregate.dimensions ?? []) {
    groupShape[dimension.name] = output(dimension.name, jsonScalarSchema);
  }
  if (aggregate.time_bucket && !periodMover) {
    groupShape[aggregate.time_bucket.name] = output(aggregate.time_bucket.name, jsonScalarSchema);
  }
  for (const measure of aggregate.measures) {
    if (periodMover) {
      groupShape[`${measure.name}_period_1`] = z.number().finite();
      groupShape[`${measure.name}_period_2`] = z.number().finite();
      groupShape[`${measure.name}_absolute_change`] = z.number().finite();
      groupShape[`${measure.name}_percentage_change`] = z.number().finite().nullable();
    } else {
      groupShape[measure.name] = output(measure.name, z.number().finite());
    }
  }
  if (aggregate.comparison && !periodMover) groupShape.period = jsonScalarSchema;
  return z.object({
    groups: z.array(z.object(groupShape).strict()),
    suppression: z.object({
      minimum_cohort_size: z.number().int().positive(),
      suppressed_groups: z.number().int().nonnegative(),
      totals_returned: z.literal(false),
    }).strict(),
  }).strict();
}
