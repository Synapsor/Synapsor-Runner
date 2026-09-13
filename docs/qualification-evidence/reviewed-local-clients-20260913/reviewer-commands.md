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
