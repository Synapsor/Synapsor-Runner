import crypto from "node:crypto";
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
import { canonicalJsonStringify } from "@synapsor-runner/protocol";

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

  it("binds trusted principal scope on UPDATE, INSERT, DELETE, and reconciliation", () => {
    const update = buildMysqlUpdate(withPrincipalScope(v2UpdateJob));
    expect(update.sql).toContain("`assigned_to` = ?");
    expect(update.values).toEqual([2500, "CR-1", "acme", "support_agent_17", 7]);

    const insertion = buildMysqlInsert(withPrincipalScope(v2InsertJob));
    expect(insertion.sql).toContain("`assigned_to`");
    expect(insertion.values).toEqual([2500, "acme", "wrp_insert", "support_agent_17"]);

    const deletion = buildMysqlDelete(withPrincipalScope(v2DeleteJob));
    expect(deletion.sql).toContain("`assigned_to` = ?");
    expect(deletion.values).toEqual(["CR-1", "acme", "support_agent_17", 7]);

    const reconciliation = buildMysqlReconciliationRead(withPrincipalScope(v2UpdateJob));
    expect(reconciliation.sql).toContain("`assigned_to` = ?");
    expect(reconciliation.values).toEqual(["CR-1", "acme", "support_agent_17"]);
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
    expect(() => canonicalJsonStringify(result)).not.toThrow();
    expect(result).not.toHaveProperty("result_version");
    expect(result).not.toHaveProperty("error_code");
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

  it("atomically applies an exact frozen set and emits per-member effects", async () => {
    const connection = new SetMysqlConnection();
    const result = await applyMysqlJobWithConnection(v3SetUpdateJob(), config, connection);

    expect(result).toMatchObject({
      protocol_version: "3.0",
      operation: "set_update",
      status: "applied",
      affected_rows: 2,
      member_effects: [
        { primary_key: { column: "id", value: "INV-1" } },
        { primary_key: { column: "id", value: "INV-2" } },
      ],
    });
    expect(connection.sqlLog.filter((sql) => sql.startsWith("UPDATE `appdb`.`invoices`"))).toHaveLength(2);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("applies a reviewed compensation with a fresh guard and emits a revert-of-revert inverse", async () => {
    const connection = new CompensationMysqlConnection();
    const result = await applyMysqlJobWithConnection(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: new FakeIntentStore(),
    }, connection);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      operation: "restore_update",
      status: "applied",
      affected_rows: 1,
      inverse: { operation: "restore_update", lineage: { depth: 2 } },
    });
    expect(connection.sqlLog.some((sql) => sql.startsWith("UPDATE `appdb`.`credits`"))).toBe(true);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("fails a stale compensation closed before mutation", async () => {
    const connection = new CompensationMysqlConnection(true);
    const result = await applyMysqlJobWithConnection(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: new FakeIntentStore(),
    }, connection);

    expect(result).toMatchObject({ protocol_version: "4.0", status: "conflict", error_code: "ROW_CHANGED_AFTER_FORWARD_WRITE", affected_rows: 0 });
    expect(connection.sqlLog.some((sql) => sql.startsWith("UPDATE `appdb`.`credits`"))).toBe(false);
  });

  it("requires reconciliation when a compensation stops after source COMMIT", async () => {
    const connection = new CompensationMysqlConnection();
    const intents = new FakeIntentStore();
    const result = await applyMysqlJobWithConnection(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_commit") throw new Error("simulated compensation process death");
      },
    }, connection);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      operation: "restore_update",
      status: "reconciliation_required",
      error_code: "RECONCILIATION_REQUIRED",
      intent_id: "wbi:test",
    });
    expect(result).not.toHaveProperty("inverse");
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("requires reconciliation when compensation rollback acknowledgement is lost", async () => {
    const connection = new RollbackUnknownCompensationMysqlConnection();
    const intents = new FakeIntentStore();
    const result = await applyMysqlJobWithConnection(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_mutation") throw new Error("simulated compensation connection loss");
      },
    }, connection);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      status: "reconciliation_required",
      error_code: "RECONCILIATION_REQUIRED",
    });
    expect(result).not.toHaveProperty("inverse");
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
  });

  it("bounds direct write preflight execution and lock waits for the session", async () => {
    const connection = new SetMysqlConnection();
    const result = await applyMysqlJobWithConnection(v3SetUpdateJob(), { ...config, statementTimeoutMs: 2500 }, connection);

    expect(result.status).toBe("applied");
    expect(connection.sqlLog.slice(0, 3)).toEqual([
      "SET SESSION max_execution_time = ?",
      "SET SESSION innodb_lock_wait_timeout = ?",
      "BEGIN",
    ]);
    expect(connection.timeoutValues).toEqual([[2500], [3]]);
  });

  it("fails a stale frozen member closed before any set mutation", async () => {
    const connection = new SetMysqlConnection({ staleSecond: true });
    const result = await applyMysqlJobWithConnection(v3SetUpdateJob(), config, connection);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "conflict", affected_rows: 0, error_code: "SET_DRIFT_CONFLICT" });
    expect(connection.sqlLog.some((sql) => sql.startsWith("UPDATE `appdb`.`invoices`"))).toBe(false);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("rolls back the whole frozen set when any member mutation is anomalous", async () => {
    const connection = new SetMysqlConnection({ failMutationAt: 2 });
    await expect(applyMysqlJobWithConnection(v3SetUpdateJob(), config, connection)).rejects.toThrow(/SET_ATOMICITY_VIOLATION/);
    expect(connection.sqlLog.filter((sql) => sql.startsWith("UPDATE `appdb`.`invoices`"))).toHaveLength(2);
    expect(connection.sqlLog).toContain("ROLLBACK");
    expect(connection.sqlLog).not.toContain("COMMIT");
  });

  it("preflights every batch identity before INSERT and blocks duplicates atomically", async () => {
    const connection = new SetMysqlConnection({ duplicateBatchAt: 2 });
    const result = await applyMysqlJobWithConnection(v3BatchInsertJob(), config, connection);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "conflict", affected_rows: 0, error_code: "INSERT_DEDUP_CONFLICT" });
    expect(connection.sqlLog.some((sql) => sql.startsWith("INSERT INTO `appdb`.`account_credits`"))).toBe(false);
    expect(connection.sqlLog).toContain("COMMIT");
  });

  it("blocks frozen-set hard DELETE when hidden trigger effects are present", async () => {
    const connection = new SetMysqlConnection({ deleteTrigger: true });
    const result = await applyMysqlJobWithConnection(v3SetDeleteJob(), config, connection);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "failed", affected_rows: 0, error_code: "DELETE_TRIGGER_BLOCKED" });
    expect(connection.sqlLog.some((sql) => sql.startsWith("DELETE FROM `appdb`.`invoices`"))).toBe(false);
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

const trustedPrincipalScope = {
  schema_version: "synapsor.principal-scope.v1" as const,
  column: "assigned_to",
  binding: "principal",
  provider: "environment" as const,
  value_fingerprint: `sha256:${"a".repeat(64)}` as const,
  value: "support_agent_17",
};

function withPrincipalScope<T extends { target: Record<string, unknown> }>(input: T): T {
  return { ...input, target: { ...input.target, principal_scope: trustedPrincipalScope } };
}

function v4CompensationUpdateJob() {
  return {
    protocol_version: "4.0" as const,
    job_id: "wbj_revert_update",
    proposal_id: "wrp_revert_update",
    approval_id: "sha256:revert-approval",
    source_id: "src_1",
    engine: "mysql" as const,
    operation: "restore_update" as const,
    target: { schema: "appdb", table: "credits", primary_key: { column: "id", value: "CR-1" }, tenant_guard: { column: "tenant_id", value: "acme" } },
    allowed_columns: ["amount_cents"],
    patch: {},
    conflict_guard: { kind: "none" as const },
    compensation: {
      schema_version: "synapsor.inverse-descriptor.v1" as const,
      availability: "available" as const,
      reason_codes: [],
      operation: "restore_update" as const,
      cardinality: "single" as const,
      forward_proposal_id: "wrp_forward_update",
      forward_writeback_job_id: "wbj_forward_update",
      target: { source_id: "src_1", schema: "appdb", table: "credits", primary_key_column: "id" },
      tenant_guard: { column: "tenant_id", value: "acme" },
      allowed_columns: ["amount_cents"],
      members: [{ primary_key: { column: "id", value: "CR-1" }, expected_state: { amount_cents: 2500, version: 8 }, restore_values: { amount_cents: 100 } }],
      max_rows: 1,
      aggregate_bounds: [],
      version_advance: { column: "version", strategy: "integer_increment" as const },
      lineage: { root_proposal_id: "wrp_forward_update", parent_proposal_id: "wrp_forward_update", reverts_proposal_id: "wrp_forward_update", depth: 1 },
    },
    forward_receipt_hash: "sha256:forward-receipt",
    idempotency_key: "revert:wrp_forward_update",
    lease_expires_at: 1,
    attempt_count: 1,
  };
}

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

class CompensationMysqlConnection implements MysqlApplyConnection {
  readonly sqlLog: string[] = [];
  constructor(private readonly stale = false) {}
  async beginTransaction() { this.sqlLog.push("BEGIN"); }
  async commit() { this.sqlLog.push("COMMIT"); }
  async rollback() { this.sqlLog.push("ROLLBACK"); }
  async query<T = unknown>(sql: string): Promise<[T, unknown]> {
    this.sqlLog.push(sql.trim());
    if (sql.startsWith("SELECT") && sql.includes("FROM `appdb`.`credits`") && sql.includes("FOR UPDATE")) {
      return [[{ id: "CR-1", tenant_id: "acme", amount_cents: this.stale ? 2600 : 2500, version: 8 }] as T, undefined];
    }
    if (sql.startsWith("UPDATE `appdb`.`credits`")) return [{ affectedRows: 1 } as T, undefined];
    throw new Error(`unexpected compensation query: ${sql}`);
  }
}
class RollbackUnknownCompensationMysqlConnection extends CompensationMysqlConnection {
  override async rollback() {
    throw new Error("connection lost during compensation rollback");
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

class SetMysqlConnection implements MysqlApplyConnection {
  readonly sqlLog: string[] = [];
  readonly timeoutValues: unknown[][] = [];
  private mutations = 0;
  private batchPreflights = 0;

  constructor(private readonly options: {
    staleSecond?: boolean;
    failMutationAt?: number;
    duplicateBatchAt?: number;
    deleteTrigger?: boolean;
  } = {}) {}

  async beginTransaction() { this.sqlLog.push("BEGIN"); }
  async commit() { this.sqlLog.push("COMMIT"); }
  async rollback() { this.sqlLog.push("ROLLBACK"); }

  async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
    this.sqlLog.push(sql.trim());
    if (sql.startsWith("SET SESSION ")) {
      this.timeoutValues.push(values ?? []);
      return [{} as T, undefined];
    }
    if (sql.startsWith("INSERT IGNORE INTO synapsor_writeback_receipts")) return [{ affectedRows: 1 } as T, undefined];
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) return [{ affectedRows: 1 } as T, undefined];
    if (sql.startsWith("SELECT") && sql.includes("FROM `appdb`.`invoices`") && sql.includes("ORDER BY") && sql.includes("FOR UPDATE")) {
      return [[
        { id: "INV-1", tenant_id: "acme", status: "overdue", balance_cents: 1000, version: 1 },
        { id: "INV-2", tenant_id: "acme", status: "overdue", balance_cents: 2000, version: this.options.staleSecond ? 99 : 2 },
      ] as T, undefined];
    }
    if (sql.startsWith("UPDATE `appdb`.`invoices`")) {
      this.mutations += 1;
      return [{ affectedRows: this.options.failMutationAt === this.mutations ? 0 : 1 } as T, undefined];
    }
    if (sql.includes("has_trigger_visibility")) return [[{ has_trigger_visibility: 1, has_fk_visibility: 1 }] as T, undefined];
    if (sql.includes("information_schema.TRIGGERS")) return [[...(this.options.deleteTrigger ? [{ found: 1 }] : [])] as T, undefined];
    if (sql.includes("information_schema.INNODB_FOREIGN")) return [[] as T, undefined];
    if (sql.startsWith("DELETE FROM `appdb`.`invoices`")) return [{ affectedRows: 1 } as T, undefined];
    if (sql.startsWith("SELECT 1 AS found") && sql.includes("FROM `appdb`.`account_credits`")) {
      this.batchPreflights += 1;
      return [[...(this.options.duplicateBatchAt === this.batchPreflights ? [{ found: 1 }] : [])] as T, undefined];
    }
    if (sql.startsWith("INSERT INTO `appdb`.`account_credits`")) return [{ affectedRows: 1 } as T, undefined];
    throw new Error(`unexpected set query: ${sql} ${JSON.stringify(values ?? [])}`);
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

function v3SetUpdateJob() {
  const members = [setUpdateMember("INV-1", 1, 1_000), setUpdateMember("INV-2", 2, 2_000)];
  const aggregateBounds = [{ column: "balance_cents", measure: "before" as const, maximum: 10_000, actual: 3_000 }];
  return {
    protocol_version: "3.0" as const,
    job_id: "wbj_set_update",
    proposal_id: "wrp_set_update",
    approval_id: sha({ approval: "set-update" }),
    source_id: "src_1",
    engine: "mysql" as const,
    operation: "set_update" as const,
    target: { schema: "appdb", table: "invoices", primary_key: { column: "id" }, tenant_guard: { column: "tenant_id", value: "acme" } },
    allowed_columns: ["status"],
    patch: { status: "closed" },
    conflict_guard: { kind: "none" as const },
    version_advance: { column: "version", strategy: "integer_increment" as const },
    frozen_set: { max_rows: 2, row_count: 2, aggregate_bounds: aggregateBounds, members, set_digest: sha({ operation: "set_update", members, aggregate_bounds: aggregateBounds }) },
    idempotency_key: "idem-set-update",
    lease_expires_at: 1,
    attempt_count: 1,
  };
}

function v3SetDeleteJob() {
  const members = [setDeleteMember("INV-1", 1, 1_000), setDeleteMember("INV-2", 2, 2_000)];
  const aggregateBounds = [{ column: "balance_cents", measure: "before" as const, maximum: 10_000, actual: 3_000 }];
  return {
    ...v3SetUpdateJob(),
    job_id: "wbj_set_delete",
    proposal_id: "wrp_set_delete",
    approval_id: sha({ approval: "set-delete" }),
    operation: "set_delete" as const,
    allowed_columns: [],
    patch: {},
    version_advance: undefined,
    frozen_set: { max_rows: 2, row_count: 2, aggregate_bounds: aggregateBounds, members, set_digest: sha({ operation: "set_delete", members, aggregate_bounds: aggregateBounds }) },
    idempotency_key: "idem-set-delete",
  };
}

function v3BatchInsertJob() {
  const members = [batchInsertMember("CR-1", "ext-1", 500), batchInsertMember("CR-2", "ext-2", 1_500)];
  const aggregateBounds = [{ column: "amount_cents", measure: "after" as const, maximum: 5_000, actual: 2_000 }];
  return {
    protocol_version: "3.0" as const,
    job_id: "wbj_batch_insert",
    proposal_id: "wrp_batch_insert",
    approval_id: sha({ approval: "batch-insert" }),
    source_id: "src_1",
    engine: "mysql" as const,
    operation: "batch_insert" as const,
    target: { schema: "appdb", table: "account_credits", primary_key: { column: "id" }, tenant_guard: { column: "tenant_id", value: "acme" } },
    allowed_columns: ["amount_cents", "reason"],
    patch: {},
    conflict_guard: { kind: "none" as const },
    frozen_set: { max_rows: 2, row_count: 2, aggregate_bounds: aggregateBounds, members, set_digest: sha({ operation: "batch_insert", members, aggregate_bounds: aggregateBounds }) },
    idempotency_key: "idem-batch-insert",
    lease_expires_at: 1,
    attempt_count: 1,
  };
}

function setUpdateMember(id: string, version: number, balance: number) {
  const before = { id, tenant_id: "acme", status: "overdue", balance_cents: balance, version };
  const after = { ...before, status: "closed", version: version + 1 };
  return { primary_key: { column: "id", value: id }, expected_version: { column: "version", value: version }, before, after, before_digest: sha({ primary_key: id, before }), after_digest: sha({ primary_key: id, after }) };
}

function setDeleteMember(id: string, version: number, balance: number) {
  const before = { id, tenant_id: "acme", status: "overdue", balance_cents: balance, version };
  const expectedVersion = { column: "version", value: version };
  return { primary_key: { column: "id", value: id }, expected_version: expectedVersion, before, after: {}, before_digest: sha({ primary_key: id, before }), tombstone_digest: sha({ primary_key: id, expected_version: expectedVersion }) };
}

function batchInsertMember(id: string, externalId: string, amount: number) {
  const after = { amount_cents: amount, reason: "reviewed", tenant_id: "acme", id, external_id: externalId };
  return {
    primary_key: { column: "id", value: id }, before: {}, after,
    after_digest: sha({ primary_key: id, after }),
    deduplication: { components: [
      { column: "tenant_id", value: "acme", source: "trusted_tenant" as const },
      { column: "id", value: id, source: "fixed" as const },
      { column: "external_id", value: externalId, source: "fixed" as const },
    ] },
  };
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

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
