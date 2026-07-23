import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  createScopedExploreRuntime,
  type ScopedExploreExecutor,
} from "./scoped-explore.js";
import {
  activateProtectedQuery,
  createProtectedQueryDraft,
  listProtectableQueries,
} from "./protect-query.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Protect This Query", () => {
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
  });

  it("requires exact digest activation, appends a managed contract, and leaves it after Explore is disabled", async () => {
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
    })).rejects.toThrow(/exact confirmation/i);

    const activated = await activateProtectedQuery({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: `ACTIVATE ${created.draft.contract_digest}`,
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
        end: "2026-07-01T00:00:00.000Z",
      }],
    },
  };
}

async function activatedFixture(): Promise<{
  root: string;
  boundary: ActivatedExplorationBoundary;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-query-"));
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
