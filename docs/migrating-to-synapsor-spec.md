# Migrating To `@synapsor/spec`

`@synapsor/spec` is the canonical Synapsor contract format.

Older Runner configs may still embed capabilities directly inside
`synapsor.runner.json`. That remains supported. New projects should separate
the portable business contract from local runtime wiring.

## Old Shape

```json
{
  "version": 1,
  "mode": "review",
  "storage": { "sqlite_path": "./.synapsor/local.db" },
  "sources": {
    "local_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL"
    }
  },
  "trusted_context": {
    "provider": "environment",
    "values": {
      "tenant_id_env": "SYNAPSOR_TENANT_ID",
      "principal_env": "SYNAPSOR_PRINCIPAL"
    }
  },
  "capabilities": [
    {
      "name": "billing.inspect_invoice",
      "kind": "read",
      "source": "local_postgres",
      "target": {
        "schema": "public",
        "table": "invoices",
        "primary_key": "id",
        "tenant_key": "tenant_id"
      },
      "args": {
        "invoice_id": { "type": "string", "required": true }
      },
      "lookup": { "id_from_arg": "invoice_id" },
      "visible_columns": ["id", "tenant_id", "status", "late_fee_cents"],
      "evidence": "required",
      "max_rows": 1
    }
  ]
}
```

## New Shape

Put context, resources, capabilities, workflows, evidence requirements,
proposal boundaries, and kept-out fields in `synapsor.contract.json`.

```json
{
  "spec_version": "0.1",
  "kind": "SynapsorContract",
  "metadata": {
    "name": "billing invoice review",
    "version": "0.1.0"
  },
  "resources": [
    {
      "name": "billing_invoices",
      "engine": "postgres",
      "schema": "public",
      "table": "invoices",
      "primary_key": "id",
      "tenant_key": "tenant_id",
      "conflict_key": "updated_at"
    }
  ],
  "contexts": [
    {
      "name": "local_operator",
      "tenant_binding": "tenant_id",
      "principal_binding": "principal",
      "bindings": [
        { "name": "tenant_id", "source": "environment", "key": "SYNAPSOR_TENANT_ID", "required": true },
        { "name": "principal", "source": "environment", "key": "SYNAPSOR_PRINCIPAL", "required": true }
      ]
    }
  ],
  "capabilities": [
    {
      "name": "billing.inspect_invoice",
      "kind": "read",
      "context": "local_operator",
      "source": "local_postgres",
      "subject": {
        "resource": "billing_invoices"
      },
      "args": {
        "invoice_id": { "type": "string", "required": true, "max_length": 128 }
      },
      "lookup": { "id_from_arg": "invoice_id" },
      "visible_fields": ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
      "kept_out_fields": ["internal_notes"],
      "evidence": { "required": true, "query_audit": true },
      "max_rows": 1
    }
  ]
}
```

Then keep only local wiring in `synapsor.runner.json`.

```json
{
  "version": 1,
  "mode": "read_only",
  "result_format": 2,
  "storage": {
    "sqlite_path": "./.synapsor/local.db"
  },
  "contracts": ["./synapsor.contract.json"],
  "sources": {
    "local_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL",
      "statement_timeout_ms": 3000
    }
  }
}
```

## Validate

```bash
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner contract normalize ./synapsor.contract.json --out ./synapsor.contract.normalized.json
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

You can also compile from the SQL-like authoring layer:

```bash
synapsor-runner dsl validate ./contract.synapsor.sql
synapsor-runner dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json --strict
```

`.synapsor.sql` is the preferred editor-friendly source filename. Existing
`.synapsor` files remain valid and compile to equivalent canonical JSON.

## Bundle For Local Runner

Cloud/exported or hand-written contracts can become a local Runner bundle:

```bash
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
```

The bundle includes:

- `synapsor.contract.json`
- `synapsor.runner.json`
- `.env.example`
- `README.md`
- `mcp-client-examples/generic-stdio.json`

It does not include database passwords, write credentials, bearer tokens,
customer rows, or table data.

## Common Errors

`UNKNOWN_FIELD`

The contract has a field outside the 0.1 core schema. Use explicit extension
fields such as `x-cloud-*`, `x-runner-*`, or `x-experimental-*`.

`MODEL_CONTROLLED_TRUST_SCOPE`

A capability argument tries to accept trusted scope from the model, such as
`tenant_id`, `principal`, table names, column names, or `expected_version`.
Bind those values from trusted context instead.

`KEPT_OUT_VISIBLE_CONFLICT`

A field appears in both `visible_fields` and `kept_out_fields`. Remove it from
`visible_fields`. Kept-out fields must not reach evidence, proposals, or replay.

`PROPOSAL_CONFLICT_GUARD_REQUIRED`

A proposal capability needs a conflict guard, or an explicit weak-guard
acknowledgement for a known dev-only path.

## Compatibility

Embedded Runner capabilities are still supported for existing users. The new
contract split is the forward path because it lets OSS Runner, Cloud, C++ import
tests, and the DSL compiler all validate the same canonical shape.
