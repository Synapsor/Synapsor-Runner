# Operations

## Required configuration

- `SYNAPSOR_CONTROL_PLANE_URL`
- `SYNAPSOR_RUNNER_TOKEN`
- `SYNAPSOR_RUNNER_ID`
- `SYNAPSOR_SOURCE_ID`
- `SYNAPSOR_DATABASE_URL`
- `SYNAPSOR_ENGINE=postgres|mysql`

## Routine checks

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner doctor
npx -y -p @synapsor/runner@alpha synapsor-runner validate --job examples/postgres-support/job.approved.json
npx -y -p @synapsor/runner@alpha synapsor-runner validate --job examples/mysql-orders/job.approved.json
```

`doctor` validates local configuration, calls Synapsor's runner-token doctor endpoint, confirms the token is authenticated for the configured source, checks database reachability and engine version, creates/verifies `synapsor_writeback_receipts`, and performs a rollback-only receipt insert to prove the configured credential can write runner receipts. It does not mutate business tables.

## Local fixture smoke

Run this before cutting a release or changing the adapters:

```bash
corepack pnpm test:docker
```

The smoke starts the local Postgres and MySQL fixtures, validates approved jobs, applies one guarded single-row update, retries the same idempotency key, verifies stale-version conflict, verifies tenant mismatch rejection, verifies disallowed-column validation, and tears down the containers with volumes.

## Shutdown

The runner handles `SIGINT` and `SIGTERM` by stopping the poll loop. In-flight database transactions complete or roll back through the adapter.

## Logs

Default logs include runner id, job id, proposal id, source id, engine, schema/table names, patch column names, status/error code, and durations. Logs must not include database URL/password, runner token, full patch values, full source rows, or customer data.
