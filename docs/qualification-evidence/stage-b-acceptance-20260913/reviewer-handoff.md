> Acceptance delivered 2026-09-13T08:02:55.929926+00:00. See external-acceptance.json and the cited external report. The reviewer used its own fresh fixture; this coordinator smoke remains PREPARED/NOT EXECUTED and will not be redundantly run. The initial handoff below is preserved as history.

# External Stage A acceptance handoff

Status: **IN PROGRESS EXTERNALLY**. The user has an independent reviewer. No independent result has been supplied; nothing here is an implementer self-review relabelled independent. The prepared smoke has not run. Stage B authoring is paused until the external result establishes no material blocker.

The target is the reported named Stage A result on product/test `23e51b1e17c5ec22492518be6d3f6bb0d752bfe7`, frozen source `66adb954d5a2cdf7419d727f7c551740e6da7b5d`, delivery `674ca78cbe94765181ff4a02cba02d3f1321fb52`. Candidate tree:

`278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2`

The complete installation is under `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/installed`. Do not rebuild it or execute a preserved queue. `candidate-verification.json` records the implementer's exact manifest, archive, lockfile, Spec, dependency-tree and entrypoint check with exit 0. Recheck independently:

```bash
cd '/home/sandesh-tiwari/Desktop/C++/synapsor-runner'
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/freeze-repair.mjs' --verify
```

Expected manifest SHA-256: `d3defd6057ab46150736339a2f08a47ca20864eb86a1d293d4d308ceb7625103`; archive: `b363f9ea100ef3da9ee1cd71a12d3835ee0a297d7973507f7402036888e4fdf0`; lockfile: `842f9b3e4026839ff3cf03204249abea8e0b3e86d72d10a2b28625c71b6830f7`; local Spec 1.11.0. The manifest enumerates all 7,569 entries. Do not use a version number as the artifact identity.

## Evidence inspection, separate from new observations

Use `../reviewed-local-clients-20260913/verification-report.md`, `installed-scorecard.json`, `reviewer-commands.md`, `installed-evidence-index.json`, `host-test-evidence-index.json` and `complete-log-index.json`. Their private paths resolve to the delivered owned root above. `delivery.json` there records the actual private-backup push. `evidence-index.json` in this directory hashes these entry points for this handoff.

Check assertions against the indexed complete raw records, including:

| Assertion | Durable evidence to inspect |
|---|---|
| Shared contexts use one history | `runtime/shared_02/deterministic/shared-matrix-result.json`, its before/after ledgers and real writer-boundary events; four exact launcher references and shared identity contract |
| Insurer and overall caps | Legitimate automatic approvals joined to proposals; actor, boundary, capability, trusted tenant and inclusive admission-time selectors; review loser has no approval or executable queue entry |
| Receipt/readback | `runtime/shared_02/deterministic` A1 stored canonical receipt, ledger and independent source snapshots; do not compare absent response IDs |
| Both A3 cases | `runtime/collection/deterministic` source/receipt comparisons and actual source-wait observations; worker concurrency one, no claim of simultaneous effect transactions |
| Publication and late refusal | `runtime/edit`, `admission_first`, `replacement_first`; retained history, no outdated dispatch, truthful late message, pending duplicate control and the separately verified operator-rejection recovery |
| Identity lifecycle | `runtime/identity_lifecycle_02` exact operator retirement, connected-context continuity, future-launch refusal and unchanged second entry; retain the first corrected measurement attempt separately |
| Stable/backend/package gates | Stable-full02 6,152 passed / 461 skipped, types exit 0, real PostgreSQL CONTROL 41 passed, ten offline checks exit 0; all remain tied to this unchanged build |

Shared-context rows depend on setup code written in that implementation assignment. Its regressions are evidence for the feature, not independent Stage A acceptance. Please record code inspection, evidence inspection and newly executed observations separately.

## One fresh public setup smoke

Suggested bound: 60 minutes, one smoke, at most one correction for a demonstrated harness error; preserve the original attempt. Do not weaken a product assertion or replay in the same failed store. No worker is needed or permitted by this smoke's zero-worker budget. This is the existing known insurance fixture, not either unseen Stage B case.

Prepared root:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/external-review-smoke`

`prepare-reviewer.py` has only copied and syntax-checked the retained harnesses. `reviewer-preparation.json` records every adaptation and hash. No fixture database, operator interaction or allowance request has executed there. The originals and candidate stay read-only inside the existing sandbox. Whole-directory remapping and the existing hash-checked effective-store preflight remain mandatory before writable application opens.

Run the following in order. Keep all output in the owned root, which can contain local identity/store records and must not be committed. Stop an affected path on failure. The local PostgreSQL 17 image, Node, bwrap, Python/pexpect and dependencies are already installed. The database is task-owned, network-none and reached only through its private Unix socket; no inherited provider or unrelated credentials are needed.

```bash
review_root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/external-review-smoke'
review_harness="$review_root/harness"
umask 077
env -i PATH="$PATH" HOME="$review_root/host-home" LANG=C.UTF-8 NO_COLOR=1 node "$review_harness/start-local-postgres.mjs" > "$review_root/postgres-prepare.log" 2>&1
env -i PATH="$PATH" HOME="$review_root/host-home" LANG=C.UTF-8 NO_COLOR=1 node "$review_harness/prepare-runtime.mjs" identity_lifecycle_02 > "$review_root/fixture-prepare.log" 2>&1
python3 "$review_harness/drive-client-setup.py" identity_lifecycle_02 review-smoke primary > "$review_root/setup-primary.json" 2>&1
python3 "$review_harness/drive-client-setup.py" identity_lifecycle_02 review-smoke colleague > "$review_root/setup-colleague.json" 2>&1
python3 "$review_harness/run-owned.py" reviewed-contexts --case identity_lifecycle_02 node "$review_root/runtime/check-reviewed-contexts.mjs"
python3 "$review_harness/run-owned.py" shared-allowance --case identity_lifecycle_02 node "$review_root/runtime/reviewer-allowance-smoke.mjs"
python3 "$review_harness/run-owned.py" future-launch-retirement --case identity_lifecycle_02 node "$review_root/runtime/installed-identity-lifecycle.mjs"
```

Record each command's actual exit immediately; do not proceed on an unsuccessful prerequisite. The two setup calls drive the real `action review --project-root .` → Continue client setup route, separately review hidden synthetic identity values, select/install each exact newly created reference and perform the launch check. Same label, different immutable reviewed revisions: creating the second must preserve the first file and launcher. The selected reference is shown in the operator review and written into the trusted generated launcher. The own-context harness uses those exact entries, diagnostics, four-tool startup, positive scoped reads and restarts. If separately exercising re-selection of an already-saved reference is desired within the same bound, use the displayed exact reference in Continue client setup; otherwise label that extra operation unexercised.

The whole restore preserves the original 40 source rows and the one legitimate previously executed approval. The allowance harness measures whether that approval is still within the rolling window; it does not assume an old timestamp remains counted. It creates the remaining history through normal requests on distinct eligible subjects until two approvals are counted. Two different principals in the same insurer then contend on a shared SQLite writer lock: expect exactly three counted approvals, one new automatic approval and one persisted pending-review loser, without source effects. All previous approval records must remain. Both the inspector's pauses and the actual SQLite wait are reported; send timing alone is not coverage. Review the canonical selectors against the previous matrix instead of treating profile labels as budget keys.

Finally the lifecycle harness keeps the first client connected, retires that exact reference through the public operator menu, verifies its cached own-context read, stops it, verifies future launch refusal, verifies the other reviewed client still reads its own rows, and uninstalls only the retired launcher entry. Retirement is **future-launch prevention**. It does not revoke an already-connected process, cancel admitted work, refund approvals or requeue anything.

Before cleanup, save results and verify no recorded process remains. The existing adapted cleanup script verifies its exact owned container ID/label/network, saves database dumps, logs and retained SQLite state, then stops that container without removing it:

```bash
python3 "$review_harness/save-and-stop-owned.py"
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/freeze-repair.mjs' --verify
```

If a process is still running, the cleanup refuses. Identify it before stopping anything; do not touch the stopped prior-assignment container. The coordinator's preservation baseline excludes this new reviewer root and covers the original evidence/candidate.

## External return

Please return the exact candidate hash, reviewed evidence paths, actual smoke commands/exits and owned result paths, independently observed assertions, unexercised parts, discrepancies classified as material blocker/minor observation/disclosed limit, and the bounded acceptance decision. No whole-suite rerun or complete Stage A replay is requested. Stage B authoring begins only after the delivered external acceptance says there is no material blocker; provider preflight and case freezing may proceed beforehand.
