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
| 3: MCP App | complete | 551 tests, packed install, unsigned MCPB build/unpack/runtime discovery passed |
| 4: effect regression | complete | 564 tests, stable JSON/JUnit and packed fixture checks passed |
| 5: audit funnel | complete | 569 tests, SARIF and disabled packed candidate generation passed |
| 6: schema candidates | complete | 576 tests, malicious fixtures and packed Prisma generation passed |
| 7: reference experience | complete | Hardened PostgreSQL/RLS demo, strict shadow, human outcomes, effect regression, legacy reference, and 576 tests passed |
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

## Pause Checkpoint - 2026-07-19

The user intentionally paused the goal during Phase 3 and subsequently resumed
it. Continue from this checkpoint; do not repeat completed phases.

Branch:

```text
feature/runner-1.5-developer-experience
```

Completed milestone commits:

```text
ada9a6f Phase 1: add one-command guarded action proof
1140b8b Phase 1B: add database-enforced PostgreSQL scope
4acbaed Phase 2: productize local shadow studies
6b6078f Phase 1B: report tenant isolation assurance
```

Uncommitted partial Phase 3 files at pause time:

```text
M  apps/runner/src/local-ui.ts
M  packages/mcp-server/package.json
M  packages/mcp-server/src/index.ts
M  pnpm-lock.yaml
?? packages/mcp-server/src/proposal-app.ts
?? packages/mcp-server/src/proposal-review-view.ts
```

Partial Phase 3 implementation:

- added pinned `@modelcontextprotocol/ext-apps@1.7.4`;
- confirmed the stable MCP Apps spec is `2026-01-26`;
- registered proposal tools with official MCP Apps UI metadata;
- registered an official `text/html;profile=mcp-app` resource;
- created a responsive display-only proposal card using the standard
  `ui/initialize` and `ui/notifications/tool-result` protocol messages;
- centralized the proposal review payload in
  `packages/mcp-server/src/proposal-review-view.ts`;
- changed the standalone local UI to consume that shared payload;
- enriched proposal tool results with `proposal_review`;
- preserved the security boundary: no approve/apply model tools and no
  privileged review token/challenge in text, structured content, resource URI,
  query string, or app source;
- selected display-only fallback because the inspected official SDK exposes
  presentation metadata but no documented model-hidden authority channel.

Build verification completed:

```bash
corepack pnpm --filter @synapsor-runner/mcp-server build
corepack pnpm --filter @synapsor/runner build
```

Both passed.

Completed after resume:

- official in-memory MCP client/transport compatibility coverage;
- proposal-tool UI metadata and app-resource MIME/read coverage;
- standard Apps initialize/tool-result schema validation;
- text fallback, shared review payload, local UI reuse, and no-secret/no-authority
  assertions;
- focused MCP App and local UI tests: 2 files, 80 tests passed.

This checkpoint is superseded by the completed Phase 3 record below. Continue
sequentially with Phase 4.

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

## Phase 3: Inline MCP App Proposal Review

Implemented:

- pinned official `@modelcontextprotocol/ext-apps@1.7.4` against the stable
  MCP Apps `2026-01-26` protocol;
- official proposal-tool App metadata and one
  `text/html;profile=mcp-app` resource at
  `ui://synapsor/proposal-review.html`;
- a responsive display-only proposal card showing trusted scope, exact diff,
  evidence/guard state, expected version, policy, receipt, reversibility, and
  the standalone operator handoff;
- one shared proposal review view model consumed by both the App and the
  loopback local UI;
- structured `proposal_review` tool results plus unchanged text fallback for
  hosts without Apps support;
- client-config diagnostics that explain automatic App discovery without
  altering or contaminating generated JSON;
- official in-memory MCP client compatibility tests for tool/resource
  discovery, metadata, resource reads, Apps initialize/tool-result messages,
  fallback output, and the continued absence of model-callable
  approval/apply/raw-SQL tools;
- `docs/mcp-apps.md` with exact versions, upstream-listed versus locally
  tested hosts, the display-only security rationale, fallback behavior, and
  operator workflow;
- an unsigned standard-profile MCPB build using
  `@anthropic-ai/mcpb@2.1.2`, manifest `0.4`, user-config placeholders, a
  frozen-lockfile hoisted production dependency layout, path/credential
  scans, digest/build metadata, and explicit `signed: false`;
- an independent unpacked-MCPB verifier that launches the artifact with the
  official MCP client and proves semantic tools plus the App resource;
- refreshed dependency-license counts and packed-install assertions that the
  MCP Apps guide ships while `development/` does not;
- updated packed-runner checks for the Phase 1 `try` ledger/IDs after the old
  quick-demo fixture was retired.

Security decisions:

- the inline App is presentation-only because the selected stable protocol
  does not document a model-hidden privileged authority channel;
- no approval token, review challenge, database credential, tenant secret, or
  reusable operator authority appears in tool results, resource metadata,
  resource HTML, resource URIs, or generated client JSON;
- approval and apply remain outside MCP in the loopback operator UI or trusted
  terminal;
- unsigned MCPB output is never presented as an official signed release, and
  release-owner signing remains a separate explicit action.

Verification:

```bash
corepack pnpm exec vitest run packages/mcp-server/src/index.test.ts apps/runner/src/local-ui.test.ts apps/runner/src/cli.test.ts
corepack pnpm test
git diff --check
corepack pnpm verify:packed-runner
corepack pnpm build:mcpb
corepack pnpm verify:mcpb
corepack pnpm exec mcpb info dist/mcpb/synapsor-runner-1.4.123-unsigned.mcpb
corepack pnpm licenses list --json
```

Results:

- focused MCP/App/local-UI/CLI suite: 3 files, 188/188 passed;
- complete suite: 26 files, 551/551 passed;
- typecheck, license/content, and DSL source-path checks passed;
- real npm tarball scratch install passed current `try`, audit, contract,
  MCP-config, handler, activity, store, and Streamable HTTP checks;
- tarball includes `docs/mcp-apps.md` and excludes `development/`;
- unsigned MCPB built at 7,617,355 bytes, validated, unpacked, and reported
  `WARNING: Not signed` as intended;
- unpacked MCPB started Runner `1.4.123`, negotiated MCP, listed the three
  support semantic tools, advertised/read the App resource with the standard
  MIME type, and exposed zero model-facing approval/apply tools;
- the license inventory now covers all current build/runtime dependencies,
  including the official Apps and MCPB tooling.

## Phase 4: Agent Business-Effect Regression

Implemented:

- a Runner-owned, versioned `synapsor.effect-fixture.v1` artifact created from
  a proposal replay, stored proposal, or shadow-study case;
- separate versioned provider-neutral result and dataset formats, with public
  JSON Schemas under `schemas/`;
- replay evidence snapshots that reuse existing ledger data and record that
  evaluation made no new source read;
- fail-closed secret scanning, kept-out field checks, fixture digests, bounded
  2 MiB files, bounded 1,000-case datasets, duplicate-ID checks, and
  dataset-path containment;
- offline comparison of capability calls/surface expansion, trusted context,
  model-controlled tenant/principal arguments, target, exact business diff,
  policy, hidden fields, conflict/block code, result category, contract
  version, source reads, and source mutation;
- stable terminal, JSON, and JUnit reports with nonzero failure status;
- CLI commands:
  `effect fixture create`, `effect result init`, `effect run`,
  `effect compare`, and `effect accept`;
- an explicit acceptance workflow requiring actor, reason, `--yes`, and
  either `--in-place` or a separate output file, with before/after baseline
  digests in history;
- non-waivable acceptance failures for fixture identity, source mutation,
  new reads, trusted-context drift/override, and hidden-field exposure;
- a deterministic support late-fee pass/fail dataset under
  `fixtures/effects/`;
- `docs/effect-regression.md`, CLI help, task-index linkage, and packed
  documentation/assets.

Architecture decision:

- effect fixtures/results are local evaluation artifacts owned by Runner, not
  canonical capability semantics, so this phase did not change
  `@synapsor/spec`, `@synapsor/dsl`, or the public writeback protocol;
- contract conformance remains a separate test kind; effect evaluation
  imports observations from any provider/application harness and deliberately
  does not become an agent workflow engine or provider SDK;
- Runner does not execute adopter code, invoke an LLM, query a source, approve
  a proposal, or apply a write during effect comparison.

Verification:

```bash
corepack pnpm typecheck
corepack pnpm vitest run \
  apps/runner/src/effect-regression.test.ts \
  apps/runner/src/effect-cli.test.ts
corepack pnpm test
corepack pnpm runner effect run \
  --dataset ./fixtures/effects/dataset.json \
  --results-dir ./fixtures/effects/results
corepack pnpm runner effect run \
  --dataset ./fixtures/effects/dataset.json \
  --results-dir ./fixtures/effects/changed
corepack pnpm build:runner-package
node apps/runner/dist/cli.js effect run \
  --dataset ./fixtures/effects/dataset.json \
  --results-dir ./fixtures/effects/results \
  --format junit
./scripts/verify-packed-runner.sh
```

Results:

- focused effect suite: 2 files, 13/13 passed;
- complete suite: 28 files, 564/564 tests passed;
- typecheck, license/content, and DSL source-path checks passed;
- the matching reference dataset passed and the changed fee/policy dataset
  failed with `BUSINESS_DIFF` and `POLICY_DECISION`;
- built JUnit output reported 14 checks and zero failures;
- real npm tarball scratch installation contains the three effect schemas,
  effect guide, pass/fail fixtures, and built command, while excluding
  `development/`;
- packed matching/changed result checks behaved identically to source.

Test-runner note:

- the first complete run oversubscribed the machine because the initial new
  tests invoked the full embedded `try` flow three additional times; several
  unrelated 5-second SQLite/UI tests timed out, one timeout temporarily left
  `process.cwd()` in a removed fixture directory, and that caused cascading
  `ENOENT` failures;
- the new tests were corrected to create real replay records directly through
  `ProposalStore`, removing unnecessary source/demo work; the subsequent
  unmodified complete test command passed all 564 tests.

## Phase 5: Audit Adoption Funnel

Implemented:

- retained the existing `synapsor.mcp-audit.v1` finding/JSON contract and its
  single manifest parser;
- changed default terminal output to group repeated findings into the top three
  distinct root causes with affected tools, blast radius, and one next action;
- retained complete finding output behind `--verbose` and Markdown;
- added deterministic SARIF 2.1.0 derived from the same findings;
- added a redacted structural tool view from the same parser, excluding raw
  descriptions, examples, defaults, enum values, and input values;
- redacted URL credentials/query fragments, stdio arguments, secret-looking
  assignments, and common token forms from report targets/tool names;
- added explicit
  `audit generate <target> --output <separate-directory>` candidate generation;
- emitted a canonical `@synapsor/spec` contract, source-less strict-shadow
  Runner scaffold, deny/redaction/operator-boundary tests, before/after model
  tool surfaces, and a required review checklist;
- made generated proposal candidates fail closed with three independent
  barriers: `writeback.mode: none`, Runner `mode: shadow`, and an empty source
  map;
- used conspicuous `review_required_*` identifiers and
  `blocked_unreviewed` extensions instead of inventing schema, tenant,
  principal, field, write, or approval authority;
- removed authority-bearing SQL/identifier/trust/credential fields from
  generated model arguments and recorded review TODOs;
- made generation byte-deterministic, rejected existing output by default, and
  allowed `--force` only for a directory carrying Runner's ownership marker;
- published JSON Schemas for audit reports and candidate-directory markers;
- documented the concise/verbose/SARIF modes and the deliberate activation
  workflow;
- extended the real packed-runner verifier through SARIF and candidate
  generation, including no-overwrite and no-write-authority checks.

Architecture decision:

- audit reports and generated review scaffolds are Runner-owned adoption
  artifacts; generated capabilities themselves are canonical
  `@synapsor/spec` documents;
- candidate generation adds no new contract meaning and does not create a
  second scanner, runtime config dialect, proposal store, or activation path;
- business semantics that cannot be inferred become TODOs, never executable
  authority.

Verification:

```bash
corepack pnpm typecheck
corepack pnpm exec vitest run \
  packages/worker-core/src/index.test.ts \
  apps/runner/src/audit-candidates.test.ts
corepack pnpm exec vitest run apps/runner/src/cli.test.ts \
  -t "audits the built-in dangerous MCP|MCP audit candidate"
corepack pnpm test
./scripts/verify-packed-runner.sh
git diff --check
```

Results:

- focused audit/candidate suite: 16/16 passed;
- focused CLI audit test passed;
- complete suite: 29 files, 569/569 tests passed;
- typecheck, license/content, and DSL source-path checks passed;
- real npm tarball scratch install produced concise, verbose, JSON, Markdown,
  and SARIF reports, generated the canonical disabled candidate directory,
  proved every proposal writeback remained `none`, and refused implicit
  overwrite;
- packed tarball contains both audit schemas and excludes `development/`.

Test-stability note:

- one verification rerun hit the pre-existing 5-second timeout in the first
  local-UI integration test; the immediately preceding full run had passed that
  test in 4.99 seconds;
- the test already performs several real loopback HTTP/SQLite operations, so
  its explicit timeout was raised to 15 seconds (matching other integration
  tests), the isolated suite passed 4/4, and the final unmodified full command
  passed all 569 tests.

## Phase 6: Reviewed Schema And API Candidates

Implemented:

- focused `init from-prisma`, `init from-drizzle`, and `init from-openapi`
  commands that require a separate output directory;
- deterministic canonical `@synapsor/spec` candidate contracts plus a
  source-less strict-shadow Runner scaffold, deny/redaction/operator-boundary
  tests, stable JSON review report, and human review checklist;
- conspicuous unresolved tenant, principal, visible-field, conflict, source,
  reviewer, and write-field placeholders rather than inferred authority;
- proposal candidates with `writeback.mode: none`, no configured source, and
  `blocked_unreviewed` markers;
- review output separating structural primary/version hints, potential
  tenant/principal fields, potentially sensitive/kept-out suggestions,
  business-logic needs, and app-handler needs;
- bounded structured Prisma parsing that ignores datasource credentials,
  defaults, enum values, generators, plugins, and model relations;
- bounded OpenAPI 3 JSON/YAML parsing with local component-schema references
  only and no server URL, example, default, enum, callback, webhook, or
  credential copying;
- conservative Drizzle `pgTable`/`mysqlTable` analysis through the TypeScript
  AST without importing, transpiling, type-checking, resolving, or executing
  adopter code;
- 2 MiB input, 50-object, 128-field, 200-capability, AST-node, structure-node,
  and recursion bounds;
- no-overwrite behavior, with `--force` accepted only for directories carrying
  the matching Runner ownership marker;
- public JSON Schemas for marker and review output, malicious fixtures, task
  documentation, README/docs-index links, CLI help, and packed-install
  generation coverage.

Architecture and packaging decisions:

- inferred capability documents use the canonical contract; no Runner-only
  capability dialect or new portable semantics were introduced;
- generator review/marker files are local Runner adoption artifacts;
- `typescript@5.9.3` and `yaml@2.8.1` are pinned runtime dependencies but are
  external to the bundled ESM CLI and loaded only by the generator path;
- scratch-install verification caught and prevented broken ESM dynamic
  requires when those parsers were initially bundled; the final main bundle
  is 2.9 MB uncompressed rather than 12.6 MB.

Verification:

```bash
corepack pnpm typecheck
corepack pnpm vitest run apps/runner/src/schema-candidates.test.ts
corepack pnpm build:runner-package
corepack pnpm test:license-content
corepack pnpm verify:packed-runner
corepack pnpm test
git diff --check
```

Results:

- focused generator suite: 7/7 passed across Prisma, Drizzle, and OpenAPI;
- malicious Drizzle input did not execute its file-write side effect and read
  only the explicitly requested input, not an adjacent secret;
- external OpenAPI references, dynamic Drizzle table names, oversized inputs,
  implicit overwrite, and forced overwrite of unowned directories failed
  closed;
- generated contracts passed the canonical validator and review/marker
  documents passed their public JSON Schemas;
- complete suite: 30 files, 576/576 tests passed;
- typecheck, content/license, DSL source-path, documentation-link, and packed
  scratch-install checks passed;
- a real installed tarball generated blocked Prisma candidates and shipped the
  fixtures, schemas, and guide while excluding `development/`.

## Phase 7: Support/Billing Reference Experience

Implemented:

- promoted `examples/support-billing-agent` as the compact flagship live
  database proof while keeping the embedded no-Docker `try` source separate;
- aligned the example around ticket `SUP-184`, invoice `INV-3001`, and an
  exact `late_fee_cents: 5500 -> 0` ($55) business effect;
- added a reviewer-fixed `assigned_to` principal row lock alongside tenant
  scope for customer, ticket, and invoice capabilities;
- enabled and forced PostgreSQL RLS on the three scoped tables, with separate
  least-privilege reader and writer policies bound to transaction-local trusted
  tenant and principal settings;
- reduced database grants to explicit readable columns and seeded
  `card_token` and `internal_risk_note` values that the live test proves never
  enter the model-facing response;
- made the live command require a passing `doctor --check-rls` canary before
  serving tools;
- expanded the shared smoke to prove exact tool exposure, scoped invoice and
  ticket evidence, no unsafe tools, tenant-argument spoof rejection,
  cross-tenant denial, same-tenant cross-principal denial, exact proposal diff,
  no pre-approval mutation, manual approval, one-row guarded writeback,
  idempotent retry, stale-version conflict, and complete replay linkage;
- added a strict-shadow proof that creates a real shadow proposal, rejects
  approval, and leaves PostgreSQL unchanged;
- added an idempotent `make evaluate` path that imports six packaged shadow
  cases, compares two authoritative human outcomes, and runs the reference
  business-effect regression fixture;
- made `make demo` run both the live database boundary and deterministic
  shadow/effect evaluation in one command;
- documented the exact guarantees and the important limit that PostgreSQL RLS
  is defense in depth, not protection from a process that can select arbitrary
  trusted context or replace credentials;
- parameterized the shared smoke's ticket and principal-scope checks so the
  smaller legacy reference fixture remains unchanged and supported.

Architecture decision:

- the production-oriented variant uses existing Runner source configuration
  and the canonical capability surface; no new spec/DSL semantics or workflow
  engine were introduced;
- the direct guarded single-row update remains appropriate for the late-fee
  waiver; app-owned handlers remain reserved for behavior outside Runner's
  supported guarded write paths.

Verification:

```bash
bash -n \
  examples/support-billing-agent/scripts/run-demo.sh \
  examples/support-billing-agent/scripts/run-evaluation.sh
examples/support-billing-agent/scripts/run-evaluation.sh
make -C examples/support-billing-agent demo
corepack pnpm test:reference-app
corepack pnpm test
git diff --check
```

Results:

- the disposable PostgreSQL/RLS live proof passed twice, including the
  live-attestation canary and adversarial scope checks;
- deterministic shadow/human-outcome and effect checks passed repeatedly from
  a clean evaluation store;
- the legacy reference application passed after the shared smoke was made
  fixture-parameterized;
- complete suite: 30 files, 576/576 tests passed;
- typecheck, license/content, and DSL source-path checks passed;
- Docker resources were removed after every live run.
