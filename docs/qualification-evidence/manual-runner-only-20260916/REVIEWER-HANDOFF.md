# Manual RUNNER ONLY handoff

Read FINAL-REPORT.md, IMPLEMENTATION-NOTE.md and PROTECTED-READ-ASSESSMENT.md. The prior frozen authoring artifact is unchanged and is not this patch. No provider/database setup is needed. Existing installed dependencies suffice.

Run from the repository, with a unique run name (the harness refuses overwriting earlier evidence):

```sh
python3 docs/qualification-evidence/manual-runner-only-20260916/verify.py reviewer-manual corepack pnpm exec vitest run apps/runner/src/boundary-cli.test.ts -t 'manual RUNNER ONLY|saves an enum review with pending column edits|restricts manual analysis|reports deterministic outcomes when focused access widens' --maxWorkers=1 --minWorkers=1 --testTimeout=20000
python3 docs/qualification-evidence/manual-runner-only-20260916/verify.py reviewer-private corepack pnpm exec vitest run apps/runner/src/scoped-explore.test.ts -t 'distinguishes raw withholding from private analysis' --maxWorkers=1 --minWorkers=1 --testTimeout=20000
python3 docs/qualification-evidence/manual-runner-only-20260916/verify.py reviewer-named corepack pnpm exec tsx docs/qualification-evidence/manual-runner-only-20260916/protected-token-probe.mts
```

The normal regression exercises both manual persistence routes, explicit activation, filter validation and final model projection, with private synthetic metadata and values. It checks active bytes before activation, a pre-existing raw-withheld field, and explicit preserve_reviewed preparation. Other existing tests retain generated/model privacy and composite relationship coverage. The named-read probe characterizes a remaining compatibility limitation; its exit0 is not a no-equality privacy pass.

Original before/after logs, command exits and per-run source patches are indexed by *-result.json in this directory. Full logs/state are under the task-owned root in PLAN.json; failed attempts were not overwritten. The initial combined run used the default5-second outer timeout and failed one unrelated slow identity fixture; its complete isolated13-case recheck retained5seconds. Final whole affected-file verification uses the already established20-second outer test profile. No product timing was altered.
