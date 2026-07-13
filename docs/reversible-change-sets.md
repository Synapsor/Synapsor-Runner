# Reviewed Reversible Change Sets

Synapsor Runner 1.4 can capture a bounded inverse for an opt-in direct database
write. This is **reviewed compensation**, not rollback or database time travel.

The operator flow is deliberately two separate approval loops:

```text
forward proposal -> approval -> guarded apply -> applied receipt with inverse
                                                    |
                                                    v
operator runs revert -> new proposal -> independent approval -> guarded apply
```

`synapsor-runner revert` never writes, approves, or bypasses a guard. It is an
operator CLI command and is not exposed as an MCP tool.

## Authoring

Add `REVERSIBLE` only to a direct SQL proposal whose inverse Runner can prove:

```sql
CREATE CAPABILITY billing.propose_plan_credit
  USING CONTEXT trusted_operator
  SOURCE billing_postgres
  ON public.customers
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  LOOKUP customer_id BY id
  ARG customer_id STRING REQUIRED MAX LENGTH 128
  ARG amount_cents NUMBER REQUIRED MIN 1 MAX 2500
  ALLOW READ id, tenant_id, plan_credit_cents, version
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION grant_plan_credit UPDATE
  ALLOW WRITE plan_credit_cents
  PATCH plan_credit_cents = ARG amount_cents
  BOUND plan_credit_cents 0..2500
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
  REVERSIBLE
END
```

The canonical JSON equivalent is:

```json
{
  "proposal": {
    "reversibility": { "mode": "reviewed_inverse" }
  }
}
```

Validation rejects `REVERSIBLE` when writeback uses an app handler or Cloud
worker, approval is policy-driven, or an UPDATE lacks exact integer version
advancement. INSERT also requires a deterministic primary-key dedup component.

## Operator Flow

After an unambiguous forward apply:

```bash
synapsor-runner revert <forward_proposal_id> \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --reason "Correct the reviewed credit"

synapsor-runner proposals show latest --details --store ./.synapsor/local.db
synapsor-runner proposals approve latest --yes --store ./.synapsor/local.db
synapsor-runner apply latest --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner replay show latest --store ./.synapsor/local.db
```

The compensation proposal inherits the original reviewer role and quorum. A
signed operator identity is required when configured. The source remains
unchanged until the compensation proposal is separately approved and applied.

## Supported Inverses

| Forward operation | Reviewed compensation |
| --- | --- |
| Single-row UPDATE | Restores only allowlisted prior values after checking the exact state and version left by the forward write. The version advances again; it is never decremented. |
| Soft delete | Same as UPDATE when deletion is a reviewed status or timestamp patch. |
| Single-row INSERT | Deletes only the exact Runner-created identity after checking current reviewed state, tenant, triggers, and foreign-key effects. |
| Bounded set UPDATE | Restores exactly the original frozen members under the original count/value caps in one transaction. One stale member aborts all members. |
| Exact-review batch INSERT | Removes exactly the inserted member identities, atomically, after the same safety preflight. |
| Hard DELETE | Not generally restorable. The receipt reports specific unavailable reason codes instead of claiming a safe inverse. |

Kept-out and non-writable fields are never captured just to make compensation
possible. Each successful compensation captures its own bounded inverse, so an
operator may propose a revert of the compensation. Lineage is linear, duplicate
children are rejected, and traversal is capped at 16 proposals.

## Fail-Closed Cases

Runner refuses to create or apply compensation when:

- the forward outcome is missing, failed, or requires reconciliation;
- the applied receipt has no available inverse;
- another active compensation already targets that receipt;
- the tenant or operator identity does not match trusted authority;
- the row changed after the forward write;
- an inserted row is missing or has changed;
- a new trigger, foreign-key dependent, or widening cascade prevents a bounded
  effect proof;
- any member of a bounded set is stale or missing;
- lineage is invalid, cyclic, or beyond the depth limit.

With `runner_ledger` receipt authority, a crash after source commit but before
ledger completion remains ambiguous. Forward and compensation writes enter
`reconciliation_required`; Runner does not call them reverted or retry them
automatically. Reconcile the outcome first through the verified operator
workflow.

## Database Metadata Privileges

Postgres uses catalog visibility available to the configured writer for
trigger and foreign-key preflight.

MySQL compensation that may delete a row, including reversal of INSERT,
requires enough metadata visibility to prove no hidden widening effects:

- scoped `TRIGGER` visibility on the target table;
- global `PROCESS` visibility for incoming InnoDB foreign-key metadata.

If those privileges are not acceptable, use a reversible soft-delete UPDATE or
an explicitly reviewed app-owned compensation capability. Runner fails closed.

## App-Owned Executors

Runner does not infer compensation for `http_handler`, `command_handler`,
payments, messages, or other external effects. The application must expose a
separate reviewed compensation capability and enforce its own tenant, version,
idempotency, and transaction rules. A handler returning a receipt does not make
its side effect Runner-reversible.

## Verification

The disposable PostgreSQL/MySQL gate proves UPDATE, INSERT, soft-delete, exact
bounded-set compensation, independent approval, stale-state refusal,
hard-delete unavailability, inverse redaction, receipts, and replay:

```bash
corepack pnpm test:reversible
```

See [RFC 006](rfcs/006-reviewed-reversible-change-sets.md) for the normative
safety design and [Current Limitations](limitations.md) for the wider boundary.
