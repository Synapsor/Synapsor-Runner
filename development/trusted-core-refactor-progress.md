# Trusted Core Modularization Progress

## Objective

Refactor the trusted Runner core into reviewable modules while preserving every
public, authority, storage, CLI, MCP, packaging, and security behavior described
in `/home/sandesh-tiwari/Desktop/C++/goal.txt`.

## Starting State

- Started: 2026-07-26
- Branch: `refactor/trusted-core-modularization`
- Starting HEAD: `8989163f324e7e8abaf55696796d1f13d7a6d71b`
- Starting worktree: clean; local `main` matched `origin/main`
- Goal SHA-256:
  `84106e6196019816ecf88ad3cf2cec3aa31b219df4c8d1af09989b362a398279`
- Root and Runner `AGENTS.md` SHA-256:
  `29ad06f0cfd7d30285160f7b2fa29d6df5edc11fa9641c7093ef2b5337a6bf78`
- Versions: Runner `1.6.5`, Spec `1.7.0`, DSL `1.7.0`
- Starting monolith lines:
  - `packages/proposal-store/src/index.ts`: 9,573
  - `packages/mcp-server/src/index.ts`: 7,511
  - `apps/runner/src/cli.ts`: 20,781
  - Total: 37,865

## Dependency Direction

Measured TypeScript project references establish the extraction order:

```text
protocol
  -> proposal-store
  -> mcp-server
  -> apps/runner
```

`mcp-server` also depends on config, control-plane-client, postgres,
schema-inspector, and spec. `apps/runner` composes those packages plus DSL,
MySQL, worker-core, and its existing focused authoring/UI modules.

## Phases

| Phase | Status | Evidence |
| --- | --- | --- |
| 0. Baseline and characterization | Complete | 948 tests and trusted-core parity verifier passed |
| 1. Proposal store | Pending | |
| 2. MCP server | Pending | |
| 3. Runner CLI | Pending | |
| 4. Integrated architecture and packed parity | Pending | |
| 5. Completion audit, merge, and push | Pending | |

## Baseline Commands

- `corepack pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm test`: passed, 63 files and 948 tests in 196.06 seconds.
- `corepack pnpm build:runner-package`: passed.
- `node scripts/trusted-core-baseline.mjs --capture`: captured
  `development/trusted-core-refactor-baseline.json`.
- `node scripts/trusted-core-baseline.mjs`: passed against a fresh runtime.
- `git diff --check`: passed.

The baseline verifier captures and compares:

- public generated declaration symbols and value signatures for proposal-store,
  MCP-server, and all published Runner entrypoints;
- the exact root CLI help text;
- Runner package name/version/bin/exports/files/dependency surface;
- the real support-plan-credit MCP tool catalog and schemas;
- exact protected-read SQL and parameter ordering;
- the canonical example-contract digest;
- shared-Postgres migration SQL;
- a deterministic local proposal, policy approval, event, attention, and
  approval transition.

Synthetic fixture tenant/principal labels are used. No credentials, URLs,
source rows, or kept-out values are captured.

## Decisions

- Extraction order is proposal-store, MCP-server, then Runner CLI.
- Existing entry files remain the only compatibility facades.
- Moves are mechanical first; cleanup and behavior changes are out of scope.
- Public declarations are checked by symbol/signature and packed-consumer
  compatibility, not byte identity of internal declaration layout.
- No package version, release note, dist-tag, dependency manifest, or publish
  state will change.

## Deviations And Blockers

None.

## Exact Next Action

Commit the complete Phase 0 baseline checkpoint. Then map proposal-store types,
Postgres adapters, SQLite responsibilities, and helper ownership before the
first mechanical extraction.
