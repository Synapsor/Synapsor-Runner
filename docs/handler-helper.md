# App-Owned Handler Helper

Use the TypeScript handler helper when an approved Synapsor proposal should be
executed by your application service, not by Runner's direct SQL writer.

This is optional support code for your app-owned handler. Users install
`@synapsor/runner`; they do not install a separate handler package in the
current alpha.

The helper is the safe-by-default path for rich writes such as:

- inserting account-credit, refund-review, ticket, or ledger rows;
- updating multiple related rows inside your app transaction;
- applying business rules that belong in your application service.

The model-facing MCP tool still creates a proposal only. A human/operator
approves outside MCP. After approval, Runner sends the structured writeback
request to your handler.

> **Important:** your app handler owns the final business write. Runner creates
> the proposal and calls your handler only after approval, but your handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If you skip those checks, you can reintroduce cross-tenant
> writes, lost updates, or duplicate writes. Keep handler credentials out of MCP.

## Scope

Current alpha scope:

- TypeScript helper in `packages/handler`;
- bearer token verification;
- optional HMAC verification over the raw request body;
- typed request parsing;
- action dispatch;
- idempotency receipt lookup;
- transaction wrapper;
- `SELECT ... FOR UPDATE` target-row lock;
- tenant guard;
- expected-version stale-row guard;
- safe applied/conflict/failed receipts;
- no raw driver errors in HTTP responses.

Python helper is planned. For now, Python handlers should follow the documented
request/receipt schema and the FastAPI template in `examples/app-owned-writeback`.

## Distribution Status

The helper implementation exists in this source repo under `packages/handler`
and is used by the app-owned executor example and tests. It is not published as
a standalone npm package yet.

If you installed `@synapsor/runner` from npm, use one of these alpha paths:

- generate a starter handler with `synapsor-runner handler template ...`;
- copy from `examples/app-owned-writeback/`;
- run `examples/mcp-postgres-billing-app-handler/`, which includes a bundled
  `synapsor-handler.mjs` shim inside the runner package.

## Schemas

Published schemas:

- `schemas/synapsor.app-handler-request.v1.json`
- `schemas/synapsor.app-handler-receipt.v1.json`

The helper accepts both the new `protocol_version: "1.0"` shape and the current
Runner `schema_version: "synapsor.handler-writeback.v1"` request shape during
the alpha migration.

## TypeScript Usage From A Source Checkout

The source checkout has an internal helper under `packages/handler`. It is not
an npm install path. Import it by workspace-relative path while developing this
repository, or use the bundled example shim in the packaged runner.

```ts
import { createWritebackHandler } from "../packages/handler/src/index.js";

export const handler = createWritebackHandler({
  tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
  signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
  source: {
    engine: "postgres",
    writeUrlEnv: "SYNAPSOR_APP_WRITE_URL",
    receiptTable: { schema: "synapsor", table: "handler_receipts" }
  },
  capabilities: {
    "support.propose_plan_credit": async (job, tx) => {
      const creditId = `CR-${job.proposalId.slice(-12)}`;

      await tx.insert("credits", {
        id: creditId,
        tenant_id: job.tenantId,
        invoice_id: job.objectId,
        amount_cents: Number(job.patch.credit_requested_cents),
        reason: String(job.patch.credit_reason),
        created_by: job.principal
      });

      await tx.update("invoices", {
        id: job.objectId,
        tenant_id: job.tenantId
      }, {
        credited_cents:
          Number(job.row.credited_cents ?? 0) +
          Number(job.patch.credit_requested_cents)
      });

      return {
        rowsAffected: 2,
        effects: [{ type: "db.insert", table: "credits", id: creditId }]
      };
    }
  }
});
```

Mount the returned handler at your app route, for example
`POST /synapsor/writeback`.

The handler author writes only the business effect. The helper owns the safety
loop around that effect.

## What The Helper Enforces

The helper checks these before your business function can mutate state:

- the bearer token matches the configured environment variable;
- the optional HMAC signature is valid and fresh;
- the request protocol is supported;
- the action maps to a configured capability function;
- the target row exists inside the trusted tenant;
- the row version still matches the proposal's expected version;
- the idempotency key was not already applied.

If the row is missing or belongs to another tenant, the helper returns:

```json
{
  "status": "conflict",
  "rows_affected": 0,
  "source_database_mutated": false,
  "safe_error_code": "ROW_NOT_FOUND_OR_WRONG_TENANT"
}
```

If the row changed after proposal creation, the helper returns:

```json
{
  "status": "conflict",
  "rows_affected": 0,
  "source_database_mutated": false,
  "safe_error_code": "ROW_CHANGED_AFTER_PROPOSAL"
}
```

If your business function throws, the helper rolls back the transaction and
returns a safe failed receipt. Raw driver and exception text are not exposed to
the caller.

## Runner-Side Signing Config

Configure the matching `http_handler` executor with the same signing-secret env
name:

```json
{
  "executors": {
    "billing_handler": {
      "type": "http_handler",
      "url_env": "BILLING_WRITEBACK_URL",
      "method": "POST",
      "auth": {
        "type": "bearer_env",
        "token_env": "BILLING_WRITEBACK_TOKEN"
      },
      "signing_secret_env": "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
      "timeout_ms": 5000
    }
  }
}
```

When this field is set, Runner signs the exact request body and sends
`X-Synapsor-Signature`, `X-Synapsor-Issued-At`,
`X-Synapsor-Proposal-Id`, and `Idempotency-Key`. The helper verifies those
headers before parsing or applying the writeback request.

## Signing

For loopback-only development, bearer auth may be enough. For any handler that
is reachable outside the local process, enable HMAC:

```ts
createWritebackHandler({
  tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
  signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
  // ...
});
```

Runner sends:

```text
Authorization: Bearer <token>
X-Synapsor-Signature: sha256=<hmac>
X-Synapsor-Issued-At: <iso timestamp>
X-Synapsor-Proposal-Id: wrp_...
Idempotency-Key: wrp_...
```

The HMAC is computed over the raw body. The helper enforces a short issued-at
skew window.

## Receipt Storage

The helper's Postgres adapter stores idempotency receipts in a receipt table.
Prefer a dedicated schema, for example:

```sql
CREATE SCHEMA IF NOT EXISTS synapsor;
GRANT USAGE, CREATE ON SCHEMA synapsor TO app_writeback_user;
```

If your application already has a receipt/idempotency table, implement the
`WritebackHandlerDatabase` interface and pass it as `database`.
