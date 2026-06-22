# Local capability config

Synapsor Runner uses a strict JSON capability config for local MCP/database safety work.

YAML can be added later, but the first supported format is JSON so the runtime can validate untrusted config without adding a parser dependency.

Capabilities are not hardcoded into the runtime. The MCP server exposes only
the reviewed `capabilities` listed in `synapsor.runner.json`, or the tool
catalog returned by Synapsor Cloud in `cloud` mode. The billing examples in
this document are examples only; use your own namespace, object names, tables,
columns, patch mappings, and approval roles.

Synapsor Runner does not implement full Synapsor workflows or
`CREATE AGENT WORKFLOW` in v0.1. It models the local commit-safety loop for
reviewed read/proposal capabilities.

## Goals

The config defines reviewed semantic capabilities. It must not define arbitrary SQL tools.

The validator rejects:

- raw SQL fields such as `sql`, `raw_sql`, `statement`, or `query_sql`;
- inline database URLs or connection strings;
- model-facing args named like `tenant_id`, `principal`, `source_id`, `allowed_columns`, `row_version`, `schema`, `table`, or `column`;
- missing primary-key target;
- missing tenant guard unless `target.single_tenant_dev` is explicitly true;
- proposal capabilities with no `allowed_columns`;
- proposal capabilities with no fixed patch mapping;
- proposal capabilities with no conflict guard unless a weak-guard exception is explicitly acknowledged;
- unknown fields when strict mode is enabled.

## Example

```json
{
  "version": 1,
  "mode": "review",
  "storage": {
    "sqlite_path": "./.synapsor/local.db"
  },
  "sources": {
    "app_postgres": {
      "engine": "postgres",
      "read_url_env": "APP_POSTGRES_READ_URL",
      "write_url_env": "APP_POSTGRES_WRITE_URL",
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
  "contexts": {
    "local_billing_operator": {
      "provider": "environment",
      "values": {
        "tenant_id_env": "SYNAPSOR_TENANT_ID",
        "principal_env": "SYNAPSOR_PRINCIPAL"
      }
    }
  },
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
      "name": "billing.inspect_invoice",
      "kind": "read",
      "source": "app_postgres",
      "context": "local_billing_operator",
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
          "max_length": 128
        }
      },
      "lookup": {
        "id_from_arg": "invoice_id"
      },
      "visible_columns": ["id", "late_fee_cents", "waiver_reason", "updated_at"],
      "evidence": "required",
      "max_rows": 1
    },
    {
      "name": "billing.propose_late_fee_waiver",
      "kind": "proposal",
      "source": "app_postgres",
      "context": "local_billing_operator",
      "executor": "billing_api",
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
          "max_length": 128
        },
        "reason": {
          "type": "string",
          "required": true,
          "max_length": 500
        }
      },
      "lookup": {
        "id_from_arg": "invoice_id"
      },
      "visible_columns": ["id", "late_fee_cents", "waiver_reason", "updated_at"],
      "evidence": "required",
      "max_rows": 1,
      "patch": {
        "late_fee_cents": {
          "fixed": 0
        },
        "waiver_reason": {
          "from_arg": "reason"
        }
      },
      "allowed_columns": ["late_fee_cents", "waiver_reason"],
      "conflict_guard": {
        "column": "updated_at"
      },
      "approval": {
        "mode": "human",
        "required_role": "support_lead"
      }
    }
  ]
}
```

## Trusted context

Supported providers:

- `static_dev`: local/demo only; validator emits a warning.
- `environment`: reads trusted values from environment variables owned by the launching process.
- `http_claims`: reserved for authenticated HTTP deployments that verify claims before binding context.
- `cloud_session`: reserved for Cloud-linked mode with scoped runner/session context.

Model-facing tool arguments cannot override trusted context.

`contexts` is the preferred shape for larger configs. A capability with
`context: "local_billing_operator"` uses that named context. A capability
without `context` falls back to the global `trusted_context` for backward
compatibility. A missing named context fails validation.

## Writeback executors

Proposal capabilities default to `sql_update`, which means the trusted runner
applies one guarded single-row `UPDATE` after approval. Set
`executor: "billing_api"` to route approved proposals to a configured
`http_handler` or `command_handler` instead.

Executor URLs, commands, bearer tokens, and database credentials must be
environment-variable references. They are never model-facing MCP arguments and
are redacted from CLI/UI output. See `docs/writeback-executors.md`.
