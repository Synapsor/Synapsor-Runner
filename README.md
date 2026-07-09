# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

Stop giving AI agents `execute_sql()`. Give them reviewed business actions.

Synapsor Runner is an open-source, local-first MCP server that exposes reviewed semantic
capabilities over Postgres and MySQL, stages risky writes as proposals, and
keeps evidence and replay for agent actions. It sits between Claude, Cursor,
OpenAI Agents SDK, or another MCP client and your database so the model does
not receive raw SQL, write credentials, approval tools, or commit authority.

```text
Without Synapsor:
  agent -> execute_sql("UPDATE invoices SET late_fee_cents = 0 ...")
           # raw write path, model-controlled scope, easy tenant mistake

With Synapsor Runner:
  agent -> billing.propose_late_fee_waiver(invoice_id, reason)
           # proposal only
  human approves -> guarded writeback applies exactly one change
```

Try the no-database quick demo:

```bash
npx -y @synapsor/runner demo --quick
```

You will see semantic tools instead of raw SQL, an exact proposal rather than
an immediate write, approval/apply outside MCP, and a receipt/replay record.

## The Five-Line Model

Your agent talks to Synapsor Runner, not directly to your database.
It can look: scoped reads through reviewed tools.
It can suggest: saved proposals with evidence and exact diffs.
It cannot commit: approval and writeback happen outside the model-facing tool.
After writeback, Runner keeps receipts and replay so you can inspect what happened.

```text
AI agent or MCP client
(Claude, Cursor, OpenAI Agents SDK, LangGraph)
        |
        | calls reviewed MCP tool
        v
+--------------------------------+
| Synapsor Runner MCP            |
| semantic capabilities only     |
| trusted tenant/principal ctx   |
| evidence + query audit         |
+--------------------------------+
        |
        | scoped read / guarded proposal
        v
+--------------------------------+
| Your Postgres or MySQL         |
| source of truth                |
+--------------------------------+

Local Runner store:
evidence · query audit · proposals · receipts · replay
```

Your database stays the source of truth. Synapsor Runner owns the
model-facing boundary: what the agent can read, what it can propose, what
evidence is saved, and what can later be reviewed or replayed.

## Start Here

Run the guided quick demo first. It does not require Docker, a database, a
config file, an MCP client, or a Synapsor Cloud account.

```bash
npx -y @synapsor/runner demo --quick
```

In a terminal, it walks through the safety model step by step. In CI, piped
output, or other non-interactive mode, it prints a short summary and exits
without waiting for Enter.

That command creates a local ledger fixture at `./.synapsor/quick-demo.db`.
It does not prove database connectivity. It shows the proposal, evidence, and
replay flow without giving the runner a database URL.

```bash
npx -y @synapsor/runner demo inspect
```

Then choose one path:

```text
Full disposable proof -> npx -y -p @synapsor/runner synapsor-runner demo
Inspect MCP risk       -> npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp
```

Flagship example: [`examples/support-plan-credit`](examples/support-plan-credit)
shows the contract policy path end to end: `$25` auto-approved by policy,
`$100` held for local review, and `$1000` rejected by the reviewed bound before
any proposal row exists.

## Why Not Just Build This Yourself?

You can build the outline in an afternoon:

```text
model calls a function
-> app stores a pending change
-> human approves
-> app runs SQL
```

That is useful, but it is not the safety layer. The repeated hard parts are
tenant scope, no raw SQL exposure, evidence, query audit, exact diffs,
approval outside the model-facing tool surface, idempotency, stale-row conflict
checks, affected-row checks, receipts, and replay.

Synapsor Runner gives you those pieces as a local runtime:

- reviewed semantic capabilities instead of `execute_sql`;
- trusted tenant/principal/object bindings from your server-side context;
- scoped reads with evidence handles and query audit;
- saved proposals with exact before/after changes;
- approval and writeback commands that are not exposed to the model;
- guarded direct writeback for one-row updates;
- app-owned executors for richer writes;
- idempotency receipts and replay so you can inspect what happened later.

If all you need is restricted reads, a read-only database user and safe views
are a good start. Use Runner when you need the agent-facing boundary around
those reads, or when database-backed actions must become proposals before any
durable write happens.

## More Than A Tool Proxy

Synapsor is intentionally more than an MCP wrapper. The public packages include
a versioned contract, DSL compiler, schema validation, conformance fixtures,
Runner enforcement, proposal/evidence/replay artifacts, Cloud registry push,
and C++/Cloud round-trip verification.

## Connect Your Postgres Or MySQL

Use a staging or disposable database first:

```bash
export DATABASE_URL="postgres://readonly:...@localhost:5432/app"
npx -y -p @synapsor/runner synapsor-runner start --from-env DATABASE_URL
```

The first-run path is:

```text
1. Inspect schema and generate a reviewed config with start/init/onboard.
2. Run tools preview to confirm no raw SQL or write credentials are exposed.
3. Run smoke call against one generated inspect tool.
4. Start review mode with up --serve or mcp serve.
5. Inspect, propose, approve, apply, and replay from the local ledger.
```

Useful commands after setup:

```bash
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner up --serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

If you already have a canonical `synapsor.contract.json` from the DSL, Cloud,
or the C++ exporter, keep it as the source of truth and reference it from local
runner wiring:

```json
{
  "version": 1,
  "mode": "review",
  "contracts": ["./synapsor.contract.json"],
  "sources": {
    "local_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL"
    }
  },
  "storage": {
    "sqlite_path": "./.synapsor/local.db"
  }
}
```

Preview the model-facing tool surface before connecting an MCP client:

```bash
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

## What Runner Does

When an agent uses Runner:

- the model gets reviewed capabilities, not raw database authority;
- reads produce evidence handles and query audit;
- writes become proposals, not direct mutations;
- approval and writeback happen outside the model-facing MCP surface;
- replay shows what the agent saw, proposed, and what was applied or blocked.

## Four Terms

- Capability: a tool you define in config, such as `billing.inspect_invoice`
  or `billing.propose_late_fee_waiver`. The agent only sees capabilities.
- Proposal: the agent's suggested database-backed change. It is saved, not
  applied.
- Writeback: the moment an approved proposal actually changes the database.
- Executor: your app's writeback handler for anything richer than a guarded
  one-row update.

You install only `@synapsor/runner`. There is no separate handler package to
install. A handler is your app's endpoint or script for rich approved writes;
Runner includes templates and examples to help you build one.

## Packages

| Package | What it is |
| --- | --- |
| `@synapsor/runner` | The local runtime: CLI, MCP server, local store, evidence, proposals, approval, writeback, replay, and audit tools. |
| `@synapsor/spec` | The canonical portable contract package for contexts, resources, capabilities, workflows, evidence, proposals, receipts, and replay. |
| `@synapsor/dsl` | A SQL-like authoring layer that compiles `CREATE AGENT CONTEXT`, `CREATE CAPABILITY`, and `CREATE AGENT WORKFLOW` into `@synapsor/spec` JSON. |

Use the runner when you want something to execute locally. Use the spec when
you want a portable contract that Runner, Cloud, and the C++ engine can agree
on. Use the DSL when you want to author that contract in a reviewable,
database-style format.

## Author Your Contract

For new capabilities, prefer the portable contract path:

```text
contract.synapsor -> synapsor.contract.json -> synapsor.runner.json
```

Example DSL:

```sql
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.inspect_invoice
  DESCRIPTION 'Inspect one invoice in the trusted tenant before proposing a waiver.'
  RETURNS HINT 'Returns reviewed invoice fields plus evidence/query-audit handles.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ALLOW READ id, tenant_id, status, late_fee_cents, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
END

CREATE CAPABILITY billing.propose_late_fee_waiver
  DESCRIPTION 'Propose waiving one invoice late fee after inspecting invoice and policy evidence.'
  RETURNS HINT 'Returns a review-required proposal id, exact diff, evidence handle, and source_database_changed:false.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason for the proposed waiver.'
  ALLOW READ id, tenant_id, status, late_fee_cents, waiver_reason, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION waive_late_fee
  ALLOW WRITE late_fee_cents, waiver_reason
  PATCH late_fee_cents = 0
  PATCH waiver_reason = ARG reason
  BOUND late_fee_cents 0..10000
  APPROVAL ROLE billing_lead
  WRITEBACK DIRECT SQL
END
```

Compile, validate, and serve it:

```bash
synapsor-runner dsl compile ./contract.synapsor --out ./synapsor.contract.json --strict
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json \
  --api-url "$SYNAPSOR_CLOUD_BASE_URL" \
  --token "$SYNAPSOR_CLOUD_TOKEN" \
  --workspace "$SYNAPSOR_PROJECT_ID" \
  --name billing-late-fee
cd ./synapsor-runner-bundle
cp .env.example .env  # fill in and export your read-only database values
synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

`--strict` treats DSL safety warnings as errors, so CI catches proposal
capabilities that are missing descriptions, returns hints, or numeric patch
bounds.

The `contract bundle` step generates `synapsor.runner.json` (with env-var
placeholders) inside the bundle directory, which is why `mcp serve` runs from
there. The server keeps stdout clean for MCP protocol frames and prints its
ready line on stderr.

See [`docs/dsl-json-parity.md`](docs/dsl-json-parity.md) for the current
field-by-field support matrix across JSON spec, DSL, runner enforcement,
C++/Cloud compatibility, and Cloud push.

After a real push, open **Contract registry** in Synapsor Cloud to inspect the
immutable version, semantic capabilities, workflows, visible and kept-out
fields, policy references, warnings, and registry audit events. Downloading a
runner bundle returns the same normalized contract with placeholder local
wiring and ready-to-copy MCP configs.

- [Cloud push](docs/cloud-push.md)
- [Runner bundles](docs/runner-bundles.md)
- [MCP client configs](docs/mcp-clients.md)

Your `synapsor.runner.json` supplies local wiring: database env var names,
SQLite store path, MCP transport settings, and local debug options. The
contract supplies the portable meaning: contexts, capabilities, evidence,
proposal shape, and writeback intent.

## Who Does What

You write the config: sources, trusted context, capabilities, visible fields,
proposal fields, and guards. For rich writes, you also write a small handler.

Synapsor Runner serves the MCP tools, stores evidence/proposals/receipts,
enforces tenant, column, version, and idempotency guards, routes writeback, and
keeps the replay log. You do not rebuild the safety loop yourself.

## The Writeback Rule

One-row update to an existing row: Runner can do guarded direct writeback.
Anything else, such as inserting a row, touching two tables, or emitting an
event: your app-owned executor does it after approval.

## How An External Handler Works

Some changes are too rich for Runner's one-row writeback: insert a credit row,
touch two tables, or emit an event. For those, you run a small endpoint. The
flow is:

```text
agent proposes
-> human approves outside MCP
-> Runner POSTs the approved change to your endpoint
-> your code writes it in its own transaction and returns a receipt
```

The model never touches this code. You are the last line of defense: Runner
hands you the tenant, expected row version, and idempotency key, and your
handler must re-check all three. Skipping those checks reintroduces
cross-tenant writes, lost updates, or duplicate writes. Start from
`synapsor-runner handler template ...` instead of hand-rolling the safety checks.

## Deliberate Limits

Runner does not expose raw SQL, write credentials, approval tools, or commit
tools to the model. Direct Runner writeback does not do generic `INSERT`,
`DELETE`, `UPSERT`, DDL, or multi-row SQL. Those are app-owned executor jobs.

## Command Name

```bash
npm install -g @synapsor/runner
synapsor-runner demo --quick
```

`synapsor-runner` is the public command for this OSS runner. `synapsor` is
reserved for the Synapsor Cloud CLI. If you install the package globally, you
can drop the `npx -y -p @synapsor/runner` prefix.

Contributor note: during development, test local changes with
`./bin/synapsor-runner ...` or a packed tarball. `npx -p @synapsor/runner ...`
only tests the currently published package, not unpublished local source
changes.

Authoring reference:

- [Migrating To `@synapsor/spec`](docs/migrating-to-synapsor-spec.md):
  split portable contract semantics from local runner wiring.
- [Conformance Fixtures](docs/conformance.md): how the shared fixture suite
  keeps Runner and Cloud/C++ contract semantics from drifting.
- [Capability Authoring](docs/capability-authoring.md): read/proposal tools,
  model-facing descriptions, result envelope v2, trusted context, and writeback
  guards.
- [Result Envelope v2](docs/result-envelope-v2.md): stable
  `ok`/`summary`/`data`/`proposal`/`error` MCP tool results.
- [JSON Schema](schemas/synapsor.runner.schema.json): editor validation for
  `synapsor.runner.json`.

## Operational Details

These are current alpha requirements, not hidden behavior:

- Writeback with `--config ./synapsor.runner.json` reads the trusted writer
  connection from the source `write_url_env`, for example
  `SYNAPSOR_DATABASE_WRITE_URL`. `SYNAPSOR_DATABASE_URL` is only the legacy
  fallback when you run direct worker/apply flows without a local config.
- `synapsor-runner mcp serve` is standard stdio MCP for local clients that can
  launch Runner.
- `synapsor-runner mcp serve-streamable-http` is standard MCP Streamable HTTP
  with `initialize` and in-memory session behavior for SDK/client HTTP MCP
  integrations.
- OpenAI Agents SDK rejects dotted function/tool names. Use
  `--alias-mode openai` or `--openai-tool-aliases` for OpenAI-facing MCP
  transports. Runner exposes aliases such as `billing__inspect_invoice` and
  keeps the canonical Synapsor capability name in tool metadata.
- `synapsor-runner mcp serve-http` is a small authenticated JSON-RPC bridge for
  `tools/list`, `tools/call`, and `resources/read`. Use it only when you want a
  simple app/server wrapper instead of full HTTP MCP.
- Direct SQL writeback creates or writes `synapsor_writeback_receipts` for
  idempotency and replay. The trusted writer needs permission for that table,
  or an administrator must pre-create it and grant access. Use an app-owned
  `http_handler` or `command_handler` if Runner should not create receipt
  tables in your application schema.
- Run `synapsor-runner doctor --config synapsor.runner.json --check-writeback`
  after reviewing receipt-table DDL/grants to verify writer connectivity,
  receipt-table permissions, and rollback-only target-table access. The probe
  never mutates business rows, but it can create the receipt table if the
  writer has permission.
- For app-owned `http_handler` executors, configure `signing_secret_env` to
  have Runner sign writeback requests with `X-Synapsor-Signature`. Run
  `synapsor-runner doctor --config synapsor.runner.json --check-handlers` to
  check handler env vars and network reachability without applying a proposal.

## Run The Full Disposable Demo

The full demo requires Docker. It starts a disposable local Postgres-backed app
and proves the proposal-first write path:

```bash
npx -y -p @synapsor/runner synapsor-runner demo
```

For contributor/release verification from a checkout, the live apply smoke uses
four disposable Postgres/MySQL scenarios and the official MCP stdio client
transport:

```bash
corepack pnpm test:live-apply
```

It verifies semantic tool listing, proposal diffs, source rows unchanged before
approval, guarded writeback, idempotent retry, stale-row conflict, receipts,
replay, and the support-plan-credit policy tiers. See
[`docs/local-mode.md`](docs/local-mode.md#local-mcp-smoke) for prerequisites and
expected output.

After the demo prints its generated config and store path, run the happy path it
prints. The shape is:

```bash
synapsor-runner propose billing.propose_late_fee_waiver --sample
synapsor-runner proposals show latest
synapsor-runner proposals approve latest --yes
synapsor-runner apply latest
synapsor-runner replay show latest
synapsor-runner replay show latest --details
```

What you should see:

```text
Agent called:
billing.propose_late_fee_waiver

Proposal created:
invoice.late_fee_cents
5500 -> 0

Source DB changed:
no

Approval:
required outside MCP

After approval:
guarded writeback applied

Replay:
saved
```

That is the core point: the model can ask for a database-backed business
change, but durable state changes only after reviewed approval and guarded
writeback.

## Connect Your Own Staging Database

Use this after the quick demo makes sense. Start with staging, a disposable
database, or a least-privilege view. Do not start with your most sensitive
production database.

Put the read-only connection string in an environment variable:

```bash
export DATABASE_URL="postgresql://readonly_user:password@host:5432/app?sslmode=require"
```

For disposable dev RDS fixtures only, use `sslmode=no-verify` if your local
Node/Postgres TLS stack cannot verify the test certificate chain. For real
staging or production-like databases, keep certificate verification enabled.

Run the guided own-database path:

```bash
npx -y -p @synapsor/runner synapsor-runner start \
  --from-env DATABASE_URL \
  --schema public
```

`start --from-env` is the low-friction alias for `onboard db --from-env`. That
path inspects metadata, helps you choose one table/view, creates trusted
context bindings, generates semantic MCP tools, validates the tool boundary,
and prints the exact MCP/UI next commands. It does not require hand-authored
JSON. If you provide an optional real object id during the wizard, it also
writes `./.synapsor/smoke-input.json` so the first tool call can use an actual
row instead of guessed sample data. When the read URL env var and trusted
tenant/principal env vars are already set, onboarding also attempts that smoke
call immediately and stores the evidence/query audit in the local ledger. If
those env vars are missing, it prints the exact command to run after you set
them from `.env.example`.

Bring the generated review-mode workspace up with one command:

```bash
npx -y -p @synapsor/runner synapsor-runner up \
  --serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

`up` validates the config/store, summarizes model-facing tools, shows whether
proposal tools use direct SQL writeback or app-owned executors, checks active
store leases, and prints the next smoke, approve, apply, replay, UI, and doctor
commands. By default, `up` is guidance-only. Use `up --serve` to start the
standard Streamable HTTP MCP server after the checklist; use `--dry-run` to
rehearse without starting it. For app-owned executor configs, add
`--with-handler` to run the handler doctor before serving.

For CI, shell scripts, or an LLM driving the setup, use the prompt-free path:

```bash
npx -y -p @synapsor/runner synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --schema public \
  --table invoices \
  --mode review \
  --tenant-column tenant_id \
  --primary-key id \
  --conflict-column updated_at \
  --namespace billing \
  --object-name invoice \
  --id-arg invoice_id \
  --visible-columns id,tenant_id,late_fee_cents,waiver_reason,updated_at \
  --patch late_fee_cents=fixed:0,waiver_reason=arg:reason \
  --patch-bounds late_fee_cents=0:5500 \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL \
  --yes
```

If `--namespace` is omitted, Runner derives a namespace from the table name
instead of creating `source.*` tools. Use `--read-tool` and `--proposal-tool`
when you need exact model-facing names.

For app-owned writeback, replace `--write-url-env ...` with
`--writeback http_handler --handler-url-env APP_WRITEBACK_URL --emit-handler`.
Runner marks that source as read-only unless you explicitly pass a writer env,
so `config validate` does not warn that direct SQL writeback is disabled.
You can also pass `--answers ./answers.json --yes` for a fully declarative
setup file.

The end-to-end shape is:

```text
1. Put your read-only DB URL in DATABASE_URL.
2. Run start --from-env DATABASE_URL.
3. Choose one table/view and the safe fields agents may see.
4. Preview the generated capabilities.
5. Serve them over MCP to Claude, Cursor, OpenAI Agents SDK, or your app.
6. For writes, approve a proposal outside MCP before writeback.
```

The generated config is just the safety contract. A small reviewed version
looks like this:

```json
{
  "version": 1,
  "mode": "review",
  "result_format": 2,
  "sources": {
    "app_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL",
      "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL"
    }
  },
  "trusted_context": {
    "provider": "environment",
    "values": {
      "tenant_id_env": "SYNAPSOR_TENANT_ID",
      "principal_env": "SYNAPSOR_PRINCIPAL"
    }
  },
  "capabilities": [
    {
      "name": "billing.inspect_invoice",
      "kind": "read",
      "source": "app_postgres",
      "target": {
        "schema": "public",
        "table": "invoices",
        "primary_key": "id",
        "tenant_key": "tenant_id"
      },
      "args": {
        "invoice_id": { "type": "string", "required": true }
      },
      "lookup": { "id_from_arg": "invoice_id" },
      "visible_columns": ["id", "status", "late_fee_cents", "updated_at"],
      "evidence": "required",
      "max_rows": 1
    },
    {
      "name": "billing.propose_late_fee_waiver",
      "kind": "proposal",
      "source": "app_postgres",
      "target": {
        "schema": "public",
        "table": "invoices",
        "primary_key": "id",
        "tenant_key": "tenant_id"
      },
      "args": {
        "invoice_id": { "type": "string", "required": true },
        "reason": { "type": "string", "required": true }
      },
      "lookup": { "id_from_arg": "invoice_id" },
      "visible_columns": ["id", "status", "late_fee_cents", "updated_at"],
      "patch": {
        "late_fee_cents": { "fixed": 0 },
        "waiver_reason": { "from_arg": "reason" }
      },
      "allowed_columns": ["late_fee_cents", "waiver_reason"],
      "conflict_guard": { "column": "updated_at" },
      "approval": { "mode": "human", "required_role": "billing_lead" }
    }
  ]
}
```

The agent sees `billing.inspect_invoice` and
`billing.propose_late_fee_waiver`. It does not see the database URL, writer
credential, raw SQL, approval command, or commit command.

Prefer the step-by-step commands if you want to inspect each stage manually:

```bash
npx -y -p @synapsor/runner synapsor-runner inspect \
  --engine auto \
  --from-env DATABASE_URL \
  --schema public

npx -y -p @synapsor/runner synapsor-runner init --wizard --from-env DATABASE_URL --mode read_only
```

The wizard creates this local flow:

```text
trusted context -> capability -> MCP tool
```

It asks which table/view backs the context, which tenant/scope column and
backend session env vars are trusted, which fields are visible, and what
semantic capability name to expose. Before writing files, it shows a final
preview and lets you revise visible fields or capability names. It writes
`synapsor.runner.json`, `.env.example`, and MCP client snippets. It does not put
your database URL in the MCP client config.

Preview the tools:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Call one generated tool locally before wiring an MCP client:

```bash
npx -y -p @synapsor/runner synapsor-runner smoke call \
  <generated.inspect_tool_name> \
  --input ./.synapsor/smoke-input.json \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

`smoke call` uses the same runtime as MCP, records evidence/query audit or a
proposal in the local store, and then prints the evidence/proposal/replay
commands to inspect what happened. If you skipped the optional smoke input in
the wizard, pass one real row id instead:

```bash
npx -y -p @synapsor/runner synapsor-runner smoke call \
  <generated.inspect_tool_name> \
  --json '{"<lookup_arg>":"<real_id>"}' \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Serve the semantic MCP tools locally:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

## Three Ways To Run MCP

Use stdio when the MCP client runs locally and can launch Synapsor Runner. Use
Streamable HTTP when a standard HTTP MCP client connects to a long-running
Runner process. Use the JSON-RPC bridge only when you want simple POST calls
from your own app/server wrapper.

Local MCP clients:

```bash
synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

For OpenAI Agents SDK over stdio, add OpenAI-safe aliases:

```bash
synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --alias-mode openai
```

App/server deployments:

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

You can also start the same review-mode server through the safer startup
checklist:

```bash
synapsor-runner up --serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

The same Streamable HTTP server can also be started through the unified serve
command:

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

Streamable HTTP defaults to `127.0.0.1:8766`, requires bearer auth by default,
and should use private networking, TLS, and rate limits before being exposed
beyond a local machine. With `--alias-mode openai`, tools are exposed to
the model as OpenAI-safe aliases such as `billing__inspect_invoice`; `_meta`
still includes `synapsor.canonical_tool_name = billing.inspect_invoice`, and
Runner routes calls back to the canonical Synapsor capability. Use
`--alias-mode both` during migrations if one client still expects canonical
dotted names while another needs OpenAI-safe aliases.

Bridge mode:

```bash
synapsor-runner mcp serve-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Bridge HTTP defaults to `127.0.0.1:8765` and supports only JSON-RPC
`tools/list`, `tools/call`, and `resources/read`. It does not implement MCP
Streamable HTTP `initialize`/session behavior.

OpenAI Agents SDK examples:

```text
examples/openai-agents-stdio/
examples/openai-agents-http/
```

Detailed setup: [docs/openai-agents-sdk.md](docs/openai-agents-sdk.md).

Use `--mode review` only when you are ready to create proposal tools and test
guarded writeback. Review mode needs an approved write path and a separate
trusted write credential; the model-facing read URL should stay least
privilege.

## Audit Your MCP Database Tools

`synapsor-runner audit` is a static MCP/database risk review. It is useful even before
you adopt the full runner.

```bash
synapsor-runner audit --example dangerous-db-mcp
synapsor-runner audit --example dangerous-db-mcp --format markdown
synapsor-runner audit ./synapsor.runner.json
synapsor-runner audit --mcp-config ./claude_desktop_config.json
synapsor-runner audit --stdio "node ./my-db-mcp-server.js"
```

The built-in example runs without cloning this repository or downloading an
examples file. File-based audits still work when you have your own exported MCP
tool manifest.

It looks for patterns such as:

- arbitrary SQL tools;
- broad database write tools;
- model-facing approval/commit tools;
- missing tenant/principal context;
- dangerous tool names;
- unclear parameter schemas;
- mutation tools without proposal/approval.

Example finding:

```text
Risk: high

Found:
- execute_sql appears to expose arbitrary database access.
- approve_refund appears to let the model approve a durable write.
- update_customer appears to mutate state without a proposal boundary.
- No trusted tenant/principal context was detected.

Suggested safer shape:
- billing.inspect_invoice
- billing.propose_late_fee_waiver
- approval outside MCP
- guarded writeback after approval

Note:
This is a static risk review, not a security guarantee.
```

## Why Not Just Use A Read-Only Database User?

You should use one.

Synapsor Runner is not a replacement for least-privilege database permissions.
Start with a read-only user, restricted views, row-level security, and staging
data where appropriate.

The difference is that database permissions protect the connection. Synapsor
Runner shapes the model-facing interface.

Instead of exposing `execute_sql`, `query_database`, table names, or
model-controlled tenant filters, Synapsor exposes reviewed business
capabilities such as `billing.inspect_invoice` and
`billing.propose_late_fee_waiver`.

For read-only use cases, Runner provides scoped semantic tools, trusted context
binding, evidence handles, query audit, and local inspection. Proposal
workflows add full replay across evidence, approval, writeback receipts, and
events.

If all you need is restricted reads, database permissions are a good start.
Use Synapsor Runner when you also want the agent-facing layer: semantic tools,
trusted context, evidence handles, query audit, local inspection, and
proposal-first writes.

## Find Evidence And Replay

The commands in this section require this checkout or an alpha package that
includes the local-ledger CLI surface.

Synapsor Runner writes a local evidence/replay ledger to SQLite. Use it to
answer questions such as:

```text
What did the agent see and do for invoice INV-3001?
```

Search the local activity ledger:

```bash
synapsor-runner activity search --tenant acme --object invoice:INV-3001
synapsor-runner activity search --capability billing.propose_late_fee_waiver --from 2026-06-01 --to 2026-06-23
synapsor-runner events tail --store ./.synapsor/local.db
synapsor-runner events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/local.db
```

Inspect the linked records:

```bash
synapsor-runner proposals list --tenant acme --object invoice:INV-3001 --status approved
synapsor-runner evidence show ev_...
synapsor-runner query-audit list --evidence ev_...
synapsor-runner receipts list --proposal wrp_...
synapsor-runner receipts show <receipt_id>
synapsor-runner replay show --proposal wrp_...
synapsor-runner replay show --replay replay_wrp_...
```

The default views answer what happened, whether the source DB changed, the
current status, and the next command to run. Add `--details` when you need
target URIs, primary keys, proposal hash/version, conflict guards, query
fingerprints, event timestamps, or receipt internals.

Export replay or evidence for review:

```bash
synapsor-runner replay export --proposal wrp_... --format json --output replay.json
synapsor-runner replay export --proposal wrp_... --format markdown --output replay.md
synapsor-runner evidence export ev_... --format markdown --output evidence.md
```

Create a redacted local diagnostic report:

```bash
synapsor-runner doctor --config synapsor.runner.json --report --redact --output synapsor-doctor.md
synapsor-runner doctor --config synapsor.runner.json --check-writeback
```

Inspect or compact the local ledger:

```bash
synapsor-runner store stats --store ./.synapsor/local.db
synapsor-runner events tail --store ./.synapsor/local.db --follow
synapsor-runner events webhook --url-env SYNAPSOR_EVENT_WEBHOOK_URL --auth-token-env SYNAPSOR_EVENT_WEBHOOK_TOKEN --follow --store ./.synapsor/local.db
synapsor-runner store vacuum --store ./.synapsor/local.db
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --dry-run
synapsor-runner store reset --store ./.synapsor/local.db --yes
```

`events webhook` is a local/dev/staging convenience for review UIs, Slack
bridges, or app-local notifications. It POSTs one redacted local event envelope
per lifecycle event; it is not a hosted central ledger.

This is local indexed search for local/dev/staging usage. It is not a hosted
central ledger, not RBAC/SSO, not cross-runner search, and not compliance
retention. Synapsor Cloud adds a shared contract registry and enabled hosted
activity/evidence surfaces; confirm retention and production operations for
the specific design-partner deployment.

## Connect Claude, Cursor, Or Another MCP Client

Generate a local MCP client snippet:

```bash
synapsor-runner mcp config --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Use a specific client shape when needed:

```bash
synapsor-runner mcp config cursor --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner mcp config vscode --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner mcp config generic --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The generated config references the local runner command. It does not include:

- database URL;
- database password;
- write credentials;
- approval tools;
- commit/apply tools.

## Sanity Check The Agent Connection

After you connect Claude, Cursor, OpenAI Agents SDK, or another MCP client, run
one tiny tool-call test before asking the agent to solve a real task.

First preview the tools Runner will expose:

```bash
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For OpenAI-facing clients, preview the model-visible aliases:

```bash
synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --alias-mode openai
```

Example:

```text
Exposed to MCP:
  - billing__inspect_invoice -> billing.inspect_invoice
```

Then ask the agent:

```text
Use the Synapsor Runner MCP tool to inspect invoice INV-3001.
Do not answer from memory.
Return the tool name called, the evidence handle, and whether raw SQL was available.
```

For your own database, replace `invoice INV-3001` with one real object ID and
the semantic tool name from `tools preview`.

Expected result:

- the agent calls a Synapsor Runner tool such as `billing.inspect_invoice`;
- the response includes an evidence handle or local ledger reference;
- the agent says raw SQL/write/approval tools were not available.

If the agent gives generic advice, a freeform summary, or unrelated planning
text without a tool call or evidence handle, Runner is not in the loop yet. Fix
the MCP client config, restart the client, confirm trusted context environment
variables are set, and rerun `synapsor-runner tools preview`.

## What The Model Gets

The model gets reviewed semantic capabilities from `synapsor.runner.json`, for
example:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
support.inspect_ticket
support.propose_plan_credit
orders.inspect_order
orders.propose_status_change
```

These are business tools with trusted scope, visible fields, evidence rules,
proposal boundaries, and writeback guards.

## Fixture Benchmark

Run the included MCP efficiency fixture:

```bash
synapsor-runner benchmark mcp-efficiency
```

Current fixture result for the late-fee-waiver workflow:

```text
Generic database MCP reference:
  exposed tools: 4
  scripted tool calls: 5
  raw SQL exposed: yes
  approval separated: no
  stale-row conflict checked: no

Synapsor Runner semantic path:
  exposed tools: 2
  scripted tool calls: 2
  raw SQL exposed: no
  approval separated: yes
  stale-row conflict checked: yes
```

The fixture tokenizer is deterministic and repeatable for this repo. It is not
a model billing tokenizer and not a universal token-savings claim.

## Safe Write Examples

The disposable reference app includes three proposal-first write shapes:

- `billing.propose_late_fee_waiver`: waive a late fee after evidence and review.
- `support.propose_plan_credit`: propose a bounded customer credit for a support case.
- `orders.propose_status_change`: move an order through an allowlisted status transition.

Each tool creates evidence, a before/after diff, and a local proposal. The
source database is unchanged until approval outside MCP and guarded writeback.

## What The Model Never Gets

Synapsor Runner does not expose:

```text
execute_sql
raw_sql
query_database
database URLs
write credentials
approval tools
commit/apply tools
arbitrary table names
arbitrary column names
model-controlled tenant authority
direct write access
```

Approval and writeback stay outside the model-facing MCP tool surface.

## App-Owned Writeback

Direct guarded DB writeback is useful for local/staging demos and simple
single-row updates. If your application service already owns business writes,
configure an `http_handler` or `command_handler` executor instead.

The flow stays the same: model-facing MCP creates a proposal, approval happens
outside MCP, Synapsor Runner sends an approved job to your app handler, and the
handler returns an applied/conflict/failed receipt for replay.

> **Important:** your app handler owns the final business write. Runner creates
> the proposal and calls your handler only after approval, but your handler must
> still enforce tenant/scope checks, expected-version or conflict guards,
> idempotency keys, allowed business actions, transaction/rollback, and safe
> error receipts. If you skip those checks, you can reintroduce cross-tenant
> writes, lost updates, or duplicate writes. Keep handler credentials out of MCP.

Details: [docs/writeback-executors.md](docs/writeback-executors.md). Starter
handlers live in [examples/app-owned-writeback](examples/app-owned-writeback).
The runner npm package includes handler templates and the
`examples/mcp-postgres-billing-app-handler/synapsor-handler.mjs` bundled helper
shim. These show bearer/HMAC auth, tenant scope, expected-version guards,
idempotency, transaction rollback, and safe receipts around your business
effect. There is no separate handler package to install.
The full Postgres billing example in
[examples/mcp-postgres-billing-app-handler](examples/mcp-postgres-billing-app-handler)
shows `billing.propose_account_credit` creating a proposal first, then inserting
an `account_credits` row through an app-owned HTTP handler after approval.
You can also generate a starter handler directly:

```bash
npx -y -p @synapsor/runner synapsor-runner handler template node-fastify \
  --output ./synapsor-writeback-handler.mjs
```

For direct SQL writeback, set the writer env var named by the source
`write_url_env`, for example `SYNAPSOR_DATABASE_WRITE_URL`. Runner also creates
or writes `synapsor_writeback_receipts` for idempotency/replay, so the writer
needs permission for that receipt table or an administrator must pre-create and
grant it. Use app-owned handlers when you do not want Runner creating receipt
tables in your application schema.

## Safety Model

```text
MCP client
-> Synapsor Runner
-> semantic capability
-> trusted tenant/principal context
-> scoped DB read
-> evidence-backed proposal
-> approval outside MCP
-> guarded writeback
-> receipt and replay
```

Current boundaries:

- no generic SQL tools;
- no model-facing approval or apply tools;
- tenant/principal scoping is enforced;
- allowed columns are enforced;
- primary-key targeting is required;
- conflict/version guards are available;
- idempotency keys are used;
- affected row count is checked;
- direct DB writeback is limited to guarded single-row `UPDATE`.

## Safety Checks It Catches

After the happy path, use the demo and tests to inspect failure cases:

- stale-row conflict;
- missing tenant context;
- disallowed write column;
- model-facing commit or approval tool;
- arbitrary SQL tool.

The important stale-row case:

```text
The row changed after the agent saw it.
Result: conflict
Source DB changed by Synapsor: no
```

Conflict handling is a safety check, not the first demo payoff.

## Local Features

| Feature | Runner version |
| --- | --- |
| Context bindings | Trusted tenant/principal from env, static dev config, HTTP claims, or cloud session |
| Capabilities | Local semantic MCP tools from `synapsor.runner.json` |
| Evidence | Local evidence bundles and query audit records |
| Proposals | Local before/after change sets |
| Approval | Local CLI/UI approval outside MCP |
| Writeback | Guarded single-row `UPDATE` for Postgres/MySQL |
| Replay | Local replay of proposal, evidence, events, receipts, and query audit |
| MCP audit | Static risk review for MCP database tools |

The runner intentionally does not include full Synapsor Cloud/DBMS features such
as workflow DAGs, native branches, time travel, settlement policies, governed
memory, RBAC/SSO, hosted evidence ledger, managed runners, CDC, or C++ DBMS
internals.

## Local Runner Vs Synapsor Cloud

| Need | Synapsor Runner | Synapsor Cloud |
| --- | --- | --- |
| Local MCP server | Yes | Contracts export back to Runner; a managed fleet is not claimed |
| Local trusted context bindings | Yes | Contract bindings are registered; hosted session behavior is pilot-specific |
| Local semantic capabilities | Yes | Hosted registry + versioning |
| Local evidence/proposal/replay | Yes | Central searchable ledger |
| Local approval | CLI/UI | Existing team approval surfaces where enabled for a pilot |
| Writeback | Guarded single-row `UPDATE` | Cloud-linked jobs exist; managed production orchestration is not claimed |
| MCP risk audit | Static/local | Continuous/org-wide |
| RBAC/SSO | No | RBAC where configured; SAML/SCIM are not in this beta |
| Policy packs | Local reviewed subset | Registry preserves policies; hosted enforcement is not implied |
| Workflow builder | No | Existing Cloud authoring surfaces; full public DAG parity is not claimed |
| Native branches/time travel | No | Yes |
| Settlement policies | No | Yes |
| Compliance exports | No | Audit/retention primitives exist; legal hold/certification are not claimed |
| Production support/SLA | No | Design-partner support; no enterprise SLA is claimed |

The runner is useful by itself for local/staging safety. Synapsor Cloud adds a
shared contract registry, immutable versions, downloadable Runner bundles, and
existing team activity/evidence/approval surfaces where enabled. Managed
runners, SAML/SCIM, legal hold, and an enterprise SLA remain future work.

Portable contracts can be checked locally before Cloud import:

```bash
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json \
  --api-url "$SYNAPSOR_CLOUD_BASE_URL" \
  --token "$SYNAPSOR_CLOUD_TOKEN" \
  --workspace "$SYNAPSOR_PROJECT_ID" \
  --name billing-late-fee
```

## Current Limitations

Supported in the current `0.1.x` line:

- stdio MCP server;
- authenticated HTTP MCP server for app/server deployments;
- Postgres/MySQL inspection;
- semantic read tools;
- evidence-backed proposals;
- local approval outside MCP;
- guarded single-row `UPDATE`;
- local SQLite evidence/proposal/replay store;
- tenant, primary-key, allowed-column, idempotency, and conflict guards;
- static MCP risk audit.

Not supported:

- raw `execute_sql`;
- model-generated SQL;
- DDL;
- INSERT;
- DELETE;
- UPSERT;
- multi-row writes;
- stored procedures;
- physical branching of external Postgres/MySQL;
- full Synapsor workflow DAG execution;
- Synapsor SQL generation;
- auto-merge or settlement-policy semantics;
- model-callable approval or commit tools;
- general prompt-injection prevention;
- production SLA or compliance certification.

Contract and DSL authoring can declare workflows and allowed capabilities with
`CREATE AGENT WORKFLOW`. Runner 0.1 validates, bundles, and surfaces those
contracts, but it does not execute full Synapsor Cloud workflow DAGs,
auto-merge, settlement policies, or native branching.

Complete limits: [docs/limitations.md](docs/limitations.md).

Security boundary: [docs/security-boundary.md](docs/security-boundary.md).

Single-node production-candidate runbook:
[docs/production.md](docs/production.md).

Release notes and stable-tag policy:
[docs/release-notes.md](docs/release-notes.md).

## Stable Compatibility Promise

Starting with `0.1.0`, Synapsor Runner keeps the following surfaces compatible
through the `0.1.x` line unless a release note explicitly marks a deprecation
first:

- the `synapsor-runner` binary name and README quickstart commands;
- `synapsor.runner.json` schema version `1` for documented fields;
- result envelope v2 for new configs, with the documented v1 opt-out;
- stdio MCP and Streamable HTTP MCP command surfaces;
- generated MCP client snippets for documented clients;
- proposal, approval, guarded writeback, receipt, evidence, query-audit, and
  replay inspection commands;
- direct SQL writeback and app-owned executor contracts documented in this
  README and `docs/writeback-executors.md`.

Stable does not mean production SLA, hosted Cloud features, compliance
certification, physical Postgres/MySQL branching, generic SQL writeback, or
support for undocumented local SQLite internals. Those limits remain explicit
in [docs/limitations.md](docs/limitations.md).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`).

Apache-2.0 applies to this runner repo. It does not grant rights to the
Synapsor name, logo, hosted cloud service, or proprietary Synapsor platform
features. See [docs/licensing.md](docs/licensing.md) and
[TRADEMARKS.md](TRADEMARKS.md).

Synapsor Cloud, hosted governance, advanced policy/workflow engines, enterprise
controls, and native Synapsor DBMS/C++ internals are outside this Apache-2.0
repository. Managed runners and other hosted features, where offered, are
proprietary and are not implied by the OSS package.

## Developer And Contributor Commands

Public docs use `synapsor-runner`. During source-checkout development, if the
global binary is not linked yet, use `./bin/synapsor-runner ...` or
`corepack pnpm runner ...`.

Helper scripts are wrappers and development conveniences, not the main product
interface:

```bash
./scripts/try-synapsor.sh
./scripts/demo-docker.sh
./scripts/open-demo-ui.sh
./scripts/use-your-db.sh
./scripts/mcp-config.sh
```

Contributor checks:

```bash
corepack pnpm install
./scripts/verify-release-gate.sh
```

After a manual alpha publish, verify the public npm package:

```bash
VERIFY_PUBLISHED_ALPHA=1 ./scripts/verify-release-gate.sh 0.1.0-alpha.17
```

After a manual stable publish/promotion, verify `latest`:

```bash
./scripts/verify-published-stable.sh 0.1.0
```

## Repository Map

- `apps/runner`: CLI entrypoint and local UI.
- `packages/spec`: canonical portable contract schemas, normalization, CLI, and conformance fixtures.
- `packages/dsl`: SQL-like contract authoring for contexts, capabilities, and workflow declarations.
- `packages/mcp-server`: stdio/HTTP MCP server and configured tool runtime.
- `packages/schema-inspector`: Postgres/MySQL metadata inspection and config generation.
- `packages/proposal-store`: local SQLite evidence/proposal/replay store.
- `packages/postgres`, `packages/mysql`: guarded writeback adapters.
- `packages/worker-core`: shared runner orchestration.
- `recipes`: optional starter contracts.
- `examples`: disposable local demos and reference app.
- `docs`: focused setup, MCP, security, troubleshooting, and limitation docs.

## Community

Synapsor Runner is maintained by Synapsor.

- Website: https://synapsor.ai
- Docs: https://synapsor.ai/docs
- License: Apache License 2.0 (`Apache-2.0`)
- Issues: use GitHub Issues
