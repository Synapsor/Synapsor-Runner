# Choose The Smallest Safe Database Boundary

You do not always need Synapsor Runner. Choose the smallest boundary that
matches the authority and evidence your agent actually needs.

## Decision Summary

| Approach | Good fit | Main boundary | Main trade-off |
| --- | --- | --- | --- |
| Direct database MCP | Disposable local data, synthetic demos, or tightly isolated development | Database credential and server implementation | The model can express SQL and may hold broad query authority |
| Read-only database access | Exploration where database permissions and result exposure are already acceptable | Read-only role, views, RLS, and query controls | Read-only is not data-safe by itself; broad reads can still expose another tenant or sensitive columns |
| Hand-built application tool | A few stable business operations already owned by one application team | Application endpoint or stored procedure | Your team owns every scope, review, retry, conflict, receipt, and investigation guarantee |
| Synapsor Runner | Consequential reads or writes needing a shared reviewed boundary | Canonical capabilities plus Runner and database controls | Adds contract and operating machinery; it does not replace database security or application handlers |

## Direct Or Raw Database MCP

A raw database MCP server can be appropriate when all data is synthetic,
disposable, and isolated from production. It is also useful for a trusted
developer exploring a local database where arbitrary SQL is the intended
power.

It is a poor model-facing production boundary when a tool accepts SQL, table
names, columns, predicates, tenant identifiers, or credentials chosen by the
model. Prompt instructions and SQL blocklists do not remove that authority.
Read-only credentials limit writes but can still permit broad or cross-tenant
reads.

Audit a server before adopting Runner or any other replacement:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
npx -y @synapsor/runner audit ./tools-list.json
```

The audit is a structural review, not a penetration test or certification.

## Read-Only Database Access

Direct read-only access is often sufficient when:

- the agent is used by trusted internal developers;
- the database role can see only the rows and columns those users may see;
- restricted views or PostgreSQL row-level security enforce tenant scope;
- query cost and result size are bounded independently;
- no proposal, approval, receipt, or replay record is required.

Read-only does not mean harmless. Sensitive fields, cross-tenant records,
expensive queries, and data useful for later attacks can all be exposed without
a write. Keep the credential least-privileged and test the database policy as
the real authorization floor.

## Hand-Built Application Tools

A narrow application endpoint or stored procedure is often the best answer for
one or two stable operations. Trusted code should choose a fixed parameterized
query, derive tenant and principal scope from authenticated state, validate
business rules, and return only the required fields.

This may be enough when one team owns the entire path and does not need a
shared contract or review ledger. The team must still design and test:

- immutable intent and idempotency under retries;
- stale-data and concurrent-write conflicts;
- approval identity and quorum outside the model;
- exact before/after evidence and affected-row bounds;
- receipts, investigation, replay, and ambiguous-crash handling.

Runner can also route an approved proposal to an app-owned executor. Use that
boundary for external side effects, multi-table transactions, free-form
application logic, and operations the built-in guarded adapters intentionally
do not support.

## Synapsor Runner

Runner is useful when the model should receive reviewed semantic capabilities
instead of SQL and the organization needs the same trust mechanics across
tools or teams:

- trusted tenant and principal values stay outside model arguments;
- visible and kept-out fields are reviewed in one portable contract;
- model-facing writes create exact proposals without changing source data;
- activation, approval, apply, and compensation remain outside MCP;
- guarded apply rechecks scope, policy, conflict, bounds, and idempotency;
- evidence, proposal history, receipts, and replay preserve the lifecycle.

This is not magic and it is not a claim that these mechanics cannot be built in
application code. Runner packages a specific enforcement and evidence model so
each integration does not invent a subtly different one.

## What Runner Does Not Protect

Runner governs traffic that passes through its reviewed capabilities. It does
not:

- prevent prompt injection or make arbitrary SQL safe;
- stop a separate raw database tool, leaked credential, or application bypass;
- replace PostgreSQL RLS, restricted views, database grants, or network policy;
- make a deployment compliant with HIPAA, PCI DSS, SOC 2, or another standard;
- provide backups, disaster recovery, or protection from a trusted host or
  database administrator;
- safely infer tenant scope, hidden fields, approval policy, or write authority.

Keep least-privilege roles, RLS or tenant-restricted views, encryption,
monitoring, tested backups, and application authorization underneath Runner.
For PostgreSQL, prefer transaction-bound RLS when the topology supports it. For
MySQL, use restricted views, per-tenant credentials, or isolated deployments
where required.

## A Practical Evaluation

1. Audit the model-facing tools and identify who chooses SQL, tenant scope,
   fields, predicates, approval, and commit timing.
2. Keep direct read-only access if database policy already provides the exact
   safe boundary and no review lifecycle is needed.
3. Keep a hand-built tool if it is narrow, well-tested, and its operational
   guarantees are sufficient.
4. Try Runner on one consequential staging action when you need an exact Data
   PR, approval outside the agent, guarded commit, receipt, and replay.

Continue with [Connect Your Own Database](getting-started-own-database.md),
[Security Boundary](security-boundary.md), or the deeper [build-versus-adopt
analysis](why-synapsor-vs-app-guardrails.md).
