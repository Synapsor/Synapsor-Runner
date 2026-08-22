import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresProposalRuntimeStore,
  migrateSharedPostgresRuntimeStore,
  type ExploreBudgetLimits,
  type PostgresRuntimeClient,
  type PostgresRuntimePool,
  type PostgresRuntimeQueryResult,
  type ProductionExploreBudgetReservationInput,
} from "./index.js";

const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("production Explore PostgreSQL accounting", () => {
  const schema = `synapsor_explore_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await migrateSharedPostgresRuntimeStore(pool, schema);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("isolates principal budgets while retaining one tenant-wide ceiling", async () => {
    const store = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const principalLimits = limits({ max_queries_per_session: 1 });
    const tenantLimits = limits({ max_queries_per_session: 2 });
    const tenant = fingerprint("tenant-acme");

    const first = await store.claimProductionExploreBudgetReservation(reservation({
      id: 1,
      principal: fingerprint("alice"),
      tenant,
      principalLimits,
      tenantLimits,
    }));
    expect(first).toMatchObject({ allowed: true });
    await expect(store.completeProductionExploreBudgetReservation({
      reservation_id: reservationId(1),
      result_released: true,
      returned_cells: 2,
      completed_at: "2026-08-04T12:00:01.000Z",
    })).resolves.toEqual({ completed: true });

    await expect(store.claimProductionExploreBudgetReservation(reservation({
      id: 2,
      principal: fingerprint("alice"),
      tenant,
      principalLimits,
      tenantLimits,
    }))).resolves.toMatchObject({
      allowed: false,
      code: "QUERY_BUDGET_EXHAUSTED",
      exhausted_scope: "principal",
    });

    await expect(store.claimProductionExploreBudgetReservation(reservation({
      id: 3,
      principal: fingerprint("bob"),
      tenant,
      principalLimits,
      tenantLimits,
    }))).resolves.toMatchObject({ allowed: true });

    await expect(store.claimProductionExploreBudgetReservation(reservation({
      id: 4,
      principal: fingerprint("carol"),
      tenant,
      principalLimits,
      tenantLimits,
    }))).resolves.toMatchObject({
      allowed: false,
      code: "QUERY_BUDGET_EXHAUSTED",
      exhausted_scope: "tenant",
    });

    const persisted = await pool.query(
      `SELECT scope_kind, scope_fingerprint FROM "${schema}".production_explore_budget_reservations`,
    );
    const serialized = JSON.stringify(persisted.rows);
    expect(serialized).not.toContain("tenant-acme");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("bob");
  });

  it("serializes concurrent requests so only one can consume the final principal unit", async () => {
    const interleaving = new ForcedInterleavingPool(pool);
    const store = new PostgresProposalRuntimeStore({
      pool: interleaving,
      schema,
      lockTimeoutMs: 2_000,
    });
    const principal = fingerprint("concurrent-principal");
    const tenant = fingerprint("concurrent-tenant");
    const principalLimits = limits({ max_queries_per_session: 1 });
    const tenantLimits = limits({ max_queries_per_session: 100 });

    const firstPromise = store.claimProductionExploreBudgetReservation(reservation({
      id: 10,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      now: "2026-08-04T12:10:00.000Z",
    }));
    await interleaving.firstTransactionPaused;
    const secondPromise = store.claimProductionExploreBudgetReservation(reservation({
      id: 11,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      now: "2026-08-04T12:10:00.001Z",
    }));
    await interleaving.secondTransactionObservedLock;
    interleaving.releaseFirstTransaction();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toMatchObject({ allowed: true });
    expect(second).toMatchObject({
      allowed: false,
      code: "QUERY_BUDGET_EXHAUSTED",
      exhausted_scope: "principal",
    });
  });

  it("keeps differencing variants across store instances while isolating root-resource pools", async () => {
    const firstStore = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const renewedSessionStore = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const principal = fingerprint("renewed-session-principal");
    const tenant = fingerprint("renewed-session-tenant");
    const principalLimits = limits({ max_differencing_queries: 1 });
    const tenantLimits = limits({ max_differencing_queries: 1 });
    const firstInput = reservation({
      id: 12,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      resource: "public.orders",
      variant: "orders-first",
      now: "2026-08-04T12:11:00.000Z",
    });
    await expect(firstStore.claimProductionExploreBudgetReservation(firstInput))
      .resolves.toMatchObject({ allowed: true });
    await expect(firstStore.completeProductionExploreBudgetReservation({
      reservation_id: firstInput.reservation_id,
      result_released: true,
      returned_cells: 2,
      completed_at: "2026-08-04T12:11:00.100Z",
    })).resolves.toEqual({ completed: true });

    await expect(renewedSessionStore.claimProductionExploreBudgetReservation(reservation({
      id: 13,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      resource: "public.orders",
      variant: "orders-second",
      now: "2026-08-04T12:11:01.000Z",
    }))).resolves.toMatchObject({
      allowed: false,
      code: "DIFFERENCING_BUDGET_EXHAUSTED",
      exhausted_scope: "principal",
      usage: { differencing_attempts: 1 },
    });

    await expect(renewedSessionStore.claimProductionExploreBudgetReservation(reservation({
      id: 14,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      resource: "public.members",
      variant: "members-first",
      now: "2026-08-04T12:11:02.000Z",
    }))).resolves.toMatchObject({
      allowed: true,
      principal_usage_after_reservation: { differencing_attempts: 1 },
      tenant_usage_after_reservation: { differencing_attempts: 1 },
    });
  });

  it("charges failed releases to query and rate budgets but not disclosure cells", async () => {
    const store = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const principal = fingerprint("failed-result-principal");
    const tenant = fingerprint("failed-result-tenant");
    const principalLimits = limits({
      max_queries_per_session: 2,
      max_extracted_cells_per_session: 1,
      max_response_cells: 1,
    });
    const tenantLimits = limits();
    const firstInput = reservation({
      id: 20,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      estimatedCells: 1,
      now: "2026-08-04T12:20:00.000Z",
    });
    await expect(store.claimProductionExploreBudgetReservation(firstInput))
      .resolves.toMatchObject({ allowed: true });
    await expect(store.completeProductionExploreBudgetReservation({
      reservation_id: firstInput.reservation_id,
      result_released: false,
      returned_cells: 0,
      completed_at: "2026-08-04T12:20:00.100Z",
    })).resolves.toEqual({ completed: true });

    const second = await store.claimProductionExploreBudgetReservation(reservation({
      id: 21,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      estimatedCells: 1,
      now: "2026-08-04T12:20:01.000Z",
    }));
    expect(second).toMatchObject({
      allowed: true,
      principal_usage_after_reservation: {
        query_count: 2,
        extracted_cells: 1,
      },
    });

    await expect(store.claimProductionExploreBudgetReservation(reservation({
      id: 22,
      principal,
      tenant,
      principalLimits,
      tenantLimits,
      estimatedCells: 1,
      now: "2026-08-04T12:20:02.000Z",
    }))).resolves.toMatchObject({
      allowed: false,
      code: "QUERY_BUDGET_EXHAUSTED",
      exhausted_scope: "principal",
    });
  });

  it("blocks complementary releases at both principal and tenant scope", async () => {
    const store = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const tenant = fingerprint("privacy-tenant");
    const complement = fingerprint("group-total-complement");
    const common = {
      complement_fingerprints: [complement],
      query_fingerprint: fingerprint("group-query"),
      boundary_digest: fingerprint("boundary"),
    };

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      principal_scope_fingerprint: fingerprint("privacy-alice"),
      tenant_scope_fingerprint: tenant,
      release_kind: "suppressed_grouping",
    })).resolves.toEqual({ allowed: true });

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      query_fingerprint: fingerprint("alice-total-query"),
      principal_scope_fingerprint: fingerprint("privacy-alice"),
      tenant_scope_fingerprint: tenant,
      release_kind: "scalar_total",
    })).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "suppressed_grouping",
      conflicting_scope: "principal",
    });

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      query_fingerprint: fingerprint("bob-total-query"),
      principal_scope_fingerprint: fingerprint("privacy-bob"),
      tenant_scope_fingerprint: tenant,
      release_kind: "scalar_total",
    })).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "suppressed_grouping",
      conflicting_scope: "tenant",
    });

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      query_fingerprint: fingerprint("other-tenant-total-query"),
      principal_scope_fingerprint: fingerprint("privacy-carol"),
      tenant_scope_fingerprint: fingerprint("privacy-other-tenant"),
      release_kind: "scalar_total",
    })).resolves.toEqual({ allowed: true });
  });

  it("atomically blocks scalar-filter complements at principal and tenant scope", async () => {
    const store = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const tenant = fingerprint("scalar-filter-tenant");
    const parent = fingerprint("scalar-filter-parent");
    const child = fingerprint("scalar-filter-child");
    const base = {
      tenant_scope_fingerprint: tenant,
      boundary_digest: fingerprint("scalar-filter-boundary"),
    };
    const unfiltered = (principal: `sha256:${string}`, query: string) => ({
      ...base,
      principal_scope_fingerprint: principal,
      complement_fingerprints: [fingerprint(`legacy:${query}`)],
      release_kind: "scalar_total" as const,
      query_fingerprint: fingerprint(query),
      additional_releases: [{
        complement_fingerprints: [parent],
        release_kind: "scalar_total" as const,
        conflict_reason: "scalar_filter_complement" as const,
      }],
    });
    const filtered = (principal: `sha256:${string}`, query: string) => ({
      ...base,
      principal_scope_fingerprint: principal,
      complement_fingerprints: [fingerprint(`legacy:${query}`)],
      release_kind: "scalar_total" as const,
      query_fingerprint: fingerprint(query),
      additional_releases: [{
        complement_fingerprints: [child],
        release_kind: "scalar_total" as const,
        conflict_reason: "scalar_filter_complement" as const,
      }, {
        complement_fingerprints: [parent],
        release_kind: "suppressed_grouping" as const,
        conflict_reason: "scalar_filter_complement" as const,
      }],
    });

    const alice = fingerprint("scalar-filter-alice");
    await expect(store.claimProductionExplorePrivacyRelease(
      unfiltered(alice, "alice-parent"),
    )).resolves.toEqual({ allowed: true });
    const deniedQuery = fingerprint("alice-child");
    await expect(store.claimProductionExplorePrivacyRelease({
      ...filtered(alice, "alice-child"),
      query_fingerprint: deniedQuery,
    })).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "scalar_total",
      conflicting_release_reason: "scalar_filter_complement",
      conflicting_scope: "principal",
    });
    const deniedRows = await pool.query(
      `SELECT COUNT(*) AS count FROM "${schema}".production_explore_privacy_releases
       WHERE query_fingerprint = $1`,
      [deniedQuery],
    );
    expect(Number(deniedRows.rows[0]?.count)).toBe(0);

    await expect(store.claimProductionExplorePrivacyRelease(
      filtered(fingerprint("scalar-filter-bob"), "bob-child"),
    )).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "scalar_total",
      conflicting_release_reason: "scalar_filter_complement",
      conflicting_scope: "tenant",
    });

    const reverseTenant = fingerprint("scalar-filter-reverse-tenant");
    const reversePrincipal = fingerprint("scalar-filter-reverse-principal");
    await expect(store.claimProductionExplorePrivacyRelease({
      ...filtered(reversePrincipal, "reverse-child"),
      tenant_scope_fingerprint: reverseTenant,
    })).resolves.toEqual({ allowed: true });
    await expect(store.claimProductionExplorePrivacyRelease({
      ...unfiltered(reversePrincipal, "reverse-parent"),
      tenant_scope_fingerprint: reverseTenant,
    })).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "suppressed_grouping",
      conflicting_release_reason: "scalar_filter_complement",
      conflicting_scope: "principal",
    });

    const concurrentTenant = fingerprint("scalar-filter-concurrent-tenant");
    const concurrentPrincipal = fingerprint("scalar-filter-concurrent-principal");
    const concurrent = await Promise.all([
      store.claimProductionExplorePrivacyRelease({
        ...unfiltered(concurrentPrincipal, "concurrent-parent"),
        tenant_scope_fingerprint: concurrentTenant,
      }),
      store.claimProductionExplorePrivacyRelease({
        ...filtered(concurrentPrincipal, "concurrent-child"),
        tenant_scope_fingerprint: concurrentTenant,
      }),
    ]);
    expect(concurrent.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(concurrent.filter((decision) => !decision.allowed)).toEqual([
      expect.objectContaining({
        allowed: false,
        conflicting_release_reason: "scalar_filter_complement",
        conflicting_scope: "principal",
      }),
    ]);
  });

  it("appends production audit volume beyond the proposal-ledger cap without blocking proposal audit writes", async () => {
    const store = new PostgresProposalRuntimeStore({
      pool,
      schema,
      lockTimeoutMs: 2_000,
      maxEntries: 100,
    });
    const createdAt = "2026-08-04T13:00:00.000Z";
    await Promise.all(Array.from({ length: 150 }, async (_unused, index) => {
      await store.recordProductionExploreAuditEvent({
        event_id: `ev_load_${index.toString().padStart(4, "0")}`,
        event_kind: "query_audit",
        payload: {
          query_audit: {
            status: "ok",
            normalized_plan: { resource: "public.orders" },
            result_values_persisted: false,
          },
        },
        created_at: createdAt,
      });
    }));

    await expect(store.recordQueryAudit({
      source_id: "control",
      query_fingerprint: fingerprint("proposal-audit-after-explore-volume"),
      table_name: "proposal_review",
      row_count: 0,
      payload: { status: "reviewed" },
    })).resolves.toBeUndefined();

    const events = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "${schema}".production_explore_audit_events WHERE event_id LIKE 'ev_load_%'`,
    );
    expect(Number(events.rows[0]?.count)).toBe(150);
    const ledger = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "${schema}".ledger_entries WHERE kind IN ('evidence_bundle', 'evidence_item', 'query_audit')`,
    );
    expect(Number(ledger.rows[0]?.count)).toBe(1);
  });

  it("allows independent production audit appends to proceed without a global writer lock", async () => {
    const concurrent = new ConcurrentAuditPool(pool);
    const store = new PostgresProposalRuntimeStore({ pool: concurrent, schema, lockTimeoutMs: 2_000 });
    await Promise.all([0, 1].map(async (index) => {
      await store.recordProductionExploreAuditEvent({
        event_id: `ev_concurrent_${index}`,
        event_kind: "query_audit",
        payload: { query_audit: { status: "ok", index } },
        created_at: "2026-08-04T13:10:00.000Z",
      });
    }));
    expect(concurrent.maximumConcurrentAuditAppends).toBe(2);
  });

  it("keeps retention cleanup outside accounting locks and uses the database clock for the 24-hour privacy window", async () => {
    const recorded = new RecordingPool(pool);
    const store = new PostgresProposalRuntimeStore({ pool: recorded, schema, lockTimeoutMs: 2_000 });
    const activeComplement = fingerprint("retention-active-complement");
    const expiredComplement = fingerprint("retention-expired-complement");
    const tenant = fingerprint("retention-tenant");
    const principal = fingerprint("retention-principal");
    const common = {
      query_fingerprint: fingerprint("retention-query"),
      boundary_digest: fingerprint("retention-boundary"),
      principal_scope_fingerprint: principal,
      tenant_scope_fingerprint: tenant,
    };

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      complement_fingerprints: [activeComplement, expiredComplement],
      release_kind: "suppressed_grouping",
    })).resolves.toEqual({ allowed: true });
    expect(recorded.transactionSql.some((sql) => /DELETE\s+FROM/i.test(sql))).toBe(false);

    await pool.query(
      `UPDATE "${schema}".production_explore_privacy_releases
       SET created_at = now() - interval '25 hours'
       WHERE complement_fingerprint = $1`,
      [expiredComplement],
    );
    // A future-skewed application clock must not shorten the database-backed
    // privacy window or release a complementary aggregate early.
    await store.runProductionExploreMaintenance(new Date("2099-08-04T12:00:00.000Z"));

    const retained = await pool.query(
      `SELECT complement_fingerprint FROM "${schema}".production_explore_privacy_releases
       WHERE complement_fingerprint = ANY($1::text[])`,
      [[activeComplement, expiredComplement]],
    );
    expect([...new Set(retained.rows.map((row) => row.complement_fingerprint))]).toEqual([activeComplement]);

    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      query_fingerprint: fingerprint("retention-opposite-query"),
      complement_fingerprints: [activeComplement],
      release_kind: "scalar_total",
    })).resolves.toEqual({
      allowed: false,
      conflicting_release_kind: "suppressed_grouping",
      conflicting_scope: "principal",
    });
    await expect(store.claimProductionExplorePrivacyRelease({
      ...common,
      query_fingerprint: fingerprint("retention-expired-opposite-query"),
      complement_fingerprints: [expiredComplement],
      release_kind: "scalar_total",
    })).resolves.toEqual({ allowed: true });
  });

  it("creates indexes for time-based maintenance", async () => {
    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    );
    const names = indexes.rows.map((row) => String(row.indexname));
    expect(names).toContain("idx_synapsor_production_explore_budget_created");
    expect(names).toContain("idx_synapsor_production_explore_privacy_created");
    expect(names).toContain("idx_synapsor_production_explore_audit_created");
  });
});

function reservation(input: {
  id: number;
  principal: `sha256:${string}`;
  tenant: `sha256:${string}`;
  principalLimits: ExploreBudgetLimits;
  tenantLimits: ExploreBudgetLimits;
  estimatedCells?: number;
  now?: string;
  resource?: string;
  variant?: string;
}): ProductionExploreBudgetReservationInput {
  return {
    reservation_id: reservationId(input.id),
    principal_scope_fingerprint: input.principal,
    tenant_scope_fingerprint: input.tenant,
    resource_id: input.resource ?? "public.orders",
    variant_fingerprint: fingerprint(input.variant ?? `variant-${input.id}`),
    requires_differencing: true,
    estimated_response_cells: input.estimatedCells ?? 2,
    principal_limits: input.principalLimits,
    tenant_limits: input.tenantLimits,
    now: input.now ?? `2026-08-04T12:00:${String(input.id).padStart(2, "0")}.000Z`,
  };
}

function reservationId(id: number): string {
  return `explore_budget_${id.toString(16).padStart(32, "0")}`;
}

function limits(overrides: Partial<ExploreBudgetLimits> = {}): ExploreBudgetLimits {
  return {
    max_queries_per_session: 100,
    rate_limit_per_minute: 100,
    max_extracted_cells_per_session: 10_000,
    max_differencing_queries: 100,
    max_response_cells: 1_000,
    ...overrides,
  };
}

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

class ForcedInterleavingPool implements PostgresRuntimePool {
  readonly firstTransactionPaused: Promise<void>;
  readonly secondTransactionObservedLock: Promise<void>;
  private resolveFirstPaused!: () => void;
  private resolveSecondObserved!: () => void;
  private releaseFirst!: () => void;
  private readonly firstRelease: Promise<void>;
  private nextClient = 0;

  constructor(private readonly pool: Pool) {
    this.firstTransactionPaused = new Promise((resolve) => { this.resolveFirstPaused = resolve; });
    this.secondTransactionObservedLock = new Promise((resolve) => { this.resolveSecondObserved = resolve; });
    this.firstRelease = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  releaseFirstTransaction(): void {
    this.releaseFirst();
  }

  async connect(): Promise<PostgresRuntimeClient> {
    const client = await this.pool.connect();
    this.nextClient += 1;
    return new ForcedInterleavingClient(
      client,
      this.nextClient,
      this.firstRelease,
      this.resolveFirstPaused,
      this.resolveSecondObserved,
    );
  }

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    const result = await this.pool.query(sql, values);
    return { rows: result.rows };
  }
}

class RecordingPool implements PostgresRuntimePool {
  readonly transactionSql: string[] = [];

  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PostgresRuntimeClient> {
    const client = await this.pool.connect();
    return {
      query: async (sql, values) => {
        this.transactionSql.push(sql);
        return await client.query(sql, values);
      },
      release: () => client.release(),
    };
  }

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    const result = await this.pool.query(sql, values);
    return { rows: result.rows as Record<string, unknown>[] };
  }
}

class ConcurrentAuditPool implements PostgresRuntimePool {
  maximumConcurrentAuditAppends = 0;
  private activeAuditAppends = 0;
  private resolveSecondStarted!: () => void;
  private readonly secondStarted = new Promise<void>((resolve) => {
    this.resolveSecondStarted = resolve;
  });

  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PostgresRuntimeClient> {
    return await this.pool.connect();
  }

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    if (!sql.includes("INSERT INTO") || !sql.includes("production_explore_audit_events")) {
      const result = await this.pool.query(sql, values);
      return { rows: result.rows as Record<string, unknown>[] };
    }
    this.activeAuditAppends += 1;
    this.maximumConcurrentAuditAppends = Math.max(
      this.maximumConcurrentAuditAppends,
      this.activeAuditAppends,
    );
    if (this.activeAuditAppends === 1) await this.secondStarted;
    else this.resolveSecondStarted();
    try {
      const result = await this.pool.query(sql, values);
      return { rows: result.rows as Record<string, unknown>[] };
    } finally {
      this.activeAuditAppends -= 1;
    }
  }
}

class ForcedInterleavingClient implements PostgresRuntimeClient {
  private acquiredLocks = 0;

  constructor(
    private readonly client: PoolClient,
    private readonly clientNumber: number,
    private readonly firstRelease: Promise<void>,
    private readonly firstPaused: () => void,
    private readonly secondObserved: () => void,
  ) {}

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    const result = await this.client.query(sql, values);
    if (sql.includes("pg_try_advisory_xact_lock")) {
      if (this.clientNumber === 1 && result.rows[0]?.locked === true) {
        this.acquiredLocks += 1;
        if (this.acquiredLocks === 2) {
          this.firstPaused();
          await this.firstRelease;
        }
      } else if (this.clientNumber === 2 && result.rows[0]?.locked === false) {
        this.secondObserved();
      }
    }
    return { rows: result.rows };
  }

  release(): void {
    this.client.release();
  }
}
