# Let An AI Agent Update A Production Database Safely

The production problem is database authority, not merely connectivity. Do not
connect an exploratory `execute_sql` tool to production. Production authority
should consist of reviewed data grammar or named operations with trusted scope,
bounded effects, and decisions outside the model.

```text
Explore -> Protect -> Propose -> outside-model decision -> Commit -> Receipt
```

Explore is the reviewed discovery surface. Protect freezes a useful read into
named authority. A write tool creates an exact proposal without mutation. A
human or reviewed policy decides outside MCP, and trusted execution records the
outcome.

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
idempotency immediately before a Runner-managed direct commit.

That final guarantee depends on the executor. Direct SQL writeback can recheck
inside the source transaction; source-database receipt authority can commit the
mutation and receipt atomically. Runner-ledger authority can require operator
reconciliation after an ambiguous crash and is not distributed exactly-once.
For an app-owned HTTP or command handler, Runner validates the approved proposal
before invocation, while the application owns final scope, conflict,
idempotency, transaction, rollback, and external-effect behavior.

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
