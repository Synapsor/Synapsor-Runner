# Compensation Protocol v4

Protocol v4 is used only for reviewed compensation. Existing v1 single-row,
v2 CRUD, and v3 bounded-set objects keep their meaning.

Public objects:

- `synapsor.compensation-change-set.v1`;
- `synapsor.inverse-descriptor.v1`;
- `synapsor.writeback-job.v4`;
- `synapsor.execution-receipt.v4`.

The compensation change set is a normal proposal with a new proposal ID,
principal, tenant scope, evidence, approval requirement, integrity hash, and a
link to the exact applied forward receipt. It does not authorize execution.

The inverse descriptor records:

- `availability` plus specific `reason_codes` when unavailable;
- `restore_update`, `remove_insert`, or `restore_insert`;
- single-row or exact-set cardinality;
- fixed source, table, tenant guard, and allowed columns;
- exact primary-key members, expected forward state, and restore values;
- original row/aggregate caps and integer version advancement;
- root/parent/reverted proposal lineage and bounded depth.

A v4 writeback job is created only after the compensation proposal is
independently approved. The adapter locks and validates every member before
mutation, applies in one source transaction, and emits a v4 receipt. A
successful receipt contains the compensation's own bounded inverse. A stale or
missing member returns conflict without a partial effect.

With Runner-ledger receipt authority, an unacknowledged commit or rollback
enters `reconciliation_required`; no inverse is synthesized until a verified
operator resolves the outcome.

Canonical JSON Schemas are under:

```text
schemas/inverse-descriptor.v1.schema.json
schemas/compensation-change-set.v1.schema.json
schemas/writeback-job.v4.schema.json
schemas/execution-receipt.v4.schema.json
```

See [Reviewed Reversible Change Sets](reversible-change-sets.md) for the
operator flow and supported operation matrix.
