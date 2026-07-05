import { describe, expect, it } from "vitest";
import {
  applyMysqlJobWithConnection,
  buildMysqlUpdate,
  normalizeVersionValue,
  versionValuesMatch,
  type MysqlApplyConnection
} from "./index.js";

const job = {
  protocol_version: "1.0" as const,
  job_id: "wbj_1",
  proposal_id: "wrp://x",
  approval_id: "appr_1",
  source_id: "src_1",
  engine: "mysql" as const,
  target: {
    schema: "appdb",
    table: "orders",
    primary_key: { column: "id", value: "O-1" },
    tenant_guard: { column: "tenant_id", value: "acme" }
  },
  allowed_columns: ["status"],
  patch: { status: "refund_requested" },
  conflict_guard: { kind: "version_column" as const, column: "updated_at", expected_value: "v1" },
  idempotency_key: "idem",
  lease_expires_at: 1
};

describe("mysql adapter", () => {
  it("builds parameterized SQL", () => {
    const update = buildMysqlUpdate(job);
    expect(update.sql).toContain("UPDATE `appdb`.`orders`");
    expect(update.sql).not.toContain("refund_requested");
    expect(update.values).toEqual(["refund_requested", "O-1", "acme", "v1"]);
  });

  it("rejects unsafe identifiers", () => {
    expect(() => buildMysqlUpdate({ ...job, target: { ...job.target, table: "orders;drop" } })).toThrow(/unsafe/i);
  });

  it("rejects non-allowlisted and protected patch columns at the adapter boundary", () => {
    expect(() => buildMysqlUpdate({ ...job, patch: { admin_note: "bypass" } })).toThrow(/not allowlisted/i);
    expect(() => buildMysqlUpdate({ ...job, allowed_columns: ["id", "status"] })).toThrow(/primary key/i);
    expect(() => buildMysqlUpdate({ ...job, allowed_columns: ["tenant_id", "status"] })).toThrow(/tenant guard/i);
    expect(() => buildMysqlUpdate({ ...job, patch: {} })).toThrow(/must not be empty/i);
  });

  it("compares timestamp guards at microsecond precision", () => {
    expect(normalizeVersionValue("2026-05-16T00:00:00Z")).toBe("2026-05-16 00:00:00.000000");
    expect(versionValuesMatch("2026-05-16 00:00:00.123456", "2026-05-16T00:00:00.123456Z")).toBe(true);
    expect(versionValuesMatch("2026-05-16 00:00:00.123456", "2026-05-16T00:00:00.123Z")).toBe(false);
    expect(versionValuesMatch("2026-06-20 14:31:08+00", "2026-06-20T14:31:08Z")).toBe(true);
    expect(versionValuesMatch("2026-06-20 07:31:08-07", "2026-06-20T14:31:08Z")).toBe(true);
  });

  it("returns an idempotent receipt without touching the business row", async () => {
    const connection = new FakeMysqlConnection({
      claimAffectedRows: 0,
      receiptRow: { status: "applied", result_hash: "sha256:existing" }
    });

    const result = await applyMysqlJobWithConnection(job, config, connection);

    expect(result.status).toBe("already_applied");
    expect(result.result_hash).toBe("sha256:existing");
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(false);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("records stale-row conflicts before update", async () => {
    const connection = new FakeMysqlConnection({
      businessRow: { updated_at: "2026-05-16 00:00:00.123456" }
    });

    const result = await applyMysqlJobWithConnection(
      { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123Z" } },
      config,
      connection
    );

    expect(result.status).toBe("conflict");
    expect(result.error_code).toBe("VERSION_CONFLICT");
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(false);
    expect(connection.recordedReceiptStatus).toBe("conflict");
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("blocks missing primary-key or tenant-scoped rows before update", async () => {
    const connection = new FakeMysqlConnection();

    const result = await applyMysqlJobWithConnection(job, config, connection);

    expect(result.status).toBe("conflict");
    expect(result.error_code).toBe("ROW_NOT_FOUND");
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(false);
    expect(connection.recordedReceiptStatus).toBe("conflict");
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("rolls back when the guarded update affects zero rows after lock", async () => {
    const connection = new FakeMysqlConnection({
      businessRow: { updated_at: "2026-05-16 00:00:00.123456" },
      businessUpdateAffectedRows: 0
    });

    await expect(
      applyMysqlJobWithConnection(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        connection
      )
    ).rejects.toThrow(/VERSION_CONFLICT/);
    expect(connection.sqlLog).toContain("ROLLBACK");
  });

  it("allows only one concurrent duplicate apply to touch the business row", async () => {
    const state = new ConcurrentReceiptState();
    const first = new ConcurrentMysqlConnection(state);
    const second = new ConcurrentMysqlConnection(state);

    const [firstResult, secondResult] = await Promise.all([
      applyMysqlJobWithConnection(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        first
      ),
      applyMysqlJobWithConnection(
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
    const connection = new FakeMysqlConnection({
      businessRow: { updated_at: "2026-05-16 00:00:00.123456" },
      businessUpdateAffectedRows: 1
    });

    const result = await applyMysqlJobWithConnection(
      { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
      config,
      connection
    );

    expect(result.status).toBe("applied");
    expect(result.affected_rows).toBe(1);
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(true);
    expect(connection.recordedReceiptStatus).toBe("applied");
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("treats multi-row updates as fatal and rolls back", async () => {
    const connection = new FakeMysqlConnection({
      businessRow: { updated_at: "2026-05-16 00:00:00.123456" },
      businessUpdateAffectedRows: 2
    });

    await expect(
      applyMysqlJobWithConnection(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        connection
      )
    ).rejects.toThrow(/MULTI_ROW_WRITE_BLOCKED/);
    expect(connection.sqlLog).toContain("ROLLBACK");
  });

  it("rolls back when receipt recording fails after the business update", async () => {
    const connection = new FakeMysqlConnection({
      businessRow: { updated_at: "2026-05-16 00:00:00.123456" },
      businessUpdateAffectedRows: 1,
      receiptUpdateAffectedRows: 0
    });

    await expect(
      applyMysqlJobWithConnection(
        { ...job, conflict_guard: { ...job.conflict_guard, expected_value: "2026-05-16T00:00:00.123456Z" } },
        config,
        connection
      )
    ).rejects.toThrow(/IDEMPOTENCY_RECEIPT_UNAVAILABLE/);
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(true);
    expect(connection.sqlLog).toContain("ROLLBACK");
  });
});

const config = {
  controlPlaneUrl: "http://127.0.0.1",
  runnerToken: "syn_wbr_test",
  runnerId: "runner-test",
  sourceId: "src_1",
  databaseUrl: "mysql://user:redacted@127.0.0.1/db",
  engine: "mysql" as const,
  pollIntervalMs: 1000,
  logLevel: "info" as const,
  dryRun: false,
  stateDir: ".synapsor"
};

class FakeMysqlConnection implements MysqlApplyConnection {
  readonly sqlLog: string[] = [];
  recordedReceiptStatus?: string;

  constructor(private readonly options: {
    claimAffectedRows?: number;
    receiptRow?: Record<string, unknown>;
    businessRow?: Record<string, unknown>;
    businessUpdateAffectedRows?: number;
    receiptUpdateAffectedRows?: number;
  } = {}) {}

  async beginTransaction(): Promise<void> {
    this.sqlLog.push("BEGIN");
  }

  async commit(): Promise<void> {
    this.sqlLog.push("COMMIT");
  }

  async rollback(): Promise<void> {
    this.sqlLog.push("ROLLBACK");
  }

  async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
    this.sqlLog.push(sql.trim());
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts")) {
      return [undefined as T, undefined];
    }
    if (sql.startsWith("INSERT IGNORE INTO synapsor_writeback_receipts")) {
      return [{ affectedRows: this.options.claimAffectedRows ?? 1 } as T, undefined];
    }
    if (sql.startsWith("SELECT status, result_hash FROM synapsor_writeback_receipts")) {
      return [[...(this.options.receiptRow ? [this.options.receiptRow] : [])] as T, undefined];
    }
    if (sql.startsWith("SELECT *")) {
      return [[...(this.options.businessRow ? [this.options.businessRow] : [])] as T, undefined];
    }
    if (sql.startsWith("UPDATE `appdb`.`orders`")) {
      return [{ affectedRows: this.options.businessUpdateAffectedRows ?? 1 } as T, undefined];
    }
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.recordedReceiptStatus = String(values?.[0]);
      return [{ affectedRows: this.options.receiptUpdateAffectedRows ?? 1 } as T, undefined];
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

class ConcurrentMysqlConnection implements MysqlApplyConnection {
  constructor(private readonly state: ConcurrentReceiptState) {}

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts")) {
      return [undefined as T, undefined];
    }
    if (sql.startsWith("INSERT IGNORE INTO synapsor_writeback_receipts")) {
      if (!this.state.claimed) {
        this.state.claimed = true;
        return [{ affectedRows: 1 } as T, undefined];
      }
      return [{ affectedRows: 0 } as T, undefined];
    }
    if (sql.startsWith("SELECT status, result_hash FROM synapsor_writeback_receipts")) {
      await this.state.finalizedPromise;
      return [[{ status: this.state.receiptStatus, result_hash: this.state.resultHash }] as T, undefined];
    }
    if (sql.startsWith("SELECT *")) {
      return [[{ updated_at: "2026-05-16 00:00:00.123456" }] as T, undefined];
    }
    if (sql.startsWith("UPDATE `appdb`.`orders`")) {
      this.state.businessUpdates += 1;
      return [{ affectedRows: 1 } as T, undefined];
    }
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.state.markFinal(String(values?.[0]), String(values?.[1]));
      return [{ affectedRows: 1 } as T, undefined];
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}
