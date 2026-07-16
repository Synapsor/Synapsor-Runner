import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyPostgresJobWithClient,
  buildPostgresDelete,
  buildPostgresInsert,
  buildPostgresReconciliationRead,
  buildPostgresUpdate,
  normalizeVersionValue,
  postgresPoolConfig,
  versionValuesMatch,
  type PostgresApplyClient
} from "./index.js";
import type { WritebackIntentStore } from "@synapsor-runner/worker-core";

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

  it("builds parameterized v2 INSERT and guarded DELETE statements", () => {
    const insertion = buildPostgresInsert(v2InsertJob);
    expect(insertion.sql).toContain('INSERT INTO "public"."credits"');
    expect(insertion.sql).not.toContain("acme");
    expect(insertion.sql).not.toContain("wrp_insert");
    expect(insertion.values).toEqual([2500, "acme", "wrp_insert"]);

    const deletion = buildPostgresDelete(v2DeleteJob);
    expect(deletion.sql).toContain('DELETE FROM "public"."credits"');
    expect(deletion.sql).toContain('"version" = $3');
    expect(deletion.values).toEqual(["CR-1", "acme", 7]);
  });

  it("binds trusted principal scope on UPDATE, INSERT, DELETE, and reconciliation", () => {
    const update = buildPostgresUpdate(withPrincipalScope(v2UpdateJob));
    expect(update.sql).toContain('"assigned_to" = $4');
    expect(update.values).toEqual([2500, "CR-1", "acme", "support_agent_17", 7]);

    const insertion = buildPostgresInsert(withPrincipalScope(v2InsertJob));
    expect(insertion.sql).toContain('"assigned_to"');
    expect(insertion.values).toEqual([2500, "acme", "wrp_insert", "support_agent_17"]);

    const deletion = buildPostgresDelete(withPrincipalScope(v2DeleteJob));
    expect(deletion.sql).toContain('"assigned_to" = $3');
    expect(deletion.values).toEqual(["CR-1", "acme", "support_agent_17", 7]);

    const reconciliation = buildPostgresReconciliationRead(withPrincipalScope(v2UpdateJob));
    expect(reconciliation.sql).toContain('"assigned_to" = $3');
    expect(reconciliation.values).toEqual(["CR-1", "acme", "support_agent_17"]);
  });

  it("builds reconciliation reads from reviewed columns and trusted identity only", () => {
    const update = buildPostgresReconciliationRead(v2UpdateJob);
    expect(update.sql).toContain('SELECT "id", "tenant_id", "amount_cents", "version"');
    expect(update.sql).not.toContain("SELECT *");
    expect(update.sql).not.toContain("private_note");
    expect(update.values).toEqual(["CR-1", "acme"]);

    const insert = buildPostgresReconciliationRead(v2InsertJob);
    expect(insert.sql).toContain('"tenant_id" = $1 AND "request_id" = $2');
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

  it("atomically applies source-receipted single-row INSERT and DELETE", async () => {
    const insertClient = new CrudPostgresClient("insert");
    const inserted = await applyPostgresJobWithClient(v2InsertJob, config, insertClient);
    expect(inserted).toMatchObject({ protocol_version: "2.0", operation: "single_row_insert", status: "applied", affected_rows: 1, receipt_authority: "source_db" });
    expect(insertClient.sqlLog).toContain("COMMIT");
    expect(insertClient.sqlLog.some((sql) => sql.startsWith('INSERT INTO "public"."credits"'))).toBe(true);
    expect(insertClient.recordedReceiptStatus).toBe("applied");

    const deleteClient = new CrudPostgresClient("delete");
    const deleted = await applyPostgresJobWithClient(v2DeleteJob, config, deleteClient);
    expect(deleted).toMatchObject({ protocol_version: "2.0", operation: "single_row_delete", status: "applied", affected_rows: 1, receipt_authority: "source_db" });
    expect(deleteClient.sqlLog).toContain("COMMIT");
    expect(deleteClient.sqlLog.some((sql) => sql.startsWith('DELETE FROM "public"."credits"'))).toBe(true);
    expect(deleteClient.sqlLog.some((sql) => /SELECT\s+\*/i.test(sql))).toBe(false);
    expect(deleteClient.recordedReceiptStatus).toBe("applied");
  });

  it("atomically applies an exact frozen set and emits per-member effects", async () => {
    const client = new SetPostgresClient();
    const result = await applyPostgresJobWithClient(v3SetUpdateJob(), config, client);

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
    expect(client.sqlLog.filter((sql) => sql.startsWith('UPDATE "public"."invoices"'))).toHaveLength(2);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("applies a reviewed compensation with a fresh guard and emits a revert-of-revert inverse", async () => {
    const client = new CompensationPostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
    }, client);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      operation: "restore_update",
      status: "applied",
      affected_rows: 1,
      inverse: { operation: "restore_update", lineage: { depth: 2 } },
    });
    expect(client.sqlLog.some((sql) => sql.startsWith('UPDATE "public"."credits"'))).toBe(true);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("fails a stale compensation closed before mutation", async () => {
    const client = new CompensationPostgresClient(true);
    const result = await applyPostgresJobWithClient(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: new FakeIntentStore(),
    }, client);

    expect(result).toMatchObject({ protocol_version: "4.0", status: "conflict", error_code: "ROW_CHANGED_AFTER_FORWARD_WRITE", affected_rows: 0 });
    expect(client.sqlLog.some((sql) => sql.startsWith('UPDATE "public"."credits"'))).toBe(false);
  });

  it("requires reconciliation when a compensation stops after source COMMIT", async () => {
    const client = new CompensationPostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_commit") throw new Error("simulated compensation process death");
      },
    }, client);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      operation: "restore_update",
      status: "reconciliation_required",
      error_code: "RECONCILIATION_REQUIRED",
      intent_id: "wbi:test",
    });
    expect(result).not.toHaveProperty("inverse");
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("requires reconciliation when compensation rollback acknowledgement is lost", async () => {
    const client = new RollbackUnknownCompensationPostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v4CompensationUpdateJob(), {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_mutation") throw new Error("simulated compensation connection loss");
      },
    }, client);

    expect(result).toMatchObject({
      protocol_version: "4.0",
      status: "reconciliation_required",
      error_code: "RECONCILIATION_REQUIRED",
    });
    expect(result).not.toHaveProperty("inverse");
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
  });

  it("bounds direct write statements and lock waits inside the transaction", async () => {
    const client = new SetPostgresClient();
    const result = await applyPostgresJobWithClient(v3SetUpdateJob(), { ...config, statementTimeoutMs: 2500 }, client);

    expect(result.status).toBe("applied");
    expect(client.sqlLog.slice(0, 3)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 2500",
      "SET LOCAL lock_timeout = 2500",
    ]);
  });

  it("fails a stale frozen member closed before any set mutation", async () => {
    const client = new SetPostgresClient({ staleSecond: true });
    const result = await applyPostgresJobWithClient(v3SetUpdateJob(), config, client);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "conflict", affected_rows: 0, error_code: "SET_DRIFT_CONFLICT" });
    expect(client.sqlLog.some((sql) => sql.startsWith('UPDATE "public"."invoices"'))).toBe(false);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("rolls back the whole frozen set when any member mutation is anomalous", async () => {
    const client = new SetPostgresClient({ failMutationAt: 2 });
    await expect(applyPostgresJobWithClient(v3SetUpdateJob(), config, client)).rejects.toThrow(/SET_ATOMICITY_VIOLATION/);
    expect(client.sqlLog.filter((sql) => sql.startsWith('UPDATE "public"."invoices"'))).toHaveLength(2);
    expect(client.sqlLog).toContain("ROLLBACK");
    expect(client.sqlLog).not.toContain("COMMIT");
  });

  it("preflights every batch identity before INSERT and blocks duplicates atomically", async () => {
    const client = new SetPostgresClient({ duplicateBatchAt: 2 });
    const result = await applyPostgresJobWithClient(v3BatchInsertJob(), config, client);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "conflict", affected_rows: 0, error_code: "INSERT_DEDUP_CONFLICT" });
    expect(client.sqlLog.some((sql) => sql.startsWith('INSERT INTO "public"."account_credits"'))).toBe(false);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("blocks frozen-set hard DELETE when hidden trigger effects are present", async () => {
    const client = new SetPostgresClient({ deleteTrigger: true });
    const result = await applyPostgresJobWithClient(v3SetDeleteJob(), config, client);

    expect(result).toMatchObject({ protocol_version: "3.0", status: "failed", affected_rows: 0, error_code: "DELETE_TRIGGER_BLOCKED" });
    expect(client.sqlLog.some((sql) => sql.startsWith('DELETE FROM "public"."invoices"'))).toBe(false);
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
    ).rejects.toThrow(/SOURCE_RECEIPT_UNAVAILABLE/);
    expect(client.sqlLog.some((sql) => sql.includes('UPDATE "public"."tickets"'))).toBe(true);
    expect(client.sqlLog).toContain("ROLLBACK");
  });

  it("uses the Runner ledger without source receipt DDL or DML", async () => {
    const client = new V2PostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
    }, client);

    expect(result).toMatchObject({ protocol_version: "2.0", status: "applied", affected_rows: 1, result_version: "8", receipt_authority: "runner_ledger" });
    expect(intents.calls).toEqual(["claim", "applying", "complete"]);
    expect(client.sqlLog.some((sql) => sql.includes("synapsor_writeback_receipts"))).toBe(false);
    expect(client.sqlLog.some((sql) => /SELECT\s+\*/i.test(sql))).toBe(false);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("requires reconciliation when execution stops after source COMMIT", async () => {
    const client = new V2PostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_commit") throw new Error("simulated process death");
      },
    }, client);

    expect(result).toMatchObject({ status: "reconciliation_required", error_code: "RECONCILIATION_REQUIRED", intent_id: "wbi:test" });
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
    expect(client.sqlLog).toContain("COMMIT");
  });

  it("rolls back a known pre-COMMIT failure and terminally records it", async () => {
    const client = new V2PostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "before_source_commit") throw new Error("simulated pre-commit stop");
      },
    }, client);

    expect(result).toMatchObject({ status: "failed", error_code: "TRANSACTION_FAILED" });
    expect(intents.calls).toEqual(["claim", "applying", "complete"]);
    expect(client.sqlLog).toContain("ROLLBACK");
    expect(client.sqlLog).not.toContain("COMMIT");
  });

  it("requires reconciliation when rollback acknowledgement is lost", async () => {
    const client = new RollbackUnknownPostgresClient();
    const intents = new FakeIntentStore();
    const result = await applyPostgresJobWithClient(v2UpdateJob, {
      ...config,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: intents,
      testFailpoint(name) {
        if (name === "after_source_mutation") throw new Error("simulated connection loss");
      },
    }, client);

    expect(result).toMatchObject({ status: "reconciliation_required", error_code: "RECONCILIATION_REQUIRED" });
    expect(intents.calls).toEqual(["claim", "applying", "reconciliation"]);
  });
});

const v2UpdateJob = {
  protocol_version: "2.0" as const,
  job_id: "wbj_v2_update",
  proposal_id: "wrp_update",
  approval_id: "sha256:approval",
  source_id: "src_1",
  engine: "postgres" as const,
  operation: "single_row_update" as const,
  target: {
    schema: "public",
    table: "credits",
    primary_key: { column: "id", value: "CR-1" },
    tenant_guard: { column: "tenant_id", value: "acme" },
  },
  allowed_columns: ["amount_cents"],
  patch: { amount_cents: 2500 },
  conflict_guard: { kind: "version_column" as const, column: "version", expected_value: 7 },
  version_advance: { column: "version", strategy: "integer_increment" as const },
  idempotency_key: "wrp_update:CR-1",
  lease_expires_at: "2026-07-13T12:00:00Z",
  attempt_count: 1,
};

const v2InsertJob = {
  protocol_version: "2.0" as const,
  job_id: "wbj_v2_insert",
  proposal_id: "wrp_insert",
  approval_id: "sha256:approval",
  source_id: "src_1",
  engine: "postgres" as const,
  operation: "single_row_insert" as const,
  target: {
    schema: "public",
    table: "credits",
    primary_key: { column: "id" },
    tenant_guard: { column: "tenant_id", value: "acme" },
  },
  allowed_columns: ["amount_cents"],
  patch: { amount_cents: 2500 },
  conflict_guard: { kind: "none" as const },
  deduplication: { components: [
    { column: "tenant_id", value: "acme", source: "trusted_tenant" as const },
    { column: "request_id", value: "wrp_insert", source: "proposal_id" as const },
  ] },
  idempotency_key: "wrp_insert:credits",
  lease_expires_at: "2026-07-13T12:00:00Z",
  attempt_count: 1,
};

const v2DeleteJob = {
  protocol_version: "2.0" as const,
  job_id: "wbj_v2_delete",
  proposal_id: "wrp_delete",
  approval_id: "sha256:approval",
  source_id: "src_1",
  engine: "postgres" as const,
  operation: "single_row_delete" as const,
  target: {
    schema: "public",
    table: "credits",
    primary_key: { column: "id", value: "CR-1" },
    tenant_guard: { column: "tenant_id", value: "acme" },
  },
  allowed_columns: [],
  patch: {},
  conflict_guard: { kind: "version_column" as const, column: "version", expected_value: 7 },
  idempotency_key: "wrp_delete:CR-1",
  lease_expires_at: "2026-07-13T12:00:00Z",
  attempt_count: 1,
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
    engine: "postgres" as const,
    operation: "restore_update" as const,
    target: { schema: "public", table: "credits", primary_key: { column: "id", value: "CR-1" }, tenant_guard: { column: "tenant_id", value: "acme" } },
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
      target: { source_id: "src_1", schema: "public", table: "credits", primary_key_column: "id" },
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

class V2PostgresClient implements PostgresApplyClient {
  readonly sqlLog: string[] = [];
  async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sqlLog.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith('SELECT "id"::text AS "__synapsor_primary_key"')) return { rows: [{ __synapsor_primary_key: "CR-1", __synapsor_conflict_value: "7" }], rowCount: 1 };
    if (sql.startsWith('UPDATE "public"."credits"')) return { rows: [{ __synapsor_result_version: "8" }], rowCount: 1 };
    throw new Error(`unexpected v2 query: ${sql}`);
  }
}

class CompensationPostgresClient implements PostgresApplyClient {
  readonly sqlLog: string[] = [];
  constructor(private readonly stale = false) {}
  async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sqlLog.push(sql.trim());
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith("SELECT") && sql.includes('FROM "public"."credits"') && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "CR-1", tenant_id: "acme", amount_cents: this.stale ? 2600 : 2500, version: 8 }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "public"."credits"')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected compensation query: ${sql}`);
  }
}

class RollbackUnknownCompensationPostgresClient extends CompensationPostgresClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    if (sql === "ROLLBACK") throw new Error("connection lost during compensation rollback");
    return super.query(sql);
  }
}

class RollbackUnknownPostgresClient extends V2PostgresClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    if (sql === "ROLLBACK") throw new Error("connection lost during rollback");
    return super.query(sql);
  }
}

class CrudPostgresClient implements PostgresApplyClient {
  readonly sqlLog: string[] = [];
  recordedReceiptStatus?: string;

  constructor(private readonly operation: "insert" | "delete") {}

  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sqlLog.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith("INSERT INTO synapsor_writeback_receipts")) return { rows: [{ status: "in_progress" }], rowCount: 1 };
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      this.recordedReceiptStatus = String(values?.[1]);
      return { rows: [], rowCount: 1 };
    }
    if (this.operation === "insert" && sql.startsWith('SELECT "id"::text AS "__synapsor_primary_key" FROM')) return { rows: [], rowCount: 0 };
    if (this.operation === "insert" && sql.startsWith('INSERT INTO "public"."credits"')) return { rows: [{ __synapsor_primary_key: "CR-NEW" }], rowCount: 1 };
    if (this.operation === "delete" && sql.startsWith('SELECT "id"::text AS "__synapsor_primary_key"')) {
      return { rows: [{ __synapsor_primary_key: "CR-1", __synapsor_conflict_value: "7" }], rowCount: 1 };
    }
    if (this.operation === "delete" && sql.startsWith("SELECT EXISTS")) return { rows: [{ has_user_trigger: false, has_widening_fk: false }], rowCount: 1 };
    if (this.operation === "delete" && sql.startsWith('DELETE FROM "public"."credits"')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected CRUD query: ${sql}`);
  }
}

class SetPostgresClient implements PostgresApplyClient {
  readonly sqlLog: string[] = [];
  private mutations = 0;
  private batchPreflights = 0;
  private batchInserts = 0;

  constructor(private readonly options: {
    staleSecond?: boolean;
    failMutationAt?: number;
    duplicateBatchAt?: number;
    deleteTrigger?: boolean;
  } = {}) {}

  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sqlLog.push(sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ? sql : sql.trim());
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.startsWith("SET LOCAL ")) return { rows: [], rowCount: null };
    if (sql.startsWith("INSERT INTO synapsor_writeback_receipts")) return { rows: [{ status: "in_progress" }], rowCount: 1 };
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT") && sql.includes('FROM "public"."invoices"') && sql.includes("ORDER BY") && sql.includes("FOR UPDATE")) {
      return {
        rows: [
          { id: "INV-1", tenant_id: "acme", status: "overdue", balance_cents: 1000, version: 1 },
          { id: "INV-2", tenant_id: "acme", status: "overdue", balance_cents: 2000, version: this.options.staleSecond ? 99 : 2 },
        ],
        rowCount: 2,
      };
    }
    if (sql.startsWith('UPDATE "public"."invoices"')) {
      this.mutations += 1;
      return { rows: [], rowCount: this.options.failMutationAt === this.mutations ? 0 : 1 };
    }
    if (sql.startsWith("SELECT EXISTS") && sql.includes("pg_trigger")) {
      return { rows: [{ has_user_trigger: this.options.deleteTrigger === true, has_widening_fk: false }], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM "public"."invoices"')) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT 1") && sql.includes('FROM "public"."account_credits"')) {
      this.batchPreflights += 1;
      const duplicate = this.options.duplicateBatchAt === this.batchPreflights;
      return { rows: duplicate ? [{ exists: 1 }] : [], rowCount: duplicate ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO "public"."account_credits"')) {
      this.batchInserts += 1;
      return { rows: [{ __synapsor_primary_key: `CR-${this.batchInserts}` }], rowCount: 1 };
    }
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
  databaseUrl: "postgresql://user:redacted@127.0.0.1/db",
  engine: "postgres" as const,
  pollIntervalMs: 1000,
  logLevel: "info" as const,
  dryRun: false,
  stateDir: ".synapsor"
};

function v3SetUpdateJob() {
  const members = [
    setUpdateMember("INV-1", 1, 1_000),
    setUpdateMember("INV-2", 2, 2_000),
  ];
  const aggregateBounds = [{ column: "balance_cents", measure: "before" as const, maximum: 10_000, actual: 3_000 }];
  return {
    protocol_version: "3.0" as const,
    job_id: "wbj_set_update",
    proposal_id: "wrp_set_update",
    approval_id: sha({ approval: "set-update" }),
    source_id: "src_1",
    engine: "postgres" as const,
    operation: "set_update" as const,
    target: { schema: "public", table: "invoices", primary_key: { column: "id" }, tenant_guard: { column: "tenant_id", value: "acme" } },
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
  const members = [
    setDeleteMember("INV-1", 1, 1_000),
    setDeleteMember("INV-2", 2, 2_000),
  ];
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
    engine: "postgres" as const,
    operation: "batch_insert" as const,
    target: { schema: "public", table: "account_credits", primary_key: { column: "id" }, tenant_guard: { column: "tenant_id", value: "acme" } },
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
    if (sql.startsWith("SELECT") && sql.includes('FROM "public"."tickets"') && sql.includes("FOR UPDATE")) {
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
    if (sql.startsWith("SELECT") && sql.includes('FROM "public"."tickets"') && sql.includes("FOR UPDATE")) {
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
