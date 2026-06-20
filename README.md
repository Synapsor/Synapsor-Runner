# Synapsor Runner

Open-source trusted writeback for approved AI-agent changes to Postgres and MySQL.

Synapsor Runner runs inside your environment. It claims approved structured writeback jobs from Synapsor, validates the target, allowed columns, tenant scope, idempotency key, and conflict guard, then performs a parameterized single-row update and reports applied, conflict, or failed.

> Alpha status: v0.1 is intentionally small. It supports guarded single-row `UPDATE` jobs only. It is not a self-hosted Synapsor control plane, not HA, not exactly-once across networks, and not a compliance certification.

## What it does

- Polls Synapsor for approved writeback jobs.
- Rejects arbitrary SQL and model-generated SQL.
- Validates primary key, tenant guard, allowed patch columns, idempotency key, and version-column conflict guard.
- Builds parameterized SQL inside the Postgres/MySQL adapter.
- Applies exactly one row inside a transaction.
- Stores an idempotency receipt in the target database.
- Reports `applied`, `conflict`, or `failed` back to Synapsor.

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

## Repository layout

- `packages/protocol`: job/result schemas and validation.
- `packages/control-plane-client`: claim, heartbeat, and result HTTP client.
- `packages/worker-core`: shared config, redaction, validation, polling, and apply orchestration.
- `packages/postgres`: Postgres adapter and receipt migration.
- `packages/mysql`: MySQL adapter and receipt migration.
- `apps/runner`: CLI entrypoint.
- `examples/postgres-support`: local Postgres ticket fixture.
- `examples/mysql-orders`: local MySQL order fixture.

## Security boundary

Synapsor Cloud stores proposals, evidence, approval state, job leases, and replay records. The runner stores the write credential in your environment. Jobs never include database URLs, passwords, arbitrary SQL, prompts, or model confidence. The runner accepts a structured patch and builds parameterized SQL itself.

## Remote setup later

When Supsmall Inc. is ready to publish the repo, create the remote and push:

```bash
git remote add origin https://github.com/<owner>/synapsor-runner.git
git push -u origin main
```
