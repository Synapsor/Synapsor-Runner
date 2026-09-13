# Full-suite composed-runtime fixture finding (run still active)

Seventeen tests in semantic-action-runtime.test.ts failed at automatic admission.
All use heldExecutionFixture. It mocks createActiveActionRuleAuthorityLoader to
return authorityFixture, but migrates only a null Read selection and an execution
policy into the governed store. There is no durable current Action revision, and
the mocked load has no policy_revision. The new definitive admission guard rejects
that missing governed authority instead of accepting an unbacked mock. The exact
original test source and running full-suite log are preserved; no product guard
will be bypassed to satisfy these execution-refresh assertions.

After the SAME full suite finishes, a test-only setup correction is planned:
prepare a real reviewed Read fixture; import its valid initial Action and execution
records through existing validated migration; remove the authoritative-loader
mock; publish the third Action through existing draft/review/activation APIs.
Keep every execution-refresh, permission, stale/replay and queue assertion.
Do not alter product behavior, weaken the guard, insert approvals, or rewrite
active pointers directly. Run the corrected whole composed-runtime file within
the focused budget. No second full suite is authorized by the one-run budget;
its actual failure must remain separate from later targeted verification.
