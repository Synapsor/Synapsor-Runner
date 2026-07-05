import crypto from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";

export type Scalar = string | number | boolean | null;
export type HandlerReceiptStatus = "applied" | "already_applied" | "conflict" | "failed";

export type HandlerReceipt = {
  status: HandlerReceiptStatus;
  rows_affected: number;
  source_database_mutated: boolean;
  previous_version?: Scalar;
  new_version?: Scalar;
  safe_error_code?: string | null;
  details?: Record<string, unknown>;
};

export type HandlerJob = {
  protocolVersion: string;
  proposalId: string;
  idempotencyKey: string;
  issuedAt?: string;
  action: string;
  tenantId: string;
  objectId: string;
  principal: string;
  target: {
    schema: string;
    table: string;
    primaryKey: { column: string; value: Scalar };
  };
  tenantGuard: { column: string; value: Scalar };
  expectedVersion: { column: string; value: Scalar };
  patch: Record<string, Scalar>;
  row: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type HandlerEffects = {
  rowsAffected?: number;
  newVersion?: Scalar;
  effects?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
};

export type HandlerTx = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  insert(table: string, values: Record<string, Scalar>, options?: { schema?: string; returning?: string[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  update(table: string, where: Record<string, Scalar>, values: Record<string, Scalar>, options?: { schema?: string; returning?: string[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
};

export type WritebackHandlerTransaction = HandlerTx & {
  findReceipt(idempotencyKey: string): Promise<HandlerReceipt | undefined>;
  lockTarget(job: Omit<HandlerJob, "row">): Promise<Record<string, unknown> | undefined>;
  recordReceipt(job: Omit<HandlerJob, "row">, receipt: HandlerReceipt): Promise<void>;
};

export type WritebackHandlerDatabase = {
  withTransaction<T>(fn: (tx: WritebackHandlerTransaction) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
};

export type CreateWritebackHandlerOptions = {
  tokenEnv?: string;
  signingSecretEnv?: string;
  issuedAtSkewMs?: number;
  env?: NodeJS.ProcessEnv;
  source?: {
    engine: "postgres";
    writeUrlEnv: string;
    receiptTable?: { schema?: string; table?: string };
  };
  database?: WritebackHandlerDatabase;
  capabilities: Record<string, (job: HandlerJob, tx: HandlerTx) => Promise<HandlerEffects | void>>;
};

export type WritebackHttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const safeIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const appHandlerRequestV1Schema = z.object({
  protocol_version: z.string().optional(),
  schema_version: z.string().optional(),
  proposal_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  issued_at: z.string().optional(),
  signature: z.string().optional(),
}).passthrough();

export const appHandlerReceiptV1Schema = z.object({
  status: z.enum(["applied", "already_applied", "conflict", "failed"]),
  rows_affected: z.number().int().nonnegative().default(0),
  source_database_mutated: z.boolean().default(false),
  previous_version: scalarSchema.optional(),
  new_version: scalarSchema.optional(),
  safe_error_code: z.string().nullable().optional(),
  details: z.record(z.unknown()).optional(),
});

export function createWritebackHandler(options: CreateWritebackHandlerOptions): WritebackHttpHandler {
  const database = options.database ?? createConfiguredDatabase(options);
  return async (request, response) => {
    const result = await handleWritebackHttpRequest(request, options, database);
    response.statusCode = result.statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(result.receipt, null, 2)}\n`);
  };
}

export async function handleWritebackHttpRequest(
  request: IncomingMessage,
  options: CreateWritebackHandlerOptions,
  database: WritebackHandlerDatabase = options.database ?? createConfiguredDatabase(options),
): Promise<{ statusCode: number; receipt: HandlerReceipt }> {
  try {
    if (request.method && request.method !== "POST") {
      return { statusCode: 405, receipt: failedReceipt("METHOD_NOT_ALLOWED") };
    }
    const rawBody = await readRawBody(request);
    const auth = verifyRequestAuth({
      headers: request.headers,
      rawBody,
      options,
    });
    if (!auth.ok) return auth;
    let body: unknown;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      return { statusCode: 400, receipt: failedReceipt("BAD_JSON") };
    }
    const parsed = appHandlerRequestV1Schema.safeParse(body);
    if (!parsed.success) {
      return { statusCode: 400, receipt: failedReceipt("BAD_WRITEBACK_REQUEST") };
    }
    let baseJob: Omit<HandlerJob, "row">;
    try {
      baseJob = normalizeHandlerJob(parsed.data);
      if (!supportedProtocolVersion(baseJob.protocolVersion)) {
        return { statusCode: 400, receipt: failedReceipt("UNSUPPORTED_PROTOCOL_VERSION") };
      }
    } catch {
      return { statusCode: 400, receipt: failedReceipt("BAD_WRITEBACK_REQUEST") };
    }
    const apply = options.capabilities[baseJob.action];
    if (!apply) {
      return { statusCode: 400, receipt: failedReceipt("UNSUPPORTED_ACTION") };
    }

    const receipt = await database.withTransaction(async (tx) => {
      const duplicate = await tx.findReceipt(baseJob.idempotencyKey);
      if (duplicate?.status === "applied" || duplicate?.status === "already_applied") {
        return {
          ...duplicate,
          status: "already_applied" as const,
          rows_affected: 0,
          source_database_mutated: false,
        };
      }
      const row = await tx.lockTarget(baseJob);
      if (!row) {
        const conflict = conflictReceipt("ROW_NOT_FOUND_OR_WRONG_TENANT");
        await tx.recordReceipt(baseJob, conflict);
        return conflict;
      }
      const currentVersion = row[baseJob.expectedVersion.column];
      if (!versionValuesMatch(currentVersion, baseJob.expectedVersion.value)) {
        const conflict = conflictReceipt("ROW_CHANGED_AFTER_PROPOSAL", scalarOrNull(currentVersion));
        await tx.recordReceipt(baseJob, conflict);
        return conflict;
      }
      const job: HandlerJob = { ...baseJob, row };
      const effects = await apply(job, tx).catch(() => {
        throw new SafeHandlerError("HANDLER_BUSINESS_ERROR");
      });
      const receipt = appliedReceipt(job, effects);
      await tx.recordReceipt(job, receipt);
      return receipt;
    });
    return { statusCode: receipt.status === "failed" ? 500 : 200, receipt };
  } catch (error) {
    return {
      statusCode: 500,
      receipt: failedReceipt(error instanceof SafeHandlerError ? error.code : "HANDLER_EXCEPTION"),
    };
  }
}

class SafeHandlerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function supportedProtocolVersion(value: string): boolean {
  return value === "1.0" || value === "synapsor.handler-writeback.v1";
}

function createConfiguredDatabase(options: CreateWritebackHandlerOptions): WritebackHandlerDatabase {
  if (!options.source) throw new Error("createWritebackHandler requires source or database");
  if (options.source.engine !== "postgres") throw new Error("Only postgres app-owned handler helper source is implemented in this alpha");
  const env = options.env ?? process.env;
  const writeUrl = env[options.source.writeUrlEnv];
  if (!writeUrl) throw new Error(`${options.source.writeUrlEnv} is not set`);
  return new PostgresWritebackHandlerDatabase(writeUrl, options.source.receiptTable);
}

export class PostgresWritebackHandlerDatabase implements WritebackHandlerDatabase {
  private readonly pool: Pool;
  private readonly receiptSchema: string;
  private readonly receiptTable: string;

  constructor(connectionString: string, receiptTable?: { schema?: string; table?: string }) {
    this.pool = new Pool({ connectionString });
    this.receiptSchema = receiptTable?.schema ?? "public";
    this.receiptTable = receiptTable?.table ?? "synapsor_handler_receipts";
  }

  async withTransaction<T>(fn: (tx: WritebackHandlerTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresWritebackHandlerTransaction(client, this.receiptSchema, this.receiptTable);
      await tx.ensureReceiptTable();
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresWritebackHandlerTransaction implements WritebackHandlerTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly receiptSchema: string,
    private readonly receiptTable: string,
  ) {}

  async ensureReceiptTable(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.receiptTableName()} (
        idempotency_key text PRIMARY KEY,
        proposal_id text NOT NULL,
        action text NOT NULL,
        status text NOT NULL,
        receipt_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.client.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async insert(table: string, values: Record<string, Scalar>, options: { schema?: string; returning?: string[] } = {}): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("insert values must not be empty");
    const columns = entries.map(([column]) => quoteIdentifier(column));
    const params = entries.map((_, index) => `$${index + 1}`);
    const returning = options.returning?.length ? ` RETURNING ${options.returning.map(quoteIdentifier).join(", ")}` : "";
    const result = await this.client.query(
      `INSERT INTO ${qualifiedName(options.schema ?? "public", table)} (${columns.join(", ")}) VALUES (${params.join(", ")})${returning}`,
      entries.map(([, value]) => value),
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async update(table: string, where: Record<string, Scalar>, values: Record<string, Scalar>, options: { schema?: string; returning?: string[] } = {}): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const valueEntries = Object.entries(values);
    const whereEntries = Object.entries(where);
    if (!valueEntries.length) throw new Error("update values must not be empty");
    if (!whereEntries.length) throw new Error("update where must not be empty");
    const params: unknown[] = [];
    const set = valueEntries.map(([column, value]) => {
      params.push(value);
      return `${quoteIdentifier(column)} = $${params.length}`;
    });
    const clauses = whereEntries.map(([column, value]) => {
      params.push(value);
      return `${quoteIdentifier(column)} = $${params.length}`;
    });
    const returning = options.returning?.length ? ` RETURNING ${options.returning.map(quoteIdentifier).join(", ")}` : "";
    const result = await this.client.query(
      `UPDATE ${qualifiedName(options.schema ?? "public", table)} SET ${set.join(", ")} WHERE ${clauses.join(" AND ")}${returning}`,
      params,
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async findReceipt(idempotencyKey: string): Promise<HandlerReceipt | undefined> {
    const result = await this.client.query(
      `SELECT receipt_json FROM ${this.receiptTableName()} WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    );
    const raw = result.rows[0]?.receipt_json;
    return isRecord(raw) ? coerceReceipt(raw) : undefined;
  }

  async lockTarget(job: Omit<HandlerJob, "row">): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.query(
      `SELECT * FROM ${qualifiedName(job.target.schema, job.target.table)}
       WHERE ${quoteIdentifier(job.target.primaryKey.column)} = $1
         AND ${quoteIdentifier(job.tenantGuard.column)} = $2
       FOR UPDATE`,
      [job.target.primaryKey.value, job.tenantGuard.value],
    );
    return result.rows[0];
  }

  async recordReceipt(job: Omit<HandlerJob, "row">, receipt: HandlerReceipt): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.receiptTableName()} (idempotency_key, proposal_id, action, status, receipt_json, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (idempotency_key)
       DO UPDATE SET status = EXCLUDED.status, receipt_json = EXCLUDED.receipt_json, completed_at = EXCLUDED.completed_at`,
      [job.idempotencyKey, job.proposalId, job.action, receipt.status, JSON.stringify(receipt)],
    );
  }

  private receiptTableName(): string {
    return qualifiedName(this.receiptSchema, this.receiptTable);
  }
}

function normalizeHandlerJob(request: Record<string, unknown>): Omit<HandlerJob, "row"> {
  const changeSet = isRecord(request.change_set) ? request.change_set : request;
  const source = isRecord(changeSet.source) ? changeSet.source : {};
  const target = isRecord(changeSet.target) ? changeSet.target : source;
  const guards = isRecord(changeSet.guards) ? changeSet.guards : {};
  const scope = isRecord(changeSet.scope) ? changeSet.scope : {};
  const principal = isRecord(changeSet.principal) ? changeSet.principal : {};
  const primaryKey = isRecord(target.primary_key) ? target.primary_key : isRecord(source.primary_key) ? source.primary_key : {};
  const tenantGuard = isRecord(guards.tenant) ? guards.tenant : isRecord(changeSet.tenant_guard) ? changeSet.tenant_guard : {};
  const expectedVersion = isRecord(guards.expected_version) ? guards.expected_version : {};
  const patch = scalarRecord(changeSet.patch);
  const action = stringValue(changeSet.action ?? request.action, "action");
  const schema = safeIdentifierValue(target.schema ?? source.schema, "target.schema");
  const table = safeIdentifierValue(target.table ?? source.table, "target.table");
  const primaryKeyColumn = safeIdentifierValue(primaryKey.column, "target.primary_key.column");
  const primaryKeyValue = scalarValue(primaryKey.value ?? scope.object_id, "target.primary_key.value");
  const tenantColumn = safeIdentifierValue(tenantGuard.column, "guards.tenant.column");
  const tenantValue = scalarValue(tenantGuard.value ?? scope.tenant_id, "guards.tenant.value");
  const expectedColumn = safeIdentifierValue(expectedVersion.column, "guards.expected_version.column");
  const expectedValue = scalarValue(expectedVersion.value, "guards.expected_version.value");
  return {
    protocolVersion: String(request.protocol_version ?? request.schema_version ?? "1.0"),
    proposalId: stringValue(request.proposal_id, "proposal_id"),
    idempotencyKey: stringValue(request.idempotency_key, "idempotency_key"),
    issuedAt: typeof request.issued_at === "string" ? request.issued_at : undefined,
    action,
    tenantId: String(tenantValue),
    objectId: String(primaryKeyValue),
    principal: String(principal.id ?? changeSet.runner_hint ?? "approved_operator"),
    target: {
      schema,
      table,
      primaryKey: { column: primaryKeyColumn, value: primaryKeyValue },
    },
    tenantGuard: { column: tenantColumn, value: tenantValue },
    expectedVersion: { column: expectedColumn, value: expectedValue },
    patch,
    raw: request,
  };
}

function verifyRequestAuth(input: {
  headers: IncomingHttpHeaders;
  rawBody: string;
  options: CreateWritebackHandlerOptions;
}): { ok: true } | { ok: false; statusCode: number; receipt: HandlerReceipt } {
  const env = input.options.env ?? process.env;
  const tokenEnv = input.options.tokenEnv;
  if (tokenEnv) {
    const expected = env[tokenEnv];
    if (!expected) return { ok: false, statusCode: 500, receipt: failedReceipt("HANDLER_TOKEN_MISSING") };
    if (!validBearer(input.headers.authorization, expected)) {
      return { ok: false, statusCode: 401, receipt: failedReceipt("UNAUTHORIZED") };
    }
  }
  const signingSecretEnv = input.options.signingSecretEnv;
  if (signingSecretEnv) {
    const secret = env[signingSecretEnv];
    if (!secret) return { ok: false, statusCode: 500, receipt: failedReceipt("HANDLER_SIGNING_SECRET_MISSING") };
    const signature = headerValue(input.headers["x-synapsor-signature"]);
    const issuedAt = headerValue(input.headers["x-synapsor-issued-at"]);
    if (!signature || !validSignature(input.rawBody, secret, signature)) {
      return { ok: false, statusCode: 401, receipt: failedReceipt("INVALID_SIGNATURE") };
    }
    if (!issuedAt || !issuedAtWithinSkew(issuedAt, input.options.issuedAtSkewMs ?? 5 * 60 * 1000)) {
      return { ok: false, statusCode: 401, receipt: failedReceipt("INVALID_ISSUED_AT") };
    }
  }
  return { ok: true };
}

function appliedReceipt(job: HandlerJob, effects: HandlerEffects | void): HandlerReceipt {
  const details = {
    ...(effects?.details ?? {}),
    ...(effects?.effects ? { effects: effects.effects } : {}),
  };
  return {
    status: "applied",
    rows_affected: Math.max(1, Number(effects?.rowsAffected ?? effects?.effects?.length ?? 1)),
    previous_version: scalarOrNull(job.row[job.expectedVersion.column]),
    new_version: effects?.newVersion ?? scalarOrNull(job.row[job.expectedVersion.column]),
    source_database_mutated: true,
    safe_error_code: null,
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function conflictReceipt(code: string, previousVersion?: Scalar): HandlerReceipt {
  return {
    status: "conflict",
    rows_affected: 0,
    source_database_mutated: false,
    safe_error_code: code,
    ...(previousVersion !== undefined ? { previous_version: previousVersion } : {}),
  };
}

function failedReceipt(code: string): HandlerReceipt {
  return {
    status: "failed",
    rows_affected: 0,
    source_database_mutated: false,
    safe_error_code: code,
  };
}

function coerceReceipt(value: Record<string, unknown>): HandlerReceipt | undefined {
  const parsed = appHandlerReceiptV1Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function validBearer(header: string | string[] | undefined, expected: string): boolean {
  const value = headerValue(header);
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export function signHandlerRequest(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function validSignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(signHandlerRequest(rawBody, secret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function issuedAtWithinSkew(value: string, skewMs: number): boolean {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  return Math.abs(Date.now() - time) <= skewMs;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("handler body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function scalarRecord(input: unknown): Record<string, Scalar> {
  if (!isRecord(input)) throw new Error("patch must be an object");
  const result: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!safeIdentifier.test(key)) throw new Error(`unsafe patch column: ${key}`);
    result[key] = scalarValue(value, `patch.${key}`);
  }
  if (!Object.keys(result).length) throw new Error("patch must not be empty");
  return result;
}

function scalarValue(value: unknown, name: string): Scalar {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`${name} must be a scalar`);
}

function scalarOrNull(value: unknown): Scalar {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  return String(value);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} must be a non-empty string`);
}

function safeIdentifierValue(value: unknown, name: string): string {
  const text = stringValue(value, name);
  if (!safeIdentifier.test(text)) throw new Error(`${name} must be a safe identifier`);
  return text;
}

function versionValuesMatch(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date) return versionValuesMatch(actual.toISOString(), expected);
  const actualDate = new Date(String(actual));
  const expectedDate = new Date(String(expected));
  if (!Number.isNaN(actualDate.getTime()) && !Number.isNaN(expectedDate.getTime())) {
    return actualDate.getTime() === expectedDate.getTime();
  }
  return String(actual) === String(expected);
}

function quoteIdentifier(identifier: string): string {
  if (!safeIdentifier.test(identifier)) throw new Error(`unsafe postgres identifier: ${identifier}`);
  return `"${identifier}"`;
}

function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
