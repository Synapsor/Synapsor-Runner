# Runner 1.2 Guarded CRUD Progress

This document records evidence for the guarded CRUD and receipt-authority work.
It is a development record, not a release announcement.

## Baseline

- Date: 2026-07-13
- Branch: `feature/runner-1.2-guarded-crud-writeback`
- Base commit: `cd435b99e2242b11c167cbd54a7c58bdd2fe2e3e`
- Worktree at branch creation: clean
- Node: `v22.22.2`
- pnpm: `10.14.0`
- npm: `11.8.0`
- `@synapsor/spec`: `1.1.0`
- `@synapsor/dsl`: `1.1.0`
- local `@synapsor/runner`: `1.1.2`
- npm `@synapsor/runner` `latest`: `1.1.1`
- npm `@synapsor/runner` `next`: `1.1.1`

Runner 1.1.2 has not been published as of this baseline. This branch does not
publish or move npm tags.

## Baseline Verification

- `corepack pnpm install --frozen-lockfile`: pass
- `corepack pnpm typecheck`: pass
- `corepack pnpm test`: pass, 302 tests in 17 files
- `corepack pnpm test:fleet`: pass
- `./scripts/verify-release-gate.sh 1.1.2`: pass, including 234 focused
  tests, MCP client configs, first-run Docker proof, local/packed verification,
  packed own-database apply, license scan, package dry run, and `diff --check`

There were no baseline failures.

## Current Data Path

1. `@synapsor/spec` validates a language-neutral `SynapsorContract`.
2. `@synapsor/dsl` compiles `CREATE AGENT CONTEXT` and `CREATE CAPABILITY`
   blocks into that contract.
3. the config/runtime loader merges embedded and contract capabilities into one
   runtime catalog;
4. the MCP runtime performs a trusted-tenant read and builds a
   `synapsor.change-set.v1` proposal;
5. the proposal store persists the proposal, evidence, query audit, approval,
   writeback job, receipts, events, and replay;
6. the CLI verifies the approved proposal against the reviewed capability and
   emits a `synapsor.writeback-job.v1` `single_row_update` job;
7. the Postgres or MySQL adapter locks the exact tenant-scoped row, rechecks the
   expected version, applies one parameterized UPDATE, and records a source
   receipt in the same transaction;
8. the CLI records the execution receipt back into the local/shared Runner
   ledger, where it becomes visible through activity, receipts, and replay.

The v1 protocol and adapters are UPDATE-only. They must remain decodable and
behaviorally unchanged after v2 CRUD support is added.

## Current Source Receipt Behavior

The adapters export idempotent `CREATE TABLE IF NOT EXISTS` migration text, but
normal apply does not execute that DDL. Current public guidance expects an
administrator to create `synapsor_writeback_receipts` before writeback and grant
the writer SELECT/INSERT/UPDATE on it. Apply and the adapter doctor only use the
precreated table.

The compatibility default is therefore:

```text
receipt_authority: source_db
source_receipt_provisioning: precreated
```

Runner 1.2 must not silently change an existing config to auto-migration or to a
weaker cross-database receipt authority.

## Safety Design

The mode/operation claim matrix and crash semantics are normative in
[`docs/rfcs/004-guarded-crud-receipt-authority.md`](../rfcs/004-guarded-crud-receipt-authority.md).

Key boundary:

- `source_db` can atomically classify mutation and receipt in one source
  transaction;
- `runner_ledger` can guarantee at-most-one business effect only when the
  source itself supplies the required version/unique-key guard, but cannot
  always classify a crash after source commit;
- an unprovable committed outcome becomes `reconciliation_required`; it is
  never silently retried or labeled `already_applied`.

## Milestone Status

- Phase 0 baseline: complete
- Phase 1 receipt configuration: complete
- Phase 2 Runner-ledger UPDATE hardening: complete
- Phase 3 guarded INSERT: complete
- Phase 4 guarded DELETE: complete
- Phase 5 protocol/receipt/replay integration: complete
- Phase 6 onboarding and docs: complete
- Milestone A release verification: complete
- Milestone B bounded-set branch: not started

## Milestone A Implementation

- Canonical contracts and the DSL now express explicit single-row
  `UPDATE`, `INSERT`, and `DELETE`; an omitted operation remains the legacy
  guarded UPDATE meaning.
- Protocol v2 adds operation-aware change sets, writeback jobs, and execution
  receipts. Protocol v1 UPDATE fixtures remain accepted.
- Runtime receipt configuration separates `source_db` versus `runner_ledger`
  authority from `precreated` versus `auto_migrate` source provisioning.
- Runner-ledger apply records durable intents before source access and stops
  ambiguous crash-window outcomes at `reconciliation_required`. The operator
  reconciliation commands inspect only reviewed columns under trusted tenant
  scope and append a verified resolution rather than guessing.
- Postgres and MySQL adapters implement parameterized one-row CRUD. INSERT
  requires a source-enforced unique dedup identity; UPDATE requires and advances
  a real version; hard DELETE requires an exact version and rejects hidden
  trigger/cascade effects it cannot prove bounded.
- Schema inspection, onboarding, wizard generation, doctor, and tools preview
  report operation-specific prerequisites and receipt modes without exposing
  credentials or model-controlled identifiers.
- The flagship `support-plan-credit` example retains its three-tier UPDATE
  policy demonstration and adds a human-approved native INSERT with one-row,
  retry, receipt, and replay proof.

## Milestone A Verification In Progress

- `corepack pnpm test:live-apply`: pass after rebuilding the runner bundle;
  Postgres billing/support, MySQL orders, and support-plan-credit all proved
  proposal-before-write, external approval, guarded apply, idempotent job retry,
  stale conflict, receipt, and replay. All disposable containers were removed.
- `corepack pnpm test:guarded-crud`: pass; Postgres and MySQL covered all three
  operations under source precreated, source auto-migrate, and Runner-ledger
  modes, including injected crash windows, concurrent applies, tenant/version
  guards, and DELETE side-effect refusal.
- Focused CLI/Postgres/MySQL tests: 132 passed.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm test`: pass, 346 tests in 17 files plus license/content and
  DSL source-path checks.
- `corepack pnpm test:first-run`: pass; disposable proposal -> approval ->
  guarded apply -> replay proof.
- `corepack pnpm test:mcp-client-configs`: pass; stdio and Streamable HTTP
  examples parse, contain no secrets, and expose semantic tools only.
- `corepack pnpm test:fleet`: pass; two Runners covered shared-store claims,
  quorum, batch apply, worker races/crash recovery, bounded source pools,
  backup/restore, retention, and retryable saturation classification.
- `./scripts/verify_adoption_quickstart.sh`: pass; audit remains step one, the
  flagship DSL compiles strictly, kept-out fields remain excluded, and Cloud
  push is dry-run only.
- `./scripts/verify-local-runner.sh`, `./scripts/verify-packed-runner.sh`, and
  `./scripts/verify-packed-own-db.sh`: pass. The own-database packed path uses
  explicit `source_precreated` receipt mode and a writer without CREATE.
- `./scripts/verify-release-gate.sh 1.2.0`: pass, including 262 focused tests,
  public/local/packed commands, first-run proof, package content scan, Runner
  dry-run tarball (160 files, 420.8 kB), and `git diff --check`.
- `npm pack --dry-run` passes for `@synapsor/spec@1.2.0` (70 files, 26.5 kB)
  and `@synapsor/dsl@1.2.0` (10 files, 14.4 kB).
- No disposable Synapsor Runner Docker containers remain active.
