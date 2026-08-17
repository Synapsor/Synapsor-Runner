# Doctor

Use `doctor` to check a local Runner setup without printing database URLs,
passwords, bearer tokens, signing secrets, or private keys.

```bash
synapsor-runner doctor --config synapsor.runner.json
synapsor-runner doctor --config synapsor.runner.json --json
synapsor-runner doctor --config synapsor.runner.json --report --redact --output synapsor-doctor.md
```

The default check validates:

- config shape;
- trusted context environment variables;
- read credential environment variables;
- read/write credential separation;
- reachable source metadata when the read env var is set;
- configured target tables and columns;
- required index presence and low-selectivity advisories for active reviewed derived-scope paths;
- MCP tool boundary, including absence of raw SQL and commit tools;
- local store stats.

For a source configured with `database_scope.mode = "postgres_rls"`, doctor
also verifies RLS/FORCE status, effective-role bypass risk, applicable
operation policies, `USING`/`WITH CHECK`, and both configured trusted-setting
names. Hardened mode fails rather than silently falling back to
application-only predicates.

On a disposable or explicitly approved live target, add:

```bash
synapsor-runner doctor --config synapsor.runner.json --check-rls
```

This performs a read-only cross-tenant and cross-principal canary and checks
that transaction-local values do not survive the pooled transaction. See
[Database-Enforced Tenant And Principal
Scope](database-enforced-scope.md).

## Derived Scope Index Advisory

When an active boundary scopes a normalized child table through a proven
relationship path, `doctor` checks the live index catalog for every link the
mandatory scope predicate traverses. It looks for:

- a child index whose leading column or columns are the reviewed foreign key;
- an index on the ancestor key referenced by that relationship;
- an index on the terminal tenant or principal filter column.

A missing child foreign-key index is a warning because the mandatory scoping
`EXISTS` may scan. Missing referenced-key or terminal scope-filter coverage is
shown as a lower-impact note. These findings are advisory: they never activate,
disable, widen, or gate Explore, and they never change the scope predicate.

Each missing-index finding includes engine-correct `CREATE INDEX` SQL for an
operator to review and run separately. Runner only reads catalog metadata;
`doctor` never creates the suggested index or reads source rows for this check.
A clean report says that the indexes required by the reviewed paths exist. This
is an availability statement, not a promise that the database planner will use
those indexes.

When catalog statistics are available, `doctor` also compares the terminal
tenant or principal index's approximate distinct-value count with the ancestor
table's approximate row count. An ancestor estimated at 100,000 or more rows
with 50 or fewer distinct scope values gets a low-selectivity warning:
PostgreSQL or MySQL may reasonably choose scans even though every required
index exists. The estimate comes from `pg_stats.n_distinct` on PostgreSQL and
`information_schema.statistics.cardinality` on MySQL. Both are approximate and
may be stale, so the warning is advisory rather than a latency prediction.
Measure the real plan before changing a reviewed timeout or source schema. For
high-volume deep paths, a direct scope column on the leaf, or a shorter reviewed
path where the schema permits one, is usually more predictable than relying on
an index over a low-cardinality terminal predicate.

## App-Owned Handler Checks

For `http_handler` executors, add `--check-handlers`:

```bash
synapsor-runner doctor --config synapsor.runner.json --check-handlers
```

This checks handler URL/token/signing-secret env vars and sends a reachability
probe to the handler endpoint. It does not apply a proposal and does not send a
writeback job.

Use `signing_secret_env` for non-loopback handler deployments so Runner signs
requests with:

```text
X-Synapsor-Signature
X-Synapsor-Issued-At
X-Synapsor-Proposal-Id
Idempotency-Key
```

## Direct SQL Writeback Checks

For direct guarded single-row CRUD or bounded-set writeback, add
`--check-writeback` after reviewing the selected receipt mode and
operation-specific grants:

```bash
synapsor-runner doctor --config synapsor.runner.json --check-writeback
```

This connects with the trusted writer env var named by `write_url_env` and
checks:

- writer database connectivity;
- source receipt migration/permissions when authority is `source_db`;
- no source receipt DDL/DML when authority is `runner_ledger`;
- rollback-only access to each configured proposal target table;
- operation-specific version, unique/dedup, generated-column, trigger,
  cascade, RLS, and DML prerequisites.

For bounded sets, the normal doctor report also identifies operation kind,
fixed selection or exact batch source, row cap, aggregate bounds, and the
mandatory human/operator approval boundary. It fails validation before any
proposal exists when those portable guards are incomplete.

The target-table probe uses fixed schema/table/column identifiers from the
reviewed config. It does not accept model SQL, user SQL, arbitrary table names,
or arbitrary column names. It runs inside a transaction and rolls back.

For `source_db` + `precreated`, an administrator creates the receipt table and
grants steady-state access. Doctor never executes DDL in this mode:

```bash
synapsor-runner writeback migration --engine postgres --schema synapsor
synapsor-runner writeback grants --engine postgres --schema synapsor --writer-role app_writer
```

For MySQL:

```bash
synapsor-runner writeback migration --engine mysql --schema appdb
synapsor-runner writeback grants --engine mysql --schema appdb --writer-role "'app_writer'@'%'"
```

Use `source_db` + `auto_migrate` only when the writer may create the fixed
receipt table. Use `runner_ledger` for no source receipt table; doctor then
checks the local/small-fleet topology and crash-reconciliation prerequisites.
See [Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md).
For set-specific prerequisites, see [Bounded Set
Writeback](bounded-set-writeback.md).

Use an app-owned `http_handler` or `command_handler` executor when your
application should own richer business writes or receipt storage.

## Redaction

Doctor output intentionally uses safe categories such as:

```text
connection failed
authentication failed
permission denied
configured object not found
database probe failed
```

Raw driver errors, connection strings, passwords, tokens, signing secrets, and
handler URLs are not printed in the report.
