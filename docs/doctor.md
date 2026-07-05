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

For direct `sql_update` writeback, add `--check-writeback` only after reviewing
the receipt-table DDL/grants:

```bash
synapsor-runner doctor --config synapsor.runner.json --check-writeback
```

This connects with the trusted writer env var named by `write_url_env` and
checks:

- writer database connectivity;
- `synapsor_writeback_receipts` permission through the adapter doctor;
- rollback-only access to each configured proposal target table;
- rollback-only update permission for configured allowed write columns.

The target-table probe uses fixed schema/table/column identifiers from the
reviewed config. It does not accept model SQL, user SQL, arbitrary table names,
or arbitrary column names. It runs inside a transaction and rolls back.

The receipt-table probe can create `synapsor_writeback_receipts` if the writer
has permission. If your policy does not allow Runner to create tables in the
application schema, pre-create the table and grant access:

```bash
synapsor-runner writeback migration --engine postgres --schema synapsor
synapsor-runner writeback grants --engine postgres --schema synapsor --writer-role app_writer
```

For MySQL:

```bash
synapsor-runner writeback migration --engine mysql --schema appdb
synapsor-runner writeback grants --engine mysql --schema appdb --writer-role "'app_writer'@'%'"
```

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
