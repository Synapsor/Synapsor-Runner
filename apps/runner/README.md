# Synapsor Runner

Commit-safe MCP runner for Postgres and MySQL agents.

Synapsor Runner lets an MCP agent request database-backed business actions
without receiving raw SQL, write credentials, approval tools, or commit tools.
It exposes semantic tools, creates proposals, records evidence, requires
approval outside the model-facing tool surface, and applies approved writes
through guarded execution.

## Run The Alpha

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner --help
```

Use it with a local or staging database:

```bash
export DATABASE_URL="postgresql://readonly_user:password@localhost:5432/app"
npx -y -p @synapsor/runner@alpha synapsor-runner inspect --engine auto --from-env DATABASE_URL --schema public
npx -y -p @synapsor/runner@alpha synapsor-runner init --wizard --engine auto --from-env DATABASE_URL --schema public
npx -y -p @synapsor/runner@alpha synapsor-runner tools preview
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve
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

This package installs the `synapsor-runner` binary. It intentionally does not
install a `synapsor` binary because the hosted Synapsor SDK package already owns
that command.

## Scope

This package is an alpha local runner. It is not Synapsor Cloud, not the
Synapsor DBMS, not a physical branch engine for Postgres/MySQL, and not a
general MCP security platform.

See the full repository README and docs for Docker demos, MCP client setup,
configuration recipes, and security boundaries.
