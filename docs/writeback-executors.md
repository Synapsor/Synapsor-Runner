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
npx -y -p @synapsor/runner@alpha synapsor apply \
  --proposal wrp_123 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The handler receives proposal fields, the exact patch, evidence metadata,
guards, and an idempotency key. It does not receive arbitrary model SQL or DB
credentials from Synapsor Runner.

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
