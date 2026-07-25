import { describe, expect, it } from "vitest";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import { buildFriendlyAggregatePlan } from "./explore-cli.js";

describe("friendly Scoped Explore CLI", () => {
  it("builds a useful bounded weekly aggregate without plan JSON", () => {
    const plan = buildFriendlyAggregatePlan(boundary(), { suggested: true });
    expect(plan).toEqual({
      kind: "aggregate",
      resource: "public.check_ins",
      measures: [{ function: "count_distinct", field: "member_id" }],
      dimensions: [{ field: "outcome" }],
      time_bucket: { field: "checked_in_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 10,
    });
  });

  it("supports one reviewed relationship path and rejects two", () => {
    expect(buildFriendlyAggregatePlan(boundary(), {
      resource: "public.check_ins",
      countDistinct: ["member_id"],
      groupBy: ["name@check_ins_location_id_fkey"],
      timeBucket: "checked_in_at:week",
      top: 8,
    })).toMatchObject({
      relationship: "check_ins_location_id_fkey",
      dimensions: [{ field: "name", relationship: "check_ins_location_id_fkey" }],
      top_n: 8,
    });

    expect(() => buildFriendlyAggregatePlan(boundary(), {
      resource: "public.check_ins",
      groupBy: [
        "name@check_ins_location_id_fkey",
        "membership_tier@check_ins_member_id_fkey",
      ],
    })).toThrow(/one reviewed relationship path/);
  });

  it("parses typed filters but leaves authority enforcement to Scoped Explore", () => {
    expect(buildFriendlyAggregatePlan(boundary(), {
      resource: "public.check_ins",
      count: true,
      filters: ["outcome:eq:attended", "member_id:in:member-001,member-002"],
    })).toMatchObject({
      where: [
        { field: "outcome", op: "eq", value: "attended" },
        { field: "member_id", op: "in", value: ["member-001", "member-002"] },
      ],
    });
  });
});

function boundary(): ActivatedExplorationBoundary {
  const resource = (
    id: string,
    input: Partial<ActivatedExplorationBoundary["pack"]["resources"][number]> = {},
  ): ActivatedExplorationBoundary["pack"]["resources"][number] => ({
    id,
    schema: "public",
    table: id.split(".")[1]!,
    primary_key: "id",
    tenant_key: "organization_id",
    field_types: {
      id: "text",
      organization_id: "text",
      member_id: "text",
      outcome: "text",
      checked_in_at: "timestamp with time zone",
      name: "text",
      membership_tier: "text",
    },
    field_enums: {},
    selectable_fields: ["outcome", "checked_in_at"],
    filterable_fields: { outcome: ["eq"], member_id: ["eq", "in"], checked_in_at: ["gte", "lt"] },
    sortable_fields: ["checked_in_at"],
    groupable_fields: ["outcome"],
    aggregate_measures: [],
    count_distinct_fields: ["member_id"],
    time_bucket_fields: { checked_in_at: ["day", "week", "month"] },
    kept_out_fields: [],
    relationships: [],
    minimum_cohort_size: 5,
    suppression_aware_totals: true,
    ...input,
  });
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: {
      state: "active",
      digest: "sha256:active",
      actor: "reviewer",
      activated_at: "2026-07-24T00:00:00.000Z",
      generation_lock_fingerprint: "sha256:lock",
      reviewed_decisions: [],
    },
    deployment_profile: "staging",
    source: "app_postgres",
    compiler_version: "1.6.3",
    spec_version: "1.6.0",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: "sha256:lock",
    role_posture_fingerprint: "sha256:role",
    pack: {
      name: "fitflow",
      resources: [
        resource("public.check_ins", {
          relationships: [
            {
              id: "check_ins_location_id_fkey",
              target_resource: "public.locations",
              local_columns: ["location_id"],
              target_columns: ["id"],
              counted_entity: "public.check_ins",
              cardinality: "many_to_one",
              max_fan_out: 1,
            },
            {
              id: "check_ins_member_id_fkey",
              target_resource: "public.members",
              local_columns: ["member_id"],
              target_columns: ["id"],
              counted_entity: "public.check_ins",
              cardinality: "many_to_one",
              max_fan_out: 1,
            },
          ],
        }),
        resource("public.locations", {
          selectable_fields: ["name"],
          filterable_fields: { name: ["eq"] },
          sortable_fields: ["name"],
          groupable_fields: ["name"],
          count_distinct_fields: ["id"],
          time_bucket_fields: {},
        }),
        resource("public.members", {
          selectable_fields: ["membership_tier"],
          filterable_fields: { membership_tier: ["eq"] },
          sortable_fields: ["membership_tier"],
          groupable_fields: ["membership_tier"],
          count_distinct_fields: ["id"],
          time_bucket_fields: {},
        }),
      ],
    },
    budgets: {
      max_rows: 20,
      max_groups: 12,
      max_top_n: 10,
      max_measures: 3,
      max_dimensions: 2,
      max_time_ranges: 2,
      max_relationship_hops: 1,
      max_response_cells: 200,
      max_response_bytes: 64_000,
      statement_timeout_ms: 2_000,
      max_complexity: 20,
      max_queries_per_session: 12,
      max_extracted_cells_per_session: 1_000,
      max_differencing_queries: 3,
      rate_limit_per_minute: 20,
    },
  };
}
