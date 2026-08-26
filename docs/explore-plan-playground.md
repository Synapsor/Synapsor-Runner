# Explore Plan Playground

The Explore Plan Playground lets an operator validate or replay one exact JSON
Explore plan without asking a model to create it. The CLI is the primary
interface. Workbench offers the same local workflow as a preview.

This is a plan playground, not a SQL console:

- input is the fixed `app.explore_data` plan grammar;
- resource, field, and relationship names must be exact reviewed IDs;
- tenant and principal values never come from the JSON document;
- local execution resolves trusted scope from Runner configuration;
- production HTTP execution resolves scope from the verified JWT session;
- valid runs use the normal drift, scope, privacy, budget, evidence, and audit
  path;
- no `execute_sql`, arbitrary join, activation, approval, or commit surface is
  added.

The MCP surface remains exactly `app.describe_data` and `app.explore_data`.

## Prepare A Plan

Start from the reviewed catalog, not from the physical database schema:

```bash
synapsor-runner explore describe --project-root .
synapsor-runner explore describe \
  --resource public.orders \
  --project-root . \
  --json
```

Save a raw plan in `orders-by-region.json`:

```json
{
  "kind": "aggregate",
  "resource": "public.orders",
  "measures": [
    { "function": "count" }
  ],
  "dimensions": [
    { "field": "region" }
  ],
  "where": [
    { "field": "status", "op": "eq", "value": "completed" }
  ],
  "order_by": { "kind": "measure", "index": 0, "direction": "desc" },
  "top_n": 10
}
```

The exact MCP envelope is accepted too:

```json
{
  "boundary": "reviewed_staging",
  "plan": {
    "kind": "rows",
    "resource": "public.orders",
    "select": ["order_number", "status"],
    "order_by": { "field": "order_number", "direction": "asc" },
    "limit": 20
  }
}
```

Only `plan` and optional `boundary` are legal envelope keys. A document that
adds `tenant`, `tenant_id`, `principal`, a database URL, SQL, or another control
is refused. A boundary selected in the document must agree with `--boundary`.

## Validate Locally Without Querying Source Rows

Set the same trusted local scope required by Explore, then validate:

```bash
export SYNAPSOR_TENANT_ID=acme
export SYNAPSOR_PRINCIPAL=analyst-42 # only when the boundary requires it

synapsor-runner explore validate \
  --plan ./orders-by-region.json \
  --project-root .
```

Validation performs a fresh catalog and role-posture inspection, checks the
active boundary and generation lock, resolves trusted scope, normalizes the
plan, verifies every reviewed operation and relationship, applies complexity
bounds, resolves relative time windows once, and compiles the read-only SQL.

It does **not**:

- send the compiled data query to the source;
- reserve query, extraction, rate, or differencing budget;
- create an evidence bundle or query-audit record;
- change the source database.

The terminal shows the normalized plan and the exact parameterized statement
shape. Parameter values are absent, including filter values and trusted tenant
or principal values. Use `--json` for automation:

```bash
synapsor-runner explore validate \
  --plan ./orders-by-region.json \
  --project-root . \
  --json
```

Validation can prove that the plan is legal against the catalog snapshot at
that moment. It cannot reserve future budget or guarantee that schema, grants,
scope, or data availability will remain unchanged before a later run. Runner
rechecks those conditions when the plan executes.

## Run Through Normal Explore Enforcement

Run the same plan locally:

```bash
synapsor-runner explore run \
  --plan ./orders-by-region.json \
  --project-root . \
  --details
```

A successful run consumes the reviewed rolling allowances, executes the same
compiler-generated query used by `app.explore_data`, applies response bounds
and cohort suppression, and writes the normal evidence and query-audit records.
The human terminal result includes released rows or groups, suppression counts,
budget/audit metadata where available, and the evidence ID. Database text is
rendered as untrusted result data, never as authority or terminal control.

A refusal may happen before execution, or after a read query when a
complementary privacy release cannot safely be returned. The CLI distinguishes
those cases when the refusal carries execution metadata. No playground path can
mutate the source.

For scripts, read a file or stdin rather than embedding a large JSON document:

```bash
cat ./orders-by-region.json | \
  synapsor-runner explore run --plan - --project-root . --json
```

`--plan-json` is available for short experiments. `--input` is a compatibility
alias for `--plan`.

## Use The Interactive CLI

Open the stateful terminal playground:

```bash
synapsor-runner explore playground --project-root .
```

When no plan is preloaded, the terminal opens directly in paste mode. Paste the
formatted JSON exactly as copied; Runner detects the complete JSON object and
loads it without requiring a one-line conversion or a special terminator.
`Esc` cancels and opens the action menu.

The action menu supports Up/Down plus Enter and these shortcuts:

```text
P paste JSON   F load file   C catalog   B boundary
V preview SQL  R run plan    S last SQL    J loaded JSON   ? help   Q quit
```

Every detail screen uses Up/Down or PgUp/PgDn to scroll; `Esc` or Enter returns
to the menu. `Esc` from the menu exits and restores the normal terminal cursor.
Paste mode also retains a line containing only `.` as an optional manual finish.
Interactive mode cannot use `--plan -`, because stdin must remain available for
navigation. Use direct paste, `P`, a file, or noninteractive `validate`/`run`.

After local validation, `S` shows the compiled value-free SQL preview. After a
local run, `S` reads the exact parameterized SQL shape captured in that run's
evidence bundle. Parameter values remain absent. A production HTTP client never
receives operator SQL; the remote SQL view points to the server-side evidence
command instead. SQL is laid out across clauses for inspection; formatting is
display-only and does not alter the statement Runner compiled or executed. The
terminal keeps an animated status line visible while catalog, validation,
execution, or evidence SQL is loading.

When several active boundaries overlap, select one exact boundary with `B`,
`--boundary`, or the envelope's `boundary` key. Automatic routing remains
available when the exact resource ID maps to only one active boundary.

## Workbench Preview

Launch Workbench directly at the JSON playground:

```bash
synapsor-runner explore workbench --project-root .
```

The command starts the existing secured localhost Workbench, opens the one-time
bootstrap URL, authenticates the browser session, and then focuses **JSON plan
playground**. It provides:

- a code-editor surface with JSON syntax highlighting, synchronized line
  numbers, live parse state, cursor position, Format, and Copy;
- formatted paste plus Tab indentation, `Ctrl`/`Command`+`S` or
  `Ctrl`/`Command`+`Enter` to preview SQL, and
  `Ctrl`/`Command`+`Shift`+`Enter` to run;
- active-boundary selection;
- read-only trusted-scope source and binding names;
- **Preview parameterized SQL** and **Run reviewed plan** actions;
- highlighted normalized-plan and SQL output, with engine placeholders and
  parameter counts but no values;
- visible loading state with editing and run controls temporarily disabled, so
  one plan cannot be changed underneath an in-flight validation or run;
- released result, privacy, budget, timing, and evidence details.

Workbench sends neither tenant nor principal values in the plan. Its local
backend reads the same in-memory trusted context as the normal Workbench
Explore composer, requires the existing CSRF token, and calls the same shared
playground service as the CLI. The browser does not receive raw trusted-scope
values.

Workbench is a local preview and does not act as a browser-based proxy for a
remote production bearer token. Use the CLI for production HTTP replay.

## Replay Against Production HTTP

Obtain a short-lived access token through the configured identity provider and
place it in an environment variable. Runner does not issue or refresh tokens:

```bash
export SYNAPSOR_MCP_ACCESS_TOKEN="$(your-idp-token-command)"

synapsor-runner explore run \
  --url https://runner.example/mcp \
  --token-env SYNAPSOR_MCP_ACCESS_TOKEN \
  --plan ./orders-by-region.json
```

When the deployed public resource URL is already in the production config:

```bash
synapsor-runner explore run \
  --config ./synapsor.runner.json \
  --token-env SYNAPSOR_MCP_ACCESS_TOKEN \
  --plan ./orders-by-region.json
```

The token value cannot be supplied through a CLI option and is never printed.
URLs containing credentials, query parameters, or fragments are refused. HTTPS
is mandatory except for an explicit loopback test endpoint such as
`http://127.0.0.1:8766/mcp`.

Remote replay creates a standard authenticated Streamable HTTP MCP session and
calls exactly `app.explore_data`. The server verifies JWT signature, issuer,
audience, expiry, required OAuth scope, tenant claim, and principal claim before
constructing the scoped runtime. Query-string or plan fields cannot replace
those claims.

Remote validate-only is intentionally unavailable. Adding it as an MCP tool
would widen the fixed two-tool production surface. A remote `run` always
validates before execution; validate locally against the same reviewed artifacts
when a compile-only preview is required.

Production MCP returns the model-safe result projection. Operator-only budget
and resolved-window details remain in the server ledger rather than being added
to the model-facing envelope. Inspect them with the normal production evidence
commands:

```bash
synapsor-runner evidence list --config ./synapsor.runner.json --since 24h
synapsor-runner query-audit list --config ./synapsor.runner.json --since 24h
```

## Enforcement Matrix

| Check or effect | Validate | Run |
| --- | ---: | ---: |
| Fresh catalog, role posture, and generation lock | yes | yes |
| Trusted tenant/principal resolution | yes | yes |
| Exact reviewed identifiers and operations | yes | yes |
| Relationship, complexity, and response bounds | yes | yes |
| Read-only SQL compilation | yes | yes |
| Source data query | no | yes, after validation |
| Query/extraction/differencing accounting | no | yes |
| Cohort suppression and release accounting | no | yes |
| Evidence and query audit | no | yes |
| Source mutation | no | no |

## Troubleshooting

`EXPLORE_BOUNDARY_REQUIRED`
: The resource appears in more than one active boundary, or the selected
  boundary conflicts with the document. Choose one exact active boundary.

`EXPLORE_FIELD_FORBIDDEN` or `EXPLORE_RELATIONSHIP_FORBIDDEN`
: The plan names an operation or path that is not in the activated reviewed
  boundary. Use `explore describe --resource <exact-id>` and review access
  outside the playground. The playground cannot activate the offered path.

`EXPLORE_LOCK_STALE`
: Schema, role posture, version authority, or another generation dependency
  changed. Run the normal boundary rescan and human review flow.

`EXPLORE_PRIVACY_BUDGET_EXHAUSTED`
: The reviewed rolling query, extraction, differencing, or complementary
  release control refused the result. Reconnecting or changing the token does
  not bypass scope-keyed production accounting.

Remote token errors
: Confirm the token environment variable is set and that its issuer, audience,
  scope, tenant claim, principal claim, signature algorithm, and expiry match
  the production config. Never paste the token into a plan, config file, or
  shell command argument.
