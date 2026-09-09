# Agent Guide For Synapsor Runner

Synapsor Runner is an OSS MCP safety layer for Postgres/MySQL agents. It
replaces raw database tools such as `execute_sql` with reviewed business
capabilities, proposal-first writes, approval outside the model, guarded
writeback, and local evidence/replay.

## First Commands

Use the stable package for public/user-facing examples:

```bash
npx -y @synapsor/runner demo --quick
npx -y @synapsor/runner audit --example dangerous-db-mcp
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

## Onboard Without Reading dist/

Fresh `start` and `onboard db` use the same reviewed Read/Action system. The
runtime surface stays at four tools as business rules change. Start with a
read-only database credential and describe the intended job:

```bash
export DATABASE_URL="postgres://readonly:...@localhost:5432/app"
./bin/synapsor-runner onboard db --from-env DATABASE_URL --schema public
```

For automation or an external development assistant, use the documented
structured draft/export flow in `docs/guided-onboarding.md`. It validates and
saves disabled revisions without a TTY or provider call. Draft success is not
activation. Read, Action, execution and worker startup remain separately
reviewed, with authenticated exact proof required for supported headless
activation. Never call internal activation helpers with a fabricated actor.

After the reviewed authorities are activated, use the managed client installer:

```bash
./bin/synapsor-runner mcp install claude-code \
  --project --authoring --project-root . \
  --yes
```

This grants no additional database authority. The four tools are
`app.describe_data`, `app.explore_data`, `app.describe_actions`, and
`app.request_change`. Missing runtime identity, writer or worker readiness must
be reported accurately; a handshake is not proof of a successful source effect.

Do not recommend named per-table tools for new projects. Legacy recipes,
code-first actions and exported artifacts remain explicit compatibility/testing
surfaces; see `docs/legacy-onboarding.md` for the inventory and unported effects.

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
