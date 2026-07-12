# Runner Config Reference

`synapsor.runner.json` wires portable reviewed contracts to one local runtime.
It contains environment-variable names and fixed identifiers, never database
URLs, passwords, bearer tokens, prompts, or model-selected tenant authority.

Validate before serving:

```bash
synapsor-runner config validate --config ./synapsor.runner.json
```

Editor schema:

```text
schemas/synapsor.runner.schema.json
```

Unknown keys fail when `strict` is true (the default).

## Top-level keys

| Key | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Must be `1`. |
| `mode` | Yes | `read_only`, `shadow`, `review`, or `cloud`. |
| `result_format` | No | `1` legacy or `2` stable `ok/summary/data/proposal/error` envelope. Default `1`. |
| `strict` | No | Reject unknown config keys. Default `true`. |
| `storage` | Local | Local SQLite ledger plus optional shared Postgres mirror or runtime-store wiring. |
| `sources` | Local | Named Postgres/MySQL source wiring. |
| `trusted_context` | Conditional | Default trusted tenant/principal binding. |
| `contexts` | No | Named trusted contexts referenced by capabilities/contracts. |
| `contracts` | No | Portable contract file paths. Preferred for reviewed authoring. |
| `capabilities` | Conditional | Embedded compatibility capabilities; may be `[]` with `contracts`. |
| `policies` | No | Embedded reviewed policies; contract policies merge into the same catalog. |
| `approvals` | No | Local approval overrides. |
| `operator_identity` | No | Verified operator identity and apply-role wiring for approve/reject/apply. |
| `executors` | No | App-owned writeback wiring. |
| `cloud` | Cloud mode | Scoped Cloud adapter configuration. |

## Path resolution

- `contracts` entries resolve relative to the directory containing the config
  file. Every command uses this rule, including audit, validate, doctor, tools,
  smoke, MCP serve, propose, and apply.
- `storage.sqlite_path` is resolved by the Runner process working directory.
  Pass an absolute path when an MCP client launches Runner from another CWD.
- Executor paths/URLs come from environment variables, not relative contract
  content.

## Storage

```json
{
  "storage": {
    "sqlite_path": "./.synapsor/local.db",
    "shared_postgres": {
      "mode": "mirror",
      "url_env": "SYNAPSOR_LEDGER_DATABASE_URL",
      "schema": "synapsor_runner",
      "lock_timeout_ms": 10000
    }
  }
}
```

The ledger stores proposals, visible evidence copies, query audit, approvals,
receipts, events, and replay. New POSIX stores are owner-only (`0600`). Protect
the file like a database extract; see [Store Lifecycle](store-lifecycle.md).

`storage.shared_postgres.mode = "mirror"` makes mutating CLI commands restore
from the shared Postgres ledger before the local mutation and sync back after
the command while holding a schema-scoped Postgres advisory lock. Mirror mode is
a bounded operator handoff bridge; MCP serving still uses the local SQLite
store.

`storage.shared_postgres.mode = "runtime_store"` makes MCP serving use the
shared Postgres ledger as the primary proposal/evidence/replay store. Runner
creates a connection from the environment variable named by `url_env`, auto-runs
the shared-ledger migration at startup, and uses a schema-scoped transaction
advisory lock around runtime mutations. The URL is still referenced by
environment variable name; never put the database URL in the config file.
Bounded CLI approval/apply/worker commands bridge through the same Postgres
ledger by restoring into a temporary local store under the Postgres advisory
lock, running the existing mutation, and syncing back. Long-running worker
processes repeat bounded drain cycles and release the advisory lock while idle.

`synapsor-runner doctor --config ./synapsor.runner.json` checks shared Postgres
wiring when this block is present: the URL env var must be set, and the
configured schema must already contain `ledger_entries`, `proposal_locks`, and
`worker_leases`. Doctor reports env var names and table readiness only; it does
not print database URLs or create the schema.

## Sources

```json
{
  "sources": {
    "billing_postgres": {
      "engine": "postgres",
      "read_url_env": "BILLING_POSTGRES_READ_URL",
      "write_url_env": "BILLING_POSTGRES_WRITE_URL",
      "read_only": false,
      "statement_timeout_ms": 3000
    }
  }
}
```

`engine` is `postgres` or `mysql`. `read_url_env` is required. Use a
least-privilege read credential. `write_url_env` is optional unless direct SQL
writeback must apply; it should name a separate restricted writer. `read_only:
true` forbids direct SQL writeback. `statement_timeout_ms` is a positive read
timeout. `ssl` carries adapter-specific reviewed SSL options when used.

A contract's `SOURCE billing_postgres` must exactly match a `sources` key.

## Trusted context

```json
{
  "trusted_context": {
    "provider": "environment",
    "values": {
      "tenant_id_env": "SYNAPSOR_TENANT_ID",
      "principal_env": "SYNAPSOR_PRINCIPAL"
    }
  }
}
```

Providers are `environment`, `static_dev`, `http_claims`, and `cloud_session`.
`static_dev` is only for local fixtures. Named `contexts` use the same shape.
Capabilities may reference a context by name. The model never receives tenant
or principal as an overridable argument.

For multi-tenant Streamable HTTP services, use `http_claims` plus signed
session auth:

```json
{
  "trusted_context": {
    "provider": "http_claims",
    "values": {
      "tenant_id_key": "tenant_id",
      "principal_key": "sub"
    }
  },
  "session_auth": {
    "provider": "jwt_hs256",
    "secret_env": "SYNAPSOR_SESSION_JWT_SECRET",
    "previous_secret_env": "SYNAPSOR_PREVIOUS_SESSION_JWT_SECRET",
    "issuer": "https://identity.example",
    "audience": "synapsor-runner"
  }
}
```

`previous_secret_env` is optional and is only for rotation windows. Runner tries
the active secret first, then the previous secret. Existing MCP sessions remain
bound to the exact token fingerprint, so clients cannot swap tenant/principal
identity inside an initialized session.

## Contracts and embedded capabilities

```json
{
  "contracts": ["./billing.contract.json"],
  "capabilities": []
}
```

Contracts are normalized `@synapsor/spec` JSON. Runner merges their contexts,
capabilities, and policies into one runtime catalog. Duplicate names across
embedded config and contracts fail; there is no silent shadowing.

Embedded capabilities remain supported for generated/legacy configs. Their
fields are documented in the JSON Schema and
[Capability Authoring](capability-authoring.md): fixed target, args, primary-key
lookup, visible fields, evidence, patch allowlist, bounds/transitions, conflict
guard, approval, and writeback mode.

## Executors

```json
{
  "executors": {
    "billing_handler": {
      "type": "http_handler",
      "url_env": "BILLING_HANDLER_URL",
      "method": "POST",
      "auth": {
        "type": "bearer_env",
        "token_env": "BILLING_HANDLER_TOKEN"
      },
      "signing_secret_env": "BILLING_HANDLER_SIGNING_SECRET",
      "timeout_ms": 5000
    }
  }
}
```

Types are `sql_update`, `http_handler`, and `command_handler`. HTTP handlers use
`url_env`, optional `POST|PUT|PATCH`, bearer auth, signing secret, and timeout.
Command handlers use `command_env` and timeout. Secrets stay in the environment.
See [Writeback Executors](writeback-executors.md).

## Policies and approvals

`policies` is an array of reviewed policy objects. Local approval policies use
`kind: "approval"` and numeric rules such as `{ "field": "amount_cents",
"max": 2500 }`. Canonical policies may also carry daily `count` or `total`
limits scoped to `tenant_policy` or `tenant_policy_object`. These limits come
from reviewed DSL `LIMIT` clauses, not an unreviewed local override. A tripped
limit falls back to human review and is recorded in the ledger.
`approvals.disable_auto_approval: true` disables local policy auto-approval
without changing the reviewed contract. Approval never becomes an MCP tool.

## Operator identity

Local development compatibility uses an explicitly unverified environment
identity:

```json
{
  "operator_identity": {
    "provider": "dev_env",
    "actor_env": "SYNAPSOR_OPERATOR_ID",
    "roles_env": "SYNAPSOR_OPERATOR_ROLES",
    "apply_roles": ["writeback_operator"]
  }
}
```

Shared or production-like operation should register signed operator keys:

```json
{
  "operator_identity": {
    "provider": "signed_key",
    "apply_roles": ["writeback_operator"],
    "operators": {
      "alice": {
        "public_key_path": "./operators/alice.pub.pem",
        "roles": ["support_reviewer", "writeback_operator"]
      }
    }
  }
}
```

The public key path resolves relative to `synapsor.runner.json`. Keep the
private key outside the repository and invoke decisions with `--identity alice
--identity-key /secure/path/alice.pem`. Runner verifies key possession and the
contract's required role, then binds the exact proposal hash/version, action,
subject, timestamp, roles, signature, and integrity hash into the approval
ledger. `apply_roles` independently gates writeback. The local browser UI
refuses approval/rejection in signed-key mode so it cannot bypass this check.

## Cloud mode

Cloud mode omits local sources/capabilities and requires:

```json
{
  "version": 1,
  "mode": "cloud",
  "cloud": {
    "base_url_env": "SYNAPSOR_CLOUD_BASE_URL",
    "runner_token_env": "SYNAPSOR_RUNNER_TOKEN",
    "adapter_id": "mcp.billing",
    "runner_id": "runner_local_1",
    "project_id": "project_123",
    "engines": ["postgres"],
    "capabilities": ["adapter:read", "adapter:invoke"],
    "session": {}
  }
}
```

`base_url_env`, `runner_token_env`, and `adapter_id` are required. Optional keys
are `runner_id`, `runner_version`, `project_id`, `source_id`, `engines`, scoped
capability permissions, and trusted session metadata.

## Direct SQL readiness

An administrator must apply `writeback migration` once. The steady-state writer
needs target-table SELECT/allowed UPDATE plus receipt-table
SELECT/INSERT/UPDATE; it does not need schema CREATE.

```bash
synapsor-runner writeback migration --engine postgres --schema synapsor
synapsor-runner writeback grants --engine postgres \
  --schema synapsor --writer-role synapsor_writer
synapsor-runner doctor --config ./synapsor.runner.json --check-writeback
```

The doctor probe uses a rolled-back receipt insert and target-table check. It
does not mutate business rows.
