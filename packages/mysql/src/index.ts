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

export function quoteMysqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe mysql identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

export function buildMysqlUpdate(job: WritebackJob): { sql: string; values: unknown[] } {
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

function resultHash(job: WritebackJob, status: string, version?: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({ job_id: job.job_id, status, version })).digest("hex")}`;
}

export async function applyMysqlJob(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult> {
  if (config.dryRun) {
    buildMysqlUpdate(job);
    return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "applied", affected_rows: 0, result_hash: resultHash(job, "dry-run"), completed_at: new Date().toISOString() };
  }
  if (!config.databaseUrl) return failed(job, config, "DATABASE_UNAVAILABLE");
  const connection = await mysql.createConnection({ uri: config.databaseUrl, dateStrings: true });
  try {
    await connection.beginTransaction();
    await connection.query(mysqlReceiptMigration);
    const [receiptRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT status, result_hash FROM synapsor_writeback_receipts WHERE idempotency_key = ? FOR UPDATE",
      [job.idempotency_key]
    );
    if (receiptRows[0]?.status === "applied") {
      await connection.commit();
      return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "applied", affected_rows: 0, result_hash: receiptRows[0].result_hash, completed_at: new Date().toISOString() };
    }
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT * FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}
WHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ?
  AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?
FOR UPDATE`,
      [job.target.primary_key.value, job.target.tenant_guard.value]
    );
    if (!rows[0]) {
      await recordReceipt(connection, job, "conflict", resultHash(job, "ROW_NOT_FOUND"));
      await connection.commit();
      return conflict(job, config, "ROW_NOT_FOUND");
    }
    if (job.conflict_guard.kind === "version_column" && String(rows[0][job.conflict_guard.column]) !== String(job.conflict_guard.expected_value)) {
      await recordReceipt(connection, job, "conflict", resultHash(job, "VERSION_CONFLICT", rows[0][job.conflict_guard.column]));
      await connection.commit();
      return conflict(job, config, "VERSION_CONFLICT");
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
    const message = error instanceof Error ? error.message : "TRANSACTION_FAILED";
    return failed(job, config, message.includes("MULTI_ROW") ? "MULTI_ROW_WRITE_BLOCKED" : message.includes("VERSION") ? "VERSION_CONFLICT" : "TRANSACTION_FAILED");
  } finally {
    await connection.end();
  }
}

async function recordReceipt(connection: mysql.Connection, job: WritebackJob, status: string, hash: string): Promise<void> {
  await connection.query(
    `INSERT INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash, completed_at)
VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON DUPLICATE KEY UPDATE status = VALUES(status), result_hash = VALUES(result_hash), completed_at = VALUES(completed_at)`,
    [job.idempotency_key, job.job_id, job.proposal_id, status, hash]
  );
}

function conflict(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "conflict", affected_rows: 0, error_code: code, completed_at: new Date().toISOString() };
}

function failed(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "failed", error_code: code, completed_at: new Date().toISOString() };
}

export const mysqlAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "SYNAPSOR_DATABASE_URL required" } };
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
