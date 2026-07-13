# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

Stop giving AI agents `execute_sql`. Give them reviewed business actions.

Synapsor Runner is an open-source, local-first MCP runtime for Postgres and
MySQL. It exposes semantic tools such as `billing.inspect_invoice` and
`billing.propose_late_fee_waiver`, saves risky changes as proposals, and keeps
database credentials, approval, and writeback outside the model-facing tool
surface.

## Prove It In 60 Seconds

The path is: **audit** your existing MCP risk, then **demo** the safety
boundary, then **connect** a staging database. The first two commands finish in
seconds and touch nothing but a local fixture file.

First, inspect the risk in a typical raw-SQL database MCP server. This works
even if you never adopt Runner:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Then point the same static review at your own exported tool manifest, remote
`tools/list` endpoint, or stdio MCP server:

```bash
npx -y @synapsor/runner audit ./tools-list.json
```

The audit flags raw SQL, arbitrary table/column inputs, model-controlled tenant
or principal authority, model-facing approval/writeback tools, and missing
conflict or idempotency signals. It does not call business tools, and it is a
risk review rather than proof that a server is secure. See [MCP Database Risk
Review](docs/mcp-audit.md) for remote, stdio, JSON, and Markdown workflows.

Then see the proposal, approval boundary, evidence, and replay loop. It needs no
database, Docker, config file, MCP client, or Synapsor account:

```bash
npx -y @synapsor/runner demo --quick
```

The quick demo creates a fixture ledger at `./.synapsor/quick-demo.db`. It
teaches the boundary; it does not claim to test your database connection.

## Safety Model

```text
AI agent or MCP client
        |
        | reviewed semantic tool
        v
+--------------------------------+
| Synapsor Runner MCP            |
| trusted tenant/principal scope |
| evidence + query audit         |
| proposals, not direct writes   |
+--------------------------------+
        |
        | scoped read / approved guarded writeback
        v
+--------------------------------+
| Your Postgres or MySQL         |
| source of truth                |
+--------------------------------+

Local SQLite ledger:
evidence -> proposal -> approval -> receipt -> replay
```

The model can inspect scoped data and propose an exact change. It cannot call
approval or apply tools. A human or trusted operator approves outside MCP, then
Runner either performs one guarded row update or routes the approved proposal
to an app-owned executor.

The distinction is the complete boundary, not a read-only toggle or a generic
approve/reject prompt:

- reviewed contracts constrain tools, tenant context, visible and writable
  columns, numeric bounds, transitions, and approval requirements;
- proposals separate model intent from commit authority, including aggregate
  auto-approval ceilings where configured;
- evidence, query audit, idempotency receipts, and replay preserve what was
  inspected, requested, approved, and applied.

Runner supports bounded production deployments when its documented database,
identity, ledger, backup, and operational controls are satisfied. It does not
make arbitrary agent code, raw SQL tools, host infrastructure, or
prompt-injection-prone clients safe by itself.

## Connect A Staging Database

Start with a staging or disposable database and a read-only credential. Keep
database permissions, restricted views, and row-level security in place.

```bash
npm install -g @synapsor/runner
export DATABASE_URL="postgresql://runner_reader:REPLACE_ME@db.example.com:5432/app?sslmode=require"
synapsor-runner start --from-env DATABASE_URL --schema public
```

The guided command inspects metadata, asks you to choose one table or view,
creates trusted context, generates reviewed capabilities, previews the MCP tool
surface, and prints the next smoke and serve commands. It stores environment
variable names, not connection strings.

The interesting part of the generated configuration is the capability entry: a
reviewed, tenant-scoped read with an explicit column allowlist and required
evidence. The storage, source, and trusted-context wiring around it (including
statement timeouts) is generated for you; the full file is in the
[own-database guide](docs/getting-started-own-database.md).

```json
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
    "invoice_id": { "type": "string", "required": true, "max_length": 128 }
  },
  "lookup": { "id_from_arg": "invoice_id" },
  "visible_columns": ["id", "tenant_id", "status", "late_fee_cents", "updated_at"],
  "evidence": "required",
  "max_rows": 1
}
```

Set the trusted values in the process that launches Runner, then validate and
preview the exact model-facing boundary before connecting an MCP client:

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local-developer"
synapsor-runner config validate --config ./synapsor.runner.json
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For proposal capabilities and writes, follow the
[complete own-database guide](docs/getting-started-own-database.md). One-row
updates can use Runner's guarded direct writeback. Inserts, multiple tables, or
external effects go through an [app-owned executor](docs/writeback-executors.md)
after approval.

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)**. It defines protected assets,
trust boundaries, covered threats, non-goals, and required operator controls.

- [Conformance fixtures](docs/conformance.md) prove trusted context, scoped
  reads, kept-out fields, proposal boundaries, approval, receipts, and replay
  behavior rather than only validating JSON shape.
- MCP proposal, evidence, and replay handles are references rather than bearer
  authority: resource reads re-check the owning tenant and principal against
  the current trusted session.
- `corepack pnpm test:live-apply` runs disposable Postgres and MySQL scenarios.
  It proves source rows stay unchanged before approval, guarded writeback
  applies once, idempotent retry does not duplicate the effect, and a stale row
  returns a conflict.
- The C++/Cloud round-trip verifier exports normalized contracts, validates
  them with `@synapsor/spec`, and loads them in Runner. The shared contract and
  verification commands are documented in [Conformance](docs/conformance.md).

Runner is a narrow agent/database safety boundary, not a replacement for
least-privilege database access, host security, or application authorization.
See [Security Boundary](docs/security-boundary.md) and
[Current Limitations](docs/limitations.md).

## Operate The Approval Loop

Reviewed policies can combine a per-proposal threshold with daily count and
total ceilings. Exceeding a ceiling routes that proposal to human review; it
never auto-applies. Operators can apply the bounded approved queue independently
with `apply --all-approved --yes`, inspect Prometheus counters with `metrics
show`, and consume safe newline-delimited JSON outcome logs from stderr. Signed
operator keys can enforce contract reviewer roles and separate apply roles.
Shared Postgres ledger mirror mode is available for bounded operator handoffs,
and `storage.shared_postgres.mode = "runtime_store"` lets MCP serving use
Postgres as the primary proposal/evidence/replay store with bounded CLI
approval/apply/worker commands bridged through the same ledger. Local SQLite
remains the default. See
[Production](docs/production.md) and the
[Runner Config Reference](docs/runner-config-reference.md).

For a small multi-tenant fleet, bind every capability context to verified HTTP
claims, use `jwt_asymmetric` session auth, and share a bounded Postgres
`runtime_store`. Never assume a global `http_claims` setting overrides an
environment-bound contract context; Runner rejects that contradiction before
serving tools. Load balancers should use dependency-free `/healthz` for
liveness and `/readyz` for source/ledger/writeback readiness. The tested
two-Runner topology, pool/rate-limit budgets, metrics, backup/restore,
dead-letter, and rolling-upgrade rules are in
[Running A Small Runner Fleet](docs/running-a-runner-fleet.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@synapsor/runner` | CLI, MCP runtime, local ledger, proposals, approval, guarded writeback, replay, and MCP audit. |
| `@synapsor/spec` | Canonical portable contracts for contexts, capabilities, workflows, evidence, proposals, receipts, and replay. |
| `@synapsor/dsl` | SQL-like authoring that compiles contexts, capabilities, and workflow declarations into canonical contract JSON. |

Runner executes locally. The spec is the portable contract shared by Runner
and Cloud/C++. The DSL gives that contract a reviewable source format. Start
with [Capability Authoring](docs/capability-authoring.md). Use `.synapsor.sql`
for DSL source files when you want editors to provide generic SQL highlighting;
legacy `.synapsor` files remain supported and produce the same contract JSON.

Use the [DSL Reference](docs/dsl-reference.md) for exact authoring grammar and
the [Runner Config Reference](docs/runner-config-reference.md) for every wiring
key, default, and path-resolution rule. The
[Store Lifecycle guide](docs/store-lifecycle.md) explains ledger sensitivity,
owner-only permissions, inspection commands, and retention.

## OSS And Cloud

Synapsor Runner works by itself for local, single-node, and bounded small-fleet
deployments: your database remains the source of truth and Runner stores review
artifacts in the default local SQLite ledger or an opt-in shared Postgres
runtime store.
Synapsor Cloud adds a shared contract registry, immutable versions,
downloadable Runner bundles, and team activity, evidence, and approval
surfaces. See [OSS Runner vs Synapsor Cloud](docs/oss-vs-cloud.md) for the
detailed boundary.

## Next Steps

- Run the [`support-plan-credit` flagship example](examples/support-plan-credit).
- Connect [Claude, Cursor, OpenAI Agents SDK, or another MCP client](docs/mcp-clients.md).
- Author and [push a validated contract to Cloud](docs/cloud-push.md).
- Browse the [task-first documentation index](docs/README.md).
- Report bugs or request features through [GitHub Issues](https://github.com/Synapsor/Synapsor-Runner/issues).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Maintainer and contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md).
