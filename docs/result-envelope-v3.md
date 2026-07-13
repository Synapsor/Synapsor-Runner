# Result Envelope V3

Protocol v3 is used only for bounded set direct writeback. Protocol v1 and v2
remain accepted for legacy UPDATE and guarded single-row CRUD.

The public artifacts are:

- `synapsor.change-set.v3`;
- `synapsor.writeback-job.v3`;
- `synapsor.execution-receipt.v3`.

Each v3 object names one operation: `set_update`, `set_delete`, or
`batch_insert`. It carries the same frozen-set authority:

```json
{
  "max_rows": 10,
  "row_count": 2,
  "aggregate_bounds": [
    { "column": "balance_cents", "measure": "before", "maximum": 20000, "actual": 15000 }
  ],
  "members": [
    {
      "primary_key": { "column": "id", "value": "INV-1" },
      "expected_version": { "column": "version", "value": 1 },
      "before_digest": "sha256:...",
      "after_digest": "sha256:..."
    }
  ],
  "set_digest": "sha256:..."
}
```

The complete protocol fixtures live in [`fixtures/protocol`](../fixtures/protocol)
and the JSON Schemas live in [`schemas`](../schemas). The execution receipt
reports every `target_identity` and matching `member_effect`, plus receipt
authority, set digest, exact affected count, safe status/error, and receipt
hash. An applied result is invalid unless its affected count and member-effect
count match the frozen identity count.

`runner_ledger` may return `reconciliation_required` with an intent ID when a
cross-database crash window prevents proof of commit. That is a terminal
operator state, not a retry instruction or an `already_applied` guess.
