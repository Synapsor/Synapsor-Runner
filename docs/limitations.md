# Limitations

Synapsor Runner is intentionally narrow in the current alpha.

## Supported

- Stdio MCP server for semantic database capabilities.
- Local read and proposal tools.
- Local SQLite evidence/proposal/query-audit/replay store by default.
- Optional shared Postgres proposal/evidence/replay runtime store for MCP serving.
- Human approval through CLI commands.
- Public protocol objects:
  - `synapsor.change-set.v1`
  - `synapsor.writeback-job.v1`
  - `synapsor.execution-receipt.v1`
  - `synapsor.runner-registration.v1`
- Guarded single-row `UPDATE` for Postgres and MySQL.
- App/API handler writeback through approved `http_handler` executors.
- Local script writeback through approved `command_handler` executors.
- Primary-key guard.
- Tenant guard.
- Allowed-column validation.
- Version-column or explicit weak row-hash conflict guard.
- Idempotency receipts.
- Named local trusted contexts for capability configs.
- Capability recipes that generate reviewed starter configs.
- Shadow-mode proposal-vs-human-action comparison.
- Static MCP database risk review.
- Local indexed search for proposals, evidence bundles, query audit, writeback
  receipts, and proposal replay.

## Runtime Contract

Local capabilities are config-defined, not built into the server. The runtime
does not special-case billing, support, orders, refunds, invoices, or tickets.
Those domains appear only in demos, smoke tests, and optional recipe JSON files.
When you connect your own database, `synapsor.runner.json` is the source of
truth for the model-facing tools.

## Not Supported

- Arbitrary SQL.
- Model-generated SQL.
- DDL.
- INSERT.
- DELETE.
- UPSERT.
- Multi-row UPDATE.
- Stored procedures.
- Cross-database transactions.
- Physical branching of Postgres/MySQL.
- Full Synapsor workflow/DAG execution.
- `CREATE AGENT WORKFLOW` or hosted Synapsor SQL generation.
- Auto-merge or settlement policy semantics.
- Automatic rollback of external database writes.
- Model-callable approval or commit tools.
- Generic MCP firewall behavior.
- Prompt-injection prevention.
- High availability, SLA, compliance certification, or production support guarantee.

## Important External Database Semantics

External Postgres/MySQL databases are not branched or merged by Synapsor Runner.

The proposal, evidence, replay, and approval state live in Synapsor Runner locally or in Synapsor Cloud. The external source database changes only when a trusted runner applies an approved writeback job.

Local replay means replay of records captured by the runner:

- trusted context values used by the capability;
- captured/projected source-row excerpts;
- query audit fingerprints and redacted parameter metadata;
- proposal before/proposed diffs;
- approval/rejection events;
- guarded writeback jobs;
- applied/conflict/failed receipts.

It does not mean external Postgres/MySQL time travel. Runner cannot reconstruct
arbitrary historical rows that were never captured as evidence, and it does not
provide `AS OF` queries over an external source.

Local search is single-node SQLite search over the local runner store. It is
useful for local/dev/staging usage. It is not a hosted central evidence ledger,
not cross-runner aggregation, not RBAC/SSO, and not compliance retention.

Use this wording:

```text
External DB = Synapsor review state + trusted writeback
Synapsor-native = real branch + merge
```

Do not describe external approval as merge.

## Weak Conflict Guards

A version/timestamp column is the preferred conflict guard. A weak row-hash guard can be acknowledged for local/dev use, but it should not be presented as equivalent to a durable version column.
