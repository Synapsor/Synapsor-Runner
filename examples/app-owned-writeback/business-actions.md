# App-Owned Business Action Examples

These examples show the kinds of approved proposals an app-owned handler can
apply. They are intentionally not direct SQL examples. Your application service
owns the write transaction, re-checks authorization and row/version guards, and
returns a terminal receipt to Synapsor Runner.

Each request uses the same boundary:

```text
model-facing MCP tool -> proposal
human/operator approval -> app-owned handler
handler transaction -> applied/conflict/failed receipt
local replay
```

The handler must not trust request fields blindly. Re-check tenant,
principal/role, idempotency, row versions, and business policy before mutating
state.

## Create A Refund Review

Use this when an agent may request a refund review, but your application must
create the review record through normal business logic.

Capability:

```text
refunds.propose_refund_review(order_id, reason, requested_amount_cents)
```

Handler request:

```json
{
  "schema_version": "synapsor.handler-writeback.v1",
  "writeback_job_id": "hwb_wrp_refund_001",
  "proposal_id": "wrp_refund_001",
  "idempotency_key": "wrp_refund_001",
  "change_set": {
    "action": "refunds.propose_refund_review",
    "scope": {
      "tenant_id": "acme",
      "principal": "support_lead@example.com",
      "object_type": "order",
      "object_id": "ORD-3001"
    },
    "before": {
      "order_status": "delivered",
      "refund_review_id": null
    },
    "patch": {
      "requested_amount_cents": 2500,
      "reason": "duplicate charge"
    },
    "after": {
      "refund_review_status": "pending_review"
    },
    "guards": {
      "expected_version": {
        "column": "updated_at",
        "value": "2026-06-20T14:31:08Z"
      }
    },
    "evidence": {
      "bundle_id": "ev_refund_001"
    }
  },
  "executor": "app_writeback_api",
  "dry_run": false
}
```

Handler transaction sketch:

```text
BEGIN
  verify principal can request refunds for tenant acme
  verify order ORD-3001 still belongs to tenant acme
  verify order.updated_at still matches expected_version
  verify no receipt exists for idempotency_key
  INSERT INTO refund_reviews (...)
  INSERT INTO synapsor_app_receipts (...)
COMMIT
```

Receipt:

```json
{
  "status": "applied",
  "rows_affected": 1,
  "new_object_id": "RR-9001",
  "source_database_mutated": true
}
```

## Insert An Account Credit Row

Use this when the safe write is an append-only ledger/accounting operation.

Capability:

```text
credits.propose_account_credit(customer_id, amount_cents, reason)
```

Handler transaction sketch:

```text
BEGIN
  verify customer belongs to trusted tenant
  verify amount is within app policy
  verify idempotency_key has not already created a credit
  INSERT INTO account_credits (...)
  UPDATE customers SET credit_balance_cents = credit_balance_cents + amount
  INSERT INTO synapsor_app_receipts (...)
COMMIT
```

Conflict receipt if the app policy no longer allows the credit:

```json
{
  "status": "conflict",
  "safe_error_code": "CREDIT_POLICY_CHANGED",
  "source_database_mutated": false,
  "details": {
    "reason": "customer credit limit changed after proposal"
  }
}
```

## Open A Support Ticket

Use this when the agent may propose opening a ticket, but ticket creation must
go through your helpdesk/application service.

Capability:

```text
support.propose_open_ticket(customer_id, subject, body)
```

Handler transaction sketch:

```text
BEGIN
  verify principal can open support tickets for tenant
  verify customer belongs to tenant
  validate subject/body against app policy
  INSERT INTO support_tickets (...)
  INSERT INTO ticket_events (...)
  INSERT INTO synapsor_app_receipts (...)
COMMIT
```

Receipt:

```json
{
  "status": "applied",
  "rows_affected": 2,
  "new_object_id": "T-9100",
  "source_database_mutated": true
}
```

## Update Multiple Related Rows

Use this when an approved business action spans several tables and should stay
inside your normal application transaction.

Capability:

```text
subscriptions.propose_trial_extension(customer_id, extension_days, reason)
```

Handler transaction sketch:

```text
BEGIN
  verify tenant/principal authorization
  SELECT subscription FOR UPDATE
  verify expected subscription version
  UPDATE subscriptions SET trial_ends_at = ...
  INSERT INTO customer_events (...)
  INSERT INTO billing_notes (...)
  INSERT INTO synapsor_app_receipts (...)
COMMIT
```

Receipt:

```json
{
  "status": "applied",
  "rows_affected": 3,
  "previous_version": "2026-06-20T14:31:08Z",
  "new_version": "2026-06-20T14:34:19Z",
  "source_database_mutated": true
}
```

## Idempotent Retry

If the same `idempotency_key` reaches your handler again after a successful
apply, return `already_applied` and the original receipt details rather than
running the transaction again.

```json
{
  "status": "already_applied",
  "rows_affected": 0,
  "source_database_mutated": false,
  "details": {
    "original_receipt_id": "rct_abc123"
  }
}
```
