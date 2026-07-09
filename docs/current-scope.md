# Current Scope

The canonical scope page is [Current Limitations](limitations.md).

Current `0.1.x` scope:

- local semantic MCP tools for Postgres/MySQL-backed business actions;
- schema inspection and guided config generation;
- trusted context from environment/session values;
- evidence handles, query audit, proposals, receipts, and local replay;
- guarded single-row `UPDATE` writeback for simple edits;
- app-owned `http_handler` and `command_handler` executors for richer approved
  business transactions;
- stdio MCP, Streamable HTTP MCP, and a small JSON-RPC bridge.

Stable `0.1.x` compatibility covers the documented `synapsor-runner` binary,
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
- production SLA or compliance certification.
