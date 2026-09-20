# Close proven-no-effect blocked work

`worker close-blocked` is an operator lifecycle operation. It closes supported failed work permanently; it does not retry, undo an effect, approve a replacement, or refund an automatic approval.

```sh
synapsor worker dead-letter show <proposal_id> --config ./synapsor.actions.runner.json
synapsor worker close-blocked <proposal_id> --config ./synapsor.actions.runner.json
synapsor worker close-blocked <proposal_id> --config ./synapsor.actions.runner.json \
  --confirm --assessment sha256:<exact-preview-digest> \
  --reason "Resolve proven failed work" \
  --identity alice --identity-key /secure/alice.pem
```

Preview is read-only. Confirmation defaults to cancel. `--json` uses the same assessment as the human preview. An acknowledged repeat must use the original assessment and reason; it returns the existing result without another event. Keep the private signing key outside client configuration and version control. Use the existing [signed operator configuration](runner-config-reference.md#operator-identity) and separate execution review before running work. Closure requires a verified operator with an apply role recorded for the failed attempt, plus its cancellation control role when one was recorded. A worker identity or local development identity alone is insufficient.

The first supported class is a single terminal PostgreSQL semantic v5 `source_db` attempt, with an explicitly qualified precreated receipt table and a canonical failed `SEMANTIC_AUTHORITY_STALE` receipt. New workers record acknowledged whole-source rollback evidence at the authoritative transaction boundary, bound to the exact job, source destination, receipt namespace, store, lease and approval history. The source receipt lookup must also succeed and show no conflicting receipt. It is supplementary evidence: absence, zero affected rows and an error code cannot establish historical rollback by themselves.

Existing failed items without that producer record remain unsupported; upgrading does not create evidence retroactively. Multiple attempts, uncertain commit/rollback, live leases, outstanding admissions, contradictory or uninspectable receipts, missing operator roles, delegated execution, MySQL and other receipt modes remain on the existing inspection/reconciliation route. There is no force option. Current business rows need not equal the failed attempt's original facts.

Successful closure preserves the failed proposal, approval, attempt, job and canonical receipt. The worker item becomes `discarded`, with one attributed `writeback_blocked_closed` event (`closed_no_effect`). It cannot be claimed after restart. This is not an applied result. An old request/reference still identifies its old failed request.

In the connected application, use `app.explore_data` to obtain a fresh permitted subject reference, then make a separate `app.request_change`. Runner reads current facts and checks current authority, eligibility and allowance again. The earlier approval still counts until its normal window expires. A fresh request may be refused or require human review, including when the old Action has been removed. Closure never reactivates it.

Control mutations use the existing SQLite writer transaction or PostgreSQL schema advisory writer lock. Source inspection and signing happen before that lock; the exact assessment is revalidated under it. All cooperating workers must run the new producer before their failures can qualify. This does not establish multi-host durability or arbitrary clock-skew tolerance.
