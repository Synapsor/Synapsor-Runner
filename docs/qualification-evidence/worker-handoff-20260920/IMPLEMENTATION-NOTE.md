# O2 / P1 reporting and launch assessment

The before PostgreSQL test reached apply after claim and recorded
TRUSTED_BINDING_MISSING, blocked, attempt 1. Its exact log and exit are retained.
The former JSON summary already counted blocked items. The valid renderer
reproduction proves the human summary and dead-letter-empty text disagreed.
Earlier renderer attempts failed fixture config validation, not product behavior.

The repair adds a local launch assessment shared by guided execution review,
`worker check --supervised`, and supervised startup, before bridges, startup
attention, enqueue/expiry sweeps, leases, attempts and job creation. Existing
effective-store selection is checked first; forged bridge/store overrides remain
refused. A read-only shared-store check uses the existing read bridge. It uses the
existing default reviewed local identity loader and resolves its project relative
to the selected configuration. The loader's contract/ownership/mode/conflict
checks are preserved. Named identity selection remains confined to its existing
supported launch routes; worker gains no new profile selector or fallback.

The assessment derives context references by observing the actual trusted
resolver's environment reads. It retains only reference names and presence,
never values. It resolves the exact outcome's existing writer source and checks
local URL shape without connecting. It reports receipt selection provenance
separately from live verification and execution consent. The check never calls
the receipt probe, grants permissions, opens the queue, or starts a worker.

Scope is deliberately narrow: one selected semantic outcome (or the single
configured semantic outcome). Multi-outcome unselected and other per-item modes
are explicitly unassessed, not a union of credentials or a new global human
identity requirement. `worker check` returns 2 for incomplete assessment. Existing
worker dispatch paths retain their guarded per-item checks. Generated launch
commands select the exact outcome and quote configuration paths. The selected
mode's existing worker identity selection still applies to check and run.

All authority, source posture, facts, scope, version, receipt, lease and runtime
binding checks still run at dispatch. A passed check is a point-in-time local
prerequisite assessment, not execution authorization. There is no success cache.
No accounting query, retry classification, queue transition or recovery is added.

Status preserves machine fields and adds attempt facts and explicit scope/page
metadata. It counts the entire matching queue before limiting displayed rows.
Human output defaults to 20 rows; JSON remains complete unless explicitly paged.
A leased attempt has started but not completed. Retry scheduling is asserted only
for retry_wait and retains its actual next_attempt_at; the configured maximum
is not remaining retries. Reconciliation does not imply no effect. Observations
are separate reads, explicitly not an atomic snapshot. Dead-letter show uses the
read bridge, not the mutation bridge.

Blocked recovery is not implemented: dead-letter requeue and unstarted-work
cancellation have distinct guards that do not accept terminal blocked work.
Status directs inspection and warns about the duplicate guard and retained
approval consumption. A new bounded recovery decision must distinguish proven
no-effect setup failures, stale authority/facts and uncertain dispatch; an error
code alone is insufficient evidence to delete, refund, retarget or requeue.

Integration correction before freeze: the first implementation diagnosed missing
context before an invalid explicit SQLite store selection. The unchanged existing
codec regression caught the error-code precedence change (expected
POLICY_STORE_SELECTION_CHANGED, got TRUSTED_BINDING_MISSING). Store selection
is now checked first; the same SQLite and real PG control tests pass, including
added check-only store/forged-bridge negatives. No assertion was relaxed.

Receipt-label correction before freezing: saved receipt selection is an operator
setup record, not the active execution configuration. A current source/domain
binding can coexist with a different configured writer, mode or destination.
The handoff therefore reports configured mode, selected mode/domain status, and
an explicit exact execution-configuration match separately. The regression runs
through saved selection and actual launch assessment, varies mode/destination/
writer, and confirms that assessment adds no receipt probe. No runtime receipt
selection or execution rule was changed.

Full-stable02 completed exit1 (15failed/6606passed/470skipped), source unchanged.
Thirteen worker policy-refresh unit cases use mocked configuration/application
and no actual saved semantic authority; the new real assessment correctly found
ENOENT. Their existing isolated fixture now explicitly supplies a mocked valid
launch assessment, leaving policy refresh/identity/revocation assertions intact.
The real authority integration tests still execute the assessor unmocked. One
actual authority TUI assertion expected the former flag order; it now asserts
both real check and scoped run commands. One long-running-client codec case
supplied synthetic context only to the request runtime, not the separately
invoked worker; it now passes those same fixture inputs to the worker, restoring
them afterwards. Its original before-claim revocation schedule and no-claim/no-
effect assertions remain strict. No product guard was changed for these failures.
These are demonstrated fixture/output-contract corrections, not a green full
suite. Focused corrected cases and a new complete stable run are still required.
