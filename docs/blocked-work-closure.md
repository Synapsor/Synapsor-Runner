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

The prospective `worker check` identity assessment makes no source write or
closure decision. JWT verification can fetch the configured public JWKS; an
authenticated apply-role actor still does not establish a failed item's
separate cancellation control role or its rollback evidence.

Execution setup and `worker check --supervised --capability <outcome>` report
prospective recovery prerequisites separately from worker launch readiness.
No configured `operator_identity.apply_roles` warns that a future eligible
failure may lack an authenticated closure route. A configured role without a
currently authenticated matching signed/JWT actor is **unverified**; a role
string, `dev_env` identity or key filename is not enough. A successful actor
check establishes only that prerequisite for the selected configuration. The
failed item's rollback, source and receipt evidence are assessed later. The
check grants no business or recovery authority and cannot change a historical
failure's recorded roles. Configure authenticated operators through the
existing [operator-identity configuration](runner-config-reference.md#operator-identity)
before future operations; there is no automatic role-provisioning command.

The first supported class is a single terminal PostgreSQL semantic v5 `source_db` attempt, with an explicitly qualified precreated receipt table and a canonical failed `SEMANTIC_AUTHORITY_STALE` receipt. New workers record acknowledged whole-source rollback evidence at the authoritative transaction boundary, bound to the exact job, source destination, receipt namespace, store, lease and approval history. The source receipt lookup must also succeed and show no conflicting receipt. It is supplementary evidence: absence, zero affected rows and an error code cannot establish historical rollback by themselves.

Existing failed items without that producer record remain unsupported; upgrading does not create evidence retroactively. Multiple attempts, uncertain commit/rollback, live leases, outstanding admissions, contradictory or uninspectable receipts, missing operator roles, delegated execution, MySQL and other receipt modes remain on the existing inspection/reconciliation route. There is no force option. Current business rows need not equal the failed attempt's original facts.

Successful closure preserves the failed proposal, approval, attempt, job and canonical receipt. The worker item becomes `discarded`, with one attributed `writeback_blocked_closed` event (`closed_no_effect`). It cannot be claimed after restart. This is not an applied result. An old request/reference still identifies its old failed request.

In the connected application, use `app.explore_data` to obtain a fresh permitted subject reference, then make a separate `app.request_change`. Runner reads current facts and checks current authority, eligibility and allowance again. The earlier approval still counts until its normal window expires. A fresh request may be refused or require human review, including when the old Action has been removed. Closure never reactivates it.

Control mutations use the existing SQLite writer transaction or PostgreSQL schema advisory writer lock. Source inspection and signing happen before that lock; the exact assessment is revalidated under it. All cooperating workers must run the new producer before their failures can qualify. This does not establish multi-host durability or arbitrary clock-skew tolerance.

## Checking an original request through MCP

Repeat the identical `app.request_change` arguments, including the original opaque
references, while their normal lifetime, caller scope and current authority permit
it. `request_disposition: already_recorded` returns that original request. It does
not predict whether a new request would be approved. A later successful request
for the same subject does not replace the original failure or receipt.

The recorded approval, execution and administrative disposition are separate:

- `authorization.approval` uses applicable durable approval history. A failed or
  closed request can retain `automatic` or `human`; missing or contradictory
  approval evidence is `unknown`. Only actual pending review is described as
  human review, and an allowance explanation requires a recorded limit deferral.
- `lifecycle.execution` distinguishes `not_started`, `queued`, `in_progress`,
  `retry_wait`, `applied`, `failed` and `unknown`. Existing `execution: held` is
  retained for failures, running attempts and retry waits; inspect `lifecycle`
  for the distinction. `lifecycle.disposition` reports `open`, `blocked`, `closed`,
  `reconciliation_required` or `unknown` independently.
- Only a durable retry-wait state supplies `automatic_retry_scheduled: true` and
  `next_retry_at`. Closure does not retry, refund or turn a failed receipt into a
  successful one. Unknown retry evidence is null, not a promised retry.
- `source_database_changed` concerns the original request's established effect:
  true with its matching applied receipt, false for established unstarted work
  or validated rollback/closure evidence, and null when unavailable. A failure
  code, zero rows, missing receipt or current row equality alone cannot establish
  historical no effect. `invocation.source_database_changed: false` on replay
  separately says this replay performed no new source effect; it does not say
  that the database is unchanged now.

`ok: true` and a successful MCP transport mean status was returned, not that the
business operation succeeded. Text and structured content describe the same
projection. Bounded control-record rereads conservatively withhold details across
a detected concurrent change; they are not an atomic snapshot. Projection does
not inspect source rows, reconcile, close work or acquire new execution authority.
Private failure causes, signing evidence and raw request/worker identifiers stay
outside this client view. Operator inspection retains its existing permissions.
