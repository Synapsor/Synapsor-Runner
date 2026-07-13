# RFC 004: Guarded CRUD Receipt Authority

Status: implementation gate

## Purpose

Runner 1.2 adds guarded single-row INSERT and DELETE while making source receipt
DDL optional. It must preserve the defining boundary: a reviewed, tenant-bound,
one-row business effect with evidence, external approval, a receipt, and replay.

This RFC is required before adapter expansion because receipt placement changes
which outcomes can be proven after a crash.

## Configuration Model

Two decisions are orthogonal:

```text
receipt_authority: source_db | runner_ledger
source_receipt_provisioning: precreated | auto_migrate
```

`source_receipt_provisioning` is valid only for `source_db`.

For compatibility, omitted fields mean `source_db` plus `precreated`. A new
wizard may recommend `auto_migrate`, but it must obtain explicit consent before
granting Runner DDL authority. `runner_ledger` is opt-in and must explain its
post-commit ambiguity.

Receipt schema/table identifiers are operator config, validated as fixed safe
identifiers. They are never contract fields or model arguments.

## Terms

- **Exactly-once classification:** Runner can prove whether this proposal was
  applied, conflicted, or failed.
- **At-most-once business effect:** the source cannot perform the reviewed
  effect twice for the same deterministic identity.
- **Idempotent effect:** repeating an operation converges on the same source
  state, but may not prove who caused it.
- **Ambiguous outcome:** the source may have committed, but Runner lacks an
  atomic receipt proving that fact. This requires reconciliation.

These terms are not interchangeable.

## Claim Matrix

The claims below apply equally to Postgres and MySQL. Engine-specific tests must
prove them separately.

| Operation | Authority | Source prerequisite | Normal result | Retry after completed receipt | Crash after source commit, before Runner completion |
| --- | --- | --- | --- | --- | --- |
| UPDATE | `source_db` | exact PK+tenant+version guard; source receipt table | atomic one-row UPDATE and receipt | `already_applied` | atomic transaction proves applied or rolled back |
| INSERT | `source_db` | trusted tenant; reviewed insert columns; proposal-specific PK/UNIQUE dedup key; source receipt table | atomic one-row INSERT and receipt | `already_applied` | atomic transaction proves applied or rolled back |
| DELETE | `source_db` | exact PK+tenant+version guard; no expanding cascade/write trigger; source receipt table | atomic one-row DELETE and receipt | `already_applied` | atomic transaction proves applied or rolled back |
| UPDATE | `runner_ledger` | authoritative shared ledger for fleets; exact PK+tenant+version guard; monotonic version advancement in source transaction | intent, one-row UPDATE, terminal ledger receipt | completed matching receipt returns `already_applied` | advanced guard plus incomplete intent is `reconciliation_required` |
| INSERT | `runner_ledger` | authoritative shared ledger for fleets; proposal-specific source PK/UNIQUE key | intent, one-row INSERT, terminal ledger receipt | completed matching receipt returns `already_applied` | matching unique row plus incomplete intent is reconciled only when provenance is provable; otherwise `reconciliation_required` |
| DELETE | `runner_ledger` | authoritative shared ledger for fleets; exact PK+tenant+version guard; no expanding side effects | intent, one-row DELETE, terminal ledger receipt | completed matching receipt returns `already_applied` | missing row plus incomplete intent is `reconciliation_required`, not proof of this delete |

## Failure and Crash Matrix

| Point/outcome | `source_db` | `runner_ledger` |
| --- | --- | --- |
| ledger/source unavailable before intent | no source effect; retryable unavailable | no source effect; retryable unavailable |
| crash before source BEGIN | no source effect | durable intent remains; safe retry only if no ambiguous attempt was entered |
| crash after BEGIN, before mutation | transaction rolls back | source transaction rolls back; intent can be marked failed/retried by bounded operator/worker logic |
| stale/version conflict | conflict receipt commits atomically | conflict terminal event is recorded; no source mutation |
| crash after mutation, before source COMMIT | transaction rolls back | source transaction rolls back; no business effect |
| crash after source COMMIT, before Runner completion | impossible as a split outcome because source receipt shares the transaction | terminal state is `reconciliation_required`; never auto-retry |
| concurrent identical apply | source receipt serializes one outcome | ledger intent plus source guard/unique key permits at most one effect; ambiguous loser reconciles |
| source unavailable after intent | no source effect | intent remains failed/retryable only while no source transaction could have committed |

## Operation Proof Obligations

### UPDATE

Runner-ledger UPDATE requires a real version guard and monotonic advancement in
the same source transaction. Accepted strategies are a Runner-generated integer
increment or a database-generated version whose changed value is verified
before commit. A name such as `updated_at` is not proof. Insufficient timestamp
precision fails preflight.

An advanced source version plus an incomplete intent is ambiguous, not
`already_applied`.

### INSERT

INSERT requires a proposal-specific deterministic identity backed by an
inspected PRIMARY KEY or UNIQUE constraint. The model cannot set tenant,
identity/generated columns, or arbitrary columns. The contract declares the
portable dedup mapping; Runner config declares receipt placement.

Ledger memory by itself does not prevent a duplicate INSERT after a process
crash. A source uniqueness constraint is mandatory.

### DELETE

DELETE targets one reviewed row by primary key, trusted tenant, and expected
version. The proposal freezes allowlisted before evidence. A hard delete is
refused when cascading foreign keys or write triggers can expand the reviewed
effect. Soft delete remains the preferred path.

A missing row after an incomplete Runner-ledger attempt proves only that the
row is absent, not that this attempt deleted it.

## Durable Runner-Ledger Intent

Before touching the source, Runner durably stores:

- proposal ID, version, and hash;
- capability and operation;
- trusted tenant and target/dedup identity;
- expected guard;
- bounded attempt number;
- state and timestamps.

Allowed states are:

```text
intent_recorded
applying
applied
already_applied
conflict
failed
reconciliation_required
```

Transitions append immutable events. An incomplete `applying` attempt is never
automatically restarted if the source may have committed.

## Reconciliation

The operator command re-reads only the reviewed target under trusted tenant
scope and displays expected versus observed allowlisted metadata. It never
guesses. A verified operator can mark `applied`, `conflict`, or `failed` with a
reason; Runner appends a reconciliation event and receipt. Production signed
identity requirements apply unchanged.

## Topology Rules

- local SQLite Runner-ledger authority is allowed only for one local operator
  process;
- Streamable HTTP fleets and multiple workers require shared Postgres
  `runtime_store` as the authoritative ledger;
- `mirror` is not authoritative enough for Runner-ledger write intents;
- unsafe topology fails at config/doctor/start preflight.

## Security Invariants

- raw SQL, receipt controls, identifiers, approval, apply, credentials, tenant,
  and principal remain outside model-facing tools;
- all identifiers are contract/config validated and all values are parameters;
- unknown, stale, ambiguous, or multi-row effects fail closed;
- kept-out fields are not persisted in intents, receipts, metrics, or replay;
- local resource reads continue to reauthorize tenant and principal;
- no claim of distributed atomic exactly-once is made for `runner_ledger`.

## Bounded Set Gate

This RFC does not authorize multi-row writes. Set operations require a separate
RFC with fixed typed predicates, frozen exact targets, mandatory count/value
bounds, deterministic row locking, one transaction, exact receipts, and all
R1-R7 threat mitigations. `MAX ROWS` syntax alone is not shippable.

