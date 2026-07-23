import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
} from "./auto-boundary.js";
import {
  compileExplorePlan,
  createScopedExploreRuntime,
  loadProtectedPlan,
  prepareScopedExplore,
  ScopedExploreError,
  validateExplorePlan,
  type ScopedExploreExecutor,
} from "./scoped-explore.js";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Scoped Explore", () => {
  it("advertises exactly two local read-only authoring tools through the official MCP client", async () => {
    const { boundary } = await activatedFixture();
    const runtime = {
      boundary,
      session_fingerprint: "sha256:test" as const,
      describe: () => ({ ok: true, resources: [] }),
      explore: async () => ({ ok: true, source_database_changed: false }),
      close: async () => undefined,
    };
    const server = createScopedExploreMcpServer(runtime);
    const client = new Client({ name: "scoped-explore-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["app.describe_data", "app.explore_data"]);
      expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(listed.tools.map((tool) => tool.name).join(" ")).not.toMatch(/execute_sql|approve|apply|commit/i);
      const called = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.subscriptions",
            select: ["region"],
            limit: 1,
          },
        },
      });
      expect(called.isError).not.toBe(true);
      expect(JSON.stringify(called)).toContain('"source_database_changed":false');
    } finally {
      await client.close();
      await server.close();
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

  it("compiles bounded PM aggregates without raw SQL or unreviewed dimensions", async () => {
    const { boundary } = await activatedFixture();
    expect(() => validateExplorePlan({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "billing_token" }],
      top_n: 10,
    }, boundary)).toThrow(/not reviewed for group/i);

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
      expect(query.sql).toContain("date_trunc('week', t0.\"churned_at\")");
      expect(query.sql).toContain("COUNT(*) AS \"__cohort_size\"");
      expect(query.sql).not.toContain("price");
      expect(query.sql).not.toContain("tenant-acme");
      expect(query.params.at(-1)).toBe(boundary.budgets.max_groups + 1);
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
        dimension_0: "north",
        time_bucket: "2026-06-02T00:00:00.000Z",
        measure_0: 8,
      }]);
      expect(result).toMatchObject({
        source_database_changed: false,
        untrusted_data: true,
        privacy: { suppressed_groups: 1, totals_returned: false },
      });

      const auditText = JSON.stringify(store.listQueryAudit());
      expect(auditText).not.toContain("private-literal");
      expect(auditText).not.toContain("tenant-acme");
      expect(auditText).not.toContain("pm-1");
      expect(auditText).not.toContain("north");
      expect(auditText).not.toContain("rare-secret-region");
      expect(auditText).toContain("keyed_hash");

      const protect = result.protect as { token: string };
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
    })).rejects.toMatchObject({ code: "EXPLORE_LOCK_STALE" });

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
    });
    await overflowRuntime.close();
    const refusalStore = new ProposalStore(path.join(fixture.root, ".synapsor/local.db"));
    expect(refusalStore.listQueryAudit().some((record) =>
      (record.payload as Record<string, unknown>).status === "refused_privacy_boundary"
      && (record.payload as Record<string, unknown>).result_values_persisted === false
    )).toBe(true);
    refusalStore.close();

    const budgetRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ dimension_0: "a", measure_0: 10, __cohort_size: 10 }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    await budgetRuntime.explore(aggregatePlan("one"));
    await budgetRuntime.explore(aggregatePlan("two"));
    await expect(budgetRuntime.explore(aggregatePlan("three"))).rejects.toMatchObject({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
    });
    await budgetRuntime.close();
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
    await expect(prepareScopedExplore({
      projectRoot: missingRoot,
      transport: "stdio",
      env: {},
      inspectDatabaseFn: async () => churnInspection(),
    })).rejects.toMatchObject({ code: "EXPLORE_DISABLED" });

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
    })).rejects.toMatchObject({ code: "EXPLORE_RATE_LIMITED" });
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
    })).rejects.toMatchObject({ code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED" });
    await extraction.close();

    const failed = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => {
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

async function activatedFixture(
  narrow?: (candidate: ReturnType<typeof buildAutoBoundary>["exploration_boundary"]) => void,
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-explore-"));
  temporaryRoots.push(root);
  const inspection = churnInspection();
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

function fixedExecutor(rows: Record<string, unknown>[]): ScopedExploreExecutor {
  return {
    execute: async () => structuredClone(rows),
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
  active.activation.digest = canonicalJsonDigest({
    schema_version: active.schema_version,
    activation: "reviewed",
    deployment_profile: active.deployment_profile,
    source: active.source,
    compiler_version: active.compiler_version,
    spec_version: active.spec_version,
    trusted_context: active.trusted_context,
    generation_lock_fingerprint: active.generation_lock_fingerprint,
    role_posture_fingerprint: active.role_posture_fingerprint,
    pack: active.pack,
    budgets: active.budgets,
  });
  await fs.writeFile(activePath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
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
