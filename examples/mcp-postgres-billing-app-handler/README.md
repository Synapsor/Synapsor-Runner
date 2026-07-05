# Postgres Billing App Handler

This example shows the two Synapsor Runner commit paths against one disposable
Postgres billing database.

Direct guarded SQL writeback:

- `billing.propose_late_fee_waiver`
- one-row `UPDATE`;
- tenant guard, allowed-column guard, conflict guard, idempotency receipt.

App-owned rich writeback:

- `billing.propose_account_credit`
- model-facing MCP only creates a proposal;
- approval happens outside MCP;
- Runner calls `billing_app_handler`;
- the app uses the first-party handler helper from the source workspace, or the
  bundled `synapsor-handler.mjs` shim included in the runner npm package, to
  verify bearer auth, HMAC signature, tenant scope, expected row version,
  idempotency, and transaction/receipt shape;
- the handler business code inserts an `account_credits` row and updates the
  invoice inside the helper-owned transaction;
- Runner records the handler receipt and replay.

The model never receives `execute_sql`, approval tools, commit/apply tools,
database URLs, or write credentials.

> **Important:** the app handler owns the final business write. Runner creates
> the proposal and calls the handler only after approval, but the handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If those checks are skipped, the app can reintroduce
> cross-tenant writes, lost updates, or duplicate writes.

## Run

From the repository root:

```bash
examples/mcp-postgres-billing-app-handler/scripts/run-demo.sh
```

Expected ending:

```text
App-owned billing handler demo passed.
Verified: proposal first, source unchanged before approval, account credit inserted by app handler, idempotent retry, replay.
```

## Manual Start

```bash
docker compose -f examples/mcp-postgres-billing-app-handler/docker-compose.yml up -d

export BILLING_APP_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55437/synapsor_billing_app_handler"
export BILLING_APP_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55437/synapsor_billing_app_handler"
export BILLING_APP_HANDLER_URL="http://127.0.0.1:8787/synapsor/writeback"
export BILLING_APP_HANDLER_TOKEN="dev-handler-token"
export BILLING_APP_HANDLER_SIGNING_SECRET="dev-handler-signing-secret"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_billing_operator"

node examples/mcp-postgres-billing-app-handler/app-handler.mjs
```

Then, in another terminal:

```bash
synapsor-runner tools preview \
  --config examples/mcp-postgres-billing-app-handler/synapsor.runner.json \
  --store ./tmp/billing-app-handler/local.db

synapsor-runner propose billing.propose_account_credit \
  --json '{"invoice_id":"INV-3001","amount_cents":2500,"reason":"support-approved credit"}' \
  --config examples/mcp-postgres-billing-app-handler/synapsor.runner.json \
  --store ./tmp/billing-app-handler/local.db

synapsor-runner proposals approve latest --yes --store ./tmp/billing-app-handler/local.db
synapsor-runner apply latest \
  --config examples/mcp-postgres-billing-app-handler/synapsor.runner.json \
  --store ./tmp/billing-app-handler/local.db
synapsor-runner replay show latest --store ./tmp/billing-app-handler/local.db
```

## Why This Exists

Direct Runner SQL writeback should stay intentionally narrow. It is good for
simple, bounded, single-row updates.

For richer business transactions such as creating credits, refund reviews,
ledger rows, tickets, events, or multi-row updates, keep execution in your
application service. Synapsor Runner still owns proposal creation, evidence,
approval boundary, idempotency, receipt storage, and replay.
