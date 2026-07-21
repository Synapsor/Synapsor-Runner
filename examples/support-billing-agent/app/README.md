# App Surface

This folder marks the customer application boundary for the flagship demo.

The model talks to Synapsor Runner MCP tools. It does not receive application
write credentials or direct SQL authority. After approval, the trusted runner
uses the reviewed `synapsor.runner.json` contract to apply the one-row
writeback with tenant, primary-key, allowed-column, idempotency, and
`updated_at` conflict guards.

For richer app actions, such as inserting a credit ledger row and emitting an
event, use the app-owned handler examples in `../app-owned-writeback/` and
`../mcp-postgres-billing-app-handler/`.

`contract.ts` demonstrates the optional typed authoring frontend without
changing the canonical contract. `record-shadow-outcomes.mjs` is the normal-app
bridge for authoritative human outcomes. `effect-adapter.mjs` is a deterministic
propose-only CI adapter; it receives a bounded fixture path and emits one
canonical result. Neither helper approves, applies, or mutates the source.
