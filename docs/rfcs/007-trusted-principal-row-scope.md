# RFC 007: Trusted Principal Row Scope

Status: accepted for implementation

## Problem

Runner already binds a trusted tenant and principal to a context, but the
principal is currently identity/audit metadata rather than a database row
predicate. Two users in one tenant can therefore share a tenant-scoped
capability even when each should see only rows assigned to that user.

## Canonical Shape

Add one optional subject field:

```json
{
  "tenant_key": "hospital_id",
  "principal_scope_key": "assigned_to"
}
```

The value for `principal_scope_key` always comes from the capability context's
required `principal_binding`. The contract does not store a principal value and
the model does not supply one.

The DSL form is:

```sql
TENANT KEY hospital_id
PRINCIPAL SCOPE KEY assigned_to
```

No second representation is introduced. Existing contracts without the field
retain their current tenant-scoped semantics.

## Invariant

```text
effective row authority = tenant predicate
                          AND principal predicate
                          AND reviewed fixed guards
```

Principal scope is invalid without tenant scope or without a required trusted
principal binding. It cannot replace tenant scope, use a model argument, OR
with another predicate, default to match-all, or be bypassed dynamically. A
tenant-wide supervisor uses a separately reviewed capability without principal
scope.

## Enforcement

The principal predicate is a bound SQL parameter in every applicable read,
proposal, aggregate, bounded-set, CRUD, compensation, and apply-time query.
INSERT forces the reviewed column from trusted context. Executor envelopes carry
an immutable reviewed scope guard. The principal scope is included in proposal
integrity and writeback authority.

Cloud receives only the reviewed column/binding metadata and a stable safe
fingerprint. The local proposal retains the trusted value needed for SQL. A
Cloud job cannot substitute it; Runner verifies the job fingerprint, proposal
hash, and contract digest before mutation.

Evidence, proposal, receipt, activity, and replay lookups recheck tenant and
principal authority. Opaque handles are not bearer credentials. A same-tenant
cross-principal miss has the same public result as a cross-tenant or absent row,
and the query performs no separate existence probe.

## Compatibility And Release

The field changes `@synapsor/spec`, `@synapsor/dsl`, and Runner behavior. It is
covered by canonical normalization/digest tests, TypeScript/C++ round-trip
fixtures, PostgreSQL/MySQL live tests, and packed-package tests. The next Runner
release remains on the `1.4.x` line and targets `1.4.122` if unused; this RFC
does not justify a `1.5.0` jump.
