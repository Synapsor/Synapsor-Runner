import { describe, expect, it, vi } from "vitest";
import {
  exploreVocabularyDoctorCheck,
  withMysqlProbeConnection,
  withPostgresProbeClient,
} from "./runtime-doctor.js";

describe("runtime doctor database probe cleanup", () => {
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
