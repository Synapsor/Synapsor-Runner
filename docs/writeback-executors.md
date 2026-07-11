# Writeback Executors

Synapsor Runner separates proposal authority from execution authority.

The model-facing MCP server can inspect and propose. It cannot approve or
commit. After a human or trusted process approves a proposal, the local runner
uses a configured writeback executor.

## `sql_update`

`sql_update` is the default executor.

It applies one guarded `UPDATE` through the database adapter:

- fixed schema/table from reviewed config;
- fixed primary key column;
- tenant guard;
- allowed-column validation;
- conflict/version guard;
- idempotency key;
- affected-row check;
- terminal receipt in replay.

Use this when the trusted runner is allowed to update the selected business row
directly.

The source config controls which writer env var is used:

```json
{
  "sources": {
    "local_postgres": {
      "engine": "postgres",
      "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL"
    }
  }
}
```

For `synapsor-runner apply --job ... --config ...`, set the env var named by
`write_url_env`. `SYNAPSOR_DATABASE_URL` is only a legacy fallback for direct
worker flows that do not pass a local config.

Direct SQL writeback also stores idempotency receipts in the source database.
By default it runs:

```sql
CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (...);
```

That means the writer needs permission to create and write that receipt table in
the target schema/database, or the table must be pre-created by an administrator
and granted to the writer. If you do not want Runner to create a table in the
application schema, create a dedicated schema/database for receipts where your
database policy allows it, or use `http_handler`/`command_handler` so your
application owns receipt storage and business writes.

Use the helper commands before enabling direct SQL writeback:

```bash
npx -y -p @synapsor/runner synapsor-runner writeback doctor --config ./synapsor.runner.json
npx -y -p @synapsor/runner synapsor-runner writeback migration --engine postgres
npx -y -p @synapsor/runner synapsor-runner writeback grants --engine postgres --writer-role app_writer
```

`writeback doctor --check-db` connects with the configured writer credential and
checks the pre-created receipt table path in a rolled-back transaction. Apply
the printed migration as an administrator first; the steady-state writer needs
table `SELECT`/`INSERT`/`UPDATE`, not schema `CREATE`.

## `http_handler`

Use `http_handler` when your application/API should own business execution.

The approved proposal becomes a structured HTTP request to an internal handler.
The handler URL and bearer token come from environment variables, not config
literal values.

```json
{
  "executors": {
    "billing_api": {
      "type": "http_handler",
      "url_env": "SYNAPSOR_BILLING_HANDLER_URL",
      "method": "POST",
      "auth": {
        "type": "bearer_env",
        "token_env": "SYNAPSOR_BILLING_HANDLER_TOKEN"
      },
      "signing_secret_env": "SYNAPSOR_BILLING_HANDLER_SIGNING_SECRET",
      "timeout_ms": 5000
    }
  },
  "capabilities": [
    {
      "name": "billing.propose_late_fee_waiver",
      "kind": "proposal",
      "executor": "billing_api"
    }
  ]
}
```

Run after approval:

```bash
npx -y -p @synapsor/runner synapsor-runner apply \
  --proposal wrp_123 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The handler receives proposal fields, the exact patch, evidence metadata,
guards, and an idempotency key. It does not receive arbitrary model SQL or DB
credentials from Synapsor Runner.

> **Important:** your app handler owns the final business write. Runner creates
> the proposal and calls your handler only after approval, but your handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If you skip those checks, you can reintroduce cross-tenant
> writes, lost updates, or duplicate writes. Keep handler credentials out of MCP.

When `signing_secret_env` is set, Runner signs the exact JSON body with HMAC
SHA-256 and sends:

- `X-Synapsor-Signature: sha256=...`
- `X-Synapsor-Issued-At: ...`
- `X-Synapsor-Proposal-Id: ...`
- `Idempotency-Key: ...`

Use signing for any handler that is not strictly loopback-only and protected by
another trusted boundary.

Handler responses:

```json
{
  "status": "applied",
  "rows_affected": 1,
  "previous_version": "2026-06-20T14:31:08Z",
  "new_version": "2026-06-20T14:34:19Z",
  "source_database_mutated": true
}
```

Allowed terminal statuses:

- `applied`
- `already_applied`
- `conflict`
- `failed`

Non-2xx responses and timeouts become failed execution receipts. The terminal
receipt is stored in replay.

Use your application/API for business logic. Use Synapsor Runner for proposal,
approval, evidence, policy boundary, and replay.

For TypeScript services, use the source-level helper in `packages/handler`.
It verifies bearer/HMAC auth, parses the request, locks the target row with the
tenant guard, checks the expected version, handles idempotency, wraps the
business effect in a transaction, and returns safe receipts without raw driver
errors. See [Handler Helper](handler-helper.md).

This is the recommended path for writes that are richer than the current
`sql_update` scope, such as:

- creating a refund review;
- inserting an account credit row;
- opening a support ticket;
- updating multiple related rows in one app transaction.

Starter templates are in:

```text
examples/app-owned-writeback/
```

Concrete business-action examples are in:

```text
examples/app-owned-writeback/business-actions.md
```

The full disposable Postgres account-credit demo is in:

```text
examples/mcp-postgres-billing-app-handler/
```

It proves the rich-write path end to end: the model creates a proposal, the
source DB is unchanged before approval, the app-owned handler inserts an
`account_credits` row after approval, retry is idempotent, and replay stores the
handler receipt.

Or generate one into your app:

```bash
npx -y -p @synapsor/runner synapsor-runner handler template node-fastify \
  --output ./synapsor-writeback-handler.mjs

npx -y -p @synapsor/runner synapsor-runner handler template python-fastapi \
  --output ./synapsor_writeback_handler.py

npx -y -p @synapsor/runner synapsor-runner handler template command \
  --output ./synapsor-command-handler.mjs
```

## `command_handler`

`command_handler` is a local integration path for scripts:

```json
{
  "executors": {
    "local_billing_script": {
      "type": "command_handler",
      "command_env": "SYNAPSOR_BILLING_HANDLER_COMMAND",
      "timeout_ms": 5000
    }
  }
}
```

The command receives the same structured JSON request on stdin and should print
a JSON receipt body on stdout.

> **Important:** command handlers have the same responsibility as HTTP
> handlers. Re-check tenant/scope, expected-version or conflict guard,
> idempotency, allowed business action, transaction/rollback, and safe error
> receipt before mutating state. Otherwise the script can reintroduce
> cross-tenant writes, lost updates, or duplicate writes.

Use `examples/app-owned-writeback/command-handler.mjs` as a starting point when
your safest apply path is an app script or job runner.

## Safety Boundary

Executor secrets are never exposed over MCP. The model never receives:

- approval tools;
- commit tools;
- write credentials;
- handler bearer tokens;
- arbitrary SQL authority;
- tenant/principal authority.

`MCP tool call = request/proposal authority. Trusted runner = execution
authority.`
