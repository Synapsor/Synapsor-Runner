# Local mode

Local mode runs Synapsor Runner inside the developer or customer environment. No Synapsor Cloud account is required for local review flows.

Command model:

- `./scripts/demo-docker.sh` runs the no-install Docker demo.
- `synapsor <command>` is the public CLI surface.
- From a source checkout, use `./bin/synapsor-runner <command>` if the global binary is
  not linked yet.

`synapsor-runner demo --quick` creates a fixture ledger for learning and CLI
verification. In a terminal it walks through the safety model step by step; in
CI or piped output it prints a short summary and exits without waiting for
Enter. It does not read or write external Postgres/MySQL. Local mode with
`synapsor-runner mcp serve`, `synapsor-runner demo`, or an own generated config is the real
Postgres/MySQL path. Use `synapsor-runner demo inspect` to print the follow-up
commands for the quick-demo fixture.

Current local-mode foundation:

- strict JSON capability config validation in `packages/config`;
- local SQLite proposal/event/evidence/query-audit/writeback/replay store in `packages/proposal-store`;
- local proposal review CLI in `apps/runner`;
- local localhost proposal review UI through `synapsor-runner ui`;
- static MCP database risk review with `synapsor-runner audit`;
- local stdio MCP server with semantic read/proposal tools;
- authenticated HTTP MCP server for app/server agents;
- MCP resource reads for `synapsor://proposals/*`, `synapsor://evidence/*`, and `synapsor://replay/*`;
- local approved proposal to `synapsor.writeback-job.v1` job generation;
- guarded Postgres/MySQL writeback adapters for approved structured jobs.

Still pending:

The alpha package requires Node >= 22.5.0 because the local evidence/replay
ledger uses Node's `node:sqlite` runtime. The published package declares that
engine requirement and the CLI exits early with a clear message on older Node
versions. The Docker-backed demo remains the recommended path when you do not
want to change your host Node version.

## Initialize a config

Create a starter config without putting credentials in the file:

```bash
npx -y -p @synapsor/runner synapsor-runner init --engine postgres --mode review
```

For MySQL:

```bash
npx -y -p @synapsor/runner synapsor-runner init --engine mysql --mode review --output synapsor.mysql.runner.json
```

The generated config uses environment-variable names for read/write URLs and trusted context. Edit the table, column, and capability names before serving tools.

Do not include credential-bearing columns in reviewed visible fields or
evidence. The local store rejects obvious database URLs, bearer tokens, runner
tokens, private-key blocks, and secret-like field names before they can be
persisted into proposals, evidence, query audit, runner state, or replay.

For a reviewed own-database setup generated from explicit selections, use:

```bash
npx -y -p @synapsor/runner synapsor-runner init --spec onboarding-selection.json --non-interactive
npx -y -p @synapsor/runner synapsor-runner doctor --config synapsor.runner.json
```

`doctor --config` checks config validation, required environment variables,
read/write credential separation, metadata visibility for configured targets,
and the semantic MCP tool boundary without printing credential values.

## Stdio Vs HTTP MCP

Use stdio for local MCP clients that launch Synapsor Runner:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Use Streamable HTTP when your app/server agent connects through a standard HTTP
MCP client:

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Streamable HTTP defaults to `127.0.0.1:8766`, requires bearer auth by default,
and should run behind private networking/TLS before production-like exposure.
Use `synapsor-runner mcp serve-http` only when you explicitly want the smaller
JSON-RPC bridge. Details: [HTTP MCP](http-mcp.md).

## Local safety modes

The local runner modes are intentionally narrow:

- `read_only`: exposes read tools only; proposal tools fail closed.
- `shadow`: lets proposal tools create local proposals, evidence, query audit, and replay records, but approval and writeback-job creation are disabled.
- `review`: lets proposal tools create local proposals, then a human/operator can approve and create a guarded writeback job.
- `cloud`: delegates reviewed tools to Synapsor Cloud through a runner token.

Use `shadow` when you want to test the shape of proposals without any path to mutate the source database. Use `review` only when you are ready to exercise the trusted writeback worker.

## Store path

Commands use `--store` or `SYNAPSOR_LOCAL_STORE`.

```bash
export SYNAPSOR_LOCAL_STORE="./.synapsor/local.db"
```

If neither is set, the CLI uses:

```text
./.synapsor/local.db
```

## Proposal review

List proposals:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals list --store ./.synapsor/local.db
```

Show a proposal:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals show wrp_123 --store ./.synapsor/local.db
```

Approve:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals approve wrp_123 \
  --store ./.synapsor/local.db \
  --actor local_reviewer \
  --yes
```

Before approval, the CLI prints the reviewer-critical proposal details: trusted principal, tenant, target row, primary key, required role, proposal hash/version, allowed columns, conflict guard, evidence bundle/query fingerprint, writeback boundary, source mutation state, and exact before/after diff. Interactive approval still requires typing `yes`; noninteractive scripts must pass `--yes`.

Create a guarded writeback job from an approved proposal:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals writeback-job wrp_123 \
  --store ./.synapsor/local.db \
  --project local \
  --runner local_runner \
  --output job.json
```

The generated job uses the public `synapsor.writeback-job.v1` protocol and can be applied by the guarded worker:

```bash
export SYNAPSOR_DATABASE_WRITE_URL="postgresql://writer:<password>@localhost:5432/app"
SYNAPSOR_ENGINE=postgres \
npx -y -p @synapsor/runner synapsor-runner apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

When `--config` is passed, direct SQL writeback reads the writer connection from
the source `write_url_env` in that config. `SYNAPSOR_DATABASE_URL` is only a
legacy fallback for direct worker flows without a local runner config.

Passing `--store` records the terminal `synapsor.execution-receipt.v1` locally. Replay then links the proposal, approval, writeback job, applied/conflict/failed receipt, evidence, and query audit.

Reject:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals reject wrp_123 \
  --store ./.synapsor/local.db \
  --reason "policy evidence is incomplete" \
  --yes
```

`approve` and `reject` require either interactive confirmation or explicit `--yes`.

Approval records the approver against the exact proposal hash/version. The proposal patch is immutable after creation.

Shadow-mode proposals are inspectable through `proposals show` and `replay show`, but `proposals approve` and `proposals writeback-job` reject them. Shadow mode never mutates Postgres/MySQL.

## Browser review UI

Start a localhost-only review UI:

```bash
npx -y -p @synapsor/runner synapsor-runner ui --config synapsor.runner.json --store ./.synapsor/local.db
```

The UI shows setup summary, semantic tools, proposal states, exact diffs,
evidence, approval state, receipts, and replay. It binds to `127.0.0.1` by
default, uses a per-run local session token, and requires CSRF protection for
approve/reject actions.

The UI does not expose raw SQL, database URLs, password values, MCP approval
tools, MCP commit tools, or controls that widen configured tables/columns.

## Replay

Show replay:

```bash
npx -y -p @synapsor/runner synapsor-runner replay show wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner replay show --proposal wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner replay show --replay replay_wrp_123 --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner replay show --evidence ev_123 --store ./.synapsor/local.db
```

Export replay:

```bash
npx -y -p @synapsor/runner synapsor-runner replay export wrp_123 \
  --store ./.synapsor/local.db \
  --output replay.json

npx -y -p @synapsor/runner synapsor-runner replay export --proposal wrp_123 \
  --format markdown \
  --store ./.synapsor/local.db \
  --output replay.md
```

Replay records include proposal metadata, before/after diff, events, writeback receipts, evidence summaries, and query audit rows currently stored for the proposal.
Human output is concise by default. Use `--details` for reviewer metadata or
`--json` for complete machine-readable records.

## Local evidence, query audit, and receipts

The local SQLite store is also searchable without relying on `latest`:

```bash
synapsor-runner activity search \
  --tenant acme \
  --object invoice:INV-3001 \
  --store ./.synapsor/local.db

synapsor-runner evidence list \
  --tenant acme \
  --capability billing.inspect_invoice \
  --source app_postgres \
  --table invoices \
  --store ./.synapsor/local.db

synapsor-runner evidence show ev_123 --store ./.synapsor/local.db
synapsor-runner query-audit list --evidence ev_123 --store ./.synapsor/local.db
synapsor-runner receipts list --proposal wrp_123 --store ./.synapsor/local.db
synapsor-runner receipts show <receipt_id> --store ./.synapsor/local.db
```

Default inspection output is intentionally short. Add `--details` when you need
target URIs, primary keys, proposal hash/version, conflict guards, query
fingerprints, event timestamps, or receipt internals.

Read-only MCP tools record evidence bundles and query-audit rows and return an
evidence handle. Use `evidence show`, `evidence list`, and `query-audit list`
to inspect those captured rows and fingerprints later without rerunning the
external database read.

This is local indexed search over the runner's SQLite ledger. It is not
external Postgres/MySQL time travel, not native branching, and not a hosted
cross-runner audit ledger.

## Local store maintenance

The local ledger is a developer/staging SQLite file. You can inspect, compact,
or prune it without touching your source Postgres/MySQL database:

```bash
synapsor-runner store stats --store ./.synapsor/local.db
synapsor-runner events tail --store ./.synapsor/local.db
synapsor-runner events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/local.db
synapsor-runner store vacuum --store ./.synapsor/local.db
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --dry-run
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --yes
synapsor-runner store prune --store ./.synapsor/local.db --older-than 30d --yes --force
synapsor-runner store reset --store ./.synapsor/local.db --yes
```

`events tail` shows local lifecycle events already recorded in the SQLite
ledger, including proposal creation, approval/rejection, writeback jobs, and
writeback applied/conflict/failed receipts. Add `--follow` to keep polling a
running local store.

`events webhook` pushes the same local lifecycle events to a local/dev/staging
HTTP endpoint, one event envelope per POST. Use it for a review UI, Slack bridge,
or app-local notification path when polling is awkward. It is not a hosted
central ledger and does not expose database credentials.

`store prune` defaults to dry-run. `store reset` requires `--yes` and removes
only the local SQLite ledger files. MCP server modes write a small active-store
lease next to the SQLite file; destructive store operations refuse while that
lease points at a live PID unless you pass `--force` after verifying the server
is stopped or stale.

## Boundary

Local mode does not expose `approve_proposal` or `commit_proposal` as model-callable MCP tools. The intended flow is:

```text
MCP tool call
  -> reviewed semantic proposal
  -> local store
  -> human/operator approval outside the model
  -> guarded worker writeback
  -> terminal receipt
  -> replay
```

The external Postgres/MySQL database is not physically branched. It remains unchanged until a trusted runner applies an approved writeback job.

## Local MCP smoke

The repository includes a one-command Docker-only local demo:

```bash
./scripts/demo-docker.sh
```

This path requires Docker only. It builds the runner image locally, starts disposable Postgres/MySQL fixtures, runs the stdio MCP proof, and tears down the disposable resources. No Synapsor Cloud account, API key, hosted workspace, or host Node/Corepack setup is required.

If you already have Node/Corepack installed for contributor work, the direct wrapper is also available:

```bash
./scripts/demo-local.sh
corepack pnpm demo:local
```

The Docker-only script is also available through pnpm after dependencies are installed:

```bash
corepack pnpm demo:docker
```

The contributor script checks Docker/Corepack, installs dependencies if needed, starts disposable Postgres/MySQL containers, and runs the stdio MCP proof flow.

For CI or direct verification, use:

```bash
corepack pnpm test:mcp-local
```

It launches the official MCP stdio client transport against `synapsor-runner mcp serve`, exercises the Postgres billing, Postgres support, and MySQL orders examples, checks that source rows are unchanged before approval, approves locally, generates versioned writeback jobs, applies them, retries idempotently, and then proves stale-row conflict:

```text
The business state changed after the agent saw it, so Synapsor refused to commit.
```

## Optional MCP client configs

After the Docker demo passes, developers who want to attach an MCP client can use the checked-in stdio config shapes in:

```text
examples/mcp-client-configs/
```

Verify those config files without launching any client UI:

```bash
corepack pnpm test:mcp-client-configs
```

That command starts the runner through each config shape, calls MCP `tools/list`, and verifies that the server exposes semantic tools such as `billing.inspect_invoice` and `billing.propose_late_fee_waiver` without exposing raw SQL, approval, or commit tools. It verifies the stdio contract and config shape; it does not claim that a specific client application's UI was manually tested.
