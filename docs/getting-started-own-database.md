# Connect Your Own Database

Use this path after the Docker demo passes and you want to try Synapsor Runner
against a staging or disposable Postgres/MySQL database.

Do not start with your most sensitive production database. Runner is a
commit-safety runtime for reviewed single-row business actions, not a
production certification.

If you only ran `synapsor-runner demo --quick`, you have tested the fixture-only
teaching path and local ledger commands. This page is the real own-database
path: it inspects your Postgres/MySQL metadata and generates reviewed semantic
tools from your selections.

## Fast path

Set one read-only database URL and run the public guided path:

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
npx -y -p @synapsor/runner synapsor-runner start --from-env DATABASE_URL
```

That command does the useful local mini-Synapsor path:

```text
inspect your schema
-> choose one table/view
-> choose trusted scope and visible fields
-> optionally choose proposal/writeback rules
-> generate synapsor.runner.json
-> preview MCP tools exposed to the model
-> run a local smoke check of the tool boundary
-> optionally write .synapsor/smoke-input.json for one real row
-> print mcp serve and local UI commands
```

It does not print your database URL, put the URL in MCP client config, expose
`execute_sql`, expose approval/commit tools, or give the model write
credentials.

`start --from-env` is the shortest public command for first-run onboarding.
`onboard db --from-env DATABASE_URL` is the same explicit path if you prefer the
older command name in scripts.

During the wizard, provide the optional sample object id if you know one safe
row in the selected table. Runner writes `./.synapsor/smoke-input.json` with
that id and prints the exact `smoke call` command. If you skip it, use
`--json '{"<lookup_arg>":"<real_id>"}'` when you are ready to test one real
row.

The rest of this page shows the same flow step by step using the public
`synapsor-runner ...` CLI. From a source checkout, use `./bin/synapsor-runner ...` if the
global binary is not linked yet.

From a source checkout, `./scripts/use-your-db.sh` runs the same kind of
guided flow plus local repository checks.

## 1. Put the read URL in an environment variable

Do not pass connection strings on the command line.

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
```

Use a read-only credential for inspection and model-facing read/proposal tools.

The generated compatibility setup uses application-level trusted-scope
predicates. Before production-like multi-tenant use, choose and document one of
the modes in [Database-Enforced Tenant And Principal
Scope](database-enforced-scope.md): shared application scope, PostgreSQL RLS
plus Runner checks, or tenant-bound credentials/deployments. MySQL has no
native RLS equivalent.

### TLS notes for AWS RDS and other managed databases

If you see an error like:

```text
self-signed certificate in certificate chain
```

that is not a Postgres permission issue. It means the client reached the
database, but your local Node/Postgres TLS stack could not verify the server's
certificate chain.

Do not disable certificate verification. Install the managed database CA bundle
and configure the Postgres/MySQL client environment to trust it. For AWS RDS,
use the current AWS RDS regional or global CA bundle. Treat database CA
configuration like any other production trust-store dependency and verify it
before using staging or production-like data.

## 2. Inspect metadata

```bash
npx -y -p @synapsor/runner synapsor-runner inspect \
  --engine auto \
  --from-env DATABASE_URL \
  --schema public
```

For a disposable staging URL, this also works:

```bash
npx -y -p @synapsor/runner synapsor-runner inspect "$DATABASE_URL" --engine auto --schema public
```

For automation:

```bash
npx -y -p @synapsor/runner synapsor-runner inspect \
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
npx -y -p @synapsor/runner synapsor-runner recipes list
npx -y -p @synapsor/runner synapsor-runner recipes show billing.late_fee_waiver
npx -y -p @synapsor/runner synapsor-runner recipes init billing.late_fee_waiver --output synapsor.runner.json
```

Use a recipe when the shape is close. Use the guided wizard or explicit flags
when your action is custom.

Built-in recipes are JSON files under `recipes/`. You can copy one and pass the
edited file path to `recipes show` or `recipes init`; the runtime still serves
only the capabilities in your generated `synapsor.runner.json`.

## 4. Generate from reviewed selections

In an interactive terminal, run the guided wizard:

```bash
npx -y -p @synapsor/runner synapsor-runner init --from-env DATABASE_URL --mode read_only --wizard
```

The generated context and capabilities are based on your selections. Synapsor
Runner does not force billing, support, order, or any other built-in domain.
The local shape is:

```text
trusted context -> capability -> MCP tool
```

You choose the source object, trusted tenant/principal bindings, namespace,
object name, lookup argument, visible fields, proposal fields, guards, and
approval role. You can also provide an optional real object id so Runner writes
`./.synapsor/smoke-input.json` for the first local tool call. If the read URL
env var and trusted tenant/principal env vars are already set, the wizard also
attempts that smoke call immediately and stores the evidence/query audit in the
local ledger. If not, it prints the exact smoke command to run after you set
the env vars from `.env.example`.

Start with `read_only` to prove safe database reads first. Use `--mode review`
when you are ready to create proposal tools and guarded writeback setup.

The wizard:

- asks for the engine and read URL environment-variable name;
- tests read connectivity through schema inspection;
- lists discovered schemas and tables/views;
- asks which source object backs the local context;
- asks which tenant/scope column and backend session env vars are trusted;
- asks you to confirm primary key, conflict/version column, visible columns,
  mode, semantic capability names, and proposal patch mappings;
- asks review-mode users to choose direct guarded SQL writeback, an app-owned
  HTTP handler, or an app-owned command handler;
- for direct SQL, asks for UPDATE/INSERT/DELETE and source receipt
  auto-migrate, precreated receipt, or zero-source-schema Runner-ledger mode;
- previews the MCP tools and what is not exposed, then lets you revise visible
  fields or capability names before writing files;
- attempts a first smoke call when you supplied a real object id and the
  required trusted env vars are present;
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
npx -y -p @synapsor/runner synapsor-runner init \
  --from-env DATABASE_URL \
  --engine postgres \
  --schema public \
  --table invoices \
  --namespace billing \
  --object-name invoice \
  --mode review \
  --visible-columns id,tenant_id,late_fee_cents,waiver_reason,updated_at \
  --allowed-columns late_fee_cents,waiver_reason \
  --tenant-column tenant_id \
  --id-arg invoice_id \
  --patch late_fee_cents=fixed:0,waiver_reason=arg:reason \
  --patch-bounds late_fee_cents=0:5500 \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL
```

If you omit `--namespace`, Runner derives the namespace from the table name
instead of defaulting to `source.*`. Add `--read-tool` and `--proposal-tool`
when you want exact capability names in the generated contract.

For app-owned writeback, replace the direct writer env with a handler executor:

```bash
npx -y -p @synapsor/runner synapsor-runner init \
  --from-env DATABASE_URL \
  --engine postgres \
  --schema public \
  --table invoices \
  --namespace billing \
  --object-name invoice \
  --mode review \
  --tenant-column tenant_id \
  --id-arg invoice_id \
  --patch late_fee_cents=fixed:0,waiver_reason=arg:reason \
  --writeback http_handler \
  --handler-url-env APP_WRITEBACK_URL \
  --handler-token-env APP_WRITEBACK_TOKEN \
  --emit-handler
```

Handler-owned configs mark the Runner source as read-only unless you explicitly
pass `--write-url-env`, so `config validate` does not warn that direct SQL
writeback is disabled.

Use `--writeback command_handler --handler-command-env APP_WRITEBACK_COMMAND`
when your app-owned writer is a local command/script instead of HTTP.

For native single-row CRUD, use operation-aware onboarding. INSERT requires a
source primary/unique dedup key; DELETE requires an exact conflict guard and
safe cascade/trigger inspection:

```bash
npx -y -p @synapsor/runner synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --table account_credits \
  --mode review \
  --operation insert \
  --dedup-columns request_id \
  --receipt-mode runner_ledger \
  --patch amount_cents=arg:amount_cents \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL \
  --yes
```

Review [Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md) before
choosing receipt authority. Runner-ledger mode creates no source receipt table,
but ambiguous post-commit crashes stop for operator reconciliation.

Or generate from a saved inspection snapshot without reconnecting:

```bash
npx -y -p @synapsor/runner synapsor-runner init \
  --inspection-json schema-inspection.json \
  --table invoices \
  --namespace billing \
  --object-name invoice \
  --mode review \
  --patch late_fee_cents=fixed:0,waiver_reason=arg:reason
```

The command uses inspected metadata for primary-key, tenant-key, conflict-column,
and default-visible-column suggestions. If a suggestion is ambiguous or missing,
pass explicit flags such as `--primary-key`, `--tenant-key`, and
`--conflict-column`.

Review mode requires at least one explicit `--patch` mapping, or the older
`--patch-fixed` / `--patch-from-arg` flags. Use `--mode read_only` if you only
want an inspect tool.

For bounded business actions, add reviewed value guards:

```bash
--patch-bounds credit_cents=0:10000
--status-guards status=open:pending_review
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
  "result_format": 2,
  "read_url_env": "SYNAPSOR_DATABASE_READ_URL",
  "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL",
  "schema": "public",
  "table": "invoices",
  "primary_key": "id",
  "tenant_key": "tenant_id",
  "conflict_column": "updated_at",
  "namespace": "billing",
  "object_name": "invoice",
  "read_tool": "billing.inspect_invoice",
  "proposal_tool": "billing.propose_late_fee_waiver",
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
npx -y -p @synapsor/runner synapsor-runner init \
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
npx -y -p @synapsor/runner synapsor-runner mcp config generic --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner mcp config claude-desktop --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner mcp config cursor --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Call one generated tool locally before wiring an MCP client:

```bash
npx -y -p @synapsor/runner synapsor-runner smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
```

`smoke call` uses the same runtime as the MCP server. It records evidence and
query audit for read tools, or creates a proposal for proposal tools, then
prints the commands to inspect evidence/proposals/replay. With the default
storage topology those records are in local SQLite. With
`storage.shared_postgres.mode = "runtime_store"`, Runner `1.4.12` and later
write them to the authoritative shared Postgres ledger and include `--config`
in follow-up commands. The supplied `--store` path is compatibility plumbing
for those CLI commands; it does not receive an orphan proposal copy. If the
shared ledger is unavailable, `smoke call` fails safely and does not fall back
to SQLite.

The snippets contain the local command and args. They must not contain database
URLs, passwords, approval tools, commit tools, or write credentials.

## 7. Validate the config

```bash
npx -y -p @synapsor/runner synapsor-runner config validate --config synapsor.runner.json
npx -y -p @synapsor/runner synapsor-runner config show --config synapsor.runner.json --redacted
```

The config stores environment-variable names, not connection-string values.

Run doctor after setting the referenced environment variables:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --config synapsor.runner.json
```

Doctor validates config shape, trusted context env vars, source env vars,
read/write credential separation, table/column metadata when the read URL is
available, and the semantic MCP tool boundary. Use JSON for automation:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --config synapsor.runner.json --json
```

## 8. Serve semantic MCP tools

Use stdio when a local MCP client can launch Synapsor Runner:

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"
npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Use Streamable HTTP when an app/server agent connects through a standard HTTP
MCP client:

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

npx -y -p @synapsor/runner synapsor-runner up --serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

`up --serve` runs the review-mode checklist first, then starts Streamable HTTP.
Use `--dry-run` for the checklist only, or `--with-handler` when the config uses
an app-owned executor and you want Runner to check the handler endpoint before
serving.

The lower-level MCP command starts the same transport directly:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Streamable HTTP defaults to `127.0.0.1:8766` and requires bearer auth by
default. Use private networking/TLS before exposing it beyond localhost. See
[HTTP MCP](http-mcp.md). If you want the smaller JSON-RPC bridge instead, use
`synapsor-runner mcp serve-http`.

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
npx -y -p @synapsor/runner synapsor-runner proposals list --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner proposals show wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
npx -y -p @synapsor/runner synapsor-runner proposals writeback-job wrp_123 --store ./.synapsor/local.db --output job.json
```

Apply through the trusted worker path with a separate writer credential:

```bash
export SYNAPSOR_DATABASE_WRITE_URL="<postgres-or-mysql-write-url>"
SYNAPSOR_ENGINE=postgres \
npx -y -p @synapsor/runner synapsor-runner apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

For `apply --job ... --config ...`, Runner reads the write credential from the
source `write_url_env` in `synapsor.runner.json`, such as
`SYNAPSOR_DATABASE_WRITE_URL`. `SYNAPSOR_DATABASE_URL` is accepted only as a
legacy fallback for direct worker flows that do not pass a local config.

If your application/API should own the business write, use an `http_handler`
executor instead of direct SQL writeback. Handler URLs and bearer tokens come
from environment variables, and the handler receives a structured proposal/job
payload, not arbitrary model SQL:

```bash
npx -y -p @synapsor/runner synapsor-runner apply --proposal wrp_123 --config synapsor.runner.json --store ./.synapsor/local.db
```

See [Writeback Executors](writeback-executors.md).

Replay afterward:

```bash
npx -y -p @synapsor/runner synapsor-runner replay show wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

## Boundary

MCP tool call equals request/proposal authority. Trusted runner equals
execution authority.

If tenant scope, primary key, allowed columns, expected version, approval state,
or local config cannot be verified, do not apply the write.
