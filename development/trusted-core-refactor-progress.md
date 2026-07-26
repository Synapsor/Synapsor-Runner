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
| 3. Runner CLI | Complete | 160 focused tests, 949-test root suite, packaged build, parity verifier, and declaration audit passed |
| 4. Integrated architecture and packed parity | Complete | Dependency checker, architecture map, 950-test suite, clean packed declarations, pre-refactor ledger, compatibility matrices, and every required integration gate passed |
| 5. Completion audit | Complete | Final baseline, dependency, type, worktree, version, schema/storage, and facade-size audits passed |

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

## Phase 3: Runner CLI

`apps/runner/src/cli.ts` is now a 364-line shebang-bearing compatibility facade
and command composition root, down from 20,781 lines. Its prior command
implementations are separated into these operational groups:

- `cli-command-meta.ts`, `cli-help.ts`, `cli-options.ts`, `cli-files.ts`,
  `cli-format.ts`, and `cli-logging.ts`: command metadata/help, argument
  parsing, guarded file IO, stable output formatting, and error redaction.
- `cli-project.ts`, `cli-runtime.ts`, `config-domain.ts`,
  `config-inspect.ts`, `config-templates.ts`, and `runtime-doctor.ts`:
  project/config/store resolution, adapters, validation, generated
  configuration, and runtime posture checks.
- `guided-start.ts`, `onboarding.ts`, `boundary-commands.ts`,
  `first-run-doctor.ts`, `ui-command.ts`, and `mcp-project*.ts`: guided
  onboarding, exact-digest activation, Workbench, first-run checks, and managed
  MCP client setup.
- `mcp-runtime.ts`, `mcp-shared.ts`, `mcp-audit.ts`, and
  `runtime-commands.ts`: MCP serving/smoke behavior, tool naming/output,
  manifest audit, and local runtime lifecycle.
- `proposal-ledger.ts`, `proposal-formatting.ts`, `ledger-commands.ts`,
  `ledger-options.ts`, `activity-formatting.ts`, and `contract-commands.ts`:
  proposal/evidence/receipt/replay inspection, lifecycle output, contract/DSL,
  reports, policy, and effect commands.
- `apply-commands.ts`, `guarded-apply.ts`, `writeback-domain.ts`,
  `writeback-execution.ts`, and `writeback-setup.ts`: approval/apply/revert,
  guarded authority checks, SQL/handler execution, idempotency,
  reconciliation, and operator setup.
- `worker-policy.ts`, `worker-runtime.ts`, `attention-domain.ts`, and
  `attention-notifications.ts`: supervised-worker eligibility/runtime,
  proposal-expiry and queue attention, notification delivery, and
  operator-only controls.
- `cloud-commands.ts`, `shared-ledger-domain.ts`, `store-shared.ts`,
  `store-lease.ts`, `shadow-commands.ts`, and `try-commands.ts`: Cloud-linked
  synchronization, shared-store bridges, local leases, shadow studies, and
  isolated proof/demo flows.

No new production module exceeds 1,634 lines, and no new security-critical
module exceeds 2,000 lines. `onboarding.ts` is the only extracted module over
the preferred 1,500-line target; it retains the cohesive existing init/wizard,
artifact-generation, and receipt-setup flow rather than splitting one ordered
interactive state machine across forwarding modules.

The facade preserves each prior public helper with an explicit compatibility
wrapper. The packaging build now produces portable `./cli` and `./shadow`
declarations with the same captured public symbols/signatures but without
unpublished workspace aliases, repository-local absolute paths, or references
to extracted files omitted by the unchanged package `files` manifest.

Phase 3 evidence:

- `corepack pnpm typecheck`: passed.
- Focused Runner command suites: passed, 8 files and 160 tests.
- `corepack pnpm test`: passed, 63 files and 949 tests in 194.72 seconds,
  followed by the license/content, human command-surface, DSL-source-path, and
  Cursor-plugin verifiers.
- `corepack pnpm build:runner-package`: passed.
- `node scripts/trusted-core-baseline.mjs`: passed after extraction and after
  the explicit declaration wrappers.
- Generated `apps/runner/dist/cli.d.ts` retains the exact baseline public
  symbol set and compatible signatures and has no reference to a newly
  extracted relative module.
- `git diff --check`: passed.

Phase 3 implementation commit: `b08a1ee`.

## Phase 4: Integrated Architecture And Packed Parity

The repository now owns and enforces the trusted-core import direction:

- `scripts/check-trusted-core-dependencies.mjs` uses the TypeScript AST to scan
  146 production modules and 736 internal edges.
- It rejects package-direction violations, forbidden facade back-imports,
  within-package layer violations, cycles, and oversized facades.
- `docs/trusted-core-architecture.md` maps each trust decision, durable or
  database side effect, and model-controlled versus trusted input to one owner.
- The checker runs before Vitest in the root `test` command.

The final compatibility work added two executable proofs required by the goal:

- `scripts/make-runner-declarations-portable.mjs` preserves the exact captured
  public symbols/signatures while resolving only the internal types needed by
  `@synapsor/runner/cli` and `@synapsor/runner/shadow`. A clean packed consumer
  compiles `./cli`, `./authoring`, `./shadow`, and `./runtime` with
  `skipLibCheck: false`. No dependency, export, entrypoint, or package `files`
  manifest changed.
- `development/trusted-core-fixtures/pre-refactor-8989163-ledger.db` was
  generated with the pre-refactor `ProposalStore` at the starting commit. The
  current store opens it, validates synthetic proposal/evidence/query-audit/
  approval/receipt/replay state, appends a successor, closes, and reopens it.
  The fixture is excluded from the Runner tarball.

Final integrated evidence:

- `corepack pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm test`: passed, 63 files and 950 tests in 194.23 seconds,
  followed by the license/content, human command-surface, DSL-source-path, and
  Cursor-plugin verifiers.
- `corepack pnpm build:runner-package`: passed.
- `corepack pnpm test:smoke`: passed; 440 release-subset tests, current
  Claude Code and Codex config validation, first-run Docker proof, public/local
  command checks, clean packed declaration compilation, packed own-database
  Postgres apply, and pnpm publish dry-run all passed.
- `corepack pnpm test:packed-backward-compatibility`: passed against Runner
  1.6.3, DSL 1.6.0, and Spec 1.6.0.
- `corepack pnpm test:published-compatibility`: passed against the pinned
  1.5.4, 1.6.0, and 1.6.3 public compatibility baselines.
- `corepack pnpm test:auto-boundary-explore`: passed against live PostgreSQL +
  Next.js + Prisma; authoring-only tool surface remained bounded.
- `corepack pnpm test:auto-boundary-explore:packed`: passed from a clean
  tarball; bounded aggregate denials, suppression, read-only posture, Protect,
  and production tool-surface checks all passed.
- `corepack pnpm test:reviewed-relationships`: passed on live Postgres/MySQL,
  including star/depth-two totals, nullable semantics, per-relation scope, and
  fan-out refusal.
- `corepack pnpm test:workbench-ask`: passed desktop/mobile, provider, parity,
  no-mutation, no-persisted-key, and browser-storage checks.
- `corepack pnpm test:guided-onboarding:packed`: passed the 40-resource
  FitFlow packed journey, OIDC approval roles, workers, policy/manual
  combinations, limits, stale conflicts, replay, compensation, and
  notifications.
- `corepack pnpm test:proposal-freshness`: passed live Postgres/MySQL target and
  supporting-evidence drift, quorum, shared-store, Cloud, idempotency, and
  kept-out checks.
- `corepack pnpm test:principal-scope`: passed Postgres/MySQL DSL variants and
  shared-ledger isolation.
- `corepack pnpm test:bounded-set`: passed source/ledger receipt modes, scope,
  caps, values, drift, atomicity, reconciliation, and 1/10/100-row cases.
- `corepack pnpm test:reversible`: passed Postgres/MySQL update/insert/delete,
  compensation, stale conflict, exact restore, lineage, and redaction checks.
- `corepack pnpm test:fleet`: passed two-runner shared-ledger isolation,
  locking, quorum, duplicate-worker exclusion, crash recovery, dead letters,
  readiness, pool-pressure classification, backup/restore, and retention.
- `node scripts/trusted-core-baseline.mjs`: passed after the complete refactor
  and final declaration build.
- `corepack pnpm check:trusted-core-dependencies`: passed.
- `git diff --check`: passed.

No required gate is unverified. Docker, network registry access, live Postgres,
live MySQL, Claude Code, and Codex prerequisites were available.

Phase 4 architecture/checker commit: `693475e`.
Phase 4 packed/storage parity commit: `e812d58`.

## Phase 5: Completion Audit

The final pre-merge audit confirms:

- Compatibility facades are 98 lines for proposal-store, 118 lines for
  MCP-server, and 364 lines for Runner CLI, down from 9,573, 7,511, and
  20,781 lines respectively.
- `node scripts/trusted-core-baseline.mjs`,
  `corepack pnpm check:trusted-core-dependencies`,
  `corepack pnpm typecheck`, and `git diff --check` all pass at the final
  branch state.
- Runner remains `1.6.5`, Spec remains `1.7.0`, and DSL remains `1.7.0`.
- `pnpm-lock.yaml` and every published package manifest are unchanged. The
  root-only `package.json` change adds the repository dependency checker and
  runs it as part of `test`.
- Existing SQLite schema and migration behavior are unchanged: the migration
  SQL baseline is identical, all current store tests pass, and the current
  implementation opens, validates, extends, closes, and reopens a ledger
  created by the exact pre-refactor starting commit.
- No npm publication, dist-tag movement, release, tag, or package-version
  change occurred.

Remaining pre-existing audit hotspots outside the three authorized monoliths
are `apps/runner/src/local-ui.ts` (6,806 lines),
`apps/runner/src/auto-boundary.ts` (2,443),
`apps/runner/src/boundary-workbench.ts` (2,255), and
`apps/runner/src/scoped-explore.ts` (1,889). They were not refactored because
the goal explicitly prohibited broad cleanup outside the three trusted-core
entry files.

## Deviations And Blockers

- A diagnostic `corepack pnpm --filter @synapsor/runner test` invocation ran
  Vitest from `apps/runner`, which changed root-relative fixture resolution and
  used the package-local 5-second default timeout. It produced cascading
  fixture errors and known load-sensitive timeouts. This is not a repository
  gate and did not prompt test or timeout changes. The supported root
  `corepack pnpm test` command runs from the repository root with four workers
  and 20-second test/hook timeouts; it passed all 950 tests.
- The required clean packed-consumer compile exposed a pre-existing declaration
  packaging defect: public CLI/shadow declarations named unpublished workspace
  packages. The portable declaration build fixes resolution while preserving
  the baseline public symbol/signature set and unchanged package manifest.
- An intermediate publish dry-run showed the new old-ledger fixture under the
  package-wide `fixtures` release copy. It was moved under `development/`;
  a final packed artifact check proves it is absent from the tarball.
- No active blockers.

## Exact Next Action

Commit this completed progress record, fetch the current remote state, merge
the reviewed branch into `main`, and push `main` without publishing, tagging,
or changing any package version.
