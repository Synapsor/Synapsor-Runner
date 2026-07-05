# Store Lifecycle

Synapsor Runner keeps local evidence, query audit, proposals, receipts, replay,
and lifecycle events in a SQLite store.

Default path:

```bash
./.synapsor/local.db
```

## Server leases

MCP server modes write a small lease file next to the store:

```text
<store>.lease.json
```

The lease records the server pid, mode, transport, and start time. Destructive
store operations refuse to run while that lease points at a live process.

Use `--force` only after you have stopped the server or verified the lease is
stale.

## Prune safely

Preview first:

```bash
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --dry-run
```

Apply after review:

```bash
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --yes
```

Override an active/stale lease:

```bash
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --yes --force
```

## Reset the local ledger

Reset deletes only the local SQLite ledger files:

```bash
synapsor-runner store reset --store ./.synapsor/local.db --yes
```

It removes:

```text
local.db
local.db-wal
local.db-shm
local.db.lease.json
```

It never touches your source Postgres/MySQL database. Like prune, reset refuses
while an active server lease exists unless you pass `--force` after verifying
the server is stopped or the lease is stale.

## Deleted store under a running server

If the store file disappears while a server is still running, model-facing tool
calls fail safely with `TEMPORARILY_UNAVAILABLE`. Runner does not expose raw
SQLite paths, corruption text, or filesystem errors to the model.

Fix:

1. Stop the running MCP server.
2. Recreate the store by rerunning the demo/setup or restore the previous store.
3. Restart the MCP server.

## Concurrent server modes

Running multiple server transports against the same SQLite store can cause
contention and confusing local state. Runner refuses concurrent server leases by
default. Use `--allow-concurrent-store` only for controlled local debugging.
