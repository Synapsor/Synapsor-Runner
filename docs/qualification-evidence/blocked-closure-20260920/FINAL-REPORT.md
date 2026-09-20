# Terminal blocked-work closure — verification in progress

This is a bounded known-fixture maintenance result. Original Stage B remains ATTEMPTED / NOT PASSED. Independent acceptance of this candidate is pending.

Product/tests: ae96fb0b2556cb2b9465adfc796fee76389f2eb9, following 4bff1ba831904f94b1b36f9f9f735aa9616b61d7. Baseline: 4b22b460d80eaa246ad4fd0928dc541a49833c81. All ten offline checks passed on the final source (attempt3); exact exits and commands are in offline-package-plan-attempt3.json. Frozen source checkpoint: 5b39c6d6e83bb33d0777390379e20b0f5ea3f4b4. Installed tree: fb6d6d923eb842b5bd2f17decb4b625a4b682b483d3a47aa510f96f8af6710a5 (7,569 entries); full manifest/archive identities are in ARTIFACT.json. Final operational results remain pending.

The implementation contract and legacy migration limits are in IMPLEMENTATION-NOTE.md. Historical W2 is ineligible: its records do not establish acknowledged source rollback. The new event is future-only. No saved historical queue was executed.

## Current evidence distinction

- Completed full suite attempt2: exit 1, 6,650 passed / 1 failed / 476 skipped. The obsolete status expectation was subsequently corrected; this failed whole-run result remains historical.
- Full suite attempt3: completed exit 0, 6,653 passed / 476 skipped (321 passed files, 21 skipped). Four workers and 20s outer test/hook limits; source digest 40b2373d47f37dbdd403ff1c4a0b5e3930e5aadb102ec1c69dca279d17a0831c identical before/after. Duration 1,298.57 seconds. Final types exit 0.
- Final explicit PostgreSQL gate: 48 passed, exit 0 (source producer, native control lifecycle/accounting/cancellation, actual bridge coordination). Additional SQLite contention gate: 1 passed, exit 0; three real connections waited approximately 5,009–5,010 ms and refused under the held writer lock, then one closure event survived two closures and a startup claim. Earlier focused gates remain separately recorded.
- Four public from-empty model-free setup journeys completed on the frozen candidate. All original504 rows match by PK/value; separately activated Read/Action/execution, reviewed signed operator and local client, generated narrow writer grants, passed rolled-back receipt probes, own permitted Read and worker check. Four untouched starts were sealed before requests; manifest479a3117daf3fe0e64cc6a6b436babc7a51f14c68265842f2988a2c0da7e7744. Full428-entry bidirectional verification passed. Independent restoration validation and installed R0/R1/R2 schedules remain pending.
- Runner provider calls: zero.

## Operational and review limits

Closure is administrative resolution, not retry, compensation or approval. The failed proposal/receipt, original approval, one completed attempt and allowance consumption remain. The existing discarded worker state prevents dispatch; one attributable event records closure. Fresh requests already work for failed work under normal current authority; closure does not add a duplicate bypass.

Only one-attempt semantic v5 PostgreSQL source_db/precreated stale refusals with the new producer proof, exact qualified ordinary receipt namespace, source contradiction check and verified operator roles qualify. Legacy/multi-attempt/uncertain/applied/in-progress/delegated/unsupported cases remain inspection/reconciliation work. Worker upgrades affect future evidence only. Existing clock assumptions, process coordination and source receipt semantics are retained; no multi-host or universal exactly-once claim.

Prior M6 and O2/P1 independent acceptances remain artifact-specific. Prior W1/W2 were inspected, not independently executed. M4 E2/E3 remain separate. The new tester lane has fresh-effect authorization but has not executed this candidate yet.
