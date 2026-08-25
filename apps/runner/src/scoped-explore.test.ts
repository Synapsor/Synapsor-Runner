import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
  type ReviewedMetadataDecision,
} from "./auto-boundary.js";
import {
  assertPreparedExplorePlanAuthority,
  compileExplorePlan,
  createScopedExploreRuntime,
  loadProtectedPlan,
  prepareScopedExplore,
  projectScopedExploreResultForModel,
  ScopedExploreError,
  validateExplorePlan,
  validateExploreRequest,
  type CompiledExploreQuery,
  type ScopedExploreExecutor,
} from "./scoped-explore.js";
import { createScopedExploreMcpServer, projectDescribeDataForModel } from "./authoring-mcp.js";
import { compileOperatorExploreEvidence } from "./explore-operator-evidence.js";
import { captureExploreParameterizedSql } from "./explore-parameterized-sql.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Scoped Explore", () => {
  it("compiles exact reviewed database identifiers that require dialect quoting", async () => {
    const fixture = await activatedFixture(undefined, quotedIdentifierInspection());
    const rowPlan = validateExplorePlan({
      kind: "rows",
      resource: "public.select",
      select: ["total amount", "caf\u00e9_count", "quote\"field", "back`tick"],
      where: [{ field: "total amount", op: "gte", value: 100 }],
      order_by: [{ field: "total amount", direction: "desc" }],
      limit: 5,
    }, fixture.boundary);
    const aggregatePlan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.select",
      measures: [{ function: "sum", field: "total amount" }],
      dimensions: [{ field: "caf\u00e9_count" }],
      top_n: 10,
    }, fixture.boundary);

    const [postgresRows] = compileExplorePlan(rowPlan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    const [mysqlRows] = compileExplorePlan(rowPlan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "mysql");
    const [postgresAggregate] = compileExplorePlan(aggregatePlan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    const [mysqlAggregate] = compileExplorePlan(aggregatePlan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "mysql");

    expect(postgresRows?.sql).toContain('FROM "public"."select" t0');
    expect(postgresRows?.sql).toContain('t0."total amount" AS "total amount"');
    expect(postgresRows?.sql).toContain('t0."caf\u00e9_count" AS "caf\u00e9_count"');
    expect(postgresRows?.sql).toContain('t0."quote""field" AS "quote""field"');
    expect(postgresRows?.sql).toContain('t0."back`tick" AS "back`tick"');
    expect(mysqlRows?.sql).toContain("FROM `public`.`select` t0");
    expect(mysqlRows?.sql).toContain("t0.`total amount` AS `total amount`");
    expect(mysqlRows?.sql).toContain("t0.`caf\u00e9_count` AS `caf\u00e9_count`");
    expect(mysqlRows?.sql).toContain('t0.`quote"field` AS `quote"field`');
    expect(mysqlRows?.sql).toContain("t0.`back``tick` AS `back``tick`");
    expect(postgresAggregate?.sql).toContain('SUM(t0."total amount")');
    expect(postgresAggregate?.sql).toContain('t0."caf\u00e9_count" AS "dimension_0"');
    expect(mysqlAggregate?.sql).toContain("SUM(t0.`total amount`)");
    expect(mysqlAggregate?.sql).toContain("t0.`caf\u00e9_count` AS `dimension_0`");
    const tampered = structuredClone(fixture.boundary);
    tampered.pack.resources.find((resource) => resource.id === "public.select")!.schema = "public\nunsafe";
    expect(() => compileExplorePlan(rowPlan, tampered, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres")).toThrowError(expect.objectContaining({
      code: "EXPLORE_PLAN_INVALID",
      message: expect.stringMatching(/bounded printable name/i),
    }));

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([{
        "total amount": 125,
        "caf\u00e9_count": "north",
        'quote"field': "quoted",
        "back`tick": "ticked",
      }]),
    });
    try {
      for (const mode of ["local_authoring", "production_http"] as const) {
        const server = createScopedExploreMcpServer(runtime, { mode });
        const client = new Client({ name: `quoted-identifier-${mode}`, version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const described = await client.callTool({
            name: "app.describe_data",
            arguments: { resource: "public.select" },
          });
          expect(described.isError).not.toBe(true);
          expect(described.structuredContent).toMatchObject({
            resources: [{
              id: "public.select",
              selectable_fields: expect.arrayContaining([
                "total amount",
                "caf\u00e9_count",
                'quote"field',
                "back`tick",
              ]),
              vocabulary: expect.objectContaining({ status: "ready" }),
              fields: expect.arrayContaining([expect.objectContaining({
                id: "total amount",
                plan_reference: "exact_id_only",
                semantic_status: "descriptive_identifier",
                operations: expect.objectContaining({ return_value: true }),
              })]),
            }],
          });
          const explored = await client.callTool({
            name: "app.explore_data",
            arguments: { plan: rowPlan },
          });
          expect(explored.isError).not.toBe(true);
          expect(explored.structuredContent).toMatchObject({
            ok: true,
            data: [{
              "total amount": 125,
              "caf\u00e9_count": "north",
              'quote"field': "quoted",
              "back`tick": "ticked",
            }],
          });
        } finally {
          await client.close();
          await server.close();
        }
      }
    } finally {
      await runtime.close();
    }

    expect(() => validateExplorePlan({
      kind: "rows",
      resource: "Sort preferences",
      select: ["total amount"],
      limit: 1,
    }, fixture.boundary)).toThrowError(expect.objectContaining({
      code: "EXPLORE_RESOURCE_FORBIDDEN",
    }));
    expect(() => validateExplorePlan({
      kind: "rows",
      resource: "public.select",
      select: ["Total amount"],
      limit: 1,
    }, fixture.boundary)).toThrowError(expect.objectContaining({
      code: "EXPLORE_FIELD_FORBIDDEN",
    }));
  });

  it("uses boundary-bounded defaults when a model omits row and aggregate limits", async () => {
    const fixture = await activatedFixture();
    const rowPlan = validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
    }, fixture.boundary);
    const aggregatePlan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
    }, fixture.boundary);

    expect(rowPlan).toMatchObject({ kind: "rows", limit: 50 });
    expect(aggregatePlan).toMatchObject({ kind: "aggregate", top_n: 25 });
  });

  it("validates and compiles an exact plan without querying rows, consuming budget, or writing audit evidence", async () => {
    const fixture = await activatedFixture();
    const store = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    const executeBatch = vi.fn(async () => [] as Array<Record<string, unknown>[]>);
    const executor: ScopedExploreExecutor = {
      execute: async () => [],
      executeBatch,
      close: async () => undefined,
    };
    const inspectDatabaseFn = vi.fn(async () => fixture.inspection);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn,
      executor,
      store,
      clock: () => Date.parse("2026-08-25T12:00:00.000Z"),
    });
    try {
      const result = await runtime.validate(aggregatePlan("one"));

      expect(result).toMatchObject({
        ok: true,
        outcome: { type: "validated", status: "ready" },
        boundary_name: fixture.boundary.pack.name,
        boundary_digest: fixture.boundary.activation.digest,
        database_engine: "postgres",
        trusted_scope: {
          tenant: { source: "environment", binding: "SYNAPSOR_TENANT_ID" },
          principal: { source: "not_required" },
        },
        validation: {
          source_catalog_rechecked: true,
          source_query_executed: false,
          explore_budget_consumed: false,
          estimated_response_cells: 6,
          statement_count: 1,
          parameter_values_included: false,
        },
        source_database_changed: false,
      });
      expect(result.normalized_plan).toMatchObject(aggregatePlan("one"));
      expect(result.parameterized_sql).toMatchObject({
        provenance: "captured_before_source_execution",
        parameter_values_persisted: false,
        model_received_sql: false,
        statements: [expect.objectContaining({
          parameter_count: expect.any(Number),
          statement: expect.stringContaining("SELECT"),
        })],
      });
      expect(JSON.stringify(result.parameterized_sql)).not.toContain("tenant-acme");

      await expect(runtime.validate({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["tenant_id"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_FIELD_FORBIDDEN",
      });
      expect(executeBatch).not.toHaveBeenCalled();
      expect(inspectDatabaseFn).toHaveBeenCalledTimes(3);
      expect(store.stats().explore_budget_reservations).toBe(0);
      expect(store.listEvidenceBundles()).toHaveLength(0);
      expect(store.listQueryAudit()).toHaveLength(0);
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("freshly inspects only generation-lock resource dependencies on startup and every query", async () => {
    const fixture = await activatedFixture();
    const inspectionCalls: Array<Record<string, unknown>> = [];
    const inspectDatabaseFn = vi.fn(async (options) => {
      inspectionCalls.push(options as unknown as Record<string, unknown>);
      return fixture.inspection;
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn,
      executor: fixedExecutor([{
        dimension_0: "west",
        measure_0: 10,
        __cohort_size: 10,
      }]),
    });
    try {
      await runtime.explore(aggregatePlan("one"));
      expect(inspectDatabaseFn).toHaveBeenCalledTimes(2);
      const expectedResources = fixture.boundary.pack.resources
        .map((resource) => {
          const [schema = "", ...tableParts] = resource.id.split(".");
          return { schema, table: tableParts.join(".") };
        })
        .sort((left, right) => left.schema.localeCompare(right.schema)
          || left.table.localeCompare(right.table));
      for (const options of inspectionCalls) {
        expect(options.resources).toEqual(expectedResources);
      }
    } finally {
      await runtime.close();
    }
  });

  it("includes every derived-scope proof resource in dependency-scoped inspection", async () => {
    const fixture = await activatedDerivedScopeFixture();
    let inspectionOptions: Record<string, unknown> | undefined;
    await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async (options) => {
        inspectionOptions = options as unknown as Record<string, unknown>;
        return fixture.inspection;
      },
    });
    expect(inspectionOptions?.resources).toEqual([
      { schema: "public", table: "order_items" },
      { schema: "public", table: "orders" },
    ]);
  });

  it("uses database-role tenant scope without a tenant environment value and rechecks it before execution", async () => {
    const fixture = await activatedFixture();
    const env = { ...fixture.env, SYNAPSOR_TENANT_ID: undefined };
    const executeBatch = vi.fn(async ({ queries }: Parameters<ScopedExploreExecutor["executeBatch"]>[0]) =>
      queries.map(() => [{ region: "west" }]));
    const scopes = ["tenant-a", "tenant-b"];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env,
      inspectDatabaseFn: async () => fixture.inspection,
      resolveTrustedScopeFn: vi.fn(async () => ({
        tenant: scopes.shift() ?? "tenant-b",
        principal: "",
        tenant_source: "postgres_role_setting" as const,
        tenant_binding: "app.tenant_id",
        principal_source: "not_required" as const,
      })),
      executor: {
        execute: async () => [],
        executeBatch,
        close: async () => undefined,
      },
    });
    try {
      expect(runtime.trusted_scope).toEqual({
        tenant: { source: "postgres_role_setting", binding: "app.tenant_id" },
        principal: { source: "not_required" },
      });
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).rejects.toMatchObject({ code: "EXPLORE_SCOPE_FORBIDDEN" });
      expect(executeBatch).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("projects model-withheld values to response-local opaque tokens without changing human data", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources.find((item) => item.id === "public.subscriptions");
    if (!resource) throw new Error("fixture resource missing");
    resource.model_withheld_fields = ["region"];
    const plan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    };
    const full = {
      ok: true,
      data: [
        { region: "west-ignore-previous-instructions", count: 8 },
        { region: "west-ignore-previous-instructions", count: 5 },
        { region: "north", count: 7 },
      ],
      source_database_changed: false,
    };

    const first = projectScopedExploreResultForModel({
      tool: "app.explore_data",
      arguments: { plan },
      result: full,
      boundary,
    });
    const second = projectScopedExploreResultForModel({
      tool: "app.explore_data",
      arguments: { plan },
      result: full,
      boundary,
    });

    expect(full.data[0]?.region).toContain("ignore-previous");
    expect(first.withheld).toBe(true);
    expect(first.value.data).toEqual([
      { region: expect.stringMatching(/^\[withheld:[a-f0-9]{12}:1\]$/), count: 8 },
      { region: expect.stringMatching(/^\[withheld:[a-f0-9]{12}:1\]$/), count: 5 },
      { region: expect.stringMatching(/^\[withheld:[a-f0-9]{12}:2\]$/), count: 7 },
    ]);
    expect(JSON.stringify(first.value)).not.toContain("ignore-previous");
    expect(JSON.stringify(first.value)).not.toContain("north");
    expect((first.value.data as Array<Record<string, unknown>>)[0]?.region)
      .not.toBe((second.value.data as Array<Record<string, unknown>>)[0]?.region);
  });

  it("returns a reviewed count-distinct measure without sending the model any withheld field value", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources.find((item) => item.id === "public.subscriptions");
    if (!resource) throw new Error("fixture resource missing");
    resource.kept_out_fields = resource.kept_out_fields.filter((field) => field !== "billing_token");
    resource.selectable_fields.push("billing_token");
    resource.count_distinct_fields.push("billing_token");
    resource.model_withheld_fields = ["billing_token"];
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count_distinct", field: "billing_token" }],
      top_n: 1,
    }, boundary);
    const full = {
      ok: true,
      data: [{ count_distinct_billing_token: 30 }],
      privacy: {
        minimum_cohort_size: 5,
        suppressed_groups: 0,
        totals_returned: false,
      },
      source_database_changed: false,
    };

    const projected = projectScopedExploreResultForModel({
      tool: "app.explore_data",
      arguments: { plan },
      result: full,
      boundary,
    });

    expect(projected.withheld).toBe(false);
    expect(projected.value).toEqual(full);
    expect(JSON.stringify(projected.value)).not.toContain("billing-token-secret");
    const [compiled] = compileExplorePlan(plan, boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    expect(compiled?.sql).toContain('COUNT(DISTINCT t0."billing_token")');
  });

  it("returns reviewed numeric aggregates without sending Runner-only source values to the model", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources.find((item) => item.id === "public.subscriptions");
    if (!resource) throw new Error("fixture resource missing");
    resource.model_withheld_fields = ["monthly_revenue_cents"];
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [
        { function: "sum", field: "monthly_revenue_cents" },
        { function: "avg", field: "monthly_revenue_cents" },
      ],
      top_n: 1,
    }, boundary);
    const full = {
      ok: true,
      data: [{ sum_monthly_revenue_cents: 125_000, avg_monthly_revenue_cents: 2_500 }],
      privacy: {
        minimum_cohort_size: 5,
        suppressed_groups: 0,
        totals_returned: false,
      },
      source_database_changed: false,
    };

    const projected = projectScopedExploreResultForModel({
      tool: "app.explore_data",
      arguments: { plan },
      result: full,
      boundary,
    });

    expect(projected).toEqual({ value: full, withheld: false });
    const [compiled] = compileExplorePlan(plan, boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    expect(compiled?.sql).toContain('SUM(t0."monthly_revenue_cents")');
    expect(compiled?.sql).toContain('AVG(t0."monthly_revenue_cents")');
  });

  it("compiles contributor-aware dispersion on PostgreSQL and MySQL", async () => {
    const fixture = await activatedFixture();
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [
        { function: "stddev_samp", field: "monthly_revenue_cents" },
        { function: "var_pop", field: "monthly_revenue_cents" },
      ],
      top_n: 1,
    }, fixture.boundary);

    const [postgres] = compileExplorePlan(plan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    const [mysql] = compileExplorePlan(plan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "mysql");

    expect(postgres?.sql).toContain('STDDEV_SAMP(t0."monthly_revenue_cents")');
    expect(postgres?.sql).toContain('VAR_POP(t0."monthly_revenue_cents")');
    expect(postgres?.sql).toContain('COUNT(t0."monthly_revenue_cents") AS "__measure_cohort_0"');
    expect(mysql?.sql).toContain("STDDEV_SAMP(t0.`monthly_revenue_cents`)");
    expect(mysql?.sql).toContain("VAR_POP(t0.`monthly_revenue_cents`)");
    expect(mysql?.sql).toContain("COUNT(t0.`monthly_revenue_cents`) AS `__measure_cohort_1`");
  });

  it("compiles reviewed missing-data measures without exposing source values", async () => {
    const fixture = await activatedFixture();
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [
        { function: "null_count", field: "monthly_revenue_cents" },
        { function: "non_null_count", field: "monthly_revenue_cents" },
        { function: "completion_rate", field: "monthly_revenue_cents" },
      ],
      top_n: 1,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      const field = engine === "postgres"
        ? 't0."monthly_revenue_cents"'
        : "t0.`monthly_revenue_cents`";
      expect(compiled?.sql).toContain(`COUNT(*) - COUNT(${field})`);
      expect(compiled?.sql).toContain(`COUNT(${field})`);
      expect(compiled?.sql).toContain(`100.0 * COUNT(${field}) / NULLIF(COUNT(*), 0)`);
      expect(compiled?.params).toEqual(["tenant-acme", 51]);
    }
  });

  it("selects a digest-bound derived measure by name and never accepts a model formula", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.derived_measures = [{
        name: "average_revenue_per_subscription",
        label: "Average revenue per subscription",
        shape: "per_unit_average",
        numerator: { function: "sum", field: "monthly_revenue_cents" },
        denominator: { function: "count" },
        null_policy: "null_on_zero_or_null_denominator",
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ derived_measure: "average_revenue_per_subscription" }],
      top_n: 1,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      const field = engine === "postgres"
        ? 't0."monthly_revenue_cents"'
        : "t0.`monthly_revenue_cents`";
      expect(compiled?.sql).toContain(`SUM(${field}) / COUNT(*)`);
      expect(compiled?.sql).toContain(`LEAST(COUNT(*), COUNT(${field}), COUNT(*))`);
    }

    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{
        derived_measure: "average_revenue_per_subscription",
        formula: "SUM(monthly_revenue_cents) / COUNT(*)",
      }],
      top_n: 1,
    }, fixture.boundary)).toThrow(/unsupported fields: formula/i);

    const description = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      await expect(description.describe({ resource: "public.subscriptions" })).resolves.toMatchObject({
        resources: [{
          derived_measures: [{
            name: "average_revenue_per_subscription",
            shape: "per_unit_average",
            effective_minimum_cohort_size: 5,
          }],
        }],
      });
    } finally {
      await description.close();
    }
  });

  it("runs reviewed running totals only over groups released after suppression", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.derived_measures = [{
        name: "revenue_running_total",
        label: "Revenue running total",
        shape: "running_total",
        base_measure: { function: "sum", field: "monthly_revenue_cents" },
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ derived_measure: "revenue_running_total" }],
      dimensions: [{ field: "region" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 10,
    }, fixture.boundary);
    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 'SUM(t0."monthly_revenue_cents") AS "measure_0"'
        : "SUM(t0.`monthly_revenue_cents`) AS `measure_0`");
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 't0."churned_at" IS NOT NULL'
        : "t0.`churned_at` IS NOT NULL");
      expect(compiled?.sql).not.toMatch(/\bOVER\s*\(|RUNNING_TOTAL/i);
    }
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ derived_measure: "revenue_running_total" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    }, fixture.boundary)).toThrow(/requires one reviewed time_bucket/i);

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([
        { dimension_0: "north", time_bucket: "2026-07-06", measure_0: 10, __measure_cohort_0: 10, __cohort_size: 10 },
        { dimension_0: "north", time_bucket: "2026-07-13", measure_0: 100, __measure_cohort_0: 2, __cohort_size: 2 },
        { dimension_0: "north", time_bucket: "2026-07-20", measure_0: 20, __measure_cohort_0: 20, __cohort_size: 20 },
        { dimension_0: "south", time_bucket: "2026-07-06", measure_0: 5, __measure_cohort_0: 5, __cohort_size: 5 },
      ]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      await expect(runtime.describe({ resource: "public.subscriptions" })).resolves.toMatchObject({
        resources: [{
          derived_measures: [{
            name: "revenue_running_total",
            records_without_reviewed_time: "omitted",
          }],
        }],
      });
      const result = await runtime.explore(plan);
      expect(result.data).toEqual([
        { region: "north", time_bucket: "2026-07-06", revenue_running_total: 10 },
        { region: "south", time_bucket: "2026-07-06", revenue_running_total: 5 },
        { region: "north", time_bucket: "2026-07-20", revenue_running_total: 30 },
      ]);
      expect(result.privacy).toMatchObject({ suppressed_groups: 1 });
      expect(JSON.stringify(result)).not.toContain("2026-07-13");
    } finally {
      await runtime.close();
    }
  });

  it("counts scoped child rows through a reviewed inverse relationship without a fan-out join", async () => {
    const fixture = await activatedDerivedScopeFixture((candidate) => {
      const orders = candidate.pack.resources.find((resource) => resource.id === "public.orders")!;
      orders.derived_measures = [{
        name: "order_item_count",
        label: "Order item count",
        shape: "child_count_total",
        child_resource: "public.order_items",
        relationship: "order_items_order_id_fkey",
      }, {
        name: "average_items_per_order",
        label: "Average items per order",
        shape: "child_count_average",
        child_resource: "public.order_items",
        relationship: "order_items_order_id_fkey",
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.orders",
      measures: [
        { derived_measure: "order_item_count" },
        { derived_measure: "average_items_per_order" },
      ],
      dimensions: [{ field: "region" }],
      top_n: 10,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      const sql = compiled!.sql;
      expect(sql).toContain(engine === "postgres"
        ? 'SUM((SELECT COUNT(*) FROM "public"."order_items" fc0 WHERE fc0."order_id" = t0."id"'
        : "SUM((SELECT COUNT(*) FROM `public`.`order_items` fc0 WHERE fc0.`order_id` = t0.`id`");
      expect(sql).toContain(engine === "postgres"
        ? 'AVG(1.0 * (SELECT COUNT(*) FROM "public"."order_items" fc1 WHERE fc1."order_id" = t0."id"'
        : "AVG(1.0 * (SELECT COUNT(*) FROM `public`.`order_items` fc1 WHERE fc1.`order_id` = t0.`id`");
      expect(sql).toContain("EXISTS (SELECT 1 FROM");
      expect(sql).not.toMatch(/JOIN\s+["`]public["`]\.["`]order_items["`]/i);
      expect(compiled!.resources.map((resource) => resource.id).sort()).toEqual([
        "public.order_items",
        "public.orders",
      ]);
      expect(compiled!.params).toEqual([
        "tenant-acme",
        "tenant-acme",
        "tenant-acme",
        fixture.boundary.budgets.max_groups + 1,
      ]);
      if (engine === "mysql") {
        expect((sql.match(/\?/g) ?? [])).toHaveLength(compiled!.params.length);
      }
    }

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([
        { dimension_0: "north", measure_0: 18, __measure_cohort_0: 8, measure_1: 2.25, __measure_cohort_1: 8, __cohort_size: 8 },
        { dimension_0: "private", measure_0: 3, __measure_cohort_0: 2, measure_1: 1.5, __measure_cohort_1: 2, __cohort_size: 2 },
      ]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      await expect(runtime.describe({ resource: "public.orders" })).resolves.toMatchObject({
        resources: [{
          derived_measures: [
            expect.objectContaining({
              name: "order_item_count",
              shape: "child_count_total",
              child_resource: "public.order_items",
              raw_child_rows_returned: false,
            }),
            expect.objectContaining({
              name: "average_items_per_order",
              shape: "child_count_average",
            }),
          ],
        }],
      });
      await expect(runtime.explore(plan)).resolves.toMatchObject({
        data: [{ region: "north", order_item_count: 18, average_items_per_order: 2.25 }],
        privacy: { suppressed_groups: 1, minimum_cohort_size: 5 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("counts child rows without fake tenant predicates in an explicit single-organization boundary", async () => {
    const fixture = await activatedDerivedScopeFixture();
    const boundary = structuredClone(fixture.boundary);
    boundary.organization_scope = {
      mode: "single_organization",
      organization_id: "internal-finance",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    for (const resource of boundary.pack.resources) {
      delete resource.tenant_key;
      delete resource.tenant_scope;
    }
    const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
    orders.derived_measures = [{
      name: "order_item_count",
      label: "Order item count",
      shape: "child_count_total",
      child_resource: "public.order_items",
      relationship: "order_items_order_id_fkey",
    }];
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: orders.id,
      measures: [{ derived_measure: "order_item_count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    }, boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, boundary, {
        tenant: "internal-finance",
        principal: "",
      }, engine);
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 'FROM "public"."order_items" fc0'
        : "FROM `public`.`order_items` fc0");
      expect(compiled?.sql).not.toContain("tenant_id");
      expect(compiled?.params).not.toContain("internal-finance");
      expect(compiled?.resources.map((resource) => resource.id).sort()).toEqual([
        "public.order_items",
        "public.orders",
      ]);
    }
  });

  it("refuses malformed, nullable, and tenant-neutral child-count authority", async () => {
    const fixture = await activatedDerivedScopeFixture();
    const boundary = structuredClone(fixture.boundary);
    const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
    const child = boundary.pack.resources.find((resource) => resource.id === "public.order_items")!;
    orders.derived_measures = [{
      name: "order_item_count",
      label: "Order item count",
      shape: "child_count_total",
      child_resource: child.id,
      relationship: "order_items_order_id_fkey",
    }];
    child.tenant_scope!.proof.links[0]!.nullable = true;
    child.tenant_scope!.proof.digest = canonicalJsonDigest(child.tenant_scope!.proof.links);
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: orders.id,
      measures: [{ derived_measure: "order_item_count" }],
      top_n: 1,
    }, boundary)).toThrow(/catalog-proven child relationship|non-null child-to-parent relationship/i);

    const tenantNeutral = structuredClone(fixture.boundary);
    const neutralOrders = tenantNeutral.pack.resources.find((resource) => resource.id === "public.orders")!;
    const neutralChild = tenantNeutral.pack.resources.find((resource) => resource.id === "public.order_items")!;
    neutralOrders.derived_measures = [{
      name: "order_item_count",
      label: "Order item count",
      shape: "child_count_total",
      child_resource: neutralChild.id,
      relationship: "order_items_order_id_fkey",
    }];
    delete neutralChild.tenant_scope;
    neutralChild.shared_reference_scope = {
      mode: "shared_reference",
      acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
    };
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: neutralOrders.id,
      measures: [{ derived_measure: "order_item_count" }],
      top_n: 1,
    }, tenantNeutral)).toThrow(/independently reviewed tenant scope/i);
  });

  it("selects a reviewed numeric band by name and parameterizes its fixed definition on both engines", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.numeric_bands = [{
        name: "monthly_revenue_band",
        label: "Monthly revenue band",
        field: "monthly_revenue_cents",
        edges: [1_000, 5_000],
        bucket_labels: ["under 10", "10 to 49", "50 or more"],
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "monthly_revenue_band" }],
      top_n: 10,
    }, fixture.boundary);

    const [postgres] = compileExplorePlan(plan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");
    expect(postgres?.sql).toContain('CASE WHEN t0."monthly_revenue_cents" IS NULL THEN NULL');
    expect(postgres?.sql).toContain('WHEN t0."monthly_revenue_cents" < $2 THEN $3');
    expect(postgres?.sql).toContain('WHEN t0."monthly_revenue_cents" < $4 THEN $5 ELSE $6 END AS "dimension_0"');
    expect(postgres?.sql).toContain("GROUP BY 1");
    expect(postgres?.params).toEqual([
      "tenant-acme",
      1_000,
      "under 10",
      5_000,
      "10 to 49",
      "50 or more",
      51,
    ]);

    const [mysql] = compileExplorePlan(plan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "mysql");
    expect(mysql?.sql).toContain("CASE WHEN t0.`monthly_revenue_cents` IS NULL THEN NULL");
    expect(mysql?.sql).toContain("WHEN t0.`monthly_revenue_cents` < ? THEN ?");
    expect(mysql?.sql).toContain("GROUP BY 1");
    expect(mysql?.params).toEqual([
      1_000,
      "under 10",
      5_000,
      "10 to 49",
      "50 or more",
      "tenant-acme",
      51,
    ]);

    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{
        numeric_band: "monthly_revenue_band",
        edges: [0],
      }],
      top_n: 10,
    }, fixture.boundary)).toThrow(/unsupported fields: edges/i);
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "invented_band" }],
      top_n: 10,
    }, fixture.boundary)).toThrow(/reviewed numeric bands: monthly_revenue_band/i);

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      await expect(runtime.describe({ resource: "public.subscriptions" })).resolves.toMatchObject({
        resources: [{
          numeric_bands: [{
            name: "monthly_revenue_band",
            field: "monthly_revenue_cents",
            relationship: null,
            edges: [1_000, 5_000],
            bucket_labels: ["under 10", "10 to 49", "50 or more"],
          }],
        }],
      });
    } finally {
      await runtime.close();
    }
  });

  it("compiles reviewed exact numeric groups through the ordinary bounded aggregate path", async () => {
    const inspection = exactNumericGroupingInspection();
    const fixture = await activatedFixture(
      undefined,
      inspection,
      undefined,
      undefined,
      { exact_numeric_grouping: ["started_year"] },
    );
    const resource = fixture.boundary.pack.resources[0]!;
    expect(resource.groupable_fields).toContain("started_year");
    expect(resource.numeric_bands).toBeUndefined();
    expect(resource.auto_bands).toBeUndefined();

    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "started_year" }],
      top_n: 10,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      expect(compiled?.sql).toContain(
        engine === "postgres"
          ? 't0."started_year" AS "dimension_0"'
          : "t0.`started_year` AS `dimension_0`",
      );
      expect(compiled?.sql).toContain(
        engine === "postgres"
          ? 't0."tenant_id" = $1'
          : "t0.`tenant_id` = ?",
      );
      expect(compiled?.sql).toContain(
        engine === "postgres"
          ? 'GROUP BY t0."started_year"'
          : "GROUP BY t0.`started_year`",
      );
      expect(compiled?.sql).not.toContain("CASE WHEN");
      expect(compiled?.params).toContain("tenant-acme");
      expect(compiled?.params.at(-1)).toBe(fixture.boundary.budgets.max_groups + 1);
    }

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([
        { dimension_0: 2024, measure_0: 12, __cohort_size: 12 },
        { dimension_0: 2025, measure_0: 2, __cohort_size: 2 },
      ]),
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as any;
      expect(description.resources[0]?.groupable_fields).toContain("started_year");
      const modelDescription = projectDescribeDataForModel(description, true) as any;
      expect(modelDescription.resources[0]?.groupable_fields).toContain("started_year");
      const result = await runtime.explore(plan);
      expect(result.data).toEqual([{ started_year: 2024, count: 12 }]);
      expect(result.privacy).toMatchObject({
        minimum_cohort_size: 5,
        suppressed_groups: 1,
      });
      expect(JSON.stringify(result)).not.toContain("2025");
    } finally {
      await runtime.close();
    }

    const overflowFixture = await activatedFixture(
      undefined,
      exactNumericGroupingInspection(),
      undefined,
      undefined,
      { exact_numeric_grouping: ["started_year"] },
    );
    const overflowRuntime = await createScopedExploreRuntime({
      projectRoot: overflowFixture.root,
      transport: "stdio",
      env: overflowFixture.env,
      inspectDatabaseFn: async () => overflowFixture.inspection,
      executor: fixedExecutor(Array.from(
        { length: overflowFixture.boundary.budgets.max_groups + 1 },
        (_, index) => ({
          dimension_0: 1900 + index,
          measure_0: 10,
          __cohort_size: 10,
        }),
      )),
    });
    try {
      await expect(overflowRuntime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "started_year" }],
        top_n: 10,
      })).rejects.toMatchObject({ code: "EXPLORE_RESPONSE_TOO_LARGE" });
    } finally {
      await overflowRuntime.close();
    }
  }, 20_000);

  it("compiles reviewed exact date groups without changing their database type", async () => {
    const inspection = exactNumericGroupingInspection();
    const fixture = await activatedFixture(
      undefined,
      inspection,
      undefined,
      undefined,
      { exact_numeric_grouping: ["commissioned_on"] },
    );
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "commissioned_on" }],
      top_n: 10,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      const quoted = engine === "postgres" ? 't0."commissioned_on"' : "t0.`commissioned_on`";
      expect(compiled?.sql).toContain(`${quoted} AS `);
      expect(compiled?.sql).toContain(`GROUP BY ${quoted}`);
      expect(compiled?.sql).not.toMatch(/CAST\s*\(.*commissioned_on/i);
    }
  });

  it("compiles one reviewed quantile auto band over scoped rows on both engines", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.auto_bands = [{
        field: "monthly_revenue_cents",
        methods: ["quantile"],
        min_buckets: 3,
        max_buckets: 8,
        label_style: "ordinal",
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "avg", field: "monthly_revenue_cents" }],
      dimensions: [{ numeric_band: {
        field: "monthly_revenue_cents",
        method: "quantile",
        buckets: 5,
      } }],
      top_n: 10,
    }, fixture.boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      expect(compiled?.sql).toContain("CUME_DIST() OVER");
      expect(compiled?.sql).toContain("PARTITION BY CASE WHEN");
      expect(compiled?.sql).toContain("__synapsor_auto_scope");
      expect(compiled?.sql).toContain("__synapsor_auto_banded");
      expect(compiled?.sql).toContain("__auto_bucket");
      expect(compiled?.sql).toContain("COUNT(ab.");
      expect(compiled?.sql).not.toMatch(/NTILE|PERCENTILE/i);
      expect(compiled?.params).toContain("tenant-acme");
    }
  });

  it("labels auto bands without releasing raw edges and enforces a cohort floor of five", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.auto_bands = [{
        field: "monthly_revenue_cents",
        methods: ["quantile"],
        min_buckets: 3,
        max_buckets: 8,
        label_style: "ordinal",
      }];
    }, churnInspection(), 1);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([
        { dimension_0: 1, measure_0: 100, __cohort_size: 4, __auto_effective_buckets: 5 },
        { dimension_0: 2, measure_0: 250, __cohort_size: 5, __auto_effective_buckets: 5 },
        { dimension_0: 5, measure_0: 900, __cohort_size: 8, __auto_effective_buckets: 5 },
      ]),
    });
    try {
      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ numeric_band: {
          field: "monthly_revenue_cents",
          method: "quantile",
          buckets: 5,
        } }],
        top_n: 10,
      }) as any;
      expect(result.data).toEqual([
        { monthly_revenue_cents_quantile_band: "Q2 of 5", count: 250 },
        { monthly_revenue_cents_quantile_band: "Q5 of 5", count: 900 },
      ]);
      expect(result.privacy).toMatchObject({
        effective_minimum_cohort_size: 5,
        suppressed_groups: 1,
        auto_bands: [{
          field: "monthly_revenue_cents",
          method: "quantile",
          requested_buckets: 5,
          effective_buckets: 3,
          reduced: true,
          raw_edges_returned: false,
        }],
      });
      expect(JSON.stringify(result)).not.toContain("__auto_");
    } finally {
      await runtime.close();
    }
  });

  it("uses reviewed outward rounding for auto-band labels and reduces unsafe equal widths", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.auto_bands = [{
        field: "monthly_revenue_cents",
        methods: ["equal_width"],
        min_buckets: 2,
        max_buckets: 10,
        min_bucket_width: 1_000,
        label_style: "rounded",
        label_round_to: 1_000,
      }];
    });
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: {
        field: "monthly_revenue_cents",
        method: "equal_width",
        buckets: 8,
      } }],
      top_n: 10,
    }, fixture.boundary);
    const [compiled] = compileExplorePlan(plan, fixture.boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "mysql");
    expect(compiled?.sql).toContain("GREATEST(1, FLOOR");
    expect(compiled?.sql).toContain("__synapsor_auto_labeled");
    expect(compiled?.sql).toContain("MIN(b.`__auto_value`) OVER");
    expect(compiled?.params).not.toContain(1_000);

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([{
        dimension_0: 1,
        measure_0: 12,
        __cohort_size: 12,
        __auto_effective_buckets: 3,
        __auto_bucket_min: 2_000,
        __auto_bucket_max: 2_900,
      }]),
    });
    try {
      const result = await runtime.explore(plan) as any;
      expect(result.data).toEqual([{
        monthly_revenue_cents_equal_width_band: "1000 to 3000",
        count: 12,
      }]);
      expect(result.privacy.auto_bands).toEqual([expect.objectContaining({
        requested_buckets: 8,
        effective_buckets: 3,
        reduced: true,
        label_style: "rounded",
      })]);
      expect(JSON.stringify(result)).not.toContain("2000");
      expect(JSON.stringify(result)).not.toContain("2900");
    } finally {
      await runtime.close();
    }
  });

  it("refuses unreviewed or malformed adaptive numeric grouping before execution", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.auto_bands = [{
        field: "monthly_revenue_cents",
        methods: ["quantile"],
        min_buckets: 3,
        max_buckets: 6,
        label_style: "ordinal",
      }];
    });
    const base = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      top_n: 10,
    };
    expect(() => validateExplorePlan({
      ...base,
      dimensions: [{ numeric_band: { field: "monthly_revenue_cents", method: "equal_width", buckets: 4 } }],
    }, fixture.boundary)).toThrow(/not a reviewed auto-band method/i);
    expect(() => validateExplorePlan({
      ...base,
      dimensions: [{ numeric_band: { field: "monthly_revenue_cents", method: "quantile", buckets: 7 } }],
    }, fixture.boundary)).toThrow(/from 3 through 6/i);
    expect(() => validateExplorePlan({
      ...base,
      dimensions: [{ numeric_band: {
        field: "monthly_revenue_cents",
        method: "quantile",
        buckets: 4,
        edges: [1, 2],
      } }],
    }, fixture.boundary)).toThrow(/unsupported fields: edges/i);
    expect(() => validateExplorePlan({
      ...base,
      dimensions: [
        { numeric_band: { field: "monthly_revenue_cents", method: "quantile", buckets: 4 } },
        { numeric_band: { field: "monthly_revenue_cents", method: "quantile", buckets: 5 } },
      ],
    }, fixture.boundary)).toThrow(/at most one reviewed auto-band/i);
    expect(() => validateExplorePlan({
      ...base,
      dimensions: [{ numeric_band: { field: "monthly_revenue_cents", method: "quantile", buckets: 4 } }],
      time_bucket: { field: "churned_at", bucket: "month" },
      comparison: {
        field: "churned_at",
        ranges: [
          { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
          { start: "2026-02-01T00:00:00.000Z", end: "2026-03-01T00:00:00.000Z" },
        ],
      },
    }, fixture.boundary)).toThrow(/cannot be combined with a two-period comparison/i);
  });

  it("suppresses field aggregates by non-null contributors and keeps a fixed dispersion floor of five", async () => {
    const fixture = await activatedFixture(undefined, churnInspection(), 4);
    const responses = [
      [{ measure_0: 0, __measure_cohort_0: 4, __cohort_size: 12 }],
      [{ measure_0: 11.5, __measure_cohort_0: 1, __cohort_size: 12 }],
      [{ measure_0: 3.25, __measure_cohort_0: 5, __cohort_size: 12 }],
    ];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async () => [responses.shift()!],
        close: async () => undefined,
      },
    });
    try {
      const dispersionPlan = {
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "stddev_pop", field: "monthly_revenue_cents" }],
        top_n: 1,
      };
      const belowDispersionFloor = await runtime.explore(dispersionPlan) as any;
      expect(belowDispersionFloor.data).toEqual([]);
      expect(belowDispersionFloor.privacy).toMatchObject({
        minimum_cohort_size: 4,
        effective_minimum_cohort_size: 5,
        suppressed_groups: 1,
      });

      const sparseAverage = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "avg", field: "monthly_revenue_cents" }],
        top_n: 1,
      }) as any;
      expect(sparseAverage.data).toEqual([]);
      expect(sparseAverage.privacy.suppressed_groups).toBe(1);

      const released = await runtime.explore(dispersionPlan) as any;
      expect(released.data).toEqual([{ stddev_pop_monthly_revenue_cents: 3.25 }]);
      expect(released.privacy.effective_minimum_cohort_size).toBe(5);
    } finally {
      await runtime.close();
    }
  });

  it("compiles all reviewed calendar grains portably", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.time_bucket_fields.churned_at = [
        "hour", "day", "week", "month", "quarter", "year", "day_of_week",
      ];
    });
    const expected = {
      postgres: {
        hour: "date_trunc('hour'",
        quarter: "date_trunc('quarter'",
        day_of_week: "EXTRACT(ISODOW FROM",
      },
      mysql: {
        hour: "DATE_FORMAT(",
        quarter: "CONCAT(YEAR(",
        day_of_week: "WEEKDAY(",
      },
    } as const;
    for (const engine of ["postgres", "mysql"] as const) {
      for (const bucket of ["hour", "quarter", "day_of_week"] as const) {
        const plan = validateExplorePlan({
          kind: "aggregate",
          resource: "public.subscriptions",
          measures: [{ function: "count" }],
          time_bucket: { field: "churned_at", bucket },
          top_n: 10,
        }, fixture.boundary);
        const [compiled] = compileExplorePlan(plan, fixture.boundary, {
          tenant: "tenant-acme",
          principal: "pm-1",
        }, engine);
        expect(compiled?.sql).toContain(expected[engine][bucket]);
      }
    }
  });

  it("returns the same canonical calendar bucket labels for PostgreSQL and MySQL driver values", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.time_bucket_fields.churned_at = [
        "hour", "day", "week", "month", "quarter", "year", "day_of_week",
      ];
    });
    const responses: Array<Record<string, unknown>> = [
      { time_bucket: new Date("2026-07-14T09:00:00.000Z"), measure_0: 6, __cohort_size: 6 },
      { time_bucket: "2026-07-14", measure_0: 6, __cohort_size: 6 },
      { time_bucket: new Date("2026-07-13T00:00:00.000Z"), measure_0: 6, __cohort_size: 6 },
      { time_bucket: "2026-07-01", measure_0: 6, __cohort_size: 6 },
      { time_bucket: new Date("2026-07-01T00:00:00.000Z"), measure_0: 6, __cohort_size: 6 },
      { time_bucket: "2026-Q3", measure_0: 6, __cohort_size: 6 },
      { time_bucket: 2026, measure_0: 6, __cohort_size: 6 },
      { time_bucket: "2", measure_0: 6, __cohort_size: 6 },
    ];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async () => [[structuredClone(responses.shift()!)]],
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const expected = [
      ["hour", "2026-07-14T09:00:00Z"],
      ["day", "2026-07-14"],
      ["week", "2026-07-13"],
      ["month", "2026-07-01"],
      ["quarter", "2026-Q3"],
      ["quarter", "2026-Q3"],
      ["year", "2026"],
      ["day_of_week", 2],
    ] as const;
    try {
      for (const [bucket, label] of expected) {
        const result = await runtime.explore({
          kind: "aggregate",
          resource: "public.subscriptions",
          measures: [{ function: "count" }],
          time_bucket: { field: "churned_at", bucket },
          top_n: 10,
        });
        expect(result.data).toEqual([{ time_bucket: label, count: 6 }]);
      }
    } finally {
      await runtime.close();
    }
  });

  it("emits no tenant predicate only for an explicit single-organization boundary", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    boundary.organization_scope = {
      mode: "single_organization",
      organization_id: "internal-finance",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    for (const resource of boundary.pack.resources) {
      delete resource.tenant_key;
      delete resource.tenant_scope;
    }
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      top_n: 1,
    }, boundary);
    const [compiled] = compileExplorePlan(plan, boundary, {
      tenant: "internal-finance",
      principal: "",
    }, "postgres");
    expect(compiled?.params).not.toContain("internal-finance");
    expect(compiled?.sql).not.toContain('"tenant_id" =');
    expect(compiled?.sql).not.toContain(" WHERE ");
    expect(compiled?.sql).toMatch(/FROM "public"\."subscriptions" t0 LIMIT \$1$/);

    const rowPlan = validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["id"],
      limit: 1,
    }, boundary);
    const [compiledRows] = compileExplorePlan(rowPlan, boundary, {
      tenant: "internal-finance",
      principal: "",
    }, "postgres");
    expect(compiledRows?.sql).not.toContain(" WHERE ");
    expect(compiledRows?.sql).toMatch(/ORDER BY t0\."id" ASC LIMIT \$1$/);

    boundary.pack.resources[0]!.principal_key = "id";
    const [principalScoped] = compileExplorePlan(plan, boundary, {
      tenant: "internal-finance",
      principal: "user-7",
    }, "postgres");
    expect(principalScoped?.sql).toContain('t0."id" = $1');
    expect(principalScoped?.params[0]).toBe("user-7");

    delete boundary.organization_scope;
    expect(() => compileExplorePlan(plan, boundary, {
      tenant: "internal-finance",
      principal: "",
    }, "postgres")).toThrow(/has no direct or derived tenant scope/i);
  });

  it("emits no tenant predicate for an exact reviewed shared-reference resource", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources[0]!;
    delete resource.tenant_key;
    delete resource.tenant_scope;
    resource.shared_reference_scope = {
      mode: "shared_reference",
      acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
    };
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: resource.id,
      measures: [{ function: "count" }],
      top_n: 1,
    }, boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, boundary, {
        tenant: "tenant-acme",
        principal: "",
      }, engine);
      expect(compiled?.params).not.toContain("tenant-acme");
      expect(compiled?.sql).not.toContain("tenant_id");
      expect(compiled?.sql).not.toContain(" WHERE ");
    }

    delete resource.shared_reference_scope;
    expect(() => compileExplorePlan(plan, boundary, {
      tenant: "tenant-acme",
      principal: "",
    }, "postgres")).toThrow(/no direct or derived tenant scope.*not reviewed as a shared reference/i);
  });

  it("keeps a mandatory derived principal predicate in a single-organization boundary", async () => {
    const fixture = await activatedFixture();
    const boundary = derivedScopeBoundary(fixture.boundary);
    boundary.organization_scope = {
      mode: "single_organization",
      organization_id: "internal-finance",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
    const orderItems = boundary.pack.resources.find((resource) => resource.id === "public.order_items")!;
    for (const resource of boundary.pack.resources) {
      delete resource.tenant_key;
      delete resource.tenant_scope;
    }
    orders.principal_key = "id";
    const scopeLink = {
      constraint_name: "order_items_order_id_fkey",
      source_resource: "public.order_items",
      target_resource: "public.orders",
      source_columns: ["order_id"],
      target_columns: ["id"],
      target_uniqueness: {
        kind: "primary_key" as const,
        name: "orders_pkey",
        columns: ["id"],
      },
      nullable: false,
      cardinality: "many_to_one" as const,
      max_fan_out: 1 as const,
    };
    orderItems.principal_scope = {
      mode: "derived",
      path_id: "order_items_order_id_fkey",
      ancestor_resource: "public.orders",
      ancestor_column: "id",
      proof: {
        source: "database_catalog",
        links: [scopeLink],
        digest: canonicalJsonDigest([scopeLink]),
      },
    };
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.order_items",
      measures: [{ function: "count" }],
      top_n: 1,
    }, boundary);
    const [compiled] = compileExplorePlan(plan, boundary, {
      tenant: "internal-finance",
      principal: "order-owner-7",
    }, "postgres");
    expect(compiled?.sql).toContain(
      'EXISTS (SELECT 1 FROM "public"."orders" st0_principal_0 WHERE t0."order_id" = st0_principal_0."id" AND st0_principal_0."id" = $1)',
    );
    expect(compiled?.params).toContain("order-owner-7");
    expect(compiled?.params).not.toContain("internal-finance");
  });

  it("keeps a reviewed Runner-only trusted scope value out of model egress and durable evidence", async () => {
    const fixture = await activatedFixture(undefined, churnInspection(), undefined, "runner_only");
    const store = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      store,
      executor: fixedExecutor([{ tenant_id: "tenant-acme" }]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const plan = {
      kind: "rows" as const,
      resource: "public.subscriptions",
      select: ["tenant_id"],
      limit: 1,
    };
    try {
      const result = await runtime.explore(plan);
      expect(result.data).toEqual([{ tenant_id: "tenant-acme" }]);

      const projected = projectScopedExploreResultForModel({
        tool: "app.explore_data",
        arguments: { plan },
        result,
        boundary: fixture.boundary,
      });
      expect(projected.withheld).toBe(true);
      expect(JSON.stringify(projected.value)).not.toContain("tenant-acme");
      expect(projected.value.data).toEqual([{
        tenant_id: expect.stringMatching(/^\[withheld:[a-f0-9]{12}:1\]$/),
      }]);

      const evidenceId = String(result.evidence_bundle_id);
      const persisted = JSON.stringify({
        audit: store.listQueryAudit(),
        evidence: store.getEvidenceBundle(evidenceId),
      });
      expect(persisted).not.toContain("tenant-acme");
      expect(persisted).toContain('"trusted_scope_values_persisted":false');
      expect(persisted).toContain('"result_values_persisted":false');
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("may disclose a human-reviewed trusted scope value without accepting model-selected scope", async () => {
    const fixture = await activatedFixture(undefined, churnInspection(), undefined, "model_visible");
    const store = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      store,
      executor: fixedExecutor([{ tenant_id: "tenant-acme" }]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const plan = {
      kind: "rows" as const,
      resource: "public.subscriptions",
      select: ["tenant_id"],
      limit: 1,
    };
    try {
      const result = await runtime.explore(plan);
      const projected = projectScopedExploreResultForModel({
        tool: "app.explore_data",
        arguments: { plan },
        result,
        boundary: fixture.boundary,
      });
      expect(projected.withheld).toBe(false);
      expect(projected.value.data).toEqual([{ tenant_id: "tenant-acme" }]);
      await expect(runtime.explore({
        ...plan,
        tenant_id: "tenant-other",
      } as never)).rejects.toThrow(/row plan contains unsupported fields: tenant_id/i);

      const persisted = JSON.stringify({
        audit: store.listQueryAudit(),
        evidence: store.getEvidenceBundle(String(result.evidence_bundle_id)),
      });
      expect(persisted).not.toContain("tenant-acme");
      expect(persisted).toContain('"trusted_scope_values_persisted":false');
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("does not restore a suppressed model-withheld group in either rendering", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources.find((item) => item.id === "public.subscriptions");
    if (!resource) throw new Error("fixture resource missing");
    resource.model_withheld_fields = ["region"];
    const plan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    };
    const humanResult = {
      ok: true,
      data: [],
      privacy: {
        minimum_cohort_size: 5,
        suppressed_groups: 1,
        totals_returned: false,
      },
      source_database_changed: false,
    };

    const projected = projectScopedExploreResultForModel({
      tool: "app.explore_data",
      arguments: { plan },
      result: humanResult,
      boundary,
    });

    expect(humanResult.data).toEqual([]);
    expect(projected.value.data).toEqual([]);
    expect(projected.value.privacy).toEqual(humanResult.privacy);
    expect(JSON.stringify(projected.value)).not.toContain("[withheld:");
  });

  it("advertises exactly two local read-only authoring tools through the official MCP client", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [{ region: "west" }],
        executeBatch: async ({ queries }) => queries.map(() => [{ region: "west" }]),
        close: async () => undefined,
      },
    });
    const server = createScopedExploreMcpServer(runtime);
    const client = new Client({ name: "scoped-explore-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["app.describe_data", "app.explore_data"]);
      expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
      expect(listed.tools[0]?.outputSchema?.properties).toMatchObject({
        ok: expect.any(Object),
        error_code: expect.any(Object),
        resources: expect.any(Object),
      });
      expect(listed.tools[1]?.outputSchema?.properties).toMatchObject({
        ok: expect.any(Object),
        error_code: expect.any(Object),
        data: expect.any(Object),
        privacy: expect.any(Object),
        audit: expect.any(Object),
      });
      expect(listed.tools.map((tool) => tool.name).join(" ")).not.toMatch(/execute_sql|approve|apply|commit/i);
      const described = await client.callTool({
        name: "app.describe_data",
        arguments: { resource: "public.subscriptions" },
      });
      if (described.isError) throw new Error(JSON.stringify(described));
      expect(described.isError).not.toBe(true);
      expect(described.structuredContent).toMatchObject({
        ok: true,
        resources: [{
          id: "public.subscriptions",
          kept_out_field_count: expect.any(Number),
          minimum_cohort_size: expect.any(Number),
          valid_plan_example: {
            kind: "aggregate",
            resource: "public.subscriptions",
            measures: [{ function: "count" }],
            dimensions: [{ field: "region" }],
          },
        }],
        raw_sql_available: false,
      });
      const describedWithEmptyOptionalSelectors = await client.callTool({
        name: "app.describe_data",
        arguments: { boundary: "", resource: "", cursor: 0, limit: 10 },
      });
      expect(describedWithEmptyOptionalSelectors.isError).not.toBe(true);
      expect(describedWithEmptyOptionalSelectors.structuredContent).toMatchObject({
        ok: true,
        resources: [{ id: "public.subscriptions" }],
      });
      const describedWithNullOptionalSelectors = await client.callTool({
        name: "app.describe_data",
        arguments: { boundary: null, resource: null, cursor: null, limit: null },
      });
      expect(describedWithNullOptionalSelectors.isError).not.toBe(true);
      expect(describedWithNullOptionalSelectors.structuredContent).toMatchObject({
        ok: true,
        resources: [{ id: "public.subscriptions" }],
      });
      const describedWithZeroDefaultLimit = await client.callTool({
        name: "app.describe_data",
        arguments: { limit: 0 },
      });
      expect(describedWithZeroDefaultLimit.isError).not.toBe(true);
      expect(describedWithZeroDefaultLimit.structuredContent).toMatchObject({
        ok: true,
        resources: [{ id: "public.subscriptions" }],
      });
      const called = await client.callTool({
        name: "app.explore_data",
        arguments: {
          boundary: null,
          plan: {
            kind: "rows",
            resource: "public.subscriptions",
            select: ["region"],
            where: null,
            order_by: null,
            limit: 1,
          },
        },
      });
      expect(called.isError).not.toBe(true);
      expect(JSON.stringify(called)).toContain('"source_database_changed":false');
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it("lets an external MCP client use reviewed Runner-only analytics without receiving raw values", async () => {
    const fixture = await activatedFixture();
    const withheldValue = "billing-token-ignore-all-instructions";
    await rewriteActiveBoundary(fixture.root, (active) => {
      const resource = active.pack.resources.find((item: Record<string, unknown>) =>
        item.id === "public.subscriptions");
      if (!resource) throw new Error("fixture resource missing");
      resource.kept_out_fields = resource.kept_out_fields.filter(
        (field: string) => field !== "billing_token",
      );
      resource.selectable_fields.push("billing_token");
      resource.count_distinct_fields.push("billing_token");
      resource.filterable_fields.billing_token = ["eq"];
      resource.model_withheld_fields = ["billing_token"];
      resource.field_enums.billing_token = ["billing-token-secret", "billing-token-other"];
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map((query) =>
          /COUNT\s*\(\s*DISTINCT/i.test(query.sql)
            ? [{ measure_0: 30, __cohort_size: 30 }]
            : [{ billing_token: withheldValue }]),
        close: async () => undefined,
      },
    });
    const server = createScopedExploreMcpServer(runtime, { mode: "production_http" });
    const client = new Client({ name: "runner-only-external-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const described = await client.callTool({
        name: "app.describe_data",
        arguments: { resource: "public.subscriptions" },
      });
      expect(described.structuredContent).toMatchObject({
        resources: [{
          count_distinct_fields: expect.arrayContaining(["billing_token"]),
          model_withheld_fields: expect.arrayContaining(["billing_token"]),
        }],
      });
      expect((described.structuredContent as any).resources[0].field_enums)
        .not.toHaveProperty("billing_token");
      expect(JSON.stringify(described)).not.toContain("billing-token-secret");
      expect(JSON.stringify(described)).not.toContain("billing-token-other");
      const result = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.subscriptions",
            measures: [{ function: "count_distinct", field: "billing_token" }],
            top_n: 1,
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        data: [{ count_distinct_billing_token: 30 }],
        source_database_changed: false,
      });
      expect(result.structuredContent).not.toHaveProperty("operator_budget");
      expect(JSON.stringify(result)).not.toContain("billing-token-secret");
      expect(result._meta).toMatchObject({
        "synapsor.operator_metadata_withheld": true,
      });
      expect(result._meta).not.toHaveProperty("synapsor.local_full_result");
      expect(result._meta).not.toHaveProperty("synapsor.model_withheld_values");

      const rawValueResult = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.subscriptions",
            select: ["billing_token"],
            limit: 1,
          },
        },
      });
      expect(rawValueResult.isError).not.toBe(true);
      expect(JSON.stringify(rawValueResult)).not.toContain(withheldValue);
      expect(JSON.stringify(rawValueResult)).toMatch(/\[withheld:[a-f0-9]{12}:1\]/);
      expect(rawValueResult._meta).toMatchObject({
        "synapsor.model_withheld_values": true,
        "synapsor.operator_metadata_withheld": true,
      });
      expect(rawValueResult._meta).not.toHaveProperty("synapsor.local_full_result");

      const refused = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.subscriptions",
            measures: [{ function: "count" }],
            where: [{ field: "billing_token", op: "eq", value: "guessed-token" }],
            top_n: 1,
          },
        },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("reviewed values are withheld from the model");
      expect(JSON.stringify(refused)).not.toContain("billing-token-secret");
      expect(JSON.stringify(refused)).not.toContain("billing-token-other");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it("refuses removed schema values, buckets grouped drift, and discloses row allowlist scope", async () => {
    const inspection = churnInspection();
    const region = inspection.tables[0]!.columns.find((field) => field.name === "region")!;
    region.enum_values = ["north", "south"];
    const fixture = await activatedFixture((candidate) => {
      candidate.pack.resources[0]!.field_enums.region = ["north"];
    }, inspection);
    const queries: CompiledExploreQuery[] = [];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async (query) => {
          queries.push(structuredClone(query));
          return [{ dimension_0: "north", measure_0: 8, __cohort_size: 8 }];
        },
        executeBatch: async ({ queries: batch }) => batch.map((query) => {
          queries.push(structuredClone(query));
          const bucketMarker = query.reviewed_value_controls?.find((control) =>
            control.kind === "bucket_unreviewed_values")?.marker;
          return bucketMarker
            ? [
              { dimension_0: "north", measure_0: 8, __cohort_size: 8 },
              { dimension_0: bucketMarker, measure_0: 6, __cohort_size: 6 },
            ]
            : [{ region: "north", measure_0: 8, __cohort_size: 8 }];
        }),
        close: async () => undefined,
      },
    });
    try {
      const described = await runtime.describe({ resource: "public.subscriptions" });
      expect(described).toMatchObject({
        resources: [{ field_enums: { region: ["north"] } }],
      });
      queries.length = 0;
      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        where: [{ field: "region", op: "eq", value: "south" }],
        top_n: 10,
      })).rejects.toMatchObject({
        code: "EXPLORE_PLAN_INVALID",
        message: expect.stringMatching(/south.*not a reviewed value.*north.*No source query was executed/i),
        details: expect.objectContaining({ source_query_executed: false }),
      });
      expect(queries).toHaveLength(0);

      const grouped = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        where: [{ field: "reason_category", op: "eq", value: "free_text_still_allowed" }],
        top_n: 10,
      });
      expect(grouped.data).toEqual(expect.arrayContaining([
        { region: "north", count: 8 },
        { region: "[outside-reviewed-values]", count: 6 },
      ]));
      expect(grouped.privacy).toMatchObject({
        reviewed_value_controls: {
          bucketed_fields: [{
            resource: "public.subscriptions",
            field: "region",
            output_field: "region",
            bucket_returned: true,
            bucket_token: "[outside-reviewed-values]",
          }],
          source_values_exposed: false,
        },
      });
      expect(JSON.stringify(grouped)).not.toContain("south");
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toMatch(/CASE WHEN .*region.* IN \(\$[0-9]+\).* ELSE \$[0-9]+ END AS "dimension_0"/);
      expect(queries[0]!.sql.split(" WHERE ")[1]).not.toMatch(/region" IN/);
      expect(queries[0]!.params).toEqual(expect.arrayContaining([
        "free_text_still_allowed",
        "north",
      ]));

      const mysqlGroupedPlan = validateExplorePlan({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        where: [{ field: "reason_category", op: "eq", value: "free_text_still_allowed" }],
        top_n: 10,
      }, fixture.boundary);
      const [mysqlGroupedQuery] = compileExplorePlan(mysqlGroupedPlan, fixture.boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, "mysql");
      expect(mysqlGroupedQuery?.sql).toMatch(/CASE WHEN .* IN \(\?\).* ELSE \? END AS `dimension_0`/);
      expect(mysqlGroupedQuery?.params[0]).toBe("north");
      expect(mysqlGroupedQuery?.params[1]).toMatch(/^__synapsor_unreviewed_[a-f0-9]+__$/);
      expect(mysqlGroupedQuery?.params.indexOf("tenant-acme")).toBeGreaterThan(1);
      expect(mysqlGroupedQuery?.params.indexOf("free_text_still_allowed")).toBeGreaterThan(1);

      const rows = await runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 10,
      });
      expect(rows).toMatchObject({
        data: [{ region: "north" }],
        privacy: {
          reviewed_value_controls: {
            excluded_fields: [{
              resource: "public.subscriptions",
              field: "region",
              effect: "rows_outside_reviewed_values_excluded",
            }],
          },
        },
      });
      expect(queries.at(-1)!.sql.split(" WHERE ")[1]).toMatch(/region" IN \(\$[0-9]+\)/);

      const countBoundary = structuredClone(fixture.boundary);
      countBoundary.pack.resources[0]!.count_distinct_fields.push("region");
      const distinctPlan = validateExplorePlan({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count_distinct", field: "region" }],
        top_n: 1,
      }, countBoundary);
      const [distinctQuery] = compileExplorePlan(distinctPlan, countBoundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, "postgres");
      expect(distinctQuery?.sql).toContain('COUNT(DISTINCT t0."region")');
      expect(distinctQuery?.sql.split(" WHERE ")[1]).not.toMatch(/region" IN/);

      await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        where: [{ field: "region", op: "neq", value: "north" }],
        top_n: 1,
      });
      expect(queries.at(-1)!.sql).toMatch(/region" <> \$[0-9]+/);
      expect(queries.at(-1)!.sql).toMatch(/region" IN \(\$[0-9]+\)/);
      expect(queries.at(-1)!.params).toEqual(expect.arrayContaining(["north"]));
    } finally {
      await runtime.close();
    }
  });

  it("shows a reviewed cohort override without exposing any model-settable override input", async () => {
    const fixture = await activatedFixture(undefined, churnInspection(), 1);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([]),
    });
    const description = await runtime.describe({ resource: "public.subscriptions" });
    expect(description).toMatchObject({
      resources: [{
        minimum_cohort_size: 1,
        minimum_cohort_overridden: true,
      }],
    });
    const server = createScopedExploreMcpServer(runtime);
    const client = new Client({ name: "cohort-override-surface-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const exploreSchema = JSON.stringify(
        listed.tools.find((tool) => tool.name === "app.explore_data")?.inputSchema,
      );
      expect(exploreSchema).not.toMatch(/minimum_cohort|override|reviewer|reason/i);
      expect(exploreSchema).toContain("comparison_change");
      expect(exploreSchema).not.toContain("max_ranked_groups");
      const refused = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.subscriptions",
            measures: [{ function: "count" }],
            dimensions: [{ field: "region" }],
            top_n: 10,
            minimum_cohort_size: 1,
          },
        },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).not.toMatch(/owner override|how to lower|reviewer|reason/i);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  it("describes cohort-safe date coverage for reviewed time fields without exposing source rows", async () => {
    const fixture = await activatedFixture();
    const queries: CompiledExploreQuery[] = [];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries: batch }) => {
          queries.push(...structuredClone(batch));
          return batch.map(() => [{
            __coverage_start: "2026-06-01T03:00:00.000Z",
            __coverage_end: "2026-06-27T21:00:00.000Z",
            __coverage_cohort: 30,
          }]);
        },
        close: async () => undefined,
      },
    });
    try {
      const described = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{ time_coverage: Record<string, unknown> }>;
      };
      expect(described.resources[0]?.time_coverage).toMatchObject({
        churned_at: {
          status: "available",
          start_date: "2026-06-01",
          end_date: "2026-06-27",
          reporting_timezone: "UTC",
        },
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toMatch(/SELECT MIN\(.+churned_at.+MAX\(.+churned_at.+COUNT\(.+churned_at/is);
      expect(queries[0]?.sql).not.toContain("tenant-acme");
      expect(JSON.stringify(described)).not.toContain("tenant-acme");
    } finally {
      await runtime.close();
    }
  });

  it("keeps startup metadata reads row-free when time coverage is deferred", async () => {
    const fixture = await activatedFixture();
    let databaseExecutions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => {
          databaseExecutions += 1;
          return [];
        },
        executeBatch: async () => {
          databaseExecutions += 1;
          return [];
        },
        close: async () => undefined,
      },
    });
    try {
      const described = await runtime.describe({
        resource: "public.subscriptions",
        include_time_coverage: false,
      }) as { resources: Array<{ time_coverage: Record<string, unknown> }> };
      expect(described.resources[0]?.time_coverage).toEqual({});
      expect(databaseExecutions).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("withholds reviewed time coverage when the field cohort is below its minimum", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([{
        __coverage_start: "2026-06-01T00:00:00Z",
        __coverage_end: "2026-06-02T00:00:00Z",
        __coverage_cohort: 2,
      }]),
    });
    try {
      const described = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{ time_coverage: Record<string, unknown> }>;
      };
      expect(described.resources[0]?.time_coverage).toEqual({
        churned_at: { status: "withheld_below_minimum_cohort" },
      });
      expect(JSON.stringify(described)).not.toContain("2026-06-01");
      expect(JSON.stringify(described)).not.toContain("2026-06-02");
    } finally {
      await runtime.close();
    }
  });

  it("accepts only reviewed row fields and parameterizes untrusted literals behind trusted scope", async () => {
    const { boundary } = await activatedFixture();
    expect(() => validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "billing_token"],
      limit: 10,
    }, boundary)).toThrowError(ScopedExploreError);
    expect(() => validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      where: [{ field: "tenant_id", op: "eq", value: "other-tenant" }],
      limit: 10,
    }, boundary)).toThrow(/trusted bindings/i);
    expect(() => validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      where: [{ field: "region", op: "eq", value: null }],
      limit: 10,
    }, boundary)).toThrow(/Null is not a filter literal.*null_count.*non_null_count.*completion_rate/i);

    const plan = validateExplorePlan({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "reason_category"],
      where: [{ field: "region", op: "eq", value: "west' OR 1=1 --" }],
      order_by: [{ field: "reason_category", direction: "asc" }],
      limit: 10,
    }, boundary);
    const [query] = compileExplorePlan(plan, boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");

    expect(query?.sql).not.toContain("west' OR 1=1");
    expect(query?.sql).not.toContain("tenant-acme");
    expect(query?.sql).toContain("\"tenant_id\" = $1");
    expect(query?.params).toEqual(["tenant-acme", "west' OR 1=1 --", 10]);
  });

  it("renders operator-only PostgreSQL and MySQL statements with placeholders and no parameter values", async () => {
    const { boundary } = await activatedFixture();
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [{ field: "region" }],
      where: [{ field: "reason_category", op: "eq", value: "private-filter-value" }],
      top_n: 10,
    }, boundary);

    const postgres = compileOperatorExploreEvidence({ boundary, engine: "postgres", plan });
    const mysql = compileOperatorExploreEvidence({ boundary, engine: "mysql", plan });
    expect(postgres.statements[0]?.statement).toContain("$1");
    expect(mysql.statements[0]?.statement).toContain("?");
    for (const diagnostic of [postgres, mysql]) {
      expect(diagnostic.model_received_sql).toBe(false);
      expect(diagnostic.persisted).toBe(false);
      expect(diagnostic.statements[0]).toMatchObject({
        parameter_values: "redacted",
        parameter_types: expect.arrayContaining(["string", "integer"]),
      });
      const serialized = JSON.stringify(diagnostic);
      expect(serialized).not.toContain("private-filter-value");
      expect(serialized).not.toContain("tenant-acme");
      expect(serialized).not.toContain("pm-1");
      expect(serialized).not.toContain("<trusted-tenant>");
      expect(serialized).not.toContain("<trusted-principal>");
    }
  });

  it("audits pre-execution refusals without source access, rejected values, or unknown identifiers", async () => {
    const fixture = await activatedFixture();
    const store = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    let executions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      store,
      executor: {
        execute: async () => {
          executions += 1;
          return [];
        },
        executeBatch: async () => {
          executions += 1;
          return [];
        },
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["billing_token"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_FIELD_FORBIDDEN",
        details: {
          reason: "field_operation_not_reviewed",
          resource: "public.subscriptions",
          field: "billing_token",
          operation: "select",
        },
      });
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["model_invented_secret_field"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_FIELD_FORBIDDEN",
      });
      expect(executions).toBe(0);
      expect(store.listEvidenceBundles()).toHaveLength(0);
      const records = store.listQueryAudit();
      expect(records).toHaveLength(2);
      const reviewedAttempt = records.find((record) =>
        (record.payload as Record<string, unknown>).attempted_access
        && ((record.payload as Record<string, unknown>).attempted_access as Record<string, unknown>).field === "billing_token");
      const unknownAttempt = records.find((record) => record !== reviewedAttempt);
      expect(reviewedAttempt).toMatchObject({
        tenant_id: expect.stringMatching(/^keyed:[a-f0-9]{64}$/),
        principal: expect.stringMatching(/^keyed:[a-f0-9]{64}$/),
        capability: "app.explore_data",
        table_name: "public.subscriptions",
      });
      expect(store.listQueryAudit({
        tenants: [String(reviewedAttempt?.tenant_id)],
        principals: [String(reviewedAttempt?.principal)],
        table: "public.subscriptions",
        outcome: "refused",
        boundary: fixture.boundary.activation.digest,
      })).toHaveLength(2);
      expect(reviewedAttempt?.payload).toMatchObject({
        status: "refused_before_source_execution",
        refusal_stage: "validation",
        error_code: "EXPLORE_FIELD_FORBIDDEN",
        attempted_access: {
          resource: "public.subscriptions",
          field: "billing_token",
          operation: "select",
        },
        scope_application: {
          tenant: { kind: "direct", predicate_applied: false, column: "tenant_id" },
          principal: { kind: "not_configured", predicate_applied: false },
        },
        source_execution_started: false,
        evidence_bundle_created: false,
        result_values_persisted: false,
        source_database_changed: false,
      });
      expect(unknownAttempt).toMatchObject({
        table_name: "public.subscriptions",
        payload: {
          attempted_access: {
            resource: "public.subscriptions",
            operation: "select",
          },
        },
      });
      const persisted = JSON.stringify(records);
      expect(persisted).toContain("billing_token");
      expect(persisted).not.toContain("model_invented_secret_field");
      expect(persisted).not.toContain("tenant-acme");
      expect(persisted).not.toContain("pm-1");
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("compiles bounded PM aggregates without raw SQL or unreviewed dimensions", async () => {
    const { boundary } = await activatedFixture();
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "billing_token" }],
      top_n: 10,
    }, boundary)).toThrow(/not reviewed for group/i);

    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "monthly_revenue_cents" }],
      top_n: 10,
    }, boundary)).toThrow(
      /review exact groups.*--allow-exact-grouping monthly_revenue_cents/is,
    );

    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count_distinct", field: "region" }],
      top_n: 1,
    }, boundary)).toThrow(
      /Count unique.*G Reviewed metrics.*boundary review resource public\.subscriptions --count-distinct-fields region/is,
    );

    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [
        { function: "count" },
        { function: "sum", field: "monthly_revenue_cents" },
      ],
      dimensions: [
        { field: "region" },
        { field: "reason_category" },
      ],
      time_bucket: { field: "churned_at", bucket: "week" },
      where: [{ field: "reason_category", op: "in", value: ["price", "service"] }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
      comparison: {
        field: "churned_at",
        ranges: [
          { start: "2026-05-01T00:00:00.000Z", end: "2026-06-01T00:00:00.000Z" },
          { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
        ],
      },
    }, boundary);
    const queries = compileExplorePlan(plan, boundary, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres");

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain("COUNT(*) AS \"measure_0\"");
      expect(query.sql).toContain("SUM(t0.\"monthly_revenue_cents\") AS \"measure_1\"");
      expect(query.sql).not.toContain("date_trunc(");
      expect(query.reporting_timezone).toBe("UTC");
      expect(query.sql).toContain("COUNT(*) AS \"__cohort_size\"");
      expect(query.sql).not.toContain("price");
      expect(query.sql).not.toContain("tenant-acme");
      expect(query.params.at(-1)).toBe(boundary.budgets.max_ranked_groups! + 1);
    }
  });

  it("uses a separate reviewed group ceiling for ranked aggregates without exposing it as a plan input", async () => {
    const { boundary } = await activatedFixture();
    expect(boundary.budgets).toMatchObject({
      max_groups: 50,
      max_ranked_groups: 500,
      max_top_n: 25,
    });
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
      max_ranked_groups: 5_000,
    }, boundary)).toThrow(/unsupported fields: max_ranked_groups/i);

    const ranked = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    }, boundary);
    const ordinary = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    }, boundary);
    for (const engine of ["postgres", "mysql"] as const) {
      const rankedQuery = compileExplorePlan(ranked, boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine)[0]!;
      const ordinaryQuery = compileExplorePlan(ordinary, boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine)[0]!;
      expect(rankedQuery.params.at(-1)).toBe(501);
      expect(ordinaryQuery.params.at(-1)).toBe(51);
    }

    const legacy = structuredClone(boundary);
    delete legacy.budgets.max_ranked_groups;
    const digestBefore = canonicalJsonDigest(legacy);
    const legacyQuery = compileExplorePlan(ranked, legacy, {
      tenant: "tenant-acme",
      principal: "pm-1",
    }, "postgres")[0]!;
    expect(legacyQuery.params.at(-1)).toBe(legacy.budgets.max_groups + 1);
    expect(canonicalJsonDigest(legacy)).toBe(digestBefore);
  });

  it("suppresses before ranking and returns top-N from a larger reviewed candidate set", async () => {
    const fixture = await activatedFixture();
    const rows = [
      { dimension_0: "withheld-winner", measure_0: 10_000, __cohort_size: 2 },
      ...Array.from({ length: 75 }, (_, index) => ({
        dimension_0: `region-${String(index).padStart(3, "0")}`,
        measure_0: 1_000 - index,
        __cohort_size: 10,
      })),
    ];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor(rows),
    });
    try {
      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        order_by: { kind: "measure", index: 0, direction: "desc" },
        top_n: 3,
      });
      expect(result.data).toEqual([
        { region: "region-000", count: 1_000 },
        { region: "region-001", count: 999 },
        { region: "region-002", count: 998 },
      ]);
      expect(result.privacy).toMatchObject({
        minimum_cohort_size: 5,
        suppressed_groups: 1,
      });
      expect(JSON.stringify(result)).not.toContain("withheld-winner");

      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        top_n: 3,
      })).rejects.toMatchObject({ code: "EXPLORE_RESPONSE_TOO_LARGE" });
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when a ranked aggregate exceeds its reviewed underlying group ceiling", async () => {
    const fixture = await activatedFixture();
    const rows = Array.from({ length: 501 }, (_, index) => ({
      dimension_0: `region-${index}`,
      measure_0: 501 - index,
      __cohort_size: 10,
    }));
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor(rows),
    });
    try {
      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        order_by: { kind: "measure", index: 0, direction: "desc" },
        top_n: 25,
      })).rejects.toMatchObject({
        code: "EXPLORE_RESPONSE_TOO_LARGE",
        message: expect.stringContaining("separately reviewed execution boundary"),
      });
    } finally {
      await runtime.close();
    }
  });

  it("ranks reviewed two-period movers by percentage or absolute change after suppression", async () => {
    const fixture = await activatedFixture();
    const periodRows: Record<"period_1" | "period_2", Array<Record<string, unknown>>> = {
      period_1: [
        { dimension_0: "steady-growth", measure_0: 100, __measure_cohort_0: 100, __cohort_size: 100 },
        { dimension_0: "fast-growth", measure_0: 10, __measure_cohort_0: 10, __cohort_size: 10 },
        { dimension_0: "decline", measure_0: 100, __measure_cohort_0: 100, __cohort_size: 100 },
        { dimension_0: "new", measure_0: 0, __measure_cohort_0: 10, __cohort_size: 10 },
        { dimension_0: "private", measure_0: 1, __measure_cohort_0: 1, __cohort_size: 1 },
      ],
      period_2: [
        { dimension_0: "steady-growth", measure_0: 120, __measure_cohort_0: 120, __cohort_size: 120 },
        { dimension_0: "fast-growth", measure_0: 20, __measure_cohort_0: 20, __cohort_size: 20 },
        { dimension_0: "decline", measure_0: 50, __measure_cohort_0: 50, __cohort_size: 50 },
        { dimension_0: "new", measure_0: 5, __measure_cohort_0: 10, __cohort_size: 10 },
        { dimension_0: "private", measure_0: 1_000, __measure_cohort_0: 1, __cohort_size: 1 },
      ],
    };
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map((query) =>
          structuredClone(periodRows[query.period as keyof typeof periodRows])),
        close: async () => undefined,
      },
    });
    const base = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [{ field: "region" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      top_n: 4,
      comparison: {
        field: "churned_at",
        ranges: [
          { start: "2026-07-06T00:00:00.000Z", end: "2026-07-13T00:00:00.000Z" },
          { start: "2026-07-13T00:00:00.000Z", end: "2026-07-20T00:00:00.000Z" },
        ],
      },
    } as const;
    try {
      const percentage = await runtime.explore({
        ...base,
        order_by: { kind: "comparison_change", index: 0, change: "percentage", direction: "desc" },
      });
      const percentageRows = percentage.data as Array<Record<string, unknown>>;
      expect(percentageRows.map((row) => row.region)).toEqual([
        "fast-growth",
        "steady-growth",
        "decline",
        "new",
      ]);
      expect(percentageRows[0]).toMatchObject({
        sum_monthly_revenue_cents_absolute_change: 10,
        sum_monthly_revenue_cents_percentage_change: 100,
      });
      expect(percentageRows[3]).toMatchObject({
        sum_monthly_revenue_cents_percentage_change: null,
      });
      expect(percentage.privacy).toMatchObject({ suppressed_groups: 2 });
      expect(JSON.stringify(percentage)).not.toContain("private");

      const absolute = await runtime.explore({
        ...base,
        top_n: 2,
        order_by: { kind: "comparison_change", index: 0, change: "absolute", direction: "asc" },
      });
      expect((absolute.data as Array<Record<string, unknown>>).map((row) => row.region)).toEqual([
        "decline",
        "new",
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("compares two reviewed periods in one snapshot with deterministic deltas and suppression", async () => {
    const fixture = await activatedFixture();
    const batchSizes: number[] = [];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => {
          batchSizes.push(queries.length);
          return queries.map((query) => query.period === "period_1"
            ? [
              { dimension_0: "north", measure_0: 10, __cohort_size: 10 },
              { dimension_0: "south", measure_0: 2, __cohort_size: 2 },
            ]
            : [
              { dimension_0: "north", measure_0: 15, __cohort_size: 15 },
              { dimension_0: "south", measure_0: 8, __cohort_size: 8 },
            ]);
        },
        close: async () => undefined,
      },
      clock: () => Date.parse("2026-07-26T18:30:00.000Z"),
    });
    try {
      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        time_bucket: { field: "churned_at", bucket: "week" },
        order_by: { kind: "measure", index: 0, direction: "desc" },
        top_n: 10,
        comparison: {
          field: "churned_at",
          ranges: [
            { start: "2026-07-06T00:00:00.000Z", end: "2026-07-13T00:00:00.000Z" },
            { start: "2026-07-13T00:00:00.000Z", end: "2026-07-20T00:00:00.000Z" },
          ],
        },
      });
      expect(batchSizes).toEqual([2]);
      expect(result.data).toEqual([{
        region: "north",
        count_period_1: 10,
        count_period_2: 15,
        count_absolute_change: 5,
        count_percentage_change: 50,
      }]);
      expect(result.outcome).toMatchObject({
        type: "success",
        status: "ok",
        result: {
          grain: {
            kind: "period_comparison",
            reviewed_time_bucket: "week",
          },
          reporting_timezone: {
            name: "UTC",
            authority_bound: true,
          },
          freshness: {
            snapshot_consistency: "single_read_only_transaction",
            upstream_source_freshness: "not_asserted",
          },
          suppression: {
            suppressed_groups: 1,
            incomplete_comparison_groups: 1,
          },
          source_database_changed: false,
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it("resolves relative rows once, compiles the same bounded UTC predicates on both engines, and freezes Protect", async () => {
    const fixture = await activatedFixture();
    const now = Date.parse("2026-08-10T15:30:45.123Z");
    const request = {
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      time_window: { field: "churned_at", window: "previous_month" },
      limit: 5,
    };
    const validated = validateExploreRequest(request, fixture.boundary, { now });
    expect(validated.plan).toMatchObject({
      time_window: {
        field: "churned_at",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(validated.resolved_time_windows).toEqual([expect.objectContaining({
      location: "time_window",
      window: "previous_month",
      reporting_timezone: "UTC",
      resolved_at: "2026-08-10T15:30:45.123Z",
    })]);
    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(
        validated.plan,
        fixture.boundary,
        { tenant: "tenant-acme", principal: "pm-1" },
        engine,
      );
      expect(query?.sql).toContain(engine === "postgres"
        ? 't0."churned_at" >= $2'
        : "t0.`churned_at` >= ?");
      expect(query?.sql).toContain(engine === "postgres"
        ? 't0."churned_at" < $3'
        : "t0.`churned_at` < ?");
      expect(query?.params).toContain("2026-07-01T00:00:00.000Z");
      expect(query?.params).toContain("2026-08-01T00:00:00.000Z");
    }

    const store = new ProposalStore(path.join(fixture.root, ".synapsor/relative-time.db"));
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      store,
      clock: () => now,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: fixedExecutor([{ region: "west" }]),
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as any;
      expect(description.relative_time_windows).toMatchObject({
        available: true,
        reporting_timezone: "UTC",
        windows: expect.arrayContaining(["previous_month", "month_to_date"]),
        comparison_partners: ["preceding_period", "same_period_last_year"],
        range_semantics: "half-open [start, end)",
        week_starts_on: "Monday",
        model_supplied_date_arithmetic: false,
      });
      expect(description.resources[0]?.relative_time_window_fields).toEqual(["churned_at"]);
      const compactProjection = projectDescribeDataForModel(await runtime.describe(), false);
      expect(compactProjection).not.toHaveProperty("relative_time_windows");
      const focusedProjection = projectDescribeDataForModel(description, true);
      expect(focusedProjection).toHaveProperty("relative_time_windows.windows");

      const relative = await runtime.explore(request);
      const absolute = await runtime.explore({
        ...request,
        time_window: {
          field: "churned_at",
          start: "2026-07-01T00:00:00Z",
          end: "2026-08-01T00:00:00Z",
        },
      });
      expect(relative.audit).toMatchObject({ query_fingerprint: (absolute.audit as any).query_fingerprint });
      expect(relative.operator_time_windows).toEqual(validated.resolved_time_windows);
      expect(absolute).not.toHaveProperty("operator_time_windows");
      const projected = projectScopedExploreResultForModel({
        tool: "app.explore_data",
        arguments: { plan: request },
        result: relative,
        boundary: fixture.boundary,
      });
      expect(projected.value).not.toHaveProperty("operator_time_windows");
      expect(projected.operator_metadata_withheld).toBe(true);

      const token = (relative.protect as { token: string }).token;
      const protectedPlan = await loadProtectedPlan({ projectRoot: fixture.root, token, now });
      expect(protectedPlan.plan).toMatchObject(validated.plan);
      expect(JSON.stringify(protectedPlan.plan)).not.toContain("previous_month");
      const evidence = JSON.stringify(store.listEvidenceBundles());
      expect(evidence).toContain("previous_month");
      expect(evidence).toContain("2026-07-01T00:00:00.000Z");
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("lowers relative comparisons before fingerprinting and withholds resolved timestamps from the model", async () => {
    const fixture = await activatedFixture();
    const now = Date.parse("2026-08-10T15:30:45.123Z");
    const request = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      time_bucket: { field: "churned_at", bucket: "month" },
      comparison: {
        field: "churned_at",
        window: "previous_month",
        compare_to: "preceding_period",
      },
      top_n: 10,
    };
    const validated = validateExploreRequest(request, fixture.boundary, { now });
    expect(validated.plan).toMatchObject({
      comparison: {
        ranges: [
          { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
          { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
        ],
      },
    });
    expect(compileExplorePlan(
      validated.plan,
      fixture.boundary,
      { tenant: "tenant-acme", principal: "pm-1" },
      "postgres",
    )).toHaveLength(2);

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      clock: () => now,
      inspectDatabaseFn: async () => fixture.inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map((query) => [{
          dimension_0: "west",
          measure_0: query.period === "period_1" ? 10 : 12,
          __cohort_size: 10,
        }]),
        close: async () => undefined,
      },
    });
    try {
      const result = await runtime.explore(request);
      expect(result.operator_time_windows).toEqual([expect.objectContaining({
        location: "comparison",
        window: "previous_month",
        compare_to: "preceding_period",
      })]);
      const projected = projectScopedExploreResultForModel({
        tool: "app.explore_data",
        arguments: { plan: request },
        result,
        boundary: fixture.boundary,
      });
      expect(JSON.stringify(projected.value)).not.toContain("2026-06-01T00:00:00.000Z");
      expect(projected.value).not.toHaveProperty("operator_time_windows");
      expect(projected.value).toMatchObject({
        outcome: {
          result: {
            grain: {
              kind: "period_comparison",
              relative_window: [{
                window: "previous_month",
                compare_to: "preceding_period",
                resolved_timestamps_withheld_from_model: true,
              }],
            },
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it("refuses relative-time authority and shape errors before source execution", async () => {
    const fixture = await activatedFixture();
    const base = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      top_n: 10,
    };
    expect(() => validateExplorePlan({
      ...base,
      time_window: { field: "churned_at", window: "last_decade" },
    }, fixture.boundary)).toThrow(/must be one of today/i);
    expect(() => validateExplorePlan({
      ...base,
      time_window: { field: "region", window: "previous_month" },
    }, fixture.boundary)).toThrow(/not reviewed for time window/i);
    expect(() => validateExplorePlan({
      ...base,
      time_window: { field: "churned_at", window: "previous_month", offset: "-1 month" },
    }, fixture.boundary)).toThrow(/unsupported fields: offset/i);
    expect(() => validateExplorePlan({
      ...base,
      time_window: { field: "churned_at", window: "previous_month" },
      time_bucket: { field: "churned_at", bucket: "month" },
      comparison: {
        field: "churned_at",
        window: "previous_month",
        compare_to: "preceding_period",
      },
    }, fixture.boundary)).toThrow(/mutually exclusive/i);
    const legacy = structuredClone(fixture.boundary) as any;
    delete legacy.reporting_timezone;
    expect(() => validateExplorePlan({
      ...base,
      time_window: { field: "churned_at", window: "previous_month" },
    }, legacy)).toThrow(/authority-bound UTC/i);
  });

  it("describes only activated one-hop relationship fields for the guided PM composer", async () => {
    const fixture = await activatedFixture(undefined, relationshipInspection());
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{
          relationships: Array<Record<string, any>>;
          suggested_questions: Array<Record<string, any>>;
        }>;
      };
      const resource = description.resources[0]!;
      expect(resource.relationships).toEqual([
        expect.objectContaining({
          id: "subscriptions_region_id_fkey",
          target_resource: "public.regions",
          cardinality: "many_to_one",
          groupable_fields: expect.arrayContaining(["name"]),
          fields: expect.arrayContaining([expect.objectContaining({
            id: "name",
            plan_reference: "exact_id_only",
            semantic_status: "descriptive_identifier",
            operations: expect.objectContaining({
              return_value: false,
              sortable: false,
              groupable: true,
            }),
          })]),
        }),
      ]);
      expect(resource).not.toHaveProperty("label");
      expect(resource).not.toHaveProperty("field_labels");
      expect(resource.relationships[0]).not.toHaveProperty("label");
      expect(resource.relationships[0]).not.toHaveProperty("field_labels");
      expect(resource.suggested_questions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: "Which reviewed regions have the most subscriptions?",
          dimension: {
            field: "name",
            relationship: "subscriptions_region_id_fkey",
          },
        }),
      ]));
      for (const question of resource.suggested_questions.filter((item) =>
        item.relationship_review_required !== true)) {
        expect(validateExplorePlan(
          suggestedQuestionPlan("public.subscriptions", question),
          fixture.boundary,
        )).toMatchObject({
          kind: "aggregate",
          resource: "public.subscriptions",
        });
      }
      expect(JSON.stringify(resource)).not.toMatch(/billing_token|sql/i);
    } finally {
      await runtime.close();
    }
  });

  it("returns an exact reviewed relationship correction when a grouping field is not local", async () => {
    const fixture = await activatedFixture(undefined, relationshipInspection());
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "name" }],
      top_n: 10,
    }, fixture.boundary)).toThrowError(expect.objectContaining({
      code: "EXPLORE_RELATIONSHIP_FORBIDDEN",
      message: expect.stringContaining(
        'Retry with dimension {"field":"name","relationship":"subscriptions_region_id_fkey"}',
      ),
      details: expect.objectContaining({
        reason: "relationship_required_for_field",
        resource: "public.subscriptions",
        field: "name",
        operation: "group",
        corrected_dimensions: [{
          field: "name",
          relationship: "subscriptions_region_id_fkey",
        }],
        source_query_executed: false,
      }),
    }));
  });

  it("lists competing reviewed relationships instead of guessing a grouping path", async () => {
    const fixture = await activatedFixture(undefined, relationshipInspection());
    const boundary = structuredClone(fixture.boundary);
    const resource = boundary.pack.resources.find((candidate) =>
      candidate.id === "public.subscriptions")!;
    resource.relationships.push({
      ...structuredClone(resource.relationships[0]!),
      id: "subscriptions_backup_region_id_fkey",
    });

    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "name" }],
      top_n: 10,
    }, boundary)).toThrowError(expect.objectContaining({
      code: "EXPLORE_RELATIONSHIP_FORBIDDEN",
      message: expect.stringMatching(/more than one relationship.*will not guess/i),
      details: expect.objectContaining({
        reason: "relationship_required_for_field",
        corrected_dimensions: [
          {
            field: "name",
            relationship: "subscriptions_backup_region_id_fkey",
          },
          {
            field: "name",
            relationship: "subscriptions_region_id_fkey",
          },
        ],
        source_query_executed: false,
      }),
    }));
  });

  it("describes reviewed metadata without exposing kept-out metadata or accepting labels as authority", async () => {
    const reviewedAt = "2026-08-10T12:00:00.000Z";
    const metadata = {
      resource: {
        label: "Customer subscriptions",
        description: "One reviewed subscription record per customer account.",
        actor: "analytics-owner@example.test",
        reason: "Give people and AI clients business context without changing authority.",
        decided_at: reviewedAt,
      },
      fields: {
        region: {
          label: "Sales region",
          description: "Reviewed account territory used for regional grouping.",
          actor: "analytics-owner@example.test",
          reason: "Clarify an existing reviewed dimension.",
          decided_at: reviewedAt,
        },
        billing_token: {
          label: "Internal billing credential",
          description: "Kept out of every model-facing response.",
          actor: "analytics-owner@example.test",
          reason: "Help the human reviewer identify a field that remains kept out.",
          decided_at: reviewedAt,
        },
      },
    } satisfies {
      resource: ReviewedMetadataDecision;
      fields: Record<string, ReviewedMetadataDecision>;
    };
    const fixture = await activatedFixture(
      undefined,
      churnInspection(),
      undefined,
      undefined,
      metadata,
    );
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as any;
      const resource = description.resources[0];
      expect(resource).toMatchObject({
        id: "public.subscriptions",
        label: "Customer subscriptions",
        description: "One reviewed subscription record per customer account.",
      });
      expect(resource.fields).toContainEqual(expect.objectContaining({
        id: "region",
        label: "Sales region",
        description: "Reviewed account territory used for regional grouping.",
        plan_reference: "exact_id_only",
        semantic_status: "reviewed_vocabulary",
        operations: expect.objectContaining({
          return_value: true,
          groupable: true,
        }),
      }));
      expect(resource).toMatchObject({
        vocabulary: expect.objectContaining({ status: "ready" }),
      });
      expect(description.vocabulary_policy).toEqual({
        reviewed_metadata_is_semantic_only: true,
        exact_ids_required_in_plans: true,
        opaque_identifier_behavior: "do_not_guess; ask the operator to add a reviewed label or description",
        coded_value_behavior: "do_not_infer_business_meaning_from_codes; use exact codes only when the question names them or reviewed metadata explains them",
      });
      expect(JSON.stringify(resource.fields)).not.toMatch(/billing_token|Internal billing credential|Kept out/i);
      expect(resource.suggested_questions.map((question: { text: string }) => question.text).join("\n"))
        .toMatch(/sales regions|customer subscriptions/i);

      const projected = projectDescribeDataForModel(description, false) as any;
      expect(projected.resources[0]).toMatchObject({
        id: "public.subscriptions",
        label: "Customer subscriptions",
        description: "One reviewed subscription record per customer account.",
        fields: expect.arrayContaining([expect.objectContaining({
          id: "region",
          label: "Sales region",
          description: "Reviewed account territory used for regional grouping.",
          plan_reference: "exact_id_only",
          semantic_status: "reviewed_vocabulary",
        })]),
      });
      expect(projected.resources[0].fields[0]).not.toHaveProperty("operations");
      expect(projected.resources[0].fields[0]).not.toHaveProperty("allowed_values");
      expect(projected.next_action).toMatch(/final catalog page/i);
      const pagedProjection = projectDescribeDataForModel({
        ...description,
        next_cursor: 8,
      }, false) as any;
      expect(pagedProjection.next_action).toMatch(/cursor 8.*before concluding.*unavailable/i);
      const focusedProjection = projectDescribeDataForModel(description, true) as any;
      expect(focusedProjection.resources[0].fields).toContainEqual(expect.objectContaining({
        id: "region",
        operations: expect.objectContaining({ groupable: true }),
      }));
      expect(JSON.stringify(projected.resources[0].fields))
        .not.toMatch(/billing_token|Internal billing credential|Kept out/i);

      expect(() => validateExplorePlan({
        kind: "aggregate",
        resource: "Customer subscriptions",
        measures: [{ function: "count" }],
        top_n: 10,
      }, fixture.boundary)).toThrow(/not in|not reviewed|outside/i);
      expect(validateExplorePlan({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        top_n: 10,
      }, fixture.boundary)).toMatchObject({ resource: "public.subscriptions" });
    } finally {
      await runtime.close();
    }
  });

  it("advertises coded enum semantics without blocking local or production Explore", async () => {
    const inspection = churnInspection();
    const table = inspection.tables[0]!;
    table.columns.push({
      ...column("ph_code", "text"),
      enum_values: ["P1", "P2", "P3"],
    });
    table.suggestions.default_visible_columns.push("ph_code");
    const fixture = await activatedFixture((candidate) => {
      const resource = candidate.pack.resources[0]!;
      resource.groupable_fields = ["ph_code"];
    }, inspection);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const operatorDescription = await runtime.describe({ resource: "public.subscriptions" }) as any;
      expect(JSON.stringify(operatorDescription.resources[0].suggested_questions))
        .not.toMatch(/ph code|P1|P2|P3/i);
      for (const mode of ["local_authoring", "production_http"] as const) {
        const server = createScopedExploreMcpServer(runtime, { mode });
        const client = new Client({ name: `coded-vocabulary-${mode}`, version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const described = await client.callTool({
            name: "app.describe_data",
            arguments: { resource: "public.subscriptions" },
          });
          expect(described.isError).not.toBe(true);
          expect(described.structuredContent).toMatchObject({
            vocabulary_policy: {
              coded_value_behavior: expect.stringContaining("do_not_infer_business_meaning"),
            },
            resources: [{
              vocabulary: {
                status: "review_advised",
                coded_fields_without_vocabulary: ["ph_code"],
              },
              fields: expect.arrayContaining([expect.objectContaining({
                id: "ph_code",
                semantic_status: "coded_values",
                allowed_values: ["P1", "P2", "P3"],
              })]),
              valid_plan_example: expect.not.objectContaining({ dimensions: expect.anything() }),
            }],
          });
        } finally {
          await client.close();
          await server.close();
        }
      }
    } finally {
      await runtime.close();
    }
  });

  it("requires reviewed vocabulary before activating clearly opaque model-facing identifiers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-opaque-vocabulary-"));
    temporaryRoots.push(root);
    const inspection = churnInspection();
    const table = inspection.tables[0]!;
    table.name = "t_0031";
    table.columns = [
      column("id", "uuid", { immutable: true }),
      column("tenant_id", "uuid", { tenant: true, immutable: true }),
      column("val_1", "integer"),
    ];
    table.suggestions.default_visible_columns = ["id", "tenant_id", "val_1"];
    table.suggestions.sensitive_columns = [];
    const project = {
      root,
      package_manager: "pnpm" as const,
      frameworks: [],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const unlabelledBuild = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
    });
    await writeAutoBoundaryArtifacts({ projectRoot: root, build: unlabelledBuild });
    const unlabelled = unlabelledBuild.exploration_boundary;
    const unlabelledDigest = explorationBoundaryCandidateDigest(unlabelled);
    await expect(activateExplorationBoundary({
      projectRoot: root,
      candidate: unlabelled,
      expectedDigest: unlabelledDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${unlabelledDigest}`,
      confirmedDecisions: unlabelled.unresolved_decisions,
      currentInspection: inspection,
    })).rejects.toThrow(/reviewed vocabulary.*public\.t_0031/is);

    const decision = (value: string): ReviewedMetadataDecision => ({
      label: value,
      actor: "reviewer@example.test",
      reason: "Give this legacy identifier reviewed business meaning.",
      decided_at: "2026-08-17T12:00:00.000Z",
    });
    const labelledBuild = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.t_0031": {
            metadata: decision("Transit routes"),
            field_metadata: { val_1: decision("Service class") },
          },
        },
      },
    });
    await writeAutoBoundaryArtifacts({ projectRoot: root, build: labelledBuild, force: true });
    const labelled = labelledBuild.exploration_boundary;
    const labelledDigest = explorationBoundaryCandidateDigest(labelled);
    await expect(activateExplorationBoundary({
      projectRoot: root,
      candidate: labelled,
      expectedDigest: labelledDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${labelledDigest}`,
      confirmedDecisions: labelled.unresolved_decisions,
      currentInspection: inspection,
    })).resolves.toMatchObject({ activation: { state: "active" } });
  });

  it("does not suggest summing numeric identifiers when forming model-facing questions", async () => {
    const inspection = churnInspection();
    inspection.tables[0]!.columns.find((field) => field.name === "id")!.data_type = "integer";
    const fixture = await activatedFixture(undefined, inspection);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{ suggested_questions: Array<Record<string, any>> }>;
      };
      const questions = description.resources[0]!.suggested_questions;
      expect(questions).not.toContainEqual(expect.objectContaining({
        measure: { function: "sum", field: "id" },
      }));
      expect(questions).toContainEqual(expect.objectContaining({
        text: "How did total monthly revenue change by week across region?",
        measure: { function: "sum", field: "monthly_revenue_cents" },
      }));
    } finally {
      await runtime.close();
    }
  });

  it("suggests an explicit record-count trend when identifiers are the only numeric measures", async () => {
    const inspection = churnInspection();
    inspection.tables[0]!.columns.find((field) => field.name === "id")!.data_type = "integer";
    inspection.tables[0]!.columns.find((field) => field.name === "monthly_revenue_cents")!.data_type = "text";
    const fixture = await activatedFixture(undefined, inspection);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{ suggested_questions: Array<Record<string, any>> }>;
      };
      expect(description.resources[0]!.suggested_questions).toContainEqual(expect.objectContaining({
        text: "How did the number of subscriptions change by week across region?",
        measure: { function: "count" },
      }));
      expect(JSON.stringify(description.resources[0]!.suggested_questions)).not.toMatch(/total (?:id|subscription id)/i);
    } finally {
      await runtime.close();
    }
  });

  it("compiles reviewed star dimensions with independent trusted scope on every relation", async () => {
    const { boundary } = await activatedFixture(undefined, starRelationshipInspection());
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [
        { field: "name", relationship: "subscriptions_region_id_fkey" },
        { field: "name", relationship: "subscriptions_segment_id_fkey" },
        { field: "name", relationship: "subscriptions_plan_id_fkey" },
      ],
      top_n: 10,
    }, boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, engine);
      expect(query?.resources.map((resource) => resource.id).sort()).toEqual([
        "public.plans",
        "public.regions",
        "public.segments",
        "public.subscriptions",
      ]);
      expect(query?.params).toEqual([
        "tenant-acme",
        "pm-1",
        "tenant-acme",
        "pm-1",
        "tenant-acme",
        "pm-1",
        "tenant-acme",
        "pm-1",
        boundary.budgets.max_groups + 1,
      ]);
      expect(query?.sql).toContain(engine === "postgres"
        ? "JOIN \"public\".\"regions\" t1"
        : "JOIN `public`.`regions` t1");
      expect(query?.sql).toContain(engine === "postgres"
        ? "JOIN \"public\".\"segments\" t2"
        : "JOIN `public`.`segments` t2");
      expect(query?.sql).toContain(engine === "postgres"
        ? "JOIN \"public\".\"plans\" t3"
        : "JOIN `public`.`plans` t3");
      expect(query?.sql).toContain("COUNT(*)");
      expect(query?.sql).not.toMatch(/CROSS JOIN|SELECT\s+\*/i);
    }
  });

  it("allows proven relationship analysis without fake tenant scope only in single-organization mode", async () => {
    const { boundary: activated } = await activatedFixture(undefined, relationshipInspection());
    const relationshipPlan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "name", relationship: "subscriptions_region_id_fkey" }],
      top_n: 10,
    };

    const multiTenant = structuredClone(activated);
    const unscopedTarget = multiTenant.pack.resources.find((resource) =>
      resource.id === "public.regions")!;
    delete unscopedTarget.tenant_key;
    delete unscopedTarget.tenant_scope;
    expect(() => validateExplorePlan(relationshipPlan, multiTenant)).toThrowError(
      expect.objectContaining({
        code: "EXPLORE_RELATIONSHIP_FORBIDDEN",
        message: expect.stringMatching(/public\.regions has no independently reviewed tenant scope/i),
      }),
    );

    const singleOrganization = structuredClone(activated);
    singleOrganization.organization_scope = {
      mode: "single_organization",
      organization_id: "internal-finance",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    for (const resource of singleOrganization.pack.resources) {
      delete resource.tenant_key;
      delete resource.tenant_scope;
    }
    const validated = validateExplorePlan(relationshipPlan, singleOrganization);
    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(validated, singleOrganization, {
        tenant: "internal-finance",
        principal: "",
      }, engine);
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 'JOIN "public"."regions" t1'
        : "JOIN `public`.`regions` t1");
      expect(compiled?.sql).not.toContain("tenant_id");
      expect(compiled?.params).not.toContain("internal-finance");
      expect(compiled?.resources.map((resource) => resource.id).sort()).toEqual([
        "public.regions",
        "public.subscriptions",
      ]);
    }
  });

  it("allows a tenant-scoped resource to join an explicitly reviewed shared reference", async () => {
    const { boundary } = await activatedFixture(undefined, relationshipInspection());
    const shared = structuredClone(boundary);
    const target = shared.pack.resources.find((resource) => resource.id === "public.regions")!;
    delete target.tenant_key;
    delete target.tenant_scope;
    target.shared_reference_scope = {
      mode: "shared_reference",
      acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
    };
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "name", relationship: "subscriptions_region_id_fkey" }],
      top_n: 10,
    }, shared);
    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, shared, {
        tenant: "tenant-acme",
        principal: "",
      }, engine);
      expect(compiled?.params).toContain("tenant-acme");
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 't0."tenant_id" = $1'
        : "t0.`tenant_id` = ?");
      expect(compiled?.sql).not.toContain(engine === "postgres"
        ? 't1."tenant_id"'
        : "t1.`tenant_id`");
    }
  });

  it("keeps the target tenant predicate when a shared-reference root joins scoped rows", async () => {
    const { boundary } = await activatedFixture(undefined, relationshipInspection());
    const sharedRoot = structuredClone(boundary);
    const root = sharedRoot.pack.resources.find((resource) =>
      resource.id === "public.subscriptions")!;
    delete root.tenant_key;
    delete root.tenant_scope;
    root.shared_reference_scope = {
      mode: "shared_reference",
      acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
    };
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "name", relationship: "subscriptions_region_id_fkey" }],
      top_n: 10,
    }, sharedRoot);
    for (const engine of ["postgres", "mysql"] as const) {
      const [compiled] = compileExplorePlan(plan, sharedRoot, {
        tenant: "tenant-acme",
        principal: "",
      }, engine);
      expect(compiled?.sql).not.toContain(engine === "postgres"
        ? 't0."tenant_id"'
        : "t0.`tenant_id`");
      expect(compiled?.sql).toContain(engine === "postgres"
        ? 't1."tenant_id" = $1'
        : "t1.`tenant_id` = ?");
      expect(compiled?.params).toContain("tenant-acme");
    }
  });

  it("injects mandatory derived tenant scope for every root plan shape without aggregate fan-out", async () => {
    const fixture = await activatedFixture();
    const boundary = derivedScopeBoundary(fixture.boundary);
    const plans = [
      validateExplorePlan({
        kind: "rows",
        resource: "public.order_items",
        select: ["id", "quantity"],
        limit: 5,
      }, boundary),
      validateExplorePlan({
        kind: "aggregate",
        resource: "public.order_items",
        measures: [{ function: "sum", field: "quantity" }],
        dimensions: [{ field: "status" }],
        time_bucket: { field: "created_at", bucket: "week" },
        top_n: 10,
      }, boundary),
      validateExplorePlan({
        kind: "aggregate",
        resource: "public.order_items",
        measures: [{ function: "sum", field: "quantity" }],
        time_bucket: { field: "created_at", bucket: "week" },
        comparison: {
          field: "created_at",
          ranges: [
            { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
            { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
          ],
        },
        top_n: 1,
      }, boundary),
    ];

    for (const engine of ["postgres", "mysql"] as const) {
      for (const plan of plans) {
        const queries = compileExplorePlan(plan, boundary, {
          tenant: "tenant-acme",
          principal: "",
        }, engine);
        expect(queries).toHaveLength(plan.kind === "aggregate" && plan.comparison ? 2 : 1);
        for (const query of queries) {
          expect(query.resources.map((resource) => resource.id).sort()).toEqual([
            "public.order_items",
            "public.orders",
          ]);
          expect(query.sql).toContain(engine === "postgres"
            ? "EXISTS (SELECT 1 FROM \"public\".\"orders\" st0_tenant_0"
            : "EXISTS (SELECT 1 FROM `public`.`orders` st0_tenant_0");
          expect(query.sql).toContain(engine === "postgres"
            ? 't0."order_id" = st0_tenant_0."id"'
            : "t0.`order_id` = st0_tenant_0.`id`");
          expect(query.sql).toContain(engine === "postgres"
            ? 'st0_tenant_0."tenant_id" = $1'
            : "st0_tenant_0.`tenant_id` = ?");
          expect(query.sql).not.toMatch(/JOIN\s+[^)]*orders[^)]*JOIN\s+[^)]*orders/i);
          expect(query.params).toContain("tenant-acme");
        }
      }
    }
  });

  it("requires an explicit depth-three opt-in before compiling tenant and principal scope", async () => {
    const fixture = await activatedFixture();
    const boundary = depthThreeScopeBoundary(fixture.boundary);
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.event_notes",
      measures: [{ function: "count" }],
      top_n: 1,
    }, boundary);

    const defaultDepth = structuredClone(boundary);
    defaultDepth.budgets.max_derived_scope_hops = 2;
    expect(() => compileExplorePlan(plan, defaultDepth, {
      tenant: "tenant-acme",
      principal: "order-owner-7",
    }, "postgres")).toThrow(/malformed derived tenant scope/i);

    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, {
        tenant: "tenant-acme",
        principal: "order-owner-7",
      }, engine);
      expect(query!.resources.map((resource) => resource.id).sort()).toEqual([
        "public.event_notes",
        "public.order_events",
        "public.order_items",
        "public.orders",
      ]);
      expect(query!.sql.match(/EXISTS \(SELECT 1 FROM/g)).toHaveLength(2);
      expect(query!.sql).toContain(engine === "postgres"
        ? 'FROM "public"."order_events" st0_tenant_0 JOIN "public"."order_items" st0_tenant_1'
        : "FROM `public`.`order_events` st0_tenant_0 JOIN `public`.`order_items` st0_tenant_1");
      expect(query!.sql).toContain(engine === "postgres"
        ? 'JOIN "public"."orders" st0_tenant_2'
        : "JOIN `public`.`orders` st0_tenant_2");
      expect(query!.sql).toContain(engine === "postgres"
        ? 'st0_tenant_2."tenant_id" = $1'
        : "st0_tenant_2.`tenant_id` = ?");
      expect(query!.sql).toContain(engine === "postgres"
        ? 'st0_principal_2."id" = $2'
        : "st0_principal_2.`id` = ?");
      expect(query!.sql).not.toMatch(/CROSS JOIN|SELECT\s+\*/i);
      expect(query!.params).toContain("tenant-acme");
      expect(query!.params).toContain("order-owner-7");
    }

    const tampered = structuredClone(boundary);
    const tamperedScope = tampered.pack.resources.find((resource) =>
      resource.id === "public.event_notes")!.tenant_scope!;
    tamperedScope.proof.links[1]!.max_fan_out = 2 as 1;
    tamperedScope.proof.digest = canonicalJsonDigest(tamperedScope.proof.links);
    expect(() => compileExplorePlan(plan, tampered, {
      tenant: "tenant-acme",
      principal: "order-owner-7",
    }, "postgres")).toThrow(/continuous non-null many-to-one path/i);
  });

  it("compiles an exact reviewed three-hop analysis path on both SQL engines", async () => {
    const fixture = await activatedFixture();
    const boundary = depthThreeScopeBoundary(fixture.boundary);
    const relationship = "event_notes_order_event_id_fkey__order_events_order_item_id_fkey__order_items_order_id_fkey";
    const input = {
      kind: "aggregate" as const,
      resource: "public.event_notes",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "region", relationship }],
      top_n: 10,
    };

    const defaultDepth = structuredClone(boundary);
    defaultDepth.budgets.max_analysis_relationship_hops = 2;
    expect(() => validateExplorePlan(input, defaultDepth)).toThrow(/activated proven path-depth boundary/i);

    const plan = validateExplorePlan(input, boundary);
    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, {
        tenant: "tenant-acme",
        principal: "order-owner-7",
      }, engine);
      expect(query!.sql).toContain(engine === "postgres"
        ? 'JOIN "public"."order_events" t1 ON t0."order_event_id" = t1."id"'
        : "JOIN `public`.`order_events` t1 ON t0.`order_event_id` = t1.`id`");
      expect(query!.sql).toContain(engine === "postgres"
        ? 'JOIN "public"."order_items" t2 ON t1."order_item_id" = t2."id"'
        : "JOIN `public`.`order_items` t2 ON t1.`order_item_id` = t2.`id`");
      expect(query!.sql).toContain(engine === "postgres"
        ? 'JOIN "public"."orders" t3 ON t2."order_id" = t3."id"'
        : "JOIN `public`.`orders` t3 ON t2.`order_id` = t3.`id`");
      expect(query!.sql).toContain(engine === "postgres" ? 't3."region"' : "t3.`region`");
      expect(query!.sql).not.toMatch(/CROSS JOIN|SELECT\s+\*/i);
      const captured = captureExploreParameterizedSql({ engine, statements: [query!] });
      expect(captured.statements[0]?.statement).toBe(query!.sql);
      expect(captured.statements[0]?.statement).toContain(engine === "postgres"
        ? 'JOIN "public"."orders" t3 ON t2."order_id" = t3."id"'
        : "JOIN `public`.`orders` t3 ON t2.`order_id` = t3.`id`");
      expect(JSON.stringify(captured)).not.toMatch(/tenant-acme|order-owner-7/);
    }
  });

  it("reuses only exact reviewed relationship prefixes with matching null semantics", async () => {
    const fixture = await activatedFixture();
    const boundary = depthThreeScopeBoundary(fixture.boundary);
    const oneHop = "event_notes_order_event_id_fkey";
    const threeHop = "event_notes_order_event_id_fkey__order_events_order_item_id_fkey__order_items_order_id_fkey";
    const root = boundary.pack.resources.find((resource) => resource.id === "public.event_notes")!;
    const longRelationship = root.relationships.find((relationship) => relationship.id === threeHop)!;
    const oneHopLinks = structuredClone(longRelationship.proof!.links.slice(0, 1));
    root.relationships.push({
      ...structuredClone(longRelationship),
      id: oneHop,
      target_resource: "public.order_events",
      path_depth: 1,
      proof: {
        source: "database_catalog",
        links: oneHopLinks,
        digest: canonicalJsonDigest(oneHopLinks),
      },
    });
    root.relationships.find((relationship) => relationship.id === oneHop)!.unmatched_rows = "exclude";
    root.relationships.find((relationship) => relationship.id === threeHop)!.unmatched_rows = "exclude";
    const fusedPlan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.event_notes",
      measures: [{ function: "count" }],
      dimensions: [
        { field: "event_type", relationship: oneHop },
        { field: "region", relationship: threeHop },
      ],
      top_n: 10,
    }, boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(fusedPlan, boundary, {
        tenant: "tenant-acme",
        principal: "order-owner-7",
      }, engine);
      const orderEventsTable = engine === "postgres"
        ? 'JOIN "public"."order_events"'
        : "JOIN `public`.`order_events`";
      expect(query!.sql.split(orderEventsTable)).toHaveLength(2);
      expect(query!.sql).toContain(engine === "postgres" ? 't1."event_type"' : "t1.`event_type`");
      expect(query!.sql).toContain(engine === "postgres" ? 't3."region"' : "t3.`region`");
    }

    root.relationships.find((relationship) => relationship.id === oneHop)!.unmatched_rows = "keep_null";
    const separatePlan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.event_notes",
      measures: [{ function: "count" }],
      dimensions: [
        { field: "event_type", relationship: oneHop },
        { field: "region", relationship: threeHop },
      ],
      top_n: 10,
    }, boundary);
    const [separateQuery] = compileExplorePlan(separatePlan, boundary, {
      tenant: "tenant-acme",
      principal: "order-owner-7",
    }, "postgres");
    expect(separateQuery!.sql.match(/(?:LEFT )?JOIN "public"\."order_events"/g)).toHaveLength(2);
  });

  it("refuses an unsupported database server before compiling a local or HTTP query", async () => {
    const fixture = await activatedFixture();
    for (const transport of ["stdio", "streamable_http"] as const) {
      if (transport === "streamable_http") {
        await rewriteActiveBoundary(fixture.root, (active) => {
          active.deployment_profile = "production";
        });
      }
      let error: ScopedExploreError | undefined;
      try {
        await prepareScopedExplore({
          projectRoot: fixture.root,
          transport,
          mode: transport === "stdio" ? "local_authoring" : "production_http",
          env: fixture.env,
          inspectDatabaseFn: async () => ({
            ...fixture.inspection,
            server_version: "PostgreSQL 12.22",
          }),
        });
      } catch (caught) {
        error = caught as ScopedExploreError;
      }
      expect(error?.code).toBe("EXPLORE_SERVER_VERSION_UNSUPPORTED");
      expect(error?.message).toMatch(/PostgreSQL 13 through 18/i);
    }
  });

  it("serves the reviewed MySQL 5.7 grammar but stales it on a release-line change", async () => {
    const mysql57 = {
      ...churnInspection(),
      engine: "mysql" as const,
      server_version: "5.7.44",
    };
    const fixture = await activatedFixture(undefined, mysql57);
    const prepared = await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => mysql57,
    });
    expect(prepared.lock.database_server_authority).toMatchObject({
      version_line: "5.7",
      features: { automatic_numeric_bands: false },
    });
    expect(prepared.boundary).toMatchObject({
      database_server_version: "5.7.44",
      database_server_tier: "compatible_limited",
      database_server_authority: {
        engine: "mysql",
        version_line: "5.7",
      },
    });
    const resource = prepared.boundary.pack.resources[0]!;
    expect(resource.auto_bands).toBeUndefined();
    expect(resource.groupable_fields).not.toContain("region");
    expect(resource.filterable_fields).not.toHaveProperty("region");
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => ({
        ...mysql57,
        server_version: "5.7.45",
      }),
    })).resolves.toMatchObject({
      boundary: { database_server_version: "5.7.44" },
      inspection: { server_version: "5.7.45" },
    });

    for (const transport of ["stdio", "streamable_http"] as const) {
      if (transport === "streamable_http") {
        await rewriteActiveBoundary(fixture.root, (active) => {
          active.deployment_profile = "production";
        });
      }
      await expect(prepareScopedExplore({
        projectRoot: fixture.root,
        transport,
        mode: transport === "stdio" ? "local_authoring" : "production_http",
        env: fixture.env,
        inspectDatabaseFn: async () => ({
          ...mysql57,
          server_version: "8.0.42",
        }),
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/release line changed from mysql 5\.7 to mysql 8\.x/i),
      });
    }
  });

  it("keeps pre-CHECK MySQL patches stable but stales authority at 8.0.16", async () => {
    const mysql8015 = {
      ...churnInspection(),
      engine: "mysql" as const,
      server_version: "8.0.15",
    };
    const fixture = await activatedFixture(undefined, mysql8015);
    const prepared = await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => mysql8015,
    });
    expect(prepared.lock.database_server_tier).toBe("compatible_limited");
    expect(prepared.lock.database_server_authority).toMatchObject({
      version_line: "8.0-pre-check",
      features: {
        automatic_numeric_bands: true,
        schema_check_constraints: false,
      },
    });
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => ({
        ...mysql8015,
        server_version: "8.0.14",
      }),
    })).resolves.toMatchObject({
      boundary: { database_server_version: "8.0.15" },
      inspection: { server_version: "8.0.14" },
    });
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => ({
        ...mysql8015,
        server_version: "8.0.16",
      }),
    })).rejects.toMatchObject({
      code: "EXPLORE_LOCK_STALE",
      message: expect.stringMatching(/release line changed from mysql 8\.0-pre-check to mysql 8\.x/i),
    });
  });

  it("serves the full PostgreSQL 13 grammar but stales it on a major-version change", async () => {
    const postgres13 = {
      ...churnInspection(),
      server_version: "PostgreSQL 13.23",
    };
    const fixture = await activatedFixture(undefined, postgres13);
    const prepared = await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => postgres13,
    });
    expect(prepared.lock.database_server_authority).toMatchObject({
      engine: "postgres",
      version_line: "13",
      features: {
        automatic_numeric_bands: true,
        schema_check_constraints: true,
      },
    });
    expect(prepared.boundary).toMatchObject({
      database_server_version: "PostgreSQL 13.23",
      database_server_tier: "full",
      database_server_authority: {
        engine: "postgres",
        version_line: "13",
      },
    });
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => ({
        ...postgres13,
        server_version: "PostgreSQL 13.24",
      }),
    })).resolves.toMatchObject({
      boundary: { database_server_version: "PostgreSQL 13.23" },
      inspection: { server_version: "PostgreSQL 13.24" },
    });

    for (const transport of ["stdio", "streamable_http"] as const) {
      if (transport === "streamable_http") {
        await rewriteActiveBoundary(fixture.root, (active) => {
          active.deployment_profile = "production";
        });
      }
      await expect(prepareScopedExplore({
        projectRoot: fixture.root,
        transport,
        mode: transport === "stdio" ? "local_authoring" : "production_http",
        env: fixture.env,
        inspectDatabaseFn: async () => ({
          ...postgres13,
          server_version: "PostgreSQL 14.20",
        }),
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/release line changed from postgres 13 to postgres 14/i),
      });
    }
  });

  it("refuses a served boundary whose activated artifact omits its reviewed server tier", async () => {
    const fixture = await activatedFixture();
    await rewriteActiveBoundary(fixture.root, (active) => {
      delete active.database_server_version;
      delete active.database_server_tier;
      delete active.database_server_authority;
    });

    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
    })).rejects.toMatchObject({
      code: "EXPLORE_LOCK_STALE",
      message: expect.stringMatching(/activated boundary does not record.*database server capability tier/is),
    });
  });

  it("fails closed when a derived-scope prepared plan is missing authority dependencies", async () => {
    const fixture = await activatedDerivedScopeFixture();
    const prepared = await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
    });
    delete prepared.lock.authority_dependencies;
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.order_items",
      measures: [{ function: "sum", field: "quantity" }],
      top_n: 1,
    }, prepared.boundary);

    expect(() => assertPreparedExplorePlanAuthority(plan, prepared)).toThrowError(
      expect.objectContaining({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/derived trusted scope.*does not bind.*No query was executed/is),
      }),
    );
  });

  it("rechecks tenant-isolation evidence before a single-organization query executes", async () => {
    const fixture = await activatedFixture();
    const prepared = await prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
    });
    prepared.boundary.organization_scope = {
      mode: "single_organization",
      organization_id: "internal-finance",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    prepared.lock.organization_scope = prepared.boundary.organization_scope;
    for (const resource of prepared.boundary.pack.resources) {
      delete resource.tenant_key;
      delete resource.tenant_scope;
    }
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      top_n: 1,
    }, prepared.boundary);
    expect(() => assertPreparedExplorePlanAuthority(plan, prepared)).toThrowError(
      expect.objectContaining({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/tenant-isolation evidence[\s\S]*No query was executed/i),
      }),
    );
  });

  it("scopes a derived relationship target independently and preserves MySQL parameter order", async () => {
    const fixture = await activatedFixture();
    const boundary = derivedTargetBoundary(fixture.boundary);
    const plan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.orders",
      measures: [{ function: "count" }],
      dimensions: [{ field: "name", relationship: "orders_featured_product_id_fkey" }],
      top_n: 10,
    }, boundary);

    for (const engine of ["postgres", "mysql"] as const) {
      const [query] = compileExplorePlan(plan, boundary, {
        tenant: "tenant-acme",
        principal: "",
      }, engine);
      expect(query!.resources.map((resource) => resource.id).sort()).toEqual([
        "public.catalogs",
        "public.orders",
        "public.products",
      ]);
      expect(query!.sql).toContain(engine === "postgres"
        ? "JOIN \"public\".\"products\" t1 ON"
        : "JOIN `public`.`products` t1 ON");
      expect(query!.sql).toContain(engine === "postgres"
        ? "EXISTS (SELECT 1 FROM \"public\".\"catalogs\" st1_tenant_0"
        : "EXISTS (SELECT 1 FROM `public`.`catalogs` st1_tenant_0");
      expect(query!.params.filter((value) => value === "tenant-acme")).toHaveLength(2);
    }

    const enumPlan = validateExplorePlan({
      kind: "aggregate",
      resource: "public.order_items",
      measures: [{ function: "count" }],
      dimensions: [{ field: "status" }],
      top_n: 10,
    }, derivedScopeBoundary(fixture.boundary));
    const [mysql] = compileExplorePlan(enumPlan, derivedScopeBoundary(fixture.boundary), {
      tenant: "tenant-acme",
      principal: "",
    }, "mysql");
    expect(mysql!.params.slice(0, 3)).toEqual([
      "open",
      "closed",
      expect.stringMatching(/^__synapsor_unreviewed_[a-f0-9]+__$/),
    ]);
    expect(mysql!.params.indexOf("tenant-acme")).toBeGreaterThan(2);
  });

  it("returns exact catalog evidence when a safe plan needs a proven but inactive relationship", async () => {
    const fixture = await activatedFixture((candidate) => {
      const root = candidate.pack.resources.find((resource) =>
        resource.id === "public.subscriptions")!;
      root.relationships = [];
    }, relationshipInspection());
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const description = await runtime.describe({ resource: "public.subscriptions" }) as {
        resources: Array<{
          relationships: Array<Record<string, unknown>>;
          suggested_questions: Array<Record<string, unknown>>;
        }>;
      };
      expect(description.resources[0]?.relationships).toContainEqual(expect.objectContaining({
        id: "subscriptions_region_id_fkey",
        activation: "review_required",
        operator_review_required: true,
        cardinality: "many_to_one",
        path: {
          resources: ["public.subscriptions", "public.regions"],
          via_columns: [["region_id"]],
        },
      }));
      expect(description.resources[0]?.suggested_questions).toContainEqual(expect.objectContaining({
        relationship_review_required: true,
        dimension: {
          field: "name",
          relationship: "subscriptions_region_id_fkey",
        },
      }));

      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{
          field: "name",
          relationship: "subscriptions_region_id_fkey",
        }],
        top_n: 10,
      })).rejects.toMatchObject({
        code: "EXPLORE_RELATIONSHIP_FORBIDDEN",
        details: {
          relationship_review: {
            action: "Review and add this relationship in the operator plane",
            operator_plane_only: true,
            cli_command: "synapsor-runner boundary review --access --project-root .",
            cli_steps: [
              "Select public.subscriptions",
              "Press J Relationship paths",
            ],
            workbench: "Review and add this relationship",
            resource: "public.subscriptions",
            relationship: "subscriptions_region_id_fkey",
            target_resource: "public.regions",
            counted_entity: "id",
            path_depth: 1,
            nullable: false,
            evidence: [{
              constraint: "subscriptions_region_id_fkey",
              source_resource: "public.subscriptions",
              target_resource: "public.regions",
              uniqueness: {
                kind: "primary_key",
                columns: ["id"],
              },
              cardinality: "many_to_one",
              max_fan_out: 1,
            }],
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it("never weakens cohort suppression as reviewed dimensions become more specific", async () => {
    const fixture = await activatedFixture(undefined, starRelationshipInspection());
    const plans = [
      {
        dimensions: [{ field: "name", relationship: "subscriptions_region_id_fkey" }],
        rows: [
          { dimension_0: "West", measure_0: 16, __cohort_size: 16 },
        ],
        suppressed: 0,
      },
      {
        dimensions: [
          { field: "name", relationship: "subscriptions_region_id_fkey" },
          { field: "name", relationship: "subscriptions_segment_id_fkey" },
        ],
        rows: [
          { dimension_0: "West", dimension_1: "Enterprise", measure_0: 12, __cohort_size: 12 },
          { dimension_0: "West", dimension_1: "Rare", measure_0: 4, __cohort_size: 4 },
        ],
        suppressed: 1,
      },
      {
        dimensions: [
          { field: "name", relationship: "subscriptions_region_id_fkey" },
          { field: "name", relationship: "subscriptions_segment_id_fkey" },
          { field: "name", relationship: "subscriptions_plan_id_fkey" },
        ],
        rows: [
          { dimension_0: "West", dimension_1: "Enterprise", dimension_2: "Annual", measure_0: 8, __cohort_size: 8 },
          { dimension_0: "West", dimension_1: "Enterprise", dimension_2: "Monthly", measure_0: 4, __cohort_size: 4 },
          { dimension_0: "West", dimension_1: "Rare", dimension_2: "Annual", measure_0: 4, __cohort_size: 4 },
        ],
        suppressed: 2,
      },
    ];
    const observed: number[] = [];
    for (const item of plans) {
      const runtime = await createScopedExploreRuntime({
        projectRoot: fixture.root,
        transport: "stdio",
        env: fixture.env,
        executor: fixedExecutor(item.rows),
        inspectDatabaseFn: async () => fixture.inspection,
      });
      try {
        const result = await runtime.explore({
          kind: "aggregate",
          resource: "public.subscriptions",
          measures: [{ function: "count" }],
          dimensions: item.dimensions,
          top_n: 10,
        });
        expect(result.privacy).toMatchObject({ suppressed_groups: item.suppressed });
        observed.push((result.privacy as { suppressed_groups: number }).suppressed_groups);
      } finally {
        await runtime.close();
      }
    }
    expect(observed).toEqual([0, 1, 2]);
  });

  it("invalidates only the relationship whose catalog proof drifted", async () => {
    const fixture = await activatedFixture(undefined, starRelationshipInspection());
    const drifted = structuredClone(fixture.inspection);
    const subscriptions = drifted.tables.find((table) => table.name === "subscriptions")!;
    subscriptions.foreign_keys = subscriptions.foreign_keys.filter((foreignKey) =>
      foreignKey.name !== "subscriptions_region_id_fkey");
    let executions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async ({ sql }) => {
          executions += 1;
          return sql.includes('"segments"')
            ? [{ dimension_0: "enterprise", measure_0: 8, __cohort_size: 8 }]
            : [{ region: "north" }];
        },
        executeBatch: async ({ queries }) => Promise.all(queries.map(async ({ sql }) => {
          executions += 1;
          return sql.includes('"segments"')
            ? [{ dimension_0: "enterprise", measure_0: 8, __cohort_size: 8 }]
            : [{ region: "north" }];
        })),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => drifted,
    });
    try {
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).resolves.toMatchObject({
        data: [{ region: "north" }],
        source_database_changed: false,
      });
      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{
          field: "name",
          relationship: "subscriptions_segment_id_fkey",
        }],
        top_n: 10,
      })).resolves.toMatchObject({
        data: [{ segments_name: "enterprise", count: 8 }],
        counted_entity: {
          resource: "public.subscriptions",
          primary_key: "id",
        },
      });
      const beforeRefusal = executions;
      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{
          field: "name",
          relationship: "subscriptions_region_id_fkey",
        }],
        top_n: 10,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringContaining("subscriptions_region_id_fkey"),
      });
      expect(executions).toBe(beforeRefusal);
    } finally {
      await runtime.close();
    }
  });

  it("ignores unrelated default-deny additions but fails only the reviewed resource whose schema changed", async () => {
    const fixture = await activatedFixture(undefined, relationshipInspection());
    const added = structuredClone(fixture.inspection);
    const subscriptions = added.tables.find((table) => table.name === "subscriptions")!;
    subscriptions.columns.push(column("new_internal_note", "text", { sensitive: true }));
    const regions = added.tables.find((table) => table.name === "regions")!;
    const futureTable = structuredClone(regions);
    futureTable.name = "future_metrics";
    futureTable.unique_constraints = [{ name: "future_metrics_pkey", columns: ["id"] }];
    futureTable.indexes = [{ name: "future_metrics_pkey", columns: ["id"], unique: true }];
    added.tables.push(futureTable);

    let additiveExecutions = 0;
    const additiveRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => {
          additiveExecutions += 1;
          return [{ region: "north" }];
        },
        executeBatch: async ({ queries }) => queries.map(() => {
          additiveExecutions += 1;
          return [{ region: "north" }];
        }),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => added,
    });
    try {
      await expect(additiveRuntime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).resolves.toMatchObject({
        data: [{ region: "north" }],
        source_database_changed: false,
      });
      await expect(additiveRuntime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["new_internal_note"],
        limit: 1,
      })).rejects.toMatchObject({ code: "EXPLORE_FIELD_FORBIDDEN" });
      await expect(additiveRuntime.explore({
        kind: "rows",
        resource: "public.future_metrics",
        select: ["id"],
        limit: 1,
      })).rejects.toMatchObject({ code: "EXPLORE_RESOURCE_FORBIDDEN" });
      expect(additiveExecutions).toBe(1);
    } finally {
      await additiveRuntime.close();
    }

    const changed = structuredClone(fixture.inspection);
    const changedSubscriptions = changed.tables.find((table) => table.name === "subscriptions")!;
    changedSubscriptions.columns.find((item) => item.name === "region")!.data_type = "integer";
    let changedExecutions = 0;
    const changedRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async ({ sql }) => {
          changedExecutions += 1;
          return sql.includes('"regions"')
            ? [{ name: "North" }]
            : [{ region: "north" }];
        },
        executeBatch: async ({ queries }) => queries.map(({ sql }) => {
          changedExecutions += 1;
          return sql.includes('"regions"')
            ? [{ name: "North" }]
            : [{ region: "north" }];
        }),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => changed,
    });
    try {
      await expect(changedRuntime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(
          /Reviewed field public\.subscriptions\.region changed type from text to integer[\s\S]*boundary rescan --from-env DATABASE_URL/,
        ),
      });
      expect(changedExecutions).toBe(0);
      await expect(changedRuntime.explore({
        kind: "rows",
        resource: "public.regions",
        select: ["name"],
        limit: 1,
      })).resolves.toMatchObject({
        data: [{ name: "North" }],
        source_database_changed: false,
      });
      expect(changedExecutions).toBe(1);
    } finally {
      await changedRuntime.close();
    }

    const deleted = structuredClone(fixture.inspection);
    const deletedSubscriptions = deleted.tables.find((table) => table.name === "subscriptions")!;
    deletedSubscriptions.columns = deletedSubscriptions.columns.filter((item) => item.name !== "region");
    let deletedExecutions = 0;
    const deletedRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => {
          deletedExecutions += 1;
          return [];
        },
        executeBatch: async ({ queries }) => queries.map(() => {
          deletedExecutions += 1;
          return [];
        }),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => deleted,
    });
    try {
      await expect(deletedRuntime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringContaining(
          "Reviewed field public.subscriptions.region no longer exists",
        ),
      });
      expect(deletedExecutions).toBe(0);
    } finally {
      await deletedRuntime.close();
    }
  });

  it("suppresses small cohorts and stores only a keyed, redacted plan plus encrypted Protect state", async () => {
    const fixture = await activatedFixture();
    const store = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    const executor = fixedExecutor([
      { dimension_0: "north", time_bucket: "2026-06-02T00:00:00.000Z", measure_0: "8", __cohort_size: "8" },
      { dimension_0: "rare-secret-region", time_bucket: "2026-06-02T00:00:00.000Z", measure_0: "1", __cohort_size: "1" },
    ]);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      store,
      executor,
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    try {
      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        time_bucket: { field: "churned_at", bucket: "week" },
        where: [{ field: "reason_category", op: "eq", value: "private-literal" }],
        top_n: 10,
      });
      expect(result.data).toEqual([{
        region: "north",
        time_bucket: "2026-06-02",
        count: 8,
      }]);
      expect(result).toMatchObject({
        source_database_changed: false,
        untrusted_data: true,
        privacy: { suppressed_groups: 1, totals_returned: false },
        evidence_bundle_id: expect.stringMatching(/^ev_explore_/),
      });

      const auditText = JSON.stringify(store.listQueryAudit());
      const evidenceId = String(result.evidence_bundle_id);
      const storedEvidence = store.getEvidenceBundle(evidenceId);
      const evidenceText = JSON.stringify(storedEvidence);
      expect(store.listQueryAudit({ evidence: evidenceId })).toHaveLength(1);
      expect(storedEvidence).toMatchObject({
        tenant_id: expect.stringMatching(/^keyed:[a-f0-9]{64}$/),
        principal: expect.stringMatching(/^keyed:[a-f0-9]{64}$/),
      });
      expect(store.listEvidenceBundles({
        tenants: [String(storedEvidence?.tenant_id)],
        principals: [String(storedEvidence?.principal)],
        outcome: "ok",
        boundary: fixture.boundary.activation.digest,
      })).toHaveLength(1);
      const persistedAudit = store.listQueryAudit()[0]?.payload as Record<string, unknown>;
      const capturedSql = persistedAudit.parameterized_sql as Record<string, unknown>;
      const capturedStatements = capturedSql.statements as Array<Record<string, unknown>>;
      expect(persistedAudit).toMatchObject({
        parameterized_sql_included: true,
        parameter_values_persisted: false,
        raw_sql_included: false,
      });
      expect(capturedSql).toMatchObject({
        schema_version: "synapsor.explore-parameterized-sql.v1",
        engine: "postgres",
        parameter_values_persisted: false,
        model_received_sql: false,
      });
      expect(capturedStatements[0]?.statement).toContain('FROM "public"."subscriptions" t0');
      expect(capturedStatements[0]?.statement).toContain('t0."tenant_id" = $1');
      expect(capturedStatements[0]?.statement).toContain('t0."reason_category" = $2');
      expect(JSON.stringify(result)).not.toMatch(/\bSELECT\b|parameterized_sql/i);
      expect(auditText).not.toContain("private-literal");
      expect(auditText).not.toContain("tenant-acme");
      expect(auditText).not.toContain("pm-1");
      expect(auditText).not.toContain("north");
      expect(auditText).not.toContain("rare-secret-region");
      expect(auditText).toContain("keyed_hash");
      expect(evidenceText).not.toContain("private-literal");
      expect(evidenceText).not.toContain("tenant-acme");
      expect(evidenceText).not.toContain("pm-1");
      expect(evidenceText).not.toContain("north");
      expect(evidenceText).not.toContain("rare-secret-region");

      const protect = result.protect as { token: string };
      expect(protect.token).toBe("A1");
      const stateText = await fs.readFile(path.join(fixture.root, ".synapsor/protect-state.json"), "utf8");
      expect(stateText).not.toContain("private-literal");
      const recovered = await loadProtectedPlan({
        projectRoot: fixture.root,
        token: protect.token,
        now: Date.parse("2026-07-22T12:00:01.000Z"),
      });
      expect(recovered.plan).toMatchObject({
        kind: "aggregate",
        where: [{ value: "private-literal" }],
      });
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("fails closed on excessive groups, repeated differencing, remote transport, and changed role posture", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_groups = 3;
      candidate.budgets.max_top_n = 3;
      candidate.budgets.max_differencing_queries = 2;
    });
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "remote_http",
      env: fixture.env,
      inspectDatabaseFn: async () => fixture.inspection,
    })).rejects.toMatchObject({ code: "EXPLORE_TRANSPORT_FORBIDDEN" });

    const changedRole = structuredClone(fixture.inspection);
    changedRole.role_posture!.read_only = false;
    changedRole.role_posture!.writable_relations = ["public.subscriptions"];
    await expect(prepareScopedExplore({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      inspectDatabaseFn: async () => changedRole,
    })).rejects.toMatchObject({
      code: "EXPLORE_LOCK_STALE",
      message: expect.stringContaining(
        "synapsor-runner boundary rescan --from-env DATABASE_URL",
      ),
    });

    const overflowRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([
        { dimension_0: "a", measure_0: 10, __cohort_size: 10 },
        { dimension_0: "b", measure_0: 10, __cohort_size: 10 },
        { dimension_0: "c", measure_0: 10, __cohort_size: 10 },
        { dimension_0: "d", measure_0: 10, __cohort_size: 10 },
      ]),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    await expect(overflowRuntime.explore(aggregatePlan("one"))).rejects.toMatchObject({
      code: "EXPLORE_RESPONSE_TOO_LARGE",
      message: expect.stringContaining("one bounded two-period comparison"),
    });
    await overflowRuntime.close();
    const refusalStore = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    expect(refusalStore.listQueryAudit().some((record) =>
      (record.payload as Record<string, unknown>).status === "refused_privacy_boundary"
      && (record.payload as Record<string, unknown>).result_values_persisted === false
    )).toBe(true);
    refusalStore.close();

    const budgetFixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 2;
    });
    const budgetRuntime = await createScopedExploreRuntime({
      projectRoot: budgetFixture.root,
      transport: "stdio",
      env: budgetFixture.env,
      executor: fixedExecutor([{ dimension_0: "a", measure_0: 10, __measure_cohort_0: 10, __cohort_size: 10 }]),
      inspectDatabaseFn: async () => budgetFixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await budgetRuntime.explore(aggregatePlan("one"));
    await budgetRuntime.close();
    const resumedBudgetRuntime = await createScopedExploreRuntime({
      projectRoot: budgetFixture.root,
      transport: "stdio",
      env: budgetFixture.env,
      executor: fixedExecutor([{
        dimension_0: "a",
        measure_0: 10,
        __measure_cohort_0: 10,
        __cohort_size: 10,
      }]),
      inspectDatabaseFn: async () => budgetFixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await resumedBudgetRuntime.explore(aggregatePlan("one"));
    await resumedBudgetRuntime.explore(aggregatePlan("two"));
    await resumedBudgetRuntime.explore(aggregatePlan("one"));
    await expect(resumedBudgetRuntime.explore(aggregatePlan("three"))).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
    });
    await resumedBudgetRuntime.close();
  }, 15_000);

  it("counts only exact successful plan replays as one differencing variant", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 2;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 100;
    });
    const failed = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async () => {
          throw new Error("temporary source failure");
        },
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await expect(failed.explore(aggregatePlan("north"))).rejects.toMatchObject({
      code: "EXPLORE_SOURCE_UNAVAILABLE",
    });
    await failed.close();

    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ dimension_0: "a", measure_0: 10, __cohort_size: 10 }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await runtime.explore(aggregatePlan("north"));
    await runtime.explore(aggregatePlan("north"));
    await runtime.explore({ ...aggregatePlan("north"), top_n: 2 });
    await expect(runtime.explore(aggregatePlan("south"))).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
    });
    await runtime.close();
  });

  it("shares differencing allowance across measure, dimension, and time plan families", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 2;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "a",
        measure_0: 10,
        __measure_cohort_0: 10,
        __cohort_size: 10,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await runtime.explore(aggregatePlan("north"));
    await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [{ field: "reason_category" }],
      where: [{ field: "region", op: "eq", value: "north" }],
      top_n: 3,
    });
    await expect(runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "avg", field: "monthly_revenue_cents" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      where: [{ field: "region", op: "eq", value: "south" }],
      top_n: 3,
    })).rejects.toMatchObject({ code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED" });
    await runtime.close();
  });

  it("accounts fixed and automatic bucket-count variants in one differencing family", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 2;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
      candidate.pack.resources[0]!.numeric_bands = [{
        name: "monthly_revenue_band",
        label: "Monthly revenue band",
        field: "monthly_revenue_cents",
        edges: [1_000, 5_000],
        bucket_labels: ["under 10", "10 to 49", "50 or more"],
      }];
      candidate.pack.resources[0]!.auto_bands = [{
        field: "monthly_revenue_cents",
        methods: ["quantile"],
        min_buckets: 3,
        max_buckets: 8,
        label_style: "ordinal",
      }];
    });
    let executions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => {
          executions += 1;
          return queries.map(() => [{
            dimension_0: 1,
            measure_0: 10,
            __cohort_size: 10,
            __auto_effective_buckets: 5,
          }]);
        },
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    const planFor = (numeric_band: string | { field: string; method: "quantile"; buckets: number }) => ({
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ numeric_band }],
      top_n: 10,
    });
    try {
      await expect(runtime.explore(planFor("monthly_revenue_band"))).resolves.toMatchObject({ ok: true });
      await expect(runtime.explore(planFor({
        field: "monthly_revenue_cents",
        method: "quantile",
        buckets: 4,
      }))).resolves.toMatchObject({ ok: true });
      await expect(runtime.explore(planFor({
        field: "monthly_revenue_cents",
        method: "quantile",
        buckets: 5,
      }))).rejects.toMatchObject({ code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED" });
      expect(executions).toBe(2);
    } finally {
      await runtime.close();
    }
  });

  it("keeps differencing use across restart and UTC midnight until the rolling window expires", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 1;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    });
    let now = Date.parse("2026-07-24T23:59:00.000Z");
    const createRuntime = () => createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ dimension_0: "a", measure_0: 10, __cohort_size: 10 }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => now,
    });
    const beforeMidnight = await createRuntime();
    const stableSessionFingerprint = beforeMidnight.session_fingerprint;
    const firstResult = await beforeMidnight.explore(aggregatePlan("north")) as Record<string, any>;
    expect(firstResult.operator_budget.trusted_scope.warnings).toEqual([
      expect.stringMatching(/differencing variants for root resource public\.subscriptions reached 1\/1/i),
    ]);
    await beforeMidnight.close();

    now = Date.parse("2026-07-25T00:01:00.000Z");
    const afterMidnight = await createRuntime();
    expect(afterMidnight.session_fingerprint).toBe(stableSessionFingerprint);
    await expect(afterMidnight.explore(aggregatePlan("south"))).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
    });
    await afterMidnight.close();

    now = Date.parse("2026-07-26T00:00:01.000Z");
    const afterWindow = await createRuntime();
    await expect(afterWindow.explore(aggregatePlan("south"))).resolves.toMatchObject({ ok: true });
    await afterWindow.close();
  });

  it("atomically reserves differencing allowance across concurrent runtimes", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 1;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    });
    let sourceExecutions = 0;
    const executor = (): ScopedExploreExecutor => ({
      execute: async () => [],
      executeBatch: async ({ queries }) => {
        sourceExecutions += 1;
        return queries.map(() => [{ dimension_0: "a", measure_0: 10, __cohort_size: 10 }]);
      },
      close: async () => undefined,
    });
    const createRuntime = () => createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio" as const,
      env: fixture.env,
      executor: executor(),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    const [first, second] = await Promise.all([createRuntime(), createRuntime()]);
    try {
      const outcomes = await Promise.allSettled([
        first.explore(aggregatePlan("north")),
        second.explore(aggregatePlan("south")),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: {
          code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
          message: expect.stringMatching(
            /disclosure-control differencing allowance exhausted[\s\S]*Used 1 of 1 distinct protected variants for root resource public\.subscriptions[\s\S]*not an MCP-session counter[\s\S]*prevents reconstruction/i,
          ),
        },
      });
      expect(sourceExecutions).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("atomically reserves the rolling query allowance before source execution", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_queries_per_session = 1;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    });
    let sourceExecutions = 0;
    const executor = (): ScopedExploreExecutor => ({
      execute: async () => [],
      executeBatch: async ({ queries }) => {
        sourceExecutions += 1;
        return queries.map(() => [{ region: "north" }]);
      },
      close: async () => undefined,
    });
    const createRuntime = () => createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio" as const,
      env: fixture.env,
      executor: executor(),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    const [first, second] = await Promise.all([createRuntime(), createRuntime()]);
    const rowPlan = {
      kind: "rows" as const,
      resource: "public.subscriptions",
      select: ["region"],
      limit: 1,
    };
    try {
      const outcomes = await Promise.allSettled([
        first.explore(rowPlan),
        second.explore(rowPlan),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED" });
      expect(String(rejected?.reason?.message)).toMatch(
        /query-volume allowance exhausted[\s\S]*Used 1 of 1 queries[\s\S]*L Limits[\s\S]*controls are separate/i,
      );
      expect(sourceExecutions).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("returns operator-only remaining budgets and warns once when volume crosses 80 percent", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_queries_per_session = 5;
      candidate.budgets.rate_limit_per_minute = 10;
      candidate.budgets.max_extracted_cells_per_session = 100;
      candidate.budgets.max_differencing_queries = 16;
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ region: "north" }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    const plan = {
      kind: "rows" as const,
      resource: "public.subscriptions",
      select: ["region"],
      limit: 1,
    };
    try {
      for (let index = 1; index <= 3; index += 1) {
        const result = await runtime.explore(plan) as Record<string, any>;
        expect(result.operator_budget.trusted_scope.volume.queries_rolling_24_hours).toMatchObject({
          used: index,
          limit: 5,
          remaining: 5 - index,
        });
        expect(result.operator_budget.trusted_scope.warnings).toEqual([]);
      }
      const threshold = await runtime.explore(plan) as Record<string, any>;
      expect(threshold.operator_budget).toMatchObject({
        operator_only: true,
        accounting: expect.stringMatching(/differencing variants are per trusted scope and root resource/i),
        trusted_scope: {
          volume: {
            queries_rolling_24_hours: { used: 4, limit: 5, remaining: 1, percent_used: 80 },
          },
          disclosure: {
            differencing_variants_rolling_24_hours: {
              root_resource: "public.subscriptions",
              persists_across_sessions: true,
            },
          },
        },
      });
      expect(threshold.operator_budget.trusted_scope.warnings).toEqual([
        expect.stringMatching(/volume warning: rolling queries reached 4\/5; 1 remain/i),
      ]);
      const afterThreshold = await runtime.explore(plan) as Record<string, any>;
      expect(afterThreshold.operator_budget.trusted_scope.warnings).toEqual([]);
      expect(afterThreshold.outcome.result.remaining_budgets).toMatchObject({
        differencing_queries: null,
        differencing_variants_for_root_resource: null,
      });
      const projected = projectScopedExploreResultForModel({
        tool: "app.explore_data",
        arguments: { plan },
        result: threshold,
        boundary: fixture.boundary,
      });
      expect(projected.value).not.toHaveProperty("operator_budget");
      expect(projected.operator_metadata_withheld).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("does not exhaust differencing protection on ordinary trend replays", async () => {
    const trendFixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 1;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    });
    const trendRuntime = await createScopedExploreRuntime({
      projectRoot: trendFixture.root,
      transport: "stdio",
      env: trendFixture.env,
      executor: fixedExecutor([{ time_bucket_0: "2026-07-20T00:00:00.000Z", measure_0: 10, __cohort_size: 10 }]),
      inspectDatabaseFn: async () => trendFixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    const weeklyTrend = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      top_n: 3,
    };
    for (let index = 0; index < 8; index += 1) {
      await expect(trendRuntime.explore(weeklyTrend)).resolves.toMatchObject({
        ok: true,
        outcome: {
          result: {
            remaining_budgets: {
              differencing_queries: 0,
              differencing_variants_for_root_resource: {
                resource: "public.subscriptions",
                used: 1,
                limit: 1,
                remaining: 0,
                window: "rolling_24_hours",
                persists_across_sessions: true,
              },
            },
          },
        },
      });
    }
    await trendRuntime.close();
  });

  it("does not exhaust differencing protection for an owner-reviewed cohort of one", async () => {
    const unsuppressedFixture = await activatedFixture((candidate) => {
      candidate.budgets.max_differencing_queries = 1;
      candidate.budgets.max_queries_per_session = 20;
      candidate.budgets.rate_limit_per_minute = 20;
      candidate.budgets.max_extracted_cells_per_session = 200;
    }, churnInspection(), 1);
    const unsuppressedRuntime = await createScopedExploreRuntime({
      projectRoot: unsuppressedFixture.root,
      transport: "stdio",
      env: unsuppressedFixture.env,
      executor: fixedExecutor([{ dimension_0: "a", measure_0: 1, __cohort_size: 1 }]),
      inspectDatabaseFn: async () => unsuppressedFixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    for (const value of ["north", "south", "east"]) {
      await expect(unsuppressedRuntime.explore(aggregatePlan(value))).resolves.toMatchObject({
        ok: true,
        privacy: {
          minimum_cohort_size: 1,
          minimum_cohort_overridden: true,
          suppressed_groups: 0,
        },
        outcome: {
          result: {
            remaining_budgets: { differencing_queries: null },
          },
        },
      });
    }
    await unsuppressedRuntime.close();
  });

  it("never releases both a suppressed grouping and its complementary scalar total", async () => {
    const groupedPlan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    };
    const scalarPlan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      top_n: 1,
    };
    const executor = complementAttackExecutor();

    const groupedFirst = await activatedFixture();
    const groupedRuntime = await createScopedExploreRuntime({
      projectRoot: groupedFirst.root,
      transport: "stdio",
      env: groupedFirst.env,
      executor,
      inspectDatabaseFn: async () => groupedFirst.inspection,
      clock: () => Date.parse("2026-07-24T23:59:59.000Z"),
    });
    await expect(groupedRuntime.explore(groupedPlan)).resolves.toMatchObject({
      privacy: { suppressed_groups: 1 },
    });
    await groupedRuntime.close();
    const nextDayRuntime = await createScopedExploreRuntime({
      projectRoot: groupedFirst.root,
      transport: "stdio",
      env: groupedFirst.env,
      executor,
      inspectDatabaseFn: async () => groupedFirst.inspection,
      clock: () => Date.parse("2026-07-25T00:00:01.000Z"),
    });
    await expect(nextDayRuntime.explore(scalarPlan)).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      message: expect.stringMatching(/earlier grouped result.*reconstruct/i),
      details: {
        reason: "complementary_aggregate_release",
        resource: "public.subscriptions",
        minimum_cohort_size: 5,
        attempted_release_kind: "scalar_total",
        conflicting_release_kind: "suppressed_grouping",
        source_query_executed: true,
        result_returned_to_caller: false,
      },
    });
    await nextDayRuntime.close();

    const scalarFirst = await activatedFixture();
    const scalarRuntime = await createScopedExploreRuntime({
      projectRoot: scalarFirst.root,
      transport: "stdio",
      env: scalarFirst.env,
      executor,
      inspectDatabaseFn: async () => scalarFirst.inspection,
    });
    await expect(scalarRuntime.explore(scalarPlan)).resolves.toMatchObject({
      privacy: { suppressed_groups: 0 },
    });
    await expect(scalarRuntime.explore(groupedPlan)).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      message: expect.stringMatching(/earlier scalar total.*reconstructable/i),
      details: {
        reason: "complementary_aggregate_release",
        resource: "public.subscriptions",
        minimum_cohort_size: 5,
        attempted_release_kind: "suppressed_grouping",
        conflicting_release_kind: "scalar_total",
        source_query_executed: true,
        result_returned_to_caller: false,
      },
    });
    await scalarRuntime.close();

    const auditStore = new ProposalStore(path.join(scalarFirst.root, ".synapsor/local.db"));
    const complementRefusal = auditStore.listQueryAudit().find((record) =>
      (record.payload as Record<string, unknown>).status === "refused_privacy_complement");
    expect(complementRefusal?.payload).toMatchObject({
      source_execution_started: true,
      source_rows_returned_to_caller: false,
      result_values_persisted: false,
    });
    auditStore.close();
  }, 15_000);

  it("never releases parent and child filtered scalar totals in either order", async () => {
    const scalarPlan = (value?: string) => ({
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      ...(value
        ? { where: [{ field: "reason_category", op: "eq" as const, value }] }
        : {}),
      top_n: 1,
    });

    const parentFirst = await activatedFixture();
    const parentRuntime = await createScopedExploreRuntime({
      projectRoot: parentFirst.root,
      transport: "stdio",
      env: parentFirst.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => parentFirst.inspection,
    });
    await expect(parentRuntime.explore(scalarPlan())).resolves.toMatchObject({ ok: true });
    await expect(parentRuntime.explore(scalarPlan("price"))).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      message: expect.stringMatching(/related reviewed filter set.*subtracting/i),
      details: {
        reason: "complementary_scalar_filter_release",
        resource: "public.subscriptions",
        minimum_cohort_size: 5,
        source_query_executed: true,
        source_rows_returned_to_caller: false,
        result_returned_to_caller: false,
      },
    });
    await parentRuntime.close();

    const childFirst = await activatedFixture();
    const childRuntime = await createScopedExploreRuntime({
      projectRoot: childFirst.root,
      transport: "stdio",
      env: childFirst.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => childFirst.inspection,
    });
    await expect(childRuntime.explore(scalarPlan("price"))).resolves.toMatchObject({ ok: true });
    await expect(childRuntime.explore(scalarPlan())).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      details: { reason: "complementary_scalar_filter_release" },
    });
    await childRuntime.close();

    const siblings = await activatedFixture();
    const siblingRuntime = await createScopedExploreRuntime({
      projectRoot: siblings.root,
      transport: "stdio",
      env: siblings.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => siblings.inspection,
    });
    await expect(siblingRuntime.explore(scalarPlan("price"))).resolves.toMatchObject({ ok: true });
    await expect(siblingRuntime.explore(scalarPlan("service"))).resolves.toMatchObject({ ok: true });
    await siblingRuntime.close();

    const nested = await activatedFixture();
    const nestedRuntime = await createScopedExploreRuntime({
      projectRoot: nested.root,
      transport: "stdio",
      env: nested.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => nested.inspection,
    });
    await expect(nestedRuntime.explore(scalarPlan("price"))).resolves.toMatchObject({ ok: true });
    await expect(nestedRuntime.explore({
      ...scalarPlan("price"),
      where: [
        { field: "reason_category", op: "eq" as const, value: "price" },
        { field: "region", op: "eq" as const, value: "north" },
      ],
    })).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      details: {
        reason: "complementary_scalar_filter_release",
        predicate_relationship: "parent_or_child",
      },
    });
    await nestedRuntime.close();
  }, 20_000);

  it("treats a scalar time window as a reviewed predicate for complement accounting", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const base = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      top_n: 1,
    };
    await expect(runtime.explore({
      ...base,
      time_window: {
        field: "churned_at",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-08-01T00:00:00.000Z",
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(runtime.explore(base)).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      details: { reason: "complementary_scalar_filter_release" },
    });
    await runtime.close();
  });

  it("atomically permits only one side of a concurrent scalar-filter complement", async () => {
    const fixture = await activatedFixture();
    const create = () => createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const [first, second] = await Promise.all([create(), create()]);
    try {
      const base = {
        kind: "aggregate" as const,
        resource: "public.subscriptions",
        measures: [{ function: "count" as const }],
        top_n: 1,
      };
      const outcomes = await Promise.allSettled([
        first.explore(base),
        second.explore({
          ...base,
          where: [{ field: "reason_category", op: "neq" as const, value: "price" }],
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const refusal = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(refusal.reason).toMatchObject({
        code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
        details: { reason: "complementary_scalar_filter_release" },
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("atomically permits only one side of a concurrent complementary aggregate release", async () => {
    const fixture = await activatedFixture();
    const groupedPlan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    };
    const scalarPlan = {
      kind: "aggregate" as const,
      resource: "public.subscriptions",
      measures: [{ function: "count" as const }],
      top_n: 1,
    };
    const first = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const second = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: complementAttackExecutor(),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const outcomes = await Promise.allSettled([
        first.explore(groupedPlan),
        second.explore(scalarPlan),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const refusal = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(refusal.reason).toMatchObject({ code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED" });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("rejects SQL-shaped input, unreviewed identifiers, kept-out uses, scope overrides, and aggregate widening", async () => {
    const { boundary } = await activatedFixture((candidate) => {
      candidate.budgets.max_measures = 2;
      candidate.budgets.max_dimensions = 2;
      candidate.budgets.max_top_n = 4;
    });
    const row = {
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      limit: 4,
    };
    const aggregate = {
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      top_n: 4,
    };
    const rejected = [
      { ...row, sql: "SELECT * FROM subscriptions" },
      { ...row, resource: "pg_catalog.pg_authid" },
      { ...row, select: ["unknown_field"] },
      { ...row, select: ["billing_token"] },
      { ...row, where: [{ field: "billing_token", op: "eq", value: "secret" }] },
      { ...row, where: [{ field: "tenant_id", op: "eq", value: "other" }] },
      { ...row, where: [{ field: "region", op: "like", value: "%" }] },
      { ...row, order_by: [{ field: "billing_token", direction: "asc" }] },
      { ...row, limit: boundary.budgets.max_rows + 1 },
      { ...aggregate, tenant: "other" },
      { ...aggregate, principal: "other" },
      { ...aggregate, relationship: "similar_name_join" },
      { ...aggregate, dimensions: [{ field: "billing_token" }] },
      { ...aggregate, measures: [{ function: "count_distinct", field: "billing_token" }] },
      { ...aggregate, measures: [{ function: "sum", field: "region" }] },
      { ...aggregate, measures: [{ function: "min", field: "monthly_revenue_cents" }] },
      { ...aggregate, measures: [{ function: "count" }, { function: "sum", field: "monthly_revenue_cents" }, { function: "avg", field: "monthly_revenue_cents" }] },
      { ...aggregate, dimensions: [{ field: "region" }, { field: "reason_category" }, { field: "churned_at" }] },
      { ...aggregate, time_bucket: { field: "billing_token", bucket: "week" } },
      { ...aggregate, top_n: 5 },
      {
        ...aggregate,
        comparison: {
          field: "churned_at",
          ranges: [
            { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
            { start: "2026-02-01T00:00:00.000Z", end: "2026-03-01T00:00:00.000Z" },
            { start: "2026-03-01T00:00:00.000Z", end: "2026-04-01T00:00:00.000Z" },
          ],
        },
      },
      {
        ...aggregate,
        comparison: {
          field: "churned_at",
          ranges: [
            { start: "2026-02-01T00:00:00.000Z", end: "2026-03-01T00:00:00.000Z" },
            { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
          ],
        },
      },
      { ...aggregate, having: [{ measure: 0, op: "gt", value: 1 }] },
      { ...aggregate, distinct: true },
      { ...aggregate, expression: "COUNT(*) FILTER (WHERE true)" },
    ];
    for (const plan of rejected) {
      expect(() => validateExplorePlan(plan, boundary)).toThrowError(ScopedExploreError);
    }

    for (const bucket of ["day", "week", "month"] as const) {
      const reviewed = validateExplorePlan({
        ...aggregate,
        measures: [
          { function: "count" },
          { function: "count_distinct", field: "id" },
        ],
        time_bucket: { field: "churned_at", bucket },
      }, boundary);
      const [compiled] = compileExplorePlan(reviewed, boundary, {
        tenant: "tenant-acme",
        principal: "pm-1",
      }, "postgres");
      expect(compiled?.sql).toContain(`date_trunc('${bucket}'`);
      expect(compiled?.sql).not.toContain("tenant-acme");
    }
  });

  it("treats missing, unknown, production, stale-compiler, and HTTP authoring posture as forbidden", async () => {
    const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-explore-missing-"));
    temporaryRoots.push(missingRoot);
    const missingError = await prepareScopedExplore({
      projectRoot: missingRoot,
      transport: "stdio",
      env: {},
      inspectDatabaseFn: async () => churnInspection(),
    }).catch((error: unknown) => error);
    expect(missingError).toMatchObject({
      code: "EXPLORE_DISABLED",
      message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
    });
    expect(String(missingError)).not.toContain(missingRoot);
    expect(String(missingError)).not.toContain("ENOENT");

    for (const transport of ["streamable_http", "remote_http"] as const) {
      const fixture = await activatedFixture();
      await expect(prepareScopedExplore({
        projectRoot: fixture.root,
        transport,
        env: fixture.env,
        inspectDatabaseFn: async () => fixture.inspection,
      })).rejects.toMatchObject({ code: "EXPLORE_TRANSPORT_FORBIDDEN" });
    }

    for (const profile of ["production", "unknown"]) {
      const fixture = await activatedFixture();
      await rewriteActiveBoundary(fixture.root, (active) => {
        active.deployment_profile = profile;
      });
      await expect(prepareScopedExplore({
        projectRoot: fixture.root,
        transport: "stdio",
        env: fixture.env,
        inspectDatabaseFn: async () => fixture.inspection,
      })).rejects.toMatchObject({ code: "EXPLORE_PROFILE_FORBIDDEN" });
    }

    const staleCompiler = await activatedFixture();
    await rewriteActiveBoundary(staleCompiler.root, (active) => {
      active.compiler_version = "stale-compiler";
    });
    await expect(prepareScopedExplore({
      projectRoot: staleCompiler.root,
      transport: "stdio",
      env: staleCompiler.env,
      inspectDatabaseFn: async () => staleCompiler.inspection,
    })).rejects.toMatchObject({ code: "EXPLORE_BOUNDARY_MISMATCH" });
  });

  it("enforces response, extraction, rate, and redacted source-error boundaries", async () => {
    const fixture = await activatedFixture((candidate) => {
      candidate.budgets.max_response_bytes = 80;
      candidate.budgets.max_response_cells = 4;
      candidate.budgets.max_queries_per_session = 10;
      candidate.budgets.max_extracted_cells_per_session = 100;
      candidate.budgets.rate_limit_per_minute = 2;
    });
    const oversized = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ region: "x".repeat(200) }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    await expect(oversized.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      limit: 1,
    })).rejects.toMatchObject({ code: "EXPLORE_RESPONSE_TOO_LARGE" });
    await oversized.close();

    const bounded = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ region: "north", reason_category: "price" }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });
    await bounded.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "reason_category"],
      limit: 1,
    });
    await bounded.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "reason_category"],
      where: [{ field: "region", op: "eq", value: "north" }],
      limit: 1,
    });
    await expect(bounded.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      limit: 1,
    })).rejects.toMatchObject({
      code: "EXPLORE_RATE_LIMITED",
      message: expect.stringMatching(
        /request-rate allowance exhausted[\s\S]*Used 2 of 2 requests[\s\S]*rolling one-minute window/i,
      ),
    });
    await bounded.close();

    const extractionFixture = await activatedFixture((candidate) => {
      candidate.budgets.max_response_cells = 4;
      candidate.budgets.max_queries_per_session = 10;
      candidate.budgets.max_extracted_cells_per_session = 4;
      candidate.budgets.rate_limit_per_minute = 10;
    });
    const extraction = await createScopedExploreRuntime({
      projectRoot: extractionFixture.root,
      transport: "stdio",
      env: extractionFixture.env,
      executor: fixedExecutor([{ region: "north", reason_category: "price" }]),
      inspectDatabaseFn: async () => extractionFixture.inspection,
      clock: () => Date.parse("2026-07-26T13:00:00.000Z"),
    });
    for (let index = 0; index < 2; index += 1) {
      await extraction.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region", "reason_category"],
        limit: 1,
      });
    }
    await expect(extraction.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region"],
      limit: 1,
    })).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      message: expect.stringMatching(
        /disclosure-control extracted-cell allowance exhausted[\s\S]*Used 4 of 4 cells[\s\S]*separate from query volume/i,
      ),
    });
    await extraction.close();

    const failed = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => {
          throw new Error("postgresql://reader:secret-password@db.internal/app token=raw-secret");
        },
        executeBatch: async () => {
          throw new Error("postgresql://reader:secret-password@db.internal/app token=raw-secret");
        },
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-27T12:00:00.000Z"),
    });
    let sourceError: unknown;
    try {
      await failed.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      });
    } catch (error) {
      sourceError = error;
    }
    expect(sourceError).toBeInstanceOf(ScopedExploreError);
    expect(sourceError).toMatchObject({ code: "EXPLORE_SOURCE_UNAVAILABLE" });
    expect((sourceError as Error).message).not.toMatch(/secret-password|raw-secret|db\.internal/);
    await failed.close();
  }, 20_000);

  it("runs production HTTP Explore with claim-bound scope and hierarchical privacy accounting", async () => {
    const fixture = await activatedProductionFixture((candidate) => {
      const subscriptions = candidate.pack.resources.find((resource) =>
        resource.id === "public.subscriptions")!;
      subscriptions.derived_measures = [{
        name: "revenue_running_total",
        label: "Revenue running total",
        shape: "running_total",
        base_measure: { function: "sum", field: "monthly_revenue_cents" },
      }, {
        name: "subscription_event_count",
        label: "Subscription event count",
        shape: "child_count_total",
        child_resource: "public.subscription_events",
        relationship: "subscription_events_subscription_id_fkey",
      }];
    }, productionFanOutInspection());
    const claimBudget = vi.fn(async () => ({
      allowed: true as const,
      principal_usage_after_reservation: {
        query_count: 1,
        queries_last_minute: 1,
        extracted_cells: 10,
        differencing_attempts: 1,
      },
      tenant_usage_after_reservation: {
        query_count: 1,
        queries_last_minute: 1,
        extracted_cells: 10,
        differencing_attempts: 1,
      },
      principal_variant_already_counted: false,
      tenant_variant_already_counted: false,
    }));
    const completeBudget = vi.fn(async () => ({ completed: true as const }));
    const claimPrivacy = vi.fn(async () => ({ allowed: true as const }));
    const store = new ProposalStore();
    Object.assign(store, {
      claimProductionExploreBudgetReservation: claimBudget,
      completeProductionExploreBudgetReservation: completeBudget,
      claimProductionExplorePrivacyRelease: claimPrivacy,
    });
    const execute = vi.fn(async () => [] as Record<string, unknown>[]);
    const executeBatch = vi.fn(async ({ queries, context }: Parameters<ScopedExploreExecutor["executeBatch"]>[0]) => {
      expect(context).toEqual({ tenant: "tenant-from-jwt", principal: "principal-from-jwt" });
      return queries.map((query) => !/\bGROUP BY\b/i.test(query.sql)
        ? [{ measure_0: 12, __cohort_size: 12 }]
        : query.sql.includes('"subscription_events" fc0')
        ? [
          { dimension_0: "north", measure_0: 24, __measure_cohort_0: 8, __cohort_size: 8 },
          { dimension_0: "small", measure_0: 2, __measure_cohort_0: 2, __cohort_size: 2 },
        ]
        : query.sql.includes("SUM(")
          ? [
          { time_bucket: "2026-07-06", measure_0: 10, __measure_cohort_0: 10, __cohort_size: 10 },
          { time_bucket: "2026-07-13", measure_0: 100, __measure_cohort_0: 2, __cohort_size: 2 },
          { time_bucket: "2026-07-20", measure_0: 20, __measure_cohort_0: 20, __cohort_size: 20 },
          ]
          : [
            { dimension_0: "north", measure_0: 8, __cohort_size: 8 },
            { dimension_0: "small", measure_0: 2, __cohort_size: 2 },
          ]);
    });
    const tenantLimits = {
      max_queries_per_session: 10_000,
      max_extracted_cells_per_session: 1_000_000,
      max_differencing_queries: 2_000,
      rate_limit_per_minute: 1_000,
      max_response_cells: 1_000_000,
    };
    const hmacKey = Buffer.from("shared-production-accounting-key-32-bytes-minimum");
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "streamable_http",
      mode: "production_http",
      env: {
        ...fixture.env,
        SYNAPSOR_TENANT_ID: "environment-tenant-must-not-win",
        SYNAPSOR_PRINCIPAL: "environment-principal-must-not-win",
      },
      store,
      sessionContext: {
        tenant_id: "tenant-from-jwt",
        principal: "principal-from-jwt",
        provenance: "http_claims",
      },
      productionPrivacyHmacKey: hmacKey,
      productionAccountingNamespace: "example.analytics.production",
      productionTenantLimits: tenantLimits,
      executor: { execute, executeBatch, close: async () => undefined },
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-08-04T13:00:00.000Z"),
    });
    try {
      expect(runtime.trusted_scope).toEqual({
        tenant: { source: "verified_http_claim", binding: "org_id" },
        principal: { source: "verified_http_claim", binding: "sub" },
      });
      await runtime.describe({ include_time_coverage: true });
      expect(execute).not.toHaveBeenCalled();
      expect(executeBatch).not.toHaveBeenCalled();

      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        top_n: 5,
      });
      expect(result).toMatchObject({
        ok: true,
        privacy: { suppressed_groups: 1 },
        source_database_changed: false,
      });
      expect((result as Record<string, unknown>).protect).toBeUndefined();
      expect(executeBatch).toHaveBeenCalledTimes(1);
      const compiled = executeBatch.mock.calls[0]![0].queries[0]!;
      expect(compiled.sql).toContain('t0."tenant_id" = $1');
      expect(compiled.sql).toContain('t0."account_id" = $2');
      expect(compiled.params.slice(0, 2)).toEqual(["tenant-from-jwt", "principal-from-jwt"]);
      expect(compiled.params[2]).toBe(fixture.boundary.budgets.max_groups + 1);
      const running = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ derived_measure: "revenue_running_total" }],
        time_bucket: { field: "churned_at", bucket: "week" },
        order_by: { kind: "time_bucket", direction: "asc" },
        top_n: 10,
      });
      expect(running).toMatchObject({
        data: [
          { time_bucket: "2026-07-06", revenue_running_total: 10 },
          { time_bucket: "2026-07-20", revenue_running_total: 30 },
        ],
        privacy: { suppressed_groups: 1 },
      });
      expect(executeBatch).toHaveBeenCalledTimes(2);
      expect(executeBatch.mock.calls[1]![0].queries[0]!.sql).not.toMatch(/\bOVER\s*\(|RUNNING_TOTAL/i);
      const childCount = await runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ derived_measure: "subscription_event_count" }],
        dimensions: [{ field: "region" }],
        top_n: 10,
      });
      expect(childCount).toMatchObject({
        data: [{ region: "north", subscription_event_count: 24 }],
        privacy: { suppressed_groups: 1 },
      });
      expect(executeBatch).toHaveBeenCalledTimes(3);
      const childQuery = executeBatch.mock.calls[2]![0].queries[0]!;
      expect(childQuery.sql).toContain('t0."tenant_id" = $1');
      expect(childQuery.sql).toContain('t0."account_id" = $2');
      expect(childQuery.sql).toContain('FROM "public"."subscription_events" fc0');
      expect(childQuery.sql).toContain('fc0."tenant_id" = $3');
      expect(childQuery.sql).toContain('fc0."account_id" = $4');
      expect(childQuery.sql).not.toMatch(/JOIN\s+"public"\."subscription_events"/i);
      expect(childQuery.params.slice(0, 4)).toEqual([
        "tenant-from-jwt",
        "principal-from-jwt",
        "tenant-from-jwt",
        "principal-from-jwt",
      ]);
      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        where: [{ field: "reason_category", op: "eq", value: "price" }],
        top_n: 1,
      })).resolves.toMatchObject({ ok: true });
      expect(claimPrivacy).toHaveBeenLastCalledWith(expect.objectContaining({
        principal_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        tenant_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        release_kind: "scalar_total",
        additional_releases: expect.arrayContaining([
          expect.objectContaining({
            release_kind: "scalar_total",
            conflict_reason: "scalar_filter_complement",
          }),
          expect.objectContaining({
            release_kind: "suppressed_grouping",
            conflict_reason: "scalar_filter_complement",
          }),
        ]),
      }));
      expect(claimBudget).toHaveBeenCalledWith(expect.objectContaining({
        principal_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        tenant_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        principal_limits: fixture.boundary.budgets,
        tenant_limits: {
          ...tenantLimits,
          max_response_cells: fixture.boundary.budgets.max_response_cells,
        },
      }));
      expect(claimPrivacy).toHaveBeenCalledWith(expect.objectContaining({
        principal_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        tenant_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        release_kind: "suppressed_grouping",
      }));
      expect(completeBudget).toHaveBeenCalledWith(expect.objectContaining({
        result_released: true,
      }));
      const durableAudit = JSON.stringify(store.listQueryAudit());
      expect(durableAudit).not.toContain("tenant-from-jwt");
      expect(durableAudit).not.toContain("principal-from-jwt");
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("serves an explicitly reviewed shared reference over production HTTP without a row-scope predicate", async () => {
    const fixture = await activatedSharedReferenceFixture({ production: true });
    const claimBudget = vi.fn(async () => ({
      allowed: true as const,
      principal_usage_after_reservation: {
        query_count: 1,
        queries_last_minute: 1,
        extracted_cells: 2,
        differencing_attempts: 1,
      },
      tenant_usage_after_reservation: {
        query_count: 1,
        queries_last_minute: 1,
        extracted_cells: 2,
        differencing_attempts: 1,
      },
      principal_variant_already_counted: false,
      tenant_variant_already_counted: false,
    }));
    const store = new ProposalStore();
    Object.assign(store, {
      claimProductionExploreBudgetReservation: claimBudget,
      completeProductionExploreBudgetReservation: vi.fn(async () => ({ completed: true as const })),
      claimProductionExplorePrivacyRelease: vi.fn(async () => ({ allowed: true as const })),
    });
    const executeBatch = vi.fn(async ({ queries, context }: Parameters<ScopedExploreExecutor["executeBatch"]>[0]) => {
      expect(context).toEqual({ tenant: "tenant-from-jwt", principal: "principal-from-jwt" });
      return queries.map(() => [
        { dimension_0: "north", measure_0: 8, __cohort_size: 8 },
      ]);
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "streamable_http",
      mode: "production_http",
      env: fixture.env,
      store,
      sessionContext: {
        tenant_id: "tenant-from-jwt",
        principal: "principal-from-jwt",
        provenance: "http_claims",
      },
      productionPrivacyHmacKey: Buffer.from("shared-production-accounting-key-32-bytes-minimum"),
      productionAccountingNamespace: "example.shared-reference.production",
      productionTenantLimits: {
        max_queries_per_session: 100,
        max_extracted_cells_per_session: 10_000,
        max_differencing_queries: 10,
        rate_limit_per_minute: 20,
        max_response_cells: 10_000,
      },
      executor: {
        execute: async () => [],
        executeBatch,
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
    });
    try {
      const resource = runtime.boundary.pack.resources[0]!;
      expect(resource.shared_reference_scope).toEqual({
        mode: "shared_reference",
        acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      });
      expect(resource.kept_out_fields).toContain("billing_token");

      await expect(runtime.explore({
        kind: "aggregate",
        resource: "public.subscriptions",
        measures: [{ function: "count" }],
        dimensions: [{ field: "region" }],
        top_n: 5,
      })).resolves.toMatchObject({ ok: true, source_database_changed: false });

      expect(executeBatch).toHaveBeenCalledTimes(1);
      const compiled = executeBatch.mock.calls[0]![0].queries[0]!;
      expect(compiled.sql).not.toContain("tenant_id");
      expect(compiled.sql).not.toContain("account_id");
      expect(compiled.params).not.toContain("tenant-from-jwt");
      expect(compiled.params).not.toContain("principal-from-jwt");
      expect(claimBudget).toHaveBeenCalledWith(expect.objectContaining({
        principal_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        tenant_scope_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }));
    } finally {
      await runtime.close();
      store.close();
    }
  });

  it("derives replica-stable opaque production budget scopes", async () => {
    const [firstFixture, secondFixture] = await Promise.all([
      activatedProductionFixture(),
      activatedProductionFixture(),
    ]);
    const seen: Array<{ principal: string; tenant: string }> = [];
    const create = async (root: string, inspection: SchemaInspection) => {
      const store = new ProposalStore();
      Object.assign(store, {
        claimProductionExploreBudgetReservation: vi.fn(async (input: Record<string, unknown>) => {
          seen.push({
            principal: String(input.principal_scope_fingerprint),
            tenant: String(input.tenant_scope_fingerprint),
          });
          return {
            allowed: true,
            principal_usage_after_reservation: { query_count: 1, queries_last_minute: 1, extracted_cells: 1, differencing_attempts: 0 },
            tenant_usage_after_reservation: { query_count: 1, queries_last_minute: 1, extracted_cells: 1, differencing_attempts: 0 },
            principal_variant_already_counted: false,
            tenant_variant_already_counted: false,
          };
        }),
        completeProductionExploreBudgetReservation: vi.fn(async () => ({ completed: true })),
        claimProductionExplorePrivacyRelease: vi.fn(async () => ({ allowed: true })),
      });
      const runtime = await createScopedExploreRuntime({
        projectRoot: root,
        transport: "streamable_http",
        mode: "production_http",
        env: { DATABASE_URL: "postgresql://unused.example.test/synapsor" },
        store,
        sessionContext: { tenant_id: "tenant-a", principal: "alice", provenance: "http_claims" },
        productionPrivacyHmacKey: Buffer.from("shared-production-accounting-key-32-bytes-minimum"),
        productionAccountingNamespace: "example.analytics.production",
        productionTenantLimits: {
          max_queries_per_session: 100,
          max_extracted_cells_per_session: 10_000,
          max_differencing_queries: 10,
          rate_limit_per_minute: 20,
          max_response_cells: 10_000,
        },
        executor: fixedExecutor([{ region: "north" }]),
        inspectDatabaseFn: async () => inspection,
      });
      await runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      });
      await runtime.close();
      store.close();
    };

    await create(firstFixture.root, firstFixture.inspection);
    await create(secondFixture.root, secondFixture.inspection);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });

  it("revalidates dependency drift before every call in a long-running authoring runtime", async () => {
    const fixture = await activatedFixture();
    let currentInspection = fixture.inspection;
    let sourceExecutions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => {
          sourceExecutions += 1;
          return [{ region: "north" }];
        },
        executeBatch: async ({ queries }) => queries.map(() => {
          sourceExecutions += 1;
          return [{ region: "north" }];
        }),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => currentInspection,
    });
    try {
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).resolves.toMatchObject({ source_database_changed: false });
      expect(sourceExecutions).toBe(1);

      const drifted = structuredClone(fixture.inspection);
      drifted.tables[0]!.columns = drifted.tables[0]!.columns.filter(
        (column) => column.name !== "region",
      );
      currentInspection = drifted;
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringContaining("public.subscriptions.region no longer exists"),
      });
      expect(sourceExecutions).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("runs an activated generated derived-scope resource and fails closed when its FK proof drifts", async () => {
    const fixture = await activatedDerivedScopeFixture();
    let currentInspection = fixture.inspection;
    const compiled: CompiledExploreQuery[][] = [];
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => {
          compiled.push(queries);
          return queries.map(() => [{ quantity: 2 }]);
        },
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => currentInspection,
    });
    try {
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.order_items",
        select: ["quantity"],
        limit: 1,
      })).resolves.toMatchObject({ source_database_changed: false });
      expect(compiled).toHaveLength(1);
      expect(compiled[0]?.[0]?.resources.map((resource) => resource.id))
        .toEqual(["public.order_items", "public.orders"]);
      expect(compiled[0]?.[0]?.sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM "public"\."orders"/);
      expect(compiled[0]?.[0]?.sql).toMatch(/st0_tenant_0\."tenant_id" = \$1/);

      const drifted = structuredClone(fixture.inspection);
      drifted.tables.find((table) => table.name === "order_items")!.columns
        .find((field) => field.name === "order_id")!.nullable = true;
      currentInspection = drifted;
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.order_items",
        select: ["quantity"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/derived tenant scope/i),
      });
      expect(compiled).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed before execution when a reviewed shared reference gains tenant-shaped schema", async () => {
    const fixture = await activatedSharedReferenceFixture();
    let currentInspection = fixture.inspection;
    let sourceExecutions = 0;
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map(() => {
          sourceExecutions += 1;
          return [{ region: "north" }];
        }),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => currentInspection,
    });
    try {
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).resolves.toMatchObject({ source_database_changed: false });
      expect(sourceExecutions).toBe(1);

      const drifted = structuredClone(fixture.inspection);
      drifted.tables[0]!.columns.splice(1, 0, column("tenant_id", "uuid", {
        tenant: true,
        immutable: true,
      }));
      drifted.tables[0]!.suggestions.tenant_columns = ["tenant_id"];
      currentInspection = drifted;
      await expect(runtime.explore({
        kind: "rows",
        resource: "public.subscriptions",
        select: ["region"],
        limit: 1,
      })).rejects.toMatchObject({
        code: "EXPLORE_LOCK_STALE",
        message: expect.stringMatching(/authority-bearing schema[\s\S]*No query was executed/i),
      });
      expect(sourceExecutions).toBe(1);
    } finally {
      await runtime.close();
    }
  });
});

function aggregatePlan(value: string) {
  return {
    kind: "aggregate",
    resource: "public.subscriptions",
    measures: [{ function: "count" }],
    dimensions: [{ field: "region" }],
    where: [{ field: "reason_category", op: "eq", value }],
    top_n: 3,
  };
}

function suggestedQuestionPlan(
  resource: string,
  question: Record<string, any>,
): Record<string, unknown> {
  const dimensions = (Array.isArray(question.dimensions)
    ? question.dimensions
    : [question.dimension])
    .filter(Boolean)
    .map((value: string | Record<string, unknown>) =>
      typeof value === "string" ? { field: value } : value);
  const time = question.time_field
    ? typeof question.time_field === "string"
      ? { field: question.time_field }
      : question.time_field
    : undefined;
  return {
    kind: "aggregate",
    resource,
    measures: [question.measure],
    ...(dimensions.length ? { dimensions } : {}),
    ...(time
      ? {
          time_bucket: {
            ...time,
            bucket: question.time_bucket ?? "week",
          },
        }
      : {}),
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
}

async function activatedFixture(
  narrow?: (candidate: ReturnType<typeof buildAutoBoundary>["exploration_boundary"]) => void,
  inspection = churnInspection(),
  minimumCohort?: 1 | 2 | 3 | 4,
  trustedScopeExposure?: "runner_only" | "model_visible",
  metadata?: {
    resource?: ReviewedMetadataDecision;
    fields?: Record<string, ReviewedMetadataDecision>;
    exact_numeric_grouping?: string[];
  },
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-explore-"));
  temporaryRoots.push(root);
  const reviewedResource = {
    ...(metadata?.resource ? { metadata: metadata.resource } : {}),
    ...(metadata?.fields ? { field_metadata: metadata.fields } : {}),
    ...(metadata?.exact_numeric_grouping
      ? {
        exact_numeric_grouping: Object.fromEntries(metadata.exact_numeric_grouping.map((field) => [
          field,
          {
            actor: "analytics-owner@example.test",
            reason: "This reviewed numeric field is a bounded, meaningful business dimension.",
            decided_at: "2026-08-19T00:00:00.000Z",
          },
        ])),
      }
      : {}),
    ...(minimumCohort
      ? {
        minimum_cohort: {
          value: minimumCohort,
          actor: "owner@example.test",
          reason: "Reviewed owner-controlled staging fixture.",
          decided_at: "2026-07-28T00:00:00.000Z",
        },
      }
      : {}),
    ...(trustedScopeExposure
      ? {
        fields: {
          tenant_id: {
            exposure: trustedScopeExposure === "runner_only"
              ? "withhold_from_model" as const
              : "allow_reviewed_use" as const,
            actor: "owner@example.test",
            reason: trustedScopeExposure === "runner_only"
              ? "Show trusted scope only in Runner's local verified result."
              : "Show the fixed trusted scope in the reviewed model result.",
            decided_at: "2026-07-28T00:00:00.000Z",
          },
        },
      }
      : {}),
  };
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: ["nextjs", "prisma"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    ...(minimumCohort || trustedScopeExposure || metadata
      ? {
        overrides: {
          schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
          resources: {
            "public.subscriptions": reviewedResource,
          },
        },
      }
      : {}),
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
  narrow?.(candidate);
  const digest = explorationBoundaryCandidateDigest(candidate);
  const boundary = await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "reviewer@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return {
    root,
    boundary,
    inspection,
    env: {
      DATABASE_URL: "postgresql://unused.example.test/synapsor",
      SYNAPSOR_TENANT_ID: "tenant-acme",
      SYNAPSOR_PRINCIPAL: "pm-1",
    },
  };
}

async function activatedDerivedScopeFixture(
  narrow?: (candidate: ReturnType<typeof buildAutoBoundary>["exploration_boundary"]) => void,
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-derived-scope-runtime-"));
  temporaryRoots.push(root);
  const inspection = derivedScopeInspection();
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: [],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    overrides: {
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources: {
        "public.order_items": {
          tenant_scope_path: {
            value: "order_items_order_id_fkey",
            actor: "owner@example.test",
            reason: "Every item belongs to the tenant of its required order.",
            decided_at: "2026-08-05T12:00:00.000Z",
          },
        },
      },
    },
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
  narrow?.(candidate);
  const digest = explorationBoundaryCandidateDigest(candidate);
  const boundary = await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "reviewer@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return {
    root,
    boundary,
    inspection,
    env: {
      DATABASE_URL: "postgresql://unused.example.test/synapsor",
      SYNAPSOR_TENANT_ID: "tenant-acme",
      SYNAPSOR_PRINCIPAL: "pm-1",
    },
  };
}

async function activatedProductionFixture(
  narrow?: (candidate: ReturnType<typeof buildAutoBoundary>["exploration_boundary"]) => void,
  sourceInspection = churnInspection(),
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-explore-"));
  temporaryRoots.push(root);
  const inspection = structuredClone(sourceInspection);
  for (const resource of inspection.tables) {
    if (!resource.columns.some((field) => field.name === "account_id")) {
      resource.columns.splice(2, 0, column("account_id", "uuid", { immutable: true }));
    }
    if (!resource.suggestions.default_visible_columns.includes("account_id")) {
      resource.suggestions.default_visible_columns.push("account_id");
    }
    resource.row_level_security_policies ??= [];
    resource.row_level_security_policies.push({
      name: `${resource.name}_principal_read`,
      command: "SELECT",
      permissive: true,
      roles: ["app_reader"],
      using_expression: "(account_id = current_setting('app.principal_id')::uuid)",
    });
  }
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: ["nextjs"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    deploymentProfile: "production",
    httpClaims: { tenantClaim: "org_id", principalClaim: "sub" },
    overrides: {
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources: Object.fromEntries(inspection.tables.map((resource) => [
        `${resource.schema}.${resource.name}`,
        {
          principal_key: {
            value: "account_id",
            actor: "production-owner@example.test",
            reason: "Each authenticated account may analyze only its own reviewed rows.",
            decided_at: "2026-08-04T12:00:00.000Z",
          },
        },
      ])),
    },
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
  narrow?.(candidate);
  const digest = explorationBoundaryCandidateDigest(candidate);
  const boundary = await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "production-owner@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return {
    root,
    boundary,
    inspection,
    env: { DATABASE_URL: "postgresql://unused.example.test/synapsor" },
  };
}

function productionFanOutInspection(): SchemaInspection {
  const inspection = churnInspection();
  const root = inspection.tables[0]!;
  const child = structuredClone(root);
  child.name = "subscription_events";
  child.columns = [
    column("id", "uuid", { immutable: true }),
    column("tenant_id", "uuid", { tenant: true, immutable: true }),
    column("subscription_id", "uuid", { immutable: true }),
    column("event_type", "text"),
  ];
  child.primary_key = ["id"];
  child.unique_constraints = [{ name: "subscription_events_pkey", columns: ["id"] }];
  child.check_constraints = [];
  child.foreign_keys = [{
    name: "subscription_events_subscription_id_fkey",
    columns: ["subscription_id"],
    referenced_schema: "public",
    referenced_table: "subscriptions",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  child.row_level_security_policies = [{
    name: "subscription_events_tenant_read",
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
  }];
  child.indexes = [
    { name: "subscription_events_pkey", columns: ["id"], unique: true },
    { name: "subscription_events_subscription_id_idx", columns: ["subscription_id"] },
  ];
  child.suggestions = {
    tenant_columns: ["tenant_id"],
    conflict_columns: [],
    sensitive_columns: [],
    default_visible_columns: ["id", "tenant_id", "subscription_id", "event_type"],
  };
  inspection.tables.push(child);
  return inspection;
}

async function activatedSharedReferenceFixture(
  options: { production?: boolean } = {},
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-shared-reference-"));
  temporaryRoots.push(root);
  const inspection = sharedReferenceInspection();
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: [],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    ...(options.production
      ? {
        deploymentProfile: "production" as const,
        httpClaims: { tenantClaim: "org_id", principalClaim: "sub" },
      }
      : {}),
    overrides: {
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources: {
        "public.subscriptions": {
          shared_reference_scope: {
            value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
            actor: "owner@example.test",
            reason: "This reference table is centrally maintained and has identical rows for every tenant.",
            decided_at: "2026-08-07T12:00:00.000Z",
          },
        },
      },
    },
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
  const digest = explorationBoundaryCandidateDigest(candidate);
  const boundary = await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "owner@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return {
    root,
    boundary,
    inspection,
    env: {
      DATABASE_URL: "postgresql://unused.example.test/synapsor",
      SYNAPSOR_TENANT_ID: "tenant-acme",
      SYNAPSOR_PRINCIPAL: "pm-1",
    },
  };
}

function relationshipInspection(): SchemaInspection {
  const inspection = churnInspection();
  inspection.tables[0]!.columns.splice(2, 0, column("region_id", "uuid", { immutable: true }));
  inspection.tables[0]!.foreign_keys = [{
    name: "subscriptions_region_id_fkey",
    columns: ["region_id"],
    referenced_schema: "public",
    referenced_table: "regions",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  inspection.tables.push({
    schema: "public",
    name: "regions",
    type: "table",
    writable: false,
    columns: [
      column("id", "uuid", { immutable: true }),
      column("tenant_id", "uuid", { tenant: true, immutable: true }),
      column("name", "text"),
      column("billing_token", "text", { sensitive: true }),
    ],
    primary_key: ["id"],
    unique_constraints: [{ name: "regions_pkey", columns: ["id"] }],
    foreign_keys: [],
    indexes: [{ name: "regions_pkey", columns: ["id"], unique: true }],
    row_level_security: true,
    row_level_security_policies: [{
      name: "regions_tenant_read",
      command: "SELECT",
      permissive: true,
      roles: ["app_reader"],
      using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
    }],
    role_posture: structuredClone(inspection.tables[0]!.role_posture),
    suggestions: {
      tenant_columns: ["tenant_id"],
      conflict_columns: [],
      sensitive_columns: ["billing_token"],
      default_visible_columns: ["id", "tenant_id", "name"],
    },
  });
  return inspection;
}

function starRelationshipInspection(): SchemaInspection {
  const inspection = relationshipInspection();
  const subscriptions = inspection.tables.find((table) => table.name === "subscriptions")!;
  const regions = inspection.tables.find((table) => table.name === "regions")!;
  subscriptions.columns.push(
    column("segment_id", "uuid", { immutable: true }),
    column("plan_id", "uuid", { immutable: true }),
    column("assigned_pm_id", "uuid", { immutable: true }),
  );
  subscriptions.foreign_keys.push({
    name: "subscriptions_segment_id_fkey",
    columns: ["segment_id"],
    referenced_schema: "public",
    referenced_table: "segments",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }, {
    name: "subscriptions_plan_id_fkey",
    columns: ["plan_id"],
    referenced_schema: "public",
    referenced_table: "plans",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  });
  subscriptions.row_level_security_policies!.push(principalPolicy("subscriptions_principal_read"));
  subscriptions.suggestions.default_visible_columns.push("segment_id", "assigned_pm_id");

  regions.columns.push(column("assigned_pm_id", "uuid", { immutable: true }));
  regions.row_level_security_policies!.push(principalPolicy("regions_principal_read"));
  regions.suggestions.default_visible_columns.push("assigned_pm_id");

  const segments = structuredClone(regions);
  segments.name = "segments";
  segments.row_level_security_policies = [
    structuredClone(regions.row_level_security_policies![0]!),
    principalPolicy("segments_principal_read"),
  ];
  segments.unique_constraints = [{ name: "segments_pkey", columns: ["id"] }];
  segments.indexes = [{ name: "segments_pkey", columns: ["id"], unique: true }];
  const plans = structuredClone(regions);
  plans.name = "plans";
  plans.row_level_security_policies = [
    structuredClone(regions.row_level_security_policies![0]!),
    principalPolicy("plans_principal_read"),
  ];
  plans.unique_constraints = [{ name: "plans_pkey", columns: ["id"] }];
  plans.indexes = [{ name: "plans_pkey", columns: ["id"], unique: true }];
  inspection.tables.push(segments, plans);
  return inspection;
}

function principalPolicy(name: string) {
  return {
    name,
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: "(assigned_pm_id = current_setting('app.principal_id')::uuid)",
  };
}

function derivedScopeBoundary(
  input: ActivatedExplorationBoundary,
): ActivatedExplorationBoundary {
  const boundary = structuredClone(input);
  const original = structuredClone(boundary.pack.resources[0]!);
  const orders = {
    ...original,
    id: "public.orders",
    table: "orders",
    relationships: [],
  };
  const scopeLink = {
    constraint_name: "order_items_order_id_fkey",
    source_resource: "public.order_items",
    target_resource: "public.orders",
    source_columns: ["order_id"],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: "orders_pkey",
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  };
  const { tenant_key: _tenantKey, principal_key: _principalKey, ...withoutDirectScope } = original;
  const orderItems = {
    ...withoutDirectScope,
    id: "public.order_items",
    table: "order_items",
    primary_key: "id",
    tenant_scope: {
      mode: "derived" as const,
      path_id: "order_items_order_id_fkey",
      ancestor_resource: "public.orders",
      ancestor_column: "tenant_id",
      proof: {
        source: "database_catalog" as const,
        links: [scopeLink],
        digest: canonicalJsonDigest([scopeLink]),
      },
    },
    field_types: {
      id: "uuid",
      order_id: "uuid",
      quantity: "integer",
      status: "text",
      created_at: "timestamp with time zone",
    },
    field_enums: { status: ["open", "closed"] },
    selectable_fields: ["id", "order_id", "quantity", "status", "created_at"],
    filterable_fields: {
      id: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
      order_id: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
      quantity: ["eq", "neq", "lt", "lte", "gt", "gte", "in"] as Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in">,
      status: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
      created_at: ["eq", "neq", "lt", "lte", "gt", "gte", "in"] as Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in">,
    },
    sortable_fields: ["id", "order_id", "quantity", "status", "created_at"],
    groupable_fields: ["status"],
    aggregate_measures: ["quantity"],
    aggregate_measure_functions: { quantity: ["sum", "avg"] as Array<"sum" | "avg"> },
    count_distinct_fields: ["id", "order_id"],
    time_bucket_fields: { created_at: ["day", "week", "month"] as Array<"day" | "week" | "month"> },
    kept_out_fields: [],
    relationships: [],
  };
  boundary.pack.resources = [orders, orderItems];
  return boundary;
}

function depthThreeScopeBoundary(
  input: ActivatedExplorationBoundary,
): ActivatedExplorationBoundary {
  type Resource = ActivatedExplorationBoundary["pack"]["resources"][number];
  type Scope = NonNullable<Resource["tenant_scope"]>;
  type Link = Scope["proof"]["links"][number];

  const boundary = structuredClone(input);
  boundary.budgets.max_derived_scope_hops = 3;
  boundary.budgets.max_analysis_relationship_hops = 3;
  const template = structuredClone(boundary.pack.resources[0]!);
  const link = (
    constraintName: string,
    sourceResource: string,
    targetResource: string,
    sourceColumn: string,
  ): Link => ({
    constraint_name: constraintName,
    source_resource: sourceResource,
    target_resource: targetResource,
    source_columns: [sourceColumn],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key",
      name: `${targetResource.split(".").at(-1)}_pkey`,
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one",
    max_fan_out: 1,
  });
  const links = [
    link(
      "event_notes_order_event_id_fkey",
      "public.event_notes",
      "public.order_events",
      "order_event_id",
    ),
    link(
      "order_events_order_item_id_fkey",
      "public.order_events",
      "public.order_items",
      "order_item_id",
    ),
    link(
      "order_items_order_id_fkey",
      "public.order_items",
      "public.orders",
      "order_id",
    ),
  ];
  const derivedScope = (path: Link[], kind: "tenant" | "principal"): Scope => ({
    mode: "derived",
    path_id: path.map((candidate) => candidate.constraint_name).join("__"),
    ancestor_resource: "public.orders",
    ancestor_column: kind === "tenant" ? "tenant_id" : "id",
    proof: {
      source: "database_catalog",
      links: structuredClone(path),
      digest: canonicalJsonDigest(path),
    },
  });
  const derivedResource = (inputResource: {
    id: string;
    table: string;
    foreignKey: string;
    path: Link[];
    labelField: string;
  }): Resource => {
    const resource = structuredClone(template);
    resource.id = inputResource.id;
    resource.table = inputResource.table;
    resource.primary_key = "id";
    delete resource.tenant_key;
    delete resource.principal_key;
    delete resource.shared_reference_scope;
    resource.tenant_scope = derivedScope(inputResource.path, "tenant");
    resource.principal_scope = derivedScope(inputResource.path, "principal");
    resource.field_types = {
      id: "uuid",
      [inputResource.foreignKey]: "uuid",
      [inputResource.labelField]: "text",
    };
    resource.field_enums = {};
    resource.selectable_fields = ["id", inputResource.foreignKey, inputResource.labelField];
    resource.model_withheld_fields = [];
    resource.filterable_fields = {
      [inputResource.labelField]: ["eq", "neq", "in"],
    };
    resource.sortable_fields = ["id", inputResource.labelField];
    resource.groupable_fields = [inputResource.labelField];
    resource.aggregate_measures = [];
    resource.aggregate_measure_functions = {};
    resource.count_distinct_fields = ["id"];
    resource.time_bucket_fields = {};
    resource.kept_out_fields = [];
    resource.relationships = [];
    delete resource.numeric_bands;
    delete resource.auto_bands;
    delete resource.derived_measures;
    return resource;
  };

  const orders = structuredClone(template);
  orders.id = "public.orders";
  orders.table = "orders";
  orders.primary_key = "id";
  orders.tenant_key = "tenant_id";
  orders.principal_key = "id";
  delete orders.tenant_scope;
  delete orders.principal_scope;
  delete orders.shared_reference_scope;
  orders.field_types = { id: "uuid", tenant_id: "uuid", region: "text" };
  orders.field_enums = {};
  orders.selectable_fields = ["id", "tenant_id", "region"];
  orders.model_withheld_fields = [];
  orders.filterable_fields = { region: ["eq", "neq", "in"] };
  orders.sortable_fields = ["id", "region"];
  orders.groupable_fields = ["region"];
  orders.aggregate_measures = [];
  orders.aggregate_measure_functions = {};
  orders.count_distinct_fields = ["id"];
  orders.time_bucket_fields = {};
  orders.kept_out_fields = [];
  orders.relationships = [];
  delete orders.numeric_bands;
  delete orders.auto_bands;
  delete orders.derived_measures;

  const orderItems = derivedResource({
    id: "public.order_items",
    table: "order_items",
    foreignKey: "order_id",
    path: links.slice(2),
    labelField: "product",
  });
  const orderEvents = derivedResource({
    id: "public.order_events",
    table: "order_events",
    foreignKey: "order_item_id",
    path: links.slice(1),
    labelField: "event_type",
  });
  const eventNotes = derivedResource({
    id: "public.event_notes",
    table: "event_notes",
    foreignKey: "order_event_id",
    path: links,
    labelField: "note_type",
  });
  const pathId = links.map((candidate) => candidate.constraint_name).join("__");
  eventNotes.relationships = [{
    id: pathId,
    target_resource: "public.orders",
    local_columns: ["order_event_id"],
    target_columns: ["id"],
    counted_entity: "id",
    cardinality: "many_to_one",
    max_fan_out: 1,
    path_depth: 3,
    proof: {
      source: "database_catalog",
      links: structuredClone(links),
      digest: canonicalJsonDigest(links),
    },
    nullable: false,
    unmatched_rows: "exclude",
  }];
  boundary.pack.resources = [eventNotes, orderEvents, orderItems, orders];
  return boundary;
}

function derivedTargetBoundary(
  input: ActivatedExplorationBoundary,
): ActivatedExplorationBoundary {
  const boundary = derivedScopeBoundary(input);
  const orders = boundary.pack.resources.find((resource) => resource.id === "public.orders")!;
  const original = structuredClone(orders);
  const catalogs = {
    ...structuredClone(original),
    id: "public.catalogs",
    table: "catalogs",
    relationships: [],
  };
  const scopeLink = {
    constraint_name: "products_catalog_id_fkey",
    source_resource: "public.products",
    target_resource: "public.catalogs",
    source_columns: ["catalog_id"],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: "catalogs_pkey",
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  };
  const { tenant_key: _tenantKey, principal_key: _principalKey, ...withoutDirectScope } = original;
  const products = {
    ...withoutDirectScope,
    id: "public.products",
    table: "products",
    tenant_scope: {
      mode: "derived" as const,
      path_id: "products_catalog_id_fkey",
      ancestor_resource: "public.catalogs",
      ancestor_column: "tenant_id",
      proof: {
        source: "database_catalog" as const,
        links: [scopeLink],
        digest: canonicalJsonDigest([scopeLink]),
      },
    },
    field_types: { id: "uuid", catalog_id: "uuid", name: "text" },
    field_enums: {},
    selectable_fields: ["id", "catalog_id", "name"],
    filterable_fields: {
      id: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
      catalog_id: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
      name: ["eq", "neq", "in"] as Array<"eq" | "neq" | "in">,
    },
    sortable_fields: ["id", "catalog_id", "name"],
    groupable_fields: ["name"],
    aggregate_measures: [],
    count_distinct_fields: ["id", "catalog_id"],
    time_bucket_fields: {},
    kept_out_fields: [],
    relationships: [],
  };
  const relationshipLink = {
    constraint_name: "orders_featured_product_id_fkey",
    source_resource: "public.orders",
    target_resource: "public.products",
    source_columns: ["featured_product_id"],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: "products_pkey",
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  };
  orders.field_types.featured_product_id = "uuid";
  orders.selectable_fields.push("featured_product_id");
  orders.relationships = [{
    id: "orders_featured_product_id_fkey",
    target_resource: "public.products",
    local_columns: ["featured_product_id"],
    target_columns: ["id"],
    counted_entity: orders.primary_key,
    cardinality: "many_to_one",
    max_fan_out: 1,
    path_depth: 1,
    proof: {
      source: "database_catalog",
      links: [relationshipLink],
      digest: canonicalJsonDigest([relationshipLink]),
    },
    nullable: false,
    unmatched_rows: "exclude",
  }];
  boundary.pack.resources = [orders, products, catalogs];
  return boundary;
}

function fixedExecutor(rows: Record<string, unknown>[]): ScopedExploreExecutor {
  return {
    execute: async () => structuredClone(rows),
    executeBatch: async ({ queries }) => queries.map(() => structuredClone(rows)),
    close: async () => undefined,
  };
}

function complementAttackExecutor(): ScopedExploreExecutor {
  return {
    execute: async () => [],
    executeBatch: async ({ queries }) => queries.map((query) =>
      /\bGROUP BY\b/i.test(query.sql)
        ? [
            { dimension_0: "visible", measure_0: 10, __cohort_size: 10 },
            { dimension_0: "withheld", measure_0: 2, __cohort_size: 2 },
          ]
        : [{ measure_0: 12, __cohort_size: 12 }]),
    close: async () => undefined,
  };
}

async function rewriteActiveBoundary(
  root: string,
  mutate: (active: Record<string, any>) => void,
): Promise<void> {
  const activePath = path.join(root, ".synapsor/exploration-boundary.active.json");
  const active = JSON.parse(await fs.readFile(activePath, "utf8")) as Record<string, any>;
  mutate(active);
  const { activation: _activation, ...activeAuthority } = active;
  active.activation.digest = canonicalJsonDigest({
    ...activeAuthority,
    activation: "reviewed",
  });
  await fs.writeFile(activePath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
  const setPath = path.join(root, ".synapsor/exploration-boundaries.active.json");
  try {
    const set = JSON.parse(await fs.readFile(setPath, "utf8")) as Record<string, any>;
    set.boundaries = (set.boundaries as Array<Record<string, any>>).map((boundary) =>
      boundary.pack?.name === active.pack?.name ? active : boundary);
    set.selected_name = active.pack.name;
    await fs.writeFile(setPath, `${JSON.stringify(set, null, 2)}\n`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function derivedScopeInspection(): SchemaInspection {
  const inspection = churnInspection();
  const orders = structuredClone(inspection.tables[0]!);
  orders.name = "orders";
  orders.unique_constraints = [{ name: "orders_pkey", columns: ["id"] }];
  orders.indexes = [{ name: "orders_pkey", columns: ["id"], unique: true }];

  const orderItems = structuredClone(orders);
  orderItems.name = "order_items";
  orderItems.columns = orderItems.columns.filter((field) => field.name !== "tenant_id");
  orderItems.columns.push(column("order_id", "uuid", { immutable: true }));
  orderItems.columns.push(column("quantity", "integer"));
  orderItems.unique_constraints = [{ name: "order_items_pkey", columns: ["id"] }];
  orderItems.indexes = [{ name: "order_items_pkey", columns: ["id"], unique: true }];
  orderItems.foreign_keys = [{
    name: "order_items_order_id_fkey",
    columns: ["order_id"],
    referenced_schema: "public",
    referenced_table: "orders",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  orderItems.row_level_security = false;
  orderItems.row_level_security_policies = [];
  if (!orderItems.role_posture) throw new Error("derived-scope fixture role posture is required");
  orderItems.role_posture.row_security_forced = false;
  orderItems.role_posture.row_security_effective_for_current_role = false;
  orderItems.suggestions.tenant_columns = [];
  orderItems.suggestions.default_visible_columns = orderItems.suggestions.default_visible_columns
    .filter((field) => field !== "tenant_id")
    .concat("order_id", "quantity");
  inspection.tables = [orderItems, orders];
  return inspection;
}

function churnInspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [{
      schema: "public",
      name: "subscriptions",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid", { immutable: true }),
        column("tenant_id", "uuid", { tenant: true, immutable: true }),
        column("region", "text"),
        column("reason_category", "text"),
        column("churned_at", "timestamp with time zone"),
        column("monthly_revenue_cents", "integer"),
        column("billing_token", "text", { sensitive: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "subscriptions_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "subscriptions_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_read",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        row_security_forced: true,
        row_security_effective_for_current_role: true,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: ["billing_token"],
        default_visible_columns: ["id", "tenant_id", "region", "reason_category", "churned_at", "monthly_revenue_cents"],
      },
    }],
  };
}

function exactNumericGroupingInspection(): SchemaInspection {
  const inspection = churnInspection();
  inspection.tables[0]!.columns.push(
    column("started_year", "integer"),
    column("commissioned_on", "date"),
  );
  inspection.tables[0]!.suggestions.default_visible_columns.push("started_year", "commissioned_on");
  return inspection;
}

function quotedIdentifierInspection(): SchemaInspection {
  const inspection = churnInspection();
  const table = inspection.tables[0]!;
  table.name = "select";
  const renamedFields = new Map([
    ["region", "caf\u00e9_count"],
    ["monthly_revenue_cents", "total amount"],
  ]);
  table.columns = table.columns.map((field) => ({
    ...field,
    name: renamedFields.get(field.name) ?? field.name,
  }));
  table.columns.push(column('quote"field', "text"), column("back`tick", "text"));
  table.suggestions.default_visible_columns = table.suggestions.default_visible_columns
    .map((field) => renamedFields.get(field) ?? field)
    .concat('quote"field', "back`tick");
  return inspection;
}

function sharedReferenceInspection(): SchemaInspection {
  const inspection = churnInspection();
  const resource = inspection.tables[0]!;
  resource.columns = resource.columns.filter((field) => field.name !== "tenant_id");
  resource.suggestions.tenant_columns = [];
  resource.suggestions.default_visible_columns = resource.suggestions.default_visible_columns
    .filter((field) => field !== "tenant_id");
  resource.row_level_security = false;
  resource.row_level_security_policies = [];
  if (!resource.role_posture) throw new Error("shared-reference fixture role posture is required");
  resource.role_posture.row_security_forced = false;
  resource.role_posture.row_security_effective_for_current_role = false;
  return inspection;
}

function column(
  name: string,
  dataType: string,
  overrides: Partial<{ tenant: boolean; sensitive: boolean; immutable: boolean }> = {},
) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: overrides.tenant ?? false,
      conflict: false,
      sensitive: overrides.sensitive ?? false,
      immutable: overrides.immutable ?? false,
      large_or_binary: false,
    },
  };
}
