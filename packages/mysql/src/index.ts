import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { WritebackJob, WritebackResult } from "@synapsor-runner/protocol";
import { assertFrozenSetJobIntegrity, classifyFrozenSetReconciliation, type ApplyAdapter, type ReconciliationObservation, type RunnerConfig } from "@synapsor-runner/worker-core";

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

type Operation = "single_row_update" | "single_row_insert" | "single_row_delete" | "set_update" | "set_delete" | "batch_insert";
type SetWritebackJob = Extract<WritebackJob, { protocol_version: "3.0" }>;
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
  memberEffects?: Array<{ primary_key: ColumnValue; before_digest?: string; after_digest?: string; tombstone_digest?: string }>;
};

export function quoteMysqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`unsafe mysql identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function operationOf(job: WritebackJob): Operation { return job.operation ?? "single_row_update"; }
function receiptAuthority(config: RunnerConfig): "source_db" | "runner_ledger" { return config.receipts?.authority ?? "source_db"; }

function sourceReceiptTable(config: RunnerConfig): string {
  if (!config.receipts?.schema && !config.receipts?.table) return "synapsor_writeback_receipts";
  const table = quoteMysqlIdentifier(config.receipts?.table ?? "synapsor_writeback_receipts");
  return config.receipts?.schema ? `${quoteMysqlIdentifier(config.receipts.schema)}.${table}` : table;
}

export function mysqlReceiptMigrationForConfig(config: RunnerConfig): string {
  return mysqlReceiptMigration.replace("synapsor_writeback_receipts", sourceReceiptTable(config));
}

export function buildMysqlUpdate(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_update") throw new Error("mysql update builder requires single_row_update");
  validatePatch(job, "mysql");
  if (job.target.primary_key.value === undefined) throw new Error("mysql update requires primary-key value");
  const values: unknown[] = [];
  const setFragments = Object.entries(job.patch).map(([column, value]) => {
    values.push(value);
    return `${quoteMysqlIdentifier(column)} = ?`;
  });
  if (job.protocol_version === "2.0" && job.version_advance?.strategy === "integer_increment") {
    setFragments.push(`${quoteMysqlIdentifier(job.version_advance.column)} = ${quoteMysqlIdentifier(job.version_advance.column)} + 1`);
  }
  values.push(job.target.primary_key.value, job.target.tenant_guard.value);
  const where = [
    `${quoteMysqlIdentifier(job.target.primary_key.column)} = ?`,
    `${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?`,
  ];
  if (job.conflict_guard.kind === "version_column") {
    values.push(job.conflict_guard.expected_value);
    where.push(`${quoteMysqlIdentifier(job.conflict_guard.column)} = ?`);
  }
  return { sql: `UPDATE ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nSET ${setFragments.join(", ")}\nWHERE ${where.join(" AND ")}`, values };
}

export function buildMysqlInsert(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_insert" || job.protocol_version !== "2.0" || !job.deduplication) throw new Error("mysql insert requires a v2 single_row_insert job with deduplication");
  validatePatch(job, "mysql");
  const row = insertValues(job);
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} (${columns.map(quoteMysqlIdentifier).join(", ")})\nVALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

export function buildMysqlDelete(job: WritebackJob): { sql: string; values: unknown[] } {
  if (operationOf(job) !== "single_row_delete") throw new Error("mysql delete builder requires single_row_delete");
  if (job.target.primary_key.value === undefined || job.conflict_guard.kind !== "version_column") throw new Error("mysql delete requires primary-key and exact version guards");
  return {
    sql: `DELETE FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nWHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ?\n  AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?\n  AND ${quoteMysqlIdentifier(job.conflict_guard.column)} = ?`,
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
  if (job.protocol_version === "3.0") return job.frozen_set.members.map((member) => member.primary_key);
  const identity: ColumnValue[] = [];
  if (insertedPrimaryKey !== undefined && insertedPrimaryKey !== null && insertedPrimaryKey !== 0) identity.push({ column: job.target.primary_key.column, value: scalar(insertedPrimaryKey) });
  else if (job.target.primary_key.value !== undefined) identity.push({ column: job.target.primary_key.column, value: job.target.primary_key.value });
  if (job.protocol_version === "2.0" && job.deduplication) {
    for (const component of job.deduplication.components) if (!identity.some((item) => item.column === component.column)) identity.push({ column: component.column, value: component.value });
  }
  if (identity.length === 0) identity.push({ column: job.target.tenant_guard.column, value: job.target.tenant_guard.value });
  return identity.slice(0, 8);
}

function scalar(value: unknown): string | number | boolean | null {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value as string | number | boolean | null : String(value);
}
function digest(value: unknown): `sha256:${string}` { return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function resultHash(job: WritebackJob, status: string, version?: unknown): `sha256:${string}` { return digest({ job_id: job.job_id, status, version }); }

function reconciliationProjection(job: WritebackJob): string[] {
  const columns = new Set<string>([job.target.primary_key.column, job.target.tenant_guard.column, ...job.allowed_columns]);
  if (job.protocol_version === "3.0") {
    for (const member of job.frozen_set.members) {
      for (const column of Object.keys(member.before)) columns.add(column);
      for (const column of Object.keys(member.after)) columns.add(column);
    }
  }
  if (job.conflict_guard.kind === "version_column") columns.add(job.conflict_guard.column);
  if (job.protocol_version === "2.0" && job.deduplication) {
    for (const component of job.deduplication.components) columns.add(component.column);
  }
  return [...columns];
}

export function buildMysqlReconciliationRead(job: WritebackJob): { sql: string; values: unknown[] } {
  const projection = reconciliationProjection(job).map(quoteMysqlIdentifier).join(", ");
  if (job.protocol_version === "3.0") {
    const identities = job.frozen_set.members.map(() => "?").join(", ");
    return {
      sql: `SELECT ${projection} FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nWHERE ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?\n  AND ${quoteMysqlIdentifier(job.target.primary_key.column)} IN (${identities})\nORDER BY ${quoteMysqlIdentifier(job.target.primary_key.column)} ASC`,
      values: [job.target.tenant_guard.value, ...job.frozen_set.members.map((member) => member.primary_key.value)],
    };
  }
  if (operationOf(job) === "single_row_insert" && job.protocol_version === "2.0" && job.deduplication) {
    return {
      sql: `SELECT ${projection} FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nWHERE ${job.deduplication.components.map((component) => `${quoteMysqlIdentifier(component.column)} = ?`).join(" AND ")}\nLIMIT 2`,
      values: job.deduplication.components.map((component) => component.value),
    };
  }
  if (job.target.primary_key.value === undefined) throw new Error("RECONCILIATION_TARGET_IDENTITY_REQUIRED");
  return {
    sql: `SELECT ${projection} FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nWHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ?\n  AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?\nLIMIT 2`,
    values: [job.target.primary_key.value, job.target.tenant_guard.value],
  };
}

export async function inspectMysqlWritebackSource(job: WritebackJob, databaseUrl: string): Promise<ReconciliationObservation> {
  if (!databaseUrl) throw new Error("DATABASE_UNAVAILABLE");
  const connection = await mysql.createConnection({ uri: databaseUrl, dateStrings: true });
  try {
    const query = buildMysqlReconciliationRead(job);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(query.sql, query.values);
    if (job.protocol_version === "3.0") return classifyFrozenSetReconciliation(job, rows, versionValuesMatch);
    if (rows.length > 1) throw new Error("RECONCILIATION_IDENTITY_NOT_UNIQUE");
    return reconciliationObservation(job, rows[0]);
  } catch (error) {
    const code = safeErrorCode(error);
    throw new Error(code === "TRANSACTION_FAILED" ? "RECONCILIATION_INSPECTION_FAILED" : code);
  } finally {
    await connection.end();
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
function offsetMinutes(offset: string): number { const sign = offset.startsWith("-") ? -1 : 1; const compact = offset.slice(1).replace(":", ""); return sign * (Number(compact.slice(0, 2)) * 60 + Number(compact.slice(2, 4) || "0")); }
function pad2(value: number): string { return String(value).padStart(2, "0"); }
export function versionValuesMatch(actual: unknown, expected: unknown): boolean { return normalizeVersionValue(actual) === normalizeVersionValue(expected); }

class SourceOutcomeUnknownError extends Error { constructor(public readonly cause: unknown) { super("source transaction outcome is unknown"); } }

async function sourceTransaction<T>(
  connection: MysqlApplyConnection,
  fn: () => Promise<T>,
  statementTimeoutMs?: number,
  hooks: { afterBegin?: () => Promise<void>; afterMutation?: () => Promise<void>; beforeCommit?: () => Promise<void> } = {},
): Promise<T> {
  if (statementTimeoutMs !== undefined) {
    await connection.query("SET SESSION max_execution_time = ?", [statementTimeoutMs]);
    await connection.query("SET SESSION innodb_lock_wait_timeout = ?", [Math.max(1, Math.ceil(statementTimeoutMs / 1000))]);
  }
  await connection.beginTransaction();
  try {
    await hooks.afterBegin?.();
    const result = await fn();
    await hooks.afterMutation?.();
    await hooks.beforeCommit?.();
    try { await connection.commit(); } catch (error) { throw new SourceOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (!(error instanceof SourceOutcomeUnknownError)) {
      try { await connection.rollback(); }
      catch (rollbackError) { throw new SourceOutcomeUnknownError({ error, rollbackError }); }
    }
    throw error;
  }
}

export async function applyMysqlJob(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult> {
  if (config.dryRun) { validateOperation(job); return resultFromOutcome(job, config, { status: "applied", affectedRows: 0, targetIdentity: identityForJob(job) }); }
  if (!config.databaseUrl) return failedResult(job, config, "DATABASE_UNAVAILABLE");
  const connection = await mysql.createConnection({ uri: config.databaseUrl, dateStrings: true });
  try { return await applyMysqlJobWithConnection(job, config, connection); }
  catch (error) { return failedResult(job, config, safeErrorCode(error)); }
  finally { await connection.end(); }
}

export async function applyMysqlJobWithConnection(job: WritebackJob, config: RunnerConfig, connection: MysqlApplyConnection): Promise<WritebackResult> {
  validateOperation(job);
  if (receiptAuthority(config) === "runner_ledger") return await applyWithRunnerLedger(job, config, connection);
  if (config.receipts?.provisioning === "auto_migrate") await connection.query(mysqlReceiptMigrationForConfig(config));
  return await sourceTransaction(connection, async () => {
    const existing = await claimSourceReceipt(connection, job, config);
    if (existing) return existing;
    const outcome = await mutateMysql(job, connection);
    const result = resultFromOutcome(job, config, outcome);
    await recordSourceReceipt(connection, job, config, outcome.status, resultHashFromResult(job, result));
    return result;
  }, config.statementTimeoutMs);
}

async function applyWithRunnerLedger(job: WritebackJob, config: RunnerConfig, connection: MysqlApplyConnection): Promise<WritebackResult> {
  const store = config.writebackIntentStore;
  if (!store) return failedResult(job, config, "RUNNER_LEDGER_UNAVAILABLE");
  const claim = await store.claimWritebackIntent(job, config.runnerId);
  if (claim.decision === "existing_result") return asAlreadyApplied(claim.result, job, config);
  if (claim.decision === "reconciliation_required") return reconciliationResult(job, config, claim.intent_id);
  await config.testFailpoint?.("after_intent_recorded");
  try { await store.markWritebackIntentApplying(claim.intent_id, config.runnerId); }
  catch {
    await store.requireWritebackReconciliation(claim.intent_id, "another worker crossed or may have crossed the source mutation boundary");
    return reconciliationResult(job, config, claim.intent_id);
  }
  await config.testFailpoint?.("after_intent_applying");
  let result: WritebackResult;
  try {
    const outcome = await sourceTransaction(connection, () => mutateMysql(job, connection), config.statementTimeoutMs, {
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
    result = failedResult(job, config, safeErrorCode(error));
    await store.completeWritebackIntent(claim.intent_id, result);
    return result;
  }
  try { await config.testFailpoint?.("after_source_commit"); }
  catch {
    await store.requireWritebackReconciliation(claim.intent_id, "process stopped after source COMMIT and before ledger completion");
    return reconciliationResult(job, config, claim.intent_id);
  }
  await store.completeWritebackIntent(claim.intent_id, result);
  await config.testFailpoint?.("after_intent_completed");
  return result;
}

function validateOperation(job: WritebackJob): void {
  if (job.protocol_version === "3.0") return validateSetJob(job);
  if (operationOf(job) === "single_row_update") buildMysqlUpdate(job);
  else if (operationOf(job) === "single_row_insert") buildMysqlInsert(job);
  else buildMysqlDelete(job);
}

async function mutateMysql(job: WritebackJob, connection: MysqlApplyConnection): Promise<MutationOutcome> {
  if (job.protocol_version === "3.0") return await mutateMysqlSet(job, connection);
  const operation = operationOf(job);
  if (operation === "single_row_insert") return await insertMysql(job, connection);
  const row = await lockTargetRow(job, connection);
  if (!row) return { status: "conflict", affectedRows: 0, code: "ROW_NOT_FOUND", targetIdentity: identityForJob(job) };
  const conflictValue = job.conflict_guard.kind === "version_column"
    ? row.__synapsor_conflict_value ?? row[job.conflict_guard.column]
    : undefined;
  if (job.conflict_guard.kind === "version_column" && !versionValuesMatch(conflictValue, job.conflict_guard.expected_value)) {
    return { status: "conflict", affectedRows: 0, code: "VERSION_CONFLICT", targetIdentity: identityForJob(job), resultVersion: scalar(conflictValue) };
  }
  const beforeDigest = digest({ identity: identityForJob(job), reviewed: job.patch, expected: job.conflict_guard });
  if (operation === "single_row_delete") {
    const [visibilityRows] = await connection.query<Record<string, unknown>[]>(`SELECT (
  EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND PRIVILEGE_TYPE = 'TRIGGER')
  OR EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND TABLE_SCHEMA = ? AND PRIVILEGE_TYPE = 'TRIGGER')
  OR EXISTS (SELECT 1 FROM information_schema.TABLE_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PRIVILEGE_TYPE = 'TRIGGER')
) AS has_trigger_visibility,
EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND PRIVILEGE_TYPE = 'PROCESS') AS has_fk_visibility`, [job.target.schema, job.target.schema, job.target.table]);
    const triggerVisibility = visibilityRows[0]?.has_trigger_visibility;
    if (!(triggerVisibility === true || Number(triggerVisibility) === 1)) {
      return { status: "failed", affectedRows: 0, code: "DELETE_TRIGGER_VISIBILITY_REQUIRED", targetIdentity: identityForJob(job) };
    }
    const fkVisibility = visibilityRows[0]?.has_fk_visibility;
    if (!(fkVisibility === true || Number(fkVisibility) === 1)) {
      return { status: "failed", affectedRows: 0, code: "DELETE_FK_VISIBILITY_REQUIRED", targetIdentity: identityForJob(job) };
    }
    const [triggerRows] = await connection.query<Record<string, unknown>[]>("SELECT 1 AS found FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? LIMIT 1", [job.target.schema, job.target.table]);
    if (triggerRows[0]) return { status: "failed", affectedRows: 0, code: "DELETE_TRIGGER_BLOCKED", targetIdentity: identityForJob(job) };
    const [cascadeRows] = await connection.query<Record<string, unknown>[]>("SELECT 1 AS found FROM information_schema.INNODB_FOREIGN WHERE REF_NAME = CONCAT(?, '/', ?) AND (TYPE & 5) <> 0 LIMIT 1", [job.target.schema, job.target.table]);
    if (cascadeRows[0]) return { status: "failed", affectedRows: 0, code: "DELETE_CASCADE_BLOCKED", targetIdentity: identityForJob(job) };
    const deletion = buildMysqlDelete(job);
    const [deleted] = await connection.query<Record<string, unknown>>(deletion.sql, deletion.values);
    const count = affectedRows(deleted);
    if (count !== 1) throw new Error(count === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
    return { status: "applied", affectedRows: 1, targetIdentity: identityForJob(job), beforeDigest, tombstoneDigest: digest({ identity: identityForJob(job), expected: job.conflict_guard }) };
  }
  const update = buildMysqlUpdate(job);
  const [applied] = await connection.query<Record<string, unknown>>(update.sql, update.values);
  const count = affectedRows(applied);
  if (count !== 1) throw new Error(count === 0 ? "VERSION_CONFLICT" : "MULTI_ROW_WRITE_BLOCKED");
  let resultVersion: string | number | boolean | null | undefined;
  if (job.protocol_version === "2.0" && job.version_advance) {
    const [rows] = await connection.query<Record<string, unknown>[]>(`SELECT ${quoteMysqlIdentifier(job.version_advance.column)} AS __synapsor_result_version FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} WHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ? AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ? FOR UPDATE`, [job.target.primary_key.value, job.target.tenant_guard.value]);
    resultVersion = rows[0]?.__synapsor_result_version == null ? undefined : scalar(rows[0].__synapsor_result_version);
    verifyVersionAdvanced(job, resultVersion);
  }
  return { status: "applied", affectedRows: 1, targetIdentity: identityForJob(job), resultVersion, beforeDigest, afterDigest: digest({ identity: identityForJob(job), patch: job.patch, version: resultVersion }) };
}

function validateSetJob(job: SetWritebackJob): void {
  assertFrozenSetJobIntegrity(job);
  if (job.frozen_set.row_count !== job.frozen_set.members.length || job.frozen_set.row_count > job.frozen_set.max_rows || job.frozen_set.max_rows > 100) throw new Error("SET_ROW_CAP_EXCEEDED");
  if (job.operation === "set_update") {
    validatePatch(job, "mysql");
    if (!job.version_advance || job.version_advance.strategy !== "integer_increment") throw new Error("SET_INTEGER_VERSION_REQUIRED");
    for (const member of job.frozen_set.members) if (!member.expected_version || member.expected_version.column !== job.version_advance.column) throw new Error("SET_VERSION_GUARD_REQUIRED");
  } else if (job.operation === "set_delete") {
    if (job.allowed_columns.length || Object.keys(job.patch).length) throw new Error("SET_DELETE_PATCH_FORBIDDEN");
    for (const member of job.frozen_set.members) if (!member.expected_version) throw new Error("SET_VERSION_GUARD_REQUIRED");
  } else {
    for (const member of job.frozen_set.members) {
      if (!member.deduplication?.components.length) throw new Error("BATCH_DEDUP_REQUIRED");
      validateBatchInsertMember(job, member);
    }
  }
}

async function mutateMysqlSet(job: SetWritebackJob, connection: MysqlApplyConnection): Promise<MutationOutcome> {
  validateSetJob(job);
  if (job.operation === "batch_insert") return await insertMysqlBatch(job, connection);
  const locked = await lockMysqlFrozenMembers(job, connection);
  if (!locked) return { status: "conflict", affectedRows: 0, code: "SET_DRIFT_CONFLICT", targetIdentity: identityForJob(job) };
  if (job.operation === "set_delete") {
    const safetyCode = await mysqlDeleteSafetyCode(job, connection);
    if (safetyCode) return { status: "failed", affectedRows: 0, code: safetyCode, targetIdentity: identityForJob(job) };
  }
  const memberEffects: NonNullable<MutationOutcome["memberEffects"]> = [];
  for (const member of job.frozen_set.members) {
    const expected = member.expected_version!;
    if (job.operation === "set_update") {
      const assignments = Object.keys(job.patch).map((column) => `${quoteMysqlIdentifier(column)} = ?`);
      assignments.push(`${quoteMysqlIdentifier(job.version_advance!.column)} = ${quoteMysqlIdentifier(job.version_advance!.column)} + 1`);
      const [updated] = await connection.query<Record<string, unknown>>(
        `UPDATE ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} SET ${assignments.join(", ")} WHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ? AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ? AND ${quoteMysqlIdentifier(expected.column)} = ?`,
        [...Object.values(job.patch), member.primary_key.value, job.target.tenant_guard.value, expected.value],
      );
      if (affectedRows(updated) !== 1) throw new Error("SET_ATOMICITY_VIOLATION");
      memberEffects.push({ primary_key: member.primary_key, before_digest: member.before_digest, after_digest: member.after_digest });
    } else {
      const [deleted] = await connection.query<Record<string, unknown>>(
        `DELETE FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} WHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ? AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ? AND ${quoteMysqlIdentifier(expected.column)} = ?`,
        [member.primary_key.value, job.target.tenant_guard.value, expected.value],
      );
      if (affectedRows(deleted) !== 1) throw new Error("SET_ATOMICITY_VIOLATION");
      memberEffects.push({ primary_key: member.primary_key, before_digest: member.before_digest, tombstone_digest: member.tombstone_digest });
    }
  }
  return { status: "applied", affectedRows: job.frozen_set.row_count, targetIdentity: identityForJob(job), memberEffects };
}

async function lockMysqlFrozenMembers(job: SetWritebackJob, connection: MysqlApplyConnection): Promise<boolean> {
  const columns = new Set<string>([job.target.primary_key.column]);
  for (const member of job.frozen_set.members) for (const column of Object.keys(member.before)) columns.add(column);
  const [rows] = await connection.query<Record<string, unknown>[]>(
    `SELECT ${[...columns].map(quoteMysqlIdentifier).join(", ")} FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} WHERE ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ? AND ${quoteMysqlIdentifier(job.target.primary_key.column)} IN (${job.frozen_set.members.map(() => "?").join(", ")}) ORDER BY ${quoteMysqlIdentifier(job.target.primary_key.column)} ASC FOR UPDATE`,
    [job.target.tenant_guard.value, ...job.frozen_set.members.map((member) => member.primary_key.value)],
  );
  if (rows.length !== job.frozen_set.row_count) return false;
  const byIdentity = new Map(rows.map((row) => [JSON.stringify(scalar(row[job.target.primary_key.column])), row]));
  return job.frozen_set.members.every((member) => {
    const row = byIdentity.get(JSON.stringify(member.primary_key.value));
    return row !== undefined && Object.entries(member.before).every(([column, value]) => versionValuesMatch(row[column], value));
  });
}

async function mysqlDeleteSafetyCode(job: SetWritebackJob, connection: MysqlApplyConnection): Promise<string | undefined> {
  const [visibilityRows] = await connection.query<Record<string, unknown>[]>(`SELECT (
  EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND PRIVILEGE_TYPE = 'TRIGGER')
  OR EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND TABLE_SCHEMA = ? AND PRIVILEGE_TYPE = 'TRIGGER')
  OR EXISTS (SELECT 1 FROM information_schema.TABLE_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PRIVILEGE_TYPE = 'TRIGGER')
) AS has_trigger_visibility,
EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE REPLACE(GRANTEE, CHAR(39), '') = CURRENT_USER() AND PRIVILEGE_TYPE = 'PROCESS') AS has_fk_visibility`, [job.target.schema, job.target.schema, job.target.table]);
  if (!(visibilityRows[0]?.has_trigger_visibility === true || Number(visibilityRows[0]?.has_trigger_visibility) === 1)) return "DELETE_TRIGGER_VISIBILITY_REQUIRED";
  if (!(visibilityRows[0]?.has_fk_visibility === true || Number(visibilityRows[0]?.has_fk_visibility) === 1)) return "DELETE_FK_VISIBILITY_REQUIRED";
  const [triggerRows] = await connection.query<Record<string, unknown>[]>("SELECT 1 AS found FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? LIMIT 1", [job.target.schema, job.target.table]);
  if (triggerRows[0]) return "DELETE_TRIGGER_BLOCKED";
  const [cascadeRows] = await connection.query<Record<string, unknown>[]>("SELECT 1 AS found FROM information_schema.INNODB_FOREIGN WHERE REF_NAME = CONCAT(?, '/', ?) AND (TYPE & 5) <> 0 LIMIT 1", [job.target.schema, job.target.table]);
  if (cascadeRows[0]) return "DELETE_CASCADE_BLOCKED";
  return undefined;
}

function validateBatchInsertMember(job: SetWritebackJob, member: SetWritebackJob["frozen_set"]["members"][number]): void {
  const dedupColumns = new Set(member.deduplication?.components.map((component) => component.column));
  for (const column of Object.keys(member.after)) if (!job.allowed_columns.includes(column) && !dedupColumns.has(column)) throw new Error("BATCH_COLUMN_NOT_ALLOWED");
  if (!dedupColumns.has(job.target.primary_key.column) || !dedupColumns.has(job.target.tenant_guard.column)) throw new Error("BATCH_DEDUP_REQUIRED");
}

async function insertMysqlBatch(job: SetWritebackJob, connection: MysqlApplyConnection): Promise<MutationOutcome> {
  for (const member of job.frozen_set.members) {
    const components = member.deduplication!.components;
    const [existing] = await connection.query<Record<string, unknown>[]>(
      `SELECT 1 AS found FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} WHERE ${components.map((component) => `${quoteMysqlIdentifier(component.column)} = ?`).join(" AND ")} LIMIT 1 FOR UPDATE`,
      components.map((component) => component.value),
    );
    if (existing[0]) return { status: "conflict", affectedRows: 0, code: "INSERT_DEDUP_CONFLICT", targetIdentity: identityForJob(job) };
  }
  const memberEffects: NonNullable<MutationOutcome["memberEffects"]> = [];
  for (const member of job.frozen_set.members) {
    const columns = Object.keys(member.after);
    const [inserted] = await connection.query<Record<string, unknown>>(
      `INSERT INTO ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} (${columns.map(quoteMysqlIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => member.after[column]),
    );
    if (affectedRows(inserted) !== 1) throw new Error("SET_ATOMICITY_VIOLATION");
    memberEffects.push({ primary_key: member.primary_key, after_digest: member.after_digest });
  }
  return { status: "applied", affectedRows: job.frozen_set.row_count, targetIdentity: identityForJob(job), memberEffects };
}

async function lockTargetRow(job: WritebackJob, connection: MysqlApplyConnection): Promise<Record<string, unknown> | undefined> {
  if (job.target.primary_key.value === undefined) return undefined;
  const projection = [
    `${quoteMysqlIdentifier(job.target.primary_key.column)} AS __synapsor_primary_key`,
    ...(job.conflict_guard.kind === "version_column"
      ? [`${quoteMysqlIdentifier(job.conflict_guard.column)} AS __synapsor_conflict_value`]
      : []),
  ].join(", ");
  const [rows] = await connection.query<Record<string, unknown>[]>(`SELECT ${projection} FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)}\nWHERE ${quoteMysqlIdentifier(job.target.primary_key.column)} = ?\n  AND ${quoteMysqlIdentifier(job.target.tenant_guard.column)} = ?\nFOR UPDATE`, [job.target.primary_key.value, job.target.tenant_guard.value]);
  return rows[0];
}

async function insertMysql(job: WritebackJob, connection: MysqlApplyConnection): Promise<MutationOutcome> {
  if (job.protocol_version !== "2.0" || !job.deduplication) throw new Error("INSERT_DEDUP_REQUIRED");
  const components = job.deduplication.components;
  const [existing] = await connection.query<Record<string, unknown>[]>(`SELECT ${quoteMysqlIdentifier(job.target.primary_key.column)} AS __synapsor_primary_key FROM ${quoteMysqlIdentifier(job.target.schema)}.${quoteMysqlIdentifier(job.target.table)} WHERE ${components.map((component) => `${quoteMysqlIdentifier(component.column)} = ?`).join(" AND ")}`, components.map((component) => component.value));
  if (existing[0]) return { status: "conflict", affectedRows: 0, code: "INSERT_DEDUP_CONFLICT", targetIdentity: identityForJob(job, existing[0].__synapsor_primary_key) };
  const insertion = buildMysqlInsert(job);
  const [inserted] = await connection.query<Record<string, unknown>>(insertion.sql, insertion.values);
  const count = affectedRows(inserted);
  if (count !== 1) throw new Error(count === 0 ? "INSERT_CONSTRAINT_FAILED" : "MULTI_ROW_WRITE_BLOCKED");
  const identity = identityForJob(job, inserted.insertId);
  return { status: "applied", affectedRows: 1, targetIdentity: identity, afterDigest: digest({ identity, values: insertValues(job) }) };
}

function affectedRows(result: unknown): number {
  return result && typeof result === "object" && "affectedRows" in result ? Number((result as { affectedRows?: unknown }).affectedRows ?? 0) : 0;
}

function verifyVersionAdvanced(job: WritebackJob, actual: unknown): void {
  if (job.protocol_version !== "2.0" || job.operation !== "single_row_update" || !job.version_advance) return;
  if (actual === undefined || job.conflict_guard.kind !== "version_column") throw new Error("VERSION_DID_NOT_ADVANCE");
  if (job.version_advance.strategy === "integer_increment") {
    if (typeof job.conflict_guard.expected_value !== "number" || Number(actual) !== job.conflict_guard.expected_value + 1) throw new Error("VERSION_DID_NOT_ADVANCE");
  } else if (versionValuesMatch(actual, job.conflict_guard.expected_value)) throw new Error("VERSION_DID_NOT_ADVANCE");
}

async function claimSourceReceipt(connection: MysqlApplyConnection, job: WritebackJob, config: RunnerConfig): Promise<WritebackResult | undefined> {
  const table = sourceReceiptTable(config);
  const [claim] = await connection.query<Record<string, unknown>>(`INSERT IGNORE INTO ${table} (idempotency_key, job_id, proposal_id, status, result_hash) VALUES (?, ?, ?, 'in_progress', NULL)`, [job.idempotency_key, job.job_id, job.proposal_id]);
  if (affectedRows(claim) === 1) return undefined;
  const [rows] = await connection.query<Record<string, unknown>[]>(`SELECT status, result_hash FROM ${table} WHERE idempotency_key = ? FOR UPDATE`, [job.idempotency_key]);
  if (!rows[0]) return failedResult(job, config, "SOURCE_RECEIPT_UNAVAILABLE");
  return resultFromExistingReceipt(job, config, rows[0].status, rows[0].result_hash);
}

async function recordSourceReceipt(connection: MysqlApplyConnection, job: WritebackJob, config: RunnerConfig, status: string, hash: string): Promise<void> {
  const [result] = await connection.query<Record<string, unknown>>(`UPDATE ${sourceReceiptTable(config)} SET status = ?, result_hash = ?, completed_at = CURRENT_TIMESTAMP WHERE idempotency_key = ?`, [status, hash, job.idempotency_key]);
  if (affectedRows(result) !== 1) throw new Error("SOURCE_RECEIPT_UNAVAILABLE");
}

function resultFromExistingReceipt(job: WritebackJob, config: RunnerConfig, status: unknown, hash: unknown): WritebackResult {
  const resultHashValue = typeof hash === "string" && hash ? hash as `sha256:${string}` : resultHash(job, "idempotent");
  if (status === "applied" || status === "already_applied") return resultFromOutcome(job, config, { status: "already_applied", affectedRows: 0, targetIdentity: identityForJob(job) }, undefined, resultHashValue);
  if (status === "conflict") return resultFromOutcome(job, config, { status: "conflict", affectedRows: 0, code: "IDEMPOTENT_CONFLICT", targetIdentity: identityForJob(job) }, undefined, resultHashValue);
  if (status === "failed") return failedResult(job, config, "IDEMPOTENT_FAILED");
  return failedResult(job, config, "SOURCE_RECEIPT_UNAVAILABLE");
}

function resultFromOutcome(job: WritebackJob, config: RunnerConfig, outcome: MutationOutcome, overrideCode?: string, overrideHash?: `sha256:${string}`): WritebackResult {
  const hash = overrideHash ?? resultHash(job, outcome.status, outcome.resultVersion);
  if (job.protocol_version === "3.0") return { protocol_version: "3.0", job_id: job.job_id, runner_id: config.runnerId, operation: job.operation, receipt_authority: receiptAuthority(config), status: outcome.status, affected_rows: outcome.affectedRows, target_identities: identityForJob(job), set_digest: job.frozen_set.set_digest, member_effects: outcome.memberEffects ?? [], result_hash: hash, error_code: outcome.code ?? overrideCode, completed_at: new Date().toISOString() };
  if (job.protocol_version !== "2.0") return { protocol_version: "1.0", job_id: job.job_id, runner_id: config.runnerId, status: outcome.status, affected_rows: outcome.affectedRows, result_version: outcome.resultVersion == null ? undefined : String(outcome.resultVersion), result_hash: hash, error_code: outcome.code ?? overrideCode, completed_at: new Date().toISOString() };
  return { protocol_version: "2.0", job_id: job.job_id, runner_id: config.runnerId, operation: job.operation, receipt_authority: receiptAuthority(config), status: outcome.status, affected_rows: outcome.affectedRows, target_identity: outcome.targetIdentity, result_version: outcome.resultVersion, before_digest: outcome.beforeDigest, after_digest: outcome.afterDigest, tombstone_digest: outcome.tombstoneDigest, result_hash: hash, error_code: outcome.code ?? overrideCode, completed_at: new Date().toISOString() };
}
function failedResult(job: WritebackJob, config: RunnerConfig, code: string): WritebackResult { return resultFromOutcome(job, config, { status: "failed", affectedRows: 0, code, targetIdentity: identityForJob(job) }); }
function reconciliationResult(job: WritebackJob, config: RunnerConfig, intentId: string): WritebackResult {
  if (job.protocol_version === "3.0") return { protocol_version: "3.0", job_id: job.job_id, runner_id: config.runnerId, operation: job.operation, receipt_authority: "runner_ledger", status: "reconciliation_required", affected_rows: 0, target_identities: identityForJob(job), set_digest: job.frozen_set.set_digest, member_effects: [], result_hash: resultHash(job, "reconciliation_required"), error_code: "RECONCILIATION_REQUIRED", intent_id: intentId, completed_at: new Date().toISOString() };
  if (job.protocol_version !== "2.0") return failedResult(job, config, "RECONCILIATION_REQUIRED");
  return { protocol_version: "2.0", job_id: job.job_id, runner_id: config.runnerId, operation: job.operation, receipt_authority: "runner_ledger", status: "reconciliation_required", affected_rows: 0, target_identity: identityForJob(job), result_hash: resultHash(job, "reconciliation_required"), error_code: "RECONCILIATION_REQUIRED", intent_id: intentId, completed_at: new Date().toISOString() };
}
function asAlreadyApplied(result: WritebackResult, job: WritebackJob, config: RunnerConfig): WritebackResult {
  if (result.status !== "applied" && result.status !== "already_applied") return result;
  return resultFromOutcome(job, config, { status: "already_applied", affectedRows: 0, targetIdentity: identityForJob(job), resultVersion: result.result_version }, undefined, result.result_hash as `sha256:${string}` | undefined);
}
function resultHashFromResult(job: WritebackJob, result: WritebackResult): `sha256:${string}` { return typeof result.result_hash === "string" && result.result_hash.startsWith("sha256:") ? result.result_hash as `sha256:${string}` : resultHash(job, result.status, result.result_version); }
function safeErrorCode(error: unknown): string {
  if (error instanceof SourceOutcomeUnknownError) return "OUTCOME_UNKNOWN";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ER_DUP_ENTRY" || code === "1062") return "INSERT_DEDUP_CONFLICT";
  for (const known of ["MULTI_ROW_WRITE_BLOCKED", "VERSION_CONFLICT", "VERSION_DID_NOT_ADVANCE", "INSERT_DEDUP_CONFLICT", "INSERT_CONSTRAINT_FAILED", "DELETE_CASCADE_BLOCKED", "DELETE_TRIGGER_BLOCKED", "DELETE_TRIGGER_VISIBILITY_REQUIRED", "DELETE_FK_VISIBILITY_REQUIRED", "SOURCE_RECEIPT_UNAVAILABLE", "RUNNER_LEDGER_UNAVAILABLE", "SET_ROW_CAP_EXCEEDED", "SET_IDENTITY_NOT_UNIQUE", "SET_IDENTITY_ORDER_INVALID", "SET_PRIMARY_KEY_MISMATCH", "SET_VERSION_GUARD_REQUIRED", "SET_VERSION_GUARD_MISMATCH", "SET_TENANT_GUARD_MISMATCH", "SET_AFTER_STATE_MISMATCH", "SET_BEFORE_DIGEST_MISMATCH", "SET_AFTER_DIGEST_MISMATCH", "SET_TOMBSTONE_DIGEST_MISMATCH", "SET_AGGREGATE_BOUND_MISMATCH", "SET_AGGREGATE_VALUE_INVALID", "SET_DIGEST_MISMATCH", "SET_ATOMICITY_VIOLATION", "SET_DRIFT_CONFLICT", "BATCH_DEDUP_REQUIRED", "BATCH_IDENTITY_MISMATCH", "BATCH_COLUMN_NOT_ALLOWED"]) if (message.includes(known)) return known;
  return "TRANSACTION_FAILED";
}

export const mysqlAdapter: ApplyAdapter = {
  async doctor(config) {
    if (!config.databaseUrl) return { ok: false, details: { error: "database URL required; local config apply reads source.write_url_env, legacy workers use SYNAPSOR_DATABASE_URL" } };
    const connection = await mysql.createConnection({ uri: config.databaseUrl, dateStrings: true });
    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
      if (receiptAuthority(config) === "source_db") {
        if (config.receipts?.provisioning === "auto_migrate") await connection.query(mysqlReceiptMigrationForConfig(config));
        await connection.beginTransaction();
        try {
          const doctorId = `doctor-${Date.now()}`;
          const receiptTable = sourceReceiptTable(config);
          await connection.query(`SELECT idempotency_key, status FROM ${receiptTable} WHERE 1 = 0`);
          await connection.query(`INSERT INTO ${receiptTable} (idempotency_key, job_id, proposal_id, status, result_hash, completed_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [doctorId, doctorId, "doctor", "doctor", "sha256:doctor"]);
          const [updated] = await connection.query<mysql.ResultSetHeader>(`UPDATE ${receiptTable} SET status = ? WHERE idempotency_key = ?`, ["doctor_updated", doctorId]);
          if (affectedRows(updated) !== 1) throw new Error("SOURCE_RECEIPT_UNAVAILABLE");
          await connection.rollback();
        } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      }
      return { ok: true, details: { version: rows[0]?.version, receipt_authority: receiptAuthority(config), receipt_provisioning: receiptAuthority(config) === "source_db" ? (config.receipts?.provisioning ?? "precreated") : "not_applicable", receipt_table: receiptAuthority(config) === "source_db" ? "ready" : "not_used", receipt_permissions: receiptAuthority(config) === "source_db" ? "select_insert_update_rollback_verified" : "no_source_receipt_access", write_permission_rollback: true, dry_run: config.dryRun } };
    } finally { await connection.end(); }
  },
  apply: applyMysqlJob,
};
