# Commands and evidence for independent review

Run from the checked-out repository. Wrappers use owned isolated HOME, /tmp and writable /var/tmp, NO_COLOR=1 and umask0077, without provider/unrelated credentials. Only --pg supplies the owned local PostgreSQL CONTROL URL. Each *-exit.json records the actual command, source identity, PID and child exit. Complete logs are adjacent. The original wrapper printed child exit1 but itself returned0; the child verdict is authoritative and the wrapper was corrected afterward.

- execution-before02: actual child exit 1

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py execution-before02 node node_modules/vitest/vitest.mjs run apps/runner/src/boundary-structured-execution.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- execution-after03: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py execution-after03 node node_modules/vitest/vitest.mjs run apps/runner/src/boundary-structured-execution.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- types02: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py types02 node node_modules/typescript/bin/tsc -b --pretty false
```

- postgres-gate01: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py postgres-gate01 --pg bash scripts/verify-publication-accounting-postgres.sh
```

- combined01: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py combined01 node node_modules/vitest/vitest.mjs run apps/runner/src/boundary-structured-authoring.test.ts apps/runner/src/boundary-structured-authoring.integration.test.ts apps/runner/src/boundary-structured-execution.test.ts apps/runner/src/control-policy-fresh-authoring.test.ts apps/runner/src/control-policy-authoring-storage.integration.test.ts apps/runner/src/control-policy-authority-codec.test.ts apps/runner/src/owner-policy-connection.test.ts apps/runner/src/control-policy-config-publication.test.ts apps/runner/src/control-policy-store.test.ts apps/runner/src/semantic-admission-publication.test.ts apps/runner/src/semantic-action-runtime.test.ts apps/runner/src/semantic-action-delegation.test.ts apps/runner/src/mcp-runtime-execution-config.test.ts apps/runner/src/model-output-config.test.ts apps/runner/src/semantic-writeback-authority.test.ts apps/runner/src/action-review-governed.test.ts apps/runner/src/project-runtime-admission.test.ts apps/runner/src/project-authority-mutation.test.ts apps/runner/src/ledger-lifecycle.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- lifecycle01: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py lifecycle01 node node_modules/vitest/vitest.mjs run apps/runner/src/lifecycle-cli.test.ts apps/runner/src/lifecycle-view.test.ts apps/runner/src/resource-lifecycle.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- publication-recovery01: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py publication-recovery01 node node_modules/vitest/vitest.mjs run apps/runner/src/control-policy-publication-recovery.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- stable-full: actual child exit 1

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py stable-full node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default --reporter=json --outputFile.json=/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/structured-save-repair-20260913/stable-full.json
```

- cli-invalid-after: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py cli-invalid-after node node_modules/vitest/vitest.mjs run apps/runner/src/cli.test.ts -t 'returns one JSON failure for invalid' --maxWorkers=1 --minWorkers=1 --testTimeout=20000
```

- execution-after04: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py execution-after04 node node_modules/vitest/vitest.mjs run apps/runner/src/boundary-structured-execution.test.ts apps/runner/src/boundary-structured-authoring.test.ts apps/runner/src/boundary-structured-authoring.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

- types04: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py types04 node node_modules/typescript/bin/tsc -b --pretty false
```

- stable-full02: actual child exit 0

```bash
python3 docs/qualification-evidence/structured-save-repair-20260913/run-local.py stable-full02 node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000 --reporter=default --reporter=json --outputFile.json=/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/structured-save-repair-20260913/stable-full02.json
```

Existing run names and directories identify immutable attempts. Use a new owned root/name for independent reproduction. Never execute historical incorrectly approved queues. The standard discovery includes boundary-structured-execution.test.ts and semantic-admission-publication.test.ts; opt-in PostgreSQL uses scripts/verify-publication-accounting-postgres.sh. Archived before-source files end in .txt and are not discovered as tests.

Offline gate: `python3 docs/qualification-evidence/structured-save-repair-20260913/run-offline-checks.py`. New freeze: `python3 docs/qualification-evidence/structured-save-repair-20260913/run-freeze.py`. The offline installed structured gate is `node scripts/verify-packed-structured-save.mjs --fixture-module <owned runtime/runtime-driver.mjs> --spelling onboard` (and start). The prepared installed-edit-check.mjs imports this gate inside the persistent-client schedule. Exact interactive operator invocations and confirmations are captured separately; never replace them with internal activation helpers.
