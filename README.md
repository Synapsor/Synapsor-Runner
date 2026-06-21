# Synapsor Runner

Source-available commit-safe MCP runtime for Postgres and MySQL.

Replace raw database MCP tools with reviewed business capabilities, proposal
diffs, local approvals, and guarded commits. Synapsor Runner lets an MCP agent
request a database change without receiving raw SQL or write credentials.

Without Synapsor:

```text
Connect agent to database.
Give it a tool.
Hope it behaves.
```

With Synapsor Runner:

```text
Expose reviewed business capabilities.
Turn risky writes into exact proposals.
Commit only through guarded execution.
```

Run the Docker demo:

```bash
./scripts/demo-docker.sh
```

No Synapsor Cloud account, API key, hosted workspace, or host Node setup is
required.

Run the local demo and you should see the important moment:

```text
The business state changed after the agent saw it, so Synapsor refused to commit.
```

The concrete shape looks like this:

```diff
invoice.late_fee_cents
- 5500
+ 0

Source DB changed: No
Approval: Required
Conflict guard: updated_at
```

That is the point of Synapsor Runner. It shows how an MCP agent can request a
database change without receiving raw SQL or write credentials, and how the
runner turns that request into a reviewable, conflict-checked business state
transition.

The examples are demos, but the CLI, MCP server, proposal store, adapters, and
guarded runner are usable locally.

MCP connects the agent. Synapsor Runner controls whether the requested database
change can become durable business state.

> Alpha: v0.1 supports guarded single-row `UPDATE` jobs only. It is not HA, not a self-hosted Synapsor Cloud, not exactly-once across networks, and not a compliance certification.

## How it works

Synapsor Runner sits between your MCP client and your database. Think of it as
the smallest local version of Synapsor's trust workflow, not a miniature
database engine.

Run this loop on your own machine:

```text
MCP client
  -> semantic business tool
  -> trusted tenant/principal context
  -> scoped read from Postgres/MySQL
  -> evidence and exact proposal diff
  -> local approval outside the model
  -> guarded single-row writeback
  -> applied/conflict/failed receipt
  -> local replay
```

The runner does not replace Postgres or MySQL. Your database remains the source
of truth. The runner controls whether an agent-requested change is safe enough
to apply.

## Use it when

Use Synapsor Runner when you want to give an MCP agent access to
database-backed actions without exposing raw SQL or write credentials.

It helps you:

- replace `execute_sql` with semantic tools;
- keep database credentials in your environment;
- turn writes into reviewable proposals;
- show exact before/after diffs before anything changes;
- approve outside the model-facing tool surface;
- commit through tenant, column, idempotency, and row-version guards;
- block stale-row writes instead of silently overwriting newer data;
- inspect local evidence, approvals, receipts, and replay.

## Quickstart

Run the full local MCP demo with Docker only:

```bash
./scripts/demo-docker.sh
```

Or use the contributor wrapper if you already have Node/Corepack installed:

```bash
./scripts/demo-local.sh
```

Or through pnpm:

```bash
corepack pnpm demo:docker
corepack pnpm demo:local
```

The host prerequisites for `./scripts/demo-docker.sh` are Docker and a reachable Docker daemon. You do not need a Synapsor Cloud account, an API key, a hosted workspace, or host Node/Corepack setup.

The demo starts disposable Postgres and MySQL containers, launches the local
stdio MCP server, and proves:

- MCP `tools/list` exposes semantic tools only, not `execute_sql`.
- Reads are tenant-scoped and evidence-backed.
- Proposal tools return exact before/after diffs.
- The source row is unchanged after proposal creation.
- Approval happens outside the model-facing MCP tool surface.
- The runner applies only a structured, approved, single-row writeback job.
- The writeback checks primary key, tenant scope, allowed columns, row version,
  idempotency, and affected row count.
- Retrying the same approved job is idempotent.
- A stale row returns `conflict` with no write.
- Replay can explain the proposal, approval, receipt, evidence, and query audit.

## Use your own Postgres or MySQL database

After the Docker demo, point Synapsor Runner at a staging database and define
one safe business capability.

This works today in v0.1, but it is intentionally not "connect any database and
let the model do anything." You inspect metadata, choose one table/view and one
business action, generate a reviewed config, then expose narrow MCP tools from
that config.

Full walkthrough: `docs/getting-started-own-database.md`.

Synapsor Runner does not auto-generate arbitrary database tools. You define the
source, table, primary key, tenant key, visible columns, allowed write columns,
conflict guard, and mode in `synapsor.runner.json`.

Recommended path:

```bash
export SYNAPSOR_DATABASE_READ_URL="postgresql://readonly:<password>@localhost:5432/app"

synapsor inspect \
  --engine postgres \
  --database-url-env SYNAPSOR_DATABASE_READ_URL \
  --schema public
```

Create a reviewed selection file from that metadata:

```json
{
  "version": 1,
  "engine": "postgres",
  "mode": "review",
  "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
  "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL",
  "schema": "public",
  "table": "invoices",
  "primary_key": "id",
  "tenant_key": "tenant_id",
  "conflict_column": "updated_at",
  "namespace": "billing",
  "object_name": "invoice",
  "visible_columns": ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
  "allowed_columns": ["late_fee_cents", "waiver_reason"],
  "patch": {
    "late_fee_cents": { "fixed": 0 },
    "waiver_reason": { "from_arg": "reason" }
  }
}
```

For MySQL, use the same flow with `--engine mysql`:

```bash
export SYNAPSOR_DATABASE_READ_URL="mysql://readonly:<password>@localhost:3306/app"

synapsor inspect \
  --engine mysql \
  --database-url-env SYNAPSOR_DATABASE_READ_URL
```

Generate the config and MCP client snippets from your reviewed selection:

```bash
synapsor init --spec onboarding-selection.json --non-interactive
synapsor config validate --config synapsor.runner.json
synapsor doctor --config synapsor.runner.json
```

The generated config will look like this:

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
      "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
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
      "visible_columns": ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
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
      "visible_columns": ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
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
        "required_role": "billing_lead"
      }
    }
  ]
}
```

Serve the reviewed tools:

```bash
export SYNAPSOR_DATABASE_READ_URL="postgresql://readonly:<password>@localhost:5432/app"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"

synapsor mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The MCP server uses the read URL for inspect and proposal reads. Keep the write
credential out of the MCP client config.

The model gets the semantic tools. It does not get raw SQL, write credentials,
approval tools, commit tools, or tenant authority.

When you are ready to apply an approved proposal, run the guarded worker/apply
path with a trusted write credential outside the model-facing MCP server:

```bash
synapsor proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
synapsor proposals writeback-job wrp_123 --store ./.synapsor/local.db --output job.json

export SYNAPSOR_DATABASE_WRITE_URL="postgresql://writer:<password>@localhost:5432/app"

SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="$SYNAPSOR_DATABASE_WRITE_URL" \
synapsor apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

Start with staging or a disposable database before pointing the runner at
production-like data.

## MCP tools exposed to the model

The model gets narrow business tools like:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
support.inspect_ticket
support.propose_ticket_resolution
orders.inspect_order
orders.propose_refund_review
```

The model does not get:

```text
execute_sql
approve_proposal
commit_proposal
database_url
write_credentials
tenant_id as model-controlled authority
arbitrary table or column names
```

MCP connects the agent. Synapsor Runner controls whether the requested database
change can become durable business state.

## Local first, Cloud when your team needs it

Local mode is the no-account mini trust loop:

- local MCP server
- local SQLite proposal/evidence/replay store
- local CLI approval
- local guarded Postgres/MySQL writeback
- local receipts and replay export

Synapsor Cloud is the team/shared control plane:

- reviewed adapter and capability catalog
- RBAC and team approvals
- hosted evidence and replay search
- managed proposal state
- runner fleet status
- writeback job leases
- retention and audit visibility

The same boundary applies in both modes: the model proposes; the trusted runner
executes only after approval.

## Current scope

Synapsor Runner is intentionally small in v0.1.

It supports:

- local MCP tools for Postgres/MySQL-backed business actions;
- read-only, shadow, review, and Cloud-linked modes;
- guarded single-row `UPDATE` writeback jobs;
- semantic tools defined in local JSON config;
- local proposals, approvals, receipts, evidence, query audit, and replay.

It does not try to be:

- a self-hosted Synapsor Cloud;
- the Synapsor C++ DBMS;
- a physical branch engine for Postgres/MySQL;
- a generic MCP security platform;
- a prompt-injection solution;
- a framework for arbitrary SQL, DDL, INSERT, DELETE, UPSERT, or multi-row writes.

It demonstrates Synapsor's database commit-safety boundary locally.

## Features

- Keeps database credentials local.
- Gives MCP agents semantic capability tools instead of raw SQL tools.
- Supports local read-only, shadow, review, and Cloud-linked modes.
- Stores local proposals, evidence, query audit, writeback receipts, and replay
  in SQLite.
- Rejects arbitrary SQL and model-generated SQL.
- Validates primary key, tenant guard, allowed patch columns, idempotency key,
  and version-column conflict guard.
- Builds parameterized SQL inside the Postgres/MySQL adapter.
- Applies exactly one row inside a transaction.
- Stores an idempotency receipt in the target database.
- Reports `applied`, `conflict`, `already_applied`, or `failed`.
- Includes `synapsor mcp audit <target>` for a static MCP database risk review.
- Includes `synapsor doctor --config synapsor.runner.json` for local setup
  readiness checks.

## Local Modes

Local modes are explicit:

- `read_only`: exposes reads only.
- `shadow`: records proposals, evidence, and replay without approval or writeback.
- `review`: enables local approval plus guarded writeback.
- `cloud`: delegates reviewed tools and approval state to Synapsor Cloud while
  keeping the write credential local.

## Test the runner

Lower-level checks are available when you want to validate specific pieces.

Validate fixture jobs without a Synapsor Cloud account:

```bash
corepack pnpm install
corepack pnpm runner validate --job examples/postgres-support/job.approved.json
corepack pnpm runner validate --job examples/mysql-orders/job.approved.json
```

Dry-run the same jobs without writing business rows:

```bash
corepack pnpm runner apply --job examples/postgres-support/job.approved.json --dry-run
corepack pnpm runner apply --job examples/mysql-orders/job.approved.json --dry-run
```

Run the Docker-backed local examples end to end:

```bash
corepack pnpm test:docker
```

This starts the Postgres and MySQL fixtures, applies one approved guarded update, retries idempotently, verifies stale-version conflict, verifies tenant mismatch rejection, verifies disallowed-column validation, and tears the containers down with volumes.

Run the stdio MCP local proof:

```bash
corepack pnpm test:mcp-local
```

This starts disposable Postgres/MySQL databases, launches the local MCP server through the official stdio client transport, lists semantic tools, calls inspect/proposal tools, confirms source rows are unchanged before approval, approves locally, generates `synapsor.writeback-job.v1` jobs, applies them through the guarded worker, retries idempotently, then simulates stale rows and returns conflict with no write.

Run the hosted-compatible Cloud-linked proof:

```bash
corepack pnpm test:mcp-cloud-linked
```

This starts the disposable Postgres billing fixture, registers a runner against a mock Synapsor Cloud API, serves MCP in `mode: "cloud"`, fetches the Cloud adapter tool catalog, calls the proposal tool through the Cloud adapter API, confirms the source row is unchanged before approval, claims an approved writeback job, applies it through the real guarded Postgres adapter, and submits the terminal receipt back to the mock Cloud API without sending database credentials to Cloud.

Run the reproducible fixture benchmark:

```bash
corepack pnpm runner benchmark mcp-efficiency
corepack pnpm runner benchmark mcp-efficiency --json
```

In the included fixture, semantic capabilities replace generic schema
exploration and raw SQL with two compact business tools. Run the benchmark to
inspect tool definitions, reference tool-call count, and tokenized context
size. This is not a universal savings claim.

## Connect to Synapsor Cloud

Use Cloud mode when you want shared approvals, RBAC, hosted evidence/replay
search, runner fleet status, leases, retention, and audit visibility while
keeping your database credentials local.

Run `doctor` against a configured Cloud source and local database:

```bash
cp .env.example .env
corepack pnpm runner doctor
```

`doctor` verifies the runner token against Synapsor, confirms source-scoped writeback permissions, checks database engine/version, creates or verifies the receipt table, and performs a rollback-only receipt insert to confirm write permission without touching business rows.

Start polling Synapsor:

```bash
synapsor runner start
```

From this repository, the equivalent shorthand is:

```bash
corepack pnpm runner start
```

Validate a Cloud-linked runner config without printing secrets:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
synapsor cloud connect --config ./synapsor.cloud.json
```

`cloud connect` verifies the scoped token, registers runner metadata, and sends an initial heartbeat. It does not upload database URLs, passwords, write credentials, prompts, or table data. The local Docker demo above remains the primary no-account path.

For hosted adapter/tool verification commands, see `docs/cloud-mode.md`.

## Audit an MCP server

Audit an exported MCP tool manifest without calling business tools:

```bash
corepack pnpm runner mcp audit ./tools-list.json
corepack pnpm runner mcp audit ./tools-list.json --json
corepack pnpm runner mcp audit https://mcp.example.com --bearer-env MCP_AUDIT_TOKEN --json
corepack pnpm runner mcp audit 'stdio:node ./server.mjs' --timeout-ms 5000
```

The audit always includes:

```text
This is a static risk review, not proof that an MCP server is secure.
```

See `docs/mcp-audit.md`.

## Define your own safe tools

Serve reviewed local capabilities over stdio MCP:

```bash
synapsor init --engine postgres --mode review
synapsor mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The MCP server exposes configured semantic tools only. It does not expose `execute_sql`, generic query tools, approval tools, or commit tools. Read tools return evidence handles. Proposal tools create exact local proposals and leave the source database unchanged.

Review local proposals from the SQLite store:

```bash
corepack pnpm runner proposals list --store ./.synapsor/local.db
corepack pnpm runner proposals show wrp_123 --store ./.synapsor/local.db
corepack pnpm runner proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
corepack pnpm runner proposals reject wrp_123 --store ./.synapsor/local.db --reason "needs review" --yes
corepack pnpm runner replay show wrp_123 --store ./.synapsor/local.db
corepack pnpm runner replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

`approve` and `reject` require interactive confirmation or explicit `--yes` for noninteractive scripts.

When applying a locally generated job, pass the same store path to attach the terminal execution receipt to replay:

```bash
corepack pnpm runner apply --job job.json --store ./.synapsor/local.db
corepack pnpm runner replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

## Repository layout

- `schemas`: public JSON Schemas for change sets, writeback jobs, execution receipts, and runner registration.
- `fixtures/protocol`: versioned protocol fixtures shared with the main Synapsor repository.
- `packages/config`: strict local capability config validation.
- `packages/protocol`: Zod schemas and normalization for public/legacy job and receipt validation.
- `packages/proposal-store`: SQLite local proposal/event/approval/receipt store.
- `packages/control-plane-client`: runner registration, heartbeat, adapter catalog/call, writeback claim, lease renewal, and result HTTP client.
- `packages/worker-core`: shared config, redaction, validation, polling, and apply orchestration.
- `packages/postgres`: Postgres adapter and receipt migration.
- `packages/mysql`: MySQL adapter and receipt migration.
- `apps/runner`: CLI entrypoint.
- `docs/capability-config.md`: reviewed local capability config shape and validation rules.
- `docs/cloud-mode.md`: Cloud-linked runner mode, token scope, and metadata boundary.
- `docs/getting-started-own-database.md`: own staging Postgres/MySQL onboarding path.
- `docs/trusted-context.md`: trusted tenant/principal binding and model boundary.
- `docs/limitations.md`: explicit v0.1 limits and non-claims.
- `docs/local-ui.md`: local UI plan and security requirements.
- `docs/local-mode.md`: local store, proposal review, and replay commands.
- `docs/mcp-audit.md`: static MCP database risk review command.
- `docs/mcp-efficiency-benchmark.md`: reproducible benchmark requirements.
- `docs/mcp-client-setup.md`: stdio MCP client setup patterns.
- `docs/security-boundary.md`: model/runner authority split.
- `docs/schema-inspection.md`: metadata inspection command and safety behavior.
- `docs/telemetry.md`: no-hidden-telemetry behavior for local mode.
- `docs/config-migrations.md`: current config versioning and migration rules.
- `docs/production-readiness.md`: current production-readiness limits.
- `docs/licensing.md`: source-available ELv2 summary.
- `docs/dependency-license-inventory.md`: third-party license inventory summary.
- `examples/postgres-support`: local Postgres ticket fixture.
- `examples/mysql-orders`: local MySQL order fixture.
- `examples/mcp-postgres-billing`: stdio MCP billing fixture with source-unchanged, approval, idempotency, and stale-row conflict proof.
- `examples/mcp-postgres-support`: stdio MCP support-ticket fixture.
- `examples/mcp-mysql-orders`: stdio MCP MySQL order fixture.

## Security boundary

Synapsor Cloud stores proposals, evidence, approval state, job leases, and replay records. The runner stores the write credential in your environment. Jobs never include database URLs, passwords, arbitrary SQL, prompts, or model confidence. The runner accepts a structured patch and builds parameterized SQL itself.

MCP tool call equals request/proposal authority. Trusted runner equals execution authority.

The runner does not make MCP generally secure. It protects the Synapsor database path by avoiding model-facing raw SQL, binding trusted scope outside model arguments, enforcing allowlisted targets/columns, checking stale rows, and recording terminal receipts.

## Community

Synapsor Runner is maintained by Synapsor.

- Website: https://synapsor.ai
- Docs: https://synapsor.ai/docs
- License: Elastic License 2.0 (`Elastic-2.0`)
- Issues: use GitHub Issues
