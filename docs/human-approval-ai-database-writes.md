# Human Approval For AI Database Writes

An AI agent should not both request and authorize a consequential database
write. Runner separates the model-facing proposal from the trusted decision and
execution paths.

The agent calls an activated semantic capability and receives the exact
proposed effect. The source database is unchanged. A human operator or a
separately reviewed policy decides outside MCP; only then can a trusted worker
recheck scope, evidence freshness, conflicts, bounds, affected rows, and
idempotency before commit.

## Approve The Effect, Not Merely The Tool Call

A client-level confirmation that a tool may run is useful, but a tool name and
arguments do not necessarily show the exact rows, before/after values, current
evidence, contract version, or affected-row limits. If that same tool performs
the write, invocation approval and commit authority are still coupled.

Runner's model-facing call creates an inert proposal instead. The decision is
bound to that exact capability digest, trusted scope ownership, target,
before/after effect, evidence, limits, and idempotency identity. Later contract
activation cannot reinterpret the old proposal. A stale or unverifiable direct
write is refused rather than silently refreshed.

## Review The Policy, Not Every Routine Change

Runner supports human/manual, human/worker, policy/manual, and policy/worker
modes. A team can review value, rate, and scope limits once, then allow routine
low-risk proposals to be policy-approved. Automatic apply requires a separate
deployment opt-in for the exact capability digest. Larger or unusual proposals
still wait for a person, and requests outside hard capability bounds are
refused.

The model never receives approval, apply, commit, worker, or activation tools.
A webhook response cannot approve a proposal.

## Direct And Application-Owned Writes

Runner can execute reviewed single-row CRUD and bounded-set changes with
conflict and row-count guards. Final revalidation occurs inside the
Runner-managed source transaction. With source-database receipt authority, the
mutation and receipt commit atomically. Runner-ledger authority may require
operator reconciliation after an ambiguous crash and does not claim distributed
exactly-once behavior.

Multi-step transactions, external side effects, and application-specific
authorization stay in an app-owned executor. Runner governs the proposal and
approval envelope, but your application owns final scope, conflict,
idempotency, transaction/rollback, and safe receipt behavior.

Start with the [Safe Action Human Control Plane](safe-action-control-plane.md),
then see [Guarded CRUD Writeback](guarded-crud-writeback.md), [Supervised
Automatic Apply](supervised-automatic-apply.md), and [App-Owned
Executors](app-owned-executors.md).

Start with a no-database proof:

```bash
npx -y @synapsor/runner try --prove
```
