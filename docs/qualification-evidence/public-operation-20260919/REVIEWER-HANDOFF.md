# Independent verifier handoff

Implementer-owned results; independent acceptance is NOT claimed. Review the failed rows as well as the passing repair. No paid old-candidate rerun is needed.

Repository `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`; evidence directory `docs/qualification-evidence/public-operation-20260919`. Owned raw root:

```text
/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919
```

Start with `FINAL-REPORT.md`, `REMAINING-EDIT-FINDINGS.md`, raw `final-results.json`, `preservation-and-saved-state.json`, `cleanup.json`, and `frozen/installed-artifact-manifest.json`. The final installed tree is `23c6ea7b3f128da6d0022efdb2b1ba70650794f1ec42b71086729282dde26fd7` (7,569 entries), product/test `097c446`, frozen source/evidence `e0210e0`. The report commit is separate; inspect Git for its full SHA.

## Recheck identity and saved evidence without application execution

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919/frozen/freeze-repair.mjs' --verify
python3 docs/qualification-evidence/public-operation-20260919/collect-results.py --verify
```

`collect-results.py` reads saved snapshots, not live databases, and reproduces strict failure verdicts rather than silently passing the extra edit. Manifest records cover both directions of installed-tree inventory, file hashes/modes and symlink targets, local Spec, lockfile/dependencies, entrypoints and Node. `evidence-index.json` hashes the selected raw results/captures. Raw provider material and project stores are local/private; do not put them in Git or print private continuation/credentials.

## Exact gates

The actual commands, source hashes, elapsed time and exit statuses are `R/*-exit.json`. The isolation wrapper is `docs/qualification-evidence/scoped-read-recovery-20260919/verify.py`, with `SYNAPSOR_READ_REPRO_ROOT=R`. Do not use a label ending `-before`: that historical wrapper has a baseline overlay for those labels.

Full final command:

```bash
corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

`full-stable02-exit.json` / `.log`: exit0, 6,563/464. `full-stable-exit.json` / `.log`: historical exit1, two real preserved failures. `full-suite-first-failure.json` identifies both and the narrow correction. `final-types-exit.json`: exit0. `offline-package-plan-attempt2.json` gives the exact ten commands and exits; their full logs remain beside that plan, ignored by Git. `run-offline-checks.py` uses the existing offline cache, local Spec and unshared network; do not infer a network package install.

`postgres-final-review-exit.json` gives the exact nine-case regex and file (`control-policy-authority-codec.test.ts`). Its real PostgreSQL control-store URL is task-owned/scoped, never a public runtime credential. The 413 deselected cases and normal full-suite integration skips remain unrun. Installed PostgreSQL business source / SQLite control results are separate.

## Raw result map

| Evidence | Meaning |
|---|---|
| `public/removal-before/terminal-2.log`, `public/removal-after/terminal-2.log` | Old-install/source-checkpoint before/after; not final artifact evidence |
| `public/removal-final/terminal-{1,2,3}.log`, `decision-frame.{json,txt}`, states | Final rescan, Keep/removal, restart; actual 100×30 frame |
| `public/optional-final/terminal-{1,2,3}.log`, frame and states | Public no-policy catalog control, not proof of a represented optional clause |
| `public/software-final-read/tools.json`, `protocol-result-{1,2}.json`, `protocol.jsonl` | Installed exact schemas, actual permitted and invalid calls, real readback |
| `public/tournament-final-catalog/protocol-result-1.json` | Seven-outcome/four-page Action catalog, detail/search/cursor guards |
| `public/runtime-{primary,secondary}/provider-*.json`, `protocol.jsonl`, status | Same actual schemas, distinct Terra incomplete/Grok read-completed results |
| `public/m4-final-action/terminal-*.log`, snapshots and semantic diff | Fixed public entry reached, interrupted then recovered without requested threshold |
| `public/m4-final-w/terminal-*.log`, snapshots and semantic diff | W saved threshold but changed two metadata flags; strict failure retained |
| `final-meter/{attempt,input,output}-*` | Every actual attempt/response; index3 is a counted pre-send harness refusal with no input/output capture |

The same M4 request is frozen in `m4-edit-plan.json`. Neither failed path was sampled again from a clean start to seek success. The read model lane was capped at three complete responses per model before running; Terra was not extended after failing that ceiling. No `app.request_change` was dispatched.

## Clean starts and restored source prerequisites

Untouched clean starts are `public/{software-reviewer,removal-reviewer,tournament-reviewer}/project`. Hashes/modes are in `reviewer-starts-before.json` and `tournament-reviewer-start.json`, reverified at closure. Read-only portable archives are `saved-state/{software-reviewer,removal-reviewer,tournament-reviewer}.tgz`. Extract a NEW whole directory, never write into these originals or run their saved queues. Keep historical FIFOs as filesystem entries; do not open them. All stopped/final edited projects have separate archives.

`saved-state/releaselab.dump` has 504 original business rows; `tournamentlab.dump` has 104; `refundlab.dump` is the task's metadata-only schema fixture plus owned control-test state. `saved-state/roles.sql` contains role posture with no passwords. Restore into a verifier-owned local PostgreSQL17 container, give the intended reader a new local password, and supply it solely as `DATABASE_URL`. No writer/worker/admin credential goes into the client. The implementer's label-verified container is STOPPED, retained as additional evidence; it is not required to use the saved dumps.

The whole-directory logical mount is essential. Resolve the recorded logical root from `.synapsor/control-policy/migration.json` target path (the directory above `.synapsor`) and mount the new whole project there. Do not edit identity, migration, authority or store bindings to relocate it. `final-launch.py` and `public-preflight.mts` document/run effective ledger resolution plus inode checks before every writable open. For a verifier-owned harness, change only the harness evidence-root/owned-container configuration and private budget files; never rewrite product or saved authority. The existing final harness budgets are closed and must not be reset. Any independent provider allowance is a separately declared verifier lane.

The normal installed commands exercised were:

```bash
node "$INSTALLED/node_modules/@synapsor/runner/dist/runner.mjs" boundary rescan --project-root . --from-env DATABASE_URL --json
node "$INSTALLED/node_modules/@synapsor/runner/dist/runner.mjs" boundary review --project-root . --access
node "$INSTALLED/node_modules/@synapsor/runner/dist/runner.mjs" action review --project-root .
node "$INSTALLED/node_modules/@synapsor/runner/dist/runner.mjs" start --project-root . --cli
node "$INSTALLED/node_modules/@synapsor/runner/dist/runner.mjs" mcp serve --authoring --project-root . --config ./synapsor.runner.json
```

For removal choose R on customers, Enter to Keep, then R/y for disabled removal; restart. M4 recommended route: Action review → Change a verified outcome → same configured model → exact-step consent. W route: start → More options → Manual Boundary editor → W. Both receive the exact unchanged numeric request. “Not now; keep authority unchanged” declines activation and retains the disabled draft. Inspect the full stored program; a review summary or CLI exit0 is not the oracle.

Software runtime used its existing reviewed environment-based trusted tenant/principal contract, scoped per child process. Its old managed identity file was missing, so no claim about that launcher is made. Operator-only context values are in private `software-restoration/runtime-private.json`; do not send them to an authoring model. `final-mcp.mjs` is an ordinary external stdio client using installed `tools/list`, with whole tool-batch mutation refusal before dispatch. Local adapter tests separately cover Runner's Responses and chat encodings.

Revalidate the fixture through normal public controls; don't activate or fabricate a replacement authority merely to make a call pass. The preserved original refunds project stays blocked. No activation, worker, receipt setup, proposal dispatch, source mutation, new domain or fresh onboarding campaign is part of this handoff.

Two decisions only: review the exact stopped edit/recovery differences, then decide on a bounded completion check. No overall pass, fresh Stage A, or unseen Stage B claim transfers from these results.
