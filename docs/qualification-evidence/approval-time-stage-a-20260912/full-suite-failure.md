# Completed full-suite failure

The same run started at2026-09-12T22:18:37.500629Z and exited1 at22:37:47.535927Z.
Vitest:6101passed,1failed,450skipped;315files. It was finished when the continuation
inspected it at22:45UTC; no descendant processes remained. No duplicate run launched.

Exact test: apps/runner/src/control-policy-store.test.ts, governed policy-store
binding and recovery > chooses one complete binding during concurrent migration.
It expects both concurrent migration operations to resolve to one repository and
deployment, statuses imported/already_imported and one snapshot read. Actual:
Promise.all index1 rejected with RuntimeAdmissionError/POLICY_RUNTIME_BUSY at the
runtime-admission five-second exclusive gate. The message reports no cutover by
that refused attempt. The test did not reach its convergence assertions.

This is a failed standard-suite assertion caused by a runtime busy timeout, not
a completed pass, nor a demonstrated authorization bypass. The underlying timing
cause is unconfirmed; the log alone does not establish an environment-only fault.
No source change, increased timeout, narrowed assertion or retry was performed.
The existing test and full log/JSON report are preserved for a separate decision.

Private writable /var/tmp and NO_COLOR=1 were used throughout. The earlier
6096/5/449 run and104-test targeted rerun remain distinct historical evidence.
