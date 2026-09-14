# Attached-policy reconciliation — working verifier handoff

Status: **NOT COMPLETE**. Final suite/types/backend/offline gates pass. Public B/C/D pass; required A fails on the accepted absent-selector meaning. See `FINAL-REPORT.md`, `scorecard.json` and `remaining-assisted-review.md`.

Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`, canonical branch `codex/tui-safe-action-control-plane`, baseline `9ca8a480b5a6aa8b8f49a44ce2a32e902c17e591`. `assignment-plan.json` fixes budgets and exact evidence roots. Prior tree `9e88145ed118e5e1f87f5dc0c55fe19197299dd9913633917c2b07c085cb3367` is historical and read-only. The prior report and raw index resolve all originals; `initial-saved-review-trace.json` preserves the actual accepted statements, reviewer calls, classifications and pending instructions.

## Trace and intended result

Assisted: exact saved tenant maximum two / boundary maximum six, both capability selectors ABSENT. The actual reviewer input already carried the five accepted operator messages and canonical null-selector evidence. A later filter preference is not a policy change; the preservation guard correctly refused it. Original: the same maxima, with the actual `league.ratify_result` capability selectors retained. These are different accepted programs.

Independent source readback is a required observation after each applicable execution, unverified in authoring. A receipt, stored execution configuration or external harness report is not that observation. An automated runtime postcondition that is actually required and unavailable remains unsupported. The original post-receipt checkpoint already had a later-duty classification but retained an older generated Action repair; history must retain that text without replaying it as owner intent. Ambiguous legacy origin requires an operator routing choice. No missing Action edit is claimed to have been implemented.

## Commands and evidence

All commands below run from the repository. The wrappers establish controlled HOME/umask, private writable `/var/tmp`, `NO_COLOR=1`, absent unrelated/provider credentials, and owned effective-store preflight. Only public authoring intentionally receives the previously authorized configured provider credential. Never copy credentials from evidence into a command.

- Stable run: `python3 docs/qualification-evidence/attached-policy-reconciliation-20260913/run-local.py stable-full corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000`. First launch retained; one explicit follow-up correction authorized a second `stable-full02` within the same 120-minute ceiling. The final result is in `stable-full02-exit.json` and its complete `.log`; the earlier build result remains separate.
- Types: `types-final04-exit.json` records the exact command and source content manifest.
- Explicit management review: `final-pg-four02-exit.json` runs all four exact `postgres validated operator policy transactions > keeps Action recovery review available with unavailable Read authority:` cases (disabled, revoked, revoked_execution, revoked_unconfirmed), not an arbitrary revoked-name selection.
- Current accounting/publication/atomic receipt: `final-postgres03-exit.json`; 43 tests, including real PostgreSQL control-store cases. SQLite/file-authority cases in that selection remain separately named in the raw results.
- Ten offline checks: `python3 docs/qualification-evidence/attached-policy-reconciliation-20260913/run-offline-checks.py source` (six read-only source checks), then `python3 docs/qualification-evidence/attached-policy-reconciliation-20260913/run-offline-checks.py package` after the full suite (four build/package checks). Individual exits are in `offline-package-plan.json`, never inferred from a later check.
- Freeze: clean committed tested source, `product-revision.json`, then `python3 docs/qualification-evidence/attached-policy-reconciliation-20260913/run-freeze.py`. Complete manifest, Spec, dependency lock/tree, archive, five entrypoints and Node identity remain in the owned `frozen` directory. Verify before/after public checks using its saved `freeze-repair.mjs --verify`.
- Prepare A/B/D: `node docs/qualification-evidence/attached-policy-reconciliation-20260913/prepare-known-run.mjs <run> --fixture-only`, then `bind-known-candidate.mjs <run>` after freeze. Exact run IDs are `recovery-tournament-assisted`, `recovery-tournament-original`, `recovery-software`. Each is a new whole-project copy with its matching dump; preparation is not execution.
- Public recovery: `node docs/qualification-evidence/attached-policy-reconciliation-20260913/run-public-known.mjs <run> start --project-root . --cli` in a recorded real PTY. Retain the real questions and responses, provider meter and exits. No fixture-specific rescue instructions may enter product prompts.
- Quiescent checkpoint: `node docs/qualification-evidence/attached-policy-reconciliation-20260913/snapshot-known-run.mjs <run> <unique-label>`. This independently verifies matching source state and records whole-project/store hashes without supplying application evidence.
- Read-only result export: `corepack pnpm exec tsx docs/qualification-evidence/attached-policy-reconciliation-20260913/verify-saved-review.mts <run> <unique-label> <baseline|reviewed|edited|observe>`. Baseline label must be `baseline`; the script uses the same host review classifier on saved records and is explicitly HOST verification, not another installed public operation. Inspect the actual installed captures as well.
- Only after B passes and its quiescent `reconciled-before-edit` checkpoint exists, prepare `edit-tournament`. Its independent 12-call allowance does not alter A/B counters. Request only the original two-to-one disabled edit; save/pause/restart. No publication or source execution is scheduled by this assignment.
- D preserves source_db and existing configuration/history. `software-preservation-check.mjs before` / `after-review` are independent read-only owned-source inspections, never application proof that all future observations occurred.

## Final one-artifact results

Tree `e4a0689b104b39aed7db7a2053a135e3265459d0df58e7378d7efb01c62ba829`; full manifest and hashes in `installed-candidate.json`. `installed-after-public-verify.json` confirms unchanged bytes after all public checks. Product/test commit af0df52896337c7aafcf13ea99c0828f10afe605; frozen source c28dc09d75475323811b8db09aebbe12dec566b3. The delivery report commit is recorded separately.

| Row | Result | Authoring calls |
|---|---|---:|
| A | FAILED: accepted absent selectors remain conflicted; completed-review restart/recheck blocked | 2/25 |
| B | PASSED: generated task archived with explicit legacy-origin choice; exact original program/history and restart retained | 1/15 |
| C | PASSED: separate disabled 2→1 edit only, saved/reopened, unrelated semantics retained | 6/12 |
| D | PASSED: source_db/observation distinction and source/history preserved; original generic wrapper-comparison failure separately adjudicated | 1/8 |

The public commands above are **recorded commands**, not permission to run preserved stores in place. All task-owned databases are stopped and their final dumps/whole-project checkpoints saved. A new reproduction must use a separately owned root and a whole-project copy with its matching source dump. Change only harness locations/owned resource names, never reviewed project/identity bindings. Preserve original inputs and verify the complete frozen tree before using it. The wrappers' refusal to re-prepare an existing run is intentional.

Current snapshots/captures resolve through `raw-evidence-index-pointer.json`. Each run's `public-invocations.jsonl`, `meter/input-*.json`, `meter/output-*.txt`, `meter/events.jsonl` and recorded PTY logs retain actual inputs, outputs, calls and process exits. Deterministic host exports are measurement evidence only. `software-wrapper-adjudication.py` compares the already-saved before/after snapshots; it does not rerun the app or modify state. Its original exit-1 wrapper comparison remains in `software-public-review-exit.json`.

The final full suite actually exited 0 with 6,238 passes/461 skips; final types, 4 named management-review cases, 43 shared backend tests and all ten offline checks separately exited 0. Use their exact exit JSON/logs rather than combining targeted counts. Four owned case containers plus the separate backend fixture were saved/stopped; `preservation-final.json` reports 185,837 original entries unchanged.

Failed development attempts remain retained, including the introduced nested-lock correction and source-race test. They are not silently converted into passes. Controlled response tests are not live model completion. Raw original captures are not reconstructed inputs. `prompt-change-audit.json` links exact before/after text to traced calls and records the fixture-term scan.

Historical Stage A acceptance remains attached to its accepted build. Original Stage B is NOT PASSED. Add/remove and other unrun qualification rows remain unrun. The independent TRUSTED_BINDING_MISSING worker-retry classification finding is outside this repair and requires its own decision; no worker is run here. No new unseen qualification, multi-host, clock-skew, production identity, receipt or execution guarantee is claimed.
