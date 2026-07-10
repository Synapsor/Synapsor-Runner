# Capability Authoring

For new work, author portable contracts first. The contract is the reviewable
source of truth for trusted context, resources, capabilities, evidence,
proposal shape, and writeback intent.

```text
contract.synapsor.sql -> synapsor.contract.json -> synapsor.runner.json
```

Use `.synapsor.sql` as the preferred DSL source extension because editors can
provide generic SQL highlighting. Legacy `.synapsor` files remain supported;
the suffix does not change DSL semantics or generated canonical JSON.

Use `synapsor.runner.json` for local wiring: database env var names, SQLite
store path, MCP transport settings, and local development flags. The model sees
semantic capabilities such as `billing.inspect_invoice`, not raw SQL, table
names, write credentials, approval tools, or commit tools.

## Contract/DSL Path

Write a small DSL contract:

```sql
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.inspect_invoice
  DESCRIPTION 'Inspect one invoice in the trusted tenant before proposing a waiver.'
  RETURNS HINT 'Returns reviewed invoice fields plus evidence/query-audit handles.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ALLOW READ id, tenant_id, status, late_fee_cents, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
END

CREATE CAPABILITY billing.propose_late_fee_waiver
  DESCRIPTION 'Propose waiving one invoice late fee after inspecting invoice and policy evidence.'
  RETURNS HINT 'Returns a review-required proposal id, exact diff, evidence handle, and source_database_changed:false.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason for the proposed waiver.'
  ALLOW READ id, tenant_id, status, late_fee_cents, waiver_reason, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION waive_late_fee
  ALLOW WRITE late_fee_cents, waiver_reason
  PATCH late_fee_cents = 0
  PATCH waiver_reason = ARG reason
  BOUND late_fee_cents 0..10000
  APPROVAL ROLE billing_lead
  WRITEBACK DIRECT SQL
END
```

Compile and validate:

```bash
synapsor-runner dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json --strict
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json \
  --api-url "$SYNAPSOR_CLOUD_BASE_URL" \
  --token "$SYNAPSOR_CLOUD_TOKEN" \
  --workspace "$SYNAPSOR_PROJECT_ID" \
  --name billing-late-fee
```

Reference the generated contract from local runner wiring:

```json
{
  "version": 1,
  "mode": "review",
  "contracts": ["./synapsor.contract.json"],
  "storage": { "sqlite_path": "./.synapsor/local.db" },
  "sources": {
    "app_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL"
    }
  }
}
```

Then preview or serve the MCP tools:

```bash
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

`--strict` treats DSL safety warnings as errors. Use it in CI so proposal
capabilities cannot accidentally lose descriptions, returns hints, or numeric
patch bounds during review.

## DSL / JSON Capability Parity

The DSL compiles to canonical `@synapsor/spec` JSON. It must not silently weaken
reviewed runner JSON capabilities. Current parity:

| JSON field | DSL clause | Since | Notes |
| --- | --- | --- | --- |
| capability `description` | `DESCRIPTION '...'` | 0.1.8 | Recommended for every model-facing tool; strict mode warns when proposal capabilities omit it. |
| capability `returns_hint` | `RETURNS HINT '...'` | 0.1.8 | Recommended for every model-facing tool; strict mode warns when proposal capabilities omit it. |
| arg `description` | `ARG name TYPE ... DESCRIPTION '...'` | 0.1.8 | Used in MCP tool input schemas. |
| arg `minimum` | `ARG amount NUMBER MIN 1` | 0.1.8 | NUMBER args only. |
| arg `maximum` | `ARG amount NUMBER MAX 2500` | 0.1.8 | NUMBER args only. |
| arg `max_length` | `ARG reason TEXT MAX LENGTH 500` | 0.1.8 | STRING/TEXT args only. Legacy `MAX 500` is still accepted for existing DSL files, but `MAX LENGTH` is the reviewed spelling. |
| arg `enum` | Not expressible in DSL yet | 0.1 | Use embedded JSON or generated contract JSON when enum allowlists are required. |
| proposal `numeric_bounds` | `BOUND column 1..2500`, `BOUND column ..2500`, or `BOUND column 1..` | 0.1.8 | Applies to patched numeric columns. Strict mode warns when a NUMBER arg is patched without arg min/max or a matching `BOUND`. |
| proposal `transition_guards` | `TRANSITION status ALLOW pending -> approved\|rejected` or `TRANSITION status FROM current_status ALLOW open -> closed` | 0.1.8 | Values are state strings; use `|` for multiple target states. |
| proposal `conflict_guard` | `CONFLICT GUARD updated_at` | 0.1 | If omitted, DSL emits an explicit weak-guard acknowledgement. Prefer a real row-version column. |
| proposal `approval` | `APPROVAL ROLE billing_lead` | 0.1 | Local mode records the required role; enforcement is still outside the model-facing MCP tool. |
| proposal `writeback` | `WRITEBACK DIRECT SQL`, `WRITEBACK APP HANDLER EXECUTOR name`, `WRITEBACK CLOUD WORKER`, `WRITEBACK NONE` | 0.1.7 | Handler URLs/tokens stay in `synapsor.runner.json`; contracts carry only the handler name. |
| evidence options | `REQUIRE EVIDENCE` | 0.1 | Detailed evidence sources/handle prefixes are not expressible in DSL yet; use embedded JSON or generated contract JSON for those. |

## Direct Runner Config Path

Directly embedding capabilities in `synapsor.runner.json` remains supported for
local experiments, generated configs, migration, and compatibility with earlier
Runner versions. Prefer contracts when you want definitions that can be
validated, bundled, reviewed in Git, dry-run pushed to Cloud, or shared with
Cloud/C++ import/export fixtures.

For editor validation, use the JSON Schema:

```text
schemas/synapsor.runner.schema.json
```

## Minimal Runner Config Shape

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

In DSL, keep the reviewed business contract portable and name the executor:

```sql
CREATE CAPABILITY billing.propose_plan_credit
  CONTEXT trusted_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  ARG invoice_id STRING REQUIRED
  ARG amount_cents NUMBER REQUIRED
  ARG reason STRING REQUIRED
  LOOKUP invoice_id
  VISIBLE id, tenant_id, customer_id, status, credit_requested_cents, credit_reason, updated_at
  PROPOSE ACTION billing.grant_plan_credit
  ALLOW WRITE credit_requested_cents, credit_reason
  PATCH credit_requested_cents = ARG amount_cents
  PATCH credit_reason = ARG reason
  CONFLICT GUARD updated_at
  APPROVAL ROLE billing_lead
  WRITEBACK APP HANDLER EXECUTOR billing_handler
END
```

`billing_handler` is contract content. Its URL, bearer-token env var, signing
secret env var, and timeout stay in `synapsor.runner.json` so credentials never
enter the portable contract:

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

For legacy embedded JSON capabilities, reference the same executor directly:

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
