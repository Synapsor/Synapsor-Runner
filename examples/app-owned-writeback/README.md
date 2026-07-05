# App-Owned Writeback Templates

Use app-owned writeback when an approved Synapsor proposal should be executed
by your application service instead of Runner writing SQL directly.

This is the right path for rich business actions:

- create a refund review;
- insert an account credit row;
- open a support ticket;
- update multiple related rows through your app service.

The model-facing MCP tool still only creates a proposal. Approval happens
outside MCP. After approval, `synapsor-runner apply` sends a structured request
to your handler, and the handler returns an execution receipt for replay.

> **Important:** your app handler owns the final business write. Runner creates
> the proposal and calls your handler only after approval, but your handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If you skip those checks, you can reintroduce cross-tenant
> writes, lost updates, or duplicate writes. Keep handler credentials out of MCP.

## Config Snippet

Add an executor and point one proposal capability at it:

```json
{
  "executors": {
    "app_writeback_api": {
      "type": "http_handler",
      "url_env": "SYNAPSOR_APP_WRITEBACK_URL",
      "method": "POST",
      "auth": {
        "type": "bearer_env",
        "token_env": "SYNAPSOR_APP_WRITEBACK_TOKEN"
      },
      "signing_secret_env": "SYNAPSOR_APP_WRITEBACK_SIGNING_SECRET",
      "timeout_ms": 5000
    }
  },
  "capabilities": [
    {
      "name": "refunds.propose_refund_review",
      "kind": "proposal",
      "executor": "app_writeback_api"
    }
  ]
}
```

Run after approval:

```bash
export SYNAPSOR_APP_WRITEBACK_URL="http://127.0.0.1:8787/synapsor/writeback"
export SYNAPSOR_APP_WRITEBACK_TOKEN="dev-handler-token"

synapsor-runner apply \
  --proposal wrp_... \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

## Handler Request Shape

Your handler receives JSON like:

```json
{
  "schema_version": "synapsor.handler-writeback.v1",
  "writeback_job_id": "hwb_wrp_...",
  "proposal_id": "wrp_...",
  "idempotency_key": "wrp_...",
  "change_set": {
    "action": "refunds.propose_refund_review",
    "scope": {
      "tenant_id": "acme",
      "object_id": "INV-3001"
    },
    "before": {},
    "patch": {},
    "after": {},
    "guards": {},
    "evidence": {
      "bundle_id": "ev_..."
    }
  },
  "executor": "app_writeback_api",
  "dry_run": false
}
```

Do not trust request fields blindly. Your service should re-check tenant,
principal, authorization, idempotency, row versions, and business rules before
mutating state.

## Handler Response Shape

Return one terminal receipt:

```json
{
  "status": "applied",
  "rows_affected": 1,
  "previous_version": "2026-06-20T14:31:08Z",
  "new_version": "2026-06-20T14:34:19Z",
  "source_database_mutated": true
}
```

Allowed statuses:

- `applied`
- `already_applied`
- `conflict`
- `failed`

## Templates

- `node-fastify-handler.mjs`: HTTP handler template for a Node/Fastify service.
- `python-fastapi-handler.py`: HTTP handler template for a Python/FastAPI service.
- `command-handler.mjs`: local command handler template for scripts.
- `business-actions.md`: concrete examples for refund reviews, account
  credits, support tickets, and multi-row app transactions.

Each template returns safe demo receipts and marks where your application
should run its own transaction.
