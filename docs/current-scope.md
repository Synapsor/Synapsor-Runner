# Current Scope

The canonical scope page is [Current Limitations](limitations.md).

Current `1.1` scope:

- local semantic MCP tools for Postgres/MySQL-backed business actions;
- schema inspection and guided config generation;
- trusted context from environment/session values;
- evidence handles, query audit, proposals, receipts, and local replay;
- guarded single-row `UPDATE` writeback for simple edits;
- app-owned `http_handler` and `command_handler` executors for richer approved
  business transactions;
- stdio MCP, Streamable HTTP MCP, and a small JSON-RPC bridge.
- a bounded small-fleet shape with asymmetric claim-bound sessions, shared
  Postgres review state, source pools, fleet rate limits, readiness, protected
  metrics, verified quorum review, dead letters, and backup/restore/retention;

Stable `1.x` compatibility covers the documented `synapsor-runner` binary,
config schema version `1`, result envelope v2 with v1 opt-out, stdio/Streamable
HTTP MCP surfaces, documented MCP client snippets, proposal/evidence/replay
inspection commands, direct SQL writeback, and app-owned executor contracts.

Out of scope:

- raw `execute_sql`;
- model-generated SQL;
- generic INSERT/DELETE/UPSERT/DDL;
- generic multi-row SQL writeback;
- physical branching of external Postgres/MySQL;
- self-hosted Synapsor Cloud;
- unbounded or multi-region shared-ledger scale and a managed Runner fleet;
- production SLA or compliance certification.
