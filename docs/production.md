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
-> guarded one-row update or app-owned executor
-> receipt/replay
```

Use this only for bounded database workflows where you can accept a single-node
local ledger and local/operator approval. Use Synapsor Cloud when you need HA,
central audit, RBAC/SSO, multi-reviewer approvals, hosted retention, managed
runners, policy packs, or production support/SLA.

## Supported Scope

Production-candidate OSS scope:

- Postgres/MySQL reads through fixed semantic MCP tools;
- trusted context from environment/session values, not model arguments;
- local SQLite ledger for evidence, query audit, proposals, receipts, replay,
  and lifecycle events;
- direct guarded single-row `UPDATE` for simple approved edits;
- app-owned `http_handler` or `command_handler` executors for richer approved
  business transactions;
- stdio MCP and Streamable HTTP MCP.

Out of scope:

- raw `execute_sql` or model-generated SQL;
- generic direct `INSERT`, `DELETE`, `UPSERT`, DDL, or multi-row SQL writeback;
- physical branching of external Postgres/MySQL;
- workflow DAGs, auto-merge/settlement, RBAC/SSO, HA ledger, or compliance
  retention;
- making prompt injection impossible.

## Database Roles

Use separate read and write credentials.

Read credential:

- can connect to the selected database;
- can inspect metadata for selected schemas;
- can `SELECT` only the tables/views used by capabilities;
- should be restricted by views/RLS where possible.

Write credential for direct `sql_update`:

- can update only the allowed business columns;
- cannot modify primary-key or tenant columns;
- can `SELECT`/`INSERT`/`UPDATE` the administrator-created
  `synapsor_writeback_receipts` table;
- does not need schema `CREATE` during doctor or apply;
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

## Receipt Table

Direct SQL writeback stores idempotency receipts in the source database. Runner
expects an administrator to create this table before steady-state operation:

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

Grant only receipt-table `SELECT`/`INSERT`/`UPDATE` and schema usage to the
writer; schema `CREATE` is not required by doctor or apply. Use an app-owned
executor when receipt storage belongs inside your application boundary.

## Direct Writeback Vs App-Owned Executor

Use direct `sql_update` when the approved change is:

```text
one existing row -> one allowed-column patch -> one guarded UPDATE
```

Use an app-owned executor when the change is richer:

- insert a credit/refund/review row;
- update more than one row;
- touch more than one table;
- emit an event or call another internal service;
- enforce business logic that belongs in your app.

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
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --dry-run
synapsor-runner store vacuum --store ./.synapsor/local.db
```

Details: [Store Lifecycle](store-lifecycle.md).

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
secrets in environment variables or your platform secret manager.

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
