# Runner 1.6.0 Progress

Branch: `feature/runner-1.6.0-auto-boundary-explore`

Baseline OSS commit: `9d5d8e5` (`Mark Runner 1.5.4 as published (#37)`)

Baseline Cloud/C++ commit: `097bddd1` (`Split control-panel media routing rule`)

Goal source: `/home/sandesh-tiwari/Desktop/C++/goal.txt`

Goal SHA-256 at start:
`5194e7bdfc244e6c9412649f1704649a15b2dba60ab7930abb48c742a92e519d`

Final handoff: `development/runner-1.6.0-handoff.md`

Target: complete the Runner 1.6.0 Auto Boundary, authoring-only Scoped Explore,
PM-style aggregate exploration, Protect This Query, compatibility, documentation,
and verification goal without publishing, pushing, tagging, releasing, or
deploying.

## Status

| Phase | Status | Evidence |
| --- | --- | --- |
| Baseline and gap audit | complete | Registry/package baselines, CLI inventory, and full OSS suite verified |
| Compatibility scaffolding | complete | Exact published artifact hashes, canonical legacy digests, packed 1.5.4/1.4.4/1.4.2 comparison, established CLI routes, TypeScript authoring, and unchanged legacy `tools/list` pass |
| Auto Boundary and onboarding | complete | Deterministic database/Prisma/Drizzle/OpenAPI/Synapsor evidence graph, DSL-first drafts, lock/diff/status, exact role posture, fresh interactive routing, and 40-table scale gate pass |
| Capability PR Workbench | complete | Secured bulk boundary review, explicit posture/scope decisions, exact-digest activation, Protect review, responsive/a11y checks, and human-reviewed light/dark/mobile/failure screenshots pass |
| Scoped row exploration | complete | Local-only authoring MCP, validated structured plans, read-only transactions, current-lock checks, redacted audit, budget enforcement, and adversarial tests pass |
| Scoped aggregate exploration | complete | Reviewed PM grammar, one-hop FK safety, shared suppression primitive, durable extraction/differencing budgets, bounded comparison, and live golden fixture pass |
| Protect This Query | complete | Successful plans produce expiring encrypted state, public DSL, canonical disabled capability, tests, digest activation, RLS-preserving runtime config, and production execution after Explore shutdown |
| Spec/DSL/C++ parity | complete | Optional default-deny `protected_read` is validated in Spec, C++, and Cloud; public DSL compiles it; Runner loads and executes it; shared cross-repository fixture and round trip pass |
| Documentation and deep dive | complete | README/package README, complete Auto Boundary/Explore/Protect guide, current scope, limitations, onboarding/troubleshooting, DSL/capability/conformance docs, `llms.txt`, Cursor plugin, Cloud website/article/LLM routes, release notes, and the 1.6.0 technical deep dive are reconciled |
| Packed golden journey | complete | Installed tarball passes Workbench activation, Cursor-compatible aggregate MCP, Protect conversion/activation, Explore shutdown, protected production execution, and no-mutation checks |
| Full release verification | complete | Full OSS, packed, live-database, C++/Cloud, Python-baseline, control-panel, round-trip, content, link, lockfile, and package dry-run gates pass |

## Baseline

Published and local versions agree:

- `@synapsor/runner@1.5.4` (`latest` and `next`);
- `@synapsor/dsl@1.4.4` (`latest` and `next`);
- `@synapsor/spec@1.4.2` (`latest` and `next`).

Both repositories started clean on synchronized `main`.

The OSS implementation already contains foundations that this release must
extend rather than duplicate:

- deterministic Prisma, Drizzle, and OpenAPI candidate parsing;
- live database inspection and one-table guided onboarding;
- project detection without executing adopter code;
- canonical Spec, public DSL, and TypeScript authoring;
- fixed privacy-suppressed aggregate capabilities;
- secured local Workbench and digest-bound Safe Action activation;
- Cursor project integration;
- proposal/evidence/query-audit/receipt/replay persistence;
- guarded CRUD, bounded sets, app-owned executors, and Data PR lifecycle;
- database-scope/RLS posture checks and hardened Streamable HTTP auth.

Observed product gaps still to implement:

- candidate generators produce disconnected directories instead of one
  whole-application evidence graph;
- fresh `start --from-env` remains one-table/action oriented;
- generated candidates do not emit one reviewed DSL-first Capability PR;
- there is no canonical generation lock and semantic rescan lifecycle;
- no reviewed temporary structured row/aggregate exploration surface exists;
- no protected-query promotion from audited plan to public DSL capability;
- existing fixed aggregate reads are not a reviewed PM-style exploration
  grammar and do not provide the required anti-differencing session lifecycle.

## Baseline Verification

`corepack pnpm test`:

- TypeScript build passed;
- 41 test files passed;
- 673 tests passed;
- license/content check passed;
- DSL source-path compatibility check passed;
- Cursor plugin verifier passed.

`./bin/synapsor-runner try --yes --no-open --json`:

- completed the deterministic proposal, approval, guarded writeback, receipt,
  and replay path;
- no external account or database required.

`./bin/synapsor-runner start --help`:

- confirms the published guided path still inspects and selects one object;
- captured as compatibility evidence before routing changes.

A quick demo launched concurrently with `try` was refused with
`TRY_STATE_BUSY`, as intended by the existing state lease. Run stateful product
checks sequentially from this point.

## Decisions

- Preserve exact 1.5.4 legacy contract normalization and digest behavior.
- Keep existing CLI routes authoritative; Auto Boundary is only the fresh,
  interactive, selector-free route.
- Reuse the current parsers, inspectors, Workbench, stores, aggregate executor,
  and DSL compiler.
- Treat the exploration boundary as canonical authority and each exploration
  plan as transient runtime input.
- Represent promoted named reads with one optional, default-deny
  `protected_read` authority object on a canonical capability. Do not broaden
  the legacy scalar `aggregate` object or turn the Spec into a general query
  AST.
- Keep the existing `read` and `aggregate_read` kinds. A protected capability
  freezes a reviewed row or aggregate shape, generation-lock bindings, privacy
  limits, and only explicitly selected bounded arguments. Legacy capabilities
  omit `protected_read` and therefore retain their exact normalized form and
  digest.
- Keep Scoped Explore local, explicit development/staging only, disabled by
  default, and absent from shared/remote/production MCP surfaces.
- Implement PM aggregates through the existing privacy-suppressed machinery,
  not a second analytics executor.
- The measured golden aggregate uses three reviewed measures, two dimensions,
  one weekly bucket, two fixed time ranges, and one reviewed many-to-one
  relationship. Its reviewed default complexity ceiling is 24; models cannot
  widen it.
- Do not redesign writeback, add a generic query AST, add a general join
  planner, or implement deferred integrations.

## Current Verification

`corepack pnpm test:auto-boundary-explore` passes end to end against the
synthetic PostgreSQL + Next.js + Prisma churn fixture:

- exact two-tool authoring surface: `app.describe_data`,
  `app.explore_data`;
- serialized `tools/list`: 6,325 bytes, about 1,582 estimated tokens;
- reviewed PM aggregate returned five groups and suppressed two sub-threshold
  groups;
- cross-tenant rows, kept-out values, arbitrary identifiers, model-selected
  tenant, unreviewed joins, and excessive top-N were refused;
- Protect emitted public `.synapsor.sql` and canonical JSON in a disabled
  draft;
- exact digest activation disabled Scoped Explore;
- production advertised only
  `analytics.churn_contributors_by_week`;
- the protected capability retained suppression and reviewed PostgreSQL RLS
  session bindings after Explore shutdown;
- source database snapshot was unchanged.

Focused TypeScript build/typecheck and Auto Boundary, Scoped Explore, Protect,
Workbench, generated-authority, and protected-read tests pass. A live fixture
also found and fixed:

- PostgreSQL `pg_policies.roles` structured normalization;
- exact RLS setting-to-scope association;
- deterministic schema fingerprints without `undefined`;
- protected-read query fingerprints without optional `undefined` values;
- Docker fixture readiness across PostgreSQL's initialization restart.

Cross-repository canonical parity now passes:

- `@synapsor/spec` validates the shared protected PM aggregate fixture;
- C++ validates and normalizes the fixture without changing it;
- the Python Cloud registry stores and retrieves the canonical authority;
- all three validators reject model-selected tenant fields, fan-out
  relationships, raw SQL fields, and missing protected-read query audit;
- the Runner round trip advertises only the named protected capability and
  executes it through the mocked canonical runtime path;
- tool preview shows reviewed measures, dimensions, group limits, and cohort
  suppression instead of legacy scalar-aggregate placeholders;
- the full `scripts/verify_contract_roundtrip.sh` gate passes.

Published compatibility now passes:

- exact npm SHA-1 baselines are pinned for Runner 1.5.4, DSL 1.4.4, and
  Spec 1.4.2;
- seven published contract fixtures retain their exact source and canonical
  SHA-256 digests;
- four published DSL sources compile to their exact prior canonical digests;
- current packed artifacts preserve the complete legacy `tools/list`;
- existing `init --answers`, `onboard db --answers`, `start --answers`,
  `start --inspection-json --table`, help, exit-code, and TypeScript-authoring
  paths stay noninteractive and compatible;
- legacy projects gain no generation lock, Workbench migration, rescan, or
  implicit authority.

Scale, adversarial, and visual gates now pass:

- a deterministic 40-table catalog produces 40 disabled candidates while an
  activated three-resource pack still advertises exactly two authoring tools;
- `tools/list` is 6,359 bytes, about 1,590 estimated tokens, below the 8,000
  byte and 2,000 token budgets;
- unactivated resources are absent and `app.describe_data` remains bounded and
  paginated;
- raw SQL, kept-out field use, tenant/principal overrides, unsupported
  operators/functions, excessive measures/dimensions/ranges/top-N, stale locks,
  production/unknown profiles, nonlocal HTTP, response extraction, request
  rate, and differencing attacks fail closed;
- source failures are redacted and durable rate accounting uses the persisted
  audit timestamp;
- Workbench automated DOM checks pass with no unlabeled controls, duplicate
  IDs, overflow, or missing lifecycle states;
- screenshots under ignored
  `development/runner-1.6.0-visual/` were inspected at desktop light, desktop
  dark, mobile light, loading, Protect-empty, keyboard-focus, and drift-failure
  states.

The packed release artifact now passes the full black-box product journey:

- the tarball contains its PostgreSQL + Next.js + Prisma churn fixture;
- packed CLI drafting starts disabled and no source-row values appear in
  generated authority;
- the secured Workbench narrows and activates the exact boundary digest;
- packed stdio MCP exposes only `app.describe_data` and `app.explore_data`;
- all aggregate denial, suppression, differencing, and hard-limit checks pass;
- Workbench discovers the recent aggregate through an internal `query_ref`,
  with no copied ID and no credential/token redaction conflict;
- Protect creates public DSL, canonical JSON, contract tests, and a disabled
  named capability before exact-digest human activation;
- disabling Explore prevents authoring restart while production advertises only
  `analytics.churn_contributors_by_week`;
- the protected production capability retains five reviewed groups, two
  suppressed cohorts, RLS scope, and zero source mutation;
- normalized audit is durable and queryable without result rows, trusted scope
  values, credentials, or kept-out literals.

Documentation and public-copy reconciliation now covers:

- the audit-first OSS front door and one primary fresh onboarding path;
- deterministic whole-schema drafting without LLMs or adopter-code execution;
- explicit fresh-interactive versus established/headless CLI routing;
- the two-tool local authoring surface and strict production absence;
- the reviewed PM aggregate cube, one-hop relationship constraints, cohort
  suppression, extraction/differencing budgets, and descriptive-not-causal
  wording;
- Protect output, digest activation, production handoff, and drift lifecycle;
- exact published-baseline versus prepared-candidate version language;
- public DSL protected-read grammar and Spec/C++/Cloud parity;
- the website homepage, OSS docs surface, technical article, `llms.txt`, and
  `llms-full.txt`;
- `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md`, including
  internals, structured plan examples, package responsibilities, compatibility,
  security assumptions, release history, and honest limits.

## Final Verification

OSS and packed artifacts:

- `corepack pnpm install --frozen-lockfile`: lockfile current; no changes.
- `corepack pnpm test`: 47 files and 709 tests passed, followed by the
  license/content, DSL source-path, and Cursor plugin gates.
- `corepack pnpm test:smoke`: complete Runner 1.6.0 release gate passed,
  including 377 focused release tests, current Claude Code/Codex MCP config
  parsing, disposable Docker first-run proof, public checkout commands, local
  Runner, packed Runner, packed own-database journey, content scan, package dry
  run, and `git diff --check`.
- `corepack pnpm test:auto-boundary-explore`,
  `test:auto-boundary-explore:packed`, `test:auto-boundary-scale`,
  `test:auto-boundary-visual`, and `test:published-compatibility`: passed.
- Guarded CRUD, bounded set, reversible, principal/database scope, aggregate
  read, contract conformance, two-runner fleet, live apply, app-owned executor,
  and Cloud-linked MCP suites: passed sequentially.
- Packed network authentication, lifecycle inspection, principal scope,
  backward compatibility, and own-database checks: passed.
- The final packed PM aggregate run used a fresh isolated npm cache followed by
  that cache's warm path. Measured results, excluding the unpublished candidate
  tarball download:
  - fresh package installation: 5,307 ms;
  - warm-cache installation: 4,930 ms;
  - first useful own-data answer: 10,863 ms;
  - first generated Data PR: 11,634 ms;
  - first digest-activated protected capability: 11,694 ms.
- The final authoring `tools/list` contains exactly `app.describe_data` and
  `app.explore_data`: 6,325 bytes, about 1,582 estimated tokens. Production
  contains only `analytics.churn_contributors_by_week`.
- The PM aggregate returned five reviewed groups, suppressed two small cohorts,
  exposed no kept-out/customer identifiers, exhausted repeated-differencing
  budget as expected, and left the source database unchanged.
- Markdown audit: 157 local links across 20 changed documentation files resolve.
- Package dry runs:
  - Spec 1.5.0: 43.2 kB packed, 236.5 kB unpacked, 82 files;
  - DSL 1.5.0: 24.9 kB packed, 108.3 kB unpacked, 13 files;
  - Runner 1.6.0: 1.3 MB packed, 6.0 MB unpacked, 273 files.

Cloud/C++ and public site:

- `cmake --build build -j 8`: complete C++ build passed.
- `ctest --test-dir build --output-on-failure`: 1,071/1,071 tests passed.
- `python3 -m unittest tests.aws_v1_control_plane_test`: 274 tests ran with
  exactly the five documented baseline failures and no branch-introduced
  failure. The failures remain the public-demo source-id expectation,
  elevated-privilege external alias expectation, MySQL external alias
  expectation, CDC runtime URL fixture, and Postgres external alias
  expectation.
- `SYNAPSOR_RUNNER_REPO=... ./scripts/verify_contract_roundtrip.sh`: 23 focused
  C++ contract tests and every C++-to-Spec-to-Runner fixture passed, including
  `protected-read-aggregate`.
- Control-panel typecheck and lint passed; Vitest passed 29 files and 117 tests.
- The production Next.js build passed and generated 108 pages, including the
  technical article, sitemap, robots, `llms.txt`, and `llms-full.txt`.
- Both repositories pass `git diff --check`.

No package, tag, release, push, AWS deployment, plugin submission, or other
external publication was performed. The candidate remains on local feature
branches. Physical macOS and Windows execution and true post-publication npm
tarball-download timing remain manual follow-up checks; Linux path/space
behavior and packed artifacts are covered here.

## Resume Instructions

1. Read `/home/sandesh-tiwari/Desktop/C++/goal.txt`.
2. Read this file.
3. Confirm the OSS branch is
   `feature/runner-1.6.0-auto-boundary-explore`.
4. Run `git status --short --branch` in both repositories and preserve unrelated
   changes.
5. Run the complete sequential OSS, C++, Python, packed, docs/link, secret,
   package-content, and dry-run release suite. Do not push, publish, tag,
   deploy, or create releases without explicit authorization.
