import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({ pool: vi.fn(), inspect: vi.fn() }));
vi.mock("@synapsor-runner/postgres", async (importOriginal) => ({
  ...await importOriginal<typeof import("@synapsor-runner/postgres")>(),
  createPostgresPool: postgres.pool,
  inspectPostgresRlsTarget: postgres.inspect,
}));

import {
  exploreVocabularyDoctorCheck,
  postgresRlsDoctorChecks,
  postgresRlsExploreTargets,
  withMysqlProbeConnection,
  withPostgresProbeClient,
} from "./runtime-doctor.js";

describe("runtime doctor RLS denied-identity canary", () => {
  beforeEach(() => {
    postgres.pool.mockReset();
    postgres.inspect.mockReset();
    postgres.inspect.mockResolvedValue({ ok: true, role: "reader", policies: [{}], errors: [] });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses valid UUID identities for both denied scopes under UUID-cast policies", async () => {
    const probe = canaryProbe({ uuidCasts: true });
    const checks = await probe.run();
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.at(-1)).toMatchObject({ level: "pass" });
    expect(probe.bindings).toHaveLength(3);
    expect(probe.bindings[0]).toEqual([probe.tenant, probe.principal]);
    expect(probe.bindings[1]![0]).toMatch(uuid);
    expect(probe.bindings[1]![0]).not.toBe(probe.tenant);
    expect(probe.bindings[1]![1]).toBe(probe.principal);
    expect(probe.bindings[2]![0]).toBe(probe.tenant);
    expect(probe.bindings[2]![1]).toMatch(uuid);
    expect(probe.bindings[2]![1]).not.toBe(probe.principal);
    expect(probe.targetQueries).toEqual([
      'SELECT "id" AS id FROM "public"."items" ORDER BY "id" LIMIT 1',
      'SELECT "id" AS id FROM "public"."items" WHERE "id" = $1',
      'SELECT "id" AS id FROM "public"."items" WHERE "id" = $1',
    ]);
    expect(probe.clients.every((client) => client.release.mock.calls.length === 1 && client.end.mock.calls.length === 1)).toBe(true);
  });

  it("still denies cross-tenant and cross-principal reads under text policies", async () => {
    const probe = canaryProbe();
    expect((await probe.run()).at(-1)).toMatchObject({ ok: true, level: "pass" });
    expect(probe.bindings).toHaveLength(3);
    expect(probe.targetQueries).toHaveLength(3);
  });

  it.each(["tenant", "principal"] as const)("refuses a policy missing %s isolation", async (bypass) => {
    const probe = canaryProbe({ bypass });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("POSTGRES_RLS_CANARY_SCOPE_BYPASS");
    expect(probe.clients.every((client) => client.release.mock.calls.length === 1 && client.end.mock.calls.length === 1)).toBe(true);
  });

  it("does not call an empty visible scope proof of isolation", async () => {
    const probe = canaryProbe({ empty: true });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("POSTGRES_RLS_CANARY_NO_VISIBLE_ROW");
    expect(probe.targetQueries).toHaveLength(1);
  });

  it("refuses trusted context leaking across rollback and connection reuse", async () => {
    const probe = canaryProbe({ leak: true });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("POSTGRES_RLS_CONTEXT_LEAKED_ACROSS_TRANSACTION");
    expect(probe.targetQueries).toHaveLength(1);
  });

  it("reports a cast error without treating it as denial or disclosing the rejected value", async () => {
    const secret = "private-scope-value postgres://user:private-password@private-host/db";
    const probe = canaryProbe({ deniedError: Object.assign(new Error(`invalid input syntax for type uuid: ${secret}`), { code: "22P02" }) });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("22P02");
    expect(check.message).toMatch(/trusted.*setting|setting.*trusted/iu);
    expect(check.message).toMatch(/not verified/iu);
    expect(check.message).not.toContain(secret);
    expect(check.message).not.toContain("private-password");
    expect(probe.bindings).toHaveLength(2);
    expect(probe.clients.every((client) => client.release.mock.calls.length === 1 && client.end.mock.calls.length === 1)).toBe(true);
  });

  it("keeps unknown database failures redacted and fail-closed", async () => {
    const probe = canaryProbe({ deniedError: new Error("private unexpected database detail") });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("database probe failed");
    expect(check.message).not.toContain("private unexpected");
    expect(probe.bindings).toHaveLength(2);
  });

  it.each([
    { error: new Error("permission denied authentication timeout unknown database private text"), reason: "database probe failed" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "42501" }), reason: "permission denied" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "28P01" }), reason: "authentication failed" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "ETIMEDOUT" }), reason: "timeout" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "ECONNREFUSED" }), reason: "connection failed" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "42P01" }), reason: "configured object not found" },
  ])("B64 NEW9 I03550 uses structured probe facts and keeps unknown prose generic ($reason)", async ({ error, reason }) => {
    const probe = canaryProbe({ deniedError: error });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain(`(${reason})`);
    expect(check.message).not.toContain(error.message);
    expect(probe.bindings).toHaveLength(2);
  });
  it("B64 NEW9 supplementary I03550 leaves non-string driver codes unknown without coercion", async () => {
    const toString = vi.fn(() => "42501");
    const error = Object.assign(new Error("opaque supplementary diagnostic"), { code: { toString } });
    const probe = canaryProbe({ deniedError: error });
    const check = (await probe.run()).at(-1)!;
    expect(check).toMatchObject({ ok: false, level: "fail" });
    expect(check.message).toContain("(database probe failed)");
    expect(check.message).not.toContain(error.message);
    expect(toString).not.toHaveBeenCalled();
    expect(probe.bindings).toHaveLength(2);
  });

});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function canaryProbe(options: { uuidCasts?: boolean; bypass?: "tenant" | "principal"; empty?: boolean; leak?: boolean; deniedError?: Error } = {}) {
  const tenant = options.uuidCasts ? "11111111-1111-4111-8111-111111111111" : "trusted-tenant";
  const principal = options.uuidCasts ? "22222222-2222-4222-8222-222222222222" : "trusted-principal";
  const bindings: string[][] = [];
  const targetQueries: string[] = [];
  const clients: Array<{ release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
  postgres.pool.mockImplementation(() => {
    let current: string[] = [];
    const client = { release: vi.fn(), end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string, values: string[] = []) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "ROLLBACK") { if (!options.leak) current = []; return { rows: [] }; }
        if (sql.startsWith("SELECT set_config")) {
          current = [values[1]!, values[3]!]; bindings.push([...current]);
          return { rows: [] };
        }
        if (sql.startsWith("SELECT current_setting")) return { rows: [{ tenant: current[0], principal: current[1] }] };
        targetQueries.push(sql);
        if (options.uuidCasts && current.some((value) => !uuid.test(value))) {
          throw Object.assign(new Error("invalid input syntax for type uuid: rejected scope"), { code: "22P02" });
        }
        if (sql.includes("ORDER BY")) return { rows: options.empty ? [] : [{ id: "private-row-id" }] };
        if (options.deniedError) throw options.deniedError;
        const allowed = (options.bypass === "tenant" || current[0] === tenant)
          && (options.bypass === "principal" || current[1] === principal);
        return { rows: allowed ? [{ id: "private-row-id" }] : [], rowCount: allowed ? 1 : 0 };
      }),
    };
    clients.push(client);
    return { connect: async () => client, end: client.end };
  });
  vi.stubEnv("F10_DATABASE_URL", "postgresql://fixture.invalid/not-used");
  vi.stubEnv("SYNAPSOR_TENANT_ID", tenant);
  vi.stubEnv("SYNAPSOR_PRINCIPAL", principal);
  const source = { engine: "postgres", read_url_env: "F10_DATABASE_URL", database_scope: {
    mode: "postgres_rls", tenant_setting: "app.tenant_id", principal_setting: "app.principal_id",
  } };
  return { tenant, principal, bindings, targetQueries, clients,
    run: () => postgresRlsDoctorChecks({ config: { sources: { fixture: source }, capabilities: [] }, sourceName: "fixture", source,
      checkCanary: true, activeExploreBoundaries: [{ source: "fixture", pack: { resources: [{ schema: "public", table: "items", primary_key: "id" }] } }],
    } as never),
  };
}

describe("runtime doctor database probe cleanup", () => {
  it("uses active Explore resources as PostgreSQL RLS canary targets", () => {
    const targets = postgresRlsExploreTargets([
      {
        source: "local_postgres",
        pack: {
          resources: [
            { schema: "renewable_ops", table: "assets", primary_key: "asset_id" },
            {
              schema: "renewable_ops",
              table: "asset_catalog",
              primary_key: "catalog_id",
              shared_reference_scope: { acknowledged: true },
            },
          ],
        },
      },
      {
        source: "other_postgres",
        pack: { resources: [{ schema: "other", table: "rows", primary_key: "id" }] },
      },
      {
        source: "local_postgres",
        organization_scope: { mode: "single_organization" },
        pack: { resources: [{ schema: "renewable_ops", table: "global_rows", primary_key: "id" }] },
      },
    ] as never, "local_postgres");

    expect(targets).toEqual([
      { schema: "renewable_ops", table: "assets", primaryKey: "asset_id" },
    ]);
  });

  it("warns on legacy opaque vocabulary without failing active authority", () => {
    const warning = exploreVocabularyDoctorCheck("legacy_boundary", {
      id: "legacy.t_0031",
      selectable_fields: ["val_1"],
      filterable_fields: {},
      sortable_fields: [],
      groupable_fields: ["val_1"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
    } as never);
    expect(warning).toMatchObject({ ok: true, level: "warn" });
    expect(warning.message).toMatch(/table name.*val_1.*existing authority remains active/is);
    expect(warning.message).toContain("press I");

    const ready = exploreVocabularyDoctorCheck("sales", {
      id: "public.orders",
      selectable_fields: ["status"],
      filterable_fields: {},
      sortable_fields: [],
      groupable_fields: ["status"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
    } as never);
    expect(ready).toMatchObject({ ok: true, level: "pass" });

    const coded = exploreVocabularyDoctorCheck("construction", {
      id: "public.sites",
      selectable_fields: ["ph_code"],
      filterable_fields: { ph_code: ["eq"] },
      sortable_fields: ["ph_code"],
      groupable_fields: ["ph_code"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      field_enums: { ph_code: ["P1", "P2", "P3"] },
      kept_out_fields: [],
    } as never);
    expect(coded).toMatchObject({ ok: true, level: "warn" });
    expect(coded.message).toMatch(/ph_code.*activation remains valid.*not to infer/is);
  });

  it("closes a PostgreSQL pool when its initial connection fails", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockRejectedValue(new Error("database unavailable")),
      end,
    };

    await expect(withPostgresProbeClient(pool, async () => undefined))
      .rejects.toThrow("database unavailable");
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves a PostgreSQL probe error when cleanup also fails", async () => {
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release,
      }),
      end: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    };

    await expect(withPostgresProbeClient(pool, async () => {
      throw new Error("probe failed");
    })).rejects.toThrow("probe failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports a cleanup failure after a successful PostgreSQL probe", async () => {
    const pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release: vi.fn(),
      }),
      end: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    };

    await expect(withPostgresProbeClient(pool, async () => "ok"))
      .rejects.toThrow("cleanup failed");
  });

  it("ends the PostgreSQL pool when client release throws", async () => {
    const release = vi.fn(() => { throw new Error("release failed"); });
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockResolvedValue({ query: vi.fn(), release }),
      end,
    };

    await expect(withPostgresProbeClient(pool, async () => "ok"))
      .rejects.toThrow("release failed");
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves a MySQL probe error when connection cleanup also fails", async () => {
    const connection = {
      query: vi.fn(),
      beginTransaction: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    };

    await expect(withMysqlProbeConnection(connection, async () => {
      throw new Error("probe failed");
    })).rejects.toThrow("probe failed");
    expect(connection.end).toHaveBeenCalledOnce();
  });
});
