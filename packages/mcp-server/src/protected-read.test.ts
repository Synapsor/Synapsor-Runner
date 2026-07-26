import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import {
  buildProtectedReadQuery,
  createMcpRuntime,
  protectedReadTargets,
  type DbRowReader,
  type RuntimeCapabilityConfig,
  type RuntimeConfig,
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const lock = `sha256:${"b".repeat(64)}` as const;

describe("protected named reads", () => {
  it("compiles a reviewed star and depth-two path with scope on every relation", () => {
    const capability = aggregateConfig().capabilities?.[0];
    if (!capability?.protected_read?.aggregate) throw new Error("protected aggregate fixture is incomplete");
    delete capability.protected_read.relationship;
    delete capability.protected_read.predicates;
    delete capability.protected_read.aggregate.comparison;
    capability.args = {};
    capability.protected_read.relationships = [
      {
        name: "store",
        links: [{
          schema: "public",
          table: "stores",
          primary_key: "id",
          tenant_key: "tenant_id",
          local_key: "store_id",
          target_key: "id",
          cardinality: "many_to_one",
          max_fan_out: 1,
          unmatched_rows: "exclude",
        }],
      },
      {
        name: "category",
        links: [
          {
            schema: "public",
            table: "products",
            primary_key: "id",
            tenant_key: "tenant_id",
            principal_scope_key: "catalog_manager_id",
            local_key: "product_id",
            target_key: "id",
            cardinality: "many_to_one",
            max_fan_out: 1,
            unmatched_rows: "keep_null",
          },
          {
            schema: "public",
            table: "categories",
            primary_key: "id",
            tenant_key: "tenant_id",
            local_key: "category_id",
            target_key: "id",
            cardinality: "many_to_one",
            max_fan_out: 1,
            unmatched_rows: "keep_null",
          },
        ],
      },
      {
        name: "region",
        links: [{
          schema: "public",
          table: "regions",
          primary_key: "id",
          tenant_key: "tenant_id",
          local_key: "region_id",
          target_key: "id",
          cardinality: "many_to_one",
          max_fan_out: 1,
          unmatched_rows: "exclude",
        }],
      },
    ];
    capability.protected_read.aggregate.dimensions = [
      { name: "store_name", field: "name", relationship: "store" },
      { name: "category_name", field: "name", relationship: "category" },
      { name: "region_name", field: "name", relationship: "region" },
    ];
    delete capability.protected_read.aggregate.time_bucket;
    delete capability.protected_read.aggregate.order_by;

    const context = {
      tenant_id: "tenant-acme",
      principal: "manager-1",
      provenance: "environment" as const,
    };
    for (const placeholderStyle of ["$", "?"] as const) {
      const query = buildProtectedReadQuery(capability, placeholderStyle, {}, context);
      expect(query.sql).toContain(`${placeholderStyle === "$" ? "\"public\".\"stores\"" : "`public`.`stores`"} r1_1`);
      expect(query.sql).toContain("LEFT JOIN");
      expect(query.sql).toContain(`${placeholderStyle === "$" ? "\"public\".\"products\"" : "`public`.`products`"} r2_1`);
      expect(query.sql).toContain(`${placeholderStyle === "$" ? "\"public\".\"categories\"" : "`public`.`categories`"} r2_2`);
      expect(query.sql).toContain(`${placeholderStyle === "$" ? "\"public\".\"regions\"" : "`public`.`regions`"} r3_1`);
      expect(query.sql).toContain("GROUP BY");
      expect(query.sql).not.toMatch(/CROSS JOIN|SELECT\s+\*/i);
      expect(query.values).toEqual([
        "tenant-acme",
        "tenant-acme",
        "manager-1",
        "tenant-acme",
        "tenant-acme",
        "tenant-acme",
        "manager-1",
      ]);
    }
    expect(protectedReadTargets(capability)).toEqual([
      { schema: "public", table: "subscriptions", principalScoped: true },
      { schema: "public", table: "stores", principalScoped: false },
      { schema: "public", table: "products", principalScoped: true },
      { schema: "public", table: "categories", principalScoped: false },
      { schema: "public", table: "regions", principalScoped: false },
    ]);
  });

  it("keeps RLS principal preflight requirements relation-specific", () => {
    const capability = aggregateConfig().capabilities?.[0];
    if (!capability?.protected_read) throw new Error("protected aggregate fixture is incomplete");
    capability.protected_read.relationship = {
      name: "subscriptions_region_id_fkey",
      schema: "public",
      table: "regions",
      local_key: "region_id",
      target_key: "id",
      primary_key: "id",
      tenant_key: "tenant_id",
      cardinality: "many_to_one",
      max_fan_out: 1,
    };
    expect(protectedReadTargets(capability)).toEqual([
      { schema: "public", table: "subscriptions", principalScoped: true },
      { schema: "public", table: "regions", principalScoped: false },
    ]);
    capability.protected_read.relationship!.principal_scope_key = "assigned_operator_id";
    expect(protectedReadTargets(capability)[1]).toEqual({
      schema: "public",
      table: "regions",
      principalScoped: true,
    });
  });

  it("serves a frozen PM aggregate, suppresses small cohorts, and stores no result or trusted values", async () => {
    const store = new ProposalStore(":memory:");
    const seen: RuntimeCapabilityConfig[] = [];
    const readRow: DbRowReader = async ({ capability }) => {
      seen.push(capability);
      return {
        row: { region: "west", churn_week: "2026-07-06", churned_accounts: 8, __cohort_size: 8, __period: "period_1" },
        rows: [
          { region: "west", churn_week: "2026-07-06", churned_accounts: 8, __cohort_size: 8, __period: "period_1" },
          { region: "tiny", churn_week: "2026-07-06", churned_accounts: 2, __cohort_size: 2, __period: "period_1" },
        ],
        rowCount: 2,
      };
    };
    const runtime = createMcpRuntime(aggregateConfig(), {
      store,
      readRow,
      env: {
        SYNAPSOR_TENANT_ID: "tenant-secret",
        SYNAPSOR_PRINCIPAL: "principal-secret",
      },
    });
    try {
      expect(runtime.listTools().map((tool) => tool.name)).toEqual(["analytics.churn_by_week"]);
      expect(runtime.listTools().map((tool) => tool.name)).not.toContain("app.explore_data");
      const result = await runtime.callTool("analytics.churn_by_week", {
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-08-01T00:00:00.000Z",
      });
      expect(result).toMatchObject({
        status: "ok",
        source_database_changed: false,
        data: {
          groups: [{
            region: "west",
            churn_week: "2026-07-06",
            churned_accounts: 8,
            period: "period_1",
          }],
          suppression: {
            minimum_cohort_size: 5,
            suppressed_groups: 1,
            totals_returned: false,
          },
        },
      });
      expect(seen[0]?.protected_read?.mode).toBe("aggregate");
      const audit = store.listQueryAudit();
      expect(audit).toHaveLength(1);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain("tenant-secret");
      expect(serialized).not.toContain("principal-secret");
      expect(serialized).not.toContain('"west"');
      expect(serialized).not.toContain('"tiny"');
      expect(serialized).not.toContain("2026-07-01T00:00:00.000Z");
      expect(audit[0]?.payload).toMatchObject({
        protected_read_version: "synapsor.protected-read.v1",
        result_values_persisted: false,
        trusted_scope_values_persisted: false,
        raw_sql_included: false,
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails closed after the reviewed distinct-query differencing budget", async () => {
    const store = new ProposalStore(":memory:");
    const runtime = createMcpRuntime(aggregateConfig(1), {
      store,
      readRow: async () => ({
        row: { region: "west", churn_week: "2026-07-06", churned_accounts: 8, __cohort_size: 8, __period: "period_1" },
        rows: [{ region: "west", churn_week: "2026-07-06", churned_accounts: 8, __cohort_size: 8, __period: "period_1" }],
        rowCount: 1,
      }),
      env: {
        SYNAPSOR_TENANT_ID: "tenant-acme",
        SYNAPSOR_PRINCIPAL: "pm-1",
      },
    });
    try {
      await runtime.callTool("analytics.churn_by_week", {
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-08-01T00:00:00.000Z",
      });
      await expect(runtime.callTool("analytics.churn_by_week", {
        period_start: "2026-07-02T00:00:00.000Z",
        period_end: "2026-08-02T00:00:00.000Z",
      })).rejects.toMatchObject({ code: "PROTECTED_DIFFERENCING_BUDGET_EXHAUSTED" });
    } finally {
      await runtime.close();
    }
  });
});

function aggregateConfig(maxDifferencingQueries = 4): RuntimeConfig {
  return {
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: ":memory:" },
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
        read_only: true,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
    },
    capabilities: [{
      name: "analytics.churn_by_week",
      kind: "aggregate_read",
      description: "Return reviewed churn counts by week and region.",
      source: "local_postgres",
      target: {
        schema: "public",
        table: "subscriptions",
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_scope_key: "owner_id",
        // Contract loading currently materializes absent optional target fields
        // as undefined. Fingerprints must omit them instead of weakening
        // canonical JSON.
        single_tenant_dev: undefined,
      },
      args: {
        period_start: { type: "string", required: true, max_length: 32 },
        period_end: { type: "string", required: true, max_length: 32 },
      },
      lookup: { id_from_arg: "unused" },
      visible_columns: [],
      kept_out_fields: ["customer_id", "email"],
      protected_read: {
        version: "1",
        mode: "aggregate",
        boundary_digest: digest,
        generation_lock_fingerprint: lock,
        predicates: [{ field: "status", operator: "eq", value: { fixed: "churned" } }],
        aggregate: {
          counted_entity: "subject",
          measures: [{ name: "churned_accounts", function: "count" }],
          dimensions: [{ name: "region", field: "region" }],
          time_bucket: { name: "churn_week", field: "churned_at", bucket: "week" },
          comparison: {
            field: "churned_at",
            ranges: [{
              start: { from_arg: "period_start" },
              end: { from_arg: "period_end" },
            }],
          },
          order_by: { kind: "measure", measure: "churned_accounts", direction: "desc" },
          top_n: 10,
          minimum_group_size: 5,
        },
        limits: {
          max_rows: 20,
          max_groups: 20,
          max_response_cells: 200,
          max_response_bytes: 32_000,
          statement_timeout_ms: 3_000,
          max_queries_per_session: 20,
          max_extracted_cells_per_session: 2_000,
          max_differencing_queries: maxDifferencingQueries,
          rate_limit_per_minute: 20,
        },
      },
      contract_provenance: { digest, version: "1.5.0" },
    }],
  };
}
