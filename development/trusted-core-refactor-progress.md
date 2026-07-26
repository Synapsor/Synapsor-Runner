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
| 1. Proposal store | Complete | 69 tests, typecheck, packaged build, parity verifier, and cycle audit passed |
| 2. MCP server | Complete | 111 tests, typecheck, packaged build, parity verifier, and cycle audit passed |
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
- `ProposalStore` remains the exported constructor. Its domain methods retain
  own, non-enumerable, writable, configurable prototype descriptors through one
  checked installer; the public TypeScript interface is composed from the same
  domain method signatures.

## Phase 1: Proposal Store

`packages/proposal-store/src/index.ts` is now a 98-line explicit compatibility
facade, down from 9,573 lines. The implementation is separated as follows:

- `domain-types.ts`: public domain records and the runtime-store interface.
- `errors.ts`: the stable coded store error.
- `proposal-integrity.ts`, `query-builders.ts`, and `writeback-domain.ts`:
  proposal identity/freshness, filtered query construction, and writeback
  semantics.
- `attention-domain.ts`, `worker-control-domain.ts`, and
  `shadow-analysis.ts`: attention mapping, operator-bound worker controls, and
  shadow comparison.
- `record-codecs.ts` and `shared-ledger-domain.ts`: durable row codecs,
  integrity parsing, shared-ledger mapping, and restoration order.
- `sqlite-*-methods.ts`: schema/lifecycle, proposals/approvals,
  writeback/reconciliation, workers, metrics/policy, attention/notifications,
  Cloud/control state, shadow studies, and common persistence internals.
- `sqlite-store.ts`: the SQLite constructor/composition root.
- `postgres-runtime-store.ts`: shared-Postgres and fleet-intent adapters.

No production module exceeds 1,203 lines. A source-import graph inspection found
no proposal-store cycles and confirmed that no lower-level module imports the
compatibility facade.

Phase 1 evidence:

- `corepack pnpm typecheck`: passed.
- `corepack pnpm --filter @synapsor-runner/proposal-store test`: passed, 69
  tests.
- `corepack pnpm build:runner-package`: passed.
- `node scripts/trusted-core-baseline.mjs`: passed.
- `git diff --check`: passed.
- Added a descriptor characterization proving installed methods remain
  non-enumerable own prototype methods.

Phase 1 implementation commit: `f0a3c6599609`.

## Phase 2: MCP Server

`packages/mcp-server/src/index.ts` is now a 118-line explicit compatibility
facade, down from 7,511 lines. The implementation is separated into these trust
and operational domains:

- `runtime-types.ts`: public and internal runtime/transport data contracts.
- `capability-authority.ts`, `trusted-context.ts`, and `runtime-config.ts`:
  capability eligibility, trusted tenant/principal/credential resolution, and
  normalized runtime configuration.
- `generated-authority.ts`: generated-boundary lock, dependency, and drift
  preflight.
- `read-planning.ts`, `source-runtime.ts`, and
  `protected-read-runtime.ts`: parameterized row/aggregate SQL planning, source
  pools and RLS binding, privacy budgets, suppression, and analytical audit.
- `proposal-freshness.ts`, `proposal-builder.ts`, and `approval-policy.ts`:
  freshness authority, immutable proposal construction, guarded policy
  evaluation, and auto-approval eligibility.
- `tool-catalog.ts`, `tool-dispatch.ts`, `result-envelope.ts`, and
  `local-resources.ts`: model-facing schemas/catalog, canonical dispatch,
  response compatibility, and read-only proposal/evidence/replay resources.
- `runtime-composition.ts`, `server-composition.ts`, and `cloud-linked.ts`:
  runtime lifecycle, official MCP server registration/stdio, and Cloud outbox
  coordination.
- `http-security.ts`, `http-transport.ts`, `runtime-observability.ts`, and
  `tool-naming.ts`: authentication/TLS/OAuth/CORS/host controls, HTTP and
  Streamable HTTP sessions, readiness/metrics, and deterministic aliases.
- `runtime-errors.ts`, `runtime-logging.ts`, and `safe-values.ts`: stable error
  classification/redaction, trusted rejection logging, and bounded canonical
  value/hash helpers.

No production module exceeds 782 lines. A compiler-symbol import graph
inspection found no MCP-server cycles and confirmed that no implementation
module imports the compatibility facade.

Phase 2 evidence:

- `corepack pnpm typecheck`: passed.
- `corepack pnpm --filter @synapsor-runner/mcp-server test`: passed, 111 tests.
- `corepack pnpm --filter @synapsor-runner/mcp-server build`: passed.
- `corepack pnpm build:runner-package`: passed.
- `node scripts/trusted-core-baseline.mjs`: passed.
- `git diff --check`: passed.

Phase 2 implementation commit: `2066c1724567`.

## Deviations And Blockers

None.

## Exact Next Action

Map Runner CLI shared parsing/output behavior, command families, and bootstrap
dispatch before the first CLI extraction.
