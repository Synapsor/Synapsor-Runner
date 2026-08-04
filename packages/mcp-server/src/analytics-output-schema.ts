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
const modelWithheldTokenSchema = z.string().regex(/^\[withheld:[a-f0-9]{12}:[1-9][0-9]*\]$/);
const modelEgressResultSchema = z.object({
  values_withheld: z.literal(true),
  tokenized_columns: z.array(z.string()),
  token_scope: z.literal("this_tool_response_only"),
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
        bucket: z.enum(["day", "week", "month"]),
        relationship: z.string().nullable(),
        output_alias: z.string(),
      }).strict().nullable(),
    }).strict(),
    z.object({
      kind: z.literal("period_comparison"),
      reviewed_time_field: z.string(),
      reviewed_time_bucket: z.enum(["day", "week", "month"]).nullable(),
      periods: z.array(z.object({
        id: z.enum(["period_1", "period_2"]),
        start_inclusive: z.string().datetime(),
        end_exclusive: z.string().datetime(),
      }).strict()).length(2),
    }).strict(),
  ]),
  measures: z.array(z.object({
    alias: z.string(),
    function: z.enum(["count", "count_distinct", "sum", "avg"]),
    field: z.string().nullable(),
    relationship: z.string().nullable(),
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
    minimum_cohort_overridden: z.literal(true).optional(),
    outcome: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    suppressed_groups: z.number().int().nonnegative(),
    incomplete_comparison_groups: z.number().int().nonnegative(),
    suppression_aware_totals_returned: z.literal(false),
  }).strict(),
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
  resources: z.array(z.object({
    boundary_name: z.string().optional(),
    id: z.string(),
    label: z.string(),
    primary_key: z.string(),
    field_labels: z.record(z.string()),
    field_egress: fieldEgressSchema,
    selectable_fields: z.array(z.string()),
    filterable_fields: z.array(z.string()),
    filter_operators: z.record(z.array(z.string())),
    sortable_fields: z.array(z.string()),
    groupable_fields: z.array(z.string()),
    aggregate_measures: z.array(z.string()),
    count_distinct_fields: z.array(z.string()),
    time_bucket_fields: z.record(z.array(z.string())),
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
      label: z.string(),
      activation: z.enum(["active", "review_required"]),
      operator_review_required: z.boolean(),
      target_resource: z.string(),
      cardinality: z.literal("many_to_one"),
      counted_entity: z.string(),
      path_depth: z.number().int().positive(),
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
      field_labels: z.record(z.string()),
      field_egress: fieldEgressSchema,
      filterable_fields: z.array(z.string()),
      filter_operators: z.record(z.array(z.string())),
      groupable_fields: z.array(z.string()),
      aggregate_measures: z.array(z.string()),
      count_distinct_fields: z.array(z.string()),
      time_bucket_fields: z.record(z.array(z.string())),
      field_types: z.record(z.string()),
    }).strict()),
    minimum_cohort_size: z.number().int().positive(),
    minimum_cohort_overridden: z.literal(true).optional(),
    maximum_rows: z.number().int().positive(),
    maximum_groups: z.number().int().positive(),
    suggested_questions: z.array(z.object({
      text: z.string(),
      measure: z.object({
        function: z.enum(["count", "count_distinct", "sum", "avg"]),
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
      time_bucket: z.enum(["day", "week", "month"]).optional(),
      relationship_review_required: z.boolean().optional(),
    }).strict()),
  }).strict()).optional(),
  next_cursor: z.number().int().nonnegative().nullable().optional(),
  raw_sql_available: z.literal(false).optional(),
  source_rows_available_before_activation: z.literal(false).optional(),
}).strict();

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
    minimum_cohort_overridden: z.literal(true).optional(),
    suppressed_groups: z.number().int().nonnegative(),
    totals_returned: z.literal(false),
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

// MCP clients need the stable result shape during tools/list, but publishing
// every nested evidence field duplicates metadata that is already present in
// the top-level response and makes discovery unnecessarily large. Runtime and
// test validation continue to use scopedExploreQueryOutputSchema above.
const scopedExploreClientResultSchema = z.object({
  status: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
  counted_entity: safeRecordSchema,
  grain: safeRecordSchema,
  measures: z.array(safeRecordSchema),
  dimensions: z.array(safeRecordSchema),
  filters: z.array(safeRecordSchema),
  relationship_paths: z.array(safeRecordSchema),
  reporting_timezone: safeRecordSchema,
  freshness: safeRecordSchema,
  suppression: safeRecordSchema,
  returned: safeRecordSchema,
  remaining_budgets: safeRecordSchema,
  query_audit_handle: sha256Schema,
  source_database_changed: z.literal(false),
}).strict();

const scopedExploreClientOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    status: z.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    result: scopedExploreClientResultSchema,
  }).strict(),
  z.object({
    type: z.literal("refusal"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: safeRecordSchema.optional(),
  }).strict(),
]);

export const scopedExploreQueryToolOutputSchema = scopedExploreQueryOutputSchema.extend({
  outcome: scopedExploreClientOutcomeSchema,
}).strict();

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
