# Recorded gate commands and exits

These are actual executions, not a recipe that silently reruns completed names. `run-local.py` records isolated environment and source before/after; use fresh owned labels for any later authorized run.

## captured-composed-exit

Exit: `1`. Started: `2026-09-14T00:16:36.814045+00:00`. Completed: `2026-09-14T00:16:37.841560+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
node --import tsx docs/qualification-evidence/saved-job-recovery-20260913/captured-composed-repro.mjs
```

## captured-composed02-exit

Exit: `1`. Started: `2026-09-14T00:17:44.571170+00:00`. Completed: `2026-09-14T00:17:45.498578+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
node --import tsx docs/qualification-evidence/saved-job-recovery-20260913/captured-composed-repro.mjs
```

## captured-composed03-exit

Exit: `0`. Started: `2026-09-14T00:18:07.398450+00:00`. Completed: `2026-09-14T00:18:08.309248+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
node --import tsx docs/qualification-evidence/saved-job-recovery-20260913/captured-composed-repro.mjs
```

## combined-focused02-exit

Exit: `1`. Started: `2026-09-14T00:19:29.186943+00:00`. Completed: `2026-09-14T00:20:27.076786+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/action-policy-scope.test.ts apps/runner/src/boundary-authoring-resume.test.ts apps/runner/src/boundary-authoring-resume-concurrency.test.ts apps/runner/src/saved-action-job-review.test.ts apps/runner/src/structured-counter-review.integration.test.ts apps/runner/src/action-read-recovery.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## failed-save-host-after-exit

Exit: `0`. Started: `2026-09-14T00:20:17.016220+00:00`. Completed: `2026-09-14T00:20:34.251008+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/boundary-cli.test.ts --testNamePattern 'resumes disabled Read and saves a semantic clarification without remapping' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## failed-save-host-before-exit

Exit: `1`. Started: `2026-09-14T00:12:37.545446+00:00`. Completed: `2026-09-14T00:12:55.545197+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/boundary-cli.test.ts --testNamePattern 'resumes disabled Read and saves a semantic clarification without remapping' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## final-pg-four-exit

Exit: `0`. Started: `2026-09-14T01:10:57.631949+00:00`. Completed: `2026-09-14T01:11:07.627942+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## final-postgres-exit

Exit: `0`. Started: `2026-09-14T01:09:12.039963+00:00`. Completed: `2026-09-14T01:10:42.656966+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/semantic-atomic-postgres.test.ts apps/runner/src/semantic-admission-publication.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## focused-after01-exit

Exit: `0`. Started: `2026-09-14T00:12:00.563552+00:00`. Completed: `2026-09-14T00:13:00.212723+00:00`. Source unchanged: `False`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/boundary-authoring-resume.test.ts apps/runner/src/saved-action-job-review.test.ts apps/runner/src/structured-counter-review.integration.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## focused-final-exit

Exit: `0`. Started: `2026-09-14T00:21:13.417528+00:00`. Completed: `2026-09-14T00:22:28.943416+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/action-policy-scope.test.ts apps/runner/src/action-rule-draft.test.ts apps/runner/src/boundary-authoring-resume.test.ts apps/runner/src/boundary-authoring-resume-concurrency.test.ts apps/runner/src/saved-action-job-review.test.ts apps/runner/src/structured-counter-review.integration.test.ts apps/runner/src/semantic-receipt-setup.test.ts packages/proposal-store/src/automatic-approval-admission.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## pg-four-after01-exit

Exit: `1`. Started: `2026-09-14T00:14:17.425109+00:00`. Completed: `2026-09-14T00:14:34.227670+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## pg-four-after02-exit

Exit: `1`. Started: `2026-09-14T00:15:41.927681+00:00`. Completed: `2026-09-14T00:15:59.488798+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## pg-four-after03-exit

Exit: `0`. Started: `2026-09-14T00:17:53.778027+00:00`. Completed: `2026-09-14T00:18:11.343001+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## pg-four-before-exit

Exit: `1`. Started: `2026-09-14T00:00:10.280262+00:00`. Completed: `2026-09-14T00:00:26.684984+00:00`. Source unchanged: `True`. PG URL enabled: `True`.

```bash
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## quoted-identity-after-exit

Exit: `0`. Started: `2026-09-14T00:33:43.702690+00:00`. Completed: `2026-09-14T00:33:48.302819+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/boundary-authoring-resume.test.ts apps/runner/src/boundary-authoring-resume-concurrency.test.ts --maxWorkers=1 --minWorkers=1
```

## quoted-identity-before-exit

Exit: `1`. Started: `2026-09-14T00:32:47.958905+00:00`. Completed: `2026-09-14T00:32:50.904970+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/boundary-authoring-resume.test.ts --testNamePattern 'saves complete quota-description' --maxWorkers=1 --minWorkers=1
```

## removal-normalized-exit

Exit: `0`. Started: `2026-09-14T00:23:48.656034+00:00`. Completed: `2026-09-14T00:23:55.971328+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts --testNamePattern 'corrects an unaccepted extra quota' --maxWorkers=1 --minWorkers=1
```

## selector-checkpoint-before-exit

Exit: `1`. Started: `2026-09-14T00:09:50.888855+00:00`. Completed: `2026-09-14T00:09:58.719581+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/boundary-authoring-resume.test.ts --maxWorkers=1 --minWorkers=1 --testNamePattern 'refuses model-added history filters|saves complete quota-description'
```

## small-before-exit

Exit: `1`. Started: `2026-09-14T00:07:07.034770+00:00`. Completed: `2026-09-14T00:07:59.984102+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run apps/runner/src/saved-action-job-review.test.ts apps/runner/src/structured-counter-review.integration.test.ts --maxWorkers=1 --minWorkers=1
```

## stable-full-exit

Exit: `-2`. Started: `2026-09-14T00:24:49.174671+00:00`. Completed: `2026-09-14T00:32:18.049252+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## stable-full02-exit

Exit: `0`. Started: `2026-09-14T00:34:48.475421+00:00`. Completed: `2026-09-14T01:02:09.997187+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

## types-before-freeze-exit

Exit: `0`. Started: `2026-09-14T00:22:52.247594+00:00`. Completed: `2026-09-14T00:23:14.712898+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm typecheck
```

## types-final-exit

Exit: `0`. Started: `2026-09-14T00:51:26.513576+00:00`. Completed: `2026-09-14T00:51:32.236327+00:00`. Source unchanged: `True`. PG URL enabled: `False`.

```bash
corepack pnpm typecheck
```

## Offline trusted-core

Exit: `0`.

```bash
node scripts/check-trusted-core-dependencies.mjs
```

## Offline licenses

Exit: `0`.

```bash
node scripts/check-license-content.mjs
```

## Offline human-commands

Exit: `0`.

```bash
node scripts/verify-human-command-surface.mjs
```

## Offline dsl-sources

Exit: `0`.

```bash
bash scripts/verify-dsl-source-paths.sh
```

## Offline cursor-plugin

Exit: `0`.

```bash
node scripts/verify-cursor-plugin.mjs
```

## Offline mcp-client-configs

Exit: `0`.

```bash
node scripts/verify-mcp-client-configs.mjs
```

## Offline local-package

Exit: `0`.

```bash
bash scripts/verify-local-runner.sh
```

## Offline bundle-freshness

Exit: `0`.

```bash
node scripts/verify-local-runner-bundle-freshness.mjs
```

## Offline public-commands

Exit: `0`.

```bash
bash scripts/verify-public-commands.sh
```

## Offline packed-offline

Exit: `0`.

```bash
bash scripts/verify-packed-runner.sh
```
