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
approval, apply, or revert tools. A human or trusted operator approves outside
MCP, then Runner performs a guarded write or routes the proposal to an
app-owned executor.

Contracts constrain tools, trusted context, visible and writable columns,
bounds, transitions, and approvals. Proposals separate model intent from commit
authority; evidence, query audit, receipts, and replay preserve the reviewed
lifecycle. Runner does not make raw SQL tools, hosts, or
prompt-injection-prone clients safe.

## Why Not Just Use A Prompt And App Code?

Prompts are not an authorization boundary. First ask who produces the SQL:

- **The model produces SQL:** validation must understand arbitrary queries,
  scope, and side effects. That is `execute_sql` behind a parser.
- **Trusted app code produces fixed, parameterized SQL:** good. You have built
  a semantic tool, and that may be enough for a small read-only application.

Runner adds one reviewed contract for trusted scope, field controls, evidence,
approval outside MCP, guarded writeback, receipts, replay, and compensation.
Use your own code when you do not need that lifecycle. See the [build-vs-adopt
guide](docs/why-synapsor-vs-app-guardrails.md).

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

The generated capability is a tenant-scoped read with an explicit column
allowlist and required evidence. See the [own-database
guide](docs/getting-started-own-database.md) for the full configuration.

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
[complete own-database guide](docs/getting-started-own-database.md). Reviewed
single-row INSERT, UPDATE, and DELETE can use Runner's guarded direct
writeback. Runner also supports tightly [bounded set
writes](docs/bounded-set-writeback.md): fixed-predicate UPDATE/DELETE and
exact-review batch INSERT, with human approval, a hard 100-row ceiling, atomic
apply, and exact receipts. Free-form predicates, unbounded or cross-table work,
and external effects go through an [app-owned
executor](docs/writeback-executors.md) after approval.

Direct writes can use [reviewed
compensation](docs/reversible-change-sets.md). Receipts capture a
bounded inverse; `synapsor-runner revert <proposal_id>` creates a separately
approved proposal. This is not rollback, time travel, or app-owned
compensation.

## Review And Prove Your Contract

Before serving a contract, use `contract explain` for a reviewer-readable
boundary, `contract lint --strict` for deterministic CI checks, and `contract
test` for adopter-owned allow/deny/redaction cases. The built-in language
server supplies diagnostics, completion, hover, and formatting for
`.synapsor.sql` and legacy `.synapsor` files. See [Contract
Review](docs/contract-review.md) and [Contract
Testing](docs/contract-testing.md).

Runner also supports reviewed [aggregate reads](docs/aggregate-reads.md),
tenant-scoped tamper-evident [ledger reports](docs/compliance-reports.md), and
opt-in [graduated-trust recommendations](docs/graduated-trust.md). Aggregate
tools return one scalar and no source rows. Graduated trust is disabled by
default, remains operator-only, and can export a reviewable artifact but never
activate it.

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)**. It defines protected assets,
trust boundaries, covered threats, non-goals, and required operator controls.

- [Conformance fixtures](docs/conformance.md) prove trusted context, scoped
  reads, kept-out fields, proposal boundaries, approval, receipts, and replay
  behavior rather than only validating JSON shape.
- `contract test` lets adopters encode the same boundary checks for their own
  synthetic fixtures; it never invokes an LLM and refuses remote live targets
  by default.
- MCP proposal, evidence, and replay handles are references rather than bearer
  authority: resource reads re-check the owning tenant and principal against
  the current trusted session.
- `test:live-apply`, `test:guarded-crud`, `test:bounded-set`, and
  `test:reversible` run disposable PostgreSQL/MySQL scenarios. They prove no
  pre-approval mutation, guarded single-row CRUD, idempotent retry,
  fail-closed conflicts, bounded atomic sets, exact receipts, and reviewed
  compensation.
- The C++/Cloud round-trip verifier exports normalized contracts, validates
  them with `@synapsor/spec`, and loads them in Runner. The shared contract and
  verification commands are documented in [Conformance](docs/conformance.md).

Runner is a narrow agent/database safety boundary, not a replacement for
least-privilege database access, host security, or application authorization.
See [Security Boundary](docs/security-boundary.md) and
[Current Limitations](docs/limitations.md).

## Operate The Approval Loop

Policies combine per-proposal and daily ceilings; exceeding one routes to human
review. Operators get batch apply, metrics, structured logs, and optional
signed roles. Local SQLite is the default; bounded fleets can use verified HTTP
claims, asymmetric JWT sessions, and a shared Postgres `runtime_store`.
`smoke call` follows that store and never falls back to SQLite. Use `/healthz`
for liveness and `/readyz` for dependency readiness. See
[Production](docs/production.md), [Runner Config](docs/runner-config-reference.md),
and [Small Runner Fleets](docs/running-a-runner-fleet.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@synapsor/runner` | CLI, MCP runtime, local ledger, proposals, approval, guarded writeback, replay, and MCP audit. |
| `@synapsor/spec` | Canonical portable contracts for contexts, capabilities, workflows, evidence, proposals, receipts, and replay. |
| `@synapsor/dsl` | SQL-like authoring that compiles contexts, capabilities, and workflow declarations into canonical contract JSON. |

Runner executes locally. The spec is shared by Runner and Cloud/C++; the DSL
is its reviewable source format. Start with [Capability
Authoring](docs/capability-authoring.md). Use `.synapsor.sql` for generic SQL
highlighting; legacy `.synapsor` files produce the same contract JSON.

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
