# Local capability config

Synapsor Runner uses a strict JSON capability config for local MCP/database safety work.

YAML can be added later, but the first supported format is JSON so the runtime can validate untrusted config without adding a parser dependency.

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
  "capabilities": [
    {
      "name": "billing.inspect_invoice",
      "kind": "read",
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
