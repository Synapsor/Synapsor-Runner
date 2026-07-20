import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  handleWritebackHttpRequest,
  PostgresWritebackHandlerDatabase,
  signHandlerRequest,
  type HandlerReceipt,
  type HandlerTx,
  type Scalar,
  type WritebackHandlerDatabase,
  type WritebackHandlerTransaction,
} from "./index.js";

const env = {
  SYNAPSOR_APP_HANDLER_TOKEN: "dev-handler-token",
  SYNAPSOR_APP_HANDLER_SIGNING_SECRET: "dev-signing-secret",
};

describe("app-owned writeback handler helper", () => {
  it("applies a valid signed request and records an atomic receipt", async () => {
    const database = new FakeDatabase();
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, signedHeaders(body)),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: {
          "support.propose_plan_credit": applyCredit,
        },
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.receipt).toMatchObject({
      status: "applied",
      rows_affected: 2,
      source_database_mutated: true,
      previous_version: "2026-05-16T00:00:00.000Z",
      new_version: "2026-06-28T00:00:00.000Z",
      safe_error_code: null,
    });
    expect(database.effects).toEqual([
      { type: "insert", schema: "public", table: "credits", values: expect.objectContaining({ id: "CR-wrp_valid" }) },
      { type: "update", schema: "public", table: "invoices", where: { id: "INV-3001", tenant_id: "tenant_acme" }, values: { credited_cents: 1500, updated_at: "2026-06-28T00:00:00.000Z" } },
    ]);
    expect(database.receipts.get("wrp_valid:INV-3001")?.status).toBe("applied");
  });

  it("rejects a missing bearer token without mutating state", async () => {
    const database = new FakeDatabase();
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, {
        "x-synapsor-signature": signHandlerRequest(body, env.SYNAPSOR_APP_HANDLER_SIGNING_SECRET),
        "x-synapsor-issued-at": new Date().toISOString(),
      }),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: { "support.propose_plan_credit": applyCredit },
      },
    );

    expect(result.statusCode).toBe(401);
    expect(result.receipt).toMatchObject({ status: "failed", safe_error_code: "UNAUTHORIZED" });
    expect(database.effects).toEqual([]);
  });

  it("rejects an invalid HMAC signature without mutating state", async () => {
    const database = new FakeDatabase();
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, {
        authorization: `Bearer ${env.SYNAPSOR_APP_HANDLER_TOKEN}`,
        "x-synapsor-signature": "sha256=bad",
        "x-synapsor-issued-at": new Date().toISOString(),
      }),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: { "support.propose_plan_credit": applyCredit },
      },
    );

    expect(result.statusCode).toBe(401);
    expect(result.receipt).toMatchObject({ status: "failed", safe_error_code: "INVALID_SIGNATURE" });
    expect(database.effects).toEqual([]);
  });

  it("returns a conflict when the source row changed after proposal", async () => {
    const database = new FakeDatabase({
      row: { ...defaultInvoiceRow(), updated_at: "2026-05-17T00:00:00.000Z" },
    });
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, signedHeaders(body)),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: { "support.propose_plan_credit": applyCredit },
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.receipt).toMatchObject({
      status: "conflict",
      rows_affected: 0,
      source_database_mutated: false,
      safe_error_code: "ROW_CHANGED_AFTER_PROPOSAL",
      previous_version: "2026-05-17T00:00:00.000Z",
    });
    expect(database.effects).toEqual([]);
    expect(database.receipts.get("wrp_valid:INV-3001")?.status).toBe("conflict");
  });

  it("does not distinguish missing rows from wrong tenant", async () => {
    const database = new FakeDatabase();
    const body = validBody({ tenantId: "tenant_globex" });
    const result = await handleWritebackHttpRequest(
      request(body, signedHeaders(body)),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: { "support.propose_plan_credit": applyCredit },
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.receipt).toMatchObject({
      status: "conflict",
      source_database_mutated: false,
      safe_error_code: "ROW_NOT_FOUND_OR_WRONG_TENANT",
    });
    expect(database.effects).toEqual([]);
  });

  it("returns already_applied for duplicate idempotency keys", async () => {
    const database = new FakeDatabase();
    const body = validBody();
    const options = {
      tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
      signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
      env,
      database,
      capabilities: { "support.propose_plan_credit": applyCredit },
    };

    await handleWritebackHttpRequest(request(body, signedHeaders(body)), options);
    const afterFirst = database.effects.length;
    const second = await handleWritebackHttpRequest(request(body, signedHeaders(body)), options);

    expect(second.statusCode).toBe(200);
    expect(second.receipt).toMatchObject({
      status: "already_applied",
      rows_affected: 0,
      source_database_mutated: false,
    });
    expect(database.effects).toHaveLength(afterFirst);
  });

  it("rolls back business effects when the handler throws", async () => {
    const database = new FakeDatabase();
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, signedHeaders(body)),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database,
        capabilities: {
          "support.propose_plan_credit": async (job, tx) => {
            await tx.insert("credits", { id: "CR-before-throw", tenant_id: job.tenantId });
            throw new Error("raw driver text should never reach response");
          },
        },
      },
    );

    expect(result.statusCode).toBe(500);
    expect(result.receipt).toMatchObject({
      status: "failed",
      source_database_mutated: false,
      safe_error_code: "HANDLER_BUSINESS_ERROR",
    });
    expect(JSON.stringify(result.receipt)).not.toContain("raw driver text");
    expect(database.effects).toEqual([]);
    expect(database.receipts.size).toBe(0);
  });

  it("does not leak raw database errors", async () => {
    const body = validBody();
    const result = await handleWritebackHttpRequest(
      request(body, signedHeaders(body)),
      {
        tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
        signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
        env,
        database: {
          async withTransaction() {
            throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
          },
        },
        capabilities: { "support.propose_plan_credit": applyCredit },
      },
    );

    expect(result.statusCode).toBe(500);
    expect(result.receipt).toMatchObject({ status: "failed", safe_error_code: "HANDLER_EXCEPTION" });
    expect(JSON.stringify(result.receipt)).not.toContain("ECONNREFUSED");
  });

  it("uses a pre-provisioned receipt table without requiring schema CREATE", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === "SELECT to_regclass($1) AS receipt_table") {
          return { rows: [{ receipt_table: "synapsor_handler_receipts" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const connect = vi.spyOn(Pool.prototype, "connect").mockResolvedValue(client as never);

    try {
      const database = new PostgresWritebackHandlerDatabase(
        "postgresql://unused.invalid/handler-test",
        { schema: "public", table: "synapsor_handler_receipts" },
      );
      await expect(database.withTransaction(async () => "committed")).resolves.toBe("committed");
    } finally {
      connect.mockRestore();
    }

    expect(statements).toContain("SELECT to_regclass($1) AS receipt_table");
    expect(statements.some((statement) => statement.includes("CREATE TABLE"))).toBe(false);
    expect(statements.at(0)).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
  });
});

async function applyCredit(job: { proposalId: string; tenantId: string; objectId: string; principal: string; patch: Record<string, Scalar>; row: Record<string, unknown> }, tx: HandlerTx) {
  const creditId = `CR-${job.proposalId}`;
  await tx.insert("credits", {
    id: creditId,
    tenant_id: job.tenantId,
    invoice_id: job.objectId,
    amount_cents: Number(job.patch.credit_requested_cents),
    reason: String(job.patch.credit_reason),
    created_by: job.principal,
  }, { schema: "public" });
  await tx.update("invoices", { id: job.objectId, tenant_id: job.tenantId }, {
    credited_cents: Number(job.row.credited_cents ?? 0) + Number(job.patch.credit_requested_cents),
    updated_at: "2026-06-28T00:00:00.000Z",
  }, { schema: "public" });
  return {
    rowsAffected: 2,
    newVersion: "2026-06-28T00:00:00.000Z",
    effects: [{ type: "db.insert", table: "credits", id: creditId }],
  };
}

function validBody(options: { tenantId?: string; proposalId?: string; idempotencyKey?: string } = {}): string {
  const tenantId = options.tenantId ?? "tenant_acme";
  return JSON.stringify({
    protocol_version: "1.0",
    proposal_id: options.proposalId ?? "wrp_valid",
    idempotency_key: options.idempotencyKey ?? "wrp_valid:INV-3001",
    issued_at: new Date().toISOString(),
    change_set: {
      action: "support.propose_plan_credit",
      scope: { tenant_id: tenantId, object_id: "INV-3001" },
      principal: { id: "human-reviewer" },
      target: {
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-3001" },
      },
      patch: {
        credit_requested_cents: 1500,
        credit_reason: "outage credit",
      },
      guards: {
        tenant: { column: "tenant_id", value: tenantId },
        expected_version: { column: "updated_at", value: "2026-05-16T00:00:00.000Z" },
      },
    },
  });
}

function signedHeaders(body: string): Record<string, string> {
  return {
    authorization: `Bearer ${env.SYNAPSOR_APP_HANDLER_TOKEN}`,
    "x-synapsor-signature": signHandlerRequest(body, env.SYNAPSOR_APP_HANDLER_SIGNING_SECRET),
    "x-synapsor-issued-at": new Date().toISOString(),
  };
}

function request(body: string, headers: Record<string, string>, method = "POST"): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.headers = headers;
  stream.method = method;
  return stream;
}

function defaultInvoiceRow(): Record<string, unknown> {
  return {
    id: "INV-3001",
    tenant_id: "tenant_acme",
    customer_id: "CUS-1",
    credited_cents: 0,
    updated_at: "2026-05-16T00:00:00.000Z",
  };
}

class FakeDatabase implements WritebackHandlerDatabase {
  row: Record<string, unknown>;
  readonly receipts: Map<string, HandlerReceipt>;
  readonly effects: Array<Record<string, unknown>>;

  constructor(options: { row?: Record<string, unknown>; receipts?: Map<string, HandlerReceipt>; effects?: Array<Record<string, unknown>> } = {}) {
    this.row = options.row ?? defaultInvoiceRow();
    this.receipts = options.receipts ?? new Map();
    this.effects = options.effects ?? [];
  }

  async withTransaction<T>(fn: (tx: WritebackHandlerTransaction) => Promise<T>): Promise<T> {
    const row = { ...this.row };
    const receipts = new Map(this.receipts);
    const effects = [...this.effects];
    const tx = new FakeTransaction(row, receipts, effects);
    const result = await fn(tx);
    this.row = row;
    this.receipts.clear();
    for (const [key, value] of receipts) this.receipts.set(key, value);
    this.effects.length = 0;
    this.effects.push(...effects);
    return result;
  }
}

class FakeTransaction implements WritebackHandlerTransaction {
  constructor(
    private readonly row: Record<string, unknown>,
    private readonly receipts: Map<string, HandlerReceipt>,
    private readonly effects: Array<Record<string, unknown>>,
  ) {}

  async query<T = Record<string, unknown>>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  async insert(table: string, values: Record<string, Scalar>, options: { schema?: string } = {}): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.effects.push({ type: "insert", schema: options.schema ?? "public", table, values });
    return { rows: [{ ...values }], rowCount: 1 };
  }

  async update(table: string, where: Record<string, Scalar>, values: Record<string, Scalar>, options: { schema?: string } = {}): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (table === "invoices" && where.id === this.row.id && where.tenant_id === this.row.tenant_id) {
      Object.assign(this.row, values);
      this.effects.push({ type: "update", schema: options.schema ?? "public", table, where, values });
      return { rows: [{ ...this.row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async findReceipt(idempotencyKey: string): Promise<HandlerReceipt | undefined> {
    return this.receipts.get(idempotencyKey);
  }

  async lockTarget(job: { target: { primaryKey: { value: Scalar } }; tenantGuard: { value: Scalar } }): Promise<Record<string, unknown> | undefined> {
    if (job.target.primaryKey.value === this.row.id && job.tenantGuard.value === this.row.tenant_id) {
      return { ...this.row };
    }
    return undefined;
  }

  async recordReceipt(job: { idempotencyKey: string }, receipt: HandlerReceipt): Promise<void> {
    this.receipts.set(job.idempotencyKey, receipt);
  }
}
