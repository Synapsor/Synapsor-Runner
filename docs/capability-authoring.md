# Capability Authoring

Use `synapsor.runner.json` to define the database actions an MCP client can see.
The model sees semantic capabilities such as `billing.inspect_invoice`, not raw
SQL, table names, write credentials, approval tools, or commit tools.

For editor validation, use the JSON Schema:

```text
schemas/synapsor.runner.schema.json
```

## Minimal Shape

```json
{
  "version": 1,
  "mode": "review",
  "result_format": 2,
  "storage": { "sqlite_path": "./.synapsor/local.db" },
  "sources": {
    "app_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL",
      "statement_timeout_ms": 3000
    }
  },
  "trusted_context": {
    "provider": "environment",
    "values": {
      "tenant_id_env": "SYNAPSOR_TENANT_ID",
      "principal_env": "SYNAPSOR_PRINCIPAL"
    }
  },
  "capabilities": []
}
```

`result_format: 2` makes every MCP tool call return one envelope:

```json
{
  "ok": true,
  "summary": "Created proposal wrp_123. Source database changed: no.",
  "action": "billing.propose_late_fee_waiver",
  "kind": "proposal",
  "data": null,
  "proposal": {},
  "error": null,
  "evidence": {
    "bundle_id": "ev_123",
    "note": "audit/replay handle; you do not need to act on it during this turn"
  },
  "source_database_changed": false,
  "_meta": {
    "canonical_capability": "billing.propose_late_fee_waiver"
  }
}
```

Use `--result-format v2` on `mcp serve` or `mcp serve-streamable-http` if you
want to opt in from the command line instead of config.

## Read Capability

Read capabilities inspect one scoped row or view and save evidence/query-audit
records locally.

```json
{
  "name": "billing.inspect_invoice",
  "kind": "read",
  "description": "Inspect one invoice in the trusted tenant before proposing a waiver or credit.",
  "returns_hint": "Returns invoice amount, late fee, status, policy facts, and an audit evidence handle.",
  "source": "app_postgres",
  "target": {
    "schema": "public",
    "table": "invoices",
    "primary_key": "id",
    "tenant_key": "tenant_id"
  },
  "args": {
    "invoice_id": {
      "type": "string",
      "required": true,
      "max_length": 128,
      "description": "Invoice id, e.g. INV-3001."
    }
  },
  "lookup": { "id_from_arg": "invoice_id" },
  "visible_columns": ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
  "evidence": "required",
  "max_rows": 1
}
```

Model-facing descriptions matter. They should explain when to use the tool and
what the result contains. Runner also adds evidence-handle guidance so the model
does not waste a turn trying to call an audit handle.

## Proposal Capability

Proposal capabilities create an exact before/after diff. They do not mutate your
source database. Approval and writeback stay outside the model-facing MCP tool
surface.

```json
{
  "name": "billing.propose_late_fee_waiver",
  "kind": "proposal",
  "description": "Propose waiving one invoice late fee after inspecting invoice and policy evidence.",
  "returns_hint": "Returns a review-required proposal id, exact field diff, evidence handle, and source_database_changed:false.",
  "source": "app_postgres",
  "target": {
    "schema": "public",
    "table": "invoices",
    "primary_key": "id",
    "tenant_key": "tenant_id"
  },
  "args": {
    "invoice_id": {
      "type": "string",
      "required": true,
      "description": "Invoice id, e.g. INV-3001."
    },
    "reason": {
      "type": "string",
      "required": true,
      "max_length": 500,
      "description": "Business reason for the proposed waiver."
    }
  },
  "lookup": { "id_from_arg": "invoice_id" },
  "visible_columns": ["id", "tenant_id", "status", "late_fee_cents", "waiver_reason", "updated_at"],
  "patch": {
    "late_fee_cents": { "fixed": 0 },
    "waiver_reason": { "from_arg": "reason" }
  },
  "allowed_columns": ["late_fee_cents", "waiver_reason"],
  "numeric_bounds": {
    "late_fee_cents": { "minimum": 0, "maximum": 10000 }
  },
  "conflict_guard": { "column": "updated_at" },
  "approval": { "mode": "human", "required_role": "billing_lead" }
}
```

## Trusted Context

Tenant, principal, approval authority, source ids, and row-version authority
must come from trusted backend/session context, not from model arguments.

Good:

```json
"trusted_context": {
  "provider": "environment",
  "values": {
    "tenant_id_env": "SYNAPSOR_TENANT_ID",
    "principal_env": "SYNAPSOR_PRINCIPAL"
  }
}
```

Bad:

```json
"args": {
  "tenant_id": { "type": "string" }
}
```

Runner rejects model-facing trust-scope arguments.

## Direct SQL Writeback

Use direct SQL writeback only for simple bounded single-row `UPDATE` proposals.
Runner validates:

- fixed table and column names;
- primary-key targeting;
- tenant guard;
- `allowed_columns`;
- numeric bounds and transition guards;
- optimistic conflict guard such as `updated_at`;
- one affected row;
- idempotency receipt.

Runner does not expose generic SQL, model-generated SQL, DDL, INSERT, DELETE,
UPSERT, or multi-row writes.

Direct SQL writeback uses the source `write_url_env`, such as
`SYNAPSOR_DATABASE_WRITE_URL`. The writer needs permission for
`synapsor_writeback_receipts` or an administrator must pre-create and grant that
table.

## App-Owned Executors

Use an app-owned executor when an approved proposal needs richer business work:
creating a credit row, inserting an outbox event, updating multiple app tables,
or calling your own service.

```json
"executors": {
  "billing_handler": {
    "type": "http_handler",
    "url_env": "BILLING_WRITEBACK_URL",
    "method": "POST",
    "auth": {
      "type": "bearer_env",
      "token_env": "BILLING_WRITEBACK_TOKEN"
    },
    "signing_secret_env": "BILLING_WRITEBACK_SIGNING_SECRET",
    "timeout_ms": 5000
  }
}
```

Then reference it from a proposal capability:

```json
{
  "name": "billing.propose_account_credit",
  "kind": "proposal",
  "executor": "billing_handler"
}
```

Approval still happens outside MCP. Runner sends the approved job to your
handler, and the handler returns an applied/conflict/failed receipt for replay.
See [App-Owned Executors](app-owned-executors.md) and
[Writeback Executors](writeback-executors.md).

## OpenAI Aliases

Canonical Synapsor names use dots, such as `billing.inspect_invoice`. Some
clients require function-safe names. Use:

```bash
synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

The model sees aliases such as `billing__inspect_invoice`. Runner includes the
canonical name in tool metadata and descriptions so audit/replay still use the
real capability name.

## Why Not `execute_sql`

`execute_sql(sql)` gives the model database authority. Synapsor Runner gives the
model proposal authority:

```text
model-facing MCP tool -> trusted context -> scoped read -> evidence -> proposal
```

Commit authority stays outside the model:

```text
human/operator approval -> guarded writeback or app-owned handler -> receipt/replay
```
