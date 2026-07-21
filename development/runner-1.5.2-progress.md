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
- Active branch: `fix/runner-1.5.1-safe-try-state`
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
- Phase 1 filesystem safety: implementation, focused verification, and final
  post-dependency full regression complete; final release gate pending
- Phase 1A 1.5.1 release candidate: verified; final diff review and commit in progress
- Phases 2-12 / 1.5.2: blocked by the mandatory 1.5.1 internal gate

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

## Next exact action

Remove the generated tarball from Git status, review/stage the intentional
source/docs/tests/progress files, and commit `1.5.1` independently. Create
`release/runner-1.5.2-first-safe-action` from that exact commit and begin the
own-data activation phases.
