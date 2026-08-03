# Synapsor vs A Raw Postgres MCP Server

A raw Postgres MCP server is useful when arbitrary SQL is the intended feature
and the data is disposable, synthetic, or already isolated to exactly what the
agent may see. It is a weak production boundary when the model can choose SQL,
tables, joins, filters, scope, or write timing.

| Question | Raw Postgres MCP | Synapsor Runner |
| --- | --- | --- |
| What does the model submit? | SQL or broad query arguments | Strict typed plans or named business actions |
| Who holds the credential? | Often the MCP server configured for the client | The trusted Runner process; credentials are omitted from client config |
| What schema is exposed? | Commonly the broad database catalog | Reviewed aliases and legal operations only |
| Who chooses tenant scope? | Prompt, SQL, or server implementation | Trusted runtime binding outside model arguments |
| How are writes handled? | Tool-dependent, sometimes immediate | Exact proposal, outside-model decision, guarded apply |
| What happens to an unsafe request? | Depends on SQL permissions and server checks | Deterministic refusal before execution |

Runner adds contract review, privacy and query limits, evidence, proposal
history, conflict guards, receipts, and replay. That machinery has a cost. If a
least-privilege read-only role already exposes exactly the acceptable data and
you need no shared review lifecycle, keep the simpler MCP server.

Audit the tool surface before choosing either path:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
npx -y @synapsor/runner audit ./tools-list.json
```

See [Choose The Smallest Safe Database Boundary](alternatives.md).
