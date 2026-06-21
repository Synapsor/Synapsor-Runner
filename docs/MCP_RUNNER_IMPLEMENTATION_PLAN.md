# MCP runner implementation plan

Branch: `mcp-commit-safe-runtime`

This plan maps the existing open-source runner repository to the commit-safe database MCP goal. The runner is a local-first MCP and database safety runtime, not a copy of the Synapsor C++ DBMS.

## Current inventory

### Existing package structure

- `packages/protocol`
  - Zod schemas for the current `protocol_version: "1.0"` writeback job/result shape.
- `packages/worker-core`
  - Runner config, env loading, redaction, doctor checks, polling loop, job validation.
- `packages/control-plane-client`
  - Runner-token HTTP client for registration, heartbeat, adapter catalog/call, claim, lease renewal, result, and doctor.
- `packages/postgres`
  - Parameterized single-row Postgres update adapter, identifier validation, receipt table, idempotency, tenant guard, version conflict guard.
- `packages/mysql`
  - Parameterized single-row MySQL update adapter with equivalent safety checks.
- `apps/runner`
  - CLI entrypoint with `doctor`, `validate`, `apply`, and `start`.
- `examples/postgres-support`
  - Local approved writeback fixture for support tickets.
- `examples/mysql-orders`
  - Local approved writeback fixture for orders/refund review.
- `scripts/smoke-local-examples.mjs`
  - Docker-backed local smoke for Postgres/MySQL apply, idempotent retry, stale conflict, tenant mismatch, and disallowed column behavior.

### Baseline behavior

- Existing test baseline before edits: `corepack pnpm test` passed 5 files / 13 tests.
- Current worker already rejects arbitrary identifiers, patch columns outside allowlist, primary/tenant patch allowlisting, and missing approval id.
- Current job protocol is useful but not yet the required public protocol names:
  - existing: `protocol_version: "1.0"`
  - required: `synapsor.change-set.v1`, `synapsor.writeback-job.v1`, `synapsor.execution-receipt.v1`, `synapsor.runner-registration.v1`

## Implementation phases

### Phase 1: shared public protocol

- Add `schemas/*.schema.json`.
- Add `fixtures/protocol/*.json`.
- Add a shared checksum manifest.
  - Current status: `fixtures/protocol/MANIFEST.json` records the schema/fixture SHA-256 set mirrored into the main Synapsor repository as `protocol/MANIFEST.json`; protocol tests verify all listed hashes.
- Extend `packages/protocol` to parse:
  - current legacy `protocol_version: "1.0"` jobs/results
  - public `schema_version: "synapsor.writeback-job.v1"` jobs
  - public `schema_version: "synapsor.execution-receipt.v1"` receipts
  - public `schema_version: "synapsor.change-set.v1"` proposals
  - public `schema_version: "synapsor.runner-registration.v1"` runner registration
- Normalize public writeback jobs into the existing worker shape so the current Postgres/MySQL adapters remain stable.
- Add tests proving protocol fixtures parse and no credentials/unrestricted SQL are present.

### Phase 2: local capability runtime and store

- Add a strict YAML/JSON config loader for semantic capabilities.
  - Current status: JSON validator implemented in `packages/config`.
- Reject arbitrary SQL, model-controlled table/schema/column names, missing tenant/primary guards, and proposal capabilities without allowlisted columns.
  - Current status: implemented in `packages/config` unit tests.
- Add local SQLite migrations for proposals, events, evidence, query audit, approvals, jobs, receipts, replay, and runner state.
  - Current status: proposal/event/approval/evidence/query-audit/writeback-job/idempotency-receipt/replay/runner-state foundation implemented in `packages/proposal-store`.
- Add proposal immutability and approval-by-hash/version.
  - Current status: implemented for proposal creation and approval in `packages/proposal-store`.
- Add approved proposal to public writeback job generation.
  - Current status: implemented through `ProposalStore.createWritebackJobFromProposal` and `synapsor proposals writeback-job`.

### Phase 3: MCP stdio server

- Add official MCP TypeScript SDK pinned to a stable version.
  - Current status: implemented in `packages/mcp-server` with `@modelcontextprotocol/sdk@1.29.0`.
- Implement stdio transport first.
  - Current status: `corepack pnpm runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db`.
- Expose semantic tools only:
  - `billing.inspect_invoice`
  - `billing.propose_late_fee_waiver`
  - `support.inspect_ticket`
  - `support.propose_ticket_resolution`
  - `orders.inspect_order`
  - `orders.propose_refund_review`
- Do not expose `execute_sql`, generic query tools, approval tools, or commit tools to the model.
  - Current status: enforced by config/runtime shape and covered by `packages/mcp-server/src/index.test.ts`.
- Add read-only resources:
  - `synapsor://proposals/{proposal_id}`
  - `synapsor://evidence/{evidence_bundle_id}`
  - `synapsor://replay/{replay_id}`
  - Current status: implemented in the local stdio server and direct runtime resource reader.

### Phase 4: local CLI approval and replay

- Add:
  - `synapsor proposals list`
  - `synapsor proposals show`
  - `synapsor proposals approve`
  - `synapsor proposals reject`
  - `synapsor replay show`
  - `synapsor replay export`
  - `synapsor mcp serve`
- Add `synapsor mcp audit`
- Current status:
  - `synapsor proposals list/show/approve/reject` implemented against `packages/proposal-store`.
  - `synapsor replay show/export` implemented against `packages/proposal-store`.
  - `synapsor mcp audit` implemented.
  - `synapsor mcp serve` implemented for local stdio mode.
  - `synapsor init`, `synapsor runner start`, `synapsor runner doctor`, and `synapsor cloud connect` implemented as CLI entrypoints for starter config, runner aliases, and Cloud token/config validation.
- Approval must show exact diff, evidence summary, conflict guard, tenant/object scope, source mutation state, and proposal hash/version.
  - Current status: `proposals show` and non-JSON `proposals approve` / `proposals reject` print trusted principal, tenant, target row, primary key, required role, proposal hash/version, allowed columns, conflict guard, evidence bundle/query fingerprint/item count, writeback boundary, source-mutation state, and exact before/after diff before local approval/rejection.

### Phase 5: demos

- Add real disposable MCP demos:
  - `examples/mcp-postgres-billing`
  - `examples/mcp-postgres-support`
  - `examples/mcp-mysql-orders`
- Each demo needs Docker Compose, schema, seed data, read/write users where practical, config, client snippets, happy path, conflict path, cleanup, and expected output.
- The stale-row conflict demo must show:
  - proposal created
  - source unchanged
  - out-of-band row change
  - approval
  - guarded worker returns conflict
  - no write applied
  - Current status: `examples/mcp-postgres-billing` plus `corepack pnpm test:mcp-local` covers MCP stdio `tools/list`, tool calls, evidence resource read, source unchanged before approval, approval, generated `synapsor.writeback-job.v1`, guarded apply, idempotent retry, and stale-row conflict.
  - Current status: equivalent first-class MCP example directories exist for support-ticket and MySQL orders. `corepack pnpm test:mcp-local` exercises Postgres billing, Postgres support, and MySQL orders through stdio MCP plus guarded writeback.
  - Current status: public local entrypoint added as `./scripts/demo-docker.sh` and `corepack pnpm demo:docker`; it requires Docker only on the host, runs the TypeScript runner inside a local demo image, runs the Docker-backed stdio MCP proof, and tears down containers/volumes. The contributor path remains `./scripts/demo-local.sh` and `corepack pnpm demo:local`.

### Phase 6: Cloud-linked mode

- Add Cloud client registration/heartbeat/tool catalog/tool call/claim/lease/result support.
  - Current status: `packages/control-plane-client` exposes runner registration, runner heartbeat, adapter tool catalog, adapter tool call, writeback claim, lease renewal through heartbeat, and receipt submission helpers with transient retry/backoff.
  - Current status: `synapsor cloud connect --config ./synapsor.cloud.json` now verifies the scoped runner token, registers runner id/version/source/engine/capability metadata, and sends an initial heartbeat.
- Do not send DB credentials to Cloud.
  - Current status: client tests assert runner registration/heartbeat payloads do not include DB URLs or obvious secrets.
  - Current status: runner CLI tests assert `cloud connect` does not print or send runner tokens, database URLs, or credential-shaped values.
- Keep write credentials local.
- Keep local and Cloud histories separate unless explicit import is later implemented.
  - Current status: `mode: "cloud"` delegates adapter tool catalog and tool calls through `ControlPlaneClient`. The main repository now exposes the compatible `/v1/agent/adapters/tools` and `/v1/agent/adapters/call-tool` runner-token bridge with `adapter:read` / `adapter:invoke` permissions.
  - Current status: `corepack pnpm test:mcp-cloud-linked` exercises a hosted-compatible Cloud-linked lifecycle against a mock Cloud API and disposable Postgres billing fixture: runner-token doctor, runner registration, heartbeat, Cloud-mode MCP `tools/list`, Cloud adapter tool call, trusted session binding, source unchanged before approval, approved job claim/lease, real guarded Postgres writeback, and terminal receipt submission.

## Current next edits

- Phase 1 protocol schemas/fixtures are implemented locally and covered by protocol tests.
- `synapsor mcp audit <target>` is implemented as a static MCP database risk review for exported manifests/tools-list payloads.
- Validated capability config and the local store are wired into a real MCP stdio server/runtime.
- Public local demo entrypoint is implemented as `./scripts/demo-docker.sh` / `corepack pnpm demo:docker`; it requires Docker only, builds a small local runner image, starts Docker fixture databases, runs the stdio MCP proof, proves guarded writeback/stale-row conflict, and tears down disposable resources. The contributor path remains `./scripts/demo-local.sh` / `corepack pnpm demo:local` for environments that already have Node/Corepack installed.
- Runtime modes are enforced in the store/CLI/runtime layers: `read_only` exposes read tools only and direct proposal calls fail closed, `shadow` stores proposals/evidence/query-audit/replay but rejects approval and writeback-job creation, and `review` enables local approval plus guarded writeback.
- Local `apply --store` records a public `synapsor.execution-receipt.v1` into the SQLite proposal store, so replay includes applied/conflict terminal writeback receipts instead of only pre-write proposal history.
- Next code-only work is broader release hardening: optional localhost approval UI, main-repo Cloud/UI gaps, and live hosted Cloud E2E once a compatible Cloud workspace/adapter/token is available.
- Preserve existing worker behavior while adding local MCP/runtime layers.
- Keep the existing Docker smoke path working.

## Release blockers

- Live hosted Cloud-linked E2E still requires a compatible Synapsor Cloud workspace, adapter, and scoped runner token. A local hosted-compatible Cloud-linked smoke now covers the protocol/API lifecycle against a mock Cloud API and real disposable Postgres writeback.
- `packages/proposal-store` currently uses Node 22 `node:sqlite`, which is still marked experimental by Node. Before a public runner release, either pin/support that runtime explicitly or replace it with a stable SQLite dependency.
- Release docs present: `LICENSE` is Apache-2.0, and `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` exist with project-specific safety guidance.

## Verification log

- `corepack pnpm --filter @synapsor-runner/mcp-server test` passed after read-only catalog enforcement: read-only mode now lists only inspect/read tools while direct proposal calls still return `PROPOSALS_DISABLED`.
- `corepack pnpm test` passed after read-only catalog enforcement: 9 test files, 48 tests.
- `corepack pnpm test` passed after shadow/read-only mode enforcement: 9 test files, 47 tests.
- `corepack pnpm test:mcp-local` passed: Postgres billing, Postgres support, and MySQL orders stdio MCP flows all completed local approval, guarded writeback, idempotent retry, and stale-row conflict proof.
- `corepack pnpm --filter @synapsor-runner/control-plane-client test` passed after main-repo runner adapter bridge verification: 1 test file, 3 tests.
- `./scripts/demo-docker.sh` passed after adding the Docker-only wrapper, temporary dependency volumes, and `host.docker.internal` fixture routing. The command required only Docker on the host, ran the TypeScript runner inside a local image, started disposable Postgres/MySQL Docker containers, exercised semantic MCP tools, verified source unchanged before approval, applied guarded writeback, retried idempotently, proved stale-row conflict, and tore down containers/volumes/local demo files.
- `./scripts/demo-local.sh` passed earlier as the contributor path for machines that already have Node/Corepack installed.
- `corepack pnpm test:mcp-local` passed after the Docker-only host-routing change and disallowed-column tamper proof. The MCP smoke now validates Postgres billing, Postgres support, and MySQL orders across semantic tool listing/calls, tenant spoof rejection, source unchanged before approval, disallowed-column job rejection, guarded writeback, idempotent retry, stale-row conflict, and replay export.
- `corepack pnpm test` passed after adding `demo:docker`: 9 test files, 48 tests.
- `corepack pnpm test` passed after the CLI init/runner/cloud command additions: 9 test files, 42 tests.
- `corepack pnpm --filter @synapsor-runner/protocol test` passed after adding manifest checksum verification.
- `corepack pnpm test:mcp-client-configs` passed for `generic-stdio.json`, `claude-desktop.json`, `cursor.json`, and `vscode.json`: each config started stdio, returned semantic billing tools, and exposed no raw SQL/approval/commit tool.
- `corepack pnpm test` passed after adding the MCP client config verifier script: 9 test files, 47 tests.
- `corepack pnpm --filter @synapsor-runner/runner test` passed after enriching local approval display: 1 test file, 4 tests.
- `corepack pnpm test` passed after enriching local approval display: 9 test files, 47 tests.
- `corepack pnpm --filter @synapsor-runner/runner test` passed after adding local `apply --store` receipt recording and replay assertions: 1 test file, 4 tests.
- `corepack pnpm test` passed after adding local `apply --store` receipt recording: 9 test files, 47 tests.
- `corepack pnpm test:mcp-local` passed after recording apply/conflict receipts into replay for Postgres billing, Postgres support, and MySQL orders.
- `corepack pnpm demo:local` passed after receipt/replay updates: the public one-command demo ran disposable Postgres billing, Postgres support, and MySQL orders MCP scenarios, proved guarded writeback/idempotency/stale-row conflict, and tore down containers/volumes/temp demo files.
- `corepack pnpm test` passed after Docker-first demo and adapter hardening updates: 9 test files, 50 tests.
- `corepack pnpm test:mcp-local` passed after disallowed-column tamper proof across Postgres billing, Postgres support, and MySQL orders.
- `./scripts/demo-docker.sh` passed as the exact Docker-only first-run path: built the local runner image, ran the stdio MCP proof inside Docker, started disposable Postgres/MySQL fixtures, proved source unchanged before approval, guarded writeback, idempotent retry, disallowed-column rejection, stale-row conflict, and teardown. No demo containers or generated `.pnpm-store` cache remain.
- `corepack pnpm test:mcp-cloud-linked` passed after adding the hosted-compatible Cloud-linked smoke with mock Cloud API plus real guarded Postgres writeback and terminal receipt submission.
- `corepack pnpm --filter @synapsor-runner/runner test` passed after wiring `cloud connect` runner registration/heartbeat: 1 test file, 5 tests.
- `corepack pnpm --filter @synapsor-runner/control-plane-client test` passed after the same change: 1 test file, 3 tests.
- `corepack pnpm test` passed after `cloud connect` registration/heartbeat docs and tests: 9 test files, 48 tests.
- `corepack pnpm --filter @synapsor-runner/config test`, `corepack pnpm --filter @synapsor-runner/mcp-server test`, and `corepack pnpm --filter @synapsor-runner/runner test` passed after allowing the generated Cloud config registration fields (`runner_id`, `runner_version`, `project_id`, `engines`, `capabilities`) in strict config validation.
- `corepack pnpm test` passed after the same strict Cloud config fix: 9 test files, 48 tests.
