# Current Scope

The canonical scope page is [Current Limitations](limitations.md).

Current `1.3` scope:

- local semantic MCP tools for Postgres/MySQL-backed business actions;
- schema inspection and guided config generation;
- trusted context from environment/session values;
- evidence handles, query audit, proposals, receipts, and local replay;
- guarded single-row `INSERT`, `UPDATE`, and `DELETE` writeback with explicit
  receipt authority;
- fixed-predicate set `UPDATE`/`DELETE` and exact-review batch `INSERT`, with
  mandatory row/value caps, frozen members, human approval, atomic execution,
  and protocol-v3 exact receipts;
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
- UPSERT, DDL, model-generated predicates, or unguarded INSERT/DELETE;
- model-generated, unbounded, or cross-table set writeback;
- physical branching of external Postgres/MySQL;
- self-hosted Synapsor Cloud;
- unbounded or multi-region shared-ledger scale and a managed Runner fleet;
- production SLA or compliance certification.
