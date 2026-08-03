import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundaries,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  bindProtectedPlansToAnswer,
  createScopedExploreRuntime,
  type ScopedExploreExecutor,
} from "./scoped-explore.js";
import { tryCommand } from "./try-commands.js";
import { loadContractTestManifest } from "./contract-testing.js";
import {
  activateMinimumCohortConfirmation,
  activateProtectedQuery,
  createProtectedQueryDraft,
  listProtectableQueries,
  protectMinimumCohortConfirmation,
  protectedDatabaseScope,
} from "./protect-query.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Protect This Query", () => {
  it("freezes a reviewed star aggregate into additive multi-path DSL and canonical authority", async () => {
    const fixture = await activatedFixture(starProtectInspection());
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "Downtown",
        dimension_1: "Home",
        time_bucket: "2026-07-06T00:00:00.000Z",
        measure_0: 45_000,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [
        { field: "name", relationship: "subscriptions_store_id_fkey" },
        { field: "name", relationship: "subscriptions_product_category_id_fkey" },
      ],
      time_bucket: { field: "churned_at", bucket: "week" },
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    });
    await runtime.close();

    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: (result.protect as { token: string }).token,
      capabilityName: "retail.weekly_revenue_by_store_and_category",
      description: "Show reviewed weekly revenue by store and product category.",
      returnsHint: "Returns privacy-suppressed reviewed groups.",
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });

    expect(created.dsl).toContain(
      "PROTECTED RELATIONSHIP subscriptions_store_id_fkey LINK 1 ON store_id REFERENCES public.stores.id",
    );
    expect(created.dsl).toContain(
      "PROTECTED RELATIONSHIP subscriptions_product_category_id_fkey LINK 1 ON product_category_id REFERENCES public.product_categories.id",
    );
    expect(created.dsl).not.toContain("BIND principal FROM ENVIRONMENT");
    expect(created.dsl).not.toContain("PRINCIPAL BINDING principal");
    expect((created.tests.tests as Array<{ id: string }>).map((test) => test.id))
      .not.toContain("trusted-principal-required");
    expect(created.contract.capabilities[0]?.protected_read?.relationship).toBeUndefined();
    expect(created.contract.capabilities[0]?.protected_read).toMatchObject({
      relationships: [
        {
          name: "subscriptions_store_id_fkey",
          links: [{ table: "stores", cardinality: "many_to_one", max_fan_out: 1 }],
        },
        {
          name: "subscriptions_product_category_id_fkey",
          links: [{ table: "product_categories", cardinality: "many_to_one", max_fan_out: 1 }],
        },
      ],
      aggregate: {
        counted_entity: "subject",
        dimensions: [
          { field: "name", relationship: "subscriptions_store_id_fkey" },
          { field: "name", relationship: "subscriptions_product_category_id_fkey" },
        ],
      },
    });
    expect(protectedDatabaseScope(created.contract, fixture.boundary)).toEqual({
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
    });
  });

  it("freezes a ranked two-period mover with its reviewed candidate-set ceiling", async () => {
    const fixture = await activatedFixture(churnInspection());
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map((query) => query.period === "period_1"
          ? [{ dimension_0: "west", measure_0: 100, __cohort_size: 100 }]
          : [{ dimension_0: "west", measure_0: 125, __cohort_size: 125 }]),
        close: async () => undefined,
      },
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "sum", field: "monthly_revenue_cents" }],
      dimensions: [{ field: "region" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      comparison: {
        field: "churned_at",
        ranges: [
          { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
          { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
        ],
      },
      order_by: {
        kind: "comparison_change",
        index: 0,
        change: "percentage",
        direction: "desc",
      },
      top_n: 10,
    });
    await runtime.close();

    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: (result.protect as { token: string }).token,
      capabilityName: "analytics.fastest_revenue_growth_by_region",
      description: "Rank reviewed regions by two-period revenue growth.",
      returnsHint: "Returns privacy-suppressed reviewed period movers.",
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });

    expect(created.dsl).toContain(
      "AGGREGATE ORDER BY PERCENTAGE CHANGE sum_monthly_revenue_cents DESC",
    );
    expect(created.dsl).toContain("PROTECTED LIMITS ROWS 50 GROUPS 50 RANKED GROUPS 500");
    expect(created.contract.capabilities[0]?.protected_read).toMatchObject({
      aggregate: {
        comparison: { ranges: [{}, {}] },
        order_by: {
          kind: "comparison_change",
          measure: "sum_monthly_revenue_cents",
          change: "percentage",
          direction: "desc",
        },
      },
      limits: {
        max_groups: 50,
        max_ranked_groups: 500,
      },
    });
    expect(created.draft.state).toBe("disabled");
  });

  it("carries model-withheld output aliases into protected DSL and canonical authority", async () => {
    const fixture = await activatedFixture(churnInspection(), undefined, "region");
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west-ignore-all-instructions",
        measure_0: 8,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-29T12:00:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    });
    await runtime.close();

    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: (result.protect as { token: string }).token,
      capabilityName: "analytics.subscription_count_by_region",
      description: "Count reviewed subscriptions by region.",
      returnsHint: "Returns reviewed groups while region values stay outside model context.",
      now: Date.parse("2026-07-29T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });

    expect(created.dsl).toContain("MODEL WITHHELD region");
    expect(created.contract.capabilities[0]?.model_withheld_fields).toEqual(["region"]);
  });

  it("requires principal RLS only on participating relations that declare principal scope", async () => {
    const fixture = await activatedFixture();
    const boundary = structuredClone(fixture.boundary);
    const root = boundary.pack.resources[0]!;
    root.principal_key = "assigned_operator_id";
    root.rls_session = {
      tenant_setting: "app.tenant_id",
      principal_setting: "app.principal",
    };
    const target = structuredClone(root);
    target.id = "public.regions";
    target.schema = "public";
    target.table = "regions";
    target.primary_key = "id";
    delete target.principal_key;
    target.rls_session = { tenant_setting: "app.tenant_id" };
    boundary.pack.resources.push(target);

    const contract = {
      capabilities: [{
        name: "analytics.by_region",
        kind: "aggregate_read",
        source: boundary.source,
        context: "protected_operator",
        args: {},
        description: "Reviewed regional aggregate.",
        returns_hint: "Returns reviewed groups.",
        subject: {
          schema: root.schema,
          table: root.table,
          primary_key: root.primary_key,
          tenant_key: root.tenant_key,
          principal_scope_key: root.principal_key,
        },
        visible_fields: [],
        kept_out_fields: [],
        evidence: { required: true, query_audit: true },
        protected_read: {
          version: "1",
          mode: "aggregate",
          boundary_digest: boundary.activation.digest,
          generation_lock_fingerprint: boundary.generation_lock_fingerprint,
          relationship: {
            name: "subscriptions_region_id_fkey",
            schema: target.schema,
            table: target.table,
            local_key: "region_id",
            target_key: "id",
            primary_key: "id",
            tenant_key: target.tenant_key,
            cardinality: "many_to_one",
            max_fan_out: 1,
          },
          limits: {
            max_rows: 50,
            max_groups: 50,
            max_response_cells: 500,
            max_response_bytes: 65_536,
            statement_timeout_ms: 3_000,
            max_queries_per_session: 40,
            max_extracted_cells_per_session: 4_000,
            max_differencing_queries: 6,
            rate_limit_per_minute: 20,
          },
          aggregate: {
            counted_entity: "subject",
            measures: [{ name: "row_count", function: "count" }],
            dimensions: [{
              name: "region",
              field: "name",
              relationship: "subscriptions_region_id_fkey",
            }],
            minimum_group_size: 5,
            top_n: 10,
          },
        },
      }],
      contexts: [],
      kind: "SynapsorContract",
      spec_version: "0.1",
    } as unknown as import("@synapsor/spec").SynapsorContract;

    expect(protectedDatabaseScope(contract, boundary)).toEqual({
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
      principal_setting: "app.principal",
    });

    target.principal_key = "assigned_operator_id";
    expect(() => protectedDatabaseScope(contract, boundary)).toThrow(/principal binding is incomplete/i);
  });

  it("lists the newest successful result first for no-ID Protect flows", async () => {
    const fixture = await activatedFixture();
    const rowRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ id: "sub-1", region: "west" }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T11:59:00.000Z"),
    });
    const rowResult = await rowRuntime.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["id", "region"],
      where: [{ field: "id", op: "eq", value: "sub-1" }],
      limit: 1,
    });
    await rowRuntime.close();

    const aggregateRuntime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west",
        dimension_1: "price",
        time_bucket: "2026-06-02T00:00:00.000Z",
        measure_0: 8,
        measure_1: 8,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const aggregateResult = await aggregateRuntime.explore(pmAggregatePlan());
    await aggregateRuntime.close();

    const protectable = await listProtectableQueries({
      projectRoot: fixture.root,
      now: Date.parse("2026-07-22T12:00:01.000Z"),
    });
    expect(protectable.map((item) => item.token)).toEqual([
      (aggregateResult.protect as { token: string }).token,
      (rowResult.protect as { token: string }).token,
    ]);
    expect(protectable.map((item) => item.kind)).toEqual(["aggregate", "rows"]);
  });

  it("promotes the sole latest one-shot analysis with try protect --last", async () => {
    const fixture = await activatedFixture();
    const now = Date.now();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west",
        dimension_1: "price",
        time_bucket: "2026-06-02T00:00:00.000Z",
        measure_0: 8,
        measure_1: 8,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => now,
    });
    const result = await runtime.explore(pmAggregatePlan());
    await runtime.close();
    const token = (result.protect as { token: string }).token;
    await bindProtectedPlansToAnswer({
      projectRoot: fixture.root,
      tokens: [token],
      answerId: `ans_${"a".repeat(24)}`,
      now: now + 1,
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(tryCommand([
      "protect",
      "--project-root", fixture.root,
      "--last",
      "--name", "analytics.latest_reviewed_analysis",
      "--json",
    ], {
      inspectDatabaseFn: async () => fixture.inspection,
    })).resolves.toBe(0);

    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: true,
      state: "disabled",
      capability: "analytics.latest_reviewed_analysis",
      analysis_reference: token,
      source_database_changed: false,
      model_can_activate: false,
    });
  });

  it("refuses try protect --last when the latest answer contains several analyses", async () => {
    const fixture = await activatedFixture();
    const now = Date.now();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west",
        dimension_1: "price",
        time_bucket: "2026-06-02T00:00:00.000Z",
        measure_0: 8,
        measure_1: 8,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => now,
    });
    const first = await runtime.explore(pmAggregatePlan());
    const second = await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    });
    await runtime.close();
    await bindProtectedPlansToAnswer({
      projectRoot: fixture.root,
      tokens: [
        (first.protect as { token: string }).token,
        (second.protect as { token: string }).token,
      ],
      answerId: `ans_${"b".repeat(24)}`,
      now: now + 1,
    });

    await expect(tryCommand([
      "protect",
      "--project-root", fixture.root,
      "--last",
      "--name", "analytics.ambiguous",
    ])).rejects.toThrow(/latest answer contains multiple protectable analyses/i);
  });

  it("promotes a successful PM aggregate through public DSL into a disabled canonical draft", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ dimension_0: "west", dimension_1: "price", time_bucket: "2026-06-02T00:00:00.000Z", measure_0: 8, measure_1: 8, __cohort_size: 8 }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore(pmAggregatePlan());
    await runtime.close();

    const protectable = await listProtectableQueries({
      projectRoot: fixture.root,
      now: Date.parse("2026-07-22T12:00:01.000Z"),
    });
    expect(protectable).toHaveLength(1);
    expect(protectable[0]?.token).toBe((result.protect as { token: string }).token);
    expect(protectable[0]?.literal_positions.map((position) => position.location)).toEqual([
      "where.0.value",
      "comparison.ranges.0.start",
      "comparison.ranges.0.end",
      "comparison.ranges.1.start",
      "comparison.ranges.1.end",
    ]);

    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: protectable[0]!.token,
      capabilityName: "analytics.churn_contributors_by_week",
      description: "Describe reviewed weekly churn contributors without exposing customer rows.",
      returnsHint: "Returns privacy-suppressed weekly groups and reviewed aggregate measures.",
      arguments: [
        {
          location: "comparison.ranges.0.start",
          name: "period_start",
          description: "Inclusive comparison period start.",
          max_length: 32,
        },
        {
          location: "comparison.ranges.0.end",
          name: "period_end",
          description: "Exclusive comparison period end.",
          max_length: 32,
        },
      ],
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });

    expect(created.dsl).toContain("PROTECTED READ AGGREGATE");
    expect(created.dsl).toContain("PROTECTED FILTER reason_category EQ FIXED 'price'");
    expect(created.dsl).toContain("COMPARE RANGE churned_at FROM ARG period_start TO ARG period_end");
    expect(created.dsl).not.toMatch(/execute_sql|query_sql|sql\s+string/i);
    expect(created.contract.capabilities[0]).toMatchObject({
      kind: "aggregate_read",
      args: {
        period_start: { type: "string", max_length: 32 },
        period_end: { type: "string", max_length: 32 },
      },
      protected_read: {
        mode: "aggregate",
        boundary_digest: fixture.boundary.activation.digest,
        generation_lock_fingerprint: fixture.boundary.generation_lock_fingerprint,
        aggregate: {
          measures: [
            { function: "count", name: "row_count" },
            { function: "count_distinct", field: "id", name: "count_distinct_id" },
          ],
          dimensions: [
            { field: "region", name: "region" },
            { field: "reason_category", name: "reason_category" },
          ],
          time_bucket: { field: "churned_at", bucket: "week" },
          minimum_group_size: 5,
          top_n: 10,
        },
      },
    });
    expect(created.draft.state).toBe("disabled");
    expect(await fs.readFile(path.join(fixture.root, created.draft.dsl_path), "utf8")).toBe(created.dsl);
    const generatedTests = await loadContractTestManifest(
      path.join(fixture.root, created.draft.tests_path),
    );
    expect(generatedTests.tests.map((test) => [test.id, test.kind])).toEqual([
      ["protected-read-shape-suppression-drift-and-boundaries", "protected_read_boundary"],
      ["trusted-scope-remains-outside-model-arguments", "trusted_scope"],
      ["kept-out-fields-remain-unavailable", "hide_fields"],
      ["evidence-and-query-audit-remain-required", "evidence_requirement"],
      ["operator-controls-remain-outside-mcp", "operator_boundary"],
    ]);
  });

  it("binds a human activation gesture to the exact digest and leaves the managed contract after Explore is disabled", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ region: "west", reason_category: "price" }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "reason_category"],
      where: [{ field: "region", op: "eq", value: "west" }],
      order_by: [{ field: "reason_category", direction: "asc" }],
      limit: 10,
    });
    await runtime.close();
    const token = (result.protect as { token: string }).token;
    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token,
      capabilityName: "analytics.recent_region_reasons",
      description: "List reviewed churn reason categories for one fixed region.",
      returnsHint: "Returns at most ten reviewed rows with no kept-out fields.",
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    const lock = JSON.parse(await fs.readFile(path.join(fixture.root, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;

    await expect(activateProtectedQuery({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: "ACTIVATE wrong",
      actor: "reviewer@example.test",
      env: fixture.env,
      prepareScopedExploreFn: async () => ({ boundary: fixture.boundary, lock, inspection: fixture.inspection }),
    })).rejects.toThrow(/explicit human confirmation/i);

    await expect(activateProtectedQuery({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: `sha256:${"f".repeat(64)}`,
      operatorConfirmed: true,
      actor: "reviewer@example.test",
      env: fixture.env,
      prepareScopedExploreFn: async () => ({ boundary: fixture.boundary, lock, inspection: fixture.inspection }),
    })).rejects.toThrow(/changed after review/i);

    const activated = await activateProtectedQuery({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      operatorConfirmed: true,
      actor: "reviewer@example.test",
      env: fixture.env,
      prepareScopedExploreFn: async () => ({ boundary: fixture.boundary, lock, inspection: fixture.inspection }),
    });

    expect(activated).toMatchObject({
      state: "active",
      capability: "analytics.recent_region_reasons",
      exploration_disabled: true,
    });
    await expect(fs.stat(path.join(fixture.root, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(fixture.root, activated.contract_path))).resolves.toBeDefined();
    const config = JSON.parse(await fs.readFile(path.join(fixture.root, activated.config_path), "utf8"));
    expect(config.contracts).toContain(`./${activated.contract_path}`);
    expect(config.sources.local_postgres).toMatchObject({
      engine: "postgres",
      read_url_env: "DATABASE_URL",
      read_only: true,
    });
    expect(config.trusted_context).toBeUndefined();
    const activeContract = JSON.parse(
      await fs.readFile(path.join(fixture.root, activated.contract_path), "utf8"),
    );
    expect(activeContract.contexts[0]).toMatchObject({
      name: "protected_operator",
      tenant_binding: "tenant_id",
      bindings: [{ name: "tenant_id", key: "SYNAPSOR_TENANT_ID" }],
    });
    expect(activeContract.contexts[0].principal_binding).toBeUndefined();
  });

  it("disables only the protected analysis source boundary when other reviewed boundaries are active", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{ region: "west", reason_category: "price" }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "rows",
      resource: "public.subscriptions",
      select: ["region", "reason_category"],
      where: [{ field: "region", op: "eq", value: "west" }],
      order_by: [{ field: "reason_category", direction: "asc" }],
      limit: 10,
    });
    await runtime.close();
    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: (result.protect as { token: string }).token,
      capabilityName: "analytics.protected_from_primary",
      description: "List reviewed reason categories for one fixed region.",
      returnsHint: "Returns at most ten reviewed rows.",
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });

    const secondCandidate = JSON.parse(await fs.readFile(
      path.join(fixture.root, "synapsor/generated/exploration-boundary.draft.json"),
      "utf8",
    ));
    secondCandidate.pack.name = "account_segments";
    const secondDigest = explorationBoundaryCandidateDigest(secondCandidate);
    await activateExplorationBoundary({
      projectRoot: fixture.root,
      candidate: secondCandidate,
      expectedDigest: secondDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${secondDigest}`,
      confirmedDecisions: secondCandidate.unresolved_decisions,
      currentInspection: fixture.inspection,
      activeSetMode: "add",
    });

    const lock = JSON.parse(await fs.readFile(
      path.join(fixture.root, ".synapsor/generation-lock.json"),
      "utf8",
    )) as GenerationLock;
    const activated = await activateProtectedQuery({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: `ACTIVATE ${created.draft.contract_digest}`,
      actor: "reviewer@example.test",
      env: fixture.env,
      prepareScopedExploreFn: async () => ({
        boundary: fixture.boundary,
        lock,
        inspection: fixture.inspection,
      }),
    });

    expect(activated.exploration_disabled).toBe(true);
    const remaining = await loadActivatedExplorationBoundaries(fixture.root);
    expect(remaining.map((boundary) => boundary.pack.name)).toEqual(["account_segments"]);
    expect(remaining[0]?.activation.digest).toBe(secondDigest);
  });

  it("requires separate Protect and activation confirmations for a lowered owner-reviewed cohort", async () => {
    const fixture = await activatedFixture(churnInspection(), 1);
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west",
        measure_0: 1,
        __cohort_size: 1,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-28T00:10:00.000Z"),
    });
    const result = await runtime.explore({
      kind: "aggregate",
      resource: "public.subscriptions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    });
    await runtime.close();
    expect(result.privacy).toMatchObject({
      minimum_cohort_size: 1,
      minimum_cohort_overridden: true,
      suppressed_groups: 0,
    });
    const token = (result.protect as { token: string }).token;
    const protectConfirmation = protectMinimumCohortConfirmation(
      "public.subscriptions",
      1,
    );

    await expect(createProtectedQueryDraft({
      projectRoot: fixture.root,
      token,
      capabilityName: "analytics.owner_reviewed_regions",
      description: "Show owner-reviewed regional counts.",
      returnsHint: "Returns reviewed aggregate groups.",
      now: Date.parse("2026-07-28T00:10:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    })).rejects.toThrow(/Protect requires an explicit human re-confirmation/i);

    const created = await createProtectedQueryDraft({
      projectRoot: fixture.root,
      token,
      capabilityName: "analytics.owner_reviewed_regions",
      description: "Show owner-reviewed regional counts.",
      returnsHint: "Returns reviewed aggregate groups.",
      minimumCohortConfirmation: protectConfirmation,
      minimumCohortActor: "owner@example.test",
      now: Date.parse("2026-07-28T00:10:01.000Z"),
      inspectDatabaseFn: async () => fixture.inspection,
    });
    expect(created.draft.minimum_cohort_override).toMatchObject({
      resource: "public.subscriptions",
      minimum_cohort_size: 1,
      reconfirmed_by: "owner@example.test",
    });
    expect(created.dsl).toContain("MIN GROUP SIZE 1");
    expect(await fs.readFile(
      path.join(fixture.root, created.draft.review_path),
      "utf8",
    )).toContain("groups of one");

    const lock = JSON.parse(
      await fs.readFile(path.join(fixture.root, ".synapsor/generation-lock.json"), "utf8"),
    ) as GenerationLock;
    const activationInput = {
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: `ACTIVATE ${created.draft.contract_digest}`,
      actor: "production-owner@example.test",
      disableExplore: false,
      env: fixture.env,
      prepareScopedExploreFn: async () => ({
        boundary: fixture.boundary,
        lock,
        inspection: fixture.inspection,
      }),
    };
    await expect(activateProtectedQuery(activationInput))
      .rejects.toThrow(/activation requires an explicit human re-confirmation/i);

    const activationCohortConfirmation = activateMinimumCohortConfirmation(
      "public.subscriptions",
      1,
      created.draft.contract_digest,
    );
    const draftPath = path.join(
      fixture.root,
      "synapsor/protected/drafts/analytics__owner_reviewed_regions/draft.json",
    );
    const persistedDraft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    delete persistedDraft.minimum_cohort_override;
    await fs.writeFile(draftPath, `${JSON.stringify(persistedDraft, null, 2)}\n`, "utf8");
    await expect(activateProtectedQuery({
      ...activationInput,
      minimumCohortConfirmation: activationCohortConfirmation,
    })).rejects.toThrow(/does not match its recorded owner review/i);
    await fs.writeFile(
      draftPath,
      `${JSON.stringify(created.draft, null, 2)}\n`,
      "utf8",
    );

    const overridePath = path.join(fixture.root, ".synapsor/review-overrides.json");
    const originalOverrides = await fs.readFile(overridePath, "utf8");
    const persistedOverrides = JSON.parse(originalOverrides);
    delete persistedOverrides.resources["public.subscriptions"].minimum_cohort;
    await fs.writeFile(
      overridePath,
      `${JSON.stringify(persistedOverrides, null, 2)}\n`,
      "utf8",
    );
    await expect(activateProtectedQuery({
      ...activationInput,
      minimumCohortConfirmation: activationCohortConfirmation,
    })).rejects.toThrow(/no longer has matching recorded owner review evidence/i);
    await fs.writeFile(overridePath, originalOverrides, "utf8");

    const activated = await activateProtectedQuery({
      ...activationInput,
      minimumCohortConfirmation: activationCohortConfirmation,
    });
    expect(activated.minimum_cohort_override).toMatchObject({
      minimum_cohort_size: 1,
      reconfirmed_by: "production-owner@example.test",
    });
    const config = JSON.parse(
      await fs.readFile(path.join(fixture.root, activated.config_path), "utf8"),
    );
    expect(config.generated_authority.minimum_cohort_overrides)
      .toMatchObject({
        "analytics.owner_reviewed_regions": {
          contract_digest: created.draft.contract_digest,
          minimum_cohort_size: 1,
          review_digest: created.draft.minimum_cohort_override?.review_digest,
        },
      });
  });

  it("refuses a stale short analysis reference before creating Protect artifacts", async () => {
    const fixture = await activatedFixture();
    const runtime = await createScopedExploreRuntime({
      projectRoot: fixture.root,
      transport: "stdio",
      env: fixture.env,
      executor: fixedExecutor([{
        dimension_0: "west",
        dimension_1: "price",
        time_bucket: "2026-06-02T00:00:00.000Z",
        measure_0: 8,
        measure_1: 8,
        __cohort_size: 8,
      }]),
      inspectDatabaseFn: async () => fixture.inspection,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
    });
    const result = await runtime.explore(pmAggregatePlan());
    await runtime.close();

    const drifted = structuredClone(fixture.inspection);
    drifted.tables[0]!.columns = drifted.tables[0]!.columns.filter(
      (column) => column.name !== "region",
    );
    await expect(createProtectedQueryDraft({
      projectRoot: fixture.root,
      token: (result.protect as { token: string }).token,
      capabilityName: "analytics.stale_analysis",
      description: "This draft must not be created from stale reviewed authority.",
      returnsHint: "No result.",
      now: Date.parse("2026-07-22T12:00:01.000Z"),
      inspectDatabaseFn: async () => drifted,
    })).rejects.toMatchObject({
      code: "EXPLORE_LOCK_STALE",
      message: expect.stringContaining("public.subscriptions.region no longer exists"),
    });
    await expect(fs.stat(path.join(
      fixture.root,
      "synapsor/protected/drafts/analytics__stale_analysis",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function pmAggregatePlan() {
  return {
    kind: "aggregate",
    resource: "public.subscriptions",
    measures: [
      { function: "count" },
      { function: "count_distinct", field: "id" },
    ],
    dimensions: [
      { field: "region" },
      { field: "reason_category" },
    ],
    time_bucket: { field: "churned_at", bucket: "week" },
    where: [{ field: "reason_category", op: "eq", value: "price" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
    comparison: {
      field: "churned_at",
      ranges: [{
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-06-15T00:00:00.000Z",
      }, {
        start: "2026-06-15T00:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
      }],
    },
  };
}

async function activatedFixture(
  inspection = churnInspection(),
  minimumCohort?: 1 | 2 | 3 | 4,
  modelWithheldField?: string,
): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-query-"));
  temporaryRoots.push(root);
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
    ...(minimumCohort || modelWithheldField
      ? {
        overrides: {
          schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
          resources: {
            "public.subscriptions": {
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
              ...(modelWithheldField
                ? {
                  fields: {
                    [modelWithheldField]: {
                      exposure: "withhold_from_model" as const,
                      actor: "owner@example.test",
                      reason: "Reviewed use without provider value egress.",
                      decided_at: "2026-07-29T00:00:00.000Z",
                    },
                  },
                }
                : {}),
            },
          },
        },
      }
      : {}),
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
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
    executeBatch: async ({ queries }) => queries.map(() => structuredClone(rows)),
    close: async () => undefined,
  };
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

function starProtectInspection(): SchemaInspection {
  const inspection = churnInspection();
  const root = inspection.tables[0]!;
  root.columns.push(
    column("store_id", "uuid", { immutable: true }),
    column("product_category_id", "uuid", { immutable: true }),
  );
  root.foreign_keys = [
    {
      name: "subscriptions_store_id_fkey",
      columns: ["store_id"],
      referenced_schema: "public",
      referenced_table: "stores",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    },
    {
      name: "subscriptions_product_category_id_fkey",
      columns: ["product_category_id"],
      referenced_schema: "public",
      referenced_table: "product_categories",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    },
  ];
  root.suggestions.default_visible_columns.push("store_id", "product_category_id");
  const relatedTable = (name: string) => {
    const table = structuredClone(root);
    table.name = name;
    table.columns = [
      column("id", "uuid", { immutable: true }),
      column("tenant_id", "uuid", { tenant: true, immutable: true }),
      column("name", "text"),
    ];
    table.primary_key = ["id"];
    table.unique_constraints = [{ name: `${name}_pkey`, columns: ["id"] }];
    table.foreign_keys = [];
    table.indexes = [{ name: `${name}_pkey`, columns: ["id"], unique: true }];
    table.row_level_security_policies = [{
      name: `${name}_tenant_read`,
      command: "SELECT" as const,
      permissive: true,
      roles: ["app_reader"],
      using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
    }];
    table.suggestions = {
      tenant_columns: ["tenant_id"],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: ["id", "tenant_id", "name"],
    };
    return table;
  };
  inspection.tables.push(relatedTable("stores"), relatedTable("product_categories"));
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
