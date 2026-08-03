# Synapsor vs A Custom API Layer For AI Agents

If your application already exposes narrow, authenticated business operations,
keep them. A good service layer may already enforce tenant scope, business
rules, transactions, and idempotency better than a generic database adapter.

Runner does not replace that layer. It adds the agent-specific control plane
that otherwise has to be rebuilt around every endpoint:

- reviewed capability schemas shared across MCP clients and agents;
- trusted context that cannot be supplied by the model;
- exact proposals before effects;
- human or policy decisions outside the model;
- evidence, query audit, conflict handling, receipts, and replay;
- one place to inspect and revoke model-facing authority.

For one or two low-risk tools owned by one team, custom code may be less work.
Runner becomes useful as consequential operations, agents, databases, clients,
or review requirements multiply.

A practical adoption path is:

```text
audit existing MCP -> wrap one consequential action -> run proposal-only ->
review policy tiers -> enable supervised execution
```

Use `synapsor-runner audit` without calling the existing business tools, then
read [Why Synapsor Over Prompt And Application Guardrails](why-synapsor-vs-app-guardrails.md)
and [App-Owned Executors](app-owned-executors.md).
