# Copilot Instructions

Follow `AGENTS.md` for this repository.

Synapsor Runner is a database/MCP safety tool. Preserve these invariants:

- model-facing tools are reviewed capabilities, not raw SQL;
- writes are proposals until approval outside MCP;
- direct writeback must enforce tenant scope, primary key targeting, allowed
  columns, conflict/version guard, affected-row count, idempotency, and receipt
  recording;
- app-owned handlers must re-check tenant/scope, expected version,
  idempotency, allowed action, transaction/rollback, and safe receipts;
- tests must cover safety-boundary changes.

Use local commands from `AGENTS.md`; do not read or edit generated `dist/`
files when changing source behavior.
