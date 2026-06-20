# Synapsor Runner

Commit-safe database MCP for Postgres and MySQL.

Without Synapsor:

```text
Connect agent to database.
Give it a tool.
Hope it behaves.
```

With Synapsor:

```text
Expose reviewed business capabilities.
Turn risky writes into exact proposals.
Commit only through guarded execution.
```

Local-first. No Synapsor Cloud account is required for the local demo.

Synapsor Runner runs inside your environment. It is the local-first MCP and database safety runtime for approved AI-agent changes to Postgres and MySQL. It claims approved structured writeback jobs from Synapsor, validates the target, allowed columns, tenant scope, idempotency key, and conflict guard, then performs a parameterized single-row update and reports applied, conflict, already applied, or failed.

> Alpha status: v0.1 is intentionally small. It supports guarded single-row `UPDATE` jobs only. It is not a self-hosted Synapsor control plane, not HA, not exactly-once across networks, and not a compliance certification.

## What it does

- Keeps database credentials local.
- Gives MCP agents semantic capability tools instead of raw SQL tools.
- Polls Synapsor for approved writeback jobs.
- Rejects arbitrary SQL and model-generated SQL.
- Validates primary key, tenant guard, allowed patch columns, idempotency key, and version-column conflict guard.
- Builds parameterized SQL inside the Postgres/MySQL adapter.
- Applies exactly one row inside a transaction.
- Stores an idempotency receipt in the target database.
- Reports `applied`, `conflict`, `already_applied`, or `failed` back to Synapsor.

## Current status

The existing runner can validate and apply guarded writeback jobs. The new public protocol schemas are present under `schemas/`, and protocol fixtures are under `fixtures/protocol/`.

The CLI also includes `synapsor mcp audit <target>` for a static MCP database risk review of exported tool manifests. The repository now has a strict local capability config validator for reviewed read/proposal tools. The standalone MCP server, local SQLite proposal store, local approval CLI, and local replay CLI are still planned on the `mcp-commit-safe-runtime` branch.

## Local demo

Install dependencies:

```bash
corepack pnpm install
```

Validate fixture jobs without a Synapsor Cloud account:

```bash
corepack pnpm runner validate --job examples/postgres-support/job.approved.json
corepack pnpm runner validate --job examples/mysql-orders/job.approved.json
```

Dry-run the same jobs without writing business rows:

```bash
corepack pnpm runner apply --job examples/postgres-support/job.approved.json --dry-run
corepack pnpm runner apply --job examples/mysql-orders/job.approved.json --dry-run
```

Run doctor against a configured source and local database:

```bash
cp .env.example .env
corepack pnpm runner doctor
```

`doctor` verifies the runner token against Synapsor, confirms source-scoped writeback permissions, checks database engine/version, creates or verifies the receipt table, and performs a rollback-only receipt insert to confirm write permission without touching business rows.

Run the Docker-backed local examples end to end:

```bash
corepack pnpm test:docker
```

This starts the Postgres and MySQL fixtures, applies one approved guarded update, retries idempotently, verifies stale-version conflict, verifies tenant mismatch rejection, verifies disallowed-column validation, and tears the containers down with volumes.

Start polling Synapsor:

```bash
corepack pnpm runner start
```

Audit an exported MCP tool manifest without calling business tools:

```bash
corepack pnpm runner mcp audit ./tools-list.json
corepack pnpm runner mcp audit ./tools-list.json --json
```

The audit always includes:

```text
This is a static risk review, not proof that an MCP server is secure.
```

See `docs/mcp-audit.md`.

## Repository layout

- `schemas`: public JSON Schemas for change sets, writeback jobs, execution receipts, and runner registration.
- `fixtures/protocol`: versioned protocol fixtures shared with the main Synapsor repository.
- `packages/config`: strict local capability config validation.
- `packages/protocol`: Zod schemas and normalization for public/legacy job and receipt validation.
- `packages/control-plane-client`: claim, heartbeat, and result HTTP client.
- `packages/worker-core`: shared config, redaction, validation, polling, and apply orchestration.
- `packages/postgres`: Postgres adapter and receipt migration.
- `packages/mysql`: MySQL adapter and receipt migration.
- `apps/runner`: CLI entrypoint.
- `docs/capability-config.md`: reviewed local capability config shape and validation rules.
- `docs/mcp-audit.md`: static MCP database risk review command.
- `examples/postgres-support`: local Postgres ticket fixture.
- `examples/mysql-orders`: local MySQL order fixture.

## Security boundary

Synapsor Cloud stores proposals, evidence, approval state, job leases, and replay records. The runner stores the write credential in your environment. Jobs never include database URLs, passwords, arbitrary SQL, prompts, or model confidence. The runner accepts a structured patch and builds parameterized SQL itself.

MCP tool call equals request/proposal authority. Trusted runner equals execution authority.

The runner does not make MCP generally secure. It protects the Synapsor database path by avoiding model-facing raw SQL, binding trusted scope outside model arguments, enforcing allowlisted targets/columns, checking stale rows, and recording terminal receipts.

## Remote setup later

When Supsmall Inc. is ready to publish the repo, create the remote and push:

```bash
git remote add origin https://github.com/<owner>/synapsor-runner.git
git push -u origin main
```
