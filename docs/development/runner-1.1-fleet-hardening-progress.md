# Runner 1.1 Fleet Hardening Progress

This file records implementation and verification evidence for
`feature/runner-1.1-fleet-hardening`. It is not a release announcement.

## Baseline

- Date: 2026-07-12 (America/Los_Angeles)
- Branch point: `f1c3014` (`v1.0.0`)
- Packages: `@synapsor/spec@1.0.0`, `@synapsor/dsl@1.0.0`,
  `@synapsor/runner@1.0.0`
- Node: `v22.22.2`
- pnpm: `10.14.0`
- Initial worktree: clean; `main` synchronized with `origin/main`
- Working branch: `feature/runner-1.1-fleet-hardening`

Baseline verification:

```text
corepack pnpm typecheck
  PASS

corepack pnpm test
  PASS: 16 test files, 265 tests
  PASS: license/content check
  PASS: DSL source path check
```

No pre-existing test failures were observed.

## Security-Path Trace

`loadRuntimeConfigFromFile()` parses runner wiring, resolves embedded and
contract-authored contexts/capabilities through `resolveRuntimeConfig()`, and
validates the merged catalog. MCP serving, tools list/preview, propose,
approval/apply authority checks, workers, doctor, and fleet operations consume
that resolved configuration. `config validate` performs raw validation and
then resolved validation.

Trusted tenant/principal selection is resolved by `resolveTrustedContext()`.
Runner 1.1 adds one effective-context compatibility check over the resolved
catalog, so claim-authenticated HTTP servers cannot silently execute a named
environment/static context.

Activity search delegates object-associated receipt lookup to the proposal
store. Receipt inclusion is based on the receipt's proposal and canonical
business object, not display text.

Shared `runtime_store` mutations use one schema-scoped Postgres advisory lock.
The bridge is capped by `max_entries`; overflow fails closed instead of
performing an unbounded full-ledger copy. Read-only CLI/UI inspection uses a
restore-only bridge, while mutations restore, operate, and synchronize under
the lock.

## Implemented Work

### BUG-012: effective context conflict

- Added `TRUSTED_CONTEXT_PROVIDER_CONFLICT` validation over embedded,
  contract-only, and mixed resolved catalogs.
- Claim-bound HTTP serving requires each effective capability context to bind
  tenant and principal from verified claims.
- Config validation, doctor, tools preview/list, and HTTP startup fail before
  serving an unsafe mismatch.
- Environment-bound stdio/local configurations remain supported.
- Tests cover the original mismatch, valid simultaneous tenant sessions, and
  redacted failures.

### BUG-013: object-filtered activity

- Added proposal-associated receipt filtering in the shared store/query layer.
- Combined object, tenant, capability, proposal, and time filters remain an
  intersection.
- CLI text/JSON and shared runtime-store fleet inspection exclude unrelated
  activity.

### GAP-3: asymmetric session authentication

- Added public-key-only RS256/ES256 verification through `jose@6.2.3`.
- Supports bounded JWKS retrieval/rotation and offline public PEM env/path
  material.
- Enforces algorithm allowlists, issuer, audience, expiration/not-before,
  configured claims, skew, `kid`, fetch timeout, response size, redirect
  refusal, cache lifetime, and controlled unknown-key refresh.
- Rejects private PEM/JWK material and algorithm confusion.
- Existing HS256 remains for backward-compatible local development.

### GAP-4: readiness

- Preserved dependency-free `/healthz`.
- Added `/readyz` to both HTTP transports with safe component names/codes.
- Checks resolved config, source reads, required direct write/executor
  dependencies, and authoritative-ledger transactional writability.
- Live fleet verification covers healthy, source-down, read-only ledger,
  bounded timeout, and recovery without restart.

### GAP-5: pools and rate limits

- Added bounded native Postgres/MySQL pools with connection, idle, queue, and
  acquire-time controls.
- Long-running runtimes reuse/close pools; one-shot commands terminate.
- Added process-local fixed-window rate limits for local mode and atomic
  fleet-wide buckets for shared runtime-store mode.
- Rejections use `RATE_LIMITED` with safe `retry_after_ms` and create no
  proposal.
- Metrics and logs use trusted tenant plus reviewed capability; model arguments
  do not select limiter authority.

### GAP-6: shared-ledger guarantees

- Serialized concurrent migration and mutation under the schema advisory lock.
- Included `rate_limit_buckets` in the shared migration and status checks.
- Added bounded read/mutation bridges for CLI and local UI.
- Added manifest/digest backup, empty-target restore verification, and
  archive-before-delete retention with owner-only archive permissions.
- Retention preserves active/retry/dead-letter/receipt-reconciliation graphs.
- Live verification covers concurrent proposal creation, concurrent approvals,
  competing worker claims, and worker death before write, during an open
  transaction, and after commit.
- Source-side idempotency receipts prove one effect during recovery.

### GAP-7/GAP-8: verified roles and quorum

- Added `jwt_oidc` operator identities using the asymmetric verifier and
  retained signed-key identity.
- Persisted verified subject, roles, issuer/key ID, decision hash, signature,
  and integrity proof without bearer tokens.
- Apply-role checks are shared by direct, batch, worker, dead-letter requeue,
  and discard paths.
- Added optional canonical `required_approvals` (default 1) and DSL
  `REQUIRE n APPROVALS` syntax with JSON/DSL parity fixtures.
- Distinct verified subjects fill quorum slots; duplicate reviewers do not.
- Apply/workers refuse incomplete quorum; authorized rejection is terminal;
  policy auto-approval does not satisfy multi-human quorum.
- CLI and local UI use the shared runtime-store queue.

### GAP-9: metrics and dead letters

- Preserved `metrics show` and added protected HTTP `/metrics`.
- Metrics include bounded proposal/approval/writeback/conflict/failure,
  auto-approval/rate-limit, worker/dead-letter, readiness, and pool counters.
- Labels exclude object IDs, principals, raw errors, URLs, and secrets.
- Added list/show/requeue/discard dead-letter commands with verified operator
  authorization, immutable events, preserved history, and receipt-based
  duplicate-effect refusal.
- Live shared-ledger verification covers requeue recovery and discard history.

### GAP-10: fleet evidence

- Added `examples/runner-fleet/` with synthetic Postgres/MySQL, two Runner
  services, bounded config, seed data, and development-token helper.
- Added `corepack pnpm test:fleet` and
  `scripts/verify-runner-fleet.mjs`.
- Added `docs/running-a-runner-fleet.md` with topology, identity, TLS, pools,
  rates, probes, metrics, workers, dead letters, backup/restore, retention,
  rotation, shutdown, and homogeneous-1.1 rolling rules.
- The docs do not claim untested mixed-version, multi-region, unbounded, or SLA
  behavior.

## Defects Found During Live Verification

The live test found and fixed implementation drift that isolated unit tests did
not expose:

1. CLI migration SQL omitted `rate_limit_buckets`.
2. Concurrent startup migrations could race before taking the schema lock.
3. Legacy MCP error conversion dropped `retry_after_ms`.
4. Shared worker apply recursively attempted the same runtime-store lock.
5. Reviewer read commands and local UI opened a local store instead of the
   authoritative shared queue.
6. The fleet replay assertion expected an obsolete nested JSON shape.
7. Retention creation mode did not explicitly tighten an existing archive on
   POSIX systems.
8. The Compose image copied host dependencies and stale TypeScript build-info,
   causing an interactive reinstall and missing clean-build outputs. A root
   `.dockerignore` now keeps the context small and forces fresh emission.
9. Stdio client closure did not terminate the server runtime, leaving a live
   local-store lease that broke the next MCP session. Stdin end/close now
   performs idempotent server/runtime cleanup and has a regression test.
10. The npm release-asset copier omitted the fleet guide and fixture even
    though package globs allowed them. The extracted tarball now contains both.
11. Readiness recognized only an explicitly declared `direct_sql` writeback,
    so proposal capabilities using the canonical default omitted their writer
    dependency. Readiness now resolves the same effective writeback mode as
    apply, and review-mode tests require the writer component.
12. The production OIDC operator identity accepted token env/file sources but
    not the required stdin path. The shared identity resolver now supports one
    mutually exclusive env, file-env, or stdin source without accepting a
    bearer token on argv.
13. Compose's original `pg_isready` health check could pass against the
    temporary postmaster used by the official Postgres image during fixture
    initialization. A seeded timestamp marker now holds Runner startup until
    the final postmaster is active.

## Verification Evidence

Focused checks completed after implementation:

```text
corepack pnpm typecheck
  PASS

corepack pnpm test
  PASS: 17 test files, 296 tests
  PASS: license/content and DSL source-path checks

readiness/OIDC/activity focused regressions
  PASS: 4 files, 165 tests

corepack pnpm test:fleet
  PASS (2026-07-12 America/Los_Angeles)

docker compose --profile fleet ... up --build -d --wait
  PASS: clean image build; Runner A/B health and readiness returned 200
  PASS: source, implicit direct-writeback, and ledger components reported ready
  PASS: unauthenticated metrics returned 401; separate token returned metrics

corepack pnpm test:first-run
corepack pnpm test:mcp-client-configs
./scripts/verify_adoption_quickstart.sh
./scripts/verify-local-runner.sh
./scripts/verify-packed-runner.sh
./scripts/verify-packed-own-db.sh
./scripts/verify-release-gate.sh
  PASS

npm pack --dry-run (spec, DSL, Runner)
  PASS: spec 70 files; DSL 10 files; Runner 145 files

extracted Runner tarball scan
  PASS: fleet docs/fixture present, audit visible, no private key,
  machine-local path, RDS host, or AWS access-key pattern
```

The passing live fleet run proves:

```text
two claim-bound Runners share one bounded Postgres ledger
cross-tenant reads fail closed
fleet-wide rate limits and one-active-proposal locking hold
1/2 quorum blocks apply; concurrent reviewers preserve 2/2
competing workers create one source effect
worker death before, during, and after commit recovers without duplication
source-down, read-only-ledger, and timeout readiness recover without restart
shared dead letters requeue/discard with receipts and events preserved
Postgres/MySQL pool pressure fails fast
backup digest, clean restore, and archive-before-retention verify
```

All required release, packed-install, Compose-profile, and package-content
checks have passed on the feature branch. A final release-gate rerun after any
subsequent edit remains mandatory.

## Compatibility And Release State

- Existing 1.0 contracts remain valid; new quorum fields are optional.
- Infrastructure wiring remains in `synapsor.runner.json`, not the canonical
  portable contract.
- Package versions are staged at `1.1.0` only.
- Cloud/C++ enforcement of the optional quorum field is not claimed.
- Changes are committed only on `feature/runner-1.1-fleet-hardening` for manual
  review. Nothing is merged, pushed, tagged, deployed, or published as part of
  this work.
