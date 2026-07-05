# Agent Guide For Synapsor Runner

Synapsor Runner is an OSS MCP safety layer for Postgres/MySQL agents. It
replaces raw database tools such as `execute_sql` with reviewed business
capabilities, proposal-first writes, approval outside the model, guarded
writeback, and local evidence/replay.

## First Commands

Use the stable package for public/user-facing examples:

```bash
npx -y -p @synapsor/runner synapsor-runner demo --quick
npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp
```

Use the local checkout while editing this repo:

```bash
corepack pnpm install
./bin/synapsor-runner demo --quick --no-interactive
./scripts/verify-release-gate.sh
```

## What Not To Change Casually

Do not weaken these safety boundaries without a failing test and an explicit
design note:

- no model-facing `execute_sql`, raw SQL, approval, commit, apply, or writeback
  tools;
- trusted tenant/principal context must come from backend/session/env config,
  not model-controlled arguments;
- proposals must not mutate the source database before approval;
- direct writeback must enforce tenant, primary key, allowed columns,
  expected-version/conflict guard, affected-row count, idempotency, and receipt
  recording;
- app-owned handlers must re-check tenant/scope, expected version,
  idempotency, allowed business action, transaction/rollback, and safe error
  receipts;
- local store lease guards and stale-lease reclaim must keep concurrent writers
  from corrupting the SQLite store.

## How The Flow Works

```text
MCP tool call
-> trusted context
-> scoped read from Postgres/MySQL
-> evidence/query audit
-> proposal diff
-> approval outside MCP
-> direct writeback or app-owned executor
-> receipt/replay
```

The source database remains the source of truth. Runner stores local evidence,
proposals, receipts, query audit, and replay in SQLite.

## Add A Capability Without Reading dist/

Start from schema inspection or a recipe, then run the smoke boundary before
wiring an MCP client:

```bash
export DATABASE_URL="postgres://readonly:...@localhost:5432/app"
./bin/synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --engine postgres \
  --schema public \
  --table invoices \
  --primary-key id \
  --tenant-column tenant_id \
  --conflict-column updated_at \
  --mode review \
  --visible-columns id,tenant_id,status,late_fee_cents,updated_at \
  --namespace billing \
  --object-name invoice \
  --id-arg invoice_id \
  --patch late_fee_cents=fixed:0 \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL \
  --yes \
  --output synapsor.runner.json

./bin/synapsor-runner config validate --config ./synapsor.runner.json
./bin/synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
./bin/synapsor-runner smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For app-owned writes, use an executor and generate a template:

```bash
./bin/synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --table invoices \
  --mode review \
  --writeback http_handler \
  --handler-url-env APP_WRITEBACK_URL \
  --emit-handler \
  --handler-template node-fastify \
  --yes
```

## Test Safely

Prefer these checks before opening a PR:

```bash
corepack pnpm typecheck
corepack pnpm test:mcp-client-configs
./scripts/verify-public-commands.sh
./scripts/verify-local-runner.sh
./scripts/verify-packed-runner.sh
```

Run the full gate before release or large safety changes:

```bash
./scripts/verify-release-gate.sh
```

Do not commit generated `.synapsor/` ledgers, database credentials, `.env`
files, or npm tarballs.

## Source Map

- `apps/runner`: CLI, local UI, packaged README/docs/examples.
- `packages/mcp-server`: MCP runtime and safe tool exposure.
- `packages/schema-inspector`: Postgres/MySQL metadata inspection.
- `packages/proposal-store`: local SQLite evidence/proposal/replay store.
- `packages/postgres`, `packages/mysql`: guarded writeback adapters.
- `examples`: runnable demos and integration examples.
- `docs`: task guides, safety boundary, release policy.
