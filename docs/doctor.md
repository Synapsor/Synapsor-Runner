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
- MCP tool boundary, including absence of raw SQL and commit tools;
- local store stats.

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

For direct guarded INSERT/UPDATE/DELETE, add `--check-writeback` after reviewing
the selected receipt mode and operation-specific grants:

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
