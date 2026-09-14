# Independent handoff — workflow evolution stopped for two decisions

Read `FINAL-REPORT.md`, `tournament-stop-result.json`, `software-stop-result.json`, and the two exact disabled-diff records. This is implementer-owned verification following Claude's separate narrow acceptance PASS. It is not a fresh Stage B pass.

Repository evidence directory:
`/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/workflow-evolution-20260914`

Owned raw root (R below):
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/workflow-evolution-37ec677-20260914`

Unchanged installation:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mixed-counting-review-b655769-20260914/frozen`

Full tree `aff01e8be77d65e614f8b6b283b1692b1a4e663d0240cac2ff9c09a5e2957008`. Product/tests32f12a0; frozen checkpointa021a84; start37ec677. The final delivered commit and clean canonical branch are in **R/delivery.json**, with private push log under R/closure. This receipt is separate from the evidence index to avoid a commit/self-hash cycle.

## Read-only verification commands

From the repository:

```bash
python3 docs/qualification-evidence/workflow-evolution-20260914/verify-evidence.py
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mixed-counting-review-b655769-20260914/frozen/freeze-repair.mjs' --verify
```

The first checks indexed local files without opening a writable database or sending a provider request. Full modes/symlinks/installed dependencies are checked by the second. The new evidence index lists durable raw hashes, not credentials or source contents. Raw source/state stays local. `candidate-verification.json` also resolves the complete manifest, archive, lockfile, Spec and entrypoint hashes.

## Tournament issue requiring the first decision

- Baseline: R/runs/recovery-tournament-assisted/checkpoints/deployment-complete.
- Initial disabled add and failed comparisons: checkpoints/add-paused; meter/input-0011.json/output-0011.txt and0012.
- Exact new owner requirement and accepted null-versus-null comparison: meter/input-0016.json/output-0016.txt; checkpoints/add-stopped/project/.synapsor/boundary-authoring/policy-sources/a6d8098e-7f74-4c80-bcc2-728ba936ef7a.json.
- UI offer/decline and actual exit0: logs/add-resume.tty, public-invocations.jsonl.
- Canonical state comparison: deterministic/deployment-complete-* and add-stopped-*; after-declined-add-actions-result.json.

Recorded public command:
`node docs/qualification-evidence/workflow-evolution-20260914/run-public-known.mjs recovery-tournament-assisted start --project-root . --cli`

Navigation: Draft a change → exact original withdrawal request in EVOLUTION-PLAN → Pause saved job after initial refusal → restart/Resume (automatically retries twice) → Clarify requirement → exact new requirement preserved in tournament-stop-result → Continue with model → activation offered → Not now → Quit.16 actual provider calls. The new domain correctly removed the old singleton interpretation first. The subsequent accepted equal-valued comparison did not establish the source-required outcome/domain claim. No second outcome was activated or runtime miscount measured.

## Software issue requiring the second decision

- Matching pre-effect checkpoint: R/runs/recovery-software/checkpoints/prepared-baseline (504business rows plus one older source receipt).
- Fresh baseline completion: checkpoints/baseline-complete; deterministic/baseline-B04-result.json, baseline-worker-result.json, baseline-B04-replay-result.json, before-/after-baseline-worker source and ledger snapshots.
- Published addition: checkpoints/final-stopped; logs/add-start.tty; meter/input/output0001–0011.
- Exact public contradiction: retirement-contract-result.json requires a slot reference; slot-contract-result.json refuses independent slot access; candidate-related-slots-result.json successfully returns slot values but only candidate references. All are under deterministic/.
- Same-client continuing original behavior: addition-current-catalog-result.json, after-add-original-B06-result.json. No retirement proposal exists.

Recorded add command is the same launcher with `recovery-software`. Navigation: start handoff → Edit rules with model → Draft a change → exact original retirement request → review/enable proposal authority → retain sealing's source_db selection → live writer check and separate sealing execution review → explicitly select same source_db relation/writer for retirement → live writer check and separate retirement execution review → Later. The runtime driver `SYNAPSOR_KNOWN_CASE=recovery-software node .../live-client.mjs` stayed connected throughout. Exact MCP JSON requests and responses are in deterministic/events.jsonl.

The successful baseline used public `proposals approve wrp_rule_9ee4a4e6270fb6b8cfecee506c86ef38 --yes --config synapsor.actions.runner.json` under the reviewed fixture supervisor, then finite `worker run --supervised --once --yes --config synapsor.actions.runner.json --worker-id semantic_action_worker`. No worker ran on a preserved original queue. Source receipt, control core hash and stored byte hash have separate contracts; see receipt-measurement-correction.json.

## Prerequisites and stopping state

Do not execute these saved runs in place. Both task containers are stopped and retained, matching dumps under each checkpoint and R/closure; original roots remain unchanged. Any separately authorized reproduction requires a new whole-project copy and its matching source.dump, preserved logical-project/socket mapping, current effective-store preflight, reviewed local identity and the same immutable candidate. Existing harness files document this restoration; do not manually rewrite authority/identity bindings. Do not run old excess-approval queues or reset history. Source data/identity values must stay outside provider prompts and Git.

Budgets/counters are closed, not reset: tournament16authoring/9MCP/1worker; software11authoring/13MCP/1worker. Removal and removal-specific pending work were not reached. Both normal MCP processes exited0; all26 recorded task process IDs are absent; both verified task containers stopped0 after logs/dumps were saved. Known TRUSTED_BINDING_MISSING was not observed. No product repair, further trial, public release or fresh unseen qualification is scheduled. **STOP for review.**
