# Reproduction and verification commands

Source product/test revision: `23e51b1e17c5ec22492518be6d3f6bb0d752bfe7`. The final artifact identity and report revision are recorded separately. Raw identity-bearing records stay in the owned task directory; see `assignment-plan.json` and result indexes.

Existing names identify preserved attempts. Independent repetition requires a fresh owned root/name and its own declared budget; these launchers refuse existing attempt directories. Never execute saved incorrectly approved queues.

refusal-before: actual exit 1.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py refusal-before node node_modules/vitest/vitest.mjs run apps/runner/src/semantic-admission-publication.test.ts -t replacement_first --maxWorkers=1 --reporter=verbose
```

identity-focus03: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py identity-focus03 node node_modules/vitest/vitest.mjs run apps/runner/src/local-test-runtime-identity.test.ts apps/runner/src/managed-mcp-project.test.ts apps/runner/src/post-activation-ask.test.ts apps/runner/src/mcp-runtime-execution-config.test.ts packages/mcp-server/src/semantic-actions.test.ts --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000 --reporter=default
```

combined01: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py combined01 node node_modules/vitest/vitest.mjs run apps/runner/src/local-test-runtime-identity.test.ts apps/runner/src/managed-mcp-project.test.ts apps/runner/src/post-activation-ask.test.ts apps/runner/src/mcp-runtime-execution-config.test.ts apps/runner/src/control-policy-store.test.ts apps/runner/src/project-runtime-admission.test.ts apps/runner/src/project-authority-mutation.test.ts apps/runner/src/semantic-admission-publication.test.ts apps/runner/src/action-revision-impact.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts packages/proposal-store/src/worker-cancellation-role.test.ts --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default
```

identity-final02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py identity-final02 node node_modules/vitest/vitest.mjs run apps/runner/src/local-test-runtime-identity.test.ts apps/runner/src/post-activation-ask.test.ts --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default
```

handoff-followup02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py handoff-followup02 node node_modules/vitest/vitest.mjs run apps/runner/src/post-activation-ask.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default
```

stable-full: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py stable-full node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default --reporter=json --outputFile.json=docs/qualification-evidence/reviewed-local-clients-20260913/stable-full.json
```

stable-full02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py stable-full02 node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default --reporter=json --outputFile.json=docs/qualification-evidence/reviewed-local-clients-20260913/stable-full02.json
```

final-types: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py final-types node node_modules/typescript/bin/tsc -b
```

postgres-gate02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-local.py postgres-gate02 --pg bash scripts/verify-publication-accounting-postgres.sh
```

Offline: `python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-offline-checks.py` (all ten commands in offline-package-plan.json).
Freeze: `python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-freeze.py`. It requires the committed coherent source and the already prepared offline cache; it creates a new complete installation instead of patching an old package.

Installed prerequisites: prepare-runtime.mjs creates a whole owned project/source restore; drive-client-setup.py invokes the actual public Action review → Continue client setup route with hidden fixture inputs and explicit confirmations. check-reviewed-contexts.mjs uses generated exact launcher entries for diagnostic, own rows and restart. No fixture setter substitutes for that operator path.

Installed schedules: a1-identical.mjs; shared-accounting-contexts.mjs (A2/A4); same-principal-control.mjs; a3-collections.mjs (both source cases); installed-edit-check.mjs with drive-publication.py (edit/admission-first/replacement-first); installed-identity-lifecycle.mjs with drive-retirement.py. Exact executed commands, exits, controller hashes and saved harness byte snapshots will accompany each result.

The reused effective-store preflight is hash-linked in reused-harness-provenance.json; its full existing source and owned copy are preserved. The observer reads the unmodified installed bundle, pauses at real writer boundaries and proves a real SQLite wait. It is labeled instrumentation, not a new product path.

## Executed final installed matrix

These are recorded executions, not commands to repeat in the preserved stores. All final calls use the complete tree in final-artifact.json. Source/fixtures are stopped and saved. A future verifier must use a new whole owned restore and an explicit budget; never run saved incorrect queues.

installed-identity-lifecycle02-lifecycle: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-identity-lifecycle02-lifecycle --case identity_lifecycle_02 node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/installed-identity-lifecycle.mjs'
```

installed-a1: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-a1 --case shared node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/a1-identical.mjs'
```

installed-a1-02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-a1-02 --case shared_02 node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/a1-identical.mjs'
```

installed-shared-matrix: actual exit 1.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-shared-matrix --case shared node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/shared-accounting-contexts.mjs'
```

installed-shared-matrix02: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-shared-matrix02 --case shared_02 node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/shared-accounting-contexts.mjs'
```

installed-same-principal: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-same-principal --case same_principal node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/same-principal-control.mjs'
```

installed-a3: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-a3 --case collection node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/a3-collections.mjs'
```

installed-edit-edit: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-edit-edit --case edit node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/installed-edit-check.mjs'
```

installed-edit-admission_first: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-edit-admission_first --case admission_first node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/installed-edit-check.mjs'
```

installed-edit-replacement_first: actual exit 0.

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/run-owned.py installed-edit-replacement_first --case replacement_first node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/runtime/installed-edit-check.mjs'
```

Each edit runtime was paired with the existing public operator controller, before waiting for both exits:

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-publication.py edit
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-publication.py admission_first
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-publication.py replacement_first
```

Operator setup exact final shared fixture commands (all exit0):

```bash
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-client-setup.py shared_02 client-one primary
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-client-setup.py shared_02 client-two colleague
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-client-setup.py shared_02 client-three second-insurer
python3 docs/qualification-evidence/reviewed-local-clients-20260913/drive-client-setup.py shared_02 client-four third-insurer
```

Before scheduling, check-installed-context.mjs and check-reviewed-contexts.mjs ran through run-owned.py for the owned fixture, with exact per-client generated launcher selection, normal own reads and restarts. installed-shared02-exits.json records these commands and actual exits. Lifecycle uses the fresh identity_lifecycle_02 fixture; its own operator retirement transcript and public future-launch refusal are retained.

Recovery executed the existing public `proposals reject <exact ID> --yes --reason <reviewed reason> --config synapsor.actions.runner.json --json` against the stranded unapproved record; the private result records its exact ID and command. No new recovery mechanism was implemented.

Final artifact verification, preservation and save/stop commands:

```bash
node '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/reviewed-local-clients-8d64270-20260913/frozen/freeze-repair.mjs' --verify
python3 docs/qualification-evidence/reviewed-local-clients-20260913/verify-preserved.py preservation-final
python3 docs/qualification-evidence/reviewed-local-clients-20260913/save-and-stop-owned.py
python3 docs/qualification-evidence/reviewed-local-clients-20260913/verify-preserved.py preservation-after-cleanup
```

Logs and owned database state were saved before stop. Cleanup verifies exact container ID, ownership label, network-none and recorded processes; it stops only that owned resource. Full/private manifests and failed attempt stores remain under the owned root.
