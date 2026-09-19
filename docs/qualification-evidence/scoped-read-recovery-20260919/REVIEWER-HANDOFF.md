# Independent verifier handoff — J5/J6

Implementer result: canonical preparation PASS; negative recovery PASS; original job/private dependency BLOCKED. Do not treat a 26/26 command exit result as 26 ready scoped Reads, or a saved failure as completed onboarding. No independent acceptance is claimed.

Candidate tree: `e60532d31bf71b801112155cbd44d7385577e44d29e4088aeb58cfefbd4b611f` (7,569 entries). Product `7754b79a3cf41c35b964e9905c221d2bca76fdf5`; tests `353165bc8865ae1ccf0aee844a5b70a5916471f6`; frozen source `53e91046ac4015060acaa6ef3aedb00a64afd050`. See [scorecard and limits](FINAL-REPORT.md) and [hash index](evidence-index.json).

All commands below run from `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`. Set paths once (no credential values):

```bash
qualification_root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919'
qualification_tools='docs/qualification-evidence/scoped-read-recovery-20260919'
node "$qualification_root/frozen/freeze-repair.mjs" --verify
```

The complete manifest is `$qualification_root/frozen/installed-artifact-manifest.json`; installed entrypoint is `$qualification_root/frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs`. `frozen/installed-artifact.tar.gz` and `source-checkpoint.tar.gz` preserve complete artifacts. Verify contents bidirectionally using `records` (type/mode/file SHA or symlink target); version numbers are not identity. Do not patch or execute writable projects inside preserved installations.

## Bounded local reproduction

Use a NEW evidence root and an already installed local PostgreSQL 17 image, never the task's sealed stores:

```bash
verifier_root="$(mktemp -d /var/tmp/j5j6-verifier-XXXXXX)"
SYNAPSOR_READ_REPRO_ROOT="$verifier_root" python3 "$qualification_tools/reproduce.py" setup
SYNAPSOR_READ_REPRO_ROOT="$verifier_root" \
SYNAPSOR_READ_RUNNER="$qualification_root/frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs" \
python3 "$qualification_tools/reproduce.py" matrix installed
```

This preserves source schemas, default scope settings, 26 prepared cases, fresh logical `/tmp/project`, RO filesystem outside owned writable roots, effective-store preflight and private credentials. It refuses existing setup/output directories. Verify task labels before stopping your container. The checked-in `inspect-matrix.py` and `validate-matrix.mts` currently address the implementer evidence root; copy those measurement scripts to your owned folder and change only their evidence root to inspect your new result. Do not point them at a different store implicitly.

Composed checks on the source checkpoint, using a fresh owned verification directory:

```bash
SYNAPSOR_READ_REPRO_ROOT="$verifier_root" python3 "$qualification_tools/verify.py" reviewer-focused \
node_modules/.bin/vitest run \
apps/runner/src/scoped-read-recovery.test.ts \
apps/runner/src/read-relationship-host.test.ts \
apps/runner/src/read-relationship-review.test.ts \
apps/runner/src/boundary-authoring-resume.test.ts \
--maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Full exact test commands/exits are in `verification-results.json`; offline commands/exits in `offline-package-plan-attempt2.json`. PostgreSQL selection is eight Read/persistence cases in `control-policy-authority-codec.test.ts`, under `postgres validated operator policy transactions`. Do not carry a source/checkpoint result to another artifact.

## Public recovery recipe and retained material

Original archive:
`/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/REPRO-PACKAGE/j6-project/stopped-j6-project.tgz`

Original logical binding:
`/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/baseline-real-flow/project`

Extract the **whole** archive into an owned copy and bind it over that logical location in a read-only-root namespace. Restore schema-only `source-dump/schemas.sql` to your owned PostgreSQL database and the matching restricted reader role. No historical rows are available. Preflight logical and physical project/store inode equality before writable application opens. Do not hand-edit reviewed store/identity bindings. Existing public `boundary rescan --project-root . --from-env DATABASE_URL --json` was necessary here: the full metadata hash changed while role and all four resource dependencies matched. Preserve and report that prerequisite rather than pretending an exact historical restore.

Exact final invocations, environments by key name, artifact and exits: `O/public/{final-fresh,final-reopen,final-resume}/invocations.jsonl`. Terminal logs contain every input and UI frame. The transport-only meter preserves every request/reply unchanged except credential redaction; it supplies no favorable response. Private raw provider captures are under `O/final-meter`; do not publish readable private continuation.

Public sequence: installed `start --project-root . --cli` → revalidate saved job with exact metadata consent → retain attached policy and original job → relationship refusal. First copy: Reopen → local editor → Quit → restart → Resume → local prerequisite refusal → Save. Second copy: Save → restart → Resume → same local prerequisite refusal → Save. Both restart calls issue **zero** provider requests. The old source never receives an FK guessed from `customer_id`.

Fresh sequence: `start --project-root . --from-env DATABASE_URL --schema refunds --cli`; selected same configured model, attached complete original `handbook.txt` with explicit transfer consent, then exact original job from `evidence/job.txt`. Client deferred. After saved structural refusal, exited and restarted → Resume with no provider call. Required inverse item path remained unavailable. Do not answer by relaxing policy or exposing inspection/fraud facts.

Copy/adapt only the local harness root when independently replaying `public-run.py`; its checked-in default intentionally points at this task's completed evidence. Its expired finite meter plan must not be reset to rerun the implementer attempt. An independent episode needs its own declared plan/consent and clean whole-project copy. Raw original attempts and frozen candidate stay unchanged.

## Evidence to inspect first

- `O/j5-first-divergence.json` plus exact CLI trace: original failure is full seed, not three-resource recommendation.
- `O/{before-isolated,after,installed}/results.json`, `installed/canonical-results.json`, `installed/stored-observations.json`: 14 old failures; 20 canonical +6 scaffold after; renamed-key correspondence.
- `O/final-public-summary.json`: actual seven calls, exact structural requests and process attribution; not time-window attribution across overlapping idle CLIs.
- `O/public/*/{before-state-with-resume.json,after-state.json,continuity-check.json}`: management changes separated from 28 unchanged application tables. `kept_out_fields` only reordered by rescan, not changed in membership.
- `O/public/final-*/recovery-frame.{png,json}`: complete 100×30 redraw, not stitched pages. Actual original terminal logs are the source.
- `O/{before-final-source,after-final-source-source}.json`: equal normalized source dump hash, eight zero-row tables. Doubled suffix in the latter is a retained harness naming artifact.
- `O/stable-full{,02,03}*.json` and logs: interruption, failed full run, separate passing full run. No result laundering.
- `O/closure`: source dumps, archived public projects/logs, exact two-container stop record, previous/new installation and original preservation verification.

Scope guard: no Action/execution activation, worker, runtime request/approval, business source mutation, public deployment or roadmap repair is part of this result. Stage B remains ATTEMPTED / NOT PASSED.
