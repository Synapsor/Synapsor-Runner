# Runner 1.5 Developer Experience Progress

Branch: `feature/runner-1.5-developer-experience`

Baseline commit: `6c8b17a` (`Stabilize first-run doctor CI test`)

Target: complete `/home/sandesh-tiwari/Desktop/C++/goal.txt` without
publishing, pushing, tagging, or deploying.

## Status

| Phase | Status | Verification |
| --- | --- | --- |
| Baseline | complete | Full release gate passed |
| 1: `try` experience | complete | 533 tests, content/path checks, packed scratch installs passed |
| 1B: database-enforced scope | complete | 549 tests, explicit assurance/provenance diagnostics, adversarial PostgreSQL RLS proof passed |
| 2: shadow studies | complete | 546 tests, packed scratch study/import/report passed |
| 3: MCP App | pending | |
| 4: effect regression | pending | |
| 5: audit funnel | pending | |
| 6: schema candidates | pending | |
| 7: reference experience | pending | |
| 8: docs and trust hygiene | pending | |
| 9: final verification | pending | |

## Baseline Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
./bin/synapsor-runner demo --quick --no-interactive
./scripts/verify-release-gate.sh
```

Results:

- install: lockfile current; no dependency changes;
- build/typecheck: passed;
- full unit suite: 25 files, 528 tests passed;
- license/content check: passed;
- DSL source-path compatibility check: passed;
- documented quick demo: passed;
- release subset: 8 files, 324 tests passed;
- MCP client configuration verification: passed;
- disposable Docker/Postgres proposal, approval, guarded writeback, and replay
  proof: passed;
- public commands, local install, packed install, and packed own-database
  onboarding: passed;
- npm dry-run: 196 files, no publish;
- complete release gate: passed for `@synapsor/runner@1.4.123`.

## Baseline Architecture

Existing foundations that must be extended:

- strict shadow proposals and basic human-action comparison/reporting;
- proposal/evidence/query-audit/receipt/replay/compensation persistence;
- guarded single-row and bounded-set SQL writeback;
- app-owned handler writeback and retry supervision;
- local review UI with loopback/session/CSRF protections;
- static/live contract tests with text, JSON, and JUnit output;
- MCP audit and capability-surface lint;
- config/onboarding/client generation;
- canonical `@synapsor/spec` and `@synapsor/dsl` packages.

Observed gaps relevant to the goal:

- no `try` command;
- `demo --quick` is concise but stops at proposal creation;
- `scripts/try-synapsor.sh` proves the full boundary but requires Docker and is
  a separate implementation;
- no first-class PostgreSQL RLS-aware source mode or RLS doctor;
- no tenant-bound credential resolver interface;
- shadow support has no complete study lifecycle or risk-ranked report;
- no MCP App resource/presentation surface;
- no effect-regression fixture CLI;
- audit does not yet emit reviewed canonical replacement candidates;
- no Prisma, Drizzle, or OpenAPI candidate generators.

## Decisions

- Keep package versions unchanged until all milestone gates pass.
- Extend existing lifecycle implementations; do not introduce parallel stores,
  test runners, audit engines, or UIs.
- Keep the canonical split: spec owns portable contract meaning, DSL owns
  authoring syntax, Runner owns local runtime/study/report behavior.
- Treat shared-credential scope as application-level. PostgreSQL RLS is an
  optional independent query-defense layer; tenant-bound credentials or
  isolated deployments are the stronger process-compromise boundary.
- Keep the first `try` path no-Docker and fast. Put restart/retry/stale proof in
  `try --prove`.

## Phase 1: One-Command Try Experience

Implemented:

- `synapsor-runner try` with interactive browser review, terminal fallback,
  `--yes`, `--no-open`, `--json`, `--no-color`, `--state-dir`, and `--prove`;
- an isolated embedded demo source separate from the real SQLite proposal
  ledger, with a real scoped evidence read, proposal, explicit review, guarded
  writeback job, atomic source receipt, execution receipt, and replay;
- exhaustive immutable-intent collision checks for tenant, principal,
  capability, target, expected version, and effect;
- restart-safe duplicate handling, stale-state conflict, cross-tenant and
  cross-principal denial, rejection, kept-out-field, and replay-no-mutation
  assertions;
- `demo --quick` delegates to the same implementation and `demo inspect`
  inspects that state instead of creating a second fixture;
- one-time local-UI bootstrap URLs that set an `HttpOnly`, `SameSite=Strict`
  loopback session cookie, redirect to a clean URL, reject token reuse, and
  emit `Referrer-Policy: no-referrer`.

Verification:

```bash
corepack pnpm build
corepack pnpm test
node scripts/check-license-content.mjs
./scripts/verify-dsl-source-paths.sh
corepack pnpm build:runner-package
corepack pnpm --filter @synapsor/runner pack --pack-destination /tmp/synapsor-phase1-pack.U2JDtP
npx -y -p /tmp/synapsor-phase1-pack.U2JDtP/synapsor-runner-1.4.123.tgz synapsor-runner try --yes --no-open --json
npm install /tmp/synapsor-phase1-pack.U2JDtP/synapsor-runner-1.4.123.tgz
npx --no-install @synapsor/runner try --yes --no-open
```

Results:

- build/typecheck passed;
- 26 test files and 533 tests passed;
- README content/license and DSL source-path checks passed;
- README remains synchronized with the npm package README at 1,486 words;
- both explicit-bin and single-bin package resolution ran the packed artifact
  successfully from a clean scratch directory;
- the package tarball contains no `development/` progress artifacts.

## Phase 1B: Database-Enforced Scope

Implemented:

- explicit, backward-compatible source modes:
  `database_scope.application`, `database_scope.postgres_rls`,
  `credential_scope.shared`, and `credential_scope.tenant_resolver`;
- transaction-local, parameterized tenant and principal binding for every
  PostgreSQL runtime read and guarded write transaction;
- fail-closed RLS attestation covering RLS/FORCE, owner/superuser/BYPASSRLS
  roles, operation policies, `USING`/`WITH CHECK`, and both setting names;
- startup and per-pool target preflight, with resolver-backed HTTP-claim
  sessions deferred until verified context exists;
- `doctor --check-rls` metadata reporting plus read-only cross-tenant,
  cross-principal, and pooled-context canaries;
- trusted writeback context reconstructed from the immutable stored proposal
  for apply, reconciliation, bounded sets, and compensation;
- a generic tenant credential resolver whose pools are partitioned by source,
  access, tenant, principal, and non-secret credential identity, with expiry
  and rotation handling;
- a public `@synapsor/runner/runtime` embedding subpath for stdio, Streamable
  HTTP, and legacy JSON-RPC serving with an application-owned resolver;
- stock CLI refusal to load executable resolver modules, plus a documented
  per-tenant process/credential deployment path;
- an honest mode/guarantee matrix, PostgreSQL policy recipe, doctor procedure,
  and MySQL alternatives in `docs/database-enforced-scope.md`.

Canonical ownership:

- these settings are local source/deployment wiring, not portable capability
  semantics, so they belong to Runner config rather than `@synapsor/spec`;
- no DSL, canonical contract, or public protocol record changed.

Verification:

```bash
corepack pnpm build
corepack pnpm exec vitest run packages/config/src/index.test.ts packages/mcp-server/src/index.test.ts packages/postgres/src/index.test.ts apps/runner/src/cli.test.ts
corepack pnpm test:database-scope
corepack pnpm test
node scripts/check-license-content.mjs
./scripts/verify-dsl-source-paths.sh
corepack pnpm --filter @synapsor/runner pack --pack-destination /tmp/synapsor-phase1b-pack.pj1HQn
npm install /tmp/synapsor-phase1b-pack.pj1HQn/synapsor-runner-1.4.123.tgz
node --input-type=module -e "await import('@synapsor/runner/runtime')"
```

Results:

- focused config/MCP/PostgreSQL/CLI suite: 241/241 passed;
- complete Vitest suite: 26 files, 541/541 passed;
- content and DSL-path checks passed after keeping the README at 1,500 words;
- disposable PostgreSQL proof passed for intentionally unscoped SQL denial,
  correct and incorrect tenant/principal access, `WITH CHECK`, pool reset,
  guarded update, bounded set, compensation, and unsafe doctor fixtures;
- packed tarball contains the new guide and runtime JS/types; a clean npm
  install imported all three public runtime functions;
- no development progress file was included in the package.

### Expanded Phase 1B Assurance Addendum

The goal was expanded after the original Phase 1B commit. Reopened and
completed the milestone before continuing later phases.

Implemented:

- one Runner-local assurance descriptor shared by `doctor`, `tools preview`,
  and Streamable HTTP startup, with exact modes `application_scope`,
  `postgres_rls`, and `tenant_bound`;
- structured trusted-context binding diagnostics for `process_bound`,
  `verified_http_session`, and externally verified Cloud sessions;
- explicit remaining-trust-boundary and attacker-class output without changing
  canonical contract semantics;
- prominent warnings when shared signed HTTP sessions still rely only on
  application-level database scope;
- provider-aware doctor checks so `http_claims` no longer incorrectly requires
  process tenant/principal environment variables;
- session-auth readiness checks, including signing-material presence and a
  production recommendation for asymmetric verification;
- startup output that reports non-secret assurance mode without logging tenant,
  principal, token, or database credentials;
- evidence/query-audit provenance recording for reviewed reads and aggregates;
- documentation that rejects query parameters, arbitrary MCP metadata,
  caller-selected tenant headers, and unverified forwarding metadata as
  authority;
- explicit opt-in/adopter-owned RLS policy guidance rather than silent policy
  mutation.

Security verification:

- a signed Streamable HTTP session was invoked with conflicting tenant and
  principal values in the URL query, custom headers, and MCP request metadata;
  the database reader still received only the verified JWT claims;
- session reuse with a different signed identity remained denied;
- cross-tenant and cross-principal evidence handles remained unreadable;
- assurance output accurately retained the compromised-process limitation of
  broad shared credentials and PostgreSQL session-context RLS.

Verification:

```bash
corepack pnpm build
corepack pnpm exec vitest run packages/mcp-server/src/index.test.ts apps/runner/src/cli.test.ts
corepack pnpm test:database-scope
corepack pnpm test
node scripts/check-license-content.mjs
./scripts/verify-dsl-source-paths.sh
corepack pnpm --filter @synapsor/runner pack --pack-destination /tmp/synapsor-phase1b-assurance-pack
npm install --prefix <scratch> /tmp/synapsor-phase1b-assurance-pack/synapsor-runner-1.4.123.tgz
node <scratch>/node_modules/@synapsor/runner/dist/cli.js tools preview --json ...
```

Results:

- focused MCP/CLI suite: 182/182 passed;
- disposable PostgreSQL RLS proof passed;
- complete suite: 26 files, 549/549 passed;
- license/content and DSL source-path checks passed;
- packed scratch install reported `application_scope` and `process_bound`
  through the shipped CLI, shipped the updated database-scope guide, and
  excluded `development/`;
- no spec, DSL, or public protocol schema changed; deployment assurance remains
  Runner-owned local wiring.

## External Actions

None. Do not push, publish, tag, or deploy during this goal.

## Phase 2: True Shadow Studies

Implemented:

- persistent local studies with stable IDs, selected capabilities, optional
  time bounds, status, cases, explicit authoritative outcomes, and
  proposal/evidence references;
- automatic attachment of new shadow proposals to matching active studies,
  restart-safe sync, and safe shared-ledger export/import for the new records;
- deterministic classifications for exact/partial/disagreement, human
  rejection, policy denial, unable-to-propose, stale/conflict, unmatched, and
  invalid/unsafe-scope outcomes;
- deterministic JSON reports with total and comparable denominators,
  amount/value distribution, capability/reason breakdowns, risk-ranked
  disagreements, and inactive sample-size-labeled policy suggestions;
- bounded 2 MiB/10,000-record JSON and JSONL imports whose authoritative
  outcomes are bound to study, request, tenant, object, and optional proposal;
- CLI study lifecycle, case/outcome record/import, stable report export, and
  legacy shadow-command compatibility;
- a protected local-UI shadow report using the existing loopback session
  boundary and the same proposal store;
- six deterministic support/billing reference cases plus explicit outcomes
  for the exact $55 waiver and human rejection;
- task documentation shipped in the Runner tarball.

Security invariants:

- approval and writeback-job creation remain blocked in `ProposalStore` for
  shadow proposals, below CLI/UI routing;
- no shadow command invokes database writeback or an app-owned handler;
- unmatched cases remain visible rather than being inferred as rejection;
- imports and shared-ledger records use the existing secret-material guard;
- report suggestions are data only and always carry `active: false`;
- no canonical contract or DSL meaning changed; study/report state remains
  Runner-owned local evaluation data.

Verification:

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm exec vitest run apps/runner/src/cli.test.ts -t "shadow studies|shadow-study reference|shadow proposals"
node scripts/check-license-content.mjs
corepack pnpm build:runner-package
corepack pnpm --filter @synapsor/runner pack --pack-destination /tmp/synapsor-phase2-pack.sIuJiw
npm install /tmp/synapsor-phase2-pack.sIuJiw/synapsor-runner-1.4.123.tgz
npx --no-install synapsor-runner shadow study create ...
npx --no-install synapsor-runner shadow case import ...
npx --no-install synapsor-runner shadow outcome import ...
npx --no-install synapsor-runner shadow report --json ...
```

Results:

- build/typecheck passed;
- complete suite: 26 files, 546/546 tests passed;
- focused shadow CLI suite: 4/4 passed;
- content/license and DSL path checks passed;
- packed tarball contains `docs/shadow-studies.md` and both reference JSONL
  files, and contains no `development/` progress file;
- clean scratch npm install created a study, imported six cases and two
  outcomes, and reported the expected 6/2/1 totals and every required
  classification.
