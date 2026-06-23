# Connect Your Own Database

Use this path after the Docker demo passes and you want to try Synapsor Runner
against a staging or disposable Postgres/MySQL database.

Do not start with your most sensitive production database. The current alpha
runner is a local commit-safety runtime for reviewed single-row business
actions, not a production certification.

## Fast path

Set one read-only database URL and run the wrapper from this repo:

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
./scripts/use-your-db.sh
```

That command does the useful local mini-Synapsor path:

```text
inspect your schema
-> choose one table/view
-> choose trusted scope and visible fields
-> optionally choose proposal/writeback rules
-> generate synapsor.runner.json
-> preview MCP tools exposed to the model
-> print mcp serve and local UI commands
```

It does not print your database URL, put the URL in MCP client config, expose
`execute_sql`, expose approval/commit tools, or give the model write
credentials.

The rest of this page shows the same flow step by step using the public
`synapsor ...` CLI. From a source checkout, use `./bin/synapsor ...` if the
global binary is not linked yet.

## 1. Put the read URL in an environment variable

Do not pass connection strings on the command line.

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
```

Use a read-only credential for inspection and model-facing read/proposal tools.

### TLS notes for AWS RDS and other managed databases

If you see an error like:

```text
self-signed certificate in certificate chain
```

that is not a Postgres permission issue. It means the client reached the
database, but your local Node/Postgres TLS stack could not verify the server's
certificate chain.

For disposable dev RDS fixtures, you can allow an insecure retry:

```bash
./scripts/use-your-db.sh --allow-insecure-ssl
```

or put `sslmode=no-verify` in the disposable test URL.

For real staging or production-like testing, do not disable verification.
Install/use the AWS RDS CA bundle and keep certificate verification enabled.
For example, download the AWS RDS global bundle and configure your Postgres URL
or client environment so the Node Postgres client trusts that CA. The exact
mechanism depends on your deployment environment and should be treated like any
other trusted database TLS setup.

## 2. Inspect metadata

```bash
npx -y -p @synapsor/runner@alpha synapsor inspect \
  --engine auto \
  --from-env DATABASE_URL \
  --schema public
```

For a disposable staging URL, this also works:

```bash
npx -y -p @synapsor/runner@alpha synapsor inspect "$DATABASE_URL" --engine auto --schema public
```

For automation:

```bash
npx -y -p @synapsor/runner@alpha synapsor inspect \
  --engine postgres \
  --from-env DATABASE_URL \
  --schema public \
  --json > schema-inspection.json
```

Inspection reads metadata only by default. It does not sample business rows.

## 3. Start from a recipe when one matches

Recipes give you a reviewed starter contract for a common business action. They
do not silently infer write authority from your schema; you still map the recipe
to your staging table, primary key, tenant key, conflict column, visible fields,
allowed write fields, and business limits.

```bash
npx -y -p @synapsor/runner@alpha synapsor recipes list
npx -y -p @synapsor/runner@alpha synapsor recipes show billing.late_fee_waiver
npx -y -p @synapsor/runner@alpha synapsor recipes init billing.late_fee_waiver --output synapsor.runner.json
```

Use a recipe when the shape is close. Use the guided wizard or explicit flags
when your action is custom.

Built-in recipes are JSON files under `recipes/`. You can copy one and pass the
edited file path to `recipes show` or `recipes init`; the runtime still serves
only the capabilities in your generated `synapsor.runner.json`.

## 4. Generate from reviewed selections

In an interactive terminal, run the guided wizard:

```bash
npx -y -p @synapsor/runner@alpha synapsor init --from-env DATABASE_URL --mode read_only --wizard
```

The generated capabilities are based on your selections. Synapsor Runner does
not force billing, support, order, or any other built-in domain. You choose the
namespace, object name, lookup argument, visible fields, proposal fields, guards,
and approval role.

Start with `read_only` to prove safe database reads first. Use `--mode review`
when you are ready to create proposal tools and guarded writeback setup.

The wizard:

- asks for the engine and read URL environment-variable name;
- tests read connectivity through schema inspection;
- lists discovered schemas and tables/views;
- asks you to confirm primary key, tenant/scope column, conflict/version
  column, visible columns, mode, semantic names, trusted context env vars, and
  proposal patch mappings;
- previews the MCP tools and what is not exposed;
- writes the generated config, `.env.example`, and MCP client snippets only
  after final confirmation.

For proposal modes, the current runner supports explicit field-update mappings such as:

```text
late_fee_cents=fixed:0,waiver_reason=arg:reason
```

Use `--starter` only when you intentionally want the old starter skeleton
instead of the reviewed wizard.

If you already know the reviewed table/action, generate config directly from
metadata and explicit flags:

```bash
npx -y -p @synapsor/runner@alpha synapsor init \
  --from-env DATABASE_URL \
  --engine postgres \
  --schema public \
  --table invoices \
  --namespace billing \
  --object-name invoice \
  --mode review \
  --visible-columns id,tenant_id,late_fee_cents,waiver_reason,updated_at \
  --allowed-columns late_fee_cents,waiver_reason \
  --patch-fixed late_fee_cents=0 \
  --patch-from-arg waiver_reason=reason \
  --numeric-bound late_fee_cents=0:5500 \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL
```

Or generate from a saved inspection snapshot without reconnecting:

```bash
npx -y -p @synapsor/runner@alpha synapsor init \
  --inspection-json schema-inspection.json \
  --table invoices \
  --namespace billing \
  --object-name invoice \
  --mode review \
  --patch-fixed late_fee_cents=0 \
  --patch-from-arg waiver_reason=reason
```

The command uses inspected metadata for primary-key, tenant-key, conflict-column,
and default-visible-column suggestions. If a suggestion is ambiguous or missing,
pass explicit flags such as `--primary-key`, `--tenant-key`, and
`--conflict-column`.

Review mode requires at least one explicit `--patch-fixed` or
`--patch-from-arg` mapping. Use `--mode read_only` if you only want an inspect
tool.

For bounded business actions, add reviewed value guards:

```bash
--numeric-bound credit_cents=0:10000
--transition-guard status=open:pending_review
```

`--numeric-bound` keeps a proposed numeric column inside a fixed range before a
proposal is created. `--transition-guard` keeps a status-like column on an
approved state path such as `open -> pending_review`. For multiple states, use
semicolon-separated paths, for example
`status=open:pending_review;pending_review:resolved`.

## 5. Or create a reviewed selection spec

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
  },
  "numeric_bounds": {
    "late_fee_cents": { "minimum": 0, "maximum": 5500 }
  }
}
```

The selection file contains reviewed metadata selections only. It must not
contain database URLs or passwords.

## 6. Generate runner files

```bash
npx -y -p @synapsor/runner@alpha synapsor init \
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

Generate or refresh MCP client snippets later with:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp config generic --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor mcp config claude-desktop --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor mcp config cursor --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The snippets contain the local command and args. They must not contain database
URLs, passwords, approval tools, commit tools, or write credentials.

## 7. Validate the config

```bash
npx -y -p @synapsor/runner@alpha synapsor config validate --config synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor config show --config synapsor.runner.json --redacted
```

The config stores environment-variable names, not connection-string values.

Run doctor after setting the referenced environment variables:

```bash
npx -y -p @synapsor/runner@alpha synapsor doctor --config synapsor.runner.json
```

Doctor validates config shape, trusted context env vars, source env vars,
read/write credential separation, table/column metadata when the read URL is
available, and the semantic MCP tool boundary. Use JSON for automation:

```bash
npx -y -p @synapsor/runner@alpha synapsor doctor --config synapsor.runner.json --json
```

## 8. Serve semantic MCP tools

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"
npx -y -p @synapsor/runner@alpha synapsor mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The model-facing MCP server exposes semantic tools such as:

```text
billing.inspect_invoice
billing.propose_invoice_update
```

Those names come from the example namespace/object. A custom setup might expose
`clinic.inspect_appointment` and `clinic.propose_appointment_update`, or any
other reviewed names you generated. It does not expose `execute_sql`, approval
tools, commit tools, database URLs, write credentials, or tenant authority.

## 9. Review and apply outside MCP

Proposal tools leave the source database unchanged. Review locally:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals list --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor proposals show wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
npx -y -p @synapsor/runner@alpha synapsor proposals writeback-job wrp_123 --store ./.synapsor/local.db --output job.json
```

Apply through the trusted worker path with a separate writer credential:

```bash
export SYNAPSOR_DATABASE_WRITE_URL="<postgres-or-mysql-write-url>"
SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="$SYNAPSOR_DATABASE_WRITE_URL" \
npx -y -p @synapsor/runner@alpha synapsor apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

If your application/API should own the business write, use an `http_handler`
executor instead of direct SQL writeback. Handler URLs and bearer tokens come
from environment variables, and the handler receives a structured proposal/job
payload, not arbitrary model SQL:

```bash
npx -y -p @synapsor/runner@alpha synapsor apply --proposal wrp_123 --config synapsor.runner.json --store ./.synapsor/local.db
```

See `docs/writeback-executors.md`.

Replay afterward:

```bash
npx -y -p @synapsor/runner@alpha synapsor replay show wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

## Boundary

MCP tool call equals request/proposal authority. Trusted runner equals
execution authority.

If tenant scope, primary key, allowed columns, expected version, approval state,
or local config cannot be verified, do not apply the write.
