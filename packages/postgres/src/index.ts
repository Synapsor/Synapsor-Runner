import crypto from "node:crypto";
import { Pool, types as pgTypes, type PoolConfig } from "pg";
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

export type PostgresApplyClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

const POSTGRES_TIMESTAMP_OIDS = new Set([1114, 1184]);

/** Keep database timestamp precision intact instead of coercing through JS Date. */
export function postgresPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    types: {
      getTypeParser(oid: number, format?: "text" | "binary") {
        if ((format ?? "text") === "text" && POSTGRES_TIMESTAMP_OIDS.has(oid)) {
          return (value: string) => value;
        }
        return pgTypes.getTypeParser(oid, format);
      },
    },
  };
}

export function createPostgresPool(connectionString: string): Pool {
  return new Pool(postgresPoolConfig(connectionString));
}

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

async function withTransaction<T>(client: PostgresApplyClient, fn: () => Promise<T>): Promise<T> {
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
  const pool = createPostgresPool(config.databaseUrl);
  const client = await pool.connect();
  try {
    return await applyPostgresJobWithClient(job, config, client);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TRANSACTION_FAILED";
    return failed(job, config, message.includes("MULTI_ROW") ? "MULTI_ROW_WRITE_BLOCKED" : message.includes("VERSION") ? "VERSION_CONFLICT" : "TRANSACTION_FAILED");
  } finally {
    client.release();
    await pool.end();
  }
}

export async function applyPostgresJobWithClient(job: WritebackJob, config: RunnerConfig, client: PostgresApplyClient): Promise<WritebackResult> {
  return await withTransaction(client, async () => {
    const existing = await claimReceipt(client, job, config);
    if (existing) return existing;

    const conflictProjection = job.conflict_guard.kind === "version_column"
      ? `, ${quotePostgresIdentifier(job.conflict_guard.column)}::text AS "__synapsor_conflict_value"`
      : "";
    const row = await client.query(
      `SELECT *${conflictProjection} FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}
WHERE ${quotePostgresIdentifier(job.target.primary_key.column)} = $1
  AND ${quotePostgresIdentifier(job.target.tenant_guard.column)} = $2
FOR UPDATE`,
      [job.target.primary_key.value, job.target.tenant_guard.value]
    );
    if (!row.rowCount) {
      const hash = resultHash(job, "ROW_NOT_FOUND");
      await recordReceipt(client, job, "conflict", hash);
      return conflict(job, config, "ROW_NOT_FOUND", hash);
    }
    const currentVersion = row.rows[0]?.__synapsor_conflict_value ?? row.rows[0]?.[job.conflict_guard.kind === "version_column" ? job.conflict_guard.column : ""];
    if (job.conflict_guard.kind === "version_column" && !versionValuesMatch(currentVersion, job.conflict_guard.expected_value)) {
      const hash = resultHash(job, "VERSION_CONFLICT", currentVersion);
      await recordReceipt(client, job, "conflict", hash);
      return conflict(job, config, "VERSION_CONFLICT", hash);
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
}

async function claimReceipt(client: PostgresApplyClient, job: WritebackJob, config: RunnerConfig): Promise<WritebackResult | undefined> {
  const claimed = await client.query(
    `INSERT INTO synapsor_writeback_receipts (idempotency_key, job_id, proposal_id, status, result_hash)
VALUES ($1, $2, $3, 'in_progress', NULL)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING status, result_hash`,
    [job.idempotency_key, job.job_id, job.proposal_id]
  );
  if (claimed.rowCount === 1) return undefined;

  const receipt = await client.query(
    "SELECT status, result_hash FROM synapsor_writeback_receipts WHERE idempotency_key = $1 FOR UPDATE",
    [job.idempotency_key]
  );
  const row = receipt.rows[0];
  if (!row) return failed(job, config, "IDEMPOTENCY_RECEIPT_UNAVAILABLE");
  return resultFromExistingReceipt(job, config, row.status, row.result_hash);
}

function resultFromExistingReceipt(job: WritebackJob, config: RunnerConfig, status: unknown, hash: unknown): WritebackResult {
  const result_hash = typeof hash === "string" && hash ? hash : resultHash(job, "idempotent");
  if (status === "applied" || status === "already_applied") {
    return {
      protocol_version: "1.0",
      job_id: job.job_id,
      runner_id: config.runnerId,
      status: "already_applied",
      affected_rows: 0,
      result_hash,
      completed_at: new Date().toISOString()
    };
  }
  if (status === "conflict") return conflict(job, config, "IDEMPOTENT_CONFLICT", result_hash);
  if (status === "failed") return failed(job, config, "IDEMPOTENT_FAILED");
  return failed(job, config, "IDEMPOTENCY_RECEIPT_IN_PROGRESS");
}

async function recordReceipt(client: PostgresApplyClient, job: WritebackJob, status: string, hash: string): Promise<void> {
  const result = await client.query(
    `UPDATE synapsor_writeback_receipts
SET status = $2, result_hash = $3, completed_at = now()
WHERE idempotency_key = $1`,
    [job.idempotency_key, status, hash]
  );
  if (result.rowCount !== 1) throw new Error("IDEMPOTENCY_RECEIPT_UNAVAILABLE");
}

function conflict(job: WritebackJob, config: RunnerConfig, code: string, result_hash?: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "conflict", affected_rows: 0, error_code: code, result_hash, completed_at: new Date().toISOString() };
}

function failed(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: "failed", error_code: code, completed_at: new Date().toISOString() };
}

export const postgresAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "database URL required; local config apply reads source.write_url_env, legacy workers use SYNAPSOR_DATABASE_URL" } };
    const pool = createPostgresPool(config.databaseUrl);
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT version()");
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
