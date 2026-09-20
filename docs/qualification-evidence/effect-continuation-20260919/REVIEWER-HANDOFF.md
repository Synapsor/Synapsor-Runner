# Independent handoff — one immutable candidate, one open default-input defect

Verdicts are implementer-owned. Review J1-DATA, M1/X4, O1 and explicit receipt continuation independently. M6's advertised blank-Enter path FAILED and is not offered for acceptance as complete. Exact reproduction: RECEIPT-DEFAULT-FOLLOWUP.md. Original Stage B ATTEMPTED / NOT PASSED.

Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`

Evidence (`E`): `docs/qualification-evidence/effect-continuation-20260919`

Raw (`R`): `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919`

Installed root: `R/frozen/installed`; source `b563c88efa34c52e98b3aec74a6e078cfe7d608b`, product/tests `4b4f362aa06cfb0e42005a1f853bc2cc6e408e09`.

Complete tree **7b99cc6fdc37db2ee6d357932d1f04fe714be323893a21c4fe768df6e3f96244**, 7,569 entries. Manifest SHA256 c2742b40e00472424d029674067ed81d6ad76c8dc67d2ccf07aea51b80f98631. Lock SHA256 6b15ef8aa17b1d6e67f88606ea9125ac57a2afbc944ee93d6406238e72ccd343. Runner pack e40ff11f48684a140b8d6c4f063567bdd6ed97d8315695fac5e00f87e8f707fc; Spec pack27cfef8a1f3d85e8897b5da378e50518e67e69facfced6b566b7731c8376f12e. Tested source archive f7211f0df545a80e3b3c2414f065b45c8ae3867f07101f529362db9e1fd8d499. Use full installed records including modes/symlinks, not package version alone.

## Safe read-only verification now

From the repository, these use saved artifacts and do not open application stores or call a provider:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919/frozen/freeze-repair.mjs' --verify
python3 docs/qualification-evidence/effect-continuation-20260919/compare-final.py
python3 docs/qualification-evidence/effect-continuation-20260919/compare-read.py
python3 docs/qualification-evidence/effect-continuation-20260919/compare-state.py read before final
python3 docs/qualification-evidence/effect-continuation-20260919/compare-state.py deployment before final
python3 docs/qualification-evidence/effect-continuation-20260919/compare-state.py decline fork final
python3 docs/qualification-evidence/effect-continuation-20260919/compare-state.py pending fork final
python3 docs/qualification-evidence/effect-continuation-20260919/compare-state.py decline final restart
```

Comparison scripts write derived reports only; their raw inputs are never changed. `evidence-index.json` gives hashes/locations for captured outputs. Private source/store snapshots stay outside Git. `compare-final.py` checks published program equality, exact selection continuity, execution digest applicability and expected active-pointer changes. The all-table comparator deliberately lists other changes rather than treating every difference as permitted; FINAL-REPORT.md and public-results.json classify those changes.

## Exact raw evidence to inspect

- `public/read/tools.json`, `protocol.jsonl`, `protocol-result-1.json`, `deterministic-status.json`: actual four tools and16 deterministic calls. `runtime-status.json`, provider responses and `final-meter/` contain one Terra episode,3transports/$0.0203919/5tools/29rows. `completed:false` means no final narrative was requested; successful_read/status and rows establish the bounded Read result. No request_change was dispatched.
- `public/read/t2-draft-effects100x30.txt`, `t2-reopened-effects100x30.txt`, `project/inspection-export.json`, `export-comparison.json`: exact disabled two-mutation contract and restart. `inspection-final.json` corroborates active and disabled programs. The original failed raw-wrapper comparison is separately retained.
- `public/deployment/terminal-1.log`, `t3-whole-effects100x30.txt`, `t3-publication-first-frame.txt`, `t3-publication-decision100x30.txt`: actual full effect inspection and only publication. `inspection-post-publication.json` proves old execution is inapplicable and receipt selection stale.
- `public/deployment/terminal-2.log`, `t3-selection-review100x30.txt`, `t3-check-only100x30.txt`, `t3-verifier-before-authorization100x30.txt`: explicit retained values, exact selection review, real writer/receipt verifier, default-No findings, then separate deliberate Yes. `terminal-3.log` / `t3-restart-current-authorization100x30.txt` and `inspection-restart.json` establish reopen.
- `public/decline/terminal-1.log`: failed blank-Enter default path. `inspection-blank-return.json` / `state-blank-return/` preserve the no-save result. `terminal-2.log` / `t3-verifier-default-decline100x30.txt`: later explicit-value control, actual verifier and No. `terminal-3.log` / `t3-restart-current-selection100x30.txt`: current choice survives restart without current execution authority. These are separate recorded attempts, not an uninterrupted blank-default success.
- `public/pending/terminal-1.log`, `t3-unprovisioned-writer-failed100x30.txt`: missing infrastructure blocks at SEMANTIC_ACTION_WRITER_POSTURE_INVALID, including complete-collection/relation/RLS prerequisites. Do not claim an isolated receipt-table failure or completed probe.
- `public/*/state-*`: every one of42tables and all504 business rows. `comparison-*` and `inspection-*` distinguish store records from UI claims. Historical queue/receipts coexist with the original source dump; they do not establish recreated post-execution business state.
- `saved-starts/`: untouched pre-publication four whole-project starts plus provisioned/unprovisioned matching dumps, sealed400. `post-publication-controls/published-before-setup.tgz`: genuine once-published intermediate used for both controls, no pointer injection. `saved-final/`: five projects, three databases, password-free roles and Docker logs, archived before removal; all hashes in manifest.
- `originals-final-verification.json`, `candidate-final-verification.json`, `previous-final-verification.json`, `cleanup.json`: preservation and owned resource cleanup.

## Reproducing an installed local path

The task container was removed. Do not launch these projects against the old URL or run an archive in place. Restore a NEW owned PostgreSQL source from the selected dump, its password-free roles and narrow generated grants. Preserve the original business rows. Prepared `releaselab.dump` includes receipt infrastructure; `pendinglab.dump` does not. Historical earlier original dumps alone do not provide it. The reviewer must establish fresh local reader/writer credentials; retained private files are evidence, not reusable service authorization.

Extract the whole selected project into a fresh writable owned directory. Use `.synapsor/control-policy/migration.json` to retain the bound logical root through bwrap; never rewrite store/identity bindings. `launch.py`/`owned.py` show the exact logical-path isolation and effective-store preflight; update only a NEW reviewer launcher/owned resource inventory. Use isolated HOME, private writable /var/tmp, umask0077, NO_COLOR=1,100x30PTY; model credentials absent unless independently predeclared. Four runtime tools only. No business request, worker or copied queue execution.

Public commands used (through `launch.py` with candidate/preflight):

```text
read protocol
read runtime-read
read action review --project-root .
read start --project-root . --export-draft ./inspection-export.json --json
deployment action review --project-root .
decline action review --project-root .
pending action review --project-root .
```

Follow observed menus; never blind authorization keystrokes. Exact publication/renewal/enable sequence is recorded in terminal logs and the predeclared FINAL-TRIAL-PLAN.md. Full controls were derived only after normal exit from the sole publication. Retain prior attempts, then explicitly type the existing three reference values to test the independent positive route; do not call that a repair of blank Enter. Cancel/decline is default. Do not run the offered worker command.

## Test commands and limitations

`development-and-focused-results.json` contains each exact command, actual child exit, source hash and elapsed time; `offline-package-plan-attempt2.json` and `offline-logs-index.json` enumerate ten independent offline checks. Full03 uses `corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000`, exit0 6602pass465skip. Types07 exit0. Explicit PG control-store review9, receipt-selection1, domain/freshness5 pass; database URL scoped only to those processes. They are separate from installed PostgreSQL-business/SQLite-control evidence. No new full campaign is needed just to read this handoff.

No independent result is attributed to Claude for this candidate yet. Prior M4 E2/E3 remain independently NOT ESTABLISHED; reviewer accidental activation was a fixture violation. Current scope does not qualify software retirement, worker recovery, production identity or multi-host durability. Existing clock/cooperating-version assumptions remain limitations. STOP after the bounded review; the sole new repair decision is the concrete blank-default adapter defect.
