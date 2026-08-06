# Let An AI Agent Update A Production Database Safely

Do not connect an exploratory `execute_sql` tool to production. Production
authority should consist of named, reviewed operations with trusted scope,
fixed effects, bounded inputs, and approval outside the model.

Runner separates two stages:

1. **Explore through reviewed read-only authority.** Local development and
   staging are the default places to ask novel typed questions. Production
   Explore is separately opt-in and requires secured HTTP, verified JWT claims,
   a trusted principal, atomic per-principal privacy budgets, and rate limits.
2. **Protect the useful operation.** Runner freezes one successful plan into a
   disabled DSL capability, canonical contract, tests, provenance, privacy
   limits, and exact digest. A human reviews and activates that named authority.

For writes, the model creates a proposal and cannot commit it. Human or
reviewed-policy approval occurs outside MCP. A trusted worker revalidates the
live row scope, evidence, version, transition, bounds, row count, and
idempotency immediately before a guarded commit.

## Keep The Database As The Floor

- Use a non-owner least-privilege runtime role.
- Enforce tenant isolation with PostgreSQL RLS, restricted views, per-tenant
  credentials, or isolated deployments as appropriate.
- Keep network, secret, backup, monitoring, and application authorization
  controls in place.
- Route multi-step transactions and external effects to an app-owned executor.

Runner governs only traffic that passes through its activated capabilities. It
does not secure a second raw database tool, leaked credential, or application
bypass.

Start with a disposable proof, then connect staging:

```bash
npx -y @synapsor/runner try --prove
npx -y @synapsor/runner start
```

Read [Production](production.md),
[Production Scoped Explore Over HTTP](production-scoped-explore-http.md),
[Proposal Freshness](proposal-evidence-freshness.md), and
[Supervised Automatic Apply](supervised-automatic-apply.md).
