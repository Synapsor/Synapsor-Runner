# Complete Collection Verification

Status: implementation in progress; not yet a qualified release feature.

An empty collection is not proof of absence if another transaction can add a
matching row, or if row security hides a matching row. Negative existence and
derived totals must therefore opt into `collection_consistency: complete_locked`
on a bounded private Verification collection. Old positive-existence rules do
not acquire new authority automatically.

The first supported shape is an inverse, inspected foreign key from a single
scoped parent to a complete child collection. Every composite key component is
retained. The parent is loaded first, and every matching child row is loaded,
including inactive rows. Business predicates are evaluated after loading, not
pushed into a filter that could omit a row which later becomes relevant.
Overflow and an unavailable parent fail closed. No unbounded source query is
introduced, and no verification fields become model-visible.

PostgreSQL uses READ COMMITTED, a FOR UPDATE lock on the exact parent, and
FOR UPDATE locks on all matching children. The validated, immediate foreign key
makes a concurrent insert or retarget wait for the parent lock. Existing child
changes wait for their row lock. A fresh statement snapshot after a lock wait is
necessary; a pre-lock repeatable-read snapshot is not sufficient. Relation locks
and fresh metadata validation prevent a changed foreign key or RLS policy from
silently invalidating the proof.

PostgreSQL RLS must be complete for the already selected customer scope. The
supported proof is a closed conjunction of reviewed tenant/principal equality
predicates against the exact bound settings, with no other predicates, functions
or disjunctions. Applicable SELECT and locking UPDATE policies must be checked
independently. Extra restrictions are unsupported, not bypassed. Superuser,
BYPASSRLS and missing RLS protections remain subject to existing validation.

MySQL uses InnoDB REPEATABLE READ and current locking reads over the complete
bounded relationship range. Next-key locks protect insertion gaps as well as
existing rows. READ COMMITTED is insufficient. Runtime qualification must use a
real server; an adapter mock is not proof of phantom prevention.

Both paths recheck the exact approved dependency facts in the source execution
transaction. No source rows change during preparation. Missing grants are an
execution prerequisite, not a reason to request schema changes during drafting.

Required qualification includes empty/nonempty collections, inserts and status
changes racing execution, complete composite keys, cross-customer isolation,
overflow, hidden rows, policy/FK drift, rollback and a successful durable receipt.
Until those tests pass, absence and totals remain unqualified in the capability
matrix. This design does not claim versionless mutations or arbitrary SQL policy
equivalence.

## Expressions And Review

Reviewed collections support `count`, `sum`, `min` and `max`, optionally filtered
by a typed `where` predicate after the entire collection is locked. Nested
existence checks used by a total or absence predicate require complete proofs
too. Unknown filter results and missing/null summands are not silently dropped.
Empty count and sum are zero; an empty min/max is unknown. Count uses integer
unit `rows`; sum preserves the reviewed numeric unit. Non-null derived effects
cannot depend on a potentially empty min/max. Checked arithmetic refuses overflow.

`date_of(timestamp, timezone: UTC)` explicitly selects a calendar day. Comparing
a date with a timestamp without this conversion remains an error. Elapsed windows
continue to use `add_duration`; calendar days are not approximated by durations.

The model drafts these expressions in the existing structured contract. Runner
infers collection consistency, retains private fields and presents filtered
conditions in exact review. Read-connection metadata checks need no customer
identity or write grants. Missing/deferred foreign keys and incomplete RLS are
separate blockers from writer provisioning, not invitations to weaken the policy.

## Explicit Clearing

A reviewed nullable target can be cleared using a typed null literal directly
in `effect.set` and `values: [null]` in its effect-field allowlist. This is an
explicit immutable permission, not a new default for nullable fields. Multiple
clears and other assignments in one guarded UPDATE commit together. A missing
or nullable source fact is still unknown; copying it does not become a clear.
Named derivations, row identity, trusted scope and version guards cannot be null.
Non-nullable targets reject clearing during compilation. The guarded adapters
bind SQL NULL as a parameter and record it in the exact effect and receipt.

This supports restoring a record while clearing its removal reason/date. It
does not remove eligibility checks, source-version validation or human review.
