# Synapsor Runner

Open-source commit-safe MCP runtime for Postgres and MySQL.

Replace raw database MCP tools with reviewed business capabilities, proposal
diffs, local approvals, and guarded commits. Synapsor Runner lets an MCP agent
request a database change without receiving raw SQL or write credentials.

Without Synapsor:

```text
Connect agent to database.
Give it a tool.
Hope it behaves.
```

With Synapsor:

```text
Expose reviewed business capabilities.
Turn risky writes into exact proposals.
Commit only through guarded execution.
```

Run the Docker demo:

```bash
./scripts/demo-docker.sh
```

No Synapsor Cloud account, API key, hosted workspace, or host Node setup is
required.

Run the local demo and you should see the important moment:

```text
The business state changed after the agent saw it, so Synapsor refused to commit.
```

The concrete shape looks like this:

```diff
invoice.late_fee_cents
- 5500
+ 0

Source DB changed: No
Approval: Required
Conflict guard: updated_at
```

That is the point of this repo. It shows how an MCP agent can request a
database change without receiving raw SQL or write credentials, and how
Synapsor turns that request into a reviewable, conflict-checked business
state transition.

This is not just a demo repo. The examples are demos, but the CLI, MCP server,
proposal store, adapters, and guarded runner are intended to be usable locally.

MCP connects the agent. Synapsor Runner controls whether the requested database
change can become durable business state.

> Alpha: v0.1 supports guarded single-row `UPDATE` jobs only. It is not HA, not a self-hosted Synapsor Cloud, not exactly-once across networks, and not a compliance certification.

## What This Repo Is

This is a local-first MCP and database safety runtime. Think of it as the
smallest local version of Synapsor's trust workflow, not a miniature database
engine.

It gives a developer a way to run this loop on their own machine:

```text
MCP client
  -> semantic business tool
  -> trusted tenant/principal context
  -> scoped read from Postgres/MySQL
  -> evidence and exact proposal diff
  -> local approval outside the model
  -> guarded single-row writeback
  -> applied/conflict/failed receipt
  -> local replay
```

The runner does not replace Postgres or MySQL. Your database remains the source
of truth. The runner controls whether an agent-requested change is safe enough
to apply.

## Why A Developer Would Use It

Use this repo when you want to answer:

- Can I expose database actions to an MCP agent without `execute_sql`?
- Can I keep database credentials local?
- Can the model propose a change without committing it?
- Can a reviewer see the exact before/after diff first?
- Can stale rows fail as conflicts instead of silent overwrites?
- Can I inspect evidence, approvals, receipts, and replay afterward?
- Can I test all of that locally before using Synapsor Cloud?

The answer demonstrated here is yes.

## The 90-Second Demo

Run the full local MCP demo with Docker only:

```bash
./scripts/demo-docker.sh
```

Or use the contributor wrapper if you already have Node/Corepack installed:

```bash
./scripts/demo-local.sh
```

Or through pnpm:

```bash
corepack pnpm demo:docker
corepack pnpm demo:local
```

The host prerequisites for `./scripts/demo-docker.sh` are Docker and a reachable Docker daemon. You do not need a Synapsor Cloud account, an API key, a hosted workspace, or host Node/Corepack setup.

The demo starts disposable Postgres and MySQL containers, launches the local
stdio MCP server, and proves:

- MCP `tools/list` exposes semantic tools only, not `execute_sql`.
- Reads are tenant-scoped and evidence-backed.
- Proposal tools return exact before/after diffs.
- The source row is unchanged after proposal creation.
- Approval happens outside the model-facing MCP tool surface.
- The runner applies only a structured, approved, single-row writeback job.
- The writeback checks primary key, tenant scope, allowed columns, row version,
  idempotency, and affected row count.
- Retrying the same approved job is idempotent.
- A stale row returns `conflict` with no write.
- Replay can explain the proposal, approval, receipt, evidence, and query audit.

## What The Model Sees

The model gets narrow business tools like:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
support.inspect_ticket
support.propose_ticket_resolution
orders.inspect_order
orders.propose_refund_review
```

The model does not get:

```text
execute_sql
approve_proposal
commit_proposal
database_url
write_credentials
tenant_id as model-controlled authority
arbitrary table or column names
```

MCP connects the agent. Synapsor Runner controls whether the requested database
change can become durable business state.

## What Is Local Versus Cloud

Local mode is the no-account mini trust loop:

- local MCP server
- local SQLite proposal/evidence/replay store
- local CLI approval
- local guarded Postgres/MySQL writeback
- local receipts and replay export

Synapsor Cloud is the team/shared control plane:

- reviewed adapter and capability catalog
- RBAC and team approvals
- hosted evidence and replay search
- managed proposal state
- runner fleet status
- writeback job leases
- retention and audit visibility

The same boundary applies in both modes: the model proposes; the trusted runner
executes only after approval.

## What This Is Not

This repo is intentionally narrow. It is not:

- a self-hosted Synapsor Cloud;
- the Synapsor C++ DBMS;
- a physical branch engine for Postgres/MySQL;
- a generic MCP security platform;
- a claim that prompt injection is solved;
- a framework for arbitrary SQL, DDL, INSERT, DELETE, UPSERT, or multi-row writes.

It demonstrates Synapsor's database commit-safety boundary locally.

## Current Capabilities

- Keeps database credentials local.
- Gives MCP agents semantic capability tools instead of raw SQL tools.
- Supports local read-only, shadow, review, and Cloud-linked modes.
- Stores local proposals, evidence, query audit, writeback receipts, and replay
  in SQLite.
- Rejects arbitrary SQL and model-generated SQL.
- Validates primary key, tenant guard, allowed patch columns, idempotency key,
  and version-column conflict guard.
- Builds parameterized SQL inside the Postgres/MySQL adapter.
- Applies exactly one row inside a transaction.
- Stores an idempotency receipt in the target database.
- Reports `applied`, `conflict`, `already_applied`, or `failed`.
- Includes `synapsor mcp audit <target>` for a static MCP database risk review.

## Local Modes

Local modes are explicit:

- `read_only`: exposes reads only.
- `shadow`: records proposals, evidence, and replay without approval or writeback.
- `review`: enables local approval plus guarded writeback.
- `cloud`: delegates reviewed tools and approval state to Synapsor Cloud while
  keeping the write credential local.

## Manual Checks

Manual lower-level checks are also available.

Validate fixture jobs without a Synapsor Cloud account:

```bash
corepack pnpm install
corepack pnpm runner validate --job examples/postgres-support/job.approved.json
corepack pnpm runner validate --job examples/mysql-orders/job.approved.json
```

Dry-run the same jobs without writing business rows:

```bash
corepack pnpm runner apply --job examples/postgres-support/job.approved.json --dry-run
corepack pnpm runner apply --job examples/mysql-orders/job.approved.json --dry-run
```

Run the Docker-backed local examples end to end:

```bash
corepack pnpm test:docker
```

This starts the Postgres and MySQL fixtures, applies one approved guarded update, retries idempotently, verifies stale-version conflict, verifies tenant mismatch rejection, verifies disallowed-column validation, and tears the containers down with volumes.

Run the stdio MCP local proof:

```bash
corepack pnpm test:mcp-local
```

This starts disposable Postgres/MySQL databases, launches the local MCP server through the official stdio client transport, lists semantic tools, calls inspect/proposal tools, confirms source rows are unchanged before approval, approves locally, generates `synapsor.writeback-job.v1` jobs, applies them through the guarded worker, retries idempotently, then simulates stale rows and returns conflict with no write.

Run the hosted-compatible Cloud-linked proof:

```bash
corepack pnpm test:mcp-cloud-linked
```

This starts the disposable Postgres billing fixture, registers a runner against a mock Synapsor Cloud API, serves MCP in `mode: "cloud"`, fetches the Cloud adapter tool catalog, calls the proposal tool through the Cloud adapter API, confirms the source row is unchanged before approval, claims an approved writeback job, applies it through the real guarded Postgres adapter, and submits the terminal receipt back to the mock Cloud API without sending database credentials to Cloud.

## Cloud-Linked Runner

Run doctor against a configured Cloud source and local database:

```bash
cp .env.example .env
corepack pnpm runner doctor
```

`doctor` verifies the runner token against Synapsor, confirms source-scoped writeback permissions, checks database engine/version, creates or verifies the receipt table, and performs a rollback-only receipt insert to confirm write permission without touching business rows.

Start polling Synapsor:

```bash
synapsor runner start
```

From this repository, the equivalent shorthand is:

```bash
corepack pnpm runner start
```

Validate a Cloud-linked runner config without printing secrets:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
synapsor cloud connect --config ./synapsor.cloud.json
```

`cloud connect` verifies the scoped token, registers runner metadata, and sends an initial heartbeat. It does not upload database URLs, passwords, write credentials, prompts, or table data. The local Docker demo above remains the primary no-account path.

Verify a real hosted Cloud-linked adapter/tool path after you have a compatible Cloud workspace, source, adapter, and scoped runner token:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
SYNAPSOR_SOURCE_ID="src_..." \
SYNAPSOR_ADAPTER_ID="mcp.billing" \
SYNAPSOR_MCP_TOOL_NAME="billing.propose_late_fee_waiver" \
SYNAPSOR_MCP_TOOL_INPUT_JSON='{"invoice_id":"INV-3001","reason":"support-approved waiver"}' \
corepack pnpm verify:hosted-cloud-linked
```

That command checks runner-token auth, runner registration, heartbeat, adapter `tools/list`, semantic tool invocation, proposal/evidence/replay linkage, and that the tool response does not report source mutation before trusted writeback. It never creates runner tokens and never prints token values. To claim and apply one already approved writeback job through the guarded local adapter, add `SYNAPSOR_HOSTED_E2E_APPLY_JOB=1`, `SYNAPSOR_ENGINE=postgres|mysql`, and `SYNAPSOR_DATABASE_URL` for the trusted worker credential.

## Static MCP Risk Review

Audit an exported MCP tool manifest without calling business tools:

```bash
corepack pnpm runner mcp audit ./tools-list.json
corepack pnpm runner mcp audit ./tools-list.json --json
corepack pnpm runner mcp audit https://mcp.example.com --bearer-env MCP_AUDIT_TOKEN --json
corepack pnpm runner mcp audit 'stdio:node ./server.mjs' --timeout-ms 5000
```

The audit always includes:

```text
This is a static risk review, not proof that an MCP server is secure.
```

See `docs/mcp-audit.md`.

## Serve Your Own Local Capability

Serve reviewed local capabilities over stdio MCP:

```bash
synapsor init --engine postgres --mode review
synapsor mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The MCP server exposes configured semantic tools only. It does not expose `execute_sql`, generic query tools, approval tools, or commit tools. Read tools return evidence handles. Proposal tools create exact local proposals and leave the source database unchanged.

Review local proposals from the SQLite store:

```bash
corepack pnpm runner proposals list --store ./.synapsor/local.db
corepack pnpm runner proposals show wrp_123 --store ./.synapsor/local.db
corepack pnpm runner proposals approve wrp_123 --store ./.synapsor/local.db --actor local_reviewer --yes
corepack pnpm runner proposals reject wrp_123 --store ./.synapsor/local.db --reason "needs review" --yes
corepack pnpm runner replay show wrp_123 --store ./.synapsor/local.db
corepack pnpm runner replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

`approve` and `reject` require interactive confirmation or explicit `--yes` for noninteractive scripts.

When applying a locally generated job, pass the same store path to attach the terminal execution receipt to replay:

```bash
corepack pnpm runner apply --job job.json --store ./.synapsor/local.db
corepack pnpm runner replay export wrp_123 --store ./.synapsor/local.db --output replay.json
```

## Repository layout

- `schemas`: public JSON Schemas for change sets, writeback jobs, execution receipts, and runner registration.
- `fixtures/protocol`: versioned protocol fixtures shared with the main Synapsor repository.
- `packages/config`: strict local capability config validation.
- `packages/protocol`: Zod schemas and normalization for public/legacy job and receipt validation.
- `packages/proposal-store`: SQLite local proposal/event/approval/receipt store.
- `packages/control-plane-client`: runner registration, heartbeat, adapter catalog/call, writeback claim, lease renewal, and result HTTP client.
- `packages/worker-core`: shared config, redaction, validation, polling, and apply orchestration.
- `packages/postgres`: Postgres adapter and receipt migration.
- `packages/mysql`: MySQL adapter and receipt migration.
- `apps/runner`: CLI entrypoint.
- `docs/capability-config.md`: reviewed local capability config shape and validation rules.
- `docs/cloud-mode.md`: Cloud-linked runner mode, token scope, and metadata boundary.
- `docs/limitations.md`: explicit v0.1 limits and non-claims.
- `docs/local-mode.md`: local store, proposal review, and replay commands.
- `docs/mcp-audit.md`: static MCP database risk review command.
- `docs/mcp-client-setup.md`: stdio MCP client setup patterns.
- `examples/postgres-support`: local Postgres ticket fixture.
- `examples/mysql-orders`: local MySQL order fixture.
- `examples/mcp-postgres-billing`: stdio MCP billing fixture with source-unchanged, approval, idempotency, and stale-row conflict proof.
- `examples/mcp-postgres-support`: stdio MCP support-ticket fixture.
- `examples/mcp-mysql-orders`: stdio MCP MySQL order fixture.

## Security boundary

Synapsor Cloud stores proposals, evidence, approval state, job leases, and replay records. The runner stores the write credential in your environment. Jobs never include database URLs, passwords, arbitrary SQL, prompts, or model confidence. The runner accepts a structured patch and builds parameterized SQL itself.

MCP tool call equals request/proposal authority. Trusted runner equals execution authority.

The runner does not make MCP generally secure. It protects the Synapsor database path by avoiding model-facing raw SQL, binding trusted scope outside model arguments, enforcing allowlisted targets/columns, checking stale rows, and recording terminal receipts.

## Remote setup later

When Supsmall Inc. is ready to publish the repo, create the remote and push:

```bash
git remote add origin https://github.com/<owner>/synapsor-runner.git
git push -u origin main
```
