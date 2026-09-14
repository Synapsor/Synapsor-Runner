# Reproduction commands and prerequisites

Use only a new owned root. The `assignment-plan.json` names the original immutable input roots and the current owned root. Never rerun a saved original or its queue in place. Scripts in this directory are prepared harnesses unless an accompanying exit/result file records execution. Historical Stage A acceptance is artifact-specific; original Stage B remains NOT PASSED.

The baseline is 218dd24. Product/test changes are recorded in product-revision.json. The previous complete tree432ed6f05baa07c0d755b3b569ea45ae0b2972cdabcca5cb218ca344234b70ef remains unchanged. Independent Finding9 review covers its model-free interactive capability on that historical artifact, not this repair or a headless path.

From the repository, the actual local executions use `python3 docs/qualification-evidence/saved-job-recovery-20260913/run-local.py NAME [--pg] COMMAND ...`. Each name is exclusive and saves the source manifest before/after, full output and actual process exit. `--pg` reads only this task's private live-postgres.json. The wrapper uses an empty controlled HOME, umask0077, NO_COLOR=1, private writable /var/tmp, a read-only root and an isolated network namespace. Provider credentials are absent.

Named before/after tests:

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/boundary-authoring-resume.test.ts apps/runner/src/saved-action-job-review.test.ts apps/runner/src/structured-counter-review.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
corepack pnpm exec vitest run apps/runner/src/boundary-cli.test.ts --testNamePattern 'resumes disabled Read and saves a semantic clarification without remapping' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

The four PostgreSQL test names and original failure-output lines are in exact-postgres-failures.json. `pg-four-before` is the unchanged-checkout failure. `pg-four-after01` preserves an incorrect new test expectation for the missing-env code; `after02` preserves the ambient-context failure at the other saved-Read lookup; `after03` passes all four, including negative controls. No unavailable authority is reactivated by inspection.

`capture-trace.py` reads the exact acknowledged checkpoint and captured model response; `captured-composed-repro.mjs` passes them through the actual conversation producer and full resume builder. The historical refused file never reached disk, so this is an explicitly reconstructed complete candidate, not a claimed byte-exact missing file. Baseline218dd24 refuses it; the corrected builder saves and reopens it. All three historical trigger texts refuse at the same original guard before6671302. Failed module-loading harness attempts are retained separately; they do not establish product outcomes.

Final gates require the full Vitest inventory, types and all ten commands in run-offline-checks.py on unchanged source. The first full launch was deliberately interrupted before a quoted-value correction; stable-suite-interruption.json records the actual SIGINT exit and explicit bounded replacement launch. Do not combine it with the completed replacement or call either an unexecuted pnpm-test wrapper invocation. The command components and exits remain separate.

The existing live backend gate runs semantic-atomic-postgres.test.ts, semantic-admission-publication.test.ts and automatic-approval-admission.test.ts with the explicitly scoped owned URL. The former42 tests gain one multi-outcome history control. The four named management review tests run separately on the same final source. The required opt-in script scripts/verify-publication-accounting-postgres.sh now includes those four future regressions.

After all gates, run run-freeze.py to create a NEW complete offline installed tree using the local Spec and copied dependency cache. Commit the tested source/evidence checkpoint first. The final installation manifest must list every file, mode and symlink target, dependency lock and entrypoints. Verify the full tree before and after public runs. Never patch an installed candidate.

Public confirmation prerequisites (executed here; use NEW owned copies for any independent repetition):

- prepare-known-run.mjs recovery-tournament-original restores fresh-tournament/stopped-scope-intent from the original authoring-review root. Its saved pending instruction and all seven acknowledged turns remain intact.
- prepare-known-run.mjs recovery-tournament-assisted restores the original stopped-extra-scope checkpoint, including the unaccepted principal cap. compare-recovered-authority.mjs compares the complete normalized program both to that saved draft and to original accepted intent. Its only permitted business correction is removal of that cap; both retained capability filters must remain absent.
- prepare-known-run.mjs recovery-software restores the working final-known-case project AND its matching source dump and source receipt. The same reviewed reader/writer roles are provisioned locally to restore the dump's original grants. The source oracle is the prior independently verified postedit-final-source.json, not original seed rows beside a post-effect ledger. Do not launch a software worker.

`run-public-known.mjs` runs installed `start --project-root . --cli` in a real operator terminal, with the configured OpenAI authoring provider, existing disclosure consent and a persistent bounded meter. It is a normal user path; the observer does not supply drafts or authority. `run-known-command.mjs` runs zero-provider public operator commands. Each performs effective-store preflight and binds the whole owned case to its original logical paths; no identity/authority binding is rewritten to relocate it. Secret values remain in private task-owned files and scoped process environments.

Only one recovered tournament continues through exact Read/Action/execution reviews, reviewed writer provisioning and local client setup to execution. known-model-client.mjs keeps one real configured Claude client connected through the ordinary-language2-to1 league-limit edit. Canonical stored receipt bytes plus independent source readback are the oracle. The second recovery ends at exact disabled save/restart. The restored software job receives a bounded review/rescan and unrelated approval edit, preserving source_db and its source/writer bindings; this does not claim new installed rollback coverage.

Provider budgets:25 authoring calls/45minutes per tournament recovery,15 separate edit calls/45minutes,30 runtime calls/60minutes; software10 calls/30minutes. Keep old and new counters separate. Final result files must distinguish preparation, execution, failed controls, supported operator input, administrator provisioning and engineering assistance.


## Completed installed commands and state oracles

Use the fixed final installation from `installed-candidate.json`. It is not interchangeable with the old package. Every normal operator invocation below used `node run-known-command.mjs CASE ...`; model authoring used `node run-public-known.mjs CASE start --project-root . --cli` in a real terminal. Exact per-invocation arrays, timestamps and exits are retained in each private `public-invocations.jsonl` and summarized in `public-run-counters.json`. Provider failures consume attempts. A reproduced run needs new names/root/socket/container/ledger and the same reviewed logical path mapping; never delete a saved result to reuse a name.

Original tournament sequence: resume with preserved owner statements → decline unrelated policy changes → inspect exact disabled program → public `action review --project-root .` for Read/Action activation, Runner-ledger selection and writer handoff → exact administrator grants → public `boundary rescan --from-env DATABASE_URL --project-root . --json` → separate writer/execution review → `Continue client setup`, local stdio, Claude Code, exact default identity review → one real Claude session and one public worker → public restart → separately reserved ordinary2→1edit, pause disabled, reopen exact `action review`, publish, renew writer/execution review → same Claude client requests fresh R02.

The operator's exact initial correction and later numeric edit are in the captured conversations and ANSI logs. They were ordinary-language inputs, not injected draft JSON. Original has explicit outcome filters on both existing caps; assisted has none. Do not conflate them. Assisted uses only exact cap removal and restart; no activation/worker was attempted.

Actual tournament oracles:

```bash
SYNAPSOR_KNOWN_CASE=recovery-tournament-original node docs/qualification-evidence/saved-job-recovery-20260913/known-initial-execution.mjs before
SYNAPSOR_KNOWN_CASE=recovery-tournament-original node docs/qualification-evidence/saved-job-recovery-20260913/known-initial-execution.mjs execute
SYNAPSOR_KNOWN_CASE=recovery-tournament-original node docs/qualification-evidence/saved-job-recovery-20260913/recovered-tournament-edit-check.mjs before
SYNAPSOR_KNOWN_CASE=recovery-tournament-original node docs/qualification-evidence/saved-job-recovery-20260913/recovered-tournament-edit-check.mjs after
```

The last command's original null-prototype measurement failure is preserved as `recovered-edit-after-result.json`. Corrected read-only comparison writes `after02` and passed. It did not reissue a request. The wider copied `known-preedit-controls.mjs`, `tournament-postedit-check.mjs` and `software-postedit-check.mjs` were prepared historical harnesses and NOT run in this smaller schedule; their assertions/outcomes are not qualification results here.

Software sequence: restored working project + matching source dump → public `action status` → unchanged rescan → preview using the exact existing writer and receipt relation → ordinary60→50 approval edit → exact disabled review → public publication, keep exact source_db receipt selection, check writer and separately enable execution. No software worker/client launch. The successful preview command through the scoped administrator wrapper was:

```bash
node docs/qualification-evidence/saved-job-recovery-20260913/run-known-command.mjs recovery-software --administrator writeback setup --config synapsor.actions.runner.json --profile development --outcome release_ops.seal_candidate --writer-role runner_writer_bfef10f6ea3c --setup-url-env SETUP_DATABASE_URL --schema synapsor_receipts --table synapsor_writeback_receipts --json
```

Preview did not apply objects or grants. Two preceding missing-prerequisite failures are retained. `software-preservation-check.mjs` ran `before`, `after-rescan`, `after-edit` and `after-publication`; each saves exact state before comparison. The final two allow only60→50 in the complete normalized program. No fixture-owner business update was made.

Counter diagnostics: `counter-diagnostic-installed.mjs` first obtained a normal exported typed draft, then exercised both documented aliases with closed stdin and redirected input. Both aliases require the real operator terminal for a new attestation; do not fabricate a TTY and call it headless.

All new containers are now stopped with their states/dumps retained. Frozen tree verification is read-only:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/saved-job-recovery-218dd24-20260913/frozen/freeze-repair.mjs' --verify
```

Read `FINAL-REPORT.md`, `final-scorecard.json`, `remaining-review-consistency.md` and `remaining-review-trace.json` before reproducing. The assisted final attached-policy review is incomplete. A passing normalized disabled draft is not a completed review. Raw logs and transport files remain private local evidence; `raw-evidence-index.json` links their exact hashes. It includes failures, snapshots, ledgers, receipts, source dumps and complete installed-manifest identity. Never run preserved queues or expose private identity/credential files to the authoring model.
