# Protocol

The public protocol has four versioned identifiers:

```text
synapsor.change-set.v1
synapsor.writeback-job.v1
synapsor.execution-receipt.v1
synapsor.runner-registration.v1
```

The schemas live in `schemas/`. Golden fixtures live in `fixtures/protocol/` and are copied into the main Synapsor repository so Cloud/C++/SDK work can validate the same contract.

The v0.1 write path supports one operation:

```text
single_row_update
```

It does not support arbitrary SQL, DDL, INSERT, DELETE, UPSERT, stored procedures, dynamic table/column names from model input, or multi-row writes.

## Change set

`synapsor.change-set.v1` describes the proposal created after a semantic capability reads the current row and derives an exact diff. It includes:

- proposal id and version;
- action name;
- trusted principal provenance;
- tenant/business-object scope;
- source table and primary key;
- before/patch/after maps;
- allowed columns;
- expected version guard;
- evidence bundle/query fingerprint;
- approval state;
- writeback state;
- `source_database_mutated: false`;
- proposal hash.

## Writeback job

`synapsor.writeback-job.v1` is the only object a runner may use to mutate the external database. Required fields include:

- `writeback_job_id`;
- `proposal_id`;
- `proposal_version`;
- `proposal_hash`;
- `runner_scope.project_id`;
- `runner_scope.source_id`;
- `engine`;
- `operation: single_row_update`;
- `target.schema`;
- `target.table`;
- `target.primary_key`;
- `tenant_guard`;
- `allowed_columns`;
- `patch`;
- `conflict_guard`;
- `idempotency_key`;
- `lease`.

The protocol package normalizes this public shape into the existing internal `protocol_version: "1.0"` worker shape so current Postgres/MySQL adapters remain stable while the public contract evolves.

## Execution receipt

`synapsor.execution-receipt.v1` records the terminal result:

```text
applied
conflict
failed
canceled
already_applied
```

Receipts include the writeback job id, proposal id, runner id, rows affected, idempotency key, version fields when available, source mutation state, safe error code, execution timestamp, and receipt hash.

## Runner registration

`synapsor.runner-registration.v1` describes a runner's id, version, supported engines, capabilities, project/source scope, and registration timestamp.

## Compatibility

Existing Cloud endpoints may still return the legacy `protocol_version: "1.0"` job/result envelope during migration. The runner validates both formats. New public examples and MCP work should use the `synapsor.*.v1` schema ids.
