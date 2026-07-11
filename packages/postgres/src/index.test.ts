import { describe, expect, it } from "vitest";
import {
  applyPostgresJobWithClient,
  buildPostgresUpdate,
  normalizeVersionValue,
  postgresPoolConfig,
  versionValuesMatch,
  type PostgresApplyClient
} from "./index.js";

const job = {
  protocol_version: "1.0" as const,
  job_id: "wbj_1",
  proposal_id: "wrp://x",
  approval_id: "appr_1",
  source_id: "src_1",
  engine: "postgres" as const,
  target: {
    schema: "public",
    table: "tickets",
    primary_key: { column: "id", value: "T-1042" },
    tenant_guard: { column: "tenant_id", value: "acme" }
  },
  allowed_columns: ["status", "resolution_note"],
  patch: { status: "pending_review", resolution_note: "Needs approval" },
  conflict_guard: { kind: "version_column" as const, column: "updated_at", expected_value: "v1" },
  idempotency_key: "idem",
  lease_expires_at: 1
};

describe("postgres adapter", () => {
  it("preserves native timestamp text before proposal construction", () => {
    const types = postgresPoolConfig("postgresql://example.invalid/app").types;
    if (!types) throw new Error("custom postgres type parsers missing");
    const parseTimestamp = types.getTypeParser(1114, "text");
    const parseTimestampTz = types.getTypeParser(1184, "text");
    expect(parseTimestamp("2026-07-11 19:13:14.482135")).toBe("2026-07-11 19:13:14.482135");
    expect(parseTimestampTz("2026-07-11 19:13:14.482135+00")).toBe("2026-07-11 19:13:14.482135+00");
  });

  it("builds parameterized SQL", () => {
    const update = buildPostgresUpdate(job);
    expect(update.sql).toContain('UPDATE "public"."tickets"');
    expect(update.sql).toContain('"id" = $3');
    expect(update.sql).not.toContain("Needs approval");
    expect(update.values).toEqual(["pending_review", "Needs approval", "T-1042", "acme", "v1"]);
  });

  it("rejects unsafe identifiers", () => {
    expect(() => buildPostgresUpdate({ ...job, target: { ...job.target, table: "tickets;drop" } })).toThrow(/unsafe/i);
  });

  it("rejects non-allowlisted and protected patch columns at the adapter boundary", () => {
    expect(() => buildPostgresUpdate({ ...job, patch: { admin_note: "bypass" } })).toThrow(/not allowlisted/i);
    expect(() => buildPostgresUpdate({ ...job, allowed_columns: ["id", "status"] })).toThrow(/primary key/i);
    expect(() => buildPostgresUpdate({ ...job, allowed_columns: ["tenant_id", "status"] })).toThrow(/tenant guard/i);
    expect(() => buildPostgresUpdate({ ...job, patch: {} })).toThrow(/must not be empty/i);
  });

  it("compares timestamp guards at microsecond precision", () => {
    expect(normalizeVersionValue("2026-05-16T00:00:00Z")).toBe("2026-05-16 00:00:00.000000");
    expect(versionValuesMatch("2026-05-16 00:00:00.123456", "2026-05-16T00:00:00.123456Z")).toBe(true);
    expect(versionValuesMatch("2026-05-16 00:00:00.123456", "2026-05-16T00:00:00.123Z")).toBe(false);
    expect(versionValuesMatch("2026-06-20 14:31:08+00", "2026-06-20T14:31:08Z")).toBe(true);
    expect(versionValuesMatch("2026-06-20 07:31:08-07", "2026-06-20T14:31:08Z")).toBe(true);
  });

  it("returns an idempotent receipt without touching the business row", async () => {
    const client = new FakePostgresClient({
      claimRowCount: 0,
      receiptRow: { status: "applied", result_hash: "sha256:existing" }
    });

    const result = await applyPostgresJobWithClient(job, config, client);

    expect(result.status).toBe("already_applied");
    expect(result.result_hash).toBe("sha256:existing");
    expect(client.sqlLog.some((sql) => /CREATE\s+TABLE/i.test(sql))).toBe(false);
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(false);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("records stale-row conflicts before update", async () => {
    const client = new FakePostgresClient({
      businessRow: { __synapsor_conflict_value: "2026-05-16 00:00:00.123456" }
    });

    const result = await applyPostgresJobWithClient(
      { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123Z" } },
      config,
      client
    );

    expect(result.status).toBe("conflict");
    expect(result.error_code).toBe("VERSION_CONFLICT");
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(false);
    expect(client.recordedReceiptStatus).toBe("conflict");
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("blocks missing primary-key or tenant-scoped rows before update", async () => {
    const client = new FakePostgresClient();

    const result = await applyPostgresJobWithClient(job, config, client);

    expect(result.status).toBe("conflict");
    expect(result.error_code).toBe("ROW_NOT_FOUND");
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(false);
    expect(client.recordedReceiptStatus).toBe("conflict");
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("rolls back when the guarded update affects zero rows after lock", async () => {
    const client = new FakePostgresClient({
      businessRow: { __synapsor_conflict_value: "2026-05-16 00:00:00.123456" },
      businessUpdateRowCount: 0
    });

    await expect(
      applyPostgresJobWithClient(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        client
      )
    ).rejects.toThrow(/VERSION_CONFLICT/);
    expect(client.sqlLog).toContain("ROLLBACK");
  });

  it("allows only one concurrent duplicate apply to touch the business row", async () => {
    const state = new ConcurrentReceiptState();
    const first = new ConcurrentPostgresClient(state);
    const second = new ConcurrentPostgresClient(state);

    const [firstResult, secondResult] = await Promise.all([
      applyPostgresJobWithClient(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        first
      ),
      applyPostgresJobWithClient(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        second
      )
    ]);

    expect([firstResult.status, secondResult.status].sort()).toEqual(["already_applied", "applied"]);
    expect((firstResult.affected_rows ?? 0) + (secondResult.affected_rows ?? 0)).toBe(1);
    expect(state.businessUpdates).toBe(1);
  });

  it("applies one matching row and records the receipt", async () => {
    const client = new FakePostgresClient({
      businessRow: { __synapsor_conflict_value: "2026-05-16 00:00:00.123456" },
      businessUpdateRowCount: 1
    });

    const result = await applyPostgresJobWithClient(
      { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
      config,
      client
    );

    expect(result.status).toBe("applied");
    expect(result.affected_rows).toBe(1);
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(true);
    expect(client.recordedReceiptStatus).toBe("applied");
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("treats multi-row updates as fatal and rolls back", async () => {
    const client = new FakePostgresClient({
      businessRow: { __synapsor_conflict_value: "2026-05-16 00:00:00.123456" },
      businessUpdateRowCount: 2
    });

    await expect(
      applyPostgresJobWithClient(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        client
      )
    ).rejects.toThrow(/MULTI_ROW_WRITE_BLOCKED/);
    expect(client.sqlLog).toContain("ROLLBACK");
  });

  it("rolls back when receipt recording fails after the business update", async () => {
    const client = new FakePostgresClient({
      businessRow: { __synapsor_conflict_value: "2026-05-16 00:00:00.123456" },
      businessUpdateRowCount: 1,
      receiptUpdateRowCount: 0
    });

    await expect(
      applyPostgresJobWithClient(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        client
      )
    ).rejects.toThrow(/IDEMPOTENCY_RECEIPT_UNAVAILABLE/);
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(true);
    expect(client.sqlLog).toContain("ROLLBACK");
  });
});

const config = {
  controlPlaneUrl: "http://127.0.0.1",
  runnerToken: "syn_wbr_test",
  runnerId: "runner-test",
  sourceId: "src_1",
  databaseUrl: "postgresql://user:redacted@127.0.0.1/db",
  engine: "postgres" as const,
  pollIntervalMs: 1000,
  logLevel: "info" as const,
  dryRun: false,
  stateDir: ".synapsor"
};

class FakePostgresClient implements PostgresApplyClient {
  readonly sqlLog: string[] = [];
  recordedReceiptStatus?: string;

  constructor(private readonly options: {
    claimRowCount?: number;
    receiptRow?: Record<string, unknown>;
    businessRow?: Record<string, unknown>;
    businessUpdateRowCount?: number;
    receiptUpdateRowCount?: number;
  } = {}) {}

  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sqlLog.push(sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ? sql : sql.trim());
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts")) return { rows: [], rowCount: null };
    if (sql.startsWith("INSERT INTO synapsor_writeback_receipts")) {
      const rowCount = this.options.claimRowCount ?? 1;
      return { rows: rowCount === 1 ? [{ status: "in_progress", result_hash: null }] : [], rowCount };
    }
    if (sql.startsWith("SELECT status, result_hash FROM synapsor_writeback_receipts")) {
      return { rows: this.options.receiptRow ? [this.options.receiptRow] : [], rowCount: this.options.receiptRow ? 1 : 0 };
    }
    if (sql.startsWith("SELECT *")) {
      return { rows: this.options.businessRow ? [this.options.businessRow] : [], rowCount: this.options.businessRow ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE "public"."tickets"')) {
      return { rows: [], rowCount: this.options.businessUpdateRowCount ?? 1 };
    }
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.recordedReceiptStatus = String(values?.[1]);
      return { rows: [], rowCount: this.options.receiptUpdateRowCount ?? 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

class ConcurrentReceiptState {
  claimed = false;
  receiptStatus = "in_progress";
  resultHash: string | null = null;
  businessUpdates = 0;
  private finalized = false;
  private finalize!: () => void;
  readonly finalizedPromise = new Promise<void>((resolve) => {
    this.finalize = resolve;
  });

  markFinal(status: string, hash: string): void {
    this.receiptStatus = status;
    this.resultHash = hash;
    if (!this.finalized) {
      this.finalized = true;
      this.finalize();
    }
  }
}

class ConcurrentPostgresClient implements PostgresApplyClient {
  constructor(private readonly state: ConcurrentReceiptState) {}

  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts")) return { rows: [], rowCount: null };
    if (sql.startsWith("INSERT INTO synapsor_writeback_receipts")) {
      if (!this.state.claimed) {
        this.state.claimed = true;
        return { rows: [{ status: "in_progress", result_hash: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT status, result_hash FROM synapsor_writeback_receipts")) {
      await this.state.finalizedPromise;
      return {
        rows: [{ status: this.state.receiptStatus, result_hash: this.state.resultHash }],
        rowCount: 1
      };
    }
    if (sql.startsWith("SELECT *")) {
      return { rows: [{ __synapsor_conflict_value: "2026-05-16 00:00:00.123456" }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "public"."tickets"')) {
      this.state.businessUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.state.markFinal(String(values?.[1]), String(values?.[2]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}
