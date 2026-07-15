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
| `session_auth` | HTTP claims | HS256 development or asymmetric RS256/ES256 session-token verification. |
| `rate_limits` | No | Operational fixed-window limits; fleet-wide only with shared `runtime_store`. |
| `metrics` | No | Separately authorized scrapeable HTTP metrics. Disabled by default. |
| `graduated_trust` | No | Off-by-default, operator-only policy recommendation criteria and kill switch. |
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
      "lock_timeout_ms": 10000,
      "max_entries": 10000
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

The bridge loads at most `max_entries` ledger records per operation. The default
is 10,000; valid values are 100 through 100,000. It fails closed with
`POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED` above the bound. Reviewer CLI reads
and the local UI use the same shared queue. This is a serialized small-fleet
design, not an unbounded high-throughput primary store.

`synapsor-runner doctor --config ./synapsor.runner.json` checks shared Postgres
wiring when this block is present: the URL env var must be set, and the
configured schema must already contain `ledger_entries`, `proposal_locks`,
`worker_leases`, and `rate_limit_buckets`. Doctor reports env var names and
table readiness only; it does
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
      "statement_timeout_ms": 3000,
      "receipts": {
        "authority": "source_db",
        "provisioning": "precreated",
        "schema": "synapsor",
        "table": "writeback_receipts"
      }
    }
  }
}
```

`engine` is `postgres` or `mysql`. `read_url_env` is required. Use a
least-privilege read credential. `write_url_env` is optional unless direct SQL
writeback must apply; it should name a separate restricted writer. `read_only:
true` forbids direct SQL writeback. `statement_timeout_ms` is an
operator-controlled positive timeout used for reads and direct SQL writeback.
PostgreSQL applies it as transaction-local `statement_timeout` and
`lock_timeout`. MySQL applies it to read/preflight execution and rounds it up
to whole seconds for `innodb_lock_wait_timeout`; MySQL does not provide the
same general DML statement-timeout guarantee as PostgreSQL. `ssl` carries
adapter-specific reviewed SSL options when used.

A contract's `SOURCE billing_postgres` must exactly match a `sources` key.

Long-running servers reuse native driver pools. Optional `pool` keys are
`max_connections` (default 10), `connection_timeout_ms` (3000),
`idle_timeout_ms` (30000), `queue_timeout_ms` (5000), and `queue_limit`
(default `max(10, max_connections * 4)`). Queue overflow returns
`SOURCE_POOL_QUEUE_FULL`; acquisition timeout returns `SOURCE_POOL_TIMEOUT`.
With result envelope v2, these conditions and recognized transient driver
connection failures are model-facing `TEMPORARILY_UNAVAILABLE` errors with
`retryable: true` and a bounded `retry_after_ms`. Operational logs retain only
a normalized safe runtime code, not the driver message, host, or credentials.
One-shot CLI commands close their pools.

### Source receipts

`sources.<name>.receipts.authority` is `source_db` or `runner_ledger`.

- `source_db` requires `provisioning: "precreated"` or `"auto_migrate"`.
  Optional fixed `schema` and `table` identifiers select the receipt table.
  The source mutation and receipt share one transaction.
- `runner_ledger` forbids `provisioning`, `schema`, and `table`. It creates no
  source receipt table. Local SQLite is permitted for one process;
  networked/multi-Runner use requires authoritative shared Postgres
  `runtime_store` and rejects mirror mode.

Existing configs without `receipts` retain the compatibility source-receipt
behavior. New onboarding asks explicitly. Runner-ledger UPDATE requires exact
version advancement; INSERT requires source-enforced deduplication; DELETE
requires an exact version guard. Ambiguous post-commit outcomes stop at
`reconciliation_required`. See
[Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md).

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

For networked deployments prefer asymmetric public-key verification:

```json
{
  "session_auth": {
    "provider": "jwt_asymmetric",
    "algorithms": ["RS256"],
    "jwks_url_env": "SYNAPSOR_SESSION_JWKS_URL",
    "issuer": "https://identity.example",
    "audience": "synapsor-runner",
    "tenant_claim": "tenant_id",
    "principal_claim": "sub",
    "clock_skew_seconds": 30,
    "jwks_cache_seconds": 600,
    "jwks_cooldown_seconds": 30,
    "fetch_timeout_ms": 3000,
    "max_response_bytes": 1048576
  }
}
```

`jwt_asymmetric` requires an explicit `RS256`/`ES256` allowlist and exactly one
public-key source: `jwks_url_env`, `public_key_env`, or `public_key_path`.
JWKS selection uses `kid`; unknown keys get one controlled refresh. Fetches are
timeout/size bounded and do not follow redirects. Private JWK fields are
rejected. Every effective named context in an `http_claims` server must bind
tenant and principal from claims; environment/static contradictions fail with
`TRUSTED_CONTEXT_PROVIDER_CONFLICT` before serving.

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

## Bounded set operation fields

A set operation is portable reviewed authority, so it can arrive from a
contract or the equivalent embedded capability:

```json
{
  "operation": {
    "kind": "update",
    "cardinality": "set",
    "selection": {
      "all": [{ "column": "status", "operator": "eq", "value": "overdue" }]
    },
    "max_rows": 10,
    "aggregate_bounds": [
      { "column": "balance_cents", "measure": "before", "maximum": 50000 }
    ],
    "version_advance": { "column": "version", "strategy": "integer_increment" }
  },
  "approval": { "mode": "human", "required_role": "billing_reviewer" },
  "writeback": { "mode": "direct_sql" }
}
```

Set UPDATE/DELETE requires one through eight fixed equality terms in
`selection.all`; the model cannot add or override them. Every set requires
`max_rows` from 1 through 100 and one through eight aggregate bounds. Set
UPDATE requires integer version advancement. Batch INSERT instead declares
`operation.batch.items_from_arg` pointing to a bounded `object_array` argument
and item-field dedup components. All forms require human/operator approval and
direct SQL writeback in 1.3. See [Bounded Set
Writeback](bounded-set-writeback.md).

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

Types are `sql_update`, `http_handler`, and `command_handler`. The legacy
`sql_update` executor identifier now dispatches the reviewed native operation
(`insert`, `update`, or `delete`) and remains named for config compatibility.
HTTP handlers use
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
Portable `approval.required_approvals` defaults to `1` and accepts `1..10`.
Distinct verified subjects fill quorum slots; one subject cannot count twice.
A rejection is terminal. Policy auto-approval is deferred when quorum is
greater than one.

## Rate limits

```json
{
  "rate_limits": {
    "enabled": true,
    "default": { "requests": 60, "window_seconds": 60 },
    "capabilities": {
      "billing.propose_refund": { "requests": 10, "window_seconds": 60 }
    }
  }
}
```

Rules are fixed-window deployment controls keyed by trusted tenant plus
reviewed capability. There is no separate burst allowance: all configured
requests may arrive immediately, but the next request is rejected until the
aligned window resets. They are process-local with SQLite and fleet-wide/atomic
with shared `runtime_store`. `RATE_LIMITED` includes `retry_after_ms` to that
reset boundary, records a counter, and creates no proposal. Rate limits are
runtime wiring and never portable contract fields.

## HTTP metrics

```json
{
  "metrics": {
    "enabled": true,
    "token_env": "SYNAPSOR_METRICS_TOKEN"
  }
}
```

`/metrics` is disabled by default. Non-loopback exposure requires a separate
metrics token; the MCP bearer does not authorize metrics. Labels are bounded to
trusted tenant, capability, source, engine, and readiness component. Object
IDs, principals, URLs, tokens, and raw errors are never labels.

## Graduated trust

`graduated_trust` is runtime/operator policy, not model-facing authority. It is
disabled unless `enabled` is exactly `true`; `kill_switch: true` stops all
evaluation. Each criterion fixes one capability, approval policy, numeric
field, minimum human-reviewed sample (10..10000), window (1..365 days), maximum
rejection/conflict/failure/revert rates, maximum threshold increment, and
absolute ceiling. Optional `workspace_id` and `project_id` further scope stored
recommendations.

Auto-approved outcomes never count as human evidence. Recommendation decisions
require verified operator identity. Approval only permits exporting a new
contract artifact bound to the current digest/version; Runner never activates
it. See [Graduated Trust Recommendations](graduated-trust.md).

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

For OIDC-style operator identity, use `provider: "jwt_oidc"` with the same
asymmetric public-key options as session auth, plus one token source:
`token_env`, `token_file_env`, or `token_stdin: true`. With stdin, pipe or paste
one token and close stdin; combine it with `--yes` so confirmation does not
compete for the stream. Also configure `roles_claim`, `subject_claim`, and an
`attestation_secret_env` containing at least 32 bytes. Runner persists verified
subject/roles/issuer/key ID and an attested decision proof, never the bearer
token. Tokens must not be passed as command-line arguments.

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

For `source_db` + `precreated`, an administrator applies `writeback migration`
once. The steady-state writer needs target-table `SELECT` and only the reviewed
operation DML plus receipt-table `SELECT`/`INSERT`/`UPDATE`; it does not need
schema `CREATE`.

```bash
synapsor-runner writeback migration --engine postgres --schema synapsor
synapsor-runner writeback grants --engine postgres \
  --schema synapsor --writer-role synapsor_writer
synapsor-runner doctor --config ./synapsor.runner.json --check-writeback
```

`source_db` + `auto_migrate` runs that fixed migration idempotently and needs
bounded `CREATE`. `runner_ledger` skips source receipt DDL/DML and validates its
authoritative ledger topology. Doctor uses rollback-only receipt and target
checks and does not mutate business rows. See
[Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md).
