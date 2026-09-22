# Exact commands and evidence
All commands run from /home/sandesh-tiwari/Desktop/C++/synapsor-runner. run-gate.py creates an isolated HOME, private writable /tmp and /var/tmp, umask0077, NO_COLOR=1, offline dependencies and no inherited provider credentials. Only --pg receives the verified owned local control database URL.

backend-01:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py backend-01 --pg corepack pnpm exec vitest run apps/runner/src/authoring-review-subject.test.ts apps/runner/src/authoring-counting-domain.test.ts apps/runner/src/authoring-counting-freshness.test.ts apps/runner/src/semantic-receipt-setup.test.ts apps/runner/src/control-policy-authority-codec.test.ts packages/proposal-store/src/control-policy-reviews.test.ts -t "postgres|exact policy review|published authoring review|saves source-required pending meaning|saves and reloads receipt readiness" --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/backend-01.log

exact-replay-02:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py exact-replay-02 corepack pnpm exec tsx docs/qualification-evidence/evidence-correction-20260922/replay-baseline.mts --after
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/exact-replay-02.log

focused-01:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py focused-01 corepack pnpm exec vitest run apps/runner/src/evidence-aware-correction.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 1; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/focused-01.log

focused-02:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py focused-02 corepack pnpm exec vitest run apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/authoring-coverage-correction.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 1; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/focused-02.log

focused-03:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py focused-03 corepack pnpm exec vitest run apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/focused-03.log

focused-04:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py focused-04 corepack pnpm exec vitest run apps/runner/src/evidence-aware-correction.test.ts apps/runner/src/source-phase-review.test.ts apps/runner/src/receipt-review-association.test.ts apps/runner/src/authoring-coverage-correction.test.ts apps/runner/src/obligation-readiness.test.ts apps/runner/src/authoring-policy-coverage.test.ts apps/runner/src/authoring-scoped-disclosure.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/focused-04.log

stable-full-001:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py stable-full-001 corepack pnpm exec vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/stable-full-001.log

types-01:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py types-01 corepack pnpm typecheck
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/types-01.log

types-02:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py types-02 corepack pnpm typecheck
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/types-02.log

wire-export-01:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py wire-export-01 corepack pnpm exec tsx docs/qualification-evidence/evidence-correction-20260922/record-local-wire.mts
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/wire-export-01.log

wire-export-02:
```
python3 docs/qualification-evidence/evidence-correction-20260922/run-gate.py wire-export-02 corepack pnpm exec tsx docs/qualification-evidence/evidence-correction-20260922/record-local-wire.mts --final
```
Actual exit: 0; source invariant: True. Log: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/gates/wire-export-02.log

Ten offline checks: `python3 docs/qualification-evidence/evidence-correction-20260922/run-offline-checks.py source attempt1`, then `package attempt1` after the full suite. Exact child args/exits are in offline-package-plan-attempt1.json. Freeze: `python3 docs/qualification-evidence/evidence-correction-20260922/run-freeze.py`; verify raw frozen/freeze-repair.mjs with `node ... --verify`.

Old failures retained: focused01 mixed-counter test hit an earlier pointer error; focused02 simulated decision drift only in memory while episode CAS reloaded saved state. Both are test setup mistakes, corrected without changing product acceptance. Independent duplicate-root finding001 is a real pre-freeze eligibility/diagnostic discrepancy; fixed by unique roots plus a genuine companion and re-probed in002.
