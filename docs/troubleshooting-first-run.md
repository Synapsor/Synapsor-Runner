# Troubleshooting First Run

Run the friendly doctor first:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --first-run
```

Use JSON for automation:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --first-run --json
```

## Fresh Start Did Not Enter Auto Boundary

Auto Boundary is the default only for a fresh interactive `start --from-env`
with no existing config, selector, answers file, machine-output flag, or other
automation input. This preserves every established 1.x route.

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
synapsor-runner mcp status cursor --project
```

The exact boundary digest must be active, the profile must explicitly be
`development` or `staging`, the generation lock and compiler/Spec versions
must be current, and the inspected database role must still be SELECT-only,
non-owner, non-superuser, and not `BYPASSRLS`. Runner also enforces a read-only
transaction for every Explore call.

A write-capable, owner, superuser, `BYPASSRLS`, or unverifiable credential may
still inspect metadata with a warning. It cannot enable source-row Explore.
Use a dedicated staging reader instead of weakening this check.

## Cursor Has Production Tools Instead Of Authoring Tools

Install the managed local authoring entry only after boundary activation:

```bash
synapsor-runner mcp install cursor \
  --project \
  --authoring \
  --project-root . \
  --yes
```

Authoring status reports exactly `app.describe_data` and `app.explore_data`.
After Protect and exact-digest activation, replace that entry with the
production config. The protected named capability remains available while
Explore disappears:

```bash
synapsor-runner mcp install cursor \
  --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

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
Workbench shows the reviewed minimum cohort, maximum groups, response limits,
and durable extraction/differencing budgets. You cannot widen them in a model
argument.

Use a larger legitimate cohort or protect a narrower reviewed question. Do not
work around suppression with repeated slightly different filters: Runner
records normalized redacted plan metadata and exhausts the differencing budget.
Returned rows/groups, trusted tenant/principal values, credentials, and raw
sensitive literals are not stored in the query audit.

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

## Activated Tool Does Not Appear In Cursor

Some MCP hosts do not refresh `tools/list` for a running stdio session. First
confirm that Runner's active tool surface changed:

```bash
synapsor-runner action status --json
synapsor-runner mcp status cursor --project --check-launch
```

Then reconnect or restart the project MCP server as directed by the Workbench.
Do not work around a stale host session by adding approval, apply, activation,
credentials, tenant values, or raw SQL to the Cursor configuration.

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
npx -y -p @synapsor/runner synapsor-runner init --from-env DATABASE_URL --mode review --wizard
```

Or pass an example config:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
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
npx -y -p @synapsor/runner synapsor-runner doctor --config synapsor.runner.json
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
npx -y -p @synapsor/runner synapsor-runner mcp config claude-desktop \
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
