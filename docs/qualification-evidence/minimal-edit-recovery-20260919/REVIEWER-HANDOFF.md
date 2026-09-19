# M4 independent handoff — ready

This is an implementer-owned known-case repair. The previous independent paired edit assessment was an inspection, not an independently repeated model run. All named gates and E1/E2/E3 completed; exact scorecard and preservation limits are in FINAL-REPORT.md. Original Stage B remains ATTEMPTED / NOT PASSED.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919`.

Use the `PLAN.json`, `IMPLEMENTATION-NOTE.md`, final `FINAL-REPORT.md` and `delivery.json` here. Raw source/database/ledger evidence stays outside Git. It contains synthetic fixture data and operator records, not model tool input. Do not execute any preserved queue. Public work is disabled editing only.

## Reproduce deterministic controls

From the canonical checkout:

```sh
python3 docs/qualification-evidence/minimal-edit-recovery-20260919/verify.py reviewer-focused corepack pnpm exec vitest run apps/runner/src/action-rule-disclosure-review.test.ts apps/runner/src/boundary-cli.test.ts apps/runner/src/boundary-authoring-resume.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

The wrapper needs the owned evidence directories to exist and uses isolated HOME, /tmp and writable /var/tmp, umask 0077, NO_COLOR and no provider credentials. It does not provision or activate application authority. For a fresh reviewer environment, create equivalent private empty directories and adjust only the wrapper's owned evidence root. Never change the preserved project store binding.

The `*-running.json` and `*-exit.json` records contain exact commands, actual exit status, elapsed time and before/after source digest. Opt-in PostgreSQL gates are separate: `postgres-stable-review` and `postgres-stable-freshness`; the scoped URL is restricted to the owned local reviewgate database. Ordinary full-suite skips do not substitute for those gates.

## Original and exact response evidence

`public/zero-provider/metadata-baseline.json` and `host-metadata.json` reproduce both disclosure flips through the actual baseline/catalog/compiler/save path, without provider work. `resume-baseline02` is the failing-before post-plan cut. `disclosure-tests02`, `resume-cuts01`, `ready-focused` and final stable gates cover the repair. Earlier failed setup/test attempts remain in the raw root; `focused04` changed source near completion and is exploratory only.

`development-meter/` preserves all six public transport requests and replies. `public/development/terminal-1.log`, `state-before`, `state-after` and `verified-after.json` establish the development result. Subsequent deterministic retention/closure hardening means that run is not evidence for the final installed build.

## Public prerequisites and procedure

Restore the immutable matched whole-project archive and matching source dump into a new owned PostgreSQL fixture. The source has 504 rows (116 slots, 116 candidates, 272 checks). It is the original source restored alongside historical queues/receipts, not a reconstructed post-receipt source. Keep the exact logical root from `.synapsor/control-policy/migration.json` via a whole-directory bwrap mount. Run the effective-store preflight before opening writable application state. Do not rewrite bindings, install writer credentials or start a worker.

`prepare.py` documents owned provisioning; it is not idempotent and must not be rerun over the delivered copies. `launch.py` documents the public installed route, fixed provider and PTY dimensions. It exposes only the synthetic reader URL and the existing authorized OpenRouter key to the process; concrete source rows and runtime identity are excluded from authoring input. The provider meter captures sanitized payloads and raw replies privately and counts pre-send interruption attempts too. The observer self-test includes real consented metadata and synthetic prohibited sentinels.

E1 uses action review and the recommended edit. E2 uses start / More options / Manual Boundary editor / W. Both use the original exact request in PLAN/evidence, accept the separate host annotation correction and review exact disabled differences, then decline activation. E3 uses the declared post-plan/pre-draft interruption and public Resume without retyping. All reopen checks must inspect stored state, not infer completion from terminal exit.

Owner-only oracles: `snapshot-owned.py` records every ledger table, configuration file and source row. `owned.py ... verify-edit.mts` compares the complete compiled authority (including digests), exact active baseline, writer/receipt configuration, application history, pending edit and retained reconciliation evidence. This is independent owner inspection, not a model tool or a product save path. Read the terminal and model replies alongside the canonical comparisons, including review prose changes.

Verify `frozen/freeze-repair.mjs --verify` before and after any run. Never patch the frozen installation. Each verifier must use its own copies and meter; delivered successful projects are evidence, not clean starts.

Final installation tree: `24f0ed0780e2956911bbf0c78c7684adf519909ba31cb96ddf86f36ab07abe1b`; source checkpoint `c046bcbebc2412ac146099e66da97e99d1dc44f7`, product/tests `feb705536859eafd90ee29bb6ac55efd941774da`. Verify with `node "<raw-root>/frozen/freeze-repair.mjs" --verify`. `saved-starts/{E1,E2,E3}.tgz` are untouched matched baselines; `E3-interrupted.tgz` is the actual declared cut with matching source unchanged. Do not use final saved-state projects as clean starts. The owned container is stopped after dumps; restore into your own resources and retain exact logical-path mounts.

Raw index: `final-results.json`, `frozen/installed-artifact-manifest.json`, `saved-starts/manifest.json`, `saved-state/manifest.json`, `final-meter/plan.json`, input/output/attempt files, `public/E*/terminal-*.log`, state-before/after/reopened, verified-* and complete-saved-diff.json. E3 additionally has interrupted-resume.json, interrupted-verification.json, declared-interruption.json and reopen-management-diff.json. All full-suite/type/PG logs and actual exits are raw root; offline logs are `offline-gates/`. Concise Git evidence has the final scorecard and exact commands; raw originals/captures remain private.

Final provider attempts: E1 1–6; E2 7–12; E3 opening/planning 13–14, unsent cut 15, resumed work 16–19. No calls during any final reopen. Provider work is implementation evidence, not independent verification. The E3 repeat authority review saves the identical revision once (epoch 15 → 16); do not demand a false whole-ledger byte-identity claim. No application state or source changes. Independent final live trials belong to Claude's separate declared lane; no need to repeat the heavy suite concurrently.
