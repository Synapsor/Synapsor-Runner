# Separate repair decision: saved-job review loses explicit control-store environment

The merged live test run exited1:11 passed,5 failed,404 excluded. Four failures are the pre-existing Action recovery UI path under disabled/revoked/revoked_execution/revoked_unconfirmed Read states. The fifth is in the new receipt lookup and is repaired separately.

Exact evidence: postgres-explicit-env-finding.json, merged-postgres-execution-review02.log and its exit/source manifests. The normal tests in apps/runner/src/control-policy-authority-codec.test.ts retain all assertions. Supply a task-owned SYNAPSOR_TEST_POSTGRES_URL and select `postgres validated operator policy transactions.*keeps Action recovery review available`. Do not count the first all-skipped selector attempt as a pass.

Ordering: fixture prepares current reviewed authority, captures its explicit environment, removes TEST_POLICY_URL from the ambient process, recovers Action state with the supplied env, then opens review with that same env. Expected: inspectable recovery review with no authority mutation. Actual: missing TEST_POLICY_URL from the saved-job read lookup. readSavedActionJobReview and its caller already omitted env at454a0d2; source snapshots below retain that trace. No failure of accounting or publication ordering was observed in the separate42-pass gate.

No repair of this older caller is attempted in the quota/receipt assignment. The passing integration subset cannot overwrite these failures. Installed known-case checks use their explicitly configured process environment and are independent of this host-only environment forwarding schedule.
