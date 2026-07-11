# Store Lifecycle

Synapsor Runner keeps local evidence, query audit, proposals, receipts, replay,
and lifecycle events in a SQLite store.

Default path:

```bash
./.synapsor/local.db
```

## Data sensitivity and permissions

The ledger contains copies of the business fields allowed by each capability:
visible before/after evidence, proposal diffs, actor/tenant metadata, query
fingerprints, approvals, receipts, and replay events. Treat it like a scoped
database extract, not disposable cache data.

Runner creates new POSIX store files with owner-only mode `0600` and tightens an
owned existing store when it opens it. On Windows, use the operating system's
file ACLs. Use encrypted disks, restrict OS accounts, and set a retention policy
appropriate for the visible business data.

`KEEP OUT` fields and redacted query parameters are not written to normal
evidence records. They do not make the rest of the ledger non-sensitive.

Direct SQLite inspection is supported **read-only** for independent verification:

```bash
sqlite3 -readonly ./.synapsor/local.db '.tables'
```

Do not mutate the database directly. Its internal tables may change between
releases and are not a public storage API; use Runner commands for automation.

## Inspect the ledger

| Question | Command |
| --- | --- |
| What did the model propose? | `synapsor-runner proposals show <proposal-id> --details` |
| What data supported it? | `synapsor-runner evidence list --proposal <proposal-id>` then `evidence show <evidence-id> --details` |
| What query was run? | `synapsor-runner query-audit list --proposal <proposal-id>` |
| Who approved or rejected it? | `synapsor-runner proposals show <proposal-id> --details` |
| Did guarded writeback apply? | `synapsor-runner receipts list --proposal <proposal-id>` |
| What happened end to end? | `synapsor-runner replay show --proposal <proposal-id> --details` |
| What happened to one object? | `synapsor-runner activity search --object invoice:INV-3001` |
| What are the latest events? | `synapsor-runner events tail` |
| How large is the store? | `synapsor-runner store stats --store ./.synapsor/local.db` |

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
