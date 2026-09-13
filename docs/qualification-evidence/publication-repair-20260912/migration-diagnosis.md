# Concurrent migration: fixture timing correction

The unchanged named test again failed in combined-01 with POLICY_RUNTIME_BUSY
before convergence assertions. This reproduces the earlier full-suite failure;
the full commands, exit1 and original assertions remain preserved. Both isolated
runs, both standalone load runs and combined-02 completed the unchanged test.
The extra combined pass is not relabeled as a fix of the earlier failed run.

Combined-02 adds test-name labels to actual native gate/SQLite-DDL/fsync traces.
The winning migration held the exclusive runtime gate4813.427ms while initializing
an empty application ledger; one schema exec took2305.988ms and an index-creation
exec1620.726ms. The second caller acquired after release for6.753ms. There was no
active reader, nested exclusive acquisition or leaked lock in this completing
trace. This confirms the fixture puts expensive one-time application-schema work
inside a schedule that requires a competing migration to wait no more than5s.
The exact physical-I/O breakdown of the failed combined-01 remains unobserved;
we do not retroactively claim that it had this same duration or a traced gate leak.

The narrow test correction initializes the existing application ledger through
ProposalStore before either concurrent policy migration starts. It initializes
no policy binding, manifest, imported revision, approval or active pointer. Both
migrations still concurrently compete for one complete governed binding and the
same frozen snapshot. All one-deployment/one-repository/imported-already_imported/
epoch1/single-snapshot assertions remain unchanged. This tests the intended
completing migration schedule without treating slow schema creation as a gate bug.
No migration product code, timeout, identity check or concurrency was changed.

A separate test intentionally holds the first migration inside its snapshot
callback, checks the second returns POLICY_RUNTIME_BUSY within the unchanged
five-second bound without reading its snapshot, then releases and awaits the
first complete import. Busy is not counted as convergence; there is no retry.
First corrected focused run passed both tests, exit0. The final combined and
stable outcomes will be recorded separately. Original full-suite/combined
failures are retained, not converted into passes.

Two standalone isolated and two standalone load budgets are consumed; one of two
corrected focused slots used. combined-02 used a declared combined slot, not a
reset standalone diagnosis budget. Evidence details and earlier uncertainty are
preserved in migration-diagnosis-interim.md, migration-trace-summary.json,
combined-02/named-migration-trace.json, migration-fixture-correction.md and the
verbatim concurrent-migration-original.test.txt. Existing gate tests additionally
cover nested readers, cancellation, legitimate busy and cleanup after death.
