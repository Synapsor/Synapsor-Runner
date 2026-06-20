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
  - Runner-token HTTP client for claim, heartbeat, result, and doctor.
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
  - Current status: proposal/event/approval/writeback receipt foundation implemented in `packages/proposal-store`.
  - Remaining: evidence items, query audit, writeback jobs, idempotency receipts, replay records, and runner state tables.
- Add proposal immutability and approval-by-hash/version.
  - Current status: implemented for proposal creation and approval in `packages/proposal-store`.

### Phase 3: MCP stdio server

- Add official MCP TypeScript SDK pinned to a stable version.
- Implement stdio transport first.
- Expose semantic tools only:
  - `billing.inspect_invoice`
  - `billing.propose_late_fee_waiver`
  - `support.inspect_ticket`
  - `support.propose_ticket_resolution`
  - `orders.inspect_order`
  - `orders.propose_refund_review`
- Do not expose `execute_sql`, generic query tools, approval tools, or commit tools to the model.
- Add read-only resources:
  - `synapsor://proposals/{proposal_id}`
  - `synapsor://evidence/{evidence_bundle_id}`
  - `synapsor://replay/{replay_id}`

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
- Approval must show exact diff, evidence summary, conflict guard, tenant/object scope, source mutation state, and proposal hash/version.

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

### Phase 6: Cloud-linked mode

- Add Cloud client registration/heartbeat/tool catalog/tool call/claim/lease/result support.
- Do not send DB credentials to Cloud.
- Keep write credentials local.
- Keep local and Cloud histories separate unless explicit import is later implemented.

## Current next edits

- Phase 1 protocol schemas/fixtures are implemented locally and covered by protocol tests.
- `synapsor mcp audit <target>` is implemented as a static MCP database risk review for exported manifests/tools-list payloads.
- Next code-only work is completing the local store tables for evidence, query audit, writeback jobs, idempotency receipts, replay records, and runner state, then wiring it into local MCP capability execution.
- Preserve existing worker behavior while adding local MCP/runtime layers.
- Keep the existing Docker smoke path working.

## Release blockers

- No standalone MCP server exists yet.
- No local approval/replay CLI exists yet.
- No Cloud-linked MCP catalog path is implemented in this repo yet.
- `packages/proposal-store` currently uses Node 22 `node:sqlite`, which is still marked experimental by Node. Before a public runner release, either pin/support that runtime explicitly or replace it with a stable SQLite dependency.
