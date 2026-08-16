# Store Lifecycle

Synapsor Runner keeps development-mode evidence, query audit, proposals,
receipts, replay, worker state, human-attention events, notification delivery
state, and lifecycle events in a SQLite store. A configured shared PostgreSQL
runtime store is authoritative for multi-process deployments and for production
HTTP Explore accounting/evidence.

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

## Inspect one complete lifecycle

Start with no id:

```bash
synapsor-runner lifecycle --store ./.synapsor/local.db
```

`lifecycle`, `lifecycle show`, and `lifecycle show latest` are exact aliases.
They choose the newest proposal deterministically by `created_at` descending,
then proposal id as the tie-breaker. The default view answers:

- what capability and business object the model requested;
- which trusted tenant and principal scoped it;
- approval state and progress;
- required/live freshness state and the proof digest bound to each approval;
- whether a writeback job or intent exists;
- the latest guarded outcome and whether the source changed;
- replay and Cloud-link status; and
- the next safe read-only or operator command.

Use `--details` for one causal proposal-to-receipt/replay timeline, or `--json`
for one stable `synapsor.lifecycle-view.v1` JSON document:

```bash
synapsor-runner lifecycle --details --store ./.synapsor/local.db
synapsor-runner lifecycle --json --store ./.synapsor/local.db
```

The JSON is a domain view, not a dump of internal SQLite/PostgreSQL tables.
Absent stages are represented explicitly as empty arrays or `null`; Runner
does not fabricate a job, receipt, replay, or Cloud synchronization.

### Browse and filter without copying ids

```bash
synapsor-runner lifecycle list --limit 20 --store ./.synapsor/local.db
synapsor-runner lifecycle show --object invoice:INV-3001 --details --store ./.synapsor/local.db
synapsor-runner lifecycle list --tenant acme --capability billing.propose_late_fee_waiver
synapsor-runner lifecycle show --principal support-agent-17 --status applied
```

List/show support tenant, principal, capability, business object, status/state,
and time-window filters. Filtered `show` selects the newest match and reports
the total match count; use `lifecycle list` to browse all matches. List JSON
uses `synapsor.lifecycle-list.v1`.

### Start from any handle you already have

```bash
synapsor-runner lifecycle show wrp_... --details
synapsor-runner lifecycle show ev_... --details
synapsor-runner lifecycle show replay_... --details
synapsor-runner lifecycle show wbj_... --details
synapsor-runner lifecycle show wbi:wbj_... --details
synapsor-runner lifecycle show receipt:42 --details
synapsor-runner lifecycle show audit:17 --details
```

Runner resolves proposal, evidence, replay, writeback-job, writeback-intent,
receipt, and query-audit handles to the owning proposal. Numeric receipt and
query-audit ids require the `receipt:` or `audit:` namespace; a bare number is
rejected rather than guessed.

Lifecycle inspection is read-only. It does not contact the source database or
Cloud, create a writeback job, acquire a worker lease, approve, apply, reconcile,
retry, or synchronize anything. It applies the same tenant/principal visibility
rules and secret/kept-out-field protections as the focused views.

### Shared PostgreSQL runtime store

For `storage.shared_postgres.mode = "runtime_store"`, pass the reviewed config:

```bash
synapsor-runner lifecycle --config ./synapsor.runner.json
synapsor-runner lifecycle show --object invoice:INV-3001 --details \
  --config ./synapsor.runner.json
```

Runner reuses the existing bounded read bridge to the authoritative shared
ledger. It does not create or synchronize a persistent local mirror during
inspection. Connection failures fail safely; the command never falls back to an
unrelated local store.

Production HTTP Explore appends metadata-only evidence and query-audit events to
the dedicated `production_explore_audit_events` table in that PostgreSQL
control store. The application source may be PostgreSQL or MySQL; the shared
control store is PostgreSQL in both cases. There is no shared-MySQL control
store. The application database and control database are separate authorities.

The focused `evidence`, `query-audit`, `receipts`, `replay`, and `activity`
read commands use the same config-aware bridge. Their text and JSON output name
whether they read local SQLite or shared PostgreSQL, including the configured
schema but never the connection URL. An empty result says which ledger was
consulted. Shared reads use a bounded read-only snapshot and do not block the
live production writer with its advisory mutation lock.

```bash
synapsor-runner evidence list --principal librarian@example.org \
  --resource public.orders --since 24h --config ./synapsor.runner.json
synapsor-runner evidence show <evidence-id> --details \
  --config ./synapsor.runner.json
synapsor-runner query-audit list --outcome refused --resource public.orders \
  --since 24h --config ./synapsor.runner.json
synapsor-runner query-audit browse --since 24h \
  --config ./synapsor.runner.json
synapsor-runner query-audit show <audit-id> --details \
  --config ./synapsor.runner.json
```

Production Explore records plans, outcome/count metadata, keyed scope
fingerprints, and result fingerprints. It does not persist result values, raw
tenant/principal claims, SQL, parameters, credentials, or source rows.

`--tenant` and `--principal` accept either the operator-known plaintext value
or an existing `keyed:<HMAC>` fingerprint. For plaintext input, Runner derives
candidate fingerprints locally from the project's audit key and configured
production HMAC key; the plaintext is not printed or persisted. Principal
lookup applies to records created after keyed principal metadata was added.
Older records only say whether principal scope was active, so they cannot be
attributed to a principal retroactively.

Use `query-audit` when the question is "what was attempted?" It includes
refusals before source execution, privacy refusals after execution, source
failures, and released results. Use `evidence` when the question is "what
metadata proves this released result?" A refusal has no evidence bundle because
no result was released. Both list commands support `--resource`, `--boundary`,
`--outcome`, `--since` (ISO timestamp or `24h`/`7d` style duration), `--to`,
`--limit`, `--json`, and `--follow`. `browse` opens the same filtered records in
an interactive terminal viewer. `--follow --json` emits newline-delimited JSON.
`activity search` uses the same production-store selection and keyed Explore
identity lookup when one combined lifecycle view is more useful than a focused
record type.

## Focused inspection commands

The existing commands remain useful when you need one record type:

| Question | Focused command |
| --- | --- |
| What did the model propose? | `synapsor-runner proposals show latest --details` |
| Is the latest proposal still fresh enough to review? | `synapsor-runner proposals check-freshness latest --config ./synapsor.runner.json` |
| What data supported it? | `synapsor-runner evidence list --proposal <proposal-id> --config ./synapsor.runner.json` then `evidence show <evidence-id> --details --config ./synapsor.runner.json` |
| What query was run? | `synapsor-runner query-audit list --proposal <proposal-id> --config ./synapsor.runner.json` |
| Did guarded writeback apply? | `synapsor-runner receipts list --proposal <proposal-id>` |
| What replay snapshot exists? | `synapsor-runner replay show latest --details` |
| What happened to one object? | `synapsor-runner activity search --object invoice:INV-3001` |
| What are the latest events? | `synapsor-runner events tail` |
| How large is the store? | `synapsor-runner store stats --store ./.synapsor/local.db` |

`proposals writeback-job` is intentionally absent from inspection examples:
it materializes a job and is therefore an operator mutation, not a read-only
view.

`proposals check-freshness` is source-read-only but is not a ledger-pure
inspection: it contacts the configured source and records an immutable proof
event. The `lifecycle` command never does that; it only reports the most recent
stored proof and approval linkage. See
[Proposal And Evidence Freshness](proposal-evidence-freshness.md).

## Human Attention And Delivery State

The store records immutable attention events, coalesced incident projections,
and sink-specific delivery attempts. Inspect them without copying an ID:

```bash
synapsor-runner attention show --store ./.synapsor/local.db
synapsor-runner notifications status --store ./.synapsor/local.db --json
```

Acknowledgement changes only the attention projection. Notification replay
requires a fresh verified signed-key or OIDC operator decision plus an explicit
reason. That decision is bound to the exact delivery revision, requeues only
the original redacted event, and appends an immutable
`notification.replayed` audit event. Neither command approves, applies,
reconciles, or repeats a source mutation. See
[Human Attention And Notifications](human-attention-notifications.md).

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
