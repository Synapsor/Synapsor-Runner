import { describe, expect, it } from "vitest";
import {
  applyMysqlJobWithConnection,
  buildMysqlDelete,
  buildMysqlInsert,
  buildMysqlReconciliationRead,
  buildMysqlUpdate,
  normalizeVersionValue,
  versionValuesMatch,
  type MysqlApplyConnection
} from "./index.js";
import type { WritebackIntentStore } from "@synapsor-runner/worker-core";

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

  it("builds parameterized v2 INSERT and guarded DELETE statements", () => {
    const insertion = buildMysqlInsert(v2InsertJob);
    expect(insertion.sql).toContain("INSERT INTO `appdb`.`credits`");
    expect(insertion.sql).not.toContain("acme");
    expect(insertion.values).toEqual([2500, "acme", "wrp_insert"]);
    const deletion = buildMysqlDelete(v2DeleteJob);
    expect(deletion.sql).toContain("DELETE FROM `appdb`.`credits`");
    expect(deletion.sql).toContain("`version` = ?");
    expect(deletion.values).toEqual(["CR-1", "acme", 7]);
  });

  it("builds reconciliation reads from reviewed columns and trusted identity only", () => {
    const update = buildMysqlReconciliationRead(v2UpdateJob);
    expect(update.sql).toContain("SELECT `id`, `tenant_id`, `amount_cents`, `version`");
    expect(update.sql).not.toContain("SELECT *");
    expect(update.sql).not.toContain("private_note");
    expect(update.values).toEqual(["CR-1", "acme"]);

    const insert = buildMysqlReconciliationRead(v2InsertJob);
    expect(insert.sql).toContain("`tenant_id` = ? AND `request_id` = ?");
    expect(insert.sql).not.toContain("SELECT *");
    expect(insert.values).toEqual(["acme", "wrp_insert"]);
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
    expect(connection.sqlLog.some((sql) => /CREATE\s+TABLE/i.test(sql))).toBe(false);
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

  it("atomically applies source-receipted single-row INSERT and DELETE", async () => {
    const insertConnection = new CrudMysqlConnection("insert");
    const inserted = await applyMysqlJobWithConnection(v2InsertJob, config, insertConnection);
    expect(inserted).toMatchObject({ protocol_version: "2.0", operation: "single_row_insert", status: "applied", affected_rows: 1, receipt_authority: "source_db" });
    expect(insertConnection.sqlLog).toContain("COMMIT");
    expect(insertConnection.sqlLog.some((sql) => sql.startsWith("INSERT INTO `appdb`.`credits`"))).toBe(true);
    expect(insertConnection.recordedReceiptStatus).toBe("applied");

    const deleteConnection = new CrudMysqlConnection("delete");
    const deleted = await applyMysqlJobWithConnection(v2DeleteJob, config, deleteConnection);
    expect(deleted).toMatchObject({ protocol_version: "2.0", operation: "single_row_delete", status: "applied", affected_rows: 1, receipt_authority: "source_db" });
    expect(deleteConnection.sqlLog).toContain("COMMIT");
    expect(deleteConnection.sqlLog.some((sql) => sql.startsWith("DELETE FROM `appdb`.`credits`"))).toBe(true);
    expect(deleteConnection.sqlLog.some((sql) => /SELECT\s+\*/i.test(sql))).toBe(false);
    expect(deleteConnection.recordedReceiptStatus).toBe("applied");
  });

  it("fails hard DELETE closed when trigger metadata visibility is not provable", async () => {
    const connection = new CrudMysqlConnection("delete", { trigger: false, foreignKeys: true });
    const result = await applyMysqlJobWithConnection(v2DeleteJob, config, connection);

    expect(result).toMatchObject({ status: "failed", error_code: "DELETE_TRIGGER_VISIBILITY_REQUIRED", affected_rows: 0 });
    expect(connection.sqlLog.some((sql) => sql.startsWith("DELETE FROM"))).toBe(false);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("fails hard DELETE closed when incoming-FK metadata visibility is not provable", async () => {
    const connection = new CrudMysqlConnection("delete", { trigger: true, foreignKeys: false });
    const result = await applyMysqlJobWithConnection(v2DeleteJob, config, connection);

    expect(result).toMatchObject({ status: "failed", error_code: "DELETE_FK_VISIBILITY_REQUIRED", affected_rows: 0 });
    expect(connection.sqlLog.some((sql) => sql.startsWith("DELETE FROM"))).toBe(false);
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
    ).rejects.toThrow(/SOURCE_RECEIPT_UNAVAILABLE/);
    expect(connection.sqlLog.some((sql) => sql.includes("UPDATE `appdb`.`orders`"))).toBe(true);
    expect(connection.sqlLog).toContain("ROLLBACK");
  });

  it("uses the Runner ledger without source receipt DDL or DML", async () => {
    const connection = new V2MysqlConnection();
    const intents = new FakeIntentStore();
    const result = await applyMysqlJobWithConnection(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
    }, connection);
    expect(result).toMatchObject({ protocol_version: "2.0", status: "applied", affected_rows: 1, result_version: 8, receipt_authority: "runner_ledger" });
    expect(intents.calls).toEqual(["claim", "applying", "complete"]);
    expect(connection.sqlLog.some((sql) => sql.includes("synapsor_writeback_receipts"))).toBe(false);
    expect(connection.sqlLog.some((sql) => /SELECT\s+\*/i.test(sql))).toBe(false);
  });

  it("rolls back a known pre-COMMIT failure and terminally records it", async () => {
    const connection = new V2MysqlConnection();
    const intents = new FakeIntentStore();
    const result = await applyMysqlJobWithConnection(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "before_source_commit") throw new Error("simulated pre-commit stop");
      },
    }, connection);
    expect(result).toMatchObject({ status: "failed", error_code: "TRANSACTION_FAILED" });
    expect(intents.calls).toEqual(["claim", "applying", "complete"]);
    expect(connection.sqlLog).toContain("ROLLBACK");
    expect(connection.sqlLog).not.toContain("COMMIT");
  });

  it("requires reconciliation when rollback acknowledgement is lost", async () => {
    const connection = new RollbackUnknownMysqlConnection();
    const intents = new FakeIntentStore();
    const result = await applyMysqlJobWithConnection(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_mutation") throw new Error("simulated connection loss");
      },
    }, connection);
    expect(result).toMatchObject({ status: "reconciliation_required", error_code: "RECONCILIATION_REQUIRED" });
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
  });
});

const v2UpdateJob = {
  protocol_version: "2.0" as const, job_id: "wbj_v2_update", proposal_id: "wrp_update", approval_id: "sha256:approval", source_id: "src_1", engine: "mysql" as const,
  operation: "single_row_update" as const,
  target: { schema: "appdb", table: "credits", primary_key: { column: "id", value: "CR-1" }, tenant_guard: { column: "tenant_id", value: "acme" } },
  allowed_columns: ["amount_cents"], patch: { amount_cents: 2500 },
  conflict_guard: { kind: "version_column" as const, column: "version", expected_value: 7 },
  version_advance: { column: "version", strategy: "integer_increment" as const },
  idempotency_key: "wrp_update:CR-1", lease_expires_at: "2026-07-13T12:00:00Z", attempt_count: 1,
};
const v2InsertJob = {
  protocol_version: "2.0" as const, job_id: "wbj_v2_insert", proposal_id: "wrp_insert", approval_id: "sha256:approval", source_id: "src_1", engine: "mysql" as const,
  operation: "single_row_insert" as const,
  target: { schema: "appdb", table: "credits", primary_key: { column: "id" }, tenant_guard: { column: "tenant_id", value: "acme" } },
  allowed_columns: ["amount_cents"], patch: { amount_cents: 2500 }, conflict_guard: { kind: "none" as const },
  deduplication: { components: [{ column: "tenant_id", value: "acme", source: "trusted_tenant" as const }, { column: "request_id", value: "wrp_insert", source: "proposal_id" as const }] },
  idempotency_key: "wrp_insert:credits", lease_expires_at: "2026-07-13T12:00:00Z", attempt_count: 1,
};
const v2DeleteJob = {
  protocol_version: "2.0" as const, job_id: "wbj_v2_delete", proposal_id: "wrp_delete", approval_id: "sha256:approval", source_id: "src_1", engine: "mysql" as const,
  operation: "single_row_delete" as const,
  target: { schema: "appdb", table: "credits", primary_key: { column: "id", value: "CR-1" }, tenant_guard: { column: "tenant_id", value: "acme" } },
  allowed_columns: [], patch: {}, conflict_guard: { kind: "version_column" as const, column: "version", expected_value: 7 },
  idempotency_key: "wrp_delete:CR-1", lease_expires_at: "2026-07-13T12:00:00Z", attempt_count: 1,
};

class V2MysqlConnection implements MysqlApplyConnection {
  readonly sqlLog: string[] = [];
  async beginTransaction() { this.sqlLog.push("BEGIN"); }
  async commit() { this.sqlLog.push("COMMIT"); }
  async rollback() { this.sqlLog.push("ROLLBACK"); }
  async query<T = unknown>(sql: string): Promise<[T, unknown]> {
    this.sqlLog.push(sql);
    if (sql.startsWith("SELECT `id` AS __synapsor_primary_key")) return [[{ __synapsor_primary_key: "CR-1", __synapsor_conflict_value: 7 }] as T, undefined];
    if (sql.startsWith("UPDATE `appdb`.`credits`")) return [{ affectedRows: 1 } as T, undefined];
    if (sql.startsWith("SELECT `version` AS __synapsor_result_version")) return [[{ __synapsor_result_version: 8 }] as T, undefined];
    throw new Error(`unexpected v2 query: ${sql}`);
  }
}
class RollbackUnknownMysqlConnection extends V2MysqlConnection {
  override async rollback() {
    throw new Error("connection lost during rollback");
  }
}
class CrudMysqlConnection implements MysqlApplyConnection {
  readonly sqlLog: string[] = [];
  recordedReceiptStatus?: string;

  constructor(
    private readonly operation: "insert" | "delete",
    private readonly visibility: { trigger: boolean; foreignKeys: boolean } = { trigger: true, foreignKeys: true },
  ) {}

  async beginTransaction() { this.sqlLog.push("BEGIN"); }
  async commit() { this.sqlLog.push("COMMIT"); }
  async rollback() { this.sqlLog.push("ROLLBACK"); }

  async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
    this.sqlLog.push(sql);
    if (sql.startsWith("INSERT IGNORE INTO synapsor_writeback_receipts")) return [{ affectedRows: 1 } as T, undefined];
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.recordedReceiptStatus = String(values?.[0]);
      return [{ affectedRows: 1 } as T, undefined];
    }
    if (this.operation === "insert" && sql.startsWith("SELECT `id` AS __synapsor_primary_key FROM")) return [[] as T, undefined];
    if (this.operation === "insert" && sql.startsWith("INSERT INTO `appdb`.`credits`")) return [{ affectedRows: 1, insertId: "CR-NEW" } as T, undefined];
    if (this.operation === "delete" && sql.startsWith("SELECT `id` AS __synapsor_primary_key")) {
      return [[{ __synapsor_primary_key: "CR-1", __synapsor_conflict_value: 7 }] as T, undefined];
    }
    if (this.operation === "delete" && sql.includes("has_trigger_visibility")) return [[{
      has_trigger_visibility: this.visibility.trigger ? 1 : 0,
      has_fk_visibility: this.visibility.foreignKeys ? 1 : 0,
    }] as T, undefined];
    if (this.operation === "delete" && sql.includes("information_schema.TRIGGERS")) return [[] as T, undefined];
    if (this.operation === "delete" && sql.includes("information_schema.INNODB_FOREIGN")) return [[] as T, undefined];
    if (this.operation === "delete" && sql.startsWith("DELETE FROM `appdb`.`credits`")) return [{ affectedRows: 1 } as T, undefined];
    throw new Error(`unexpected CRUD query: ${sql}`);
  }
}
class FakeIntentStore implements WritebackIntentStore {
  readonly calls: string[] = [];
  claimWritebackIntent() { this.calls.push("claim"); return { decision: "proceed" as const, intent_id: "wbi:test" }; }
  markWritebackIntentApplying() { this.calls.push("applying"); }
  completeWritebackIntent() { this.calls.push("complete"); }
  requireWritebackReconciliation() { this.calls.push("reconciliation"); }
}

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
    if (sql.startsWith("SELECT") && sql.includes("FROM `appdb`.`orders`") && sql.includes("FOR UPDATE")) {
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
    if (sql.startsWith("SELECT") && sql.includes("FROM `appdb`.`orders`") && sql.includes("FOR UPDATE")) {
      return [[{ __synapsor_conflict_value: "2026-05-16 00:00:00.123456" }] as T, undefined];
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
