#!/usr/bin/env node
import http from "node:http";

const { createWritebackHandler } = await loadHandlerHelper();

const port = Number(process.env.BILLING_APP_HANDLER_PORT || "8787");

if (!process.env.BILLING_APP_WRITE_URL) {
  console.error("BILLING_APP_WRITE_URL is required.");
  process.exit(1);
}

const writebackHandler = createWritebackHandler({
  tokenEnv: "BILLING_APP_HANDLER_TOKEN",
  signingSecretEnv: "BILLING_APP_HANDLER_SIGNING_SECRET",
  source: {
    engine: "postgres",
    writeUrlEnv: "BILLING_APP_WRITE_URL",
    receiptTable: {
      schema: "public",
      table: "synapsor_handler_receipts",
    },
  },
  capabilities: {
    "billing.propose_account_credit": applyAccountCredit,
  },
});

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    return writeJson(response, 200, { ok: true });
  }
  if (request.method !== "POST" || request.url !== "/synapsor/writeback") {
    return writeJson(response, 404, {
      status: "failed",
      rows_affected: 0,
      safe_error_code: "NOT_FOUND",
      source_database_mutated: false,
    });
  }
  await writebackHandler(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.error(`Billing app handler listening on http://127.0.0.1:${port}/synapsor/writeback`);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function shutdown() {
  server.close();
  process.exit(0);
}

async function applyAccountCredit(job, tx) {
  /*
   * IMPORTANT: this app handler owns the final business write.
   * The helper has already verified auth, tenant scope, expected version,
   * idempotency, and transaction wrapping before this function runs. Keep that
   * pattern if you replace the helper or move this logic into your app.
   */
  const amountCents = Number(job.patch.credit_requested_cents);
  const reason = String(job.patch.credit_reason || "approved account credit");
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("credit amount must be a positive integer");
  }

  const creditId = `CR-${job.proposalId.replace(/[^A-Za-z0-9]/g, "").slice(-12) || Date.now()}`;
  await tx.insert("account_credits", {
    id: creditId,
    tenant_id: job.tenantId,
    invoice_id: job.objectId,
    customer_id: String(job.row.customer_id),
    amount_cents: amountCents,
    reason,
    idempotency_key: job.idempotencyKey,
    created_by: job.principal,
  }, { schema: "public" });

  const newVersion = new Date().toISOString();
  const update = await tx.update("invoices", {
    id: job.objectId,
    tenant_id: job.tenantId,
  }, {
    credit_requested_cents: amountCents,
    credit_reason: reason,
    credited_cents: Number(job.row.credited_cents ?? 0) + amountCents,
    updated_at: newVersion,
  }, {
    schema: "public",
    returning: ["updated_at"],
  });

  if (update.rowCount !== 1) {
    throw new Error("invoice update affected an unexpected number of rows");
  }

  return {
    rowsAffected: 2,
    newVersion: timestampString(update.rows[0]?.updated_at ?? newVersion),
    effects: [
      { type: "db.insert", table: "account_credits", id: creditId },
      { type: "db.update", table: "invoices", id: job.objectId },
      { type: "event", name: "billing.account_credit_created" },
    ],
  };
}

function timestampString(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function loadHandlerHelper() {
  const bundledHelper = new URL("./synapsor-handler.mjs", import.meta.url);
  try {
    return await import(bundledHelper);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || error?.url !== bundledHelper.href) {
      throw error;
    }
    return await import(new URL("../../packages/handler/dist/index.js", import.meta.url));
  }
}
