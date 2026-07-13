# Guarded Single-Row CRUD Writeback

Synapsor Runner can apply reviewed, approved, single-row `INSERT`, `UPDATE`,
and `DELETE` operations to Postgres and MySQL. The model only creates a
proposal. Approval and apply remain outside MCP.

This is not a general SQL surface. Every direct operation is generated from a
validated contract and must preserve these invariants:

- fixed schema, table, primary key, tenant key, and columns;
- tenant supplied by trusted context, never by the model;
- parameterized values and no model-generated SQL or predicates;
- one reviewed row and exactly one source effect;
- source-enforced conflict or deduplication guard;
- approval before apply;
- durable intent, receipt, events, and replay;
- ambiguous outcomes fail closed for operator reconciliation.

Use [bounded set writeback](bounded-set-writeback.md) only when a fixed
predicate or complete reviewed item list can satisfy its stronger caps,
freezing, atomicity, and receipt rules. Use an [app-owned
executor](writeback-executors.md) for free-form/unbounded multi-row or
multi-table transactions, UPSERT, DDL, external effects, or business logic that
does not fit either direct boundary.

## Operation guarantees

| Operation | Required source guard | Direct-write behavior |
| --- | --- | --- |
| `UPDATE` | Primary key, trusted tenant, exact version/conflict column | Patches only allowlisted columns and affects exactly one row. In Runner-ledger mode, the version must advance in the same source transaction. |
| `INSERT` | Source `PRIMARY KEY` or `UNIQUE` constraint over the reviewed dedup identity | Runner injects tenant and proposal-derived identity values, inserts only allowlisted fields, and requires exactly one row. |
| `DELETE` | Primary key, trusted tenant, exact version column | Deletes exactly one reviewed row. Hard delete requires human/operator approval and is refused when Runner detects write triggers or widening cascades. Prefer soft delete as guarded `UPDATE`. |

Existing proposal capabilities with no `operation` field continue to mean
single-row `UPDATE`.

## Receipt authority

Receipt authority and source-table provisioning are separate decisions:

| Authority | Provisioning | Source schema change | Completion classification |
| --- | --- | --- | --- |
| `source_db` | `precreated` | Administrator creates the fixed receipt table; Runner never runs DDL. | Mutation and receipt commit in one source transaction. Strongest already-applied versus conflict classification. |
| `source_db` | `auto_migrate` | Runner runs an idempotent, reviewed receipt-table migration. Writer needs bounded `CREATE` permission. | Same atomic source transaction after migration. |
| `runner_ledger` | Not applicable | No Synapsor receipt table or receipt DML in the source database. | Durable Runner intent precedes the source transaction. A crash after source commit but before ledger completion may require reconciliation. |

`runner_ledger` does not claim distributed exactly-once semantics across two
databases. Source-enforced versions and unique keys prevent a known duplicate
effect. If Runner cannot prove whether an interrupted attempt committed, it
records `reconciliation_required`, stops automatic retry, and preserves the
intent for an operator.

Local SQLite is valid for one local operator process. A networked or
multi-Runner deployment using `runner_ledger` requires
`storage.shared_postgres.mode = "runtime_store"` so the intent ledger is
authoritative before any source mutation. Mirror mode is rejected.

## Runtime configuration

Atomic source receipts with an administrator-created table:

```json
{
  "sources": {
    "billing_postgres": {
      "engine": "postgres",
      "read_url_env": "BILLING_POSTGRES_READ_URL",
      "write_url_env": "BILLING_POSTGRES_WRITE_URL",
      "receipts": {
        "authority": "source_db",
        "provisioning": "precreated",
        "schema": "synapsor",
        "table": "writeback_receipts"
      }
    }
  }
}
```

Set `provisioning` to `auto_migrate` to let Runner create that fixed table.
Use Runner-ledger authority with no source receipt fields:

```json
{
  "sources": {
    "billing_postgres": {
      "engine": "postgres",
      "read_url_env": "BILLING_POSTGRES_READ_URL",
      "write_url_env": "BILLING_POSTGRES_WRITE_URL",
      "receipts": { "authority": "runner_ledger" }
    }
  }
}
```

Receipt schema and table names are fixed, validated runtime identifiers. They
are not portable contract fields or model arguments.

## Contract and DSL examples

Runner-ledger `UPDATE` must advance its exact guard:

```sql
PROPOSE ACTION waive_late_fee UPDATE
ALLOW WRITE late_fee_cents, waiver_reason
PATCH late_fee_cents = 0
PATCH waiver_reason = ARG reason
ADVANCE VERSION version USING INTEGER INCREMENT
APPROVAL ROLE billing_reviewer
WRITEBACK DIRECT SQL
```

Guarded `INSERT` needs a source-unique, Runner-supplied dedup identity:

```sql
PROPOSE ACTION create_credit INSERT
DEDUP KEY tenant_id = TRUSTED TENANT, request_id = PROPOSAL ID
ALLOW WRITE customer_id, amount_cents, reason
PATCH customer_id = ARG customer_id
PATCH amount_cents = ARG amount_cents
PATCH reason = ARG reason
BOUND amount_cents 1..50000
APPROVAL ROLE support_reviewer
WRITEBACK DIRECT SQL
```

The source must enforce the declared dedup columns with a primary key or unique
constraint. Ledger memory by itself is not an INSERT deduplication guard.

Hard `DELETE` has no patch and cannot use policy auto-approval:

```sql
PROPOSE ACTION delete_session DELETE
APPROVAL ROLE security_reviewer
WRITEBACK DIRECT SQL
```

The capability still declares `PRIMARY KEY`, `TENANT KEY`, `CONFLICT GUARD`,
reviewed visible fields, evidence, and `MAX ROWS 1` in its enclosing block.

## Database privileges

Keep read and write credentials separate. The writer needs only the target
table operations declared by its capabilities plus the selected receipt mode.

| Mode | Postgres writer | MySQL writer |
| --- | --- | --- |
| `source_db` + `precreated` | Schema usage, reviewed target `SELECT` and operation-specific `INSERT`/`UPDATE`/`DELETE`, sequence use for identity INSERT, receipt-table `SELECT`/`INSERT`/`UPDATE`; no `CREATE`. | Reviewed target `SELECT` and operation-specific `INSERT`/`UPDATE`/`DELETE`, receipt-table `SELECT`/`INSERT`/`UPDATE`; no `CREATE`. |
| `source_db` + `auto_migrate` | Same, plus bounded schema `CREATE` for the fixed receipt table. | Same, plus database `CREATE` for the fixed receipt table. |
| `runner_ledger` | Reviewed target `SELECT` and operation-specific DML only; no source receipt or `CREATE` privilege. | Reviewed target `SELECT` and operation-specific DML only; no source receipt or `CREATE` privilege. |

Hard DELETE requires enough metadata visibility to prove that the effect cannot
widen. Postgres reads system catalogs. MySQL requires scoped `TRIGGER` metadata
visibility on the target table and global `PROCESS` visibility for incoming
InnoDB foreign-key metadata. If those privileges are unacceptable, use a soft
delete capability or an app-owned executor; Runner fails closed rather than
claiming an unverified one-row effect.

Generate or inspect source-receipt SQL without exposing credentials:

```bash
synapsor-runner writeback migration --engine postgres --schema synapsor --table writeback_receipts
synapsor-runner writeback grants --engine postgres --writer-role app_writer --schema synapsor --table writeback_receipts
synapsor-runner doctor --config ./synapsor.runner.json --check-writeback
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

`precreated` uses rollback-only permission probes and never executes `CREATE`.
`doctor` also checks operation-specific version, unique-key, generated-column,
trigger, cascade, and topology prerequisites.

## Reconciliation

An incomplete Runner-ledger intent is not proof of success or failure. Inspect
only the reviewed target projection under the trusted tenant, then record a
verified operator decision:

```bash
synapsor-runner writeback reconcile list \
  --status reconciliation_required \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db

synapsor-runner writeback reconcile inspect latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db

synapsor-runner writeback reconcile resolve wbi:... \
  --outcome applied \
  --reason "verified source state" \
  --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Resolution appends immutable events and a reconciliation receipt. It does not
rewrite history or retry the source mutation. Configured production operator
identity is required when enabled.

## Verification

The repository includes a disposable Postgres/MySQL test that proves every
receipt mode, native INSERT/UPDATE/DELETE, idempotent retry, stale and tenant
guards, two-store races, crash boundaries, no source receipt table in
Runner-ledger mode, and hard-delete trigger/cascade refusal:

```bash
corepack pnpm test:guarded-crud
```

Use synthetic staging data first. Run `doctor --check-writeback` and review
`tools preview` before connecting an MCP client or applying a proposal.
