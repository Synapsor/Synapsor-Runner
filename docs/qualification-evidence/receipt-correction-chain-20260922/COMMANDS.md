# Exact commands and gate evidence

Run from /home/sandesh-tiwari/Desktop/C++/synapsor-runner. Each gate was wrapped by run-gate.py with isolated HOME, private writable /tmp and /var/tmp, umask0077, NO_COLOR1; provider/unrelated credentials absent. Only --pg receives the owned preflighted database URL. See GATES.json for exact source revisions/digests and settings. The commands below are shell-quoted reproductions of actual child argv. Use new exclusive output names when reproducing; do not repeat or overwrite original attempts.

## backend-01

```bash
corepack pnpm exec vitest run apps/runner/src/authoring-review-subject.test.ts apps/runner/src/authoring-counting-domain.test.ts apps/runner/src/authoring-counting-freshness.test.ts apps/runner/src/semantic-receipt-setup.test.ts apps/runner/src/control-policy-authority-codec.test.ts packages/proposal-store/src/control-policy-reviews.test.ts -t 'postgres|exact policy review|published authoring review|saves source-required pending meaning|saves and reloads receipt readiness' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/backend-01.log

## backend-02

```bash
corepack pnpm exec vitest run apps/runner/src/authoring-review-subject.test.ts apps/runner/src/authoring-counting-domain.test.ts apps/runner/src/authoring-counting-freshness.test.ts apps/runner/src/semantic-receipt-setup.test.ts apps/runner/src/control-policy-authority-codec.test.ts packages/proposal-store/src/control-policy-reviews.test.ts -t 'postgres|exact policy review|published authoring review|saves source-required pending meaning|saves and reloads receipt readiness' --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/backend-02.log

## baseline-replay-01

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/replay-before.mts
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/baseline-replay-01.log

## focused-01

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/receipt-review-association.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 1; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-01.log

## focused-02

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-02.log

## focused-03

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/action-rule-source-evidence.test.ts apps/runner/src/authoring-policy-coverage.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-03.log

## focused-04

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts apps/runner/src/action-rule-source-evidence.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-04.log

## focused-05

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts apps/runner/src/action-rule-source-evidence.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-05.log

## focused-06

```bash
corepack pnpm exec vitest run apps/runner/src/receipt-correction-chain.test.ts apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts apps/runner/src/action-rule-source-evidence.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/focused-06.log

## root-probe-after-01

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/probe-configuration-roots.mts '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/ROOT-ROUTING-AFTER-001.json'
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/root-probe-after-01.log

## root-probe-before-01

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/probe-configuration-roots.mts '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/ROOT-ROUTING-BEFORE-001.json'
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/root-probe-before-01.log

## stable-full-001

```bash
corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/stable-full-001.log

## types-01

```bash
corepack pnpm typecheck
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/types-01.log

## types-02

```bash
corepack pnpm typecheck
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/types-02.log

## types-03

```bash
corepack pnpm typecheck
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/types-03.log

## wire-export-01

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/record-local-wire.mts
```

Exit: 1; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/wire-export-01.log

## wire-export-02

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/record-local-wire.mts --final
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/wire-export-02.log

## wire-export-03

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/record-local-wire.mts binding-fixed
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/wire-export-03.log

## wire-export-04

```bash
corepack pnpm exec tsx docs/qualification-evidence/receipt-correction-chain-20260922/record-local-wire.mts final-source
```

Exit: 0; source unchanged: True. Full log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/gates/wire-export-04.log

## Offline packaging and freeze

```bash
python3 docs/qualification-evidence/receipt-correction-chain-20260922/run-offline-checks.py source attempt1
python3 docs/qualification-evidence/receipt-correction-chain-20260922/run-offline-checks.py package attempt1
python3 docs/qualification-evidence/receipt-correction-chain-20260922/run-freeze.py
```

The four package checks began only after stable-full-001 exited0. Exact offline child commands/exits/source invariance are retained in offline-package-plan-attempt1.json. Freeze requires a clean committed checkout. These commands are historical reproduction instructions, not permission to overwrite their exclusive evidence outputs.

Freeze completed exit0 at2026-09-22T06:49:39.840Z on clean sourcef14ce84eaec053c8df8822e224c11fffac150a50. See ARTIFACT.json and raw/frozen/freeze-command.log for exact inventory, archive and installation.
