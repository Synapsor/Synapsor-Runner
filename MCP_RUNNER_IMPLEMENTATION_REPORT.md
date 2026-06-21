# MCP Runner Implementation Report

## Current Completion Addendum - 2026-06-21

This addendum supersedes earlier hosted-verifier notes in this report.

- Current runner repo branch: `mcp-commit-safe-runtime`
- Runner implementation commit before this report-only addendum: `c6ba7ffe60a8b9acd87ad29801e099f1dda46c7a`
- Hosted verifier command:

```bash
set -a
source "/home/sandesh-tiwari/Desktop/C++/Synapsor Production Grade/mcp_billing_demo_cloud.env"
set +a
corepack pnpm --dir /home/sandesh-tiwari/Desktop/C++/synapsor-runner verify:hosted-cloud-linked
```

Hosted Cloud-linked verification has now run successfully against `https://synapsor.ai`:

```json
{
  "base_url": "https://synapsor.ai",
  "source_id": "src_2a431fc6b8f4fe3a",
  "adapter_id": "mcp.billing",
  "tool_name": "billing.propose_late_fee_waiver",
  "runner_id": "synapsor-hosted-cloud-e2e",
  "doctor": "ok",
  "registered": true,
  "heartbeat": true,
  "tools_listed": 1,
  "generic_sql_tool_exposed": false,
  "tool_call": "ok",
  "proposal_linked": true,
  "evidence_linked": true,
  "replay_linked": true,
  "source_database_mutated_before_approval": false,
  "writeback_applied": false
}
```

The runner successfully authenticated with a scoped runner token, registered, heartbeated, listed the Cloud adapter catalog, invoked the semantic tool, verified proposal/evidence/replay linkage, verified no generic SQL tool exposure, and confirmed the source database was not mutated before approval.

## Branch And Commit

- Branch: `mcp-commit-safe-runtime`
- Implementation commit: `c4e6cd95ea6316ed880a0e803aa29ecc18338299`
- MCP audit parity commit: `64287070d7b7393a9d1b1b0718409f67c7494ef0`
- Report/docs parity commit: `fae1a17d9a80c6fbf8b8c7e603fa0f9244897379`
- Cloud-linked smoke commit: `e422e5c27853e9d97faf692809e67939037f744b`
- Hosted Cloud-linked verifier commit: `8eec9d6f14dc6ff52a76f81cf671ba108b4f0923`
- Runner implementation commit before this report-only addendum: `c6ba7ffe60a8b9acd87ad29801e099f1dda46c7a`

## Architecture Implemented

Synapsor Runner is now a local-first MCP and database safety runtime for Postgres and MySQL. The implemented boundary is:

```text
MCP tool call
  -> reviewed semantic capability
  -> trusted context
  -> scoped source read
  -> evidence and exact diff
  -> local proposal
  -> approval outside model tools
  -> guarded writeback job
  -> applied / conflict / failed receipt
  -> replay export
```

The runner exposes semantic MCP tools, not `execute_sql`. Local mode requires no Synapsor Cloud account. Cloud-linked mode can delegate adapter catalog/call behavior to Synapsor Cloud and can claim/report approved writeback jobs through a scoped runner token.

## Main Paths Changed

- `packages/mcp-server/`: stdio MCP server, local runtime, tool catalog, tool calls, and resources.
- `packages/config/`: strict capability config validation, local modes, and Cloud config validation.
- `packages/proposal-store/`: local SQLite proposal/event/evidence/query-audit/writeback/replay store.
- `packages/protocol/`: public protocol validation and golden fixture checks.
- `packages/control-plane-client/`: runner registration, heartbeat, adapter catalog/call, writeback lease/result client.
- `packages/postgres/`, `packages/mysql/`: guarded writeback validation for allowed columns, tenant scope, primary key, idempotency, and conflict guards.
- `apps/runner/src/cli.ts`: init, MCP serve, proposal review, writeback job generation, replay export, Cloud connect, and MCP audit command surfaces.
- `apps/runner/src/cli.test.ts`, `docs/mcp-audit.md`, `README.md`: MCP audit coverage and documentation for local manifest, remote `tools/list`, and stdio MCP targets.
- `examples/mcp-postgres-billing/`, `examples/mcp-postgres-support/`, `examples/mcp-mysql-orders/`: disposable local MCP examples.
- `scripts/demo-docker.sh`: one-command Docker-only local demo.
- `scripts/smoke-mcp-cloud-linked.mjs`: hosted-compatible Cloud-linked smoke with mock Cloud API plus real guarded Postgres writeback.
- `scripts/demo-local.sh`, `scripts/smoke-mcp-local-examples.mjs`, `scripts/verify-mcp-client-configs.mjs`: contributor smoke and MCP client config verification.
- `README.md`, `SECURITY.md`, `THREAT_MODEL.md`, `docs/local-mode.md`, `docs/cloud-mode.md`, `docs/mcp-client-setup.md`, `docs/limitations.md`: public docs and security boundary.

## Migrations

- No production database migrations.
- Local SQLite proposal-store migrations are created by the runner store layer.
- Example Postgres/MySQL fixtures create disposable local users, tables, and seed data only inside demo containers.

## Public Protocol Version

Implemented and fixture-backed protocol objects:

- `synapsor.change-set.v1`
- `synapsor.writeback-job.v1`
- `synapsor.execution-receipt.v1`
- `synapsor.runner-registration.v1`

Golden fixture checks are tracked in `fixtures/protocol/MANIFEST.json`.

## Commands To Run

Primary no-account local path:

```bash
./scripts/demo-docker.sh
```

Contributor path:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm test:mcp-local
corepack pnpm test:mcp-cloud-linked
corepack pnpm test:mcp-client-configs
```

Cloud-linked validation after obtaining a scoped runner token:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
corepack pnpm runner cloud connect --config ./synapsor.cloud.json
```

Hosted Cloud-linked E2E verifier after obtaining a compatible Cloud workspace/source/adapter/scoped runner token:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
SYNAPSOR_SOURCE_ID="src_..." \
SYNAPSOR_ADAPTER_ID="mcp.billing" \
SYNAPSOR_MCP_TOOL_NAME="billing.propose_late_fee_waiver" \
SYNAPSOR_MCP_TOOL_INPUT_JSON='{"invoice_id":"INV-3001","reason":"support-approved waiver"}' \
corepack pnpm verify:hosted-cloud-linked
```

To include guarded local writeback for one already approved job, add `SYNAPSOR_HOSTED_E2E_APPLY_JOB=1`, `SYNAPSOR_ENGINE=postgres|mysql`, and `SYNAPSOR_DATABASE_URL` for the trusted worker credential.

## Tests Executed

- `corepack pnpm test`
  - Passed: 9 files / 52 tests.
- `corepack pnpm test:mcp-local`
  - Passed for Postgres billing, Postgres support, and MySQL orders.
  - Covered semantic tool listing/calls, tenant spoof rejection, source unchanged before approval, disallowed-column job rejection, guarded writeback, idempotent retry, stale-row conflict, and replay export.
- `corepack pnpm test:mcp-cloud-linked`
  - Passed.
  - Covered runner-token doctor, runner registration, runner heartbeat, Cloud-mode MCP `tools/list`, Cloud adapter tool call, trusted session binding, source unchanged before approval, approved job claim/lease, real guarded Postgres writeback, and terminal receipt submission back to the Cloud API surface.
- `corepack pnpm test:mcp-client-configs`
  - Passed for `generic-stdio.json`, `claude-desktop.json`, `cursor.json`, and `vscode.json`.
  - Verified checked-in client configs are parseable, secret-free, and expose semantic tools only.
- `git diff --check`
  - Passed after MCP audit parity changes.
- `./scripts/demo-docker.sh`
  - Passed as the exact Docker-only first-run path.
  - Built the local runner image, ran the TypeScript runner inside Docker, started disposable Postgres/MySQL containers, and tore down resources.
- `corepack pnpm verify:hosted-cloud-linked -- --help`
  - Passed. The command typechecks the runner and prints the real-hosted Cloud-linked verification contract without requiring or printing secrets.
- Hosted Cloud non-mutating preflight:
  - `curl https://synapsor.ai/health` returned HTTP 200 with `status: ok`, `service: synapsor-cloud-gateway`, and `runtime_url_configured: true`.
  - `curl https://synapsor.ai/openapi.json` returned HTTP 200 and exposed the runner/writeback/adapter routes required by the hosted verifier, including `/v1/writeback/runner/doctor`, `/v1/runner/register`, `/v1/runner/heartbeat`, `/v1/agent/adapters/tools`, `/v1/agent/adapters/call-tool`, and `/v1/writeback/jobs/claim`.
  - The main repo `.env` did not contain `SYNAPSOR_RUNNER_TOKEN`, `SYNAPSOR_SOURCE_ID`, `SYNAPSOR_ADAPTER_ID`, `SYNAPSOR_MCP_TOOL_NAME`, or `SYNAPSOR_MCP_TOOL_INPUT_JSON`, so the mutating/credentialed hosted verifier was not run.
- Hosted Cloud-linked verifier:
  - `corepack pnpm --dir /home/sandesh-tiwari/Desktop/C++/synapsor-runner verify:hosted-cloud-linked`
  - Passed using the private environment file outside git.
  - Confirmed runner token doctor, registration, heartbeat, Cloud `tools/list`, semantic tool invocation, proposal/evidence linkage, generic SQL blocking, and no source mutation before approval.

`synapsor mcp audit <target>` now supports:

- local exported tool manifests / `tools/list` JSON;
- remote HTTP MCP `tools/list` endpoints with optional `--bearer-env`;
- stdio MCP servers through a JSON-RPC `initialize` and `tools/list` exchange.

The audit still does not call business tools, approval tools, commit tools, or writeback tools.

No demo containers or generated `.pnpm-store` cache remain after verification.

## Screenshots

No browser screenshots were required for this runner-only repo. The user-facing proof is CLI/Docker output and docs.

## Security Decisions

- MCP tools are semantic capability tools only; no generic raw SQL tool is exposed.
- Approval and commit/writeback are not model-callable MCP tools.
- Trusted tenant/principal/source scope comes from config or Cloud runner-token scope, not model arguments.
- Writeback jobs contain structured patches, not database URLs, passwords, arbitrary SQL, prompts, or model confidence.
- Postgres/MySQL adapters build parameterized single-row updates and validate allowed columns, primary key, tenant guard, conflict guard, idempotency key, and affected-row count.
- Receipts redact secrets and record terminal state as `applied`, `conflict`, `already_applied`, or `failed`.
- The runner does not claim to secure all MCP, fix prompt injection, protect a compromised MCP host, or provide HA/compliance certification.

## Known Limitations

- v0.1 supports guarded single-row `UPDATE` writeback only.
- Local approval is CLI-based; optional localhost approval UI remains follow-up.
- Hosted Cloud-linked E2E now passes for runner doctor, registration, heartbeat, Cloud adapter tool catalog, semantic tool invocation, proposal/evidence/replay linkage, generic SQL blocking, and no source mutation before approval.
- Local and Cloud histories remain separate unless a future import path is explicitly implemented.
- Public release should still run dependency review, container scanning, and release/legal signoff.

## Deviations From Brief

- The optional localhost approval UI was not implemented because the CLI approval path is complete and adding a web UI would increase release surface. It is documented as follow-up.
- No license change was made. The repo already has `LICENSE`.

## Follow-Up Work

- Optional local approval UI.
- Keep the hosted verifier environment outside git and rerun it before any public MCP release candidate.
- CI wiring for Docker-backed integration tests if not already enabled in the publishing pipeline.
- Dependency/container scanning before public release.

## Confirmation

- Nothing was pushed.
- Nothing was published to npm, Docker Hub, GitHub releases, or documentation hosting.
- No Cloud deployment was performed.
- No real production credentials were created, rotated, or committed.
