import { describe, expect, it } from "vitest";
import {
  analyticalToolOutputSchema,
  schemaAsJsonSchema,
  scopedExploreDescribeOutputSchema,
  scopedExploreQueryOutputSchema,
  scopedExploreQueryToolOutputSchema,
} from "./analytics-output-schema.js";
import type {
  RuntimeCapabilityConfig,
} from "./runtime-types.js";

const digest = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const generationLock = `sha256:${"b".repeat(64)}` as `sha256:${string}`;

describe("analytical MCP output schemas", () => {
  it("advertises and validates both describe-data outcome variants", () => {
    const success = {
      ok: true,
      outcome: { type: "success" },
      boundary_digest: digest,
      pack: "reviewed_staging",
      organization_scope: {
        mode: "single_organization",
        tenant_filter: "not_applicable",
        organization_identity: "fixed_outside_model_arguments",
      },
      reporting_timezone: { name: "UTC", authority_bound: true },
      resources: [],
      next_cursor: null,
      raw_sql_available: false,
      source_rows_available_before_activation: false,
    };
    const refusal = {
      ok: false,
      outcome: {
        type: "refusal",
        code: "EXPLORE_DISABLED",
        message: "Scoped Explore is disabled.",
      },
      error_code: "EXPLORE_DISABLED",
      message: "Scoped Explore is disabled.",
      source_database_changed: false,
    };
    expect(scopedExploreDescribeOutputSchema.safeParse(success).success).toBe(true);
    expect(JSON.stringify(success)).not.toContain("internal-finance");
    expect(scopedExploreDescribeOutputSchema.safeParse(refusal).success).toBe(true);
    expect(scopedExploreDescribeOutputSchema.safeParse({
      ...refusal,
      outcome: { type: "success", code: "EXPLORE_DISABLED" },
    }).success).toBe(false);
    expect(JSON.stringify(schemaAsJsonSchema(scopedExploreDescribeOutputSchema))).toContain("\"const\":\"refusal\"");

    const canonicalResource = {
      id: "public.orders",
      primary_key: "id",
      field_egress: {
        id: { model_egress: "visible" },
        status: { model_egress: "visible" },
      },
      selectable_fields: ["id", "status"],
      filterable_fields: ["status"],
      filter_operators: { status: ["eq", "neq", "in"] },
      sortable_fields: [],
      groupable_fields: ["status"],
      aggregate_measures: [],
      aggregate_measure_functions: {},
      count_distinct_fields: ["id"],
      time_bucket_fields: {},
      time_coverage: {},
      field_types: { id: "text", status: "text" },
      field_enums: { status: ["open", "paid"] },
      kept_out_field_count: 0,
      relationships: [],
      minimum_cohort_size: 5,
      maximum_rows: 25,
      maximum_groups: 25,
      suggested_questions: [],
    };
    expect(scopedExploreDescribeOutputSchema.safeParse({
      ...success,
      resources: [canonicalResource],
    }).success).toBe(true);
    expect(scopedExploreDescribeOutputSchema.safeParse({
      ...success,
      resources: [{ ...canonicalResource, label: "Orders" }],
    }).success).toBe(false);
    expect(scopedExploreDescribeOutputSchema.safeParse({
      ...success,
      resources: [{ ...canonicalResource, plan_resource: "public.orders" }],
    }).success).toBe(false);
  });

  it("validates success, suppression, empty, comparison, and refusal variants from one schema", () => {
    for (const status of ["ok", "empty", "fully_suppressed", "incomplete_comparison"] as const) {
      const result = queryResult(status);
      expect(scopedExploreQueryOutputSchema.safeParse(result).success, status).toBe(true);
    }
    const refusal = {
      ok: false,
      outcome: {
        type: "refusal",
        code: "EXPLORE_FIELD_FORBIDDEN",
        message: "The requested field is outside the reviewed boundary.",
        details: { field: "not_reviewed" },
      },
      error_code: "EXPLORE_FIELD_FORBIDDEN",
      message: "The requested field is outside the reviewed boundary.",
      details: { field: "not_reviewed" },
      source_database_changed: false,
    };
    expect(scopedExploreQueryOutputSchema.safeParse(refusal).success).toBe(true);
    expect(scopedExploreQueryOutputSchema.safeParse({
      ...queryResult("ok"),
      outcome: { type: "success", status: "ok" },
    }).success).toBe(false);
    expect(scopedExploreQueryOutputSchema.safeParse({
      ...queryResult("ok"),
      source_database_changed: true,
    }).success).toBe(false);
    expect(scopedExploreQueryOutputSchema.safeParse({
      ...queryResult("ok"),
      data: [{ count: { unsafe: true } }],
    }).success).toBe(false);
    const jsonSchema = schemaAsJsonSchema(scopedExploreQueryOutputSchema);
    expect(JSON.stringify(jsonSchema)).toContain("\"const\":\"success\"");
    expect(JSON.stringify(jsonSchema)).toContain("\"const\":\"refusal\"");
  });

  it("publishes a compact Explore client schema without weakening full runtime validation", () => {
    const success = queryResult("ok");
    const refusal = {
      ok: false,
      outcome: {
        type: "refusal",
        code: "EXPLORE_FIELD_FORBIDDEN",
        message: "The requested field is outside the reviewed boundary.",
      },
      source_database_changed: false,
    };
    expect(scopedExploreQueryToolOutputSchema.safeParse(success).success).toBe(true);
    expect(scopedExploreQueryToolOutputSchema.safeParse(refusal).success).toBe(true);
    const fullBytes = Buffer.byteLength(JSON.stringify(schemaAsJsonSchema(scopedExploreQueryOutputSchema)));
    const clientBytes = Buffer.byteLength(JSON.stringify(schemaAsJsonSchema(scopedExploreQueryToolOutputSchema)));
    expect(clientBytes).toBeLessThan(fullBytes);
    expect(JSON.stringify(schemaAsJsonSchema(scopedExploreQueryToolOutputSchema)))
      .toContain("query_audit_handle");
  });

  it("accepts complete reviewed-value controls without allowing source values", () => {
    const success = queryResult("ok");
    const controls = {
      bucketed_fields: [{
        resource: "public.subscriptions",
        field: "plan",
        output_field: "plan",
        bucket_returned: true,
        bucket_token: "[outside-reviewed-values]",
      }],
      excluded_fields: [{
        resource: "public.subscriptions",
        field: "plan",
        effect: "rows_outside_reviewed_values_excluded",
      }],
      source_values_exposed: false,
    } as const;
    const outcome = success.outcome as Record<string, unknown>;
    const result = outcome.result as Record<string, unknown>;
    result.reviewed_value_controls = controls;
    const privacy = success.privacy as Record<string, unknown>;
    privacy.reviewed_value_controls = controls;

    expect(scopedExploreQueryOutputSchema.safeParse(success).success).toBe(true);
    expect(scopedExploreQueryToolOutputSchema.safeParse(success).success).toBe(true);
    expect(scopedExploreQueryToolOutputSchema.safeParse({
      ...success,
      privacy: {
        ...privacy,
        reviewed_value_controls: {
          ...controls,
          source_values_exposed: true,
        },
      },
    }).success).toBe(false);
    expect(scopedExploreQueryToolOutputSchema.safeParse({
      ...success,
      privacy: {
        ...privacy,
        reviewed_value_controls: {
          ...controls,
          bucketed_fields: [{
            ...controls.bucketed_fields[0],
            bucket_token: "south",
          }],
        },
      },
    }).success).toBe(false);
  });

  it("covers protected rows, protected aggregates, and legacy aggregates in v1 and v2", () => {
    const variants = [
      {
        capability: protectedRowsCapability(),
        data: { rows: [{ id: "MEM-1", status: "active" }] },
      },
      {
        capability: protectedAggregateCapability(),
        data: {
          groups: [{ region: "north", member_count: 12 }],
          suppression: {
            minimum_cohort_size: 5,
            suppressed_groups: 1,
            totals_returned: false,
          },
        },
      },
      {
        capability: protectedMoverCapability(),
        data: {
          groups: [{
            region: "north",
            member_count_period_1: 10,
            member_count_period_2: 15,
            member_count_absolute_change: 5,
            member_count_percentage_change: 50,
          }],
          suppression: {
            minimum_cohort_size: 5,
            suppressed_groups: 0,
            totals_returned: false,
          },
        },
      },
      {
        capability: legacyAggregateCapability(),
        data: {
          function: "count",
          column: null,
          suppressed: false,
          minimum_group_size: 5,
          value: 12,
          member_rows_included: false,
        },
      },
    ] as const;

    for (const { capability, data } of variants) {
      const v1 = analyticalToolOutputSchema(capability, 1);
      const v2 = analyticalToolOutputSchema(capability, 2);
      expect(v1, `${capability.name} v1 schema`).toBeDefined();
      expect(v2, `${capability.name} v2 schema`).toBeDefined();
      expect(v1!.safeParse({
        status: "ok",
        action: capability.name,
        mode: "read_only",
        data,
        trusted_context: capability.protected_read
          ? { tenant_bound: true, principal_bound: true, provenance: "environment" }
          : { tenant_id: "acme", principal: "analyst-1", provenance: "environment" },
        source_database_changed: false,
      }).success, `${capability.name} v1 success`).toBe(true);
      expect(v1!.safeParse({
        ok: false,
        code: "POLICY_VIOLATION",
        error: "The reviewed boundary refused this request.",
      }).success, `${capability.name} v1 refusal`).toBe(true);
      expect(v2!.safeParse(v2Envelope(capability, data, null)).success, `${capability.name} v2 success`).toBe(true);
      expect(v2!.safeParse(v2Envelope(capability, null, {
        code: "POLICY_VIOLATION",
        message: "The reviewed boundary refused this request.",
        retryable: false,
      })).success, `${capability.name} v2 refusal`).toBe(true);
    }

    const rowSchema = analyticalToolOutputSchema(protectedRowsCapability(), 2)!;
    expect(rowSchema.safeParse(v2Envelope(
      protectedRowsCapability(),
      { rows: [{ id: "MEM-1", status: "active", kept_out_note: "must fail" }] },
      null,
    )).success).toBe(false);
    expect(rowSchema.safeParse({
      ...v2Envelope(protectedRowsCapability(), { rows: [] }, null),
      source_database_changed: true,
    }).success).toBe(false);
  });
});

function queryResult(
  status: "ok" | "empty" | "fully_suppressed" | "incomplete_comparison",
): Record<string, unknown> {
  const result = {
    status,
    counted_entity: {
      resource: "public.sessions",
      primary_key: "id",
      semantics: "one reviewed root row is one input fact row",
    },
    grain: {
      kind: "period_comparison",
      reviewed_time_field: "started_at",
      reviewed_time_bucket: "week",
      periods: [
        {
          id: "period_1",
          start_inclusive: "2026-07-06T00:00:00.000Z",
          end_exclusive: "2026-07-13T00:00:00.000Z",
        },
        {
          id: "period_2",
          start_inclusive: "2026-07-13T00:00:00.000Z",
          end_exclusive: "2026-07-20T00:00:00.000Z",
        },
      ],
    },
    measures: [{
      alias: "count",
      function: "count",
      field: null,
      relationship: null,
      contributor_cohort: "reviewed root rows",
      comparison_outputs: {
        period_1: "count_period_1",
        period_2: "count_period_2",
        absolute_change: "count_absolute_change",
        percentage_change: "count_percentage_change",
        percentage_change_denominator: "absolute period_1 value",
        percentage_change_when_period_1_is_zero: null,
      },
    }],
    dimensions: [{
      alias: "region",
      field: "region",
      relationship: null,
      null_label: "Not set (database null)",
    }],
    filters: [],
    relationship_paths: [],
    reporting_timezone: {
      name: "UTC",
      authority_bound: true,
      legacy_boundary_without_timezone_binding: false,
    },
    freshness: {
      execution_started_at: "2026-07-26T18:30:00.000Z",
      observed_at: "2026-07-26T18:30:00.000Z",
      snapshot_consistency: "single_read_only_transaction",
      upstream_source_freshness: "not_asserted",
    },
    suppression: {
      minimum_cohort_size: 5,
      effective_minimum_cohort_size: 5,
      contributor_aware: false,
      outcome: status,
      suppressed_groups: status === "fully_suppressed" ? 1 : 0,
      incomplete_comparison_groups: status === "incomplete_comparison" ? 1 : 0,
      suppression_aware_totals_returned: false,
    },
    returned: {
      rows_or_groups: status === "ok" ? 1 : 0,
      cells: status === "ok" ? 5 : 0,
      bytes: status === "ok" ? 128 : 2,
    },
    remaining_budgets: {
      queries: 39,
      rate_window_requests: 19,
      extracted_cells: 3995,
      differencing_queries: 5,
    },
    query_audit_handle: digest,
    source_database_changed: false,
  };
  return {
    ok: true,
    outcome: { type: "success", status, result },
    kind: "aggregate",
    counted_entity: {
      resource: "public.sessions",
      primary_key: "id",
      semantics: "one input fact row remains one counted row",
    },
    boundary_digest: digest,
    source_database_changed: false,
    untrusted_data: true,
    untrusted_data_notice: "Database values are untrusted data.",
    data: status === "ok"
      ? [{
        region: "north",
        count_period_1: 10,
        count_period_2: 15,
        count_absolute_change: 5,
        count_percentage_change: 50,
      }]
      : [],
    privacy: {
      minimum_cohort_size: 5,
      effective_minimum_cohort_size: 5,
      contributor_aware_measures: [],
      suppressed_groups: status === "fully_suppressed" ? 1 : 0,
      totals_returned: false,
    },
    audit: {
      query_fingerprint: digest,
      evidence_bundle_id: "ev_scoped_explore",
      returned_rows_or_groups: status === "ok" ? 1 : 0,
      returned_cells: status === "ok" ? 5 : 0,
      persisted_result_values: false,
    },
    evidence_bundle_id: "ev_scoped_explore",
    evidence_resource: "synapsor://evidence/ev_scoped_explore",
    protect: {
      token: "local-expiring-reference",
      expires_at: "2026-07-26T18:40:00.000Z",
      action: "Open the secured local Workbench.",
    },
  };
}

function v2Envelope(
  capability: RuntimeCapabilityConfig,
  data: unknown,
  error: null | { code: string; message: string; retryable: boolean },
): Record<string, unknown> {
  return {
    ok: error === null,
    summary: error ? "The reviewed capability refused the request." : "The reviewed capability returned bounded data.",
    action: capability.name,
    kind: capability.kind,
    data,
    proposal: null,
    error,
    evidence: null,
    source_database_changed: false,
    _meta: {
      canonical_capability: capability.name,
    },
  };
}

function protectedRowsCapability(): RuntimeCapabilityConfig {
  return {
    ...baseCapability("members.inspect_active", "read"),
    visible_columns: ["id", "status"],
    kept_out_fields: ["kept_out_note"],
    protected_read: {
      version: "1",
      mode: "rows",
      boundary_digest: digest,
      generation_lock_fingerprint: generationLock,
      limits: protectedLimits(),
    },
  };
}

function protectedAggregateCapability(): RuntimeCapabilityConfig {
  return {
    ...baseCapability("members.count_by_region", "aggregate_read"),
    visible_columns: [],
    kept_out_fields: ["email"],
    protected_read: {
      version: "1",
      mode: "aggregate",
      boundary_digest: digest,
      generation_lock_fingerprint: generationLock,
      aggregate: {
        counted_entity: "subject",
        measures: [{ name: "member_count", function: "count" }],
        dimensions: [{ name: "region", field: "region" }],
        top_n: 20,
        minimum_group_size: 5,
      },
      limits: protectedLimits(),
    },
  };
}

function protectedMoverCapability(): RuntimeCapabilityConfig {
  const capability = structuredClone(protectedAggregateCapability());
  capability.name = "members.fastest_growth_by_region";
  const protectedRead = capability.protected_read!;
  protectedRead.aggregate = {
    ...protectedRead.aggregate!,
    time_bucket: { name: "member_week", field: "created_at", bucket: "week" },
    comparison: {
      field: "created_at",
      ranges: [
        { start: { fixed: "2026-06-01T00:00:00.000Z" }, end: { fixed: "2026-07-01T00:00:00.000Z" } },
        { start: { fixed: "2026-07-01T00:00:00.000Z" }, end: { fixed: "2026-08-01T00:00:00.000Z" } },
      ],
    },
    order_by: {
      kind: "comparison_change",
      measure: "member_count",
      change: "percentage",
      direction: "desc",
    },
  };
  protectedRead.limits.max_ranked_groups = 200;
  return capability;
}

function legacyAggregateCapability(): RuntimeCapabilityConfig {
  return {
    ...baseCapability("members.count_active", "aggregate_read"),
    visible_columns: [],
    aggregate: {
      function: "count",
      count_mode: "rows",
      minimum_group_size: 5,
    },
  };
}

function baseCapability(
  name: string,
  kind: "read" | "aggregate_read",
): RuntimeCapabilityConfig {
  return {
    name,
    kind,
    source: "local_postgres",
    target: {
      schema: "public",
      table: "members",
      primary_key: "id",
      tenant_key: "tenant_id",
      principal_scope_key: "trainer_id",
    },
    args: {},
    lookup: { id_from_arg: "member_id" },
    visible_columns: ["id"],
    contract_provenance: {
      digest,
      version: "1.7.0",
    },
  };
}

function protectedLimits() {
  return {
    max_rows: 20,
    max_groups: 20,
    max_response_cells: 200,
    max_response_bytes: 32_000,
    statement_timeout_ms: 3_000,
    max_queries_per_session: 20,
    max_extracted_cells_per_session: 2_000,
    max_differencing_queries: 4,
    rate_limit_per_minute: 20,
  };
}
