import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { WritebackJob, WritebackResult } from "@synapsor-runner/protocol";
import type { ApplyAdapter, RunnerConfig } from "@synapsor-runner/worker-core";

export const mysqlReceiptMigration = `CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key varchar(255) PRIMARY KEY,
  job_id varchar(255) UNIQUE NOT NULL,
  proposal_id varchar(512) NOT NULL,
  status varchar(64) NOT NULL,
  result_hash varchar(128),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp NULL
)`;

export type MysqlApplyConnection = {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
};

export function quoteMysqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe mysql identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

export function buildMysqlUpdate(job: WritebackJob): { sql: string; values: unknown[] } {
  validateMysqlPatch(job);
  const values: unknown[] = [];
  const setFragments = Object.entries(job.patch).map(([column, value]) => {
    values.push(value);
    return `${quoteMysqlIdentifier(column)} = ?`;
  });
  values.push(job.target.primary_key.value, job.target.tenant_guard.value);
  const where = [
    `${quoteMysqlIdentifier(job.target.primary_key.column)} = ?`,
    `${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?`
  ];
  if (job.conflict_guard.kind === "version_column") {
    values.push(job.conflict_guard.expected_value);
    where.push(`${quoteMysqlIdentifier(job.conflict_guard.column)} = ?`);
  }
  const sql = `UPDATE ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}
SET ${setFragments.join(", ")}
WHERE ${where.join(" AND ")}`;
  return { sql, values };
}

function validateMysqlPatch(job: WritebackJob): void {
  const patchColumns = Object.keys(job.patch || {});
  if (!patchColumns.length) {
    throw new Error("mysql writeback patch must not be empty");
  }
  const allowedColumns = new Set(Array.isArray(job.allowed_columns) ? job.allowed_columns : []);
  if (allowedColumns.has(job.target.primary_key.column)) {
    throw new Error("mysql primary key column must not be patch-allowlisted");
  }
  if (allowedColumns.has(job.target.tenant_guard.column)) {
    throw new Error("mysql tenant guard column must not be patch-allowlisted");
  }
  for (const column of patchColumns) {
    if (!allowedColumns.has(column)) {
      throw new Error(`mysql patch column not allowlisted: ${column}`);
    }
  }
}

function resultHash(job: WritebackJob, status: string, version?: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({ job_id: job.job_id, status, version })).digest("hex")}`;
}

export function normalizeVersionValue(value: unknown): string {
  if (value instanceof Date) return normalizeVersionValue(value.toISOString());
  const text = String(value ?? "").trim();
  const timestamp = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (timestamp) {
    const fraction = (timestamp[3] ?? "").padEnd(6, "0").slice(0, 6);
    const offset = timestamp[4];
    if (offset && offset.toUpperCase() !== "Z") {
      const dateParts = timestamp[1]!.split("-");
      const timeParts = timestamp[2]!.split(":");
      const year = Number(dateParts[0]);
      const month = Number(dateParts[1]);
      const day = Number(dateParts[2]);
      const hour = Number(timeParts[0]);
      const minute = Number(timeParts[1]);
      const second = Number(timeParts[2]);
      const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes(offset) * 60_000);
      return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())} ${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())}:${pad2(utc.getUTCSeconds())}.${fraction}`;
    }
    return `${timestamp[1]} ${timestamp[2]}.${fraction}`;
  }
  return text;
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const compact = offset.slice(1).replace(":", "");
  const hours = Number(compact.slice(0, 2));
  const minutes = Number(compact.slice(2, 4) || "0");
  return sign * (hours * 60 + minutes);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function versionValuesMatch(actual: unknown, expected: unknown): boolean {
  return normalizeVersionValue(actual) === normalizeVersionValue(expected);
}

export async function applyMysqlJob(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult> {
  if (config.dryRun) {
    buildMysqlUpdate(job);
    return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "applied", affected_rows: 0, result_hash: resultHash(job, "dry-run"), completed_at: new Date().toISOString() };
  }
  if (!config.databaseUrl) return failed(job, config, "DATABASE_UNAVAILABLE");
  const connection = await mysql.createConnection({ uri: config.databaseUrl, dateStrings: true });
  try {
    return await applyMysqlJobWithConnection(job, config, connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TRANSACTION_FAILED";
    return failed(job, config, message.includes("MULTI_ROW") ? "MULTI_ROW_WRITE_BLOCKED" : message.includes("VERSION") ? "VERSION_CONFLICT" : "TRANSACTION_FAILED");
  } finally {
    await connection.end();
  }
}

export async function applyMysqlJobWithConnection(job: WritebackJob, config: RunnerConfig, connection: MysqlApplyConnection): Promise<WritebackResult> {
  await connection.beginTransaction();
  try {
    await connection.query(mysqlReceiptMigration);
    const existing = await claimReceipt(connection, job, config);
    if (existing) {
      await connection.commit();
      return existing;
    }
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT * FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}
WHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ?
  AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?
FOR UPDATE`,
      [job.target.primary_key.value, job.target.tenant_guard.value]
    );
    if (!rows[0]) {
      const hash = resultHash(job, "ROW_NOT_FOUND");
      await recordReceipt(connection, job, "conflict", hash);
      await connection.commit();
      return conflict(job, config, "ROW_NOT_FOUND", hash);
    }
    if (job.conflict_guard.kind === "version_column" && !versionValuesMatch(rows[0][job.conflict_guard.column], job.conflict_guard.expected_value)) {
      const hash = resultHash(job, "VERSION_CONFLICT", rows[0][job.conflict_guard.column]);
      await recordReceipt(connection, job, "conflict", hash);
      await connection.commit();
      return conflict(job, config, "VERSION_CONFLICT", hash);
    }
    const update = buildMysqlUpdate(job);
    const [result] = await connection.query<mysql.ResultSetHeader>(update.sql, update.values);
    if (result.affectedRows !== 1) throw new Error(result.affectedRows === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
    const hash = resultHash(job, "applied", job.conflict_guard.kind === "version_column" ? job.conflict_guard.expected_value : undefined);
    await recordReceipt(connection, job, "applied", hash);
    await connection.commit();
    return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "applied", affected_rows: 1, result_hash: hash, completed_at: new Date().toISOString() };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

async function claimReceipt(connection: MysqlApplyConnection, job: WritebackJob, config: RunnerConfig): Promise<WritebackResult | undefined> {
  const [claim] = await connection.query<mysql.ResultSetHeader>(
    `INSERT IGNORE INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash)
VALUES (?, ?, ?, 'in_progress', NULL)`,
    [job.idempotency_key, job.job_id, job.proposal_id]
  );
  if (claim.affectedRows === 1) return undefined;
  const [receiptRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT status, result_hash FROM synapsor_writeback_receipts WHERE idempotency_key = ? FOR UPDATE",
    [job.idempotency_key]
  );
  const row = receiptRows[0];
  if (!row) return failed(job, config, "IDEMPOTENCY_RECEIPT_UNAVAILABLE");
  return resultFromExistingReceipt(job, config, row.status, row.result_hash);
}

function resultFromExistingReceipt(job: WritebackJob, config: RunnerConfig, status: unknown, hash: unknown): WritebackResult {
  const result_hash = typeof hash === "string" && hash ? hash : resultHash(job, "idempotent");
  if (status === "applied" || status === "already_applied") {
    return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "already_applied", affected_rows: 0, result_hash, completed_at: new Date().toISOString() };
  }
  if (status === "conflict") return conflict(job, config, "IDEMPOTENT_CONFLICT", result_hash);
  if (status === "failed") return failed(job, config, "IDEMPOTENT_FAILED");
  return failed(job, config, "IDEMPOTENCY_RECEIPT_IN_PROGRESS");
}

async function recordReceipt(connection: MysqlApplyConnection, job: WritebackJob, status: string, hash: string): Promise<void> {
  const [result] = await connection.query<mysql.ResultSetHeader>(
    `UPDATE synapsor_writeback_receipts
SET status = ?, result_hash = ?, completed_at = CURRENT_TIMESTAMP
WHERE idempotency_key = ?`,
    [status, hash, job.idempotency_key]
  );
  if (result.affectedRows !== 1) throw new Error("IDEMPOTENCY_RECEIPT_UNAVAILABLE");
}

function conflict(job: WritebackJob, config: RunnerConfig, code: string, result_hash?: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "conflict", affected_rows: 0, error_code: code, result_hash, completed_at: new Date().toISOString() };
}

function failed(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "failed", error_code: code, completed_at: new Date().toISOString() };
}

export const mysqlAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "database URL required; local config apply reads source.write_url_env, legacy workers use SYNAPSOR_DATABASE_URL" } };
    const connection = await mysql.createConnection({ uri: config.databaseUrl, dateStrings: true });
    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
      await connection.query(mysqlReceiptMigration);
      await connection.beginTransaction();
      try {
        const doctorId = `doctor-${Date.now()}`;
        await connection.query(
          `INSERT INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash, completed_at)
VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [doctorId, doctorId, "doctor", "doctor", "sha256:doctor"]
        );
        await connection.rollback();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
      return {
        ok: true,
        details: {
          version: rows[0]?.version,
          receipt_table: "ready",
          write_permission_rollback: true,
          dry_run: config.dryRun
        }
      };
    } finally {
      await connection.end();
    }
  },
  apply: applyMysqlJob
};
