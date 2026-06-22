# Synapsor Runner

Safe database tools for AI agents.

Turn Postgres/MySQL into reviewed MCP capabilities, not raw SQL. Synapsor
Runner lets an MCP agent inspect scoped data and request database-backed
business actions without receiving raw SQL, write credentials, approval tools,
or commit tools.

## Run The Alpha

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner --help
```

The already-published alpha may expose only `synapsor-runner`. This package now
also exposes `synapsor` as the primary command, with `synapsor-runner` kept as a
backward-compatible alias.

Use it with a local or staging database:

```bash
export DATABASE_URL="postgresql://readonly_user:password@localhost:5432/app"
synapsor inspect --engine auto --from-env DATABASE_URL --schema public
synapsor init --wizard --engine auto --from-env DATABASE_URL --schema public
synapsor tools preview
synapsor mcp serve
```

For a longer local session, you can install the alpha package explicitly:

```bash
npm install -g @synapsor/runner@alpha
```

## What It Does

The local runner implements a small Synapsor-style trust loop:

```text
MCP tool call
-> trusted context
-> scoped read
-> evidence
-> proposal diff
-> approval outside the model
-> guarded writeback
-> receipt/replay
```

Your Postgres/MySQL database remains the source of truth. The runner stores
local proposals, evidence, receipts, and replay data in a local SQLite store.

## Command Name

This package installs `synapsor` as the primary binary and `synapsor-runner` as
a backward-compatible alias.

## Scope

This package is an alpha local runner. It is not Synapsor Cloud, not the
Synapsor DBMS, not a physical branch engine for Postgres/MySQL, and not a
general MCP security platform.

See the full repository README and docs for Docker demos, MCP client setup,
configuration recipes, and security boundaries.
