import crypto from "node:crypto";
import { Pool, types as pgTypes, type PoolConfig } from "pg";
import type { WritebackJob, WritebackResult } from "@synapsor-runner/protocol";
import type { ApplyAdapter, ReconciliationObservation, RunnerConfig } from "@synapsor-runner/worker-core";

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

type Operation = "single_row_update" | "single_row_insert" | "single_row_delete";
type ColumnValue = { column: string; value: string | number | boolean | null };
type MutationOutcome = {
  status: "applied" | "already_applied" | "conflict" | "failed";
  affectedRows: number;
  code?: string;
  targetIdentity: ColumnValue[];
  resultVersion?: string | number | boolean | null;
  beforeDigest?: `sha256:${string}`;
  afterDigest?: `sha256:${string}`;
  tombstoneDigest?: `sha256:${string}`;
};

const POSTGRES_TIMESTAMP_OIDS = new Set([1114, 1184]);

/** Keep database timestamp precision intact instead of coercing through JS Date. */
export function postgresPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    types: {
      getTypeParser(oid: number, format?: "text" | "binary") {
        if ((format ?? "text") === "text" && POSTGRES_TIMESTAMP_OIDS.has(oid)) return (value: string) => value;
        return pgTypes.getTypeParser(oid, format);
      },
    },
  };
}

export function createPostgresPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({ ...postgresPoolConfig(connectionString), ...overrides, connectionString });
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`unsafe postgres identifier: ${identifier}`);
  return `"${identifier}"`;
}

function operationOf(job: WritebackJob): Operation {
  return job.operation ?? "single_row_update";
}

function receiptAuthority(config: RunnerConfig): "source_db" | "runner_ledger" {
  return config.receipts?.authority ?? "source_db";
}

function sourceReceiptTable(config: RunnerConfig): string {
  if (!config.receipts?.schema && !config.receipts?.table) return "synapsor_writeback_receipts";
  const table = quotePostgresIdentifier(config.receipts?.table ?? "synapsor_writeback_receipts");
  return config.receipts?.schema ? `${quotePostgresIdentifier(config.receipts.schema)}.${table}` : table;
}

export function postgresReceiptMigrationForConfig(config: RunnerConfig): string {
  return postgresReceiptMigration.replace("synapsor_writeback_receipts", sourceReceiptTable(config));
}

export function buildPostgresUpdate(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_update") throw new Error("postgres update builder requires single_row_update");
  validatePatch(job, "postgres");
  if (job.target.primary_key.value === undefined) throw new Error("postgres update requires primary-key value");
  const values: unknown[] = [];
  const setFragments = Object.entries(job.patch).map(([column, value]) => {
    values.push(value);
    return `${quotePostgresIdentifier(column)} = $${values.length}`;
  });
  if (job.protocol_version === "2.0" && job.version_advance?.strategy === "integer_increment") {
    setFragments.push(`${quotePostgresIdentifier(job.version_advance.column)} = ${quotePostgresIdentifier(job.version_advance.column)} + 1`);
  }
  values.push(job.target.primary_key.value);
  const pkParam = `$${values.length}`;
  values.push(job.target.tenant_guard.value);
  const tenantParam = `$${values.length}`;
  const where = [
    `${quotePostgresIdentifier(job.target.primary_key.column)} = ${pkParam}`,
    `${quotePostgresIdentifier(job.target.tenant_guard.column)} = ${tenantParam}`,
  ];
  if (job.conflict_guard.kind === "version_column") {
    values.push(job.conflict_guard.expected_value);
    where.push(`${quotePostgresIdentifier(job.conflict_guard.column)} = $${values.length}`);
  }
  const returning = job.protocol_version === "2.0" && job.version_advance
    ? ` RETURNING ${quotePostgresIdentifier(job.version_advance.column)}::text AS "__synapsor_result_version"`
    : "";
  return {
    sql: `UPDATE ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}\nSET ${setFragments.join(", ")}\nWHERE ${where.join(" AND ")}${returning}`,
    values,
  };
}

export function buildPostgresInsert(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_insert" || job.protocol_version !== "2.0" || !job.deduplication) {
    throw new Error("postgres insert requires a v2 single_row_insert job with deduplication");
  }
  validatePatch(job, "postgres");
  const row = insertValues(job);
  const columns = Object.keys(row);
  const values = Object.values(row);
  return {
    sql: `INSERT INTO ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)} (${columns.map(quotePostgresIdentifier).join(", ")})\nVALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})\nRETURNING ${quotePostgresIdentifier(job.target.primary_key.column)}::text AS "__synapsor_primary_key"`,
    values,
  };
}

export function buildPostgresDelete(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_delete") throw new Error("postgres delete builder requires single_row_delete");
  if (job.target.primary_key.value === undefined || job.conflict_guard.kind !== "version_column") {
    throw new Error("postgres delete requires primary-key and exact version guards");
  }
  return {
    sql: `DELETE FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}\nWHERE ${quotePostgresIdentifier(job.target.primary_key.column)} = $1\n  AND ${quotePostgresIdentifier(job.target.tenant_guard.column)} = $2\n  AND ${quotePostgresIdentifier(job.conflict_guard.column)} = $3`,
    values: [job.target.primary_key.value, job.target.tenant_guard.value, job.conflict_guard.expected_value],
  };
}

function validatePatch(job: WritebackJob, engine: string): void {
  const patchColumns = Object.keys(job.patch || {});
  if (!patchColumns.length) throw new Error(`${engine} writeback patch must not be empty`);
  const allowed = new Set(job.allowed_columns);
  if (allowed.has(job.target.primary_key.column)) throw new Error(`${engine} primary key column must not be patch-allowlisted`);
  if (allowed.has(job.target.tenant_guard.column)) throw new Error(`${engine} tenant guard column must not be patch-allowlisted`);
  for (const column of patchColumns) if (!allowed.has(column)) throw new Error(`${engine} patch column not allowlisted: ${column}`);
}

function insertValues(job: Extract<WritebackJob, { protocol_version: "2.0" }>): Record<string, unknown> {
  if (job.operation !== "single_row_insert" || !job.deduplication) throw new Error("INSERT_DEDUP_REQUIRED");
  const values: Record<string, unknown> = { ...job.patch };
  let trustedTenant = false;
  let proposalIdentity = false;
  for (const component of job.deduplication.components) {
    if (Object.prototype.hasOwnProperty.call(values, component.column)) throw new Error("INSERT_DEDUP_COLUMN_COLLISION");
    values[component.column] = component.value;
    if (component.source === "trusted_tenant" && component.column === job.target.tenant_guard.column && component.value === job.target.tenant_guard.value) trustedTenant = true;
    if (component.source === "proposal_id") proposalIdentity = true;
  }
  if (!trustedTenant || !proposalIdentity) throw new Error("INSERT_DEDUP_REQUIRED");
  return values;
}

function identityForJob(job: WritebackJob, insertedPrimaryKey?: unknown): ColumnValue[] {
  const identity: ColumnValue[] = [];
  if (insertedPrimaryKey !== undefined && insertedPrimaryKey !== null) identity.push({ column: job.target.primary_key.column, value: scalar(insertedPrimaryKey) });
  else if (job.target.primary_key.value !== undefined) identity.push({ column: job.target.primary_key.column, value: job.target.primary_key.value });
  if (job.protocol_version === "2.0" && job.deduplication) {
    for (const component of job.deduplication.components) {
      if (!identity.some((item) => item.column === component.column)) identity.push({ column: component.column, value: component.value });
    }
  }
  if (identity.length === 0) identity.push({ column: job.target.tenant_guard.column, value: job.target.tenant_guard.value });
  return identity.slice(0, 8);
}

function scalar(value: unknown): string | number | boolean | null {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value as string | number | boolean | null : String(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function reconciliationProjection(job: WritebackJob): string[] {
  const columns = new Set<string>([job.target.primary_key.column, job.target.tenant_guard.column, ...job.allowed_columns]);
  if (job.conflict_guard.kind === "version_column") columns.add(job.conflict_guard.column);
  if (job.protocol_version === "2.0" && job.deduplication) {
    for (const component of job.deduplication.components) columns.add(component.column);
  }
  return [...columns];
}

export function buildPostgresReconciliationRead(job: WritebackJob): { sql: string; values: unknown[] } {
  const projection = reconciliationProjection(job).map(quotePostgresIdentifier).join(", ");
  if (operationOf(job) === "single_row_insert" && job.protocol_version === "2.0" && job.deduplication) {
    return {
      sql: `SELECT ${projection} FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}\nWHERE ${job.deduplication.components.map((component, index) => `${quotePostgresIdentifier(component.column)} = $${index + 1}`).join(" AND ")}\nLIMIT 2`,
      values: job.deduplication.components.map((component) => component.value),
    };
  }
  if (job.target.primary_key.value === undefined) throw new Error("RECONCILIATION_TARGET_IDENTITY_REQUIRED");
  return {
    sql: `SELECT ${projection} FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}\nWHERE ${quotePostgresIdentifier(job.target.primary_key.column)} = $1\n  AND ${quotePostgresIdentifier(job.target.tenant_guard.column)} = $2\nLIMIT 2`,
    values: [job.target.primary_key.value, job.target.tenant_guard.value],
  };
}

export async function inspectPostgresWritebackSource(job: WritebackJob, databaseUrl: string): Promise<ReconciliationObservation> {
  if (!databaseUrl) throw new Error("DATABASE_UNAVAILABLE");
  const pool = createPostgresPool(databaseUrl);
  try {
    const query = buildPostgresReconciliationRead(job);
    const result = await pool.query(query.sql, query.values);
    if (result.rowCount !== null && result.rowCount > 1) throw new Error("RECONCILIATION_IDENTITY_NOT_UNIQUE");
    return reconciliationObservation(job, result.rows[0]);
  } catch (error) {
    const code = safeErrorCode(error);
    throw new Error(code === "TRANSACTION_FAILED" ? "RECONCILIATION_INSPECTION_FAILED" : code);
  } finally {
    await pool.end();
  }
}

function reconciliationObservation(job: WritebackJob, row: Record<string, unknown> | undefined): ReconciliationObservation {
  const operation = operationOf(job);
  const targetIdentity = identityForJob(job, row?.[job.target.primary_key.column]);
  const observed = row
    ? Object.fromEntries(reconciliationProjection(job).map((column) => [column, scalar(row[column])]))
    : {};
  const expected: Record<string, string | number | boolean | null> = {
    tenant: job.target.tenant_guard.value,
    ...(job.target.primary_key.value === undefined ? {} : { primary_key: job.target.primary_key.value }),
    ...(job.conflict_guard.kind === "version_column" ? { expected_version: job.conflict_guard.expected_value } : {}),
  };
  let classification: ReconciliationObservation["classification"];
  if (!row) classification = operation === "single_row_delete" ? "target_absent" : "not_observed";
  else if (operation === "single_row_insert") classification = valuesMatch(row, job.patch) ? "matches_proposed" : "drifted";
  else if (operation === "single_row_delete") classification = versionStillExpected(job, row) ? "matches_reviewed_before" : "drifted";
  else if (valuesMatch(row, job.patch) && versionMatchesProposed(job, row)) classification = "matches_proposed";
  else if (versionStillExpected(job, row)) classification = "matches_reviewed_before";
  else classification = "drifted";
  return { operation, classification, target_identity: targetIdentity, expected, observed, observed_digest: digest(observed) };
}

function valuesMatch(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([column, value]) => versionValuesMatch(row[column], value));
}

function versionStillExpected(job: WritebackJob, row: Record<string, unknown>): boolean {
  return job.conflict_guard.kind === "version_column" && versionValuesMatch(row[job.conflict_guard.column], job.conflict_guard.expected_value);
}

function versionMatchesProposed(job: WritebackJob, row: Record<string, unknown>): boolean {
  if (job.protocol_version !== "2.0" || !job.version_advance || job.conflict_guard.kind !== "version_column") return true;
  const actual = row[job.version_advance.column];
  if (job.version_advance.strategy === "integer_increment") {
    return typeof job.conflict_guard.expected_value === "number" && Number(actual) === job.conflict_guard.expected_value + 1;
  }
  return !versionValuesMatch(actual, job.conflict_guard.expected_value);
}

function resultHash(job: WritebackJob, status: string, version?: unknown): `sha256:${string}` {
  return digest({ job_id: job.job_id, status, version });
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
      const utc = new Date(Date.UTC(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]), Number(timeParts[0]), Number(timeParts[1]), Number(timeParts[2])) - offsetMinutes(offset) * 60_000);
      return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())} ${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())}:${pad2(utc.getUTCSeconds())}.${fraction}`;
    }
    return `${timestamp[1]} ${timestamp[2]}.${fraction}`;
  }
  return text;
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const compact = offset.slice(1).replace(":", "");
  return sign * (Number(compact.slice(0, 2)) * 60 + Number(compact.slice(2, 4) || "0"));
}

function pad2(value: number): string { return String(value).padStart(2, "0"); }
export function versionValuesMatch(actual: unknown, expected: unknown): boolean { return normalizeVersionValue(actual) === normalizeVersionValue(expected); }

async function sourceTransaction<T>(
  client: PostgresApplyClient,
  fn: () => Promise<T>,
  hooks: { afterBegin?: () => Promise<void>; afterMutation?: () => Promise<void>; beforeCommit?: () => Promise<void> } = {},
): Promise<T> {
  await client.query("BEGIN");
  try {
    await hooks.afterBegin?.();
    const result = await fn();
    await hooks.afterMutation?.();
    await hooks.beforeCommit?.();
    try {
      await client.query("COMMIT");
    } catch (error) {
      throw new SourceOutcomeUnknownError(error);
    }
    return result;
  } catch (error) {
    if (!(error instanceof SourceOutcomeUnknownError)) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new SourceOutcomeUnknownError({ error, rollbackError });
      }
    }
    throw error;
  }
}

class SourceOutcomeUnknownError extends Error {
  constructor(public readonly cause: unknown) { super("source transaction outcome is unknown"); }
}

export async function applyPostgresJob(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult> {
  if (config.dryRun) {
    validateOperation(job);
    return resultFromOutcome(job, config, { status: "applied", affectedRows: 0, targetIdentity: identityForJob(job) });
  }
  if (!config.databaseUrl) return failedResult(job, config, "DATABASE_UNAVAILABLE");
  const pool = createPostgresPool(config.databaseUrl);
  const client = await pool.connect();
  try {
    return await applyPostgresJobWithClient(job, config, client);
  } catch (error) {
    return failedResult(job, config, safeErrorCode(error, operationOf(job)));
  } finally {
    client.release();
    await pool.end();
  }
}

export async function applyPostgresJobWithClient(job: WritebackJob, config: RunnerConfig, client: PostgresApplyClient): Promise<WritebackResult> {
  validateOperation(job);
  if (receiptAuthority(config) === "runner_ledger") return await applyWithRunnerLedger(job, config, client);
  if (config.receipts?.provisioning === "auto_migrate") await client.query(postgresReceiptMigrationForConfig(config));
  return await sourceTransaction(client, async () => {
    const existing = await claimSourceReceipt(client, job, config);
    if (existing) return existing;
    const outcome = await mutatePostgres(job, client);
    const result = resultFromOutcome(job, config, outcome);
    await recordSourceReceipt(client, job, config, outcome.status, resultHashFromResult(job, result));
    return result;
  });
}

async function applyWithRunnerLedger(job: WritebackJob, config: RunnerConfig, client: PostgresApplyClient): Promise<WritebackResult> {
  const store = config.writebackIntentStore;
  if (!store) return failedResult(job, config, "RUNNER_LEDGER_UNAVAILABLE");
  const claim = await store.claimWritebackIntent(job, config.runnerId);
  if (claim.decision === "existing_result") return asAlreadyApplied(claim.result, job, config);
  if (claim.decision === "reconciliation_required") return reconciliationResult(job, config, claim.intent_id);
  await config.testFailpoint?.("after_intent_recorded");
  try {
    await store.markWritebackIntentApplying(claim.intent_id, config.runnerId);
  } catch {
    await store.requireWritebackReconciliation(claim.intent_id, "another worker crossed or may have crossed the source mutation boundary");
    return reconciliationResult(job, config, claim.intent_id);
  }
  await config.testFailpoint?.("after_intent_applying");
  let result: WritebackResult;
  try {
    const outcome = await sourceTransaction(client, () => mutatePostgres(job, client), {
      afterBegin: () => Promise.resolve(config.testFailpoint?.("after_source_begin")),
      afterMutation: () => Promise.resolve(config.testFailpoint?.("after_source_mutation")),
      beforeCommit: () => Promise.resolve(config.testFailpoint?.("before_source_commit")),
    });
    result = resultFromOutcome(job, config, outcome);
  } catch (error) {
    if (error instanceof SourceOutcomeUnknownError) {
      await store.requireWritebackReconciliation(claim.intent_id, "database COMMIT acknowledgement was not observed");
      return reconciliationResult(job, config, claim.intent_id);
    }
    result = failedResult(job, config, safeErrorCode(error, operationOf(job)));
    await store.completeWritebackIntent(claim.intent_id, result);
    return result;
  }
  try {
    await config.testFailpoint?.("after_source_commit");
  } catch {
    await store.requireWritebackReconciliation(claim.intent_id, "process stopped after source COMMIT and before ledger completion");
    return reconciliationResult(job, config, claim.intent_id);
  }
  await store.completeWritebackIntent(claim.intent_id, result);
  await config.testFailpoint?.("after_intent_completed");
  return result;
}

function validateOperation(job: WritebackJob): void {
  if (operationOf(job) === "single_row_update") buildPostgresUpdate(job);
  else if (operationOf(job) === "single_row_insert") buildPostgresInsert(job);
  else buildPostgresDelete(job);
}

async function mutatePostgres(job: WritebackJob, client: PostgresApplyClient): Promise<MutationOutcome> {
  const operation = operationOf(job);
  if (operation === "single_row_insert") return await insertPostgres(job, client);
  const row = await lockTargetRow(job, client);
  if (!row) return { status: "conflict", affectedRows: 0, code: "ROW_NOT_FOUND", targetIdentity: identityForJob(job) };
  if (job.conflict_guard.kind === "version_column") {
    const actual = row.__synapsor_conflict_value ?? row[job.conflict_guard.column];
    if (!versionValuesMatch(actual, job.conflict_guard.expected_value)) {
      return { status: "conflict", affectedRows: 0, code: "VERSION_CONFLICT", targetIdentity: identityForJob(job), resultVersion: scalar(actual) };
    }
  }
  const beforeDigest = digest({ identity: identityForJob(job), reviewed: job.patch, expected: job.conflict_guard });
  if (operation === "single_row_delete") {
    const safety = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal) AS has_user_trigger, EXISTS (SELECT 1 FROM pg_constraint fk JOIN pg_class target ON target.oid=fk.confrelid JOIN pg_namespace n ON n.oid=target.relnamespace WHERE fk.contype='f' AND fk.confdeltype IN ('c','n','d') AND n.nspname=$1 AND target.relname=$2) AS has_widening_fk`,
      [job.target.schema, job.target.table],
    );
    if (safety.rows[0]?.has_user_trigger === true) return { status: "failed", affectedRows: 0, code: "DELETE_TRIGGER_BLOCKED", targetIdentity: identityForJob(job) };
    if (safety.rows[0]?.has_widening_fk === true) return { status: "failed", affectedRows: 0, code: "DELETE_CASCADE_BLOCKED", targetIdentity: identityForJob(job) };
    const deletion = buildPostgresDelete(job);
    const deleted = await client.query(deletion.sql, deletion.values);
    if (deleted.rowCount !== 1) throw new Error(deleted.rowCount === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
    return { status: "applied", affectedRows: 1, targetIdentity: identityForJob(job), beforeDigest, tombstoneDigest: digest({ identity: identityForJob(job), expected: job.conflict_guard }) };
  }
  const update = buildPostgresUpdate(job);
  const applied = await client.query(update.sql, update.values);
  if (applied.rowCount !== 1) throw new Error(applied.rowCount === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
  const resultVersion = applied.rows[0]?.__synapsor_result_version == null ? undefined : scalar(applied.rows[0].__synapsor_result_version);
  verifyVersionAdvanced(job, resultVersion);
  return { status: "applied", affectedRows: 1, targetIdentity: identityForJob(job), resultVersion, beforeDigest, afterDigest: digest({ identity: identityForJob(job), patch: job.patch, version: resultVersion }) };
}

async function lockTargetRow(job: WritebackJob, client: PostgresApplyClient): Promise<Record<string, unknown> | undefined> {
  if (job.target.primary_key.value === undefined) return undefined;
  const projection = [
    `${quotePostgresIdentifier(job.target.primary_key.column)}::text AS "__synapsor_primary_key"`,
    ...(job.conflict_guard.kind === "version_column"
      ? [`${quotePostgresIdentifier(job.conflict_guard.column)}::text AS "__synapsor_conflict_value"`]
      : []),
  ].join(", ");
  const result = await client.query(
    `SELECT ${projection} FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)}\nWHERE ${quotePostgresIdentifier(job.target.primary_key.column)} = $1\n  AND ${quotePostgresIdentifier(job.target.tenant_guard.column)} = $2\nFOR UPDATE`,
    [job.target.primary_key.value, job.target.tenant_guard.value],
  );
  return result.rowCount ? result.rows[0] : undefined;
}

async function insertPostgres(job: WritebackJob, client: PostgresApplyClient): Promise<MutationOutcome> {
  if (job.protocol_version !== "2.0" || !job.deduplication) throw new Error("INSERT_DEDUP_REQUIRED");
  const components = job.deduplication.components;
  const whereValues = components.map((component) => component.value);
  const existing = await client.query(
    `SELECT ${quotePostgresIdentifier(job.target.primary_key.column)}::text AS "__synapsor_primary_key" FROM ${quotePostgresIdentifier(job.target.schema)}.${quotePostgresIdentifier(job.target.table)} WHERE ${components.map((component, index) => `${quotePostgresIdentifier(component.column)} = $${index + 1}`).join(" AND ")}`,
    whereValues,
  );
  if (existing.rowCount) return { status: "conflict", affectedRows: 0, code: "INSERT_DEDUP_CONFLICT", targetIdentity: identityForJob(job, existing.rows[0]?.__synapsor_primary_key) };
  const insertion = buildPostgresInsert(job);
  const inserted = await client.query(insertion.sql, insertion.values);
  if (inserted.rowCount !== 1) throw new Error(inserted.rowCount === 0 ? "INSERT_CONSTRAINT_FAILED" : "MULTI_ROW_WRITE_BLOCKED");
  const primaryKey = inserted.rows[0]?.__synapsor_primary_key;
  const identity = identityForJob(job, primaryKey);
  return { status: "applied", affectedRows: 1, targetIdentity: identity, afterDigest: digest({ identity, values: insertValues(job) }) };
}

function verifyVersionAdvanced(job: WritebackJob, actual: unknown): void {
  if (job.protocol_version !== "2.0" || job.operation !== "single_row_update" || !job.version_advance) return;
  if (actual === undefined) throw new Error("VERSION_DID_NOT_ADVANCE");
  if (job.conflict_guard.kind !== "version_column") throw new Error("VERSION_DID_NOT_ADVANCE");
  if (job.version_advance.strategy === "integer_increment") {
    if (typeof job.conflict_guard.expected_value !== "number" || Number(actual) !== job.conflict_guard.expected_value + 1) throw new Error("VERSION_DID_NOT_ADVANCE");
  } else if (versionValuesMatch(actual, job.conflict_guard.expected_value)) throw new Error("VERSION_DID_NOT_ADVANCE");
}

async function claimSourceReceipt(client: PostgresApplyClient, job: WritebackJob, config: RunnerConfig): Promise<WritebackResult | undefined> {
  const table = sourceReceiptTable(config);
  const claimed = await client.query(`INSERT INTO ${table} (idempotency_key, job_id, proposal_id, status, result_hash)\nVALUES ($1, $2, $3, 'in_progress', NULL)\nON CONFLICT (idempotency_key) DO NOTHING\nRETURNING status, result_hash`, [job.idempotency_key, job.job_id, job.proposal_id]);
  if (claimed.rowCount === 1) return undefined;
  const receipt = await client.query(`SELECT status, result_hash FROM ${table} WHERE idempotency_key = $1 FOR UPDATE`, [job.idempotency_key]);
  const row = receipt.rows[0];
  if (!row) return failedResult(job, config, "SOURCE_RECEIPT_UNAVAILABLE");
  return resultFromExistingReceipt(job, config, row.status, row.result_hash);
}

async function recordSourceReceipt(client: PostgresApplyClient, job: WritebackJob, config: RunnerConfig, status: string, hash: string): Promise<void> {
  const updated = await client.query(`UPDATE ${sourceReceiptTable(config)}\nSET status = $2, result_hash = $3, completed_at = now()\nWHERE idempotency_key = $1`, [job.idempotency_key, status, hash]);
  if (updated.rowCount !== 1) throw new Error("SOURCE_RECEIPT_UNAVAILABLE");
}

function resultFromExistingReceipt(job: WritebackJob, config: RunnerConfig, status: unknown, hash: unknown): WritebackResult {
  const resultHashValue = typeof hash === "string" && hash ? hash as `sha256:${string}` : resultHash(job, "idempotent");
  if (status === "applied" || status === "already_applied") return resultFromOutcome(job, config, { status: "already_applied", affectedRows: 0, targetIdentity: identityForJob(job) }, undefined, resultHashValue);
  if (status === "conflict") return resultFromOutcome(job, config, { status: "conflict", affectedRows: 0, code: "IDEMPOTENT_CONFLICT", targetIdentity: identityForJob(job) }, undefined, resultHashValue);
  if (status === "failed") return failedResult(job, config, "IDEMPOTENT_FAILED");
  return failedResult(job, config, "SOURCE_RECEIPT_UNAVAILABLE");
}

function resultFromOutcome(job: WritebackJob, config: RunnerConfig, outcome: MutationOutcome, overrideCode?: string, overrideHash?: `sha256:${string}`): WritebackResult {
  const operation = operationOf(job);
  const hash = overrideHash ?? resultHash(job, outcome.status, outcome.resultVersion);
  if (job.protocol_version !== "2.0") {
    return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: outcome.status, affected_rows: outcome.affectedRows, result_version: outcome.resultVersion == null ? undefined : String(outcome.resultVersion), result_hash: hash, error_code: outcome.code ?? overrideCode, completed_at: new Date().toISOString() };
  }
  return { protocol_version: "2.0", job_id: job.job_id, runner_id: config.runnerId, operation, receipt_authority: receiptAuthority(config), status: outcome.status, affected_rows: outcome.affectedRows, target_identity: outcome.targetIdentity, result_version: outcome.resultVersion, before_digest: outcome.beforeDigest, after_digest: outcome.afterDigest, tombstone_digest: outcome.tombstoneDigest, result_hash: hash, error_code: outcome.code ?? overrideCode, completed_at: new Date().toISOString() };
}

function failedResult(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult {
  return resultFromOutcome(job, config, { status: "failed", affectedRows: 0, code, targetIdentity: identityForJob(job) });
}

function reconciliationResult(job: WritebackJob, config: RunnerConfig, intentId: string): WritebackResult {
  if (job.protocol_version !== "2.0") return failedResult(job, config, "RECONCILIATION_REQUIRED");
  return { protocol_version: "2.0", job_id: job.job_id, runner_id: config.runnerId, operation: operationOf(job), receipt_authority: "runner_ledger", status: "reconciliation_required", affected_rows: 0, target_identity: identityForJob(job), result_hash: resultHash(job, "reconciliation_required"), error_code: "RECONCILIATION_REQUIRED", intent_id: intentId, completed_at: new Date().toISOString() };
}

function asAlreadyApplied(result: WritebackResult, job: WritebackJob, config: RunnerConfig): WritebackResult {
  if (result.status !== "applied" && result.status !== "already_applied") return result;
  return resultFromOutcome(job, config, { status: "already_applied", affectedRows: 0, targetIdentity: identityForJob(job), resultVersion: result.result_version }, undefined, result.result_hash as `sha256:${string}` | undefined);
}

function resultHashFromResult(job: WritebackJob, result: WritebackResult): `sha256:${string}` {
  return typeof result.result_hash === "string" && result.result_hash.startsWith("sha256:") ? result.result_hash as `sha256:${string}` : resultHash(job, result.status, result.result_version);
}

function safeErrorCode(error: unknown, operation?: Operation): string {
  if (error instanceof SourceOutcomeUnknownError) return "OUTCOME_UNKNOWN";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "23505" && operation === "single_row_insert") return "INSERT_DEDUP_CONFLICT";
  for (const known of ["MULTI_ROW_WRITE_BLOCKED", "VERSION_CONFLICT", "VERSION_DID_NOT_ADVANCE", "INSERT_DEDUP_CONFLICT", "INSERT_CONSTRAINT_FAILED", "DELETE_CASCADE_BLOCKED", "DELETE_TRIGGER_BLOCKED", "SOURCE_RECEIPT_UNAVAILABLE", "RUNNER_LEDGER_UNAVAILABLE"]) if (message.includes(known)) return known;
  return "TRANSACTION_FAILED";
}

export const postgresAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "database URL required; local config apply reads source.write_url_env, legacy workers use SYNAPSOR_DATABASE_URL" } };
    const pool = createPostgresPool(config.databaseUrl);
    const client = await pool.connect();
    try {
      const version = await client.query("SELECT version()");
      if (receiptAuthority(config) === "source_db") {
        if (config.receipts?.provisioning === "auto_migrate") await client.query(postgresReceiptMigrationForConfig(config));
        await client.query("BEGIN");
        try {
          const doctorId = `doctor-${Date.now()}`;
          const receiptTable = sourceReceiptTable(config);
          await client.query(`SELECT idempotency_key, status FROM ${receiptTable} WHERE false`);
          await client.query(`INSERT INTO ${receiptTable} (idempotency_key, job_id, proposal_id, status, result_hash, completed_at) VALUES ($1, $2, $3, $4, $5, now())`, [doctorId, doctorId, "doctor", "doctor", "sha256:doctor"]);
          const updated = await client.query(`UPDATE ${receiptTable} SET status = $1 WHERE idempotency_key = $2`, ["doctor_updated", doctorId]);
          if (updated.rowCount !== 1) throw new Error("SOURCE_RECEIPT_UNAVAILABLE");
          await client.query("ROLLBACK");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
      return { ok: true, details: { version: version.rows[0]?.version, receipt_authority: receiptAuthority(config), receipt_provisioning: receiptAuthority(config) === "source_db" ? (config.receipts?.provisioning ?? "precreated") : "not_applicable", receipt_table: receiptAuthority(config) === "source_db" ? "ready" : "not_used", receipt_permissions: receiptAuthority(config) === "source_db" ? "select_insert_update_rollback_verified" : "no_source_receipt_access", write_permission_rollback: true, dry_run: config.dryRun } };
    } finally {
      client.release();
      await pool.end();
    }
  },
  apply: applyPostgresJob,
};
