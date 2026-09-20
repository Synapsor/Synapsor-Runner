# Existing capabilities and the next bounded recovery decision

This assignment prevents some new blocked items and reports old ones; it does
not recover terminal blocked work. The state guards below are inspected code,
with worker/store cancellation and no-mutation regressions in the current gates.
Installed W1/W2 evidence is recorded separately when actually executed.

| Condition | Existing behavior and next supported operation |
| --- | --- |
| Local input absent before new claim | Check refuses, queued work/history retained. Restore the legitimate trusted launch input, run check, then separately run a worker. This is prevention, not blocked recovery. |
| Terminal blocked setup failure | Inspect `worker dead-letter show <proposal>` (also accepts blocked IDs), receipts and source. Neither `worker cancel` nor dead-letter requeue admits blocked state. No supported recovery transition established. Error code alone is not proof of no effect. |
| Unstarted queued/retry-wait work with stale authority | Existing cancellation checks exact state, lease, approved/pending-worker proposal and applicable reviewed control role/operator identity. Production requires the existing verified operator. It cannot cancel blocked, leased, dispatched/applied or uncertain work. |
| Stale facts encountered during execution | Preserve actual failed receipt and blocked state; no new retry classification. Reconstructing a request under current facts while an old duplicate remains active requires a separate recovery decision. |
| Transient failure with durable retry_wait | Existing bounded retry policy and actual next_attempt_at apply; control, authority, lease and source checks still apply on retry. A maximum is not promised remaining retries. |
| dead_letter | Existing verified operator requeue/discard controls have exact state and receipt guards. They do not apply to blocked state. No such transition is executed by this assignment. |
| Unknown/reconciliation_required | Inspect exact dispatch evidence, durable receipt and independent source outcome. Do not infer no change or run a blind retry. Existing reconciliation is a separate authorized operator operation. |

Next expected scope: design the smallest audited transition for concrete
terminal blocked states that currently lack one, requiring demonstrated source
outcome and preserving exact current authority, deduplication, receipt history
and prior automatic approvals. Keep known-no-effect, stale and uncertain cases
separate. Approval allowance remains consumed for the existing window even when
execution is blocked; no refund or timestamp rewrite follows from recovery.
