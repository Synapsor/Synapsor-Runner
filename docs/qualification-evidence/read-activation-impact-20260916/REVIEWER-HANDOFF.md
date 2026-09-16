# Read activation impact: verifier entry points

Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`.
Owned logs/source snapshots: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/read-activation-impact-5a5ec37-20260916`.

`PLAN.json` declares baseline and finite budgets. `source-files.json` binds the changed implementation/test files; `final-source/` in the owned root preserves their complete bytes (including newly added files). `stable-source/` and the earlier source manifest retain the version before the test-only TypeScript binding correction. Every `*-result.json` records its exact command, environment, actual exit and full log. These are local implementer tests, not an independently accepted or newly frozen qualification artifact.

Primary regression:

```sh
corepack pnpm exec vitest run apps/runner/src/boundary-cli.test.ts \
  -t 'warns before an unrelated Read edit' \
  --maxWorkers=1 --minWorkers=1 --testTimeout=20000
```

It creates an owned Read boundary, activates two supervised Action outcomes, changes only an unused field label, and exercises direct activation, cancellation, manual/conversation confirmation, signed headless activation, and the Workbench HTTP preview/activation route. It checks exact outcomes, unchanged Action records, unchanged canonical exported review bundle, and `SEMANTIC_ACTION_UNAVAILABLE` after activation without reading source facts. No external business database or authoring provider is required.

`boundary-workbench.test.ts` executes the rendered browser preview handler against controlled DOM/transport callbacks; it asserts warning-before-activation and decline behavior. `read-activation-impact.test.ts` covers sanitized failed assessments and absent authority. The complete affected suite also retains normal Action authority, Workbench and Quick Start regressions.

Baseline reproduction: `before-warning-result.json` runs the corrected fixture with the original `5a5ec37` boundary-command implementation mounted read-only. Both activation/decline cases fail because the confirmation omits outcome names. Earlier setup/assertion mistakes are retained and distinguished in FINAL-REPORT.md; they are not additional product findings.

For isolated reproduction use `verify.py <new-unique-label> <command...>` from this evidence directory. It clears credentials, disables network, assigns private HOME/tmp/var-tmp, uses NO_COLOR and umask0077, and retains logs. Existing labels are never overwritten. Do not run a preserved test project or frozen installation in place.

The preview is display-only and can become stale under concurrent changes. Inspect the implementation diff: the dependency comparison, Read/Action digests, activation decision envelope and execution bindings must remain unchanged. No activation, Action recheck or writer review is performed by the warning helper.
