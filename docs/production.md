# Production-Candidate Guide

Synapsor Runner is not self-hosted Synapsor Cloud. This guide is for the
narrow OSS production-candidate shape:

```text
MCP agent
-> reviewed semantic capability
-> trusted tenant/principal context
-> scoped Postgres/MySQL read
-> evidence/query audit/proposal
-> approval outside MCP
-> guarded one-row CRUD, bounded frozen set, or app-owned executor
-> receipt/replay
```

Use this only for bounded database workflows using either the default
single-node SQLite ledger or the tested, serialized small-fleet Postgres
runtime store. Use Synapsor Cloud when you need a managed fleet, hosted central
audit, organization administration, SSO/SCIM, compliance retention, or a
production support/SLA. See [Running A Small Runner
Fleet](running-a-runner-fleet.md) for the exact OSS fleet guarantees and limits.

## Audit The Agent-Facing Surface First

Before configuring writeback or connecting a production-like database, audit
the MCP tools the agent can see. Start with Runner's built-in risky database MCP
example:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Then audit the actual manifest, remote MCP endpoint, or stdio server you intend
to expose:

```bash
synapsor-runner audit ./tools-list.json
synapsor-runner audit https://mcp.example.com --bearer-env MCP_AUDIT_TOKEN
synapsor-runner audit 'stdio:node ./server.mjs'
```

Audit is a static risk review, not proof that an MCP server is secure. Treat
generic SQL/query tools, model-controlled tenant or principal fields, and
model-facing approval/apply tools as deployment blockers. See [MCP
Audit](mcp-audit.md) for supported inputs, findings, and machine-readable output.

## Supported Scope

Production-candidate OSS scope:

- Postgres/MySQL reads through fixed semantic MCP tools;
- trusted context from environment/session values, not model arguments;
- local SQLite ledger for evidence, query audit, proposals, receipts, replay,
  and lifecycle events;
- bounded shared Postgres runtime ledger for several claim-bound HTTP Runner
  instances and verified reviewers;
- asymmetric RS256/ES256 session authentication, readiness probes, separately
  protected metrics, source pools, and fleet-wide rate limits;
- distinct-reviewer approval quorum from the canonical contract;
- direct guarded single-row `INSERT`, `UPDATE`, and `DELETE` for approved
  operations whose source constraints satisfy the operation-specific guards;
- fixed-predicate set `UPDATE`/`DELETE` and exact-review batch `INSERT`, with
  human approval, mandatory row/value caps, a hard 100-row ceiling, frozen
  members, atomic execution, and exact per-member receipts;
- app-owned `http_handler` or `command_handler` executors for richer approved
  business transactions;
- stdio MCP and Streamable HTTP MCP.

Out of scope:

- raw `execute_sql` or model-generated SQL;
- direct `UPSERT`, DDL, model-generated predicates, unbounded set writes,
  cross-table transactions, or INSERT/DELETE whose source constraints cannot
  prove the reviewed effect;
- physical branching of external Postgres/MySQL;
- workflow DAGs, auto-merge/settlement, hosted team administration, SSO/SCIM,
  multi-region ledger replication, or compliance retention;
- making prompt injection impossible.

## Database Roles

Use separate read and write credentials.

Read credential:

- can connect to the selected database;
- can inspect metadata for selected schemas;
- can `SELECT` only the tables/views used by capabilities;
- should be restricted by views/RLS where possible.

Write credential for direct `sql_update`:

- can use only the operation-specific business DML and reviewed columns;
- cannot modify primary-key or tenant columns;
- has source receipt-table `SELECT`/`INSERT`/`UPDATE` only when receipt
  authority is `source_db`;
- needs schema `CREATE` only for explicitly selected `auto_migrate` receipt
  provisioning;
- is never exposed to MCP clients.

Example config:

```json
{
  "sources": {
    "billing_postgres": {
      "engine": "postgres",
      "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL"
    }
  }
}
```

`synapsor-runner apply --config ...` reads the writer env var named by
`write_url_env`. `SYNAPSOR_DATABASE_URL` is only a legacy fallback for direct
worker flows that do not pass a local config.

Set `statement_timeout_ms` on each production source. PostgreSQL direct
writeback uses it for transaction-local statement and lock limits. MySQL uses
it for preflight execution and InnoDB lock waits; because MySQL does not apply
`max_execution_time` to general DML, keep bounded sets small and enforce
source-side operational query limits too.

## Receipt Authority

Direct SQL writeback supports atomic `source_db` receipts and
zero-source-schema `runner_ledger` receipts. For source receipts, choose an
administrator-precreated table or explicit idempotent auto-migration:

```sql
CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (...);
```

Before using direct writeback in staging or production-like environments:

```bash
synapsor-runner writeback migration --engine postgres
synapsor-runner writeback grants --engine postgres --writer-role app_writer
synapsor-runner doctor --config synapsor.runner.json --check-writeback
```

For MySQL, replace `postgres` with `mysql`.

Grant only receipt-table `SELECT`/`INSERT`/`UPDATE` and schema usage in
`precreated` mode. `auto_migrate` additionally needs bounded `CREATE`.
`runner_ledger` needs neither source receipt-table grants nor `CREATE`, but an
ambiguous crash after source commit requires operator reconciliation and is not
distributed exactly-once. See
[Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md) for the complete
mode, operation, and privilege matrix.

## Direct Writeback Vs App-Owned Executor

Use direct writeback when the approved change is either:

```text
one reviewed row -> one guarded INSERT/UPDATE/DELETE -> one exact effect

or

one fixed reviewed rule/item list -> <= 100 frozen rows -> one atomic bounded set
```

Use an app-owned executor when the change is richer:

- choose rows from a model-supplied predicate or exceed the reviewed cap;
- touch more than one table;
- emit an event or call another internal service;
- enforce business logic that belongs in your app.

Bounded sets must satisfy every invariant in [Bounded Set
Writeback](bounded-set-writeback.md); otherwise they remain executor work.

Handlers must re-check tenant/scope, expected version, idempotency, allowed
business action, transaction boundaries, and safe errors. See
[Writeback Executors](writeback-executors.md) and
[Handler Helper](handler-helper.md).

## Local Ledger

Default local ledger path:

```text
./.synapsor/local.db
```

This SQLite file stores local evidence, query audit, proposals, approvals,
receipts, replay, and events. Back it up like local operational state if you
depend on replay after restarts.

Recommended single-node practices:

- keep the ledger on persistent disk;
- back up `local.db`, `local.db-wal`, and `local.db-shm` together when the
  server is stopped, or use your platform's filesystem snapshot mechanism;
- do not run multiple active MCP server modes against the same ledger unless
  you intentionally pass `--allow-concurrent-store` for local debugging;
- use `store prune --dry-run` before retention cleanup;
- use `store vacuum` during a planned maintenance window.

Useful commands:

```bash
synapsor-runner store stats --store ./.synapsor/local.db
synapsor-runner events tail --store ./.synapsor/local.db --follow
synapsor-runner metrics show --store ./.synapsor/local.db
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --dry-run
synapsor-runner store vacuum --store ./.synapsor/local.db
```

Details: [Store Lifecycle](store-lifecycle.md).

## Shared Postgres Ledger Setup

The default runtime ledger is SQLite. For shared deployments, Runner now ships a
Postgres ledger setup surface that creates the schema used for shared audit
entries, proposal locks, and worker leases:

```bash
export SYNAPSOR_LEDGER_DATABASE_URL="postgresql://ledger_writer:..."

synapsor-runner store shared-postgres migration --schema synapsor_runner
synapsor-runner store shared-postgres apply-migration \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL \
  --schema synapsor_runner \
  --yes
synapsor-runner store shared-postgres status \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL \
  --schema synapsor_runner
synapsor-runner store shared-postgres sync \
  --store ./.synapsor/local.db \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL \
  --schema synapsor_runner \
  --yes
synapsor-runner store shared-postgres restore \
  --store ./.synapsor/restored.db \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL \
  --schema synapsor_runner \
  --yes
```

These commands do not print the database URL. `sync` upserts a stable snapshot
of the local proposal/evidence/replay ledger into Postgres for shared audit,
backup, and retention. `restore` rebuilds a local SQLite store from those
shared ledger entries for recovery or offline investigation.

Runner supports two shared Postgres modes:

- `mirror`: bounded CLI mutations restore from Postgres into local SQLite,
  mutate locally, then sync back under a schema-scoped advisory lock.
- `runtime_store`: MCP serving uses Postgres as the primary
  proposal/evidence/replay store instead of opening a local SQLite store.

Local SQLite remains the default. Use `runtime_store` when several MCP sessions
or runner processes need to share proposal/evidence/replay state through one
ledger database. Use `mirror` when you want bounded operator handoff while still
running CLI mutations against a local SQLite file.

Mirror mode config:

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

```bash
export SYNAPSOR_LEDGER_DATABASE_URL="postgresql://ledger_writer:..."

synapsor-runner doctor \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db

synapsor-runner propose support.propose_plan_credit --sample \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db

synapsor-runner proposals approve latest --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db

synapsor-runner apply --all-approved --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

When `storage.shared_postgres.mode` is `mirror`, `doctor` checks that the
ledger URL environment variable is present and that `ledger_entries`,
`proposal_locks`, `worker_leases`, and `rate_limit_buckets` exist in the
configured schema. It reports
environment variable names and table readiness only; it does not print database
URLs or initialize the schema.

Mirror mode restores the Postgres ledger into the local store before a mutation
and syncs the local store back after the command, including failure events when
they were recorded locally. While it runs, Runner holds a schema-scoped
Postgres advisory lock so concurrent mirror-mode operators do not restore,
mutate, and sync over one another. The default lock wait is 10 seconds; tune it
with `--shared-ledger-lock-timeout-ms` or
`SYNAPSOR_SHARED_LEDGER_LOCK_TIMEOUT_MS`.

Mirror mode is explicit because the local SQLite store still executes the CLI
mutation. It is useful for bounded operator workflows and finite workers
(`worker run --once` or `--drain`); use `runtime_store` for long-lived MCP
serving and shared worker loops that need one proposal/evidence/replay ledger.

Runtime-store mode config:

```json
{
  "storage": {
    "shared_postgres": {
      "mode": "runtime_store",
      "url_env": "SYNAPSOR_LEDGER_DATABASE_URL",
      "schema": "synapsor_runner",
      "lock_timeout_ms": 10000
    }
  }
}
```

When MCP serving starts in `runtime_store` mode, Runner opens the Postgres URL
from `url_env`, auto-runs the shared-ledger migration, and serializes runtime
mutations with a transaction-scoped advisory lock. The MCP tools still expose no
database URLs or write credentials to the model.

`runtime_store` covers MCP serving, CLI approval/apply, and supervised worker
runs. For CLI mutations, Runner restores the shared ledger into a temporary
local store while holding the Postgres advisory lock, runs the existing local
mutation, then syncs the resulting ledger entries back to Postgres. A
long-running `worker run --yes` repeats bounded drain cycles under that lock
and sleeps between idle polls, so multiple workers can share one Postgres ledger
without holding the lock while idle.

The current bridge loads a bounded snapshot and serializes each mutation. It
fails closed above `max_entries`; it is not an unbounded scalable database
engine. `proposals`, `evidence`, `query-audit`, `receipts`, `replay`,
`activity`, `metrics`, worker status, and the local UI can read the same shared
queue with `--config`. Back up, verify, restore, and archive-before-retention
with the commands in [Running A Small Runner Fleet](running-a-runner-fleet.md).

For unattended policy-approved queues, declare reviewed aggregate `LIMIT`
clauses first, then use the explicit batch command:

```bash
synapsor-runner apply --all-approved --yes \
  --config ./synapsor.runner.json --store ./.synapsor/local.db \
  --capability support.propose_plan_credit --tenant acme --max 20
```

Each proposal is independent: a stale-row conflict does not abort later jobs.
In `runtime_store` mode, the batch holds one authoritative bridge while every
selected item applies, then syncs the resulting states, receipts, and events
back together. The final summary reports applied, conflict, and skipped IDs;
every skipped item includes a safe reason. Re-running is idempotent through
durable receipts. Do not schedule batch apply for a policy that has no reviewed
aggregate limits.

Runner writes newline-delimited JSON events to stderr for model-facing tool
rejections, operator decisions, and terminal writeback outcomes. These events
contain safe codes and identifiers, never tool arguments, row values, database
URLs, tokens, private keys, or free-form driver errors. Prometheus/OpenMetrics
counters are available with `metrics show` and are grouped by trusted tenant
and reviewed capability.

## Restart And Recovery

Runner stores proposal/evidence/replay state before writeback.

Expected restart behavior:

- after proposal creation: proposal, evidence, query audit, and replay remain
  inspectable from the local ledger;
- after approval but before apply: rerun `apply`; the approved proposal remains
  pending until a terminal receipt is recorded;
- after apply succeeds: retry returns an idempotent receipt, not a second write;
- after stale row or tenant mismatch: retry returns the recorded conflict path.

Inspection commands:

```bash
synapsor-runner proposals show latest --store ./.synapsor/local.db
synapsor-runner receipts list --proposal wrp_... --store ./.synapsor/local.db
synapsor-runner replay show latest --store ./.synapsor/local.db
synapsor-runner activity search --proposal wrp_... --store ./.synapsor/local.db
```

## Deployment Recipes

### Docker Compose Shape

Use Compose to run the MCP server next to your app and database network. Keep
secrets in environment variables or your platform secret manager. To hydrate
Runner env vars from AWS Secrets Manager at startup, pass a JSON map through
`SYNAPSOR_SECRET_MAP`:

```bash
export SYNAPSOR_SECRET_MAP='{
  "SYNAPSOR_DATABASE_READ_URL": "prod/synapsor/runner#read_url",
  "SYNAPSOR_DATABASE_WRITE_URL": "prod/synapsor/runner#write_url",
  "SYNAPSOR_RUNNER_HTTP_TOKEN": "prod/synapsor/runner#http_token"
}'

synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --secrets-provider aws-secretsmanager-cli \
  --secret-map-env SYNAPSOR_SECRET_MAP
```

The AWS provider shells out to `aws secretsmanager get-secret-value`; the runner
logs only how many target env vars were loaded or skipped.

```yaml
services:
  synapsor-runner:
    image: node:22-bookworm
    working_dir: /app
    command: >
      sh -lc "npm install -g @synapsor/runner &&
      synapsor-runner up --review --config /config/synapsor.runner.json
      --store /data/local.db --host 0.0.0.0 --port 8766"
    environment:
      SYNAPSOR_DATABASE_READ_URL: ${SYNAPSOR_DATABASE_READ_URL}
      SYNAPSOR_DATABASE_WRITE_URL: ${SYNAPSOR_DATABASE_WRITE_URL}
      SYNAPSOR_TENANT_ID: ${SYNAPSOR_TENANT_ID}
      SYNAPSOR_PRINCIPAL: ${SYNAPSOR_PRINCIPAL}
    volumes:
      - ./synapsor.runner.json:/config/synapsor.runner.json:ro
      - synapsor-runner-data:/data
    ports:
      - "8766:8766"

volumes:
  synapsor-runner-data:
```

### systemd Shape

```ini
[Unit]
Description=Synapsor Runner MCP server
After=network-online.target

[Service]
Type=simple
User=synapsor-runner
WorkingDirectory=/opt/synapsor-runner
EnvironmentFile=/etc/synapsor-runner.env
ExecStart=/usr/bin/synapsor-runner up --review --config /etc/synapsor.runner.json --store /var/lib/synapsor-runner/local.db --host 127.0.0.1 --port 8766
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Put database credentials in `/etc/synapsor-runner.env` or your system secret
manager, not in `synapsor.runner.json`.

## TLS And SSL

For staging or production-like databases:

- keep certificate verification enabled;
- use provider CA bundles when required;
- do not use `sslmode=disable` except disposable local fixtures;
- do not document or paste real DB URLs into logs, tickets, prompts, or MCP
  client config.

For disposable local Docker fixtures, `sslmode=disable` is acceptable when the
database is bound to loopback and contains only test data.

## Health And Doctor

Run these before exposing tools to an agent:

```bash
synapsor-runner config validate --config synapsor.runner.json
synapsor-runner doctor --config synapsor.runner.json --report --redact --output synapsor-doctor.md
synapsor-runner doctor --config synapsor.runner.json --check-writeback
synapsor-runner tools preview --config synapsor.runner.json --store ./.synapsor/local.db
curl --fail http://127.0.0.1:8766/healthz
curl --fail http://127.0.0.1:8766/readyz
```

Doctor reports should be redacted by default before sharing. They must not
include database passwords, bearer tokens, handler secrets, or raw driver
connection strings.

## Logging And Redaction

Expected public outputs must avoid secrets in:

- demo output;
- doctor reports;
- evidence exports;
- query-audit output;
- replay exports;
- thrown errors and logs.

If you find a leak, treat it as a security bug. See [SECURITY.md](../SECURITY.md).

## Release Gate

Before promoting a package or calling a build production-candidate:

```bash
./scripts/verify-release-gate.sh
```

The release gate should cover typecheck, focused tests, packed-package install,
quick demo, own-db fixture, MCP stdio/HTTP checks, direct writeback,
app-owned executor paths, package dry-run, and docs/package consistency.
