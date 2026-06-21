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

The CLI also includes `synapsor mcp audit <target>` for a static MCP database risk review of exported tool manifests. The repository now has a strict local capability config validator, SQLite proposal/event/replay store foundation, local proposal/replay CLI commands, and a stdio MCP server that exposes reviewed semantic capabilities from config. The MCP server supports local read and proposal tools, stores evidence/proposals locally, and exposes proposal/evidence/replay resources. Local approved proposals can now generate versioned `synapsor.writeback-job.v1` jobs for guarded Postgres/MySQL writeback.

Cloud-linked MCP mode is wired for adapter tool catalog and tool-call delegation through the control-plane client. The repository includes a hosted-compatible Cloud-linked smoke that uses a mock Cloud API plus the real guarded Postgres writeback path. A live hosted Cloud run still depends on a compatible Synapsor Cloud workspace, adapter, and scoped runner token; the local disposable demos remain the primary no-account path.

## Local demo

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

The Docker-only script builds a small local runner image, mounts the repository at the same path, uses your Docker daemon for disposable Postgres/MySQL containers, launches the local stdio MCP server, lists semantic tools, calls inspect/proposal tools, confirms source rows are unchanged before approval, approves locally, applies guarded writeback, retries idempotently, then simulates stale rows and returns conflict with no write.

The host prerequisites for `./scripts/demo-docker.sh` are Docker and a reachable Docker daemon. You do not need a Synapsor Cloud account, an API key, a hosted workspace, or host Node/Corepack setup.

Local modes are explicit: `read_only` exposes reads only, `shadow` records proposals/evidence/replay without any approval or writeback path, and `review` enables local approval plus guarded writeback.

Manual lower-level checks are also available.

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

Run doctor against a configured Cloud source and local database:

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
- `docs/limitations.md`: explicit v0.1 limits and non-claims.
- `docs/local-mode.md`: local store, proposal review, and replay commands.
- `docs/mcp-audit.md`: static MCP database risk review command.
- `docs/mcp-client-setup.md`: stdio MCP client setup patterns.
- `examples/postgres-support`: local Postgres ticket fixture.
- `examples/mysql-orders`: local MySQL order fixture.
- `examples/mcp-postgres-billing`: stdio MCP billing fixture with source-unchanged, approval, idempotency, and stale-row conflict proof.
- `examples/mcp-postgres-support`: stdio MCP support-ticket fixture.
- `examples/mcp-mysql-orders`: stdio MCP MySQL order fixture.

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
