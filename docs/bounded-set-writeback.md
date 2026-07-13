# Bounded Set Writeback

Synapsor Runner 1.3 can apply a deliberately narrow class of reviewed
multi-row database changes to PostgreSQL and MySQL:

- fixed-predicate set `UPDATE`;
- fixed-predicate set `DELETE`;
- exact-review batch `INSERT`.

This is not model-generated SQL and it is not a generic batch API. The model
can ask to run a reviewed business action, but it cannot choose a table,
column, operator, ordering, predicate, tenant, or unbounded set.

## Safety invariant

The worst action available to a prompt-injected model is to request one
contract-authored rule, against the trusted tenant, up to the reviewer-authored
row and value caps. Before approval, Runner freezes the exact ordered members.
Apply later touches only those members in one transaction and records every
identity and bounded digest.

Every bounded set requires:

1. a fixed typed selection for existing-row UPDATE/DELETE, or the complete
   reviewed item array for batch INSERT;
2. `MAX ROWS n`, where `1 <= n <= 100`;
3. at least one aggregate `MAX TOTAL` bound;
4. trusted tenant binding;
5. exact version guards and integer advancement for set UPDATE;
6. source-unique per-item identities for batch INSERT;
7. human/operator approval outside MCP;
8. one atomic source transaction and an exact affected-row count;
9. source or Runner-ledger receipts with the documented crash semantics.

A row cap is a rejection threshold, never `LIMIT n` truncation. Proposal reads
fetch at most `n + 1`; finding the extra row rejects before proposal
persistence. Aggregate overflow also rejects before persistence.

## DSL examples

Fixed set UPDATE:

```sql
PROPOSE ACTION close_overdue UPDATE SET
SELECT WHERE status = 'overdue'
MAX ROWS 10
MAX TOTAL balance_cents BEFORE 50000
ALLOW WRITE status
PATCH status = 'closed'
ADVANCE VERSION version USING INTEGER INCREMENT
APPROVAL ROLE billing_reviewer
WRITEBACK DIRECT SQL
```

The selection is a contract literal. It is not an argument and is never taken
from the model. The first release supports equality terms joined by `AND`.

Exact-review batch INSERT:

```sql
ARG items ROWS MAX 10 REQUIRED
ITEM FIELD items.id STRING REQUIRED MAX LENGTH 128
ITEM FIELD items.external_id STRING REQUIRED MAX LENGTH 128
ITEM FIELD items.amount_cents NUMBER REQUIRED MIN 1 MAX 2500
ITEM FIELD items.reason STRING REQUIRED MAX LENGTH 500

PROPOSE ACTION create_credits INSERT SET
BATCH ITEMS FROM ARG items
MAX ROWS 10
MAX TOTAL amount_cents AFTER 25000
DEDUP KEY tenant_id = TRUSTED TENANT, id = ITEM id, external_id = ITEM external_id
ALLOW WRITE amount_cents, reason
PATCH amount_cents = ITEM amount_cents
PATCH reason = ITEM reason
APPROVAL ROLE billing_reviewer
WRITEBACK DIRECT SQL
```

The reviewer sees every allowlisted candidate item before approval. The source
must enforce the declared identity with a primary or unique constraint.

Set DELETE uses `DELETE SET`, a fixed selection, `MAX ROWS`, `MAX TOTAL`, and
an exact conflict guard. It has no patch. Runner rejects hard DELETE if it
cannot prove trigger/FK visibility or detects write triggers or widening
cascades. Prefer a set UPDATE of `deleted_at` or status when possible.

## Proposal and apply behavior

Proposal creation stores:

- the exact ordered primary keys and trusted tenant;
- every exact expected version;
- allowlisted before/after values or bounded digests;
- reviewed row count and aggregate values;
- a digest over the complete frozen set;
- pending human/operator approval.

Apply locks the frozen rows in deterministic primary-key order, rechecks every
reviewed value/version, performs every member mutation in one transaction, and
requires the affected count to equal the frozen count. One missing/stale row or
one database error rolls back the whole set.

Set `sources.<name>.statement_timeout_ms` to bound source waits. PostgreSQL
uses transaction-local statement and lock timeouts. MySQL applies the value to
read/preflight execution and rounds it up to whole seconds for InnoDB lock
waits; MySQL does not offer the same general DML statement timeout as
PostgreSQL.

The protocol-v3 receipt and replay include every primary key plus the bounded
before/after or tombstone digests. Kept-out fields are never added merely to
support a set operation.

## Receipt authority and ambiguity

`source_db` authority commits the mutation and receipt in the same source
transaction. It gives the strongest retry classification.

`runner_ledger` authority creates no source receipt table, but no atomic
transaction spans the source and Runner ledger. A process loss after source
commit can therefore produce `reconciliation_required`. Runner does not retry
or guess. The operator reconciliation path re-inspects only the frozen,
allowlisted identities and records an immutable decision.

## Explicit boundary

Use an [app-owned executor](writeback-executors.md) for:

- model-supplied or free-form predicates;
- ranges, wildcards, ordering, subqueries, or dynamic identifiers;
- more than 100 rows or any unbounded batch;
- UPSERT/MERGE, DDL, stored procedures, or cross-table/database transactions;
- external API calls, events, files, emails, payments, or other side effects;
- a hard DELETE whose trigger/cascade effects cannot be proven bounded.

Policy auto-approval is not supported for bounded sets in 1.3. Every set
proposal requires a verified human/operator decision.

## Verification

Run the disposable-engine gate:

```bash
corepack pnpm test:bounded-set
```

It verifies both PostgreSQL and MySQL: cap+1 and aggregate rejection before
persistence, exact UPDATE/DELETE, batch INSERT, idempotent retry, stale-member
rollback, injected mid-set rollback, insert dedup/atomicity, delete trigger and
cascade refusal, exact receipt members, Runner-ledger reconciliation, and
1/10/100-row bounds. See the [local benchmark note](benchmarks/bounded-set-local.md)
and the normative [safety RFC](rfcs/005-bounded-set-writeback.md).
