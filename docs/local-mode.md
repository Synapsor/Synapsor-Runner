# Local mode

Local mode runs Synapsor Runner inside the developer or customer environment. No Synapsor Cloud account is required for local review flows.

Command model:

- `./scripts/demo-docker.sh` runs the no-install Docker demo.
- `synapsor <command>` is the public CLI surface.
- From a source checkout, use `./bin/synapsor <command>` if the global binary is
  not linked yet.

Current local-mode foundation:

- strict JSON capability config validation in `packages/config`;
- local SQLite proposal/event/evidence/query-audit/writeback/replay store in `packages/proposal-store`;
- local proposal review CLI in `apps/runner`;
- local localhost proposal review UI through `synapsor ui`;
- static MCP database risk review with `synapsor audit`;
- local stdio MCP server with semantic read/proposal tools;
- MCP resource reads for `synapsor://proposals/*`, `synapsor://evidence/*`, and `synapsor://replay/*`;
- local approved proposal to `synapsor.writeback-job.v1` job generation;
- guarded Postgres/MySQL writeback adapters for approved structured jobs.

Still pending:

- Public-release hardening around the experimental `node:sqlite` dependency.

## Initialize a config

Create a starter config without putting credentials in the file:

```bash
npx -y -p @synapsor/runner@alpha synapsor init --engine postgres --mode review
```

For MySQL:

```bash
npx -y -p @synapsor/runner@alpha synapsor init --engine mysql --mode review --output synapsor.mysql.runner.json
```

The generated config uses environment-variable names for read/write URLs and trusted context. Edit the table, column, and capability names before serving tools.

Do not include credential-bearing columns in reviewed visible fields or
evidence. The local store rejects obvious database URLs, bearer tokens, runner
tokens, private-key blocks, and secret-like field names before they can be
persisted into proposals, evidence, query audit, runner state, or replay.

For a reviewed own-database setup generated from explicit selections, use:

```bash
npx -y -p @synapsor/runner@alpha synapsor init --spec onboarding-selection.json --non-interactive
npx -y -p @synapsor/runner@alpha synapsor doctor --config synapsor.runner.json
```

`doctor --config` checks config validation, required environment variables,
read/write credential separation, metadata visibility for configured targets,
and the semantic MCP tool boundary without printing credential values.

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
npx -y -p @synapsor/runner@alpha synapsor proposals list --store ./.synapsor/local.db
```

Show a proposal:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals show wrp_123 --store ./.synapsor/local.db
```

Approve:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals approve wrp_123 \
  --store ./.synapsor/local.db \
  --actor local_reviewer \
  --yes
```

Before approval, the CLI prints the reviewer-critical proposal details: trusted principal, tenant, target row, primary key, required role, proposal hash/version, allowed columns, conflict guard, evidence bundle/query fingerprint, writeback boundary, source mutation state, and exact before/after diff. Interactive approval still requires typing `yes`; noninteractive scripts must pass `--yes`.

Create a guarded writeback job from an approved proposal:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals writeback-job wrp_123 \
  --store ./.synapsor/local.db \
  --project local \
  --runner local_runner \
  --output job.json
```

The generated job uses the public `synapsor.writeback-job.v1` protocol and can be applied by the guarded worker:

```bash
SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="postgresql://writer:<password>@localhost:5432/app" \
npx -y -p @synapsor/runner@alpha synapsor apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

Passing `--store` records the terminal `synapsor.execution-receipt.v1` locally. Replay then links the proposal, approval, writeback job, applied/conflict/failed receipt, evidence, and query audit.

Reject:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals reject wrp_123 \
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
npx -y -p @synapsor/runner@alpha synapsor ui --config synapsor.runner.json --store ./.synapsor/local.db
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
npx -y -p @synapsor/runner@alpha synapsor replay show wrp_123 --store ./.synapsor/local.db
```

Export replay:

```bash
npx -y -p @synapsor/runner@alpha synapsor replay export wrp_123 \
  --store ./.synapsor/local.db \
  --output replay.json
```

Replay records include proposal metadata, before/after diff, events, writeback receipts, evidence summaries, and query audit rows currently stored for the proposal.

## Boundary

Local mode does not expose `approve_proposal` or `commit_proposal` as model-callable MCP tools. The intended flow is:

```text
MCP tool call
  -> reviewed semantic proposal
  -> local store
  -> human/policy approval outside the model
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

It launches the official MCP stdio client transport against `synapsor mcp serve`, exercises the Postgres billing, Postgres support, and MySQL orders examples, checks that source rows are unchanged before approval, approves locally, generates versioned writeback jobs, applies them, retries idempotently, and then proves stale-row conflict:

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
