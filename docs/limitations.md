# Limitations

Synapsor Runner v0.1 is intentionally narrow.

## Supported

- Stdio MCP server for semantic database capabilities.
- Local read and proposal tools.
- Local SQLite evidence/proposal/query-audit/replay store.
- Human approval through CLI commands.
- Public protocol objects:
  - `synapsor.change-set.v1`
  - `synapsor.writeback-job.v1`
  - `synapsor.execution-receipt.v1`
  - `synapsor.runner-registration.v1`
- Guarded single-row `UPDATE` for Postgres and MySQL.
- Primary-key guard.
- Tenant guard.
- Allowed-column validation.
- Version-column or explicit weak row-hash conflict guard.
- Idempotency receipts.
- Static MCP database risk review.

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
- Automatic rollback of external database writes.
- Model-callable approval or commit tools.
- Generic MCP firewall behavior.
- Prompt-injection prevention.
- High availability, SLA, compliance certification, or production support guarantee.

## Important External Database Semantics

External Postgres/MySQL databases are not branched or merged by Synapsor Runner.

The proposal, evidence, replay, and approval state live in Synapsor Runner locally or in Synapsor Cloud. The external source database changes only when a trusted runner applies an approved writeback job.

Use this wording:

```text
External DB = Synapsor review state + trusted writeback
Synapsor-native = real branch + merge
```

Do not describe external approval as merge.

## Weak Conflict Guards

A version/timestamp column is the preferred conflict guard. A weak row-hash guard can be acknowledged for local/dev use, but it should not be presented as equivalent to a durable version column.
