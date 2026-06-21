# Connect Your Own Database

Use this path after the Docker demo passes and you want to try Synapsor Runner
against a staging or disposable Postgres/MySQL database.

Do not start with your most sensitive production database. The v0.1 runner is a
local commit-safety runtime for reviewed single-row business actions, not a
production certification.

## 1. Put the read URL in an environment variable

Do not pass connection strings on the command line.

```bash
export SYNAPSOR_DATABASE_READ_URL="<postgres-or-mysql-read-url>"
```

Use a read-only credential for inspection and model-facing read/proposal tools.

## 2. Inspect metadata

```bash
synapsor inspect \
  --engine auto \
  --database-url-env SYNAPSOR_DATABASE_READ_URL \
  --schema public
```

For automation:

```bash
synapsor inspect \
  --engine postgres \
  --database-url-env SYNAPSOR_DATABASE_READ_URL \
  --schema public \
  --json > schema-inspection.json
```

Inspection reads metadata only by default. It does not sample business rows.

## 3. Create a reviewed selection spec

Create `onboarding-selection.json` from one table and one safe business action.

```json
{
  "version": 1,
  "engine": "postgres",
  "mode": "review",
  "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
  "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL",
  "schema": "public",
  "table": "invoices",
  "primary_key": "id",
  "tenant_key": "tenant_id",
  "conflict_column": "updated_at",
  "namespace": "billing",
  "object_name": "invoice",
  "visible_columns": ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
  "allowed_columns": ["late_fee_cents", "waiver_reason"],
  "patch": {
    "late_fee_cents": { "fixed": 0 },
    "waiver_reason": { "from_arg": "reason" }
  }
}
```

The selection file contains reviewed metadata selections only. It must not
contain database URLs or passwords.

## 4. Generate runner files

```bash
synapsor init \
  --spec onboarding-selection.json \
  --non-interactive
```

This creates:

- `synapsor.runner.json`
- `.env.example`
- `.synapsor/mcp/generic-stdio.json`
- `.synapsor/mcp/claude-desktop.json`
- `.synapsor/mcp/cursor.json`
- `.synapsor/mcp/vscode.json`

Use `--force` only if you intentionally want to overwrite existing generated
files.

## 5. Validate the config

```bash
synapsor config validate --config synapsor.runner.json
synapsor config show --config synapsor.runner.json --redacted
```

The config stores environment-variable names, not connection-string values.

Run doctor after setting the referenced environment variables:

```bash
synapsor doctor --config synapsor.runner.json
```

Doctor validates config shape, trusted context env vars, source env vars,
read/write credential separation, table/column metadata when the read URL is
available, and the semantic MCP tool boundary. Use JSON for automation:

```bash
synapsor doctor --config synapsor.runner.json --json
```

## 6. Serve semantic MCP tools

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"
synapsor mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The model-facing MCP server exposes semantic tools such as:

```text
billing.inspect_invoice
billing.propose_invoice_update
```

It does not expose `execute_sql`, approval tools, commit tools, database URLs,
write credentials, or tenant authority.

## 7. Review and apply outside MCP

Proposal tools leave the source database unchanged. Review locally:

```bash
synapsor proposals list --store ./.synapsor/local.db
synapsor proposals show wrp_123 --store ./.synapsor/local.db
synapsor proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
synapsor proposals writeback-job wrp_123 --store ./.synapsor/local.db --output job.json
```

Apply through the trusted worker path with a separate writer credential:

```bash
export SYNAPSOR_DATABASE_WRITE_URL="<postgres-or-mysql-write-url>"
SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="$SYNAPSOR_DATABASE_WRITE_URL" \
synapsor apply --job job.json --store ./.synapsor/local.db
```

Replay afterward:

```bash
synapsor replay show wrp_123 --store ./.synapsor/local.db
synapsor replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

## Boundary

MCP tool call equals request/proposal authority. Trusted runner equals
execution authority.

If tenant scope, primary key, allowed columns, expected version, approval state,
or local config cannot be verified, do not apply the write.
