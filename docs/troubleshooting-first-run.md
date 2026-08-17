# Troubleshooting First Run

Run the friendly doctor first:

```bash
npx -y @synapsor/runner doctor --first-run
```

Use JSON for automation:

```bash
npx -y @synapsor/runner doctor --first-run --json
```

## Guided Recovery Contract

Runner 1.7.x failures should tell you what failed, why the boundary stopped,
what state remains, and one next action. Do not delete the project or add
`--force` merely to recover.

| Failure | State preserved | One next action |
| --- | --- | --- |
| Database connection or metadata inspection failed | Existing project/review files and source rows | Fix the URL/network without printing the credential, then rerun `npx -y @synapsor/runner start`. |
| Read role is writable, owner, superuser, `BYPASSRLS`, or unverifiable | Disabled metadata draft; no source-row Explore | Supply a verifiably SELECT-only non-owner staging role, then rerun the same `start` command. |
| Schema or project choice is ambiguous | Existing files; no authority activation | Rerun with the exact reviewed schema, for example `npx -y @synapsor/runner start --schema public`. |
| Tenant or principal scope is unresolved | Conservative blocked resource decisions | In CLI, select the table and choose its database-inspected Record ID and Tenant isolation values; in Workbench, open **Resolve blocked access**. No signed key is needed for this interactive disabled-draft decision. |
| Sensitive field remains unresolved | Field stays kept out; active tools unchanged | Open Workbench **Exceptions** and record one reviewed field decision. |
| Row identifier is missing/composite/ambiguous | Resource remains blocked | Select a source-proven single-column primary/unique identity or keep the resource blocked. |
| Trusted context environment is missing | Boundary and ledger remain intact; query did not run | Export the named tenant/principal variable locally, then rerun the displayed Try action. |
| Generated output already exists | Existing files are not overwritten | Rerun the original `start` command and choose **Resume existing review**. A valid standalone `boundary draft` project resumes even without a guided-onboarding marker. |
| Generation lock is stale | Existing active named capability and review history | Run `synapsor-runner boundary rescan`, inspect the reconciliation report, then review and activate only the disabled changed revision. |
| Lone disabled legacy boundary has no current resource to reconcile | Config, local ledger/evidence, and source database | Run the exact displayed `boundary delete <name> --discard-curated-review --yes`, then run the displayed current-version draft command. This guarded reset refuses active or multi-boundary projects. |
| Config JSON is malformed | Config and source database are unchanged | Correct the reported file/line/column, then run `synapsor-runner config validate --config ./synapsor.runner.json --json`. |
| Config mode is missing/invalid | Config and source database are unchanged | Set `mode` to `read_only`, `shadow`, `review`, or `cloud`, then rerun `synapsor-runner config validate --json`. |
| Config contains an unknown field | Config and source database are unchanged | Remove or correct the reported JSON path, then rerun `synapsor-runner config validate --json`. |
| Workbench port is occupied | Review files, ledger, and source database | Rerun `synapsor-runner ui --open`; the default selects a free loopback port. |
| Workbench Ask is missing | Reviewed project remains usable through no-model Workbench/CLI/MCP | Use authenticated loopback Workbench with an explicit development/staging profile and at least one active reviewed tool. |
| Ask provider/key fails | Boundary, no-model composer, and external MCP remain usable | Check the exported key name, provider/model access, and local DNS/TLS; then retry without changing authority. |
| Ask says authority changed | Previous consent is invalid; active reviewed tools remain unchanged | Inspect the new tool/digest summary and acknowledge direct egress again. |
| Writeback setup fails | Config and reviewed plan; transactional setup rolls back | Rerun `synapsor-runner writeback setup --profile staging --json` and review the reported prerequisite. |
| Writer role/setup URL is missing | No DDL or grant was applied | Rerun the preview with `--writer-role <role> --setup-url-env <ADMIN_URL_ENV>`. |
| No supported write candidate exists | Read boundary remains active; no write authority | Use **Add a safe action** on a writable base table with a proven identity/version field, or retain read-only mode. |
| MCP client installation is unavailable | Project and reviewed authority; client config unchanged | Run `synapsor-runner mcp config --absolute-paths` and use the generic stdio snippet manually. |
| Supervised work remains queued | Approved proposal and queue state; source unchanged | Run `synapsor-runner worker status --json`, then follow its exact digest, posture, policy, freshness, limit, pause, or required-sink finding. |
| Required attention sink is unhealthy | Approved proposal remains queued; no source mutation | Repair the operator-owned sink, run `synapsor-runner notifications test --sink <id>`, then dispatch and let the worker revalidate from the beginning. |
| Notification delivery is dead-lettered | Authoritative event and proposal state are preserved | Repair/test the sink, then run `synapsor-runner notifications replay latest --yes --reason "sink repaired"` with the configured verified operator identity; this resends only the redacted event. |
| Apply outcome is UNKNOWN | Intent, receipt evidence, and queue state are preserved | Open the latest critical attention item and use the verified reconciliation flow; never rerun the mutation blindly. |

For machine output, a process-level failure emits one redacted JSON object to
stdout and diagnostics to stderr. `recovery.source_database_changed` is `null`
when a generic exception cannot establish an operation-specific mutation
outcome; inspect the durable receipt/reconciliation state rather than guessing.

## Fresh Start Did Not Enter Auto Boundary

Auto Boundary is the default only for a fresh interactive `start` with no
existing config, selector, answers file, machine-output flag, or other
automation input. An exported `DATABASE_URL` is implied; explicit connection
and schema flags still win. This preserves every established 1.x route.

Check the generated state:

```bash
synapsor-runner boundary status --json
```

To draft explicitly without prompts or a browser:

```bash
synapsor-runner boundary draft \
  --from-env DATABASE_URL \
  --schema public \
  --project-root . \
  --json
```

## Scoped Explore Is Not Advertised

This is correct unless all authoring prerequisites pass. Explore is disabled by
default and never appears in production, unknown-profile, shared HTTP, remote,
or non-loopback `tools/list`.

Check:

```bash
synapsor-runner boundary status --json
synapsor-runner boundary diff --json
synapsor-runner mcp status claude-code --project
```

Use `cursor` or `vscode` instead when that is the selected client.
The exact boundary digest must be active, the profile must explicitly be
`development` or `staging`, the generation lock and compiler/Spec versions
must be current, and the inspected database role must still be SELECT-only,
non-owner, non-superuser, and not `BYPASSRLS`. Runner also enforces a read-only
transaction for every Explore call.

A write-capable, owner, superuser, `BYPASSRLS`, or unverifiable credential may
still inspect metadata with a warning. It cannot enable source-row Explore.
Use a dedicated staging reader instead of weakening this check.

## Workbench Ask Is Missing Or Refused

Ask is optional and follows a stricter local profile boundary. It appears only
in authenticated loopback Workbench for explicit `development` or `staging`
projects with at least one reviewed tool. Production, unknown, shared, remote,
and non-loopback surfaces intentionally omit it.

Normal Runner and MCP execution do not automatically source `.env`. Fresh
interactive `start` may read a regular project `.env` only after explicit
consent and keeps the selected database URL in that process. For the optional
model provider, export the key in the same shell that launches Workbench, then
select **Read an environment variable** and enter only the variable name. A
session-only masked paste is also supported.

Provider errors are redacted and do not disable the no-model composer:

- `ASK_KEY_REQUIRED`: export the selected key or use the masked session paste;
- `ASK_AUTHORITY_CHANGED`: review the current tools/digest and acknowledge
  direct egress again;
- `ASK_PROVIDER_UNAVAILABLE`: verify provider availability, key/model access,
  and local DNS/TLS, then retry;
- `ASK_PROVIDER_HTTP_ERROR`: inspect the bounded structured provider detail.
  Runner removes common credentials and URLs before displaying a provider
  `400`; authentication, permission, and quota bodies remain hidden;
- `ASK_PROVIDER_REDIRECT_REFUSED`: use the final fixed endpoint; Runner never
  forwards credentials across redirects;
- `ASK_PROVIDER_DESTINATION_REFUSED`: the host resolved to a private, special,
  metadata, or otherwise disallowed remote address;
- `ASK_REMOTE_HTTPS_REQUIRED`: remote custom endpoints require HTTPS; HTTP is
  accepted only on loopback;
- `ASK_TOOL_REQUIRED`: the provider answered from prose without using a
  reviewed Synapsor tool;
- `ASK_UNKNOWN_TOOL` or `ASK_OPERATOR_TOOL_REFUSED`: the provider requested
  authority outside the displayed tool surface.

Select **Clear** after a session to cancel active work and discard in-memory
provider configuration/history. See [Workbench Ask With Your
Model](workbench-ask.md).

The same provider path is available without a browser:

```bash
synapsor-runner try ask --provider openai
```

Hosted providers have tested defaults: OpenAI uses `gpt-5-mini` and Anthropic
uses `claude-sonnet-4-20250514` when `--model` is omitted. Pass `--model` to
override either default. OpenAI-compatible endpoints require an explicit model
because Runner cannot infer what a local endpoint serves.

Official OpenAI calls use the Responses API at `/v1/responses`, including
native `function_call` and `function_call_output` turns; Runner explicitly
sets `store: false` on those requests. Official Anthropic
calls use the Messages API at `/v1/messages`, including native `tool_use` and
`tool_result` blocks. Custom OpenAI-compatible endpoints continue to use the
documented Chat Completions subset; choose that provider only when the endpoint
implements that protocol.

CLI Ask refuses provider keys on the command line. Use the conventional or an
explicitly named environment variable, or the hidden interactive prompt. While
Explore is active it receives exactly `app.describe_data` and
`app.explore_data`; named proposal/read tools are not mixed into that catalog.
This form opens the interactive shell. Add a quoted question before
`--provider` for one-shot mode. If no active reviewed authoring boundary exists,
the command tells you to run `synapsor-runner start`; it never falls back to
runtime proposal tools.

## A Project Client Has Production Tools Instead Of Authoring Tools

Install the managed local entry only after boundary activation. Runner detects
an active local Explore-only project automatically; the explicit form is:

```bash
synapsor-runner mcp install claude-code \
  --project \
  --authoring \
  --project-root . \
  --yes
```

Authoring status reports exactly `app.describe_data` and `app.explore_data`.
`mcp client-config` also emits this exact form. A pre-fix config/store-shaped
entry is accepted and routed to the same surface, while an inactive
Explore-only project now refuses with an activation remedy instead of exposing
zero tools.
After Protect and exact-digest activation, replace that entry with the
production config. The protected named capability remains available while
Explore disappears:

```bash
synapsor-runner mcp install claude-code \
  --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

Use `cursor` or `vscode` instead of `claude-code` for those clients.

## Boundary Became Stale After A Schema Or Grant Change

Generated authority is bound to the schema, role, grants, ownership, RLS
posture, compiler, and canonical Spec fingerprint:

```bash
synapsor-runner boundary diff --json
```

Additive fields receive no implicit authority. Breaking or posture drift fails
closed only for lock-bound generated authority. Regenerate, review the semantic
diff, and activate the new exact digest. Existing manually authored projects
without a generation lock retain their previous behavior.

## Aggregate Explore Suppressed Or Refused A Result

Suppression and budget failures are security behavior, not query failures.
Workbench shows the reviewed minimum group size, maximum groups, response limits,
and durable extraction/differencing budgets. You cannot widen them in a model
argument.

Runner distinguishes throughput from disclosure when a budget is exhausted.
Query volume and requests-per-minute limit work; extracted cells,
differencing, cohort, and suppression limit reconstruction. The refusal names
the class, used/limit count, and an upper bound for when the currently counted
rolling-window entries expire. In the CLI, use `/access`, select the boundary,
then `L Limits` to change a reviewed query/rate ceiling and `C` to review and
activate it. The same editor also exposes hard-capped result shape, statement
timeout, ranked candidates, and derived/analysis path depth. Workbench mirrors
them in **Query volume**, **Ranked result settings**, and **Result shape,
timeout, and path depth**. Do not raise a disclosure control merely to obtain
more request throughput; differencing, extracted-cell, cohort, and suppression
controls are not widened by these settings.

Every cohort-protected aggregate, including an unfiltered total or time trend,
uses the durable rolling 24-hour privacy pool for that reviewed source, trusted
scope, and root resource. Only an exact normalized-plan replay reuses a
differencing variant; changing filters, dates, measures, dimensions, time
grains, ordering, or limits does not open a new pool. Invalid plans and source
failures release extraction and differencing allowance. Runner also refuses a
complementary total/grouping pair that could reconstruct a suppressed
aggregate. Do not attempt to work around suppression with repeated variants.

Ordinary unranked results must fit `max_groups`. Ranked top/bottom and two-period
mover queries may use the separately reviewed `max_ranked_groups` candidate
ceiling. Runner checks that the complete candidate population fits, applies
small-group suppression, and only then ranks and returns `top_n`. Lowering
`top_n` cannot bypass either ceiling. If the relevant ceiling is exceeded,
reduce reviewed dimensions, narrow the date range, choose a coarser reviewed
time bucket, or have an operator review a narrower `max_ranked_groups` setting
appropriate to the known population.
Returned rows/groups, trusted tenant/principal values, credentials, and raw
sensitive literals are not stored in the query audit.

To change the minimum group size for one table in the terminal:

1. Type `/access`, select the boundary if the boundary list appears, and press
   Enter.
2. Highlight the affected table in the table list. Do not open its columns;
   press `P` for Privacy while the table remains highlighted.
3. Enter a **minimum group size** from 1 through 5 and a short reason. Runner
   hides groups with fewer rows than that number. Choosing 1 turns small-group
   suppression off and can reveal a group containing one person or record.
4. Press Enter at the default-Yes save prompt. This creates a disabled boundary
   revision only.
5. Press Enter again at `Review and activate this boundary change now? [Y/n]`.
   If you postpone activation, return to the boundary screen and press `C`
   (**Review + activate**).

Press `P` on the boundary screen, before opening a table, to apply one minimum
group size to all included tables atomically.

## Safe Action Draft Does Not Appear As A Tool

This is expected before activation. `start --action`, agent edits, `action
validate`, and `action watch` can create or refresh only a disabled draft. They
must not alter the active model-facing tools.

Check status without exposing credentials:

```bash
synapsor-runner action status --json
synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Open the secured Workbench, run the real source-unchanged staging Data PR
preview, review the complete digest, and activate it there. There is
intentionally no activation CLI command to hand to a coding agent.

## Activated Tool Does Not Appear In The MCP Client

Some MCP hosts do not refresh `tools/list` for a running stdio session. First
confirm that Runner's active tool surface changed:

```bash
synapsor-runner action status --json
synapsor-runner mcp status claude-code --project --check-launch
```

Use `cursor` or `vscode` instead of `claude-code` for those clients.
Then reconnect or restart the project MCP server as directed by the Workbench.
Do not work around a stale host session by adding approval, apply, activation,
credentials, tenant values, or raw SQL to the client configuration.

## Safe Action Validation Reports Review Placeholders

The composer fails closed while any `__REVIEW_*__` authority placeholder or
dynamic TypeScript expression remains. Review the reported field and source,
then make the authority explicit in the restricted `defineCapability({...})`
object. Runner will not infer trusted tenant/principal bindings, hidden fields,
write columns, bounds, conflict guards, approval, or executor authority from
application code.

Use the generated explanation and test manifest after validation. Do not edit
digest-addressed files under `.synapsor/drafts/` or `.synapsor/active/`; edit
the TypeScript source and validate again.

## Smoke Proposal Missing From Another Runner

What happened:

`smoke call` returned a proposal id, but `proposals list --config ...` on a
second Runner cannot find it.

Fix:

1. Verify `synapsor-runner --version` is `1.4.12` or later.
2. Confirm both commands use a config whose
   `storage.shared_postgres.mode` is `runtime_store` and whose `url_env` and
   `schema` identify the same ledger.
3. Run `store shared-postgres status --url-env <ENV> --schema <SCHEMA>`.

In `runtime_store` mode, `--store` is not the authoritative ledger. Runner does
not fall back to that SQLite path when shared Postgres is unavailable. Versions
before `1.4.12` could orphan smoke-call artifacts locally; recreate that test
proposal after upgrading.

## Docker Missing

What happened:

```text
Docker CLI is missing.
```

Why it matters:

The first-run demo starts disposable Postgres/MySQL containers.

Fix:

Install Docker Desktop or Docker Engine, then rerun:

```bash
./scripts/try-synapsor.sh
```

## Docker Daemon Stopped

What happened:

```text
Docker daemon is not reachable.
```

Why it matters:

The demo cannot start disposable databases without the daemon.

Fix:

Start Docker Desktop or the Docker service, then rerun:

```bash
./scripts/try-synapsor.sh
```

If the doctor reports Docker socket permission problems, add your user to the
Docker group or start Docker Desktop.

## Port Conflict

What happened:

```text
Port 55433 is already in use.
```

Why it matters:

The fixtures bind predictable local ports.

Fix:

```bash
./scripts/try-synapsor.sh --reset
```

If another application owns the port, stop that application and rerun.

## Stale Containers

What happened:

Doctor reports stale Synapsor demo containers.

Why it matters:

Old containers can hold ports or stale fixture state.

Fix:

```bash
./scripts/try-synapsor.sh --reset
```

## Missing Source Dependencies

What happened:

```text
Dependencies are not installed yet.
```

Why it matters:

Source checkout commands such as `synapsor ...` need workspace
dependencies.

Fix:

```bash
corepack enable
corepack pnpm install
```

The Docker-only first-run demo does not require host Node dependencies.

## Config Missing

What happened:

```text
Runner config not found at synapsor.runner.json.
```

Why it matters:

Own-database MCP setup needs a reviewed config before serving tools.

Fix:

```bash
npx -y @synapsor/runner init --from-env DATABASE_URL --mode review --wizard
```

Or pass an example config:

```bash
npx -y @synapsor/runner tools preview --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
```

## SQLite Store Missing

What happened:

```text
SQLite local store not found at ./.synapsor/local.db.
```

Why it matters:

The local UI and replay read proposal/evidence state from the store.

Fix:

Run a demo or create a proposal first:

```bash
./scripts/try-synapsor.sh
```

or:

```bash
corepack pnpm demo:reference
```

## DB URL Env Var Missing

What happened:

```text
SYNAPSOR_DATABASE_READ_URL is not set.
```

Why it matters:

Configured capabilities need a read credential to inspect/propose against your
database.

Fix:

```bash
export SYNAPSOR_DATABASE_READ_URL="<read-only-url>"
npx -y @synapsor/runner doctor --config synapsor.runner.json
```

## Read/Write Credential Split Failed

What happened:

```text
Read and write env vars resolve to the same credential.
```

Why it matters:

Read/proposal authority and writeback authority must be separated.

Fix:

Use a read-only credential for MCP reads and a separate writer credential only
for trusted apply.

## Freshness Check Is Stale

What happened:

```text
Freshness: stale
code: FRESHNESS_TARGET_STALE
```

or:

```text
code: FRESHNESS_DEPENDENCY_STALE
```

Why it matters:

The proposal target or one explicitly declared supporting row no longer has
the exact version captured by the immutable proposal. Runner records no
approval and never updates the old proposal to match current data.

Fix:

Perform a new reviewed source read and create a new proposal. Do not retry
approval on the stale proposal or edit its stored JSON.

## Freshness Check Is Unavailable

What happened:

```text
Freshness: unavailable
code: FRESHNESS_TEMPORARILY_UNAVAILABLE
```

Why it matters:

Runner could not prove current source state. Unavailability is not treated as
fresh, and no approval was recorded.

Fix:

Restore the read connection or resolve the transient database/pool issue, then
retry:

```bash
synapsor-runner proposals check-freshness latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

## Freshness Writer Lock Probe Failed

What happened:

`doctor --check-writeback` reports that the writer cannot lock a declared
supporting dependency.

Why it matters:

Approval-time reads alone cannot provide the final atomic guarantee. The direct
SQL adapter must lock and compare every dependency inside the mutation
transaction.

Fix:

Grant only the narrow table/column privilege required for the writer's
`SELECT ... FOR UPDATE` locking read, then rerun:

```bash
synapsor-runner doctor --check-writeback --config ./synapsor.runner.json
```

Do not replace this with an overprivileged owner/superuser role. See
[Proposal And Evidence Freshness](proposal-evidence-freshness.md).

## MCP Client Config Contains A Secret

What happened:

Doctor reports a generated MCP client config appears to contain a database URL,
password, or token.

Why it matters:

MCP clients must receive only the local runner command and args.

Fix:

Regenerate the snippet:

```bash
synapsor-runner mcp config claude-desktop \
  --absolute-paths \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Keep database URLs in environment variables, not client JSON.

## Demo Did Not Prove The Boundary

What happened:

```text
Demo did not prove the Synapsor boundary.
```

Why it matters:

The first-run demo must prove semantic tools, proposal creation, source row
unchanged, approval outside MCP, guarded writeback/conflict, replay, and no
secret leakage.

Fix:

Inspect the printed log path, then reset:

```bash
./scripts/try-synapsor.sh --reset
./scripts/try-synapsor.sh
```
