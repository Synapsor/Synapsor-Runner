# RFC 005: Bounded Set Writeback

Status: implementation gate

## Purpose

Runner 1.3 may execute a reviewed set write only when the set is fixed by the
contract, frozen before approval, bounded by both row count and business value,
and applied atomically. A row cap by itself is not a safety boundary.

This RFC authorizes three direct operations:

- fixed-predicate set UPDATE;
- fixed-predicate set DELETE;
- exact-review batch INSERT.

Free-form predicates, model-selected columns or operators, unbounded sets,
UPSERT, DDL, cross-table work, and external effects remain app-owned executor
work.

## Canonical Model

Set operations are explicit. They never reuse a single-row lookup by merely
raising `max_rows`.

```json
{
  "operation": {
    "kind": "update",
    "cardinality": "set",
    "selection": {
      "all": [
        { "column": "status", "operator": "eq", "value": "overdue" }
      ]
    },
    "max_rows": 10,
    "aggregate_bounds": [
      { "column": "balance_cents", "measure": "before", "maximum": 50000 }
    ]
  }
}
```

The first release accepts only contract literals in `selection`. The typed AST
reserves no raw SQL escape hatch. The model can trigger the reviewed capability
but cannot choose a predicate, column, operator, ordering, range, wildcard, or
set size.

Batch INSERT uses an explicitly typed bounded item-array argument. Every item
is fully materialized in the proposal, receives the trusted tenant, and has a
source-enforced unique dedup identity. A generic JSON blob is not accepted.

## Hard Limits

- `MAX ROWS` is mandatory and must be between 1 and 100.
- at least one aggregate value bound is mandatory;
- a proposal query fetches at most `MAX ROWS + 1` rows;
- at most 64 reviewed columns may be captured per row;
- before/after payloads and digests are bounded before persistence;
- overflow rejects the proposal; it is never truncated to the cap.

The implementation ceiling of 100 is a safety limit, not a throughput claim.

## Frozen Set

At proposal time Runner stores, in deterministic primary-key order:

- exact primary key;
- trusted tenant;
- expected version for UPDATE/DELETE;
- allowlisted before and after values;
- per-row before and after digests;
- count, aggregate measurements, and one set digest.

Apply never re-runs the broad selection predicate. It locks the frozen primary
keys in the same deterministic order, rechecks tenant and every expected
version, and mutates the complete set in one transaction. A missing or stale
member rolls back the whole transaction.

## Approval

All set operations require verified human/operator approval in 1.3. Policy
auto-approval is rejected rather than silently downgraded. Set hard DELETE and
batch INSERT are never auto-approved. This keeps row/value-aware policy design
out of the first release.

## Exact Effects

The receipt and replay carry every affected primary key and bounded before/
after digest. Kept-out fields are never fetched merely to improve audit detail.
The source receipt and mutation share one transaction in `source_db` mode.
`runner_ledger` mode retains the documented post-source-commit ambiguity and
uses `reconciliation_required`; it never retries an ambiguous batch.

## Operation Rules

### Set UPDATE

- fixed literal predicate;
- fixed or scalar-argument patch with existing per-field bounds;
- exact version guard and monotonic version advance for every row;
- mandatory aggregate bound;
- one transaction and exact affected-row count.

### Set DELETE

- fixed literal predicate;
- exact version guard for every row;
- verified human approval;
- no write triggers or cascading foreign keys;
- bounded tombstones and exact identities.

Soft delete remains the preferred set operation because it is a guarded
UPDATE and can later be reversed safely.

### Batch INSERT

- one typed item array with `max_items` no greater than `MAX ROWS`;
- every candidate row shown in the proposal;
- trusted tenant injected by Runner;
- source UNIQUE/PRIMARY KEY dedup identity for every item;
- per-item bounds plus a mandatory aggregate bound;
- all rows and source receipts commit atomically or none do.

## Threat Cases And Fixtures

| Threat | Mitigation | Conformance fixture |
| --- | --- | --- |
| R1 selection abuse | literal typed predicate; no model predicate inputs | `bounded-set-r1-fixed-selection` |
| R2 misleading cap | row cap plus aggregate value bound; overflow rejects | `bounded-set-r2-count-value-cap` |
| R3 TOCTOU drift | frozen PK/version set; apply never broad-requeries | `bounded-set-r3-frozen-drift` |
| R4 partial application | one transaction; exact count; rollback on any member | `bounded-set-r4-atomic-rollback` |
| R5 audit collapse | every key and bounded before/after digest in receipt/replay | `bounded-set-r5-exact-receipt` |
| R6 DELETE cascades | hard DELETE preflight rejects cascades/write triggers | `bounded-set-r6-delete-side-effects` |
| R7 auto-approval amplification | human approval mandatory; policy mode rejected | `bounded-set-r7-human-approval` |

Each fixture must be exercised by canonical validation and runtime/adapter
tests. A fixture file that is never loaded by a test is not evidence.

## Crash And Receipt Matrix

| Outcome | `source_db` | `runner_ledger` |
| --- | --- | --- |
| before source BEGIN | no effect | durable intent, no effect |
| one member stale | complete rollback and conflict receipt | complete rollback and terminal conflict |
| process death before source commit | complete rollback | complete rollback; intent may be safely resolved as not committed |
| process death after source commit | source mutation and receipt prove outcome atomically | `reconciliation_required`; never automatic retry |
| retry after completed receipt | `already_applied` | `already_applied` from authoritative ledger |

No mode claims a distributed transaction across Runner's ledger and an external
source database.

## Release Gate

The feature remains unavailable until Postgres and MySQL live tests prove:

- cap+1 and aggregate overflow reject before proposal persistence;
- one stale member and injected failure leave every source row unchanged;
- lock order is deterministic;
- exact IDs/digests appear in receipts and replay;
- hard DELETE side effects and auto-approval are rejected;
- batch INSERT dedup and crash behavior are safe in both receipt modes;
- seeded 1, 10, and 100 row measurements are recorded as local evidence only.

