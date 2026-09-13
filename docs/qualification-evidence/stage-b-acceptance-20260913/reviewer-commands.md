# Exact commands and saved evidence

All results use one unchanged installation. Commands below describe executed work or read-only inspection; they do not authorize restarting stopped cases. No acceptance smoke, suite, package or backend rerun should be inferred from a prepared script.

```bash
cd '/home/sandesh-tiwari/Desktop/C++/synapsor-runner'
git rev-parse HEAD
git merge-base --is-ancestor 23e51b1e17c5ec22492518be6d3f6bb0d752bfe7 674ca78cbe94765181ff4a02cba02d3f1321fb52
git merge-base --is-ancestor 66adb954d5a2cdf7419d727f7c551740e6da7b5d 674ca78cbe94765181ff4a02cba02d3f1321fb52
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/freeze-repair.mjs' --verify
```

Expected tree: `278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2`, 7,569 entries. Exact manifest, archive, dependencies, Spec and entrypoints: `candidate-verification.json`. Evidence/report delivery revision is recorded separately in the owned root's `delivery.json`; it is not the product revision.

The public commands actually executed were:

```bash
node docs/qualification-evidence/stage-b-acceptance-20260913/run-public-case.mjs tournament-ratification start --project-root . --from-env DATABASE_URL --schema tournament_ops --cli
# Repeated once for the planned saved resume, then once for the labelled assisted continuation.

python3 docs/qualification-evidence/stage-b-acceptance-20260913/record-public-terminal.py \
 '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/cases/software-release-sealing/initial-01.terminal.log' \
 node docs/qualification-evidence/stage-b-acceptance-20260913/run-public-case.mjs software-release-sealing start --project-root . --from-env DATABASE_URL --schema release_ops --cli
```

These are **historical commands, not instructions to run preserved failure stores**. The software log path is already occupied and both canonical working project paths were moved to stopped checkpoints. The wrapper's private metering, accepted-result check, fixture hashes, effective-store preflight, read-only root mounts, owned writable directories, controlled environment and persistent ceilings are part of the recorded execution. The original tournament invocation transcripts were captured without the later advanced terminal timing wrapper.

Each case used its exact `authoring-input/policy.md` copied to `project/rules.txt`, `/attach ./rules.txt`, explicit exact transfer consent, the ordinary job prompt in its transcript and its frozen owner facts. No completed rule was imported. Exact inputs, operator answers, source definitions, provider requests and saved draft transitions are retained under the private case root. `case-selection.json` resolves full fixture and manifest hashes. Recreating UUIDs with the fixture generator would create a different fixture; use the saved manifest and owned whole-copy restoration for any separately authorized replay.

The smallest tournament failure sequence is the existing saved initial pause → normal public start/resume → ordinary tenant=league clarification in `tournament-initial-finding.json` → checkpoint save refusal. Inspect `checkpoints/unaided-clarification-refusal/failure.json` and its hashed transcript/store before causal work. The one subsequent assisted resume is distinct evidence under `checkpoints/assisted-stopped/`; it did not overwrite the original. No existing worker should be started on either.

Software is a budget-limited result: inspect the final `QUALIFICATION_PROVIDER_ATTEMPTS` message and 50 persistent `meter/attempt-*.json` files. `meter/events.jsonl` contains 50 HTTP responses and 50 `response_complete` entries. `checkpoints/budget-stopped/project/.synapsor/action-rules/drafts/reviewed_staging_rules/authority.json` is read-only verifier evidence for `nullable:false`, the explicit guard and disabled state. Do not treat it as a submitted edit or authority to activate.

Executed closure commands (one-time; do not overwrite their existing outputs):

```bash
python3 docs/qualification-evidence/stage-b-acceptance-20260913/close-stage-b.py
python3 docs/qualification-evidence/stage-b-acceptance-20260913/trial-measurements.py
python3 docs/qualification-evidence/stage-b-acceptance-20260913/verify-preserved.py preservation-final-stage-b
```

`close-stage-b.py` verifies recorded host PIDs are gone and the container ID/label/network match before any database read or stop. Its readback compares every source row with frozen facts; its SQLite opens use `mode=ro`. It saves two custom dumps, successful archive listings, roles without passwords and logs before stopping the container. It never runs a worker, deletes history or removes the container. One-time assertions deliberately prevent replaying closure in place.

Owned final state:

`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/fixture-validation/final-saved-state/`

Read `result.json`, both `*-result.json` files, source readbacks and the dump hashes. Dump replay is unnecessary to verify these zero-effect outcomes. Any later writable database replay requires a separately owned restore, verified effective destinations and the applicable public reviews; do not overwrite either original database or snapshot. Identity values/private source facts and connection material stay in this private directory, not Git or a model conversation.

The external reviewer handoff in `reviewer-handoff.md` is preparation history. External acceptance and its independent smoke are at the user's `stage-a-acceptance-review-20260913/ACCEPTANCE-REVIEW.md`, referenced by exact hash in `external-acceptance.json`. The coordinator's own prepared smoke was never executed. The source/full-suite/PostgreSQL-control records from the previous package remain historical exact-build evidence and were not rerun for this report.
