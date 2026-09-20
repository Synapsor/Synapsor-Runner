# Independent reviewer handoff — O2 / P1 reporting only

Read `FINAL-REPORT.md`, `IMPLEMENTATION-NOTE.md`, `ARTIFACT.json`,
`OPERATIONAL-RESULT.json`, `RECOVERY-DECISION.md`, then the indexed raw records.
M6 independent acceptance is a separate, earlier-artifact result. This candidate
has implementer evidence only; Stage B remains ATTEMPTED / NOT PASSED.

Raw root (R):
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920`

Installed tree:
`33bf5f661c93cbd5a93677ff59b66dd558053a7ed62b054b9544769d84706c5b`

Verify without modifying it:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920/frozen/freeze-repair.mjs' --verify
```

`R/frozen/installed-artifact-manifest.json` inventories every file, mode, directory
and symlink. `ARTIFACT.json` identifies source, product/tests, archive, lockfile
and both local tarballs. The five installed entrypoints matched the tested build.
Do not replace this installation with another 1.8.0 package.

## High-value evidence

- Before: `R/postgres-before.log`, `R/status-before-capture.json`,
  `R/status04-before.log`; earlier status attempts are harness setup failures.
- Gates: `R/full-stable{,02,03}.log` and exact exit JSONs, all `*-final` logs,
  `offline-package-plan-attempt3.json`. Failed/interrupted suites remain failures.
- Actual operator setup: `R/operational/{w1,w2}/invocation-*.json`,
  `terminal-{read,action,execution}/{terminal.log,events.json}`. Exact reviewed
  receipt commands are in invocation records; `receipt-selection.log` records
  saved intent. Administrator exports remain in the final private project archive.
- W1: `mcp-request/{protocol.jsonl,results.json}`, `state-queued`,
  `missing-writer-{check,run}.log`, `state-missing-refused`,
  `comparison-queued-missing-refused.json`, `restored-check.json`,
  `comparison-queued-restored.json`, `positive-worker.log`, `state-executed`,
  `worker-comparison.json`. Every control table and all source rows were compared.
- W2: `mcp-request`, `owner-drift.json`, `state-owner-drift`, `stale-worker.log`,
  `state-refused`, `worker-comparison.json`, `terminal-blocked-status/frame.txt`,
  `status-json.log`, `blocked-detail.log`, `status-nonmutation.json`.
- W3 synthetic coverage: `apps/runner/src/worker-status.test.ts` and
  `R/sqlite-lease-final.log`. These are seeded status fixtures, not public effects.
- State preservation: `R/owned-final-state/manifest.json`, all database dumps,
  role definitions without passwords and owner-only final project archives.
  They retain applied/blocked queues and are **inspection only**, never launch
  fixtures. `state-prepared` is an oracle snapshot, not a restorable clean project.

Raw worker/control/source records may include synthetic identities and private
facts. Keep them private; public evidence contains hashes and restricted summaries,
not copied values or credential assignments. No Runner provider was used.

## Reproduction commands and prerequisites

The existing `verify.py LABEL COMMAND...` wraps deterministic gates with isolated
HOME, private writable `/var/tmp`, umask 0077 and no inherited credentials.
Exact original commands/settings/exits are in each `*-exit.json`. Database labels
beginning `postgres-` use only an explicitly validated owned test URL; the original
container is removed, so establish a new owned test destination before replay.
Do not point these tests at customer, historical or production stores.

The final operational trial used PostgreSQL business sources and SQLite control
stores. Real PostgreSQL CONTROL coverage is separately in the explicit gates;
it is not inferred from these two public projects.

For a new bounded public trial, create fresh task-owned source/project stores
before using these operations. The known schema/source hashes and 504-row seed
are in `R/operational-preparation.json`. `prepare-operational.py` records the
preparation algorithm; it is not safe to rerun against its already-used paths.
The operational helpers contain this assignment's owned paths. A reviewer must
adapt only its own new fixture destinations and reuse the exact frozen candidate;
never rewrite saved authority/identity/store bindings to relocate an old project.

Use the frozen `synapsor-runner` with the reader credential supplied privately:

```bash
synapsor-runner onboard db --project-root . --from-env DATABASE_URL --schema release_ops --json
synapsor-runner onboard db --project-root . --export-draft export.json --json
# Prepare the known typed input against this new export; no saved authority is copied.
synapsor-runner onboard db --project-root . --draft reviewed-input.json --dry-run --json
synapsor-runner onboard db --project-root . --draft reviewed-input.json --json
synapsor-runner boundary review --project-root . --access
synapsor-runner action review --project-root .
```

The exact rule/access input and its provenance are in each private project and
`typed-input-provenance.json`. Terminal traces record actual confirmations.
Read activation, Action activation, source_db receipt selection, administrator
provisioning, live writer verification, execution confirmation and reviewed local
identity are separate. Confirmations depend on the **new exact candidate**, not
historical hashes. No internal activation API or fabricated actor was used.
Do not start the indefinite worker offered by setup for a finite trial.

After those prerequisites and own-context Read succeed, the generated operations
are (choose the actual fixture writer reference, never put its value in a command):

```bash
synapsor-runner worker check --supervised --config synapsor.actions.runner.json --capability release.seal_candidate --json
synapsor-runner worker run --supervised --config synapsor.actions.runner.json --capability release.seal_candidate --yes --once --json
synapsor-runner worker status --config synapsor.actions.runner.json --json
synapsor-runner worker status --config synapsor.actions.runner.json
synapsor-runner worker dead-letter list --config synapsor.actions.runner.json
synapsor-runner worker dead-letter show <actual-proposal-id> --config synapsor.actions.runner.json
```

The run command performs real work; it is not a dry run. `public-mcp.mjs` uses
the generated reviewed launcher, exactly four tools and normally issued subject
references. `snapshot-operational.py`, `compare-preflight.py` and
`compare-worker.py` show the independent complete-state oracle. Keep the original
2-request/3-invocation evidence distinct from any reviewer replay.

## Review decision

Prioritize: shared assessment/real loader; no pre-claim state changes with a
nonempty eligible queue; unchanged per-item freshness/authority guards; exact
receipt/effect comparison; human/JSON scope/attempt agreement; truthful blocked
recovery limits. Multi-outcome unselected modes are explicitly unassessed, and
status observations are not atomic. Local development identity is not production
authentication. Neither process timing nor result hash is an exactly-once proof.

The next implementation boundary, if selected after review, is
`RECOVERY-DECISION.md`. No terminal blocked recovery was added or attempted here.
