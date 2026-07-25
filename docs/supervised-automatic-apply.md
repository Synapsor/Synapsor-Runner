# Operator-Supervised Automatic Apply

Synapsor separates two decisions that are often incorrectly combined:

1. Who or what may approve a proposal?
2. Who or what may execute an approved proposal?

The model answers neither question. It supplies a bounded request through a
reviewed capability. Human-reviewed policy may approve that exact immutable
proposal, and a separately operated Runner worker may apply it only after
revalidating the complete guarded-write boundary.

Supervised automatic apply is additive and disabled by default. Upgrading does
not start a worker, change existing `AUTO APPROVE` behavior, or apply an
already-approved proposal.

## The Four Supported Modes

| Approval | Execution | Behavior |
| --- | --- | --- |
| Human | Manual | Default: a qualified operator approves and explicitly runs `apply`. |
| Human | Supervised worker | A qualified operator approves; the trusted worker may apply. |
| Policy auto-approval | Manual | Reviewed policy approves; an operator still runs `apply`. This is the legacy `AUTO APPROVE` behavior. |
| Policy auto-approval | Supervised worker | Reviewed policy approves; an independently enabled worker may guardedly apply. |

The default remains human approval plus manual apply.

## Dual Opt-In

Automatic execution requires both:

1. Contract permission, included in the canonical contract digest.
2. Deployment permission for the exact capability and exact active digest.

Public DSL (Domain-Specific Language):

```sql
CREATE CAPABILITY billing.propose_small_credit
  ...
  AUTO APPROVE WHEN amount_cents <= 2500
  LIMIT 20 PER DAY
  ALLOW SUPERVISED WORKER APPLY;
```

The final clause compiles to:

```json
{
  "execution": {
    "supervised_worker": "allowed"
  }
}
```

That permission alone applies nothing. The operator must separately configure
an exact deployment allowlist:

```json
{
  "supervised_worker": {
    "enabled": true,
    "profile": "production",
    "capabilities": [
      {
        "capability": "billing.propose_small_credit",
        "contract_digest": "sha256:REPLACE_WITH_THE_ACTIVE_DIGEST",
        "mode": "supervised_worker",
        "concurrency": 1,
        "queue_limit": 100,
        "lease_seconds": 60,
        "max_attempts": 5,
        "proposal_ttl_seconds": 3600,
        "rate_limit": {
          "executions": 20,
          "window_seconds": 60
        },
        "write_url_env": "BILLING_POSTGRES_WRITE_URL",
        "worker_identity": "billing_worker",
        "control_role": "runner_operator",
        "require_least_privilege_writer": true,
        "writer_posture_fingerprint": "sha256:REPLACE_WITH_REVIEWED_POSTURE_DIGEST"
      }
    ]
  }
}
```

Use environment-variable names in config, never database URLs or credentials.
Production also requires verified `signed_key` or `jwt_oidc` operator identity
for worker controls.

If either opt-in is absent, stale, revoked, or mismatched, the proposal remains
unapplied. Enabling the worker globally does not enable another capability or a
new contract version.

## Initial Eligible Write Shapes

The hardened supervised path is intentionally narrower than manual apply. It
accepts only direct-SQL, single-row proposal capabilities whose complete effect
Runner can validate:

- `UPDATE` with trusted tenant scope and an exact non-weak conflict/version
  guard;
- `INSERT` with trusted tenant scope and a reviewed deterministic
  deduplication key.

It currently refuses:

- `DELETE`;
- reversible actions;
- bounded-set and other multi-row writes;
- app-owned executors or external effects;
- arbitrary or model-generated SQL;
- a missing trusted tenant boundary;
- an unavailable receipt authority;
- a shared, privileged, owner, `BYPASSRLS`, or otherwise unverifiable writer
  when hardened posture is required.

These operations remain available through their documented manual review/apply
or app-owned executor paths. The narrower worker eligibility does not remove
existing Runner write capabilities.

## What The Worker Rechecks

Immediately before leasing and applying, Runner rechecks:

- proposal state, immutable hash, version, approval, expiry, and exact active
  contract digest;
- contract permission, deployment allowlist, worker identity, control state,
  profile, generation lock, and current approval-policy snapshot;
- trusted tenant and principal scope;
- target row and required supporting-evidence freshness;
- current source version and exact reviewed before-state;
- operation, allowed columns, bounds, transitions, row count, and expected
  effect;
- approval and execution count/value limits under concurrency;
- writer credential separation, least-privilege posture, grants, and
  PostgreSQL RLS posture where configured;
- operation identity, deduplication, receipt authority, and active lease.

A policy-approved proposal does not gain permanent authority. If the target row
or mandatory supporting evidence changes before execution, the worker fails
closed with the established conflict/freshness outcome. A refreshed diff is a
new proposal with a new hash and needs its own approval.

Manual and supervised execution converge on the same guarded apply
implementation. The queue is durable work coordination, not a second mutation
engine.

## Run And Operate The Worker

Validate first:

```bash
synapsor-runner config validate --config ./synapsor.runner.json
synapsor-runner doctor --config ./synapsor.runner.json
```

Run one supervised claim:

```bash
synapsor-runner worker run --supervised --once --yes \
  --worker-id billing_worker \
  --config ./synapsor.runner.json
```

Run continuously:

```bash
synapsor-runner worker run --supervised --yes \
  --worker-id billing_worker \
  --config ./synapsor.runner.json
```

Inspect without copying proposal IDs:

```bash
synapsor-runner worker status --config ./synapsor.runner.json
synapsor-runner attention show --config ./synapsor.runner.json
```

Operator controls:

```bash
synapsor-runner worker pause --yes --config ./synapsor.runner.json
synapsor-runner worker resume --yes --config ./synapsor.runner.json
synapsor-runner worker drain --yes --config ./synapsor.runner.json

synapsor-runner worker disable billing.propose_small_credit \
  --digest sha256:EXACT_DIGEST --yes --config ./synapsor.runner.json
synapsor-runner worker enable billing.propose_small_credit \
  --digest sha256:EXACT_DIGEST --yes --config ./synapsor.runner.json
synapsor-runner worker revoke billing.propose_small_credit \
  --digest sha256:EXACT_DIGEST --yes --config ./synapsor.runner.json
```

`revoke` is terminal for that digest. Pause, drain, disable, and revoke stop new
leasing but preserve queued proposals and durable history. They do not interrupt
a transaction that already committed.

Dead-letter recovery remains explicit and identity-verified:

```bash
synapsor-runner worker dead-letter list --config ./synapsor.runner.json
synapsor-runner worker dead-letter show wrp_... --config ./synapsor.runner.json
synapsor-runner worker dead-letter requeue wrp_... --retry-budget 3 --yes \
  --config ./synapsor.runner.json --identity alice --identity-key ./alice.pem
```

Use the secured Workbench for the same queue, pause/drain, exact-digest,
dead-letter, and reconciliation controls.

## Retry And Crash Boundary

Runner may retry only a classified transient failure with a proven non-commit
outcome. Version conflict, stale authority, scope failure, limit failure,
validation failure, and receipt mismatch do not retry automatically.

Delivery may repeat; mutation must not. Worker leases are fenced, and source
operation identity plus receipts prevent duplicate effects.

When the database outcome is unknown, Runner does not guess:

- source-receipt mode resolves a known committed operation from the source-side
  receipt;
- genuinely ambiguous runner-ledger outcomes enter
  `reconciliation_required`;
- automatic retry stops until a verified operator inspects and resolves the
  established reconciliation record.

This is safe retry and explicit ambiguity handling, not a claim of distributed
exactly-once execution.

## Optional Supervision-Health Gate

An exact capability policy may name `required_attention_sinks`:

```json
{
  "required_attention_sinks": ["operations"]
}
```

When present, the worker leaves eligible work queued until every named,
enabled sink has a healthy delivery record. Sink health never approves a
proposal and never bypasses either execution opt-in. This gate is off unless a
capability explicitly names required sinks.

See [Human Attention And Notifications](human-attention-notifications.md) for
quiet defaults, signed webhooks, routing, and the Workbench inbox.

## Accurate Model-Facing Claim

Without supervised execution:

> This call creates a proposal and does not change the source database.

With exact supervised execution enabled:

> This call creates a proposal. If it satisfies the reviewed automatic-approval
> policy, a separately trusted Runner worker may automatically apply it without
> a per-request human click. The model cannot approve, apply, start the worker,
> or change that policy.

The model can therefore cause a bounded request to enter a pre-authorized
production pipeline. It still cannot choose the authority, approve the
proposal, control the worker, or commit a mutation directly.
