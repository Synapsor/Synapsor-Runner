# Protocol

The v0.1 protocol supports one operation: guarded single-row `UPDATE`.

Required job fields:

- `protocol_version`
- `job_id`
- `proposal_id`
- `approval_id`
- `source_id`
- `engine`
- `target.schema`
- `target.table`
- `target.primary_key`
- `target.tenant_guard`
- `allowed_columns`
- `patch`
- `conflict_guard`
- `idempotency_key`
- `lease_expires_at`

Results are reported as `applied`, `conflict`, or `failed` with safe error codes.

