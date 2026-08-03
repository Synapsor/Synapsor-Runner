# Safe Postgres MCP For AI Agents

A safe Postgres MCP server should not hand the model a database credential and
an `execute_sql` tool. It should expose only reviewed operations, derive tenant
and user scope from trusted runtime state, and keep approval and commit outside
the model-facing tool list.

Synapsor Runner applies that boundary to Postgres and MySQL. The local Runner
process holds the least-privilege credential. The agent receives typed tools
whose tables, fields, relationships, filters, aggregates, result limits, and
write effects were reviewed before activation.

## What The Agent Can Do

- Ask new read-only questions by combining reviewed measures, dimensions,
  filters, time grains, and many-to-one relationship paths.
- Call activated named read capabilities in production.
- Propose only the exact write effects allowed by an activated capability.

## What The Agent Cannot Do

- Send SQL, SQL fragments, arbitrary table names, or arbitrary joins.
- Choose database credentials, tenant scope, principal scope, or deployment.
- Read kept-out fields or widen result and privacy limits.
- Activate access, approve a proposal, apply a write, or confirm a digest.

The model does receive the reviewed aliases and legal operations needed to
compose typed plans. It does not receive unrestricted schema metadata, raw DDL,
kept-out fields, database credentials, or a fallback SQL tool.

## Start With A Read-Only Database Role

```bash
npx -y @synapsor/runner start
```

Runner inspects schema metadata, drafts conservative access with no authority,
and asks a human to review the exact boundary before the agent can query data.
Use PostgreSQL grants and RLS as the database floor; Runner does not replace
them. Continue with [Database To First Safe Tool](guided-onboarding.md) and
[Security Boundary](security-boundary.md).

For disposable local data where arbitrary SQL is intentional, a direct
database MCP may be simpler. See [Synapsor vs a raw Postgres MCP](synapsor-vs-raw-postgres-mcp.md).
