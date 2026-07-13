# RFC 006: Reviewed Reversible Change Sets

Status: implemented and verified for the prepared Runner 1.4 release line

## Problem

An applied direct database write currently has evidence, approval, a guarded
writeback receipt, and replay, but no bounded compensating action. Correcting a
mistake requires an operator to author a new forward proposal manually.

Runner should be able to prepare a reviewed compensation without becoming a
database time-travel system or introducing an unreviewed rollback path.

## Safety boundary

Reversal is opt-in contract authority:

```json
{
  "reversibility": {
    "mode": "reviewed_inverse"
  }
}
```

The declaration is valid only for Runner-owned `direct_sql` writeback. It does
not apply to app handlers, Cloud workers, email, payments, or any other
external effect.

`synapsor-runner revert <proposal-id>` creates a new proposal. It never:

- mutates the source database;
- approves the proposal;
- bypasses tenant or operator identity checks;
- appears in the model-facing MCP tool list.

The new proposal must be independently approved and applied through the normal
trusted operator path.

## Protocol split

Published v1, v2, and v3 forward writeback jobs keep their existing meaning.
Reversible forward jobs carry an additive, explicit inverse-capture request.
The resulting execution receipt carries a bounded inverse descriptor only
after a successful, unambiguous source transaction.

Compensation is executed through a distinct normalized protocol v4 job. A v4
job contains:

- the exact source, tenant, and primary-key authority;
- a bounded, deterministically ordered member list;
- the original single-row or set cardinality;
- the state expected after the forward write;
- only the reviewed values to restore or remove;
- the original row and aggregate caps;
- the original approval role and quorum;
- lineage linking root, parent, and reverted proposals and the forward receipt;
- a maximum lineage depth.

This prevents compensation semantics from being inferred from a legacy job.

## Operation semantics

### UPDATE and soft delete

The inverse restores only previously reviewed writable values. The row must
still match the exact reviewed state left by the forward write. A monotonic
version column advances again during compensation; it is never decremented.
Any intervening write fails closed.

A soft delete is an UPDATE of a reviewed status or deletion marker and follows
these same rules.

### INSERT

The inverse deletes only the exact Runner-created identity. The current row
must still match the allowlisted values inserted by Runner. Trigger and foreign
key safety is rechecked immediately before deletion. A new dependent row or a
changed value blocks compensation.

Because this delete removes a row whose complete Runner-supplied values are
known, its own inverse may reinsert that exact row. It cannot infer or restore
unreviewed database-generated or trigger-generated state.

### Hard DELETE

A general hard DELETE records bounded reviewed before-state evidence but is
not automatically restorable. Generated identities, hidden required columns,
cascaded children, and trigger side effects cannot be reconstructed safely.
The receipt marks the inverse unavailable with specific reason codes and the
CLI recommends soft delete or an app-owned compensation capability.

## Bounded sets

Set compensation uses exactly the original frozen identities. It cannot widen
the predicate or increase the original row/value caps. Every member is locked
in deterministic primary-key order and checked before any mutation. One stale
member rolls back the entire transaction.

The inverse descriptor is bounded to 100 members and 256 scalar fields per
member, matching the public protocol hard ceilings.

## Receipt authority and crash behavior

With source-database receipt authority, mutation and source receipt remain in
one transaction. The inverse descriptor is deterministic from the immutable
job plus the state verified in that transaction, so an idempotent retry can
reproduce it without rereading kept-out columns.

With Runner-ledger authority, the existing cross-database crash window remains.
An ambiguous forward or compensation outcome enters
`reconciliation_required`. Runner does not generate or apply a revert until an
operator reconciles the original outcome and an applied receipt with an
available inverse exists.

## Lineage

Every compensation proposal records:

- `root_proposal_id`;
- `parent_proposal_id`;
- `reverts_proposal_id`;
- `forward_receipt_hash`;
- `depth`.

Depth is capped at 16. The same applied receipt may have only one active or
completed compensation child. To undo a compensation, the operator reverts the
child proposal, creating a linear audited chain instead of a cycle.

## Data minimization

Inverse capture may retain only:

- fixed primary-key and trusted tenant identity;
- conflict/version metadata;
- fields in the reviewed write allowlist;
- Runner-supplied deterministic deduplication fields needed to identify an
  inserted row.

Visible read fields that were not writable and all kept-out fields are excluded.
Reversibility is rejected when the safe inverse cannot be represented with that
bounded data.

## Explicit non-goals

- point-in-time recovery or WAL replacement;
- automatic rollback;
- model-facing revert, approve, apply, or receipt tools;
- restoration of arbitrary hard deletes;
- compensation of app-owned executors or external effects;
- cross-table, cross-database, or unbounded compensation;
- weakening the existing optimistic concurrency and receipt-authority model.
