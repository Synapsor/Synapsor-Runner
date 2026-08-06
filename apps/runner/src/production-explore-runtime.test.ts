import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { describe, expect, it } from "vitest";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  assertProductionExploreStartup,
  formatProductionExploreStartupReport,
  inspectProductionExploreStartup,
  productionExploreSessionFactory,
} from "./mcp-runtime.js";

type PrepareBoundary = NonNullable<Parameters<typeof inspectProductionExploreStartup>[3]>;

const hmacSecret = "production-budget-hmac-key-material-1234567890";
const controlDatabaseUrl = "postgresql://control:secret@control.internal/synapsor";

function productionConfig(): RuntimeConfig {
  return {
    version: 1,
    mode: "read_only",
    storage: {
      sqlite_path: "./.synapsor/local.db",
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
      },
    },
    sources: {
      analytics: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
      },
    },
    trusted_context: {
      provider: "http_claims",
    },
    session_auth: {
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "https://runner.example/mcp",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
    },
    http_security: {
      deployment: "shared",
      channel: "trusted_tls_proxy",
      oauth_resource: {
        resource: "https://runner.example/mcp",
        authorization_servers: ["https://identity.example"],
        scopes_supported: ["synapsor.explore"],
        required_scopes: ["synapsor.explore"],
      },
      allowed_hosts: ["runner.example"],
    },
    production_explore: {
      enabled: true,
      project_root: "/srv/synapsor/production-explore",
      required_oauth_scope: "synapsor.explore",
      budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
      accounting_namespace: "example.analytics.production",
      tenant_limits: {
        max_queries_per_rolling_24_hours: 10_000,
        max_extracted_cells_per_rolling_24_hours: 1_000_000,
        max_differencing_queries_per_rolling_24_hours: 2_000,
        requests_per_minute: 1_000,
        max_response_cells_per_response: 500,
      },
    },
  } as RuntimeConfig;
}

function productionBoundary(overrides: Record<string, unknown> = {}): ActivatedExplorationBoundary {
  return {
    deployment_profile: "production",
    source: "analytics",
    trusted_context: {
      provider: "http_claims",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
    },
    budgets: {
      max_rows: 50,
      max_groups: 50,
      max_ranked_groups: 500,
      max_top_n: 25,
      max_measures: 3,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 500,
      max_response_bytes: 65_536,
      statement_timeout_ms: 3_000,
      max_complexity: 100,
      max_queries_per_session: 100,
      max_extracted_cells_per_session: 10_000,
      max_differencing_queries: 20,
      rate_limit_per_minute: 30,
    },
    pack: { name: "customer_analytics", resources: [] },
    activation: {
      state: "active",
      digest: `sha256:${"1".repeat(64)}`,
      actor: "operator@example.com",
      activated_at: "2026-08-04T00:00:00.000Z",
      generation_lock_fingerprint: `sha256:${"2".repeat(64)}`,
      reviewed_decisions: [],
    },
    ...overrides,
  } as unknown as ActivatedExplorationBoundary;
}

function productionEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://reader:secret@source.internal/application",
    SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: hmacSecret,
    SYNAPSOR_CONTROL_DATABASE_URL: controlDatabaseUrl,
  };
}

const prepareCurrentBoundary: PrepareBoundary = async () => ({
  boundary: productionBoundary(),
  lock: {
    engine: "postgres",
    source_env: "DATABASE_URL",
  },
} as Awaited<ReturnType<PrepareBoundary>>);

describe("production Explore startup posture", () => {
  it("attests the complete secured posture without disclosing secrets", async () => {
    const report = await assertProductionExploreStartup(
      productionConfig(),
      productionEnv(),
      async () => [productionBoundary()],
      prepareCurrentBoundary,
    );

    expect(report).toMatchObject({
      ok: true,
      active_boundaries: ["customer_analytics"],
      tools: ["app.describe_data", "app.explore_data"],
    });
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "control-database-separation",
      ok: true,
    }));

    const rendered = formatProductionExploreStartupReport(report);
    expect(rendered).toContain("PRODUCTION EXPLORE READY");
    expect(rendered).toContain("customer_analytics");
    expect(rendered).toContain("app.describe_data and app.explore_data");
    expect(rendered).not.toContain(hmacSecret);
    expect(rendered).not.toContain(controlDatabaseUrl);
  });

  it("attests principal-only JWT binding for an exact reviewed single organization", async () => {
    const config = productionConfig();
    config.production_explore!.single_organization_id = "internal-finance";
    delete config.session_auth!.tenant_claim;
    const boundary = productionBoundary({
      organization_scope: {
        mode: "single_organization",
        organization_id: "internal-finance",
        acknowledgement: "all_rows_belong_to_one_organization",
      },
      trusted_context: {
        provider: "http_claims",
        principal_claim: "sub",
      },
    });
    const report = await assertProductionExploreStartup(
      config,
      productionEnv(),
      async () => [boundary],
      async () => ({
        boundary,
        lock: { engine: "postgres", source_env: "DATABASE_URL" },
      } as Awaited<ReturnType<PrepareBoundary>>),
    );
    expect(report.ok).toBe(true);
    expect(formatProductionExploreStartupReport(report)).toContain(
      "organization identity is fixed as internal-finance",
    );
  });

  it.each([
    {
      name: "missing shared HMAC material",
      mutateConfig: (_config: RuntimeConfig) => undefined,
      mutateEnv: (env: NodeJS.ProcessEnv) => delete env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY,
      boundary: productionBoundary(),
      expected: "at least 32 bytes",
    },
    {
      name: "missing shared accounting database",
      mutateConfig: (_config: RuntimeConfig) => undefined,
      mutateEnv: (env: NodeJS.ProcessEnv) => delete env.SYNAPSOR_CONTROL_DATABASE_URL,
      boundary: productionBoundary(),
      expected: "shared_postgres.mode runtime_store",
    },
    {
      name: "non-production boundary",
      mutateConfig: (_config: RuntimeConfig) => undefined,
      mutateEnv: (_env: NodeJS.ProcessEnv) => undefined,
      boundary: productionBoundary({ deployment_profile: "staging" }),
      expected: "not a separately reviewed production boundary",
    },
    {
      name: "mismatched reviewed claims",
      mutateConfig: (_config: RuntimeConfig) => undefined,
      mutateEnv: (_env: NodeJS.ProcessEnv) => undefined,
      boundary: productionBoundary({
        trusted_context: {
          provider: "http_claims",
          tenant_claim: "organization_id",
          principal_claim: "user_id",
        },
      }),
      expected: "claim bindings do not match session_auth",
    },
    {
      name: "unknown reviewed source",
      mutateConfig: (_config: RuntimeConfig) => undefined,
      mutateEnv: (_env: NodeJS.ProcessEnv) => undefined,
      boundary: productionBoundary({ source: "missing" }),
      expected: "absent from the runtime config",
    },
  ])("fails closed for $name", async ({ mutateConfig, mutateEnv, boundary, expected }) => {
    const config = productionConfig();
    const env = productionEnv();
    mutateConfig(config);
    mutateEnv(env);

    const report = await inspectProductionExploreStartup(config, env, async () => [boundary], prepareCurrentBoundary);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => !check.ok && check.message.includes(expected))).toBe(true);
    await expect(assertProductionExploreStartup(config, env, async () => [boundary], prepareCurrentBoundary)).rejects.toThrow(expected);
  });

  it("does not claim control-database separation when an earlier boundary check skipped it", async () => {
    const boundary = productionBoundary({
      trusted_context: {
        provider: "http_claims",
        tenant_claim: "organization_id",
        principal_claim: "user_id",
      },
    });
    const report = await inspectProductionExploreStartup(
      productionConfig(),
      productionEnv(),
      async () => [boundary],
      prepareCurrentBoundary,
    );
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.name === "control-database-separation")).toBe(false);
  });

  it("omits the PostgreSQL separation attestation for a reviewed MySQL source", async () => {
    const config = productionConfig();
    config.sources!.analytics = {
      engine: "mysql",
      read_url_env: "DATABASE_URL",
    };
    const env = productionEnv();
    env.DATABASE_URL = "mysql://reader:secret@source.internal/application";
    const report = await inspectProductionExploreStartup(
      config,
      env,
      async () => [productionBoundary()],
      async () => ({
        boundary: productionBoundary(),
        lock: { engine: "mysql", source_env: "DATABASE_URL" },
      } as Awaited<ReturnType<PrepareBoundary>>),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.name === "control-database-separation")).toBe(false);
  });

  it("refuses to start with no active reviewed production boundary", async () => {
    const report = await inspectProductionExploreStartup(productionConfig(), productionEnv(), async () => [], prepareCurrentBoundary);
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "active-production-boundaries",
      ok: false,
      message: expect.stringContaining("at least one active reviewed production boundary"),
    }));
  });

  it("fails attestation before traffic when active boundaries use different sources", async () => {
    const config = productionConfig();
    config.sources!.warehouse = {
      engine: "postgres",
      read_url_env: "WAREHOUSE_DATABASE_URL",
    };
    const env = productionEnv();
    env.WAREHOUSE_DATABASE_URL = "postgresql://reader:secret@warehouse.internal/analytics";
    const boundaries = [
      productionBoundary(),
      productionBoundary({
        source: "warehouse",
        pack: { name: "warehouse_analytics", resources: [] },
      }),
    ];
    const report = await inspectProductionExploreStartup(
      config,
      env,
      async () => boundaries,
      async ({ boundaryName }) => ({
        boundary: boundaries.find((boundary) => boundary.pack.name === boundaryName),
        lock: boundaryName === "warehouse_analytics"
          ? { engine: "postgres", source_env: "WAREHOUSE_DATABASE_URL" }
          : { engine: "postgres", source_env: "DATABASE_URL" },
      } as Awaited<ReturnType<PrepareBoundary>>),
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "single-reviewed-source",
      ok: false,
      message: expect.stringMatching(/customer_analytics -> analytics.*warehouse_analytics -> warehouse/),
    }));
    await expect(assertProductionExploreStartup(
      config,
      env,
      async () => boundaries,
      prepareCurrentBoundary,
    )).rejects.toThrow(/PRODUCTION EXPLORE NOT READY[\s\S]*customer_analytics -> analytics[\s\S]*warehouse_analytics -> warehouse/);
  });

  it("warns without failing when a tenant ceiling is below a boundary principal budget", async () => {
    const config = productionConfig();
    config.production_explore!.tenant_limits.max_queries_per_rolling_24_hours = 50;
    const boundary = productionBoundary({
      budgets: {
        ...productionBoundary().budgets,
        max_queries_per_session: 100,
      },
    });
    const report = await inspectProductionExploreStartup(
      config,
      productionEnv(),
      async () => [boundary],
      prepareCurrentBoundary,
    );

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "tenant-budget-sizing",
      ok: true,
      level: "warn",
      message: expect.stringContaining("queries 50 < 100"),
    }));
    expect(formatProductionExploreStartupReport(report)).toContain("WARN  Safe but potentially disruptive configuration");
  });

  it("rejects a 32-character hexadecimal HMAC key with entropy guidance", async () => {
    const env = productionEnv();
    env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY = "a".repeat(32);
    const report = await inspectProductionExploreStartup(
      productionConfig(),
      env,
      async () => [productionBoundary()],
      prepareCurrentBoundary,
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "shared-budget-hmac",
      ok: false,
      message: expect.stringContaining("32-character hex string contains only 16 bytes"),
    }));
  });

  it("requires an explicitly read-only runtime", async () => {
    const config = productionConfig();
    config.mode = "review";
    const report = await inspectProductionExploreStartup(
      config,
      productionEnv(),
      async () => [productionBoundary()],
      prepareCurrentBoundary,
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "read-only-runtime",
      ok: false,
      message: expect.stringContaining("mode read_only"),
    }));
  });

  it("reports every failed startup prerequisite together with one doctor command", async () => {
    const config = productionConfig();
    config.mode = "review";
    const env = productionEnv();
    delete env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY;
    delete env.SYNAPSOR_CONTROL_DATABASE_URL;

    await expect(assertProductionExploreStartup(
      config,
      env,
      async () => [],
      prepareCurrentBoundary,
      { doctorCommand: "synapsor-runner doctor --config ./synapsor.runner.json --transport streamable-http" },
    )).rejects.toThrow(
      /PRODUCTION EXPLORE NOT READY[\s\S]*mode read_only[\s\S]*at least 32 bytes[\s\S]*shared_postgres.mode runtime_store[\s\S]*at least one active reviewed production boundary[\s\S]*synapsor-runner doctor --config/,
    );
  });

  it("fails closed when the reviewed source lock and runtime source disagree", async () => {
    const report = await inspectProductionExploreStartup(
      productionConfig(),
      productionEnv(),
      async () => [productionBoundary()],
      async () => ({
        lock: { engine: "mysql", source_env: "OTHER_DATABASE_URL" },
      } as Awaited<ReturnType<PrepareBoundary>>),
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "active-production-boundaries",
      ok: false,
      message: expect.stringContaining("source lock does not match runtime source"),
    }));
  });

  it("fails closed when the shared accounting ledger is the PostgreSQL source database", async () => {
    const env = productionEnv();
    env.SYNAPSOR_CONTROL_DATABASE_URL = "postgresql://control:other-secret@source.internal/application?sslmode=require";
    const report = await inspectProductionExploreStartup(
      productionConfig(),
      env,
      async () => [productionBoundary()],
      prepareCurrentBoundary,
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "control-database-separation",
      ok: false,
      message: expect.stringContaining("same PostgreSQL database"),
    }));
  });

  it("fails closed when current schema or read-only role attestation fails", async () => {
    const report = await inspectProductionExploreStartup(
      productionConfig(),
      productionEnv(),
      async () => [productionBoundary()],
      async () => {
        throw new Error("database role is no longer read-only");
      },
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "active-production-boundaries",
      ok: false,
      message: expect.stringContaining("database role is no longer read-only"),
    }));
  });

  it("shares one bounded source executor across sessions and servers in the same process", async () => {
    const config = productionConfig();
    config.production_explore!.source_max_connections = 3;
    config.production_explore!.max_sessions_per_principal = 2;
    const store = new ProposalStore();
    let executorCreations = 0;
    let executorCloses = 0;
    let sessionRuntimeCloses = 0;
    const executorsSeen: unknown[] = [];
    const executor = {
      execute: async () => [],
      executeBatch: async () => [],
      close: async () => { executorCloses += 1; },
    };
    const dependencies: NonNullable<Parameters<typeof productionExploreSessionFactory>[2]> = {
      loadBoundaries: async () => [productionBoundary()],
      createExecutor: (input) => {
        executorCreations += 1;
        expect(input.maxConnections).toBe(3);
        return executor;
      },
      createBoundarySetRuntime: (async (input) => {
        executorsSeen.push(input.executor);
        return {
          close: async () => { sessionRuntimeCloses += 1; },
        };
      }) as NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createBoundarySetRuntime"],
      createMcpServer: (() => ({
        connect: async () => undefined,
        close: async () => undefined,
      })) as unknown as NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createMcpServer"],
    };
    const factory = productionExploreSessionFactory(config, productionEnv(), dependencies);
    const secondFactory = productionExploreSessionFactory(config, productionEnv(), dependencies);
    const sessionInput = {
      config,
      env: productionEnv(),
      store,
      trustedContext: {
        tenant_id: "tenant-a",
        principal: "principal-a",
        provenance: "http_claims" as const,
      },
    };

    const [first, second, third] = await Promise.all([
      factory(sessionInput),
      factory(sessionInput),
      secondFactory(sessionInput),
    ]);
    expect(executorCreations).toBe(1);
    expect(executorsSeen).toEqual([executor, executor, executor]);
    expect(factory.maxSessionsPerPrincipal).toBe(2);

    await Promise.all([first.close(), second.close(), third.close()]);
    expect(sessionRuntimeCloses).toBe(3);
    expect(executorCloses).toBe(0);
    await factory.close?.();
    expect(executorCloses).toBe(0);
    await secondFactory.close?.();
    expect(executorCloses).toBe(1);
    store.close();
  });

  it("retries shared executor bootstrap after one transient failure", async () => {
    const config = productionConfig();
    const env = productionEnv();
    env.DATABASE_URL = "postgresql://reader:secret@bootstrap-recovery.internal/application";
    const store = new ProposalStore();
    let boundaryLoads = 0;
    let executorCreations = 0;
    let executorCloses = 0;
    const executor = {
      execute: async () => [],
      executeBatch: async () => [],
      close: async () => { executorCloses += 1; },
    };
    const dependencies: NonNullable<Parameters<typeof productionExploreSessionFactory>[2]> = {
      loadBoundaries: async () => {
        boundaryLoads += 1;
        if (boundaryLoads === 1) throw new Error("transient boundary read failure");
        return [productionBoundary()];
      },
      createExecutor: () => {
        executorCreations += 1;
        return executor;
      },
      createBoundarySetRuntime: (async () => ({ close: async () => undefined })) as unknown as
        NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createBoundarySetRuntime"],
      createMcpServer: (() => ({
        connect: async () => undefined,
        close: async () => undefined,
      })) as unknown as NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createMcpServer"],
    };
    const factory = productionExploreSessionFactory(config, env, dependencies);
    const sessionInput = {
      config,
      env,
      store,
      trustedContext: {
        tenant_id: "tenant-recovery",
        principal: "principal-recovery",
        provenance: "http_claims" as const,
      },
    };

    await expect(factory(sessionInput)).rejects.toThrow("transient boundary read failure");
    const [recovered, cached] = await Promise.all([factory(sessionInput), factory(sessionInput)]);
    expect(boundaryLoads).toBe(2);
    expect(executorCreations).toBe(1);

    await Promise.all([recovered.close(), cached.close()]);
    await expect(factory.close?.()).resolves.toBeUndefined();
    expect(executorCloses).toBe(1);
    store.close();
  });

  it("binds single-organization production sessions to the fixed organization and verified principal", async () => {
    const config = productionConfig();
    config.production_explore!.single_organization_id = "internal-finance";
    delete config.session_auth!.tenant_claim;
    const boundary = productionBoundary({
      organization_scope: {
        mode: "single_organization",
        organization_id: "internal-finance",
        acknowledgement: "all_rows_belong_to_one_organization",
      },
      trusted_context: { provider: "http_claims", principal_claim: "sub" },
    });
    const store = new ProposalStore();
    let runtimeInput: Record<string, unknown> | undefined;
    const dependencies: NonNullable<Parameters<typeof productionExploreSessionFactory>[2]> = {
      loadBoundaries: async () => [boundary],
      createExecutor: () => ({
        execute: async () => [],
        executeBatch: async () => [],
        close: async () => undefined,
      }),
      createBoundarySetRuntime: (async (input) => {
        runtimeInput = input as unknown as Record<string, unknown>;
        return { close: async () => undefined };
      }) as NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createBoundarySetRuntime"],
      createMcpServer: (() => ({
        connect: async () => undefined,
        close: async () => undefined,
      })) as unknown as NonNullable<Parameters<typeof productionExploreSessionFactory>[2]>["createMcpServer"],
    };
    const factory = productionExploreSessionFactory(config, productionEnv(), dependencies);
    const session = await factory({
      config,
      env: productionEnv(),
      store,
      trustedContext: {
        tenant_id: "internal-finance",
        principal: "analyst-7",
        provenance: "http_claims",
      },
    });
    expect(runtimeInput?.sessionContext).toEqual({
      tenant_id: "internal-finance",
      principal: "analyst-7",
      provenance: "http_claims",
    });
    await expect(factory({
      config,
      env: productionEnv(),
      store,
      trustedContext: {
        tenant_id: "other-org",
        principal: "analyst-7",
        provenance: "http_claims",
      },
    })).rejects.toThrow(/exact reviewed organization identity/i);
    await session.close();
    await factory.close?.();
    store.close();
  });
});
