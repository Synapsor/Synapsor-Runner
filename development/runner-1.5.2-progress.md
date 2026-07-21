# Runner 1.5.1 / 1.5.2 progress

Last updated: 2026-07-20

## Objective

- Prepare `@synapsor/runner@1.5.1` as an independent filesystem-safety hotfix.
- Base `@synapsor/runner@1.5.2` on that exact commit and deliver the own-data
  "first safe action" activation experience from `goal.txt`.
- Do not push, publish, tag, release, deploy, or change AWS without explicit
  authorization.

## Current state

- Active repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`
- Baseline commit: `f25906a` (`main`, synchronized with `origin/main`)
- Verified hotfix commit: `83fe39dac55f0a88c6f4090c9a272519f8986a65`
- Active branch: `release/runner-1.5.2-first-safe-action`, created directly
  from that exact hotfix commit
- Cloud/site baseline: `0d672f55` (`main`, synchronized with `origin/main`)
- Worktrees were clean before branch creation.
- Node: `v22.22.2`
- pnpm: `10.14.0`
- npm: `11.8.0`
- Free disk at baseline: 49 GiB (filesystem 86% used)

## Registry and release baseline

- `@synapsor/runner`: `latest=1.5.0`, `next=1.5.0`
- `@synapsor/spec`: `latest=1.4.2`, `next=1.4.2`
- `@synapsor/dsl`: `latest=1.4.3`, `next=1.4.3`
- `@synapsor/runner@1.5.1` and `1.5.2` are available version numbers.
- Local/remote tag scan returned no `v1.5.x` tag; latest visible local release
  tag was `v1.0.0`.
- Root and Runner package versions are `1.5.0`.
- Root and packaged Runner changelogs still say `1.5.0 (prepared, not
  published)`, contradicting the live registry.

## Confirmed hotfix defect

`apps/runner/src/try-experience.ts` resolves caller-controlled `root_dir` and
immediately calls:

```ts
await fs.rm(root, { recursive: true, force: true });
```

The CLI passes `--state-dir` directly to `root_dir`. `demo inspect --state-dir`
also assumes `ledger.db` lives directly in the supplied directory. The safe
design must preserve an understandable custom-state contract while preventing
deletion of the supplied container, rejecting protected/symlinked paths, and
handling repeated/interrupted/concurrent runs.

## Phase status

- Phase 0 baseline: completed
- Phase 1 filesystem safety: completed and committed
- Phase 1A 1.5.1 release candidate: completed and committed
- Phases 2-12 / 1.5.2: completed and release-gated; local commit/handoff pending

## Baseline commands/results

- `git status --short --branch`: clean on both repositories.
- npm metadata queries: passed; versions recorded above.
- Source/path audit: confirmed the destructive `try` path and catalogued other
  recursive-removal sites for ownership review.
- Full test baseline: passed, 30 files and 577 tests; license/content and DSL
  source-path checks passed. Wall-clock duration: 116.49 seconds.
- Release gate baseline: passed for `1.5.0`, including 345 core tests, MCP
  client tool-list verification, Docker PostgreSQL/MySQL proofs, public-command
  verification, local/packed Runner, packed own-database guarded write,
  license/content, and npm pack dry-run.
- Baseline package dry-run: 1.0 MB compressed, 4.7 MB unpacked, 223 files.
- Product-only packaged `try --prove`: 3.21 seconds.
- Empty-cache cold `npx @synapsor/runner@1.5.0 try --prove`: 6.91 seconds from
  a fresh `/tmp` working directory on this machine/network.
- Running the downloaded-package check inside the monorepo is invalid because
  npm resolves the local root `synapsor-runner` bin first; cold checks must run
  from a fresh external directory.
- Implemented marked managed state beneath caller-provided containers, explicit
  file allowlist cleanup, protected-path and symlink rejection, atomic leases,
  dead-process recovery, and safe adoption of known legacy default state.
- Hardened schema/audit candidate `--force` replacement after the repository
  deletion audit; fixed-path build cleanup and `mkdtemp`-owned cleanup do not
  accept caller-owned directories.
- Focused safety/generator verification: 25/25 tests passed. Root TypeScript
  build/typecheck passed.
- First post-change full suite completed 585/588; the only failures were stale
  expected version/path assertions caused by the intentional `1.5.1` and
  managed-state changes. Updated those assertions; their focused rerun passed.
- Final post-change full suite passed: 31 files, 591/591 tests, followed by the
  license/content check and DSL source-path check. Wall-clock duration reported
  by Vitest: 116.77 seconds.
- First `1.5.1` release-gate attempt passed typecheck, 345/345 core tests, exact
  MCP client tool-list checks, the disposable Docker first-run proof, and public
  command checks. It stopped at a stale `verify-local-runner.sh` assertion that
  expected the old relative inspect-store path. The verifier now checks the
  intentional canonical absolute path and passes standalone; a complete gate
  rerun is pending.
- Second gate attempt passed the corrected local verifier, then found the same
  stale relative-path assertion in the packed verifier. Packed and published
  package verification now assert the canonical absolute inspect path; the
  packed verifier passes standalone. A final uninterrupted gate rerun is next.
- Final uninterrupted `./scripts/verify-release-gate.sh 1.5.1` passed. It
  covered typecheck, 345/345 core tests, exact MCP client tool lists, Docker
  first-run, public/local/packed Runner checks, a live packed own-database
  guarded write, license/content checks, package dry-run, and `diff --check`.
  Dry-run package report: 1.0 MB compressed, 4.7 MB unpacked, 223 files.
- The first real-tarball cold install exposed `GHSA-48c2-rrv3-qjmp` in pinned
  `yaml@2.8.1` (moderate denial of service from deeply nested collections).
  Runner now pins the minimal patched `yaml@2.8.3`; the lockfile is updated.
  The full suite/gate and tarball evidence must be regenerated from this final
  dependency graph.
- Final post-`yaml@2.8.3` full suite passed: 31 files and 591/591 tests,
  followed by the license/content and DSL source-path checks. Reported Vitest
  duration: 117.30 seconds. This supersedes the earlier pre-dependency full
  suite as release evidence; the complete release gate must still be rerun.
- Final post-`yaml@2.8.3` `./scripts/verify-release-gate.sh 1.5.1` passed. It
  covered typecheck, 345/345 core tests, exact MCP tool-list checks, disposable
  Docker first-run, public/local/packed Runner checks, packed own-database live
  PostgreSQL guarded write, license/content checks, package dry-run, and
  `diff --check`. Dry-run package report: 1.0 MB compressed, 4.7 MB unpacked,
  223 files. Final real-tarball hash and cold-install evidence remain pending.
- External final-tarball testing found one remaining containment gap: an
  unrelated Git repository root supplied as `--state-dir` was accepted because
  protection only knew the repository containing the process cwd. Root, home,
  cwd, and traversal rejection worked. Add candidate-path repository-marker
  detection and an out-of-repository regression, then repeat the affected
  safety, full-suite, release-gate, and cold-tarball checks.
- Candidate-path Git repository detection is now implemented before any
  managed child is created or read. The new out-of-repository regression and
  all focused state/generator tests pass: 22/22; typecheck also passes. The
  accidentally created owned test state at the OSS root was removed by
  unlinking only its four known managed files and removing the empty directory.
  Full suite and release gate are being rerun from this final code.
- Final full suite after repository-root hardening passed: 31 files and
  592/592 tests, followed by license/content and DSL source-path checks.
  Reported Vitest duration: 116.32 seconds. Final release-gate rerun is next.
- Final release gate after repository-root hardening passed in full: typecheck,
  345/345 core tests, MCP tool lists, disposable Docker proof, public/local/
  packed Runner, live packed PostgreSQL guarded write, content/license checks,
  package dry-run, and `diff --check`.
- Superseded pre-generator-hardening tarball evidence was discarded after the
  final diff review changed code. The exact final tarball is
  `apps/runner/synapsor-runner-1.5.1.tgz`, 1,039,655 bytes,
  4,680,029 bytes unpacked, 223 files. npm shasum:
  `1acdad869995165fcc71fc051c7414821d9dfc1f`; SHA-256:
  `47436bccf4239ceded044c09d859adb00a6c9b7a2d101f2247a0dfff63de2a8b`;
  integrity:
  `sha512-z/bxZaaV7UuADcEQpN40BO41F4w6ue0TKTSWKbZD5TQQ8Nl5s+DLVOTmY+cjTYM+HiTw1b1tqMmUZcIRgG3qjw==`.
- Clean external install at `/tmp/synapsor-runner-1.5.1-final2-0D9TrD`
  verified `--version=1.5.1`, `yaml@2.8.3`, zero npm-audit findings, and a
  3.40-second product-only `try --prove` run. Repeated custom state with spaces
  and Unicode preserved a caller sentinel and used `.synapsor-try`; `demo
  inspect` resolved it correctly. Root, cwd, home, actual/unrelated Git roots,
  direct symlink, and nested symlink cases all failed closed with sentinels
  untouched. Package scans found no development ledger, local home path,
  private-key marker, AWS access key, or OpenAI-style secret token.
- Final diff review found the candidate-generator helper should also reject an
  unrelated Git root even when it carries a valid Synapsor ownership marker.
  That check and preservation regression are now implemented. Focused try,
  schema, and audit safety tests pass 27/27; typecheck and `diff --check` pass.
  Because this is a post-gate code change, full-suite and release-gate evidence
  will be regenerated once more before the commit and replacement tarball.
- Final full suite after candidate-generator Git-root hardening passed: 31
  files and 593/593 tests, followed by license/content and DSL source-path
  checks. Reported Vitest duration: 116.90 seconds. Release gate is next.
- Final release gate after all hotfix changes passed: typecheck, 345/345 core
  tests, exact MCP tool lists, Docker first-run, public/local/packed Runner,
  live packed PostgreSQL guarded write, content/license, package dry-run, and
  `diff --check`.
- Exact final tarball cold install at
  `/tmp/synapsor-runner-1.5.1-final3-QjQRwx` passed `--version`, zero-vulnerability
  audit, a 4.27-second product-only proof, custom Unicode state preservation,
  Git-root rejection, no state creation in the rejected root, and local-path/
  progress/private-key/AWS-key scans.

## Decisions

- The hotfix will be the first independently reviewable commit.
- A string-prefix-only defense is unacceptable.
- Unknown files must be preserved; custom state cannot imply ownership of its
  contents.
- Product-only timings and cold-network `npx` timings will be reported
  separately.
- Reuse the existing `start` -> `onboard db` -> guided `init` path rather than
  adding another quickstart command. `try --from-env` will enter this same
  own-data path and must never fall back to the embedded synthetic proof.
- Raw PostgreSQL/MySQL inspection, generated read/proposal capabilities, local
  UI, shadow studies, and effect regression already exist. The 1.5.2 work is
  therefore orchestration and explicit lifecycle/product semantics, not a
  parallel runtime.
- Generated own-data artifacts will make the canonical contract reviewable and
  keep only environment-variable names and local executor wiring in the Runner
  config. Existing embedded-config compatibility remains supported.
- Cursor project install/uninstall will extend the existing MCP snippet writer
  with preview, merge, backup, idempotency, and ownership checks. It will never
  place database URLs, trusted context values, approval, apply, or revert
  authority in `.cursor/mcp.json`.
- The existing localhost UI remains the external human-review surface. It will
  gain a focused first-action/workbench state and Data-PR presentation rather
  than becoming an enterprise dashboard or a model-visible approval surface.
- The optional TypeScript authoring API will be an `@synapsor/runner` export
  that validates and emits the existing `@synapsor/spec` contract. It will not
  create a new schema or require a spec/dsl version bump.

## Existing-surface inventory (1.5.2)

- `start --from-env` currently delegates to `onboard db`; no duplicate command
  is required. It generates files, validates, runs the boundary smoke, prints
  next steps, and exits. It does not yet install Cursor or open a workbench.
- `inspectDatabase` performs read-only PostgreSQL/MySQL metadata inspection and
  already redacts source errors. `init` supports raw inspection, Prisma,
  Drizzle, and OpenAPI, but automatic project-context detection is absent.
- The guided wizard already asks for table, tenant scope, primary key, visible
  fields, one proposal operation, conflict guard, approval role, receipt mode,
  and app-owned/direct writeback. It writes embedded capabilities only; it does
  not yet emit a canonical `synapsor.contract.json` for the own-data path.
- `mcp configure --client cursor --write --destination ...` merges and backs up
  a caller-selected file, but there is no project-default install/uninstall,
  preview, ownership manifest, or Cursor doctor lifecycle.
- The local UI is localhost/token/CSRF protected and already renders proposals,
  exact diff/guards, receipts/replay, and shadow reports. It does not yet expose
  the requested Project -> Data source -> Trust scope -> Action -> Agent ->
  Test -> Review activation sequence.
- Shadow-study import/reporting and provider-neutral effect fixtures with text,
  JSON, and JUnit output already exist. They need a first-action bridge and a
  packaged reference CI path rather than new evaluation semantics.
- `@synapsor/runner` currently exports only `./runtime`; there is no code-first
  contract authoring export.
- Current README/docs already keep audit visible and describe own-database and
  MCP client setup, but they do not present the full 1.5.2 golden path or the
  new Cursor lifecycle.

## Current 1.5.2 implementation evidence

- Canonical own-data artifact generation and file-only project detection are
  implemented and wired through wizard, reviewed-spec, answers-file, inspected-
  schema, and recipe onboarding. Generated Runner wiring references one
  adjacent canonical contract, while `.env.example`, MCP snippets, and a
  secret-free `.synapsor/onboarding.json` manifest are emitted as one
  preflighted artifact set.
- `try --prove --from-env DATABASE_URL` now enters the same reviewed own-data
  onboarding path, defaults to read-only, and cannot silently fall back to the
  embedded synthetic proof. A focused CLI regression proves the generated tool
  is based on the supplied inspection and no synthetic source/proposal appears.
- Project Cursor lifecycle is implemented through `mcp install cursor
  --project`, `mcp status cursor --project`, and `mcp uninstall cursor
  --project`. It previews changes, validates the exact static MCP boundary,
  merges and backs up `.cursor/mcp.json`, records an integrity marker, is
  idempotent, preserves other servers/settings, rejects external/symlinked/
  unowned/tampered paths, and removes only its owned entry.
- Cursor doctor integration reports marker/config integrity and the exact
  reviewed model-facing tools. A real stdio initialize + tools/list probe is
  opt-in through `--check-cursor`; static evidence is not mislabeled as a host
  launch test.
- Canonical `contracts`-only Runner configs are now recognized by MCP audit, so
  generated onboarding artifacts keep the audit-to-adoption funnel working.
- Latest focused evidence: root typecheck passed; Cursor module tests 2/2;
  Cursor lifecycle + canonical audit CLI tests 2/2. Full suite is deferred
  until the next feature milestone to avoid repeatedly paying the ~2 minute
  CLI-suite cost.
- The localhost UI now consumes the canonical onboarding manifest and renders
  the focused Project -> Data source -> Trust scope -> Action -> Agent -> Test
  -> Review workbench plus a reviewer-facing Data PR assembled from proposal,
  evidence, receipt, and replay records. Its localhost/token/CSRF boundary is
  unchanged.
- Review-mode onboarding no longer records activation without an explicit
  developer decision. Noninteractive review generation requires `--yes` before
  the active review artifact set is written; read-only and shadow manifests
  record their actual non-committing status. Focused regressions were added for
  the unconfirmed-review refusal and status truth.
- The optional `@synapsor/runner/authoring` export is implemented as a typed
  frontend to the existing canonical `@synapsor/spec` contract. It adds no new
  schema or runtime semantics.
- The project Cursor entry now launches an exact-version Runner through `npx`
  instead of depending on a global binary. Current Cursor research was checked
  against local Cursor 3.7.21 and current primary documentation. No custom Add
  to Cursor deep link is generated because no documented generic payload was
  found.
- The optional `@synapsor/runner/shadow` export records app-owned authoritative
  outcomes through the existing scoped/secret-checked shadow ledger. Shadow
  reports now expose an honest Observe -> Compare -> Manual review -> Suggested
  bounded policy progression and never activate policy.
- Effect regression now supports a bounded, shell-free adopter-owned command
  adapter with a minimal environment, explicit deterministic/external-model
  provenance, timeout/output bounds, and canonical result validation. The
  flagship support/billing example uses this adapter and the shadow helper;
  `.github/workflows/effect-regression.yml` emits a JUnit artifact.
- These newest activation/shadow/effect changes have not yet completed their
  focused verification battery. No full-suite or release claim may rely on the
  earlier focused results until this battery passes.
- Root typecheck passed after the activation/shadow/effect implementation.
  Focused module verification passed 29/29 across effect command/result,
  shadow helper, onboarding artifacts, project detection, Cursor lifecycle,
  TypeScript authoring, and local workbench tests.
- The durable proposal-store suite passed 47/47, including SQLite contention,
  restart preservation, shadow classification, shared-ledger behavior, and
  evidence/audit indexing.
- The first flagship evaluation run exposed a source-checkout module-resolution
  defect: the reference app used the public `@synapsor/runner/shadow` export,
  but the monorepo root did not declare the Runner workspace package. The root
  now has an explicit development dependency on `@synapsor/runner`; installed
  and packed consumers continue to use package self-reference. The evaluation
  then passed with 6 classified shadow cases, 2 app-owned human outcomes, and
  the deterministic reviewed $55 effect unchanged.
- The first full CLI-file run found one stale test invocation that generated a
  review action without the newly mandatory `--yes` activation. Both reviewed
  invocations in that test now confirm activation explicitly. Its focused rerun
  passed, followed by the complete CLI file at 110/110 tests in 106.86 seconds.
- Local activation evidence is now explicit and telemetry-free: managed try
  state records product-only timing, own-data onboarding records its clock
  boundary in the secret-free manifest, and `activation show/export` combines
  try, own-data, Cursor, first read, and first proposal milestones without
  identifiers, source rows, credentials, or project paths. Focused activation,
  try, workbench, authoring, Cursor, and CLI checks passed 18/18.
- The workbench no longer calls config validation a completed own-data test.
  Its Test stage remains ready until a scoped query-audit record exists, and
  invalid configuration remains blocked. Focused local UI coverage passes 5/5.
- Audit candidate generation now prints a direct secured-workbench command and
  accepts explicit `--open-ui`. The candidate remains source-less,
  shadow-only, and writeback-none. Audit/workbench focused coverage passes 9/9.
- Public own-data, Cursor, code-first authoring, shadow/effect, activation, and
  host-compatibility documentation has been updated. Cursor 3.7.21 is recorded
  as locally observed; generated-command launch is protocol-tested, while
  inline Apps rendering remains Unknown and approval/apply stay outside MCP.
- Package assembly caught and fixed a tarball-broken workflow link. The rebuilt
  package docs pass link validation. README was reduced to 1,472 words, keeps
  the proof command exactly once, and passes the license/content gate.
- A dedicated proprietary-site branch,
  `release/runner-1.5.2-website`, was created from clean synchronized
  `main` at `0d672f55`. Public copy now uses reviewed compensation rather
  than implying in-place rollback, and the homepage links directly to the OSS
  first-safe-action path.
- The site now defines `/docs/oss-runner` through its canonical docs registry.
  That makes the page statically generated, canonicalized, represented in the
  docs sidebar/index, and included automatically in `sitemap.xml`. The page
  covers audit, synthetic proof, own-data onboarding, Cursor preview/install/
  status, local-only activation evidence, staging/RLS guidance, and the
  external approval/apply boundary.
- The technical article now leads with `try --prove`, documents the own-data
  workbench and owned Cursor lifecycle, identifies the optional TypeScript
  authoring frontend as a compiler to the same canonical contract, and labels
  shadow/effect provenance honestly. Its modified date and reading time were
  updated.
- Both `llms.txt` and `llms-full.txt` now include the audit/proof commands,
  the first-safe-action page, own-database guide, host matrix, and support/
  billing reference example. Focused site verification passed 10/10 tests
  across homepage, article/metadata, sitemap, and LLM discovery surfaces;
  `git diff --check` is clean.
- Complete control-panel verification passed on the website branch: TypeScript
  typecheck, full ESLint, 29 test files with 117/117 tests, and the optimized
  Next.js production build. The build generated 107 pages and retained static
  `sitemap.xml`, `llms.txt`, and `llms-full.txt` routes. No deployment or
  other external action occurred.
- OSS release metadata is now staged separately at `1.5.2` in the root and
  Runner package, with an independent 1.5.2 changelog/release-notes section
  above the preserved 1.5.1 hotfix entry. Spec remains 1.4.2 and DSL remains
  1.4.3. The rebuilt bundle prints `1.5.2`; package docs assemble and the
  license/content gate passes.
- MCP client configuration verification passed for generic stdio, Claude
  Desktop, Cursor, VS Code, and the support-plan-credit snippets. The complete
  MCP runtime file passed 76/76 tests sequentially, including stdio,
  Streamable HTTP, signed per-session context, JWT rotation/JWKS, mTLS, alias
  modes, and MCP App behavior.
- The exact flagship model-facing catalog is
  `support.inspect_ticket`, `support.propose_plan_credit`,
  `billing.inspect_invoice`, and
  `billing.propose_late_fee_waiver`. Live preview confirms raw SQL, approval,
  policy activation, apply/commit, database URLs, write credentials, and
  model-controlled tenant authority are absent.
- Direct execution of the packaged launcher exposed a stale fallback that
  labeled internal hints `synapsor`. The launcher now always identifies the
  local binary as `synapsor-runner`, and the packed verifier checks the
  direct-launcher help text so it cannot be confused with the Cloud CLI.
- Google Chrome headless browser verification exercised the real token/CSRF
  UI with synthetic proof state at 1440x1100 and 390x3000. A mobile metadata
  grid defect was found and fixed; long capability/hash/diff values now use
  the available width without horizontal overflow or character-by-character
  wrapping. Reviewer identity/reason controls now have explicit accessible
  names. Final mobile screenshot:
  `/tmp/synapsor-1.5.2-ui-mobile-final.png`. The browser server was stopped.
- Locally observed host versions remain Cursor 3.7.21
  (`517f696d8ab6c53eb04fbfdaae705cd146bf3460`, x64) and the installed Google
  Chrome. Cursor launch is protocol-tested through its generated command; a
  manual click-through in the Cursor GUI and inline MCP Apps rendering remain
  unverified/Unknown and must not be claimed.
- The first recoverable full-suite run reached 611 passing tests and failed
  only two CLI assertions that still expected the staged 1.5.1 package version.
  Both assertions now expect 1.5.2, including the Cloud-push source-version
  envelope, and the two focused cases pass 2/2. The complete suite must still
  be rerun to a final zero exit status.
- The corrected complete OSS suite passed 38/38 files and 613/613 tests in
  122.04 seconds, followed by the license/content and preferred-DSL-source-path
  gates. The signed Streamable HTTP session-isolation and cross-process SQLite
  contention cases also passed three additional strict sequential repetitions
  each; observed test bodies were about 1.96-2.00 seconds and 2.14-2.17 seconds,
  respectively.
- The generated own-database live smoke initially exposed four stale harness
  assumptions introduced by the safer onboarding flow: it lacked explicit
  `--yes`, read capabilities from the old embedded config, asserted legacy
  capability/result shapes, and accepted `source_auto_migrate` despite using a
  precreated least-privilege receipt fixture. The harness now explicitly
  activates the reviewed action, validates the referenced canonical contract
  and v2 public result envelope, and selects `source_precreated`. Disposable
  PostgreSQL and MySQL runs then passed inspect, generation, validation,
  doctor, tools/list, scoped read, proposal, approval, guarded apply,
  idempotent retry, replay, and stale-row conflict in 47.4 seconds total.
- The disposable support/billing reference application passed. Its flagship
  evaluation also passed with 6 classified shadow cases, 2 app-owned human
  outcomes, 1 exact agreement, 1 human rejection, and an unchanged reviewed
  $55 effect. The app-owned executor demo passed proposal-before-mutation,
  approval, two-row app transaction, idempotent retry, and replay.
- Native live writeback verification passed on PostgreSQL and MySQL for guarded
  single-row CRUD across receipt modes, retry/crash/concurrency behavior and
  DELETE hazards; bounded set UPDATE/INSERT/DELETE, exact members, caps,
  aggregate bounds, drift, atomic rollback, runner-ledger reconciliation, and
  local 1/10/100-row evidence; and reviewed compensation for UPDATE, INSERT,
  soft delete, stale conflicts, kept-out redaction, bounded restore, and
  hard-delete honesty.
- Canonical contract conformance passed 6/6 PostgreSQL and 4/4 MySQL cases.
  Trusted principal row-scope passed for both `.synapsor` and preferred
  `.synapsor.sql` sources on both engines; PostgreSQL database scope separately
  proved RLS, trusted tenant/principal session binding, pool reset, guarded
  writes, compensation, and fail-closed doctor checks. Aggregate reads passed
  count/sum/average, suppression, evidence/audit, timeout classification, and
  no member-row leakage on both engines.
- The multi-instance fleet verification passed shared-ledger claim isolation,
  fleet rate limits, distinct-reviewer quorum, authoritative batch apply,
  competing-worker single effect, before/during/after-commit recovery,
  dead-letter operations, retryable bounded PostgreSQL/MySQL pool pressure,
  backup/restore, and retention. The local Cloud-linked smoke passed runner
  registration, MCP proposal, Cloud approval/job lease, guarded local write,
  and receipt without contacting a live deployment.
- The first 1.5.2 release-gate attempt correctly stopped because its local
  recipe verifier had not added the new explicit `--yes` activation; a scan
  found the same stale invocation in the packed verifier. Both now state
  activation consent, and their focused local/packed runs pass.
- The complete release gate then passed uninterrupted for 1.5.2: typecheck;
  348/348 focused tests; semantic-only MCP client configs; disposable Docker
  first run; public, local, packed, and packed-own-database flows; license and
  content checks; no install-looking handler package references; npm dry-run;
  and `git diff --check`. The dry-run artifact contains 233 files and reports
  1.1 MB compressed, 5.2 MB unpacked, shasum
  `4756400a0513dc37e3d369feb4e5ba9a5d87055b`, and npm integrity beginning
  `sha512-MtinvKlsN7oVO`.
- Runtime-floor testing found the declared Node `>=22.5.0` range was too broad:
  Node 22.5.1 and 22.12.0 pass the old launcher check but cannot import
  unflagged `node:sqlite`. Runner package metadata, source/packed launchers,
  esbuild targets, MCPB compatibility, current docs, and release notes now use
  Node `>=22.13.0`. The rebuilt launcher rejects Node 20.19.5 and 22.12.0
  before bundle load with an actionable diagnostic, while Node 22.13.0,
  22.22.2, and 24.4.1 all report Runner 1.5.2.
- The pinned MCPB build and unpacked runtime verifier pass. The unsigned
  `synapsor-runner-1.5.2-unsigned.mcpb` is 11,892,095 bytes with SHA-256
  `5ffe4d652b97cc1c513a78f63a09a36babdd644652f72d0d240a7e2f7f47202b`.
  Its runtime exposes only the three reviewed support semantic tools and the
  display-only proposal app; no model-facing approval/apply tool is present.
  Signing remains an explicit release-owner step and is not claimed locally.
- The exact post-runtime-fix npm artifact is
  `/tmp/synapsor-runner-1.5.2-final-artifact-UhN8XD/synapsor-runner-1.5.2.tgz`:
  1,142,701 bytes compressed, 5,217,534 unpacked, 233 files; npm shasum
  `b483de24ad99efa8c86ba021cb106b50f240b5cf`; SHA-256
  `9241c1b4b8ef7ea960af8eff82764cfa2ab5ffe9230afae57b0669a589e699ac`;
  integrity
  `sha512-KxGoud3e1tZSu3TOEyXsz2qRZKNoDWXzWRk4ZnJvaJB2cE05YcxhZbnJsNY6HO53HyMLj1/m4EY7k+FJjpB6Yw==`.
- A clean install of that exact tarball passed local, isolated-global, and
  file-based npx version checks; a 4.25-second product-only `try --prove`;
  custom-state sentinel preservation; cwd and symlink refusal; and the
  `authoring`/`shadow` exports. Production dependency audit reports zero known
  vulnerabilities. Package scans found no development directory, local path,
  database/store artifact, private key, AWS credential, bearer token, or
  secret-token pattern.
- Clean-install `npm sbom` produced CycloneDX 1.5 with 131 components at
  `/tmp/synapsor-runner-1.5.2-final-artifact-UhN8XD/synapsor-runner-1.5.2.cdx.json`,
  149,722 bytes, SHA-256
  `0f3bb6da8b0be3d468aa48a6dd20b78f3bc35b39f6f730905a8dc573fa55f16c`.
  npm provenance cannot be truthfully generated by this manual local build;
  it remains a future trusted-publisher/CI owner step.
- The packed own-database verifier now accepts an explicit
  `SYNAPSOR_RUNNER_TARBALL` so a release byte sequence, rather than a second
  implicit repack, can be tested. The exact final tarball passed disposable
  PostgreSQL onboarding, scoped read, proposal, approval, guarded apply, row
  verification, and activity lookup in 23.28 seconds total, including local
  package installation and container startup but excluding registry download.
- A newly measured empty-cache network baseline for the still-live
  `@synapsor/runner@1.5.0` completed `try --prove` in 11.32 seconds on
  2026-07-21T03:02:44Z from `https://registry.npmjs.org`, Node 22.22.2/npm
  11.8.0, Linux 6.17 x86_64, ordinary unshaped network. This is observed
  environment evidence, not a guarantee. A true cold registry npx measurement
  for 1.5.2 is impossible before publication and remains a post-publish check.
- Final live-state read confirms Runner `latest=next=1.5.0`, Spec
  `latest=next=1.4.2`, DSL `latest=next=1.4.3`; Runner 1.5.1/1.5.2 and all
  `v1.5.x` tags/releases remain absent. No external action occurred.
- Final post-runtime-floor complete OSS verification passed 38/38 files and
  613/613 tests in 130.98 seconds, followed by the license/content and preferred
  `.synapsor.sql` source-path checks. The signed Streamable HTTP session case
  and SQLite writer-contention case both remained inside their intended
  budgets without timeout changes.
- Final uninterrupted `./scripts/verify-release-gate.sh 1.5.2` passed:
  typecheck; 348/348 core tests; semantic-only MCP client configs; disposable
  Docker first run; public/local/packed Runner; live packed PostgreSQL
  onboarding/apply; license/content; handler-reference scan; npm dry run; and
  `git diff --check`. The dry run reproduced the exact artifact's 233 files,
  1.1/5.2 MB size report, npm shasum, and integrity.
- Website evidence remains green from the final site diff: typecheck, full
  ESLint, 29 files and 117/117 tests, 107-page optimized build, focused
  metadata/sitemap/LLM-surface tests, and desktop/mobile browser screenshots.
  No website source changed after that run.
- Final limitation audit: Cursor 3.7.21 project wiring and stdio launch are
  protocol-tested, but no manual Cursor GUI click-through occurred and Cursor
  inline MCP Apps remain Unknown. Windows/macOS/devcontainer path handling is
  covered by tests/documentation but was not physically host-tested here.
  A true 1.5.2 empty-cache registry run, npm provenance, MCPB signing, GitHub
  releases, and website deployment all remain explicit post-publish/owner
  actions and are not claimed complete.

## Next exact action

Create the local 1.5.2 OSS and website commits, inspect their hashes/status,
and prepare the separate 1.5.1 then 1.5.2 owner release commands. Do not deploy,
push, publish, tag, or create a release without explicit authorization.
