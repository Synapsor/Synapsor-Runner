# Concurrent migration: bounded diagnosis, original cause unresolved

The unchanged test is `apps/runner/src/control-policy-store.test.ts`,
`governed policy-store binding and recovery > chooses one complete binding during concurrent migration`.
The preserved earlier full suite exited1 when its second caller returned
POLICY_RUNTIME_BUSY at the five-second exclusive cutover gate. This assignment
has not reproduced that failure and makes no migration product/test correction.

Both isolated attempts passed (the first observer did not load in Vitest's worker;
that measurement error is preserved separately). The corrected isolated trace
shows exclusive ownership for2484.672ms, rollback/release, then the second caller
for7.244ms. Both callers return one complete binding, imported/already_imported,
and only one legacy snapshot read, as required by the unchanged assertions.

Representative load01 exited0:362 passed/175 prerequisite skips in six files.
The named concurrent migration's owner held the gate4690.453ms, then the second
caller held it9.984ms (trace project `synapsor-policy-migration-ct2yRe`). Load02
exited0:119 passed/one prerequisite skip in four files. Its corresponding holds
were4889.945ms and3.928ms (`synapsor-policy-migration-CuIyVI`). These are the final
same-project paired acquisitions before the separate canonical-path test, in
unchanged file/test order. Exact command/exit, complete logs, native exec/read/error/
close observations, per-process handle ownership and fsync traces are retained.

Observed coordination: exclusive runtime gate precedes the authority writer
mutex; migration initializes the runtime store and policy repository, validates
and saves the exact snapshot/manifest, imports, then releases both locks. No
active reader, nested exclusive acquisition or leaked handle explains the two
successful named schedules. Native schema initialization performs synchronous
SQLite DDL while the exclusive gate is held; load02 measured individual initial
schema execs above2.4seconds. Async filesystem work creates opportunities for a
waiting caller to observe its deadline. The normal completing schedule is close
to the existing5second wait bound under this machine's I/O load.

This supports timing sensitivity as a plausible explanation, not a proven cause
of the earlier failing run: that run lacks comparable owner/reader traces. An
isolated pass or a load pass is not a fix. No timeout was raised, concurrency
removed, bounded-busy result accepted as convergence, or retry-until-green loop
used. The two isolated and two representative-load budgets are consumed.
Existing runtime-admission tests separately exercise nested readers during
cutover, cancellation, bounded busy and release after process death; their pass
is not a retrospective trace of the old failure. Keep the original failure open
for a separate decision unless the later stable suite supplies new evidence.
