# Runner 1.5.4 Lifecycle Inspection Progress

Updated: 2026-07-21 America/Los_Angeles

## Objective

Implement `/home/sandesh-tiwari/Desktop/C++/goal.txt` on top of the completed,
unpublished Runner 1.5.4 network-authentication release candidate. Add no-ID-first
typed lifecycle inspection, make weak UPDATE conflict guarding explicit, and
remove Runner's ambiguous `SESSION`-to-environment fallback without weakening the
canonical package split.

## Baseline

- Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`
- Child branch created before source edits:
  `dx/runner-1.5.4-lifecycle-inspection`
- Parent work branch: `security/runner-1.5.4-network-auth-hardening`
- Base commit: `4e27811a7c08458e8ed20cf0bcd6200370a7af9c`
- Base subject: `Ship Runner 1.5.3 safe action workflow`
- `main` and `origin/main`: same base commit
- The inherited dirty tree is the completed Runner 1.5.4 network-authentication
  work recorded in `development/runner-1.5.4-network-auth-progress.md`; it must
  remain intact and be reverified in this release candidate.
- GitHub workflows on the base commit (`ci`, `safe-action-ci`, `mcp-audit`, and
  Dependabot Updates) are green.
- Live npm registry at goal start:
  - `@synapsor/runner`: latest/next `1.5.3`; `1.5.4` unpublished and available
  - `@synapsor/spec`: latest/next `1.4.2`
  - `@synapsor/dsl`: latest/next `1.4.3`; `1.4.4` available
- Local staged versions at goal start:
  - `@synapsor/runner@1.5.4`
  - `@synapsor/spec@1.4.2`
  - `@synapsor/dsl@1.4.3`
- No publish, dist-tag, tag, merge, push, deployment, AWS, or live Cloud change
  is authorized by this goal.

## Current Phase

Implementation and the complete sequential release matrix are complete. All
focused, full, Docker-backed, shared-ledger, scratch-installed packed-artifact,
and inherited network-auth checks are green. The release candidate is ready for
owner review and later commit/merge/publish authorization; this goal performed
none of those external actions.

## Required Decisions To Prove

1. The normal lifecycle-inspection path requires no copied Runner id:
   `lifecycle show`, `lifecycle list`, and filtered `show` by business object or
   other trusted/domain fields.
2. Any known proposal/evidence/query-audit/job/intent/receipt/replay handle can
   resolve the owning lifecycle without exposing persistence tables.
3. Lifecycle inspection is read-only and never calls source databases, Cloud,
   reconciliation, job creation, approval, apply, or worker paths.
4. Ordinary UPDATE authoring cannot silently choose weak row-hash guarding.
5. Runner cannot silently interpret canonical `SESSION` bindings as process
   environment values.

## Verification Log

- `git status --short --branch`: inherited network-auth dirty tree present on
  `security/runner-1.5.4-network-auth-hardening` before child-branch creation.
- `git log -5 --oneline --decorate`: base and `origin/main` confirmed at
  `4e27811`.
- `git diff --stat`: 40 inherited tracked files, 2,919 insertions and 483
  deletions, plus the documented inherited untracked files.
- Live npm checks confirmed versions and dist-tags listed above.
- `gh run list --branch main`: latest base workflows successful.
- Created and checked out `dx/runner-1.5.4-lifecycle-inspection` with the dirty
  tree preserved.
- Focused pre-edit baseline:
  `corepack pnpm exec vitest run apps/runner/src/cli.test.ts packages/proposal-store/src/index.test.ts packages/dsl/test/dsl.test.ts packages/spec/test/validate.test.ts packages/config/src/index.test.ts packages/mcp-server/src/index.test.ts packages/mcp-server/src/jwt-auth.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1`:
  PASS, 372/372 tests in 7 files (137.30 seconds). No baseline failures.

## Phase 0 Findings

- Existing no-ID paths include `proposals show latest`, `replay show latest`,
  filtered list/search commands, and `events tail`. Leaf evidence/audit/receipt
  views still require their own handles.
- `proposals writeback-job` is mutating: it creates/persists a job and appends a
  lifecycle event. It cannot be reused for inspection.
- Jobs and intents are present in both SQLite and shared-ledger export/import.
  `ProposalStore` exposes typed intent readers but no typed writeback-job reader.
- `ProposalStore.replay()` is not read-only: it inserts/replaces a replay snapshot.
  The lifecycle view must compose existing domain records without calling it.
- The existing shared PostgreSQL runtime-store read bridge restores a bounded
  ledger snapshot into an ephemeral local store without syncing it back. Reuse
  this path for lifecycle reads.
- C++/Cloud has an implemented typed request-session model and extensive
  `FROM SESSION` execution/tests. Therefore `session` remains valid canonical
  language-neutral content. Runner must reject it as unsupported rather than
  changing the spec or aliasing it to environment.
- Current DSL compilation silently maps every proposal without `CONFLICT GUARD`
  to `weak_guard_ack: true`. The explicit compatibility syntax will be limited
  to ordinary single-row UPDATE; INSERT omits conflict guarding, while DELETE,
  set operations, reversibility, and runner-ledger UPDATE remain exact/fail-
  closed through their existing operation-specific controls.

## Changed Files For This Goal

- `development/runner-1.5.4-lifecycle-inspection-progress.md` (this tracker)
- `apps/runner/src/lifecycle-view.ts`: pure typed lifecycle resolver/view and
  human/JSON formatters.
- `apps/runner/src/lifecycle-view.test.ts`: store/domain resolution, ordering,
  redaction, stable errors, and no-mutation coverage.
- `apps/runner/src/lifecycle-cli.test.ts`: no-ID aliases, filters, handle lookup,
  missing-store behavior, and CLI help.
- `apps/runner/src/cli.ts`: `lifecycle`, `lifecycle list`, and `lifecycle show`
  command dispatch/help using the existing shared runtime-store read bridge;
  existing leaf views point back to the lifecycle view; doctor/tools preview
  report exact versus explicitly weak conflict guarding.
- `packages/proposal-store/src/index.ts`: typed read-only job/replay readers,
  proposal counting, and deterministic proposal ordering.
- `packages/dsl/src/index.ts`: explicit weak row-hash syntax and exact UPDATE
  requirement; no silent weak guard generation.
- `packages/dsl/test/dsl.test.ts`: exact/omitted/explicit-weak/forbidden-weak
  regression coverage.
- `packages/schema-inspector/src/index.ts` and test: onboarding requires an
  inspected exact conflict column for UPDATE/DELETE and never invents weak
  guarding; read-only and INSERT paths retain their distinct semantics.
- `apps/runner/src/onboarding-artifacts.ts` and test: canonical conversion
  rejects missing UPDATE/DELETE guards instead of defaulting to weak.
- `examples/support-plan-credit/synapsor.contract.json`: removed stale weak
  conflict metadata from the INSERT capability generated by its DSL source.
- `apps/runner/src/contract-tools.ts` and tests: lint/explain expose the weak
  projection-hash caveat and Runner's canonical `SESSION` rejection.
- `scripts/verify-runner-fleet.mjs`: shared-runtime-store lifecycle inspection
  before and after guarded apply, including no persistent local bridge.
- `scripts/verify-packed-lifecycle.mjs` and root `package.json`: scratch-install
  release gate for no-ID lifecycle inspection, typed handles, read-only SQLite
  row counts, exact/weak DSL guards, Runner-target SESSION rejection, packed
  docs, and tarball hygiene.
- `docs/capability-authoring.md`, `docs/dsl-reference.md`,
  `docs/dsl-json-parity.md`, `docs/limitations.md`, and
  `packages/dsl/README.md`: exact-guard migration and canonical-vs-Runner
  `SESSION` behavior.
- `docs/store-lifecycle.md`, root/package Runner READMEs, guarded-writeback,
  config, security, deployment, and release docs: final lifecycle, network-auth,
  conflict-guard, and trusted-context teaching paths.
- `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md`: final
  no-ID lifecycle command, exact/weak guard behavior, Runner SESSION rejection,
  and corrected Streamable HTTP deployment ladder (loopback opaque token,
  remote TLS, shared asymmetric JWT claims, optional mTLS, rotation, session
  credential pinning, RFC 9728 metadata, and request/host/origin limits).
- Runner remains staged at `1.5.4`, DSL is staged at available patch `1.4.4`,
  and Spec remains unchanged at `1.4.2`.

## Implementation And Focused Verification

- Added `synapsor.lifecycle-view.v1` and `synapsor.lifecycle-list.v1` domain
  outputs. Bare `lifecycle`, `lifecycle show`, and `lifecycle show latest` are
  exact aliases; list/show support trusted/domain filters and deterministic
  newest selection.
- Direct handle resolution covers proposal, evidence, replay, writeback job,
  writeback intent, namespaced receipt, and namespaced query-audit records.
  Ambiguous bare numeric ids fail closed.
- Lifecycle state coverage now includes pending review, policy approval,
  partial/complete quorum, approved-without-job, applying intent, applied,
  already-applied, conflict, failed, reconciliation-required, INSERT, UPDATE,
  DELETE, bounded set, and compensation lineage.
- Missing/orphan/corrupt linked records fail with stable domain errors without
  leaking malformed stored payloads. Lifecycle reads are snapshot-tested as
  side-effect free.
- Proposal/evidence/query-audit/receipt/replay/activity/event output now gives a
  direct lifecycle next-command hint, and shared-runtime-store hints retain the
  original config path instead of exposing an ephemeral bridge path.
- Lifecycle inspection reads stored replay/job records directly and does not
  call the existing mutating replay materializer or job creator.
- `corepack pnpm exec tsc -b --pretty false`: PASS after lifecycle work and
  again after exact-guard work.
- `corepack pnpm exec vitest run apps/runner/src/lifecycle-view.test.ts packages/proposal-store/src/index.test.ts`:
  PASS, 51/51.
- `corepack pnpm exec vitest run apps/runner/src/lifecycle-cli.test.ts apps/runner/src/lifecycle-view.test.ts`:
  PASS, 6/6.
- Exact-guard focused run:
  `corepack pnpm exec vitest run packages/dsl/test/dsl.test.ts packages/schema-inspector/src/index.test.ts apps/runner/src/onboarding-artifacts.test.ts`:
  PASS, 69/69 after the expected fixture migrations.
- Chosen explicit compatibility spelling:
  `CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED`. It compiles to the existing
  canonical `{ "weak_guard_ack": true }`, emits a prominent captured-projection
  warning, and is rejected for INSERT, DELETE, reversible UPDATE, and bounded
  UPDATE/DELETE. Omission on ordinary UPDATE is now
  `UPDATE_CONFLICT_GUARD_REQUIRED`.
- Runner `dsl validate` and `dsl compile` now target Runner explicitly and
  reject canonical `FROM SESSION` with `SESSION_BINDING_UNSUPPORTED`. Matching
  process environment variables do not alter that result. The standalone DSL
  preserves canonical parsing and offers `--target runner`.
- Runtime contract loading rejects `SESSION` before selecting any provider;
  ENVIRONMENT, verified HTTP_CLAIM, verified CLOUD_SESSION, and STATIC_DEV remain
  distinct explicit providers.
- `contract lint --strict`, `contract explain`, `doctor`, and `tools preview`
  now agree on exact versus explicitly weak guarding. Human output calls the
  latter WEAK, while JSON output reports `weak_projection_hash` and its reduced
  assurance.
- Combined focused verification after these changes:
  `corepack pnpm exec tsc -b --pretty false` plus nine sequential Vitest files
  covering lifecycle, CLI, contract tools, proposal store, DSL, onboarding,
  schema inspection, and MCP runtime: PASS, 347/347 tests in 158.71 seconds.
- Added explicit state/time filtering and kept-out-field absence assertions.
  `corepack pnpm exec vitest run apps/runner/src/lifecycle-view.test.ts apps/runner/src/lifecycle-cli.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1`:
  PASS, 10/10 tests.
- `corepack pnpm verify:packed-lifecycle`: PASS from a scratch-installed Runner
  1.5.4 tarball. Bare/show/latest are equivalent; proposal/evidence/replay
  handles resolve; every SQLite table row count is unchanged; kept-out synthetic
  source fields are absent; exact guard compilation, omitted-guard failure,
  explicit weak warning/output, SESSION rejection, packed docs, and tarball
  hygiene are all verified.

## Final Sequential Release Matrix

- `corepack pnpm build`: PASS.
- Final `corepack pnpm test`: PASS, 673/673 tests in 41 files, followed by the
  license/content gate, preferred `.synapsor.sql` plus legacy `.synapsor` source
  checks, and Cursor plugin verifier. The signed Streamable HTTP session-
  isolation and cross-process SQLite writer-contention tests both passed.
- `corepack pnpm test:mcp-streamable`: PASS, 208/208.
- `corepack pnpm test:principal-scope`: PASS for PostgreSQL/MySQL and both DSL
  suffixes, including shared-ledger handle isolation.
- `corepack pnpm test:database-scope`: PASS for PostgreSQL RLS, trusted
  tenant/principal binding, connection-pool reset, guarded writes,
  compensation, and doctor diagnostics.
- `corepack pnpm test:fleet`: PASS for two Runner processes using one shared
  PostgreSQL runtime store, claim isolation, distributed rate limits/locks,
  quorum and concurrent review, batch apply, worker/crash recovery, dead
  letters, overload classification, backup/restore/retention, and lifecycle
  inspection before and after apply without a persistent local bridge.
- `corepack pnpm test:mcp-client-configs`: PASS.
- `corepack pnpm test:mcp-cloud-linked`: PASS through registration, proposal,
  Cloud decision/lease, guarded local write, and receipt.
- `corepack pnpm test:smoke`: PASS. The release gate included 372/372 focused
  tests, disposable Docker first-run proof, public commands, local and packed
  Runner checks, packed own-database proof, license/content checks, automatic
  prepack rebuilding, and the Runner npm dry-run.
- Final `corepack pnpm verify:packed-network-auth`: PASS from a scratch install:
  missing/wrong loopback opaque credentials were rejected, undeclared remote
  cleartext failed before bind, direct TLS plus RS256 worked through the official
  MCP client, RFC 9728 metadata/challenges were correct, doctor remained
  redacted, and no secrets or runtime state were packed.
- Final `corepack pnpm verify:packed-lifecycle`: PASS from a scratch install with
  no-ID aliases, typed handles, stable JSON, read-only row-count proof, kept-out
  field absence, exact/weak guard behavior, Runner SESSION rejection, included
  docs, and tarball hygiene.

## Final Package And Registry Audit

- Live npm remains unchanged: Runner latest/next `1.5.3`, DSL latest/next
  `1.4.3`, Spec latest/next `1.4.2`. Runner `1.5.4` and DSL `1.4.4` remain
  unpublished and available.
- `npm pack --dry-run --json` for unchanged `@synapsor/spec@1.4.2`: PASS, 82
  files with README, dist, schemas, fixtures/examples, and no development state.
  Spec must not be republished.
- `pnpm publish --dry-run --access public --no-git-checks` for
  `@synapsor/dsl@1.4.4`: PASS, 14 files. A temporary packed-artifact inspection
  proved the workspace dependency is rewritten to `@synapsor/spec@^1.4.2`.
- `pnpm publish --dry-run --access public --no-git-checks` for
  `@synapsor/runner@1.5.4`: PASS after automatic prepack rebuild, 253 files,
  approximately 1.2 MB packed and 5.6 MB unpacked. It includes `runner.mjs`,
  `runtime.mjs`, README, HTTP/lifecycle docs, examples, schemas, and fixtures;
  it excludes development trackers, local stores, keys/certificates, and logs.
- Root and packaged Runner READMEs are byte-identical at 1,492 words. Modified
  JSON parses, `git diff --check` passes, the external technical deep dive has
  balanced Markdown fences, and no local home path appears in changed published
  documentation.
- The dependency-order release is DSL `1.4.4` first, then Runner `1.5.4`, then
  move each `next` dist-tag to the just-published version. Spec remains at
  `1.4.2`. Exact registry commands are deferred until the owner asks for them.

## Residual Limitations

- Lifecycle inspection is local/shared-runtime-store inspection. It does not
  fabricate Cloud copies of evidence or source rows that intentionally remain
  local.
- Numeric receipt and query-audit ids require explicit `receipt:<id>` and
  `audit:<id>` namespaces so lookup never guesses between domains.
- Explicit weak row-hash compatibility covers only the captured projection and
  is deliberately forbidden for stronger operation modes; exact source version
  columns remain the recommended path.
- Canonical `SESSION` remains valid for C++/Cloud's real typed session boundary,
  but Runner rejects it and requires an explicit supported provider.
- The existing Cursor plugin remains independently pinned to its shipped 1.5.3
  Safe Action workflow. This goal neither modifies nor republishes that plugin.

## Final External Technical Deep-Dive Audit

- Re-audited `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md`
  immediately before owner-authorized merge/push preparation.
- Removed stale text that still described typed lifecycle inspection as future,
  called Runner `SESSION` behavior an unresolved compatibility issue, or treated
  the 1.5.3 package history as the document's complete implementation baseline.
- Made the 1.5.4 source/packed-candidate versus live-registry boundary explicit,
  added the 1.5.4 history entry, and corrected the final source attribution.
- Put the shared-production JWT/TLS invocation beside the loopback opaque-token
  example and made explicit that shared mode intentionally has no
  `--auth-token-env` static endpoint token.
- Replaced invalid clean-machine `npx synapsor-runner` examples with the scoped
  `npx -y -p @synapsor/runner synapsor-runner ...` form and removed a local home
  directory from the repository-demo command.
- Clarified that `CLOUD WORKER` is Cloud-coordinated leasing to registered worker
  infrastructure, not Cloud directly connecting to the source database.
- Extracted the complete cookbook DSL block into a temporary source file and
  ran the final built CLI: strict DSL validation PASS, strict compilation PASS,
  and the documented contract lint PASS. The guide now explains the remaining
  reviewer warning for DSL-authored contract-level metadata instead of claiming
  a strict lint result the DSL cannot produce without reviewed metadata.
- Final document checks: 196 Markdown fences (balanced), no duplicate headings,
  no stale lifecycle/SESSION placeholders, no invalid scoped-package npx form,
  and no local `/home/sandesh...` path.

## Pre-Existing Failures

None. The focused 372-test pre-edit baseline passed.

## Blockers

None.

## Next Exact Action

Owner review of the final dirty feature-branch diff. Commit/merge/push only after
explicit authorization. Publish DSL 1.4.4 before Runner 1.5.4 only after the
owner separately requests registry commands and performs the manual publishes.
