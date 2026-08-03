# Synapsor vs Stored Procedures For AI Agents

A fixed stored procedure is much safer than giving a model arbitrary SQL. Keep
it when it already enforces the correct inputs, scope, transaction, and output.
Synapsor is useful when you also need a consistent agent-facing review and
evidence lifecycle across many operations.

## What A Stored Procedure Can Own Well

- Fixed parameterized database logic.
- Multi-row transactions close to the data.
- Database grants and execution permissions.
- Stable application-specific invariants.

## What Runner Adds Around It

- A portable reviewed tool schema with no SQL argument.
- Trusted tenant and principal binding outside model inputs.
- Disabled generation and exact-digest activation.
- Exact proposals before consequential effects.
- Human or reviewed-policy decisions outside MCP.
- Evidence, conflict checks, idempotency, receipts, and replay.

Do not rewrite a correct complex transaction as generic Runner SQL. Expose it
through an app-owned executor or a narrow reviewed capability, keep its own
authorization and idempotency checks, and let Runner govern what the agent may
request.

Start with [App-Owned Executors](app-owned-executors.md) and [Why Synapsor Over
Application Guardrails](why-synapsor-vs-app-guardrails.md).
