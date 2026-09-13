# Reproduction index (bounded run closed)

Canonical checkout: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`.
Evidence directory: this directory. Every automated command, start/end time,
exit and unchanged-source hash is in its `*-exit.json` record. Raw `.log` files
are preserved verbatim. No combination of reruns changes an earlier verdict.

Final complete installation: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/quota-receipt-454a0d2-20260913/frozen/installed`.
Full tree: `432ed6f05baa07c0d755b3b569ea45ae0b2972cdabcca5cb218ca344234b70ef`.
Source: `fbf5efdab77fa5011544524592d58fa007388e95`.
Product/test/merge identities and the manifest, lockfile, archive, local Spec and
entrypoint hashes are in `final-installed-identity.json` and
`final-installed-artifact-manifest.json`.

Read-only verification:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/quota-receipt-454a0d2-20260913/frozen/freeze-repair.mjs' --verify
```

`stable-full02-exit.json` is the completed full suite (6203 pass,461 skip,exit0).
`final-types-exit.json`, `final-postgres-exit.json` and
`offline-package-plan.json` retain separate final gates. The PostgreSQL gate
contains real control-store accounting/publication and a separately identified
PostgreSQL business-source/SQLite-control receipt engine check. Four additional
explicit-host-environment recovery UI failures remain failed in
`remaining-postgres-review-env.md`; the passing final gate does not cover them.

Finding9 merged counter and structured/boundary coverage is in
`merged-counters-exit.json` and `merged-combined-exit.json`; final full-suite
coverage follows the final environment-forwarding change. Both help options
are retained in `merge-help-inspection.json`. Finding9's earlier installed
qualification remains implementer-owned and does not transfer to this artifact.

Public known-case entry commands, inputs, consent, exact operator choices and
process exits are retained under the owned root's `runs/<run>/logs` and
`public-invocations.jsonl`. Provider observations are in each run's `meter`.
They contain only consented authoring material; concrete identity files remain
private and are never a model argument. No reviewer should run these saved
projects in place. Use a fresh whole-directory restore with the same logical
project/store mapping and a new task-owned source; the preparation and preflight
helpers document that isolation. Never run a worker against a preserved queue.

The original recovery's checkpoint-prose diagnostic is executable without a
provider or database using the exact command in `checkpoint-prose-exit.json`.
Its exit0 records successful observation of one refusal and one punctuation
control, not a product pass. The installed stopped state is in
`recovery-tournament-original-stopped-review-prose.json`.

The assisted recovery's exact saved selector mismatch is preserved in
`assisted-first-saved-diff.json`, `assisted-recovery-verdict.json` and its stopped
whole-project checkpoint. No activation or source effect was performed there.
The fresh named tournament and software execution/edit checks are complete on
the final tree. See `FINAL-REPORT.md`, `final-scorecard.json`,
`fresh-tournament-summary.json` and `fresh-software-summary.json`. The recovery
failures above remain stopped. Original Stage B remains NOT PASSED.

The actual stable commands were:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm exec vitest run apps/runner/src/structured-counter-review.integration.test.ts apps/runner/src/action-rule-version-review.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
corepack pnpm exec vitest run apps/runner/src/semantic-atomic-postgres.test.ts apps/runner/src/semantic-admission-publication.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

These ran through `run-local.py` with cleared unrelated credentials, private
HOME and writable `/var/tmp`, `NO_COLOR=1`, umask0077, offline Corepack, and an
owned database URL supplied only to the explicit PostgreSQL gate. Use fresh
observation names and a new owned database for any later run; existing names
and containers are preserved. `offline-package-plan.json` retains every exact
packaging command and its separate exit. The full suite has its own result;
targeted passes do not replace it.

The normal installed operator route executed for each case was:

```text
start --from-env DATABASE_URL --schema <original case schema> --cli
  -> consent to original rules and structural metadata
  -> owner-reviewed maintained counters -> exact Read review -> Action review
  -> explicit receipt selection and generated administrator handoff
boundary rescan --from-env DATABASE_URL --project-root . --json
action review --project-root .
  -> Verified Action Boundary -> Review supervised execution
  -> Keep exact receipt selection -> Check configured writer -> explicit Yes
action review --project-root . -> Continue client setup
worker run --supervised --once --yes --config synapsor.actions.runner.json --worker-id semantic_action_worker
start --project-root . --cli
  -> Edit rules with model -> Draft a change -> exact consent
  -> ordinary-language edit -> Not now (disabled save) -> quit
action review --project-root .
  -> activate exact replacement -> separately re-review writer/execution
```

The CLI equivalent receipt preview/save route is documented in merged help:

```bash
writeback setup --config synapsor.actions.runner.json --profile development --outcome release_ops.seal_candidate --receipt-mode source_db --write-url-env WRITER_DATABASE_URL --schema synapsor_receipts --table synapsor_writeback_receipts --json
```

Only after inspecting that preview, the operator adds `--save-selection
--confirm "SAVE RECEIPT SETUP sha256:<exact displayed review>"`. This is a
selection, not administrator application or enabled execution. The fresh
software run used the same selection implementation through the public TUI.
Source provisioning used the exact generated file hashes in the two
`fresh-*-writer-provision.json` records, followed by normal reinspection.

`prepare-known-run.mjs`, `run-public-known.mjs`, `run-known-command.mjs` and
`prepare-known-client.py` preserve the launch/isolation mechanics. They are
not instructions to rerun an existing completed project: prepare a new owned
harness plan/root and whole fixture copy, retain logical project/store
containment, and obtain the existing required reviews normally. Do not rewrite
saved authority bindings to relocate a project or insert approval history.

`known-model-client.mjs` recorded the real persistent Claude sessions;
`known-initial-execution.mjs`, `known-preedit-controls.mjs`,
`software-old-work.mjs`, `software-postedit-check.mjs` and
`tournament-postedit-check.mjs` contain the exact normal MCP/operator schedules
and independent owner-readback assertions. Product checks and worker limits
stay enabled. Provider attempts and failed harness attempts remain counted;
do not reset their saved budgets. Raw logs/state are indexed by path and hash
in `owned-raw-evidence-index.json`; they remain private outside Git.

After closure, `preservation-final.json` reports145,974 unchanged original
entries; `finding9-preservation-final.json` reports126 unchanged evidence files.
`artifact-after-all-public-runs.json` verifies the complete installed tree.
Every `owned-cleanup-*.json` names an exact saved/stopped task container. The
database dumps and quiescent project checkpoints remain available for the
verifier. No saved queue should be executed in place.
