import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { WritebackJob, WritebackResult } from "@synapsor-runner/protocol";
import type { ApplyAdapter, RunnerConfig } from "@synapsor-runner/worker-core";

export const postgresReceiptMigration = `CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key text PRIMARY KEY,
  job_id text UNIQUE NOT NULL,
  proposal_id text NOT NULL,
  status text NOT NULL,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
)`;

export function quotePostgresIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function buildPostgresUpdate(job: WritebackJob): { sql: string; values: unknown[] } {
  validatePostgresPatch(job);
  const values: unknown[] = [];
  const setFragments = Object.entries(job.patch).map(([column, value]) => {
    values.push(value);
    return `${quotePostgresIdentifier(column)} = $${values.length}`;
  });
  values.push(job.target.primary_key.value);
  const pkParam = `$${values.length}`;
  values.push(job.target.tenant_guard.value);
  const tenantParam = `$${values.length}`;
  const where = [
    `${quotePostgresIdentifier(job.target.primary_key.column)} = ${pkParam}`,
    `${quotePostgresIdentifier(job.target.tenant_guard.column)} = ${tenantParam}`
  ];
  if (job.conflict_guard.kind === "version_column") {
    values.push(job.conflict_guard.expected_value);
    where.push(`${quotePostgresIdentifier(job.conflict_guard.column)} = $${values.length}`);
  }
  const sql = `UPDATE ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}
SET ${setFragments.join(", ")}
WHERE ${where.join(" AND ")}`;
  return { sql, values };
}

function validatePostgresPatch(job: WritebackJob): void {
  const patchColumns = Object.keys(job.patch || {});
  if (!patchColumns.length) {
    throw new Error("postgres writeback patch must not be empty");
  }
  const allowedColumns = new Set(Array.isArray(job.allowed_columns) ? job.allowed_columns : []);
  if (allowedColumns.has(job.target.primary_key.column)) {
    throw new Error("postgres primary key column must not be patch-allowlisted");
  }
  if (allowedColumns.has(job.target.tenant_guard.column)) {
    throw new Error("postgres tenant guard column must not be patch-allowlisted");
  }
  for (const column of patchColumns) {
    if (!allowedColumns.has(column)) {
      throw new Error(`postgres patch column not allowlisted: ${column}`);
    }
  }
}

function resultHash(job: WritebackJob, status: string, version?: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({ job_id: job.job_id, status, version })).digest("hex")}`;
}

function versionValuesMatch(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date) {
    const expectedDate = new Date(String(expected));
    return !Number.isNaN(expectedDate.getTime()) && actual.getTime() === expectedDate.getTime();
  }
  if (typeof actual === "string" && typeof expected === "string") {
    const actualDate = new Date(actual);
    const expectedDate = new Date(expected);
    if (!Number.isNaN(actualDate.getTime()) && !Number.isNaN(expectedDate.getTime())) {
      return actualDate.getTime() === expectedDate.getTime();
    }
  }
  return String(actual) === String(expected);
}

async function withTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function applyPostgresJob(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult> {
  if (config.dryRun) {
    buildPostgresUpdate(job);
    return {
      protocol_version: "1.0",
      job_id: job.job_id,
      runner_id: config.runnerId,
      status: "applied",
      affected_rows: 0,
      result_hash: resultHash(job, "dry-run"),
      completed_at: new Date().toISOString()
    };
  }
  if (!config.databaseUrl) {
    return failed(job, config, "DATABASE_UNAVAILABLE");
  }
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = await pool.connect();
  try {
    return await withTransaction(client, async () => {
      await client.query(postgresReceiptMigration);
      const receipt = await client.query(
        "SELECT status, result_hash FROM synapsor_writeback_receipts WHERE idempotency_key = $1 FOR UPDATE",
        [job.idempotency_key]
      );
      if (receipt.rowCount && receipt.rows[0]?.status === "applied") {
        return {
          protocol_version: "1.0",
          job_id: job.job_id,
          runner_id: config.runnerId,
          status: "applied",
          affected_rows: 0,
          result_hash: receipt.rows[0]?.result_hash || resultHash(job, "idempotent"),
          completed_at: new Date().toISOString()
        };
      }
      const row = await client.query(
        `SELECT * FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}
WHERE ${quotePostgresIdentifier(job.target.primary_key.column)} = $1
  AND ${quotePostgresIdentifier(job.target.tenant_guard.column)} = $2
FOR UPDATE`,
        [job.target.primary_key.value, job.target.tenant_guard.value]
      );
      if (!row.rowCount) {
        await recordReceipt(client, job, "conflict", resultHash(job, "ROW_NOT_FOUND"));
        return conflict(job, config, "ROW_NOT_FOUND");
      }
      if (job.conflict_guard.kind === "version_column" && !versionValuesMatch(row.rows[0]?.[job.conflict_guard.column], job.conflict_guard.expected_value)) {
        await recordReceipt(client, job, "conflict", resultHash(job, "VERSION_CONFLICT", row.rows[0]?.[job.conflict_guard.column]));
        return conflict(job, config, "VERSION_CONFLICT");
      }
      const update = buildPostgresUpdate(job);
      const applied = await client.query(update.sql, update.values);
      if (applied.rowCount !== 1) {
        throw new Error(applied.rowCount === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
      }
      const hash = resultHash(job, "applied", job.conflict_guard.kind === "version_column" ? job.conflict_guard.expected_value : undefined);
      await recordReceipt(client, job, "applied", hash);
      return {
        protocol_version: "1.0",
        job_id: job.job_id,
        runner_id: config.runnerId,
        status: "applied",
        affected_rows: 1,
        result_hash: hash,
        completed_at: new Date().toISOString()
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TRANSACTION_FAILED";
    return failed(job, config, message.includes("MULTI_ROW") ? "MULTI_ROW_WRITE_BLOCKED" : message.includes("VERSION") ? "VERSION_CONFLICT" : "TRANSACTION_FAILED");
  } finally {
    client.release();
    await pool.end();
  }
}

async function recordReceipt(client: PoolClient, job: WritebackJob, status: string, hash: string): Promise<void> {
  await client.query(
    `INSERT INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash, completed_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (idempotency_key)
DO UPDATE SET status = EXCLUDED.status, result_hash = EXCLUDED.result_hash, completed_at = EXCLUDED.completed_at`,
    [job.idempotency_key, job.job_id, job.proposal_id, status, hash]
  );
}

function conflict(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "conflict", affected_rows: 0, error_code: code, completed_at: new Date().toISOString() };
}

function failed(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "failed", error_code: code, completed_at: new Date().toISOString() };
}

export const postgresAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "SYNAPSOR_DATABASE_URL required" } };
    const pool = new Pool({ connectionString: config.databaseUrl });
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT version()");
      await client.query(postgresReceiptMigration);
      await client.query("BEGIN");
      try {
        const doctorId = `doctor-${Date.now()}`;
        await client.query(
          `INSERT INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash, completed_at)
VALUES ($1, $2, $3, $4, $5, now())`,
          [doctorId, doctorId, "doctor", "doctor", "sha256:doctor"]
        );
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      return {
        ok: true,
        details: {
          version: result.rows[0]?.version,
          receipt_table: "ready",
          write_permission_rollback: true,
          dry_run: config.dryRun
        }
      };
    } finally {
      client.release();
      await pool.end();
    }
  },
  apply: applyPostgresJob
};
