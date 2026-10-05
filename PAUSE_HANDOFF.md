# Paused for account switch — 2026-10-05 UTC

Owner explicitly paused all lanes. No new suite, probe, container or paid run until the owner resumes. Containers and evidence were left in place; no deletion. No Main test process was running at the pause boundary. Product remains unfrozen.

Worktree: `/home/sandesh-tiwari/.codex/worktrees/b36-scoped-private-evidence/synapsor-runner`; branch `codex/b41-operator-resolution-20261001`. Product/tests remain committed at `db67a64ed907db189aa2a208b0f14325d80ed58e`; this continuation changed handoff documentation and external harness/evidence only. Push to verified PRIVATE `backup` (`Synapsor/Synapsor-Runner-Backup`) only, never origin. Never commit root `synapsor.runner.json`.

## State and isolation lead

Full1194 finished exit 1: **8,406 pass / 464 fail / 576 skip**, 9,446 tests, 26 failing files. Retained under E/`settled-source-full1194`; triage is E/`FULL1194-TRIAGE1209.json`. Suspected broad cause: config-discovery isolation. Actual resolver checks confirmed both the worktree-root config and personal `~/synapsor.runner.json` were discoverable; 56 failure messages explicitly name the personal path. This does not yet prove the cause of all 464 failures.

Per owner instruction, moved worktree-root config to E/`preserved-worktree-config1211/synapsor.runner.json`, preserving bytes/metadata (SHA256 `8e6525992a28a2e0b3f2dc0f03a7f1957590a04d2a8b2c4673356933d6ce5ddd`). Record: E/`CONFIG-PRESERVATION1211.json`. Personal config and `.synapsor` were left alone.

Corrected external launcher E/`shared-dev-command-launch1213.py` puts HOME/TMPDIR under `/var/tmp`, isolates networking, and makes the outer filesystem read-only. Existing directories: `/var/tmp/synapsor-full1213-owned/{home,tmp}`. Tiny E/`isolation-probe1213` passed exit 0: no project discovered from worktree/HOME/TMP and personal config not writable. No corrected full suite has started. Owner authorizes exactly ONE corrected full rerun after isolation; do not relaunch old1194.

## Exact next command after explicit resume

First inspect this handoff and remeasure/admit resources: the old 1210 admission covers only a 16 MiB isolation probe, NOT a full rerun. Include the new `/var/tmp/synapsor-full1213-owned` root and Tester's retained 831,488-byte probe (700,416 above its 128 KiB reservation). Preserve prior inaccessible-directory margins/reservations; no deletion credit. Write a fresh full-suite admission to E/`RESOURCE-FULL-RESUME1214.json`. Then run the following exact unfiltered command once (new output directory must not already exist):

```bash
W=/home/sandesh-tiwari/.codex/worktrees/b36-scoped-private-evidence/synapsor-runner
E='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-reliability-20260930/authoring-dead-end-lab-20261002/operator-conversation-470'
python3 "$E/shared-dev-command-launch1213.py" \
  --cwd "$W" --output "$E/settled-source-full1214" \
  --ref "$W/node_modules/vitest/vitest.mjs" \
  --dry-command '["node","--version"]' \
  --admission "$E/RESOURCE-FULL-RESUME1214.json" -- \
  env NO_COLOR=1 HOME=/var/tmp/synapsor-full1213-owned/home \
  TMPDIR=/var/tmp/synapsor-full1213-owned/tmp \
  node "$W/node_modules/vitest/vitest.mjs" run \
  --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 \
  --reporter=json --outputFile="$E/settled-source-full1214/results.json"
```

This is standalone Vitest, not an entire package gate. Collect EXIT/results without a duplicate launch. No DB container is needed for this command. After full: explicit types, real PG, ten offline gates, and actual 20/50/64 final-request size measurements remain pending. Plans: E/`SETTLED-GATE-PREPARATION1196-v2.json`, `settled-postgres1203.py`, `run-offline1205.py`, `size-current1195/measure-v2.mts`. PG/offline preparations still reference full1194 success and old HOME/launcher: update those finite dependencies before use; they have not run.

## Resources and owners

40 GiB cap / 8 GiB free floor. Last Main conservative upper including isolation reservation: 42,179,863,049 bytes; +131,072 Tester reservation = 42,179,994,121, before its reported overage and newer files. Last free 45,718,700,032 bytes. Remeasure; these are stale checkpoints, not new admission. E/`RESOURCE-ISOLATION1210.json`, `TESTER-LIGHT-ADMISSION1212.json`, `RESOURCE-RESERVATIONS1204.json` preserve accounting. Prospective main PG256 MiB, helper A160 MiB, Terra256 MiB, size16 MiB total688 MiB are NOT admitted. Helper later original50 needs another192 MiB. One heavy suite and one paid request globally.

- **Main:** corrected full rerun → settled gates/size → generic product fixes, checkpoints, freeze. No provider/key/count calls. All existing containers remain untouched, including running `main-deadend-lab-a-final-cold-20261005-1129-v2`. Fresh `synapsor-conversation-final1203` PG gate container is only prepared, not created; needs256 MiB and retained PG17.10 image.
- **Helper `action_gap_prepare`:** proposal-only connected-client A/B live rule edits → clean scripted ORIGINALfull50 DEV, separate HOME/DB. No execution approvals/worker/Source writes. Existing `synapsor-helper1160-pg` (`79b1adc01116`) is exited; leave it stopped until resumed and admitted. Preparations: E/`helper-harness-smokes1160/connected-rule-edit-prep1189-v1`, `restore-a1197-v4.py`, `A-CONNECTED-LAUNCH-PLAN-PREP1197-v1.json`, `ORIGINAL50-PROSPECTIVE-NAMESPACE-RESOURCES1209-v1.json`. Current request-only adapter has 10 inert passes; full/scoped ORIGINAL50 coverage still refuses insufficient wire information. No live connected or ORIGINAL50 run yet.
- **Tester chat `01a0bcb8-0925-7380-911a-8bab207b9e0b`:** independent Q04/Q07/Q08/Q16, coherent B, current F3/privacy, all paid operations. Latest tiny synthetic Action probe exit1/0pass8fail was a fixture-schema error (`values:[7]` instead of integer bounds), not a product finding; original evidence retained. Corrected v2 prepared but NOT authorized to start during pause. Tester confirmed PAUSED; final pre-pause allocation856,064 bytes (initial831,488). Independent handoff: `/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-authoring-reliability-20260930/operator-conversation-development/PAUSE-HANDOFF-ACCOUNT-SWITCH-20261004.json`. Helper also confirmed PAUSED with no product edits owed.

One fresh student-registration Terra DEV diagnostic remains authorized only after the full suite, ≤$2 within lab$8 with full50$20 protected; skip if it delays freeze. Tester owns sealed packet at `student-registration-terra-dev-prospective1201-v1/SEALED-OPERATOR-PACKET-PROPOSED.json` beneath their `operator-conversation-development` evidence root. Main adoption: E/`MAIN-STUDENT-FACT-ADOPTION1208.json`. Use disposable DB, SQL00→01→02→03, real source CLI, vague answer → narrower follow-up → clear answer; Version unknown stays pending → true trigger answer; confirm/correct readbacks. No new student DB, SQL application or paid run has started. Reconcile money/currentness/SQL/resources before sending. Historical Class C fences remain; never replay/reset them.

Product cutoff Oct6 17:00Z; final Oct7 17:00Z. Pause overrides standing autonomy until owner resumes. See CURRENT_STATE.md for full retained constraints.
