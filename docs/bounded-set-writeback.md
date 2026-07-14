# Bounded Set Writeback

Synapsor Runner can apply a deliberately narrow class of reviewed
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

## Worked contract-to-apply example

This PostgreSQL example closes two overdue tickets. MySQL is supported with
the same contract semantics; change the source engine and schema/database name
to match the inspected MySQL object.

Create the fixture with an administrator account, then give the Runner reader
`SELECT` and its separate writer only `SELECT, UPDATE` on this table:

```sql
CREATE TABLE public.service_tickets (
  id bigint PRIMARY KEY,
  tenant_id text NOT NULL,
  status text NOT NULL,
  cost_cents integer NOT NULL,
  version integer NOT NULL
);

INSERT INTO public.service_tickets
  (id, tenant_id, status, cost_cents, version)
VALUES
  (3, 'acme', 'overdue', 8000, 1),
  (4, 'acme', 'overdue', 15000, 1),
  (99, 'globex', 'overdue', 49000, 1);
```

Save this as `tickets.synapsor.sql`:

```sql
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY tickets.close_overdue
  USING CONTEXT local_operator
  SOURCE local_db
  ON public.service_tickets
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  LOOKUP reason BY id
  ARG reason STRING REQUIRED MAX LENGTH 100
  ALLOW READ id, tenant_id, status, cost_cents, version
  REQUIRE EVIDENCE
  PROPOSE ACTION close_overdue UPDATE SET
  SELECT WHERE status = 'overdue'
  MAX ROWS 10
  MAX TOTAL cost_cents BEFORE 50000
  ALLOW WRITE status
  PATCH status = 'closed'
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE ops_manager
  WRITEBACK DIRECT SQL
END
```

Compile the contract and create `synapsor.runner.json`:

```bash
synapsor-runner dsl compile ./tickets.synapsor.sql \
  --out ./synapsor.contract.json --strict
synapsor-runner contract validate ./synapsor.contract.json
```

```json
{
  "version": 1,
  "mode": "review",
  "storage": { "sqlite_path": "./.synapsor/local.db" },
  "sources": {
    "local_db": {
      "engine": "postgres",
      "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL",
      "statement_timeout_ms": 3000,
      "receipts": { "authority": "runner_ledger" }
    }
  },
  "contracts": ["./synapsor.contract.json"]
}
```

Load database URLs from your shell or secret manager. The config stores only
environment-variable names. Trusted tenant/principal values are process-owned,
not tool arguments:

```bash
export SYNAPSOR_TENANT_ID=acme
export SYNAPSOR_PRINCIPAL=local_operator

synapsor-runner config validate --config ./synapsor.runner.json
synapsor-runner doctor --config ./synapsor.runner.json --check-writeback
synapsor-runner propose tickets.close_overdue \
  --json '{"reason":"reviewed overdue-ticket close"}' \
  --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner proposals show latest --store ./.synapsor/local.db --details
```

At this point IDs `3` and `4` are frozen in the proposal, but both source rows
are still `overdue` at version `1`; the `globex` row is outside trusted tenant
scope. Approval and apply remain operator-side commands and are not MCP tools:

```bash
synapsor-runner proposals approve latest --actor ops_manager --yes \
  --store ./.synapsor/local.db
synapsor-runner apply latest --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner receipts list --proposal <proposal_id> \
  --store ./.synapsor/local.db
synapsor-runner replay show --proposal <proposal_id> --details \
  --store ./.synapsor/local.db
```

Exactly IDs `3` and `4` become `closed` at version `2` in one transaction.
The receipt/replay list both safe primary-key identities and their bounded
digests. ID `99` is unchanged.

To test drift on a freshly seeded copy, create the proposal, then use a
database-operator session to increment one frozen row's version before
approval. `apply` returns `SET_DRIFT_CONFLICT`; the other frozen row remains
unchanged because no partial set mutation is committed:

```sql
UPDATE public.service_tickets SET version = version + 1 WHERE id = 4;
```

The example uses `runner_ledger`, which creates no receipt table in the source
database. For one local process, the local store is the authority; a fleet must
use authoritative shared-Postgres `runtime_store`. `source_db` authority
instead writes the mutation and receipt atomically in one source transaction
and requires its fixed precreated or auto-migrated receipt table. See
[Guarded CRUD receipt authority](guarded-crud-writeback.md).

## Proposal and apply behavior

Proposal creation stores:

- the exact ordered primary keys and trusted tenant;
- every exact expected version;
- allowlisted before/after values or bounded digests;
- reviewed row count and aggregate values;
- a digest over the complete frozen set;
- pending human/operator approval.

Member and set digests use SHA-256 over JSON whose object keys are sorted
recursively. Array order remains significant because it is the reviewed,
deterministic primary-key order. JSON strings, finite numbers, booleans, and
null retain their protocol representation; unsupported runtime objects and
non-finite values are rejected rather than stringified implicitly. Runner
1.4.1 also verifies the narrowly known deterministic raw-object order emitted
by 1.4.0, reconstructed from the complete stored reviewed data, so unchanged
1.4.0 proposals remain applyable without weakening the drift checks.

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

Policy auto-approval is not supported for bounded sets. Every set proposal
requires a verified human/operator decision.

## Verification

Run the disposable-engine gate:

```bash
corepack pnpm test:bounded-set
```

It verifies both PostgreSQL and MySQL: the exact DSL/contract path under both
receipt authorities; cap+1 and aggregate rejection before persistence; exact
UPDATE/DELETE; batch INSERT; idempotent retry; independent version, predicate,
aggregate, writable-value, missing-member, and tenant drift; injected mid-set
rollback; insert dedup/atomicity; delete trigger/cascade refusal; exact receipt
members; Runner-ledger reconciliation; and 1/10/100-row bounds. See the
[local benchmark note](benchmarks/bounded-set-local.md) and the normative
[safety RFC](rfcs/005-bounded-set-writeback.md).
