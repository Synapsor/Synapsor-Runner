# Verifier handoff — counting-contract review

Start with `FINAL-REPORT.md`, `SEMANTIC-ADJUDICATION.md`, and **`remaining-counter-review.md`**. Required installed review failed; successful-review restart/recheck are blocked and were not attempted. Case-A semantics remain established; no new owner-policy decision is inferred. This is implementer-owned evidence, not independent acceptance.

## Identities and primary evidence

- Product `bf156a0ba5834c1c832d967400c5f4e2274ea4fd`; implementation/prompt `79b3fdba300c8f7c0166bf229555a97c70b9aa76`; final test-only expectation correction `113859e424e77906fae74a0e2203d714b0014e70`.
- Frozen source checkpoint `26fc90fafa576ec511d74685807327037e8f1ab2`.
- Complete installation **`3a871a30a8e226ad60928290bb387fa2a4432cc32400ed164db8ef780b3f3b75`**. `installed-artifact-identity.json`, complete manifest and dependency tree include local Spec, lockfile, Node and five entrypoint identities. `installed-artifact-verified-after.json` confirms unchanged bytes/modes/symlinks after the public attempt.
- Before trace: `saved-call-trace.json`, with both historical responses. First bad pointer and second substantive conflict remain distinct. `counting-query-unchanged.json` proves the evaluator unchanged.
- Corrected synthetic evaluator observations: `final-postgres02/counting-contract.json` (fourteen actual decisions/records). The first diagnostic's unsupported human timestamp option is retained but is not cited as within-window human evidence.
- After trace: `installed-public-trace.json`, exact two requests/replies, source/owner context, draft and raw-file hashes. Both new replies acknowledge conditional equivalence but use message 3 in a mixed approval passage; host requires exact message 5 for the narrow comparison.
- Persisted result: `installed-public-result.json`, `installed-ledger-difference.json`, `recovery-tournament-assisted-stopped-review.json`, `recovery-tournament-assisted-stopped-counter-disposition.json`.
- `SCORECARD.json` gives the single-candidate verdict; `delivery.json` resolves the final branch/delivery state separately from the frozen checkpoint.

## Exact commands and outcomes

Run from `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`. These are the executed commands; every test's exact argument array, source before/after hashes, environment and actual exit appear in its `*-exit.json`/`.log`. Do not overwrite their evidence or rerun a harness under an existing result name.

```bash
python3 docs/qualification-evidence/counting-contract-review-20260914/run-local.py stable-full03 corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
python3 docs/qualification-evidence/counting-contract-review-20260914/run-local.py types-final corepack pnpm typecheck
python3 docs/qualification-evidence/counting-contract-review-20260914/run-offline-checks.py package
python3 docs/qualification-evidence/counting-contract-review-20260914/run-freeze.py
```

Full03: **6262 passed, 462 skipped, exit0**, unchanged final test source. Types exit0. All ten offline source/package checks exit0. Full01 was interrupted after the dependency guard rejected introduced type cycles; full02 exited1 on five exact-object expectations missing the new field. Both failures and explicit launch amendments are preserved. Never combine targeted reruns into either earlier full-suite result.

The exact real PostgreSQL CONTROL commands are in `final-postgres02-exit.json` (37 passed, none skipped) and `final-review-postgres02-exit.json` (four passed, 416 excluded by pattern). The latter selects exactly:

```text
postgres validated operator policy transactions > keeps Action recovery review available with unavailable Read authority: disabled
postgres validated operator policy transactions > keeps Action recovery review available with unavailable Read authority: revoked
postgres validated operator policy transactions > keeps Action recovery review available with unavailable Read authority: revoked_execution
postgres validated operator policy transactions > keeps Action recovery review available with unavailable Read authority: revoked_unconfirmed
```

They used an owned PostgreSQL 17 database with existing test-only migration/setup permissions and a scoped URL passed only via `--pg`. This is different from the installed PostgreSQL business fixture with a SQLite ledger. Backend source is byte-identical after the final one-line test-only correction (`final-test-only-source-delta.json`). The database is now stopped; dumps/logs and verified IDs are indexed by `backend-cleanup02.json`.

The following two commands are repeatable read-only checks now, with no provider, application save or database open:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/counting-contract-review-f58a824-20260914/frozen/freeze-repair.mjs' --verify
corepack pnpm exec tsx docs/qualification-evidence/counting-contract-review-20260914/replay-public-refusal.mts
```

The replay verifies raw-file hashes and exact extracted replies, then reproduces both parser refusals. Exit0 means the expected failure was reproduced, **not** that the installed review passes. Default operation writes no evidence files; Do not use `--save` here: the initial diagnostic result is preserved and the command refuses to overwrite it.

## Public path, prerequisites and stopping state

Observed installed invocation:

```bash
script -q -f -e -c 'node docs/qualification-evidence/counting-contract-review-20260914/run-public-known.mjs recovery-tournament-assisted start --project-root . --cli' '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/counting-contract-review-f58a824-20260914/runs/recovery-tournament-assisted/logs/public-initial.tty'
```

Selections were **Resume the interrupted job**, then **Pause with all pending work preserved** after the bounded two-response rejection. No owner question was answered, override accepted, repair-routing confirmation selected, or policy changed. Existing `openai[gpt-5.6-terra]`, saved metadata consent and private key handling were retained. The only observation hook was the existing nonmutating provider meter; no response substitution, authority setter or delivery modification was used. Two of25 calls consumed; six restart calls remained reserved. Do not restart this stopped case to seek a favorable opinion.

For any separately authorized reproduction, create a **new** owned root and restore the whole project with its matching source dump from the preserved checkpoint. Use the established `scripts/qualification-sandbox.mjs`, original read-only protections and effective-store preflight. Preserve the logical project/socket/store bindings through mounts; never rewrite authority/identity files to relocate them. The existing helper/plan must be copied into new evidence before changing its owned destination; do not alter this delivered plan or execute its old prepared/stopped directories in place. Verify container ID/label/network and actual database destination before application writable opens. Use the same 104 rows (8 events/96 results), schema, source/owner statements and exact disabled Action revision. Do not provision execution or run a worker for this authoring reproduction.

New stopped whole-project checkpoint:

`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/counting-contract-review-f58a824-20260914/runs/recovery-tournament-assisted/checkpoints/stopped-counter-disposition/`

Original restored starting point remains under the previous task's `checkpoints/stopped-review-conflict/`; it was never executed in place. New source rows, program, active authority and runtime history remain unchanged. A same-revision disabled-save event advanced only the deployment epoch; do not claim the whole ledger is byte-identical.

## Preservation and limits

`preservation-final.json`: 202108 original entries, changed[], added[]. `owned-cleanup-recovery-tournament-assisted.json` and `backend-cleanup02.json` save state/logs before stopping; `owned-resources-final.json` confirms both containers stopped and no recorded task processes remain. Fixtures and immutable installations were retained, not deleted.

The new comparison is point-in-time, tied to exact source/decision/program/store/outcome history. Other outcomes or unavailable history invalidate it. No arbitrary clock-skew, mixed-version, multi-host, universal exactly-once, runtime receipt, production-authentication or unseen qualification claim is added. Deployment and independent after-execution readback remain unverified duties. Historical Stage A remains artifact-specific; original Stage B is NOT PASSED. One next decision is recorded in `remaining-counter-review.md`; no further work is launched by this handoff.
