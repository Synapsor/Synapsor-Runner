# Runner 1.5.3 progress

Updated: 2026-07-21T08:39:35Z

## Objective

Implement and honestly verify the complete Runner 1.5.3 Intent to Safe Action
adoption release defined by:

`/home/sandesh-tiwari/Desktop/C++/goal.txt`

Preserve the canonical contract shared by JSON, the SQL-like DSL, the
code-first TypeScript API, Runner, and Cloud. Keep activation, approval, apply,
commit, credentials, and trusted tenant/principal authority outside the
model-facing MCP surface.

Do not push, merge, publish, tag, release, deploy, submit to a marketplace,
change npm dist-tags, or change live AWS state without explicit authorization.

## Goal evidence

- Goal SHA-256:
  `3ee4ccd48c97f690fccd9705092e359b6eead548a7e67920e9dc0dc2e97f38c8`
- Final handoff SHA-256:
  `b605664b856155a3c74ef11dbfa962b5ec5948229365119871ca1fc71909f32f`
- Goal target: `@synapsor/runner@1.5.3`
- Goal branch: `release/runner-1.5.3-intent-to-safe-action`
- Website branch: `release/runner-1.5.3-website`

## Baseline repositories

### OSS Runner

- Path: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`
- Verified base: `78576718b8725b6c9a4fdb8e7be9fc44dbab3f6f`
- Base subject: `Add Runner first safe action workflow`
- Branch created from base:
  `release/runner-1.5.3-intent-to-safe-action`
- Base GitHub CI run `29798587795`: passed.
- Worktree was clean before branch creation.

### Website, Cloud, and C++

- Path: `/home/sandesh-tiwari/Desktop/C++/Synapsor`
- Verified base: `764d284633cd3fcc634c21bac5e949b4c9efda14`
- Base subject: `Document Runner first safe action`
- Branch created from base: `release/runner-1.5.3-website`
- Worktree was clean before branch creation.

## Baseline versions and environment

- Root workspace: `1.5.2`
- `@synapsor/runner`: `1.5.2`
- `@synapsor/spec`: `1.4.2`
- `@synapsor/dsl`: `1.4.3`
- Node: `v22.22.2`
- pnpm: `10.14.0`
- npm: `11.8.0`
- Host: `Linux 6.17.0-40-generic x86_64`
- Disk at start: 344 GB total, 279 GB used, 48 GB available.

## Live external state at start

Checked 2026-07-21 UTC:

- Runner npm `latest=next=1.5.0`.
- Spec npm `latest=next=1.4.2`.
- DSL npm `latest=next=1.4.3`.
- Runner 1.5.1, 1.5.2, and 1.5.3 are not published.
- The only local Runner Git tag is `v1.0.0`.
- OSS `main` is synchronized with GitHub at `7857671`.
- Website/Cloud `main` is synchronized with GitHub at `764d2846`.
- No npm publication, Git tag, GitHub release, marketplace submission, website
  deployment, or AWS state change is authorized by the current goal.

## Baseline handoff evidence to reproduce

The 1.5.2 handoff reports:

- full OSS suite: 38 files, 613/613 tests;
- release gate: 348/348 focused tests plus Docker-backed local, packed, and
  packed-own-PostgreSQL flows;
- PostgreSQL/MySQL onboarding, guarded writeback, conformance, aggregate,
  trusted-scope, fleet, recovery, and Cloud-linked smoke coverage;
- website typecheck, lint, 117/117 tests, and 107-page production build;
- no publication or deployment.

These are claims to reproduce, not proof by themselves.

## Phase status

- Phase 0, verify 1.5.2 foundation: completed.
- Phase 1, Safe Action Composer: completed and verified from the exact packed
  candidate, including restricted static TypeScript parsing, disabled draft,
  deterministic tests, real disposable-PostgreSQL effect preview, and no
  active-tool or source mutation.
- Phase 2, portable agent authoring instructions: completed with one canonical
  source and thin Cursor, Codex, and Claude project wrappers.
- Phase 3, live draft validation and explicit activation: completed with watch,
  LSP diagnostics, digest-addressed draft/active state, exact non-mutating
  staging preview, token/CSRF-protected Workbench activation, immutable active
  snapshots, proposal digest pinning, and an honest reconnect fallback.
- Phase 4, Cursor plugin and `/synapsor-protect`: locally complete and package
  ready in the current official Cursor plugin format. Deterministic package,
  install, reinstall, path-with-spaces, configuration-preservation, and clean
  uninstall checks pass. Manual stable-Cursor GUI and Marketplace review remain
  explicit owner launch gates.
- Phase 5, audit adoption funnel: completed with the evidence-labeled authority
  map, static and explicitly consented selected-server bypass inspection,
  text/JSON/Markdown/SARIF, fixtures, remediation links, and GitHub Actions.
- Phase 6, team and retention loop: completed. The checked-in action and
  generated tests pass 10 static and 3 live disposable-PostgreSQL assertions in
  text, JSON, and JUnit while leaving source data and active authority unchanged.
- Phase 7, verified client/framework recipes: completed for the evidence levels
  documented in the host matrix. Recipes are syntax/secret checked, current
  Claude Code and Codex parsers accept their configuration, standard MCP is
  protocol-tested, and a live proposal call leaves source data unchanged.
- Phase 8, README/website/demo/discovery: completed in source and verified with
  tests, production build, browser, metadata, sitemap, `llms.txt`, and links.
  AWS deployment remains an owner-authorized action.
- Phase 9, packaging and release preparation: completed locally for the exact
  1.5.3 candidate, including cold/global installs, supported Node containers,
  content/secret scans, zero-vulnerability production audit, CycloneDX SBOM,
  release copy, and owner commands. Publication/provenance/tag/release remain
  owner actions.
- Final requirement-by-requirement audit: completed for the release candidate;
  non-automatable owner launch gates are listed separately and are not claimed.

## Initial decisions

- Use existing Runner `start`, Workbench, authoring, activation, Cursor, audit,
  shadow, and effect-regression surfaces rather than creating parallel product
  models.
- Keep Spec and DSL versions unchanged unless implementation proves a genuine
  canonical-contract requirement.
- Treat 1.5.2 as a required packed baseline and distinguish any prerequisite
  defect from new 1.5.3 work.
- Measure product activation separately from cold registry download time.
- Do not claim Cursor inline MCP Apps support without current, reproduced host
  evidence.
- Do not let a coding agent activate drafts, alter active runtime snapshots, or
  gain approval/apply authority through MCP, files, generated commands, or
  configuration changes.
- Parse the agent-authored TypeScript action through a restricted static AST.
  Never import or execute the file during validation.
- Keep `start --action` as the product entry point. `action validate/watch/status`
  are technical support commands; there is intentionally no CLI activation
  command.
- Store compiled drafts and active contracts as digest-addressed canonical JSON.
  Activation changes the config only through the token/CSRF-protected localhost
  Workbench after a matching non-mutating staging proposal preview.
- Pending local proposals fail closed at apply when their pinned contract digest
  no longer matches the active reviewed capability.

## Commands and results

### Initial audit

- `git status --short --branch` in both repositories: clean on `main`.
- npm metadata queries: passed; live versions recorded above.
- GitHub main CI query: `7857671` passed.
- Branch availability checks: both 1.5.3 branch names were unused locally and
  remotely.
- Created both dedicated branches from their verified bases.

### Reproduced 1.5.2 full suite

- Command: `corepack pnpm test`
- Result: passed.
- Vitest: 38/38 files and 613/613 tests passed.
- Duration: 132.18 seconds.
- License/content check: passed.
- Preferred `.synapsor.sql` source-path check: passed; `.synapsor`
  compatibility preserved.
- Concurrency-sensitive signed Streamable HTTP session isolation and
  cross-process SQLite writer contention passed without timeout changes.
- No pre-existing baseline failure was observed in the full suite.

### Reproduced 1.5.2 release gate

- Command: `./scripts/verify-release-gate.sh 1.5.2`
- Result: passed uninterrupted.
- Typecheck: passed.
- Focused release suite: 8/8 files and 348/348 tests passed.
- MCP client examples: generic stdio, Claude Desktop, Cursor, VS Code, and
  support-plan-credit paths parsed, safety-scanned, and verified as applicable.
- Disposable Docker first-run proof: passed.
- Public-checkout commands: passed.
- Local Runner install: passed.
- Packed Runner install: passed.
- Packed own-PostgreSQL onboarding and guarded apply: passed with one affected
  row and a durable receipt.
- License/content and public handler-reference checks: passed.
- Package dry run: 233 files, 1.1 MB compressed, 5.2 MB unpacked, npm shasum
  `b483de24ad99efa8c86ba021cb106b50f240b5cf`, integrity beginning
  `sha512-KxGoud3e1tZSu`.
- `git diff --check`: passed.
- Published-registry verification was correctly skipped because 1.5.2 is not
  published.
- No pre-existing baseline failure was observed in the release gate.

### 1.5.3 implementation checkpoint: Safe Action authority core

Implemented:

- `apps/runner/src/safe-action.ts`:
  - restricted TypeScript AST parser for one `defineCapability({...})` export;
  - no imports except `@synapsor/runner/authoring` and no dynamic expressions,
    spreads, functions, or file execution;
  - fail-closed diagnostics for model-controlled trust/query arguments,
    unresolved review placeholders, unknown context/resource/source/executor,
    missing tenant/write/approval/conflict/bounds authority, and visibility
    overlap;
  - canonical contract merge preserving JSON/DSL/Cloud contract compatibility;
  - deterministic generated contract tests;
  - disabled digest-addressed drafts under `.synapsor/drafts`;
  - digest-addressed read-only active artifacts under `.synapsor/active`;
  - exact source/base/draft digest revalidation and rollback of config pointer on
    activation failure;
  - activation requires a same-digest, source-unchanged staging proposal
    preview.
- `start --action <name> --description <intent>` scaffolds one concise inert
  TypeScript action from an existing reviewed read boundary and surfaces five
  unresolved authority questions with their source.
- `action validate|compile`, `action watch`, and `action status` added. None can
  activate a draft or alter active tools.
- `apps/runner/src/safe-action-instructions.ts` is one host-neutral safety source
  used to generate `synapsor/SAFE_ACTION_AGENT.md`, scoped `AGENTS.md`, and
  scoped `CLAUDE.md` wrappers without overwriting unowned files.
- Workbench endpoints require the local session and CSRF token for draft
  preview/activation. Activation additionally requires typing `ACTIVATE` plus
  the complete digest. Cloud-linked configs are directed to the governed Cloud
  activation path. No model-facing MCP activation tool was added.
- Workbench displays agent-can/agent-cannot/operator-review boundaries, preview
  args, preview identity, exact digest, and an honest MCP reconnect instruction.
- `verifyLocalWritebackAuthority` now compares a local proposal's immutable
  contract digest with the currently active reviewed capability. A changed
  activation requires a new proposal instead of reinterpreting old approval.

Focused verification:

- `corepack pnpm exec tsc -b --pretty false`: passed.
- `corepack pnpm exec vitest run apps/runner/src/safe-action.test.ts`: 7/7
  passed.
- `corepack pnpm exec vitest run apps/runner/src/local-ui.test.ts`: 6/6 passed,
  including token/CSRF/digest/preview activation controls.
- Contract-digest apply tests passed for local and Cloud-approved jobs.
- Combined focused run: 11 selected tests passed across Safe Action, local UI,
  and CLI; 115 unrelated tests skipped by the name filter.

Not yet proven:

- default Workbench preview against a real PostgreSQL/MySQL staging source;
- packed/global/npx Safe Action journey and activation timing;
- formatter/editor diagnostics and live generated contract-test orchestration;
- editor/LSP diagnostics for TypeScript action files;
- Cursor project prompt/plugin work and current official host behavior;
- remaining audit/CI/recipes/docs/site/demo/release phases;
- full suite and release gate after implementation.

### 1.5.3 implementation checkpoint: deterministic validation evidence

Recorded: 2026-07-21T04:33:31Z

- `action validate` now writes a disabled digest-addressed canonical draft plus:
  - a complete JSON lint report;
  - a reviewer-facing Markdown contract explanation;
  - a static-only generated contract-test manifest;
  - an executed JSON static-test report;
  - an explicit list of generated live tests still pending staging data.
- Strict lint is incremental: inherited baseline warnings remain visible, all
  errors block, and newly introduced warnings block. This avoids treating old
  warnings as silently accepted while also avoiding an impossible migration
  prerequisite for the first action.
- Preview and activation fail closed unless validation evidence is complete and
  successful. The draft pointer digest must agree with the manifest digest.
- Focused proof after the change:
  - TypeScript project build passed.
  - Safe Action tests: 9/9 passed.
  - Selected CLI Safe Action test passed.
  - Selected secured Workbench activation test passed.
- Restart/tool-surface proof now passes: draft compilation leaves tools
  unchanged; explicit activation is visible after runtime restart; editing and
  compiling a later draft leaves the prior active authority unchanged.

### 1.5.3 implementation checkpoint: exact effects, project evidence, and live preview

Recorded: 2026-07-21T05:05:00Z

- Added canonical Runner contract-test assertions for `proposal_effect` and
  `conflict_guard`. They compare checked-in expectations with the exact
  proposal operation, cardinality, selection, caps, writable fields, patch,
  scalar and transition bounds, conflict guard, approval, writeback, and row
  limit. Stable mismatch codes are covered by tests.
- Generated Safe Action tests now cover the operator boundary, exact proposal
  effect, conflict guard, kept-out fields, every scalar argument constraint,
  transition guards, and set caps. They also emit explicit live templates for
  the allowed effect, another-tenant denial, and source-unchanged-before-review.
  The reference draft executes seven deterministic static tests and reports
  three live tests pending staging data.
- Safe Action authority validation now fails closed for missing or ambiguous
  source/object/key/scope/visibility/evidence/mutation/approval/conflict/
  idempotency/bounds/executor authority. Tenant and principal trust must be
  bound outside model arguments; direct SQL requires an environment-bound
  writer; app handlers and Cloud workers must resolve to reviewed config.
- Existing project detection now also reports raw SQL/schema files and migration
  directories. Safe Action scaffolding records only structural evidence:
  detected frameworks, source paths, and environment-variable names. It never
  executes project code or reads environment-variable values.
- The existing language server now validates `synapsor/actions/*.ts` through
  the restricted static parser and canonical authority validator. Diagnostics
  use stable `synapsor-safe-action` codes, disclose no absolute local paths,
  create no draft state, and preserve existing DSL completion/hover/formatting.
- Added `corepack pnpm verify:safe-action-preview`. The verifier starts the
  disposable billing PostgreSQL fixture, compiles a disabled action, proves the
  active tool list is unchanged, sends a token/CSRF-protected preview through
  the real default Workbench server, obtains an immutable proposal/hash/digest,
  verifies the source row is unchanged, activates the exact digest with the
  explicit confirmation, reloads the runtime, observes the new tool, and again
  verifies the source row is unchanged.

Focused results:

- TypeScript project build: passed.
- Safe Action tests: 10/10 passed.
- Project detection tests: 2/2 passed.
- Language-server tests: 5/5 passed, including a real stdio protocol exchange.
- Contract-testing tests: 5/5 passed.
- Secured Workbench and selected CLI Safe Action tests: passed.
- Real disposable-PostgreSQL preview verifier: passed with
  `source_database_changed=false`, `active_after_explicit_confirmation=true`,
  and `reconnect_required=true`.

## Activation timings

- Exact final packed own-PostgreSQL product run: first proposal in 5,501 ms;
  first guarded receipt in 7,926 ms. Package resolution/download is excluded.
- A second already-authored disabled fixture action validated in 0.74 seconds.
  This proves tool mechanics, not real coding-agent authoring time; the
  five-person owner trial measures the under-two/under-five-minute human path.
- Empty-cache local-tarball `npx` observation: 3.82 seconds on 2026-07-21,
  Linux 6.17.0-40 x86_64, Intel i7-13800H, Node 22.22.2, npm 11.8.0, default
  npm registry, no observed throttling. The tarball bytes were local while
  registry dependencies were cold, so this is not a post-publication registry
  claim or a universal network guarantee.

### 1.5.3 implementation checkpoint: Cursor adoption and audit authority map

Recorded: 2026-07-21T05:15:46Z

- Researched current official Cursor plugin, MCP, and deeplink documentation
  and recorded the source URLs/date in `docs/cursor-plugin.md`. Local Cursor is
  `3.7.21`, commit `517f696d8ab6c53eb04fbfdaae705cd146bf3460`.
- Added an official-format plugin under `plugins/cursor/synapsor` with one
  project-scoped stdio Runner, `/synapsor-protect`, one canonical-instruction
  skill wrapper, one action-file rule, no hooks, and no activation/approval/
  apply/credential authority.
- Added deterministic plugin build/verify scripts. Verification passed with
  package digest
  `sha256:c0c72f8a74098735afbfafabf2d1ceb430eb4938d562a7d503fc8776dbc857bd`,
  seven files, path-with-spaces support, idempotent copied install, clean
  uninstall, unrelated-config preservation, and no embedded secrets or
  activation authority.
- Corrected Runner's existing project Cursor installer to emit documented
  `type: stdio`; all three project-installer tests pass.
- Workbench now supplies the exact copyable Cursor prompt, user-confirmed
  official prompt deeplink, honest project-configuration evidence, exact
  configured tool surface, proposal waiting state, and direct Data PR review
  handoff. Focused local UI and Cursor tests pass (9/9).
- Extended MCP audit with an evidence-labeled model-authority map and configured
  server bypass check. Static config inspection launches nothing. A live check
  requires one exact `--live-server` plus `--yes`, invokes no shell, refuses
  unresolved interpolation, and calls only MCP initialization and `tools/list`.
- Added text, JSON, sanitized Markdown, and SARIF authority/bypass output;
  stable finding-specific remediation URLs; home-directory target redaction;
  deterministic fixtures under `fixtures/mcp-audit`; and a checked-in GitHub
  Actions workflow that verifies findings and SARIF without running business
  tools.
- TypeScript project build passed after the audit changes.
- Focused audit/CLI tests passed, including raw SQL, arbitrary predicates,
  proposal boundaries, static bypass detection, no-launch behavior, explicit
  consent, path-with-spaces interpolation, and live direct-authority detection.

### 1.5.3 implementation checkpoint: team CI and adjacent client recipes

Recorded: 2026-07-21T05:35:09Z

- Added a checked-in code-first `support.propose_plan_credit` action to the
  flagship example. Validation produces the same disabled draft digest
  `sha256:c238e5f9dddc6ccc6a0930b0516f37e9e5e9450f52e4c7cdc9839e452f912c82`
  and a checked-in generated contract-test manifest.
- Added `verify:safe-action-team` and `safe-action-ci.yml`. The gate copies the
  project to a path with spaces, proves no active tool/source/config/action
  mutation, compares generated tests byte-for-byte, and writes text, JSON, and
  JUnit evidence. It passed 7/7 static tests with three explicit staging tests
  left pending rather than faked.
- Added one packaged recipe set over the same support-plan-credit contract for
  Claude Desktop, Claude Code, Codex, Cursor, VS Code, OpenAI Agents SDK,
  LangChain/LangGraph, Google ADK, LlamaIndex, generic stdio, and generic
  Streamable HTTP.
- Added explicit host-tested/configuration-tested/protocol-tested/recipe-checked
  labels and current official framework links. No framework is called host
  tested based only on standard MCP evidence.
- `corepack pnpm test:mcp-client-configs` passed. It syntax/secret checks all
  recipes, accepted the current config through Claude Code 2.1.216 and Codex
  0.144.6 in isolated homes, and completed MCP `tools/list` with only
  `support.inspect_customer` and `support.propose_plan_credit` on the flagship
  surface.
- The optional live recipe gate passed against disposable PostgreSQL. It called
  `support.propose_plan_credit` with `CUS-3001`, received
  `source_database_changed:false`, and independently queried the source before
  and after: both were `0||2026-06-20 14:31:08+00`.
- Current Google ADK 2.5.0 and LlamaIndex MCP 0.4.8 package APIs were inspected
  without installing them into the workspace; the checked imports and
  `BasicMCPClient.list_tools/call_tool` shape match those distributions.

At this checkpoint, the next action was to update the README, website, article, deterministic short
demo, discovery metadata, and honest alternatives page before packed and full
release verification.

### 1.5.3 implementation checkpoint: README, website, article, demo, and discovery

Recorded: 2026-07-21T06:14:12Z

- Reworked the Runner README front door around the own-application journey:
  four-second synthetic proof, existing staging application, disabled Safe
  Action draft, Cursor project handoff, exact Data PR, approval outside MCP,
  and guarded receipt. The feature inventory remains below this activation
  path and MCP audit remains a prominent no-database entry point.
- Added `docs/alternatives.md` and a matching public
  `/docs/database-agent-alternatives` page. Both distinguish raw database MCP,
  read-only access, app-owned tools, and Runner without claiming that Runner
  replaces RLS, restricted views, least-privilege roles, or backups.
- Updated own-database, security-boundary, troubleshooting, OSS-versus-Cloud,
  launch, release, discovery, and task-first documentation. The public article
  now explains the static TypeScript-to-disabled-draft path and links to client
  recipes and the alternatives page.
- Added a deterministic 36-second 1920x1080 H.264 Safe Action demonstration and
  an 18-second 960x540 GIF teaser over the existing support-plan-credit
  integration. The capture ran against disposable PostgreSQL and proved exact
  proposal diff, source unchanged before approval, one-row guarded apply,
  receipt, idempotent retry, and stale `VERSION_CONFLICT` without overwrite.
- `corepack pnpm demo:safe-action:verify` passed after the final render. The
  verifier checks story order, real-run evidence, media shape, and local-path /
  secret hygiene. Current generated media remains ignored in the OSS worktree;
  the public website carries the reviewed MP4, poster, and WebVTT captions.
- Visually inspected eight representative video frames at original resolution.
  Corrected low-contrast secondary text, rerendered, and reran verification.
- Public-site focused tests passed (10/10), typecheck passed, lint passed, the
  full control-panel suite passed (117/117), and the production Next.js build
  passed with the article, alternatives page, sitemap, robots, `llms.txt`, and
  `llms-full.txt` routes present. No website deployment was performed.
- `git diff --check` passes in both repositories. The website still requires a
  local production HTTP/browser/link smoke before the final handoff.

### 1.5.3 release-preparation checkpoint: package truth and focused gates

Recorded: 2026-07-21T06:23:51Z

- npm registry inspection confirms Runner `1.5.3` is available; live
  `latest`/`next` remain `1.5.0`. Spec `1.4.2` and DSL `1.4.3` remain the live
  compatible versions and were not changed.
- Bumped only the root workspace and `@synapsor/runner` package to `1.5.3`.
  `build:runner-package` passes, the built CLI reports `1.5.3`, and the package
  build synchronizes the root and npm README byte-for-byte.
- Extended `verify-packed-runner.sh` to require the new public docs and prove,
  from a clean tarball install, that `start --action` creates only an inert
  scaffold, `action validate` creates a digest-addressed disabled draft, source
  data and active tools remain unchanged, and no active artifact exists.
  `./scripts/verify-packed-runner.sh` passes.
- Added `docs/fresh-developer-usability.md`: a repeatable five-person protocol,
  separate cold-download/product timers, explicit safety blockers, and an
  owner-pending reporting rule. No external participant result is claimed.
- Focused tests found one stale Cloud principal-scope fixture that omitted the
  new immutable contract digest. Updated the fixture to match neighboring
  Cloud authority tests; its focused rerun passes. The fail-closed runtime rule
  for unpinned proposals was not weakened.
- Cursor plugin verification passes with version `1.5.3`, seven files, digest
  `sha256:c0c72f8a74098735afbfafabf2d1ceb430eb4938d562a7d503fc8776dbc857bd`,
  idempotent project install, clean uninstall, no secrets, and no activation
  authority.
- Team Safe Action verification passes 7/7 static checks with its three live
  checks explicitly pending for the disposable-database gate. Adjacent recipe
  verification passes, including live standard-MCP `tools/list` for the exact
  two-tool support-plan-credit surface and current Claude Code 2.1.216 / Codex
  0.144.6 configuration acceptance.
- Safe Action media verification and the license/content gate pass. README is
  1,485 words, retains the required compatibility statement, and remains below
  the 1,500-word ceiling.
- Next long action is the complete OSS test suite, followed strictly
  sequentially by database-backed safety suites and the release gate.

### 1.5.3 verification checkpoint: complete OSS and live database suites

Recorded: 2026-07-21T06:37:35Z

- `corepack pnpm test` passes: 39 files, 630 tests, TypeScript build, license
  and content policy, DSL source-path compatibility, and Cursor plugin
  verification. No test was skipped to hide a release failure.
- `corepack pnpm test:guarded-crud` passes for PostgreSQL and MySQL across all
  receipt modes, guarded INSERT/UPDATE/DELETE, retry, crash, concurrency, and
  DELETE hazards.
- `corepack pnpm test:bounded-set` passes for PostgreSQL and MySQL: fixed
  multi-term selection, row/value caps, drift refusal, atomic rollback,
  frozen UPDATE/DELETE, exact batch INSERT, reconciliation, and 1/10/100-row
  evidence timings.
- `corepack pnpm test:reversible` passes for PostgreSQL and MySQL: reviewed
  forward/revert proposals, bounded inverse, stale-member refusal, redaction,
  inverse-of-inverse, and hard-delete honesty.
- `corepack pnpm test:principal-scope` passes all 8 PostgreSQL/MySQL legacy and
  preferred-extension cases, including shared-ledger handle isolation.
- `corepack pnpm test:database-scope` passes independent PostgreSQL RLS,
  trusted tenant/principal binding, connection-pool reset, guarded writes,
  compensation, and fail-closed doctor checks.
- `corepack pnpm test:live-apply` passes every packaged PostgreSQL/MySQL
  example: semantic tools only, unchanged source before approval, approval
  outside MCP, guarded apply, receipt/replay, idempotent retry, stale conflict,
  policy tiers, and native guarded INSERT.
- `corepack pnpm verify:safe-action-preview` passes against disposable
  PostgreSQL with a real proposal, unchanged source, exact draft digest,
  explicit operator confirmation, active immutable artifact, and accurate
  reconnect requirement.
- `corepack pnpm test:aggregate-read` passes PostgreSQL/MySQL scoped fixed
  aggregates, suppression, evidence/audit, timeout classification, and no
  member-row leakage.
- `corepack pnpm test:fleet` passes two-Runner shared-ledger isolation, quorum,
  competing worker claims, before/during/after-commit recovery, dead letters,
  bounded PostgreSQL/MySQL pool pressure, backup/restore, and retention.
- Disposable Docker resources were torn down by each verifier. Next action is
  the consolidated `verify-release-gate.sh 1.5.3`, followed by final artifact,
  website/browser, timing, and acceptance audits.

### 1.5.3 completion-audit checkpoint: team CI closes live boundary gaps

Recorded: 2026-07-21T07:43:19Z

- The requirement-by-requirement audit found one implementation gap in the
  checked-in team path: it reported its three disposable-database assertions as
  pending rather than running them in GitHub Actions.
- Added named static contract assertions for trusted tenant/principal scope,
  required evidence, and the complete approval boundary (mode, role, referenced
  policy rules, and aggregate limits). The flagship disabled action now passes
  10/10 static assertions and still produces the same canonical draft digest
  `sha256:c238e5f9dddc6ccc6a0930b0516f37e9e5e9450f52e4c7cdc9839e452f912c82`.
- Extended `safe-action-ci.yml` with a synthetic disposable PostgreSQL service.
  The same verifier now resolves only test fixture identifiers, uses an amount
  above the auto-approval threshold, and runs the generated allowed-effect,
  other-tenant-denial, and source-unchanged cases through the real MCP runtime.
- The local reproduction of the exact CI branch passed 13/13 live assertions.
  It compared both fixture rows and the source receipt count before/after,
  proving `source_database_changed:false`; no approval, activation, or apply was
  performed. Text, JSON, and JUnit reports were emitted for static and live
  runs.
- Focused contract-testing and Safe Action tests pass 15/15. The generated
  checked-in manifest and adopter documentation were updated from the same
  deterministic generator.
- The disposable `synapsor_runner_plan_credit` container, volume, and network
  were removed after verification.

At this checkpoint, the next action was to rerun the full OSS suite and complete release gate because
the contract-test runner and packaged generated fixture changed after the prior
candidate tarball. Then rebuild the final tarball/SBOM and finish the acceptance
matrix and owner handoff.

### 1.5.3 final-artifact and browser checkpoint

Recorded: 2026-07-21T08:11:38Z

- After the live team-CI correction, `corepack pnpm test` passed 39/39 files and
  630/630 tests plus TypeScript, license/content, preferred DSL path, and Cursor
  plugin checks.
- `./scripts/verify-release-gate.sh 1.5.3` then passed 351/351 focused tests,
  current client-recipe checks, disposable first-run proof, local and packed
  Runner checks, packed own-PostgreSQL onboarding/apply, package dry run, and
  `git diff --check`. The packed own-data proof observed first proposal at
  5,377 ms and first receipt at 7,800 ms of product time.
- A first exact tarball candidate passed clean install, global install,
  `try --prove`, the MCP audit, Node 22.13.1 and Node 24.18.0 containers, and a
  zero-vulnerability production dependency audit. A CycloneDX 1.5 SBOM was
  generated. That tarball is now explicitly superseded and must not be
  published because the subsequent browser audit found a shipped responsive
  defect.
- The real token/session-protected Workbench from the packed install rendered
  in headless Chrome at 1440x1100 and 390x1600 with a populated Data PR,
  disabled Safe Action digest, operator boundary, and no visible bootstrap
  token. The accessibility tree exposed the Workbench identity and all
  interactive controls had accessible names.
- The mobile pass found that nested cards in the collapsed runtime/tools grid
  retained their long-content minimum width and clipped by about 8 px at 390
  CSS pixels. Added `.grid > * { min-width:0; }` and a local UI regression
  assertion. The focused local UI suite passes 6/6.

At this checkpoint, the next action was to rerun the complete OSS suite and release gate after the
responsive fix, render the packaged Workbench again at desktop/mobile, then
generate a new exact tarball and SBOM. Do not reuse any pre-fix artifact hash.

### 1.5.3 final release-candidate checkpoint

Recorded: 2026-07-21T08:39:35Z

- After the responsive Workbench fix, `corepack pnpm test` passed again: 39/39
  files, 630/630 tests, TypeScript build, license/content policy, preferred DSL
  paths, and Cursor plugin verification.
- `./scripts/verify-release-gate.sh 1.5.3` passed again with 351/351 focused
  tests, client recipes, disposable first-run proof, local Runner, packed
  Runner, packed own-PostgreSQL proposal/apply, content checks, pack dry run,
  and `git diff --check`. This final run observed first proposal at 5,501 ms
  and first receipt at 7,926 ms of product time.
- The authoritative candidate is:
  `/tmp/synapsor-runner-1.5.3-release-final-3/synapsor-runner-1.5.3.tgz`.
  It is 1,189,678 compressed bytes, 5,398,753 unpacked bytes, and 252 files.
  npm/SHA-1 is `4da9709601e91cd83c8b8348992a60fffef593ca`; SHA-256 is
  `d299bd11e04432e557ef96e847ed4904aac3a77c059f848248624f717dfdd5c8`;
  integrity is
  `sha512-LbtbNlvqKI1qE/7e72+hzTBLFQJRn7fCvP8AIcl+pUvMdRKdHnw7tuNmWwT9h6g7/e4oBNPRUt0nFgrfeG0j/A==`.
- A clean temporary install and a temporary global-prefix install both report
  Runner 1.5.3. The packed `try --prove --json --yes` proves duplicate-free
  retry, changed-intent refusal, stale conflict, non-mutating replay, and no
  automatic UNKNOWN retry. Packed audit returns the authority map and bounded
  visibility; packed action validation emits only a disabled draft while active
  tools and source data stay unchanged.
- The exact candidate passed version/try/audit checks in Node 22.13.1 and Node
  24.18.0 containers. Its clean production dependency audit reports zero info,
  low, moderate, high, critical, or total vulnerabilities.
- The final CycloneDX 1.5 SBOM is
  `/tmp/synapsor-runner-1.5.3-release-final-3/sbom/synapsor-runner-1.5.3.cdx.json`.
  Its root is `pkg:npm/%40synapsor/runner@1.5.3`, it records 120 components,
  and its SHA-256 is
  `7f6dfb0ce68aea076510cfbbd11255e78aeb087719e7bfb0d87756eb5462df40`.
  npm provenance cannot be honestly produced by a local OTP publish; use npm
  trusted publishing/CI if provenance is required.
- `corepack pnpm build:mcpb` and `corepack pnpm verify:mcpb` pass for the
  explicitly unsigned signing-preparation artifact
  `dist/mcpb/synapsor-runner-1.5.3-unsigned.mcpb`. It is 11,919,558 bytes,
  SHA-256
  `a073b40f23dea33e336f4d27fb3066babfd96f29bc9f2c756317eceece2e6add`,
  exposes only the three reviewed support semantic tools, and exposes zero
  model-facing approval/apply tools. Signing remains an owner action; the
  builder records `signed=false` and never self-signs.
- Final package scans found no database, key/certificate, media, development,
  Git metadata, private-key, AWS/GitHub/npm/OpenAI/Slack token, or local-user
  path leak. The packaged `.env.example` contains only explicitly disposable
  localhost values and empty Cloud fields. Root and npm READMEs match
  byte-for-byte.
- The final packed Workbench rendered in real headless Chrome at 1440x1100 and
  390x1600. Both passes had zero body or uncontained overflow, zero unnamed
  controls, no visible bootstrap token, and visible Data PR, proposal,
  operator-boundary, and active-tools-unchanged evidence. The accessibility
  tree exposed the Workbench identity. Screenshots are
  `/tmp/synapsor-runner-1.5.3-final-workbench-desktop.png` and
  `/tmp/synapsor-runner-1.5.3-final-workbench-mobile.png`.
- Website source passed typecheck, lint, 29/29 files and 117/117 tests, and an
  optimized 108-page Next.js build. Production-mode browser smoke passed the
  homepage, technical article, and canonical alternatives page at six
  viewports each. The article rendered its canonical URL, Open Graph, Twitter
  large-image metadata, and TechArticle JSON-LD; sitemap and `llms.txt` include
  the article and OSS surfaces. Of 125 internal links collected from the three
  pages, 124 passed locally; the sole local exception was the intentionally
  proxied `/openapi.json` without a local control plane, and the live public
  endpoint returned HTTP 200. The initial smoke invocation used nonexistent
  `/alternatives`, received the expected 404, and was rerun successfully with
  `/docs/database-agent-alternatives`.
- No goal-owned process or Docker resource remains running. The existing
  `calendarapp-*` and `agentcap-*` containers predate this goal and were left
  untouched.

## Definition-of-done audit

1. **Pass:** the 1.5.2 foundation was reproduced before editing and remains
   covered by the final packed gate and live PostgreSQL/MySQL suites.
2. **Pass:** exact packed own-PostgreSQL first proposal is 5,501 ms, under the
   five-minute product target.
3. **Pass:** the secured Workbench has the exact copyable first prompt,
   project-scoped Cursor setup, connection/tool status, proposal waiting state,
   and direct review link; browser and local UI tests cover it.
4. **Pass:** once Cursor calls the proposal tool, the proposal/review response
   requires no additional CLI discovery command.
5. **Pass:** `start --action` plus canonical agent instructions let a coding
   agent author the restricted TypeScript Safe Action in the project.
6. **Pass:** Runner statically parses, compiles, explains, and tests the action
   without importing it or requiring a model-provider API.
7. **Pass:** generated actions are digest-addressed `disabled_draft` artifacts;
   validation/watch have no activation side effect.
8. **Pass:** active tools load only from an explicitly activated immutable
   artifact; file edits and restart tests preserve the previous tool surface.
9. **Pass:** distinct draft/active digests, immutable history, stale-base
   refusal, restart identity, and failed-activation preservation are tested.
10. **Pass:** proposals carry the exact contract digest; apply fails closed if
    active authority changes, so old proposals never inherit new semantics.
11. **Pass:** CLI watch, LSP, Workbench diagnostics, exact generated effects,
    and real staging preview are verified without source mutation.
12. **Pass:** activation exists only in the token/CSRF-protected Workbench (or
    governed Cloud workflow), with complete digest confirmation. There is no
    action-activation CLI or model-facing MCP tool.
13. **Pass with documented host fallback:** activation reports
    `tools_list_changed:false` and `reconnect_required:true`; docs accurately
    require Cursor/MCP reconnect instead of claiming unverified hot reload.
14. **Pass locally:** the seven-file official-format Cursor plugin is
    secret-free, project-scoped, idempotently installable, removable, and
    package-ready. GUI/Marketplace acceptance remains an owner launch gate.
15. **Pass:** `/synapsor-protect` is a thin wrapper over `start --action` and
    `action validate`; verifier rejects activation/approval/apply authority.
16. **Pass:** audit renders an evidence-labeled model-authority map.
17. **Pass:** static and explicitly consented selected-server checks identify
    direct-write/raw-SQL bypass while stating static-audit visibility limits.
18. **Pass:** text, JSON, sanitized Markdown, SARIF, deterministic fixtures,
    remediation links, and GitHub Actions are verified.
19. **Pass:** team CI runs 10 static and 3 live assertions and proves no source,
    active-contract, approval, or apply mutation.
20. **Pass at documented evidence levels:** proposal-only recipes cover Cursor,
    Claude Desktop/Code, Codex, VS Code, OpenAI Agents, LangChain/LangGraph,
    Google ADK, LlamaIndex, generic stdio, and generic Streamable HTTP. No
    protocol-only result is labeled host-tested.
21. **Pass:** README and website lead with the existing-application Data PR;
    full inventory is below the activation path.
22. **Pass:** no generic SQL, automatic authority, new database engine, or
    Cloud dependency was introduced.
23. **Pass:** the exact Runner 1.5.3 tarball passes the complete final release
    gate, cold/global installs, supported Node checks, browser checks, scans,
    and zero-vulnerability audit.
24. **Pass:** Spec stays 1.4.2 and DSL stays 1.4.3; the canonical contract did
    not change for UI convenience.
25. **Pass:** no release failure was skipped or relabeled. The responsive
    defect found by browser testing was fixed and the full gate rerun; local
    OpenAPI proxy and nonexistent-route observations are documented above.
26. **Pass:** no push, merge, npm publish/dist-tag, tag, GitHub release,
    Marketplace submission, AWS deployment, or live AWS mutation occurred.

## Client and host versions

- Cursor 3.7.21, commit
  `517f696d8ab6c53eb04fbfdaae705cd146bf3460`, x64, was installed locally.
  Official plugin, plugin-reference, MCP, and deeplink docs were checked on
  2026-07-21. Static/package and standard-MCP evidence passed; a manual GUI
  click-through and Marketplace review are not claimed.
- Claude Code 2.1.216 accepted its isolated configuration recipe.
- Codex 0.144.6 accepted its isolated configuration recipe.
- Google ADK 2.5.0 and LlamaIndex MCP 0.4.8 current APIs were source-inspected;
  their recipes are labeled recipe-checked/protocol-tested rather than
  physically host-tested.

## Blockers

None currently.

## Remaining manual verification

- Actual Cursor GUI installation and proposal flow.
- Cursor Marketplace submission/review. Current format and requirements are
  documented and locally validated, but acceptance is external.
- Cursor inline MCP Apps behavior remains unknown until reproduced.
- Physical Windows/macOS/devcontainer verification where unavailable locally.
- Five-person fresh-developer usability test remains an owner launch gate; the
  repeatable protocol exists, but no participant result is claimed.
- True post-publication npm cold-registry timing remains unavailable before
  publication.
- npm trusted-publisher provenance/signing, publication, dist-tags, Git tag,
  GitHub release, Marketplace submission, and website/AWS deployment remain
  owner actions.

## Next exact action

Review the final handoff, commit one intentional OSS release commit and one
website commit, then use the owner-authorized PR/merge, npm publication/tag,
Cursor Marketplace, and AWS deployment sequence. Rebuild and rerun the release
gate from the merged commit before npm publication; do not rely on the
ephemeral `/tmp` tarball. Keep Spec 1.4.2 and DSL 1.4.3 unchanged.
