# Shadow Studies

Use a shadow study before granting an agent write authority. Runner serves the
reviewed proposal capability and records what the agent would have proposed,
but the proposal cannot be approved, queued, or applied.

A study compares two explicit records:

```text
agent result or proposed effect
versus
authoritative outcome recorded by your application or operator
```

Runner does not infer a human rejection from an unchanged database row. A case
without an authoritative outcome remains visibly unmatched.

## Safety Boundary

Set the Runner configuration to:

```json
{
  "version": 1,
  "mode": "shadow"
}
```

The proposal store enforces the shadow boundary below the CLI and local UI:

- a shadow proposal cannot be approved;
- it cannot become a writeback job or worker item;
- it cannot invoke direct database writeback or an app-owned handler;
- no flag bypasses these checks;
- a report suggestion is inactive and never edits or activates a contract.

Shadow data remains in the configured local Runner store. Case and outcome
imports reject obvious credentials, bearer tokens, database URLs, and
secret-like fields.

## Start A Study

Create a study before serving the shadow capability. An empty capability list
means all shadow capabilities; repeat `--capability` or use comma-separated
names to narrow it.

```bash
synapsor-runner shadow study create \
  --id sst_support_pilot \
  --name "Support waiver pilot" \
  --capability billing.propose_late_fee_waiver \
  --store ./.synapsor/local.db

synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

New matching shadow proposals are attached automatically. To attach proposals
that already exist, or to repair correlation after an interrupted process:

```bash
synapsor-runner shadow study sync sst_support_pilot \
  --store ./.synapsor/local.db
```

## Record Non-Proposal Results

A study also needs tasks where the agent was unable or not allowed to propose.
Import one JSON object with `case record`, or a JSON array/JSONL file with
`case import`.

```json
{
  "request_id": "req-policy-42",
  "tenant_id": "acme",
  "principal": "support-agent-shadow",
  "capability": "billing.propose_late_fee_waiver",
  "business_object": "invoice",
  "object_id": "INV-3042",
  "agent_result": "policy_denied",
  "decision_reason": "amount above reviewed bound",
  "risk_score": 35
}
```

Allowed `agent_result` values are:

- `proposed`
- `policy_denied`
- `unable_to_propose`
- `stale_conflict`
- `invalid_unsafe_scope_attempt`

For `proposed`, include normalized `before`, `after`, and `patch` objects under
`proposed_effect`.

```bash
synapsor-runner shadow case import \
  --study sst_support_pilot \
  --input ./cases.jsonl \
  --store ./.synapsor/local.db
```

Imports are limited to 2 MiB and 10,000 records per command.

## Record Authoritative Outcomes

Export actual outcomes from your application audit log or have a trusted
operator create them. Each outcome must match an existing case by study,
request, trusted tenant, business object, and object ID. A supplied proposal ID
must match too.

```json
{
  "request_id": "request_123",
  "proposal_id": "wrp_123",
  "tenant_id": "acme",
  "business_object": "invoice",
  "object_id": "INV-3001",
  "actor": "support_lead_1",
  "disposition": "applied",
  "actual_effect": {
    "before": { "late_fee_cents": 5500 },
    "after": { "late_fee_cents": 0 },
    "patch": { "late_fee_cents": 0 }
  },
  "occurred_at": "2026-07-19T12:00:00.000Z",
  "source": "support-system-audit",
  "reference": "ticket:SUP-184",
  "reason": "customer qualified"
}
```

Allowed dispositions are `applied`, `rejected_no_action`, and
`stale_conflict`. An applied outcome requires an exact normalized effect.

```bash
synapsor-runner shadow outcome import \
  --study sst_support_pilot \
  --input ./outcomes.jsonl \
  --store ./.synapsor/local.db
```

For the normal application path, record the trusted outcome directly instead
of assembling JSONL. `@synapsor/runner/shadow` writes through the same scope,
effect-shape, and secret checks as the import command:

```js
import { createShadowOutcomeRecorder } from "@synapsor/runner/shadow";

const recorder = createShadowOutcomeRecorder({
  storePath: "./.synapsor/local.db",
  studyId: "sst_support_pilot",
  actor: "support_application",
  source: "support-audit-log",
});

try {
  recorder.record({
    requestId: "request_123",
    tenantId: "acme",
    businessObject: "invoice",
    objectId: "INV-3001",
    disposition: "applied",
    actualEffect: {
      before: { late_fee_cents: 5500 },
      after: { late_fee_cents: 0 },
      patch: { late_fee_cents: 0 },
    },
  });
} finally {
  recorder.close();
}
```

The application owns the truth of this outcome. The helper does not read or
mutate the source database and cannot approve a shadow proposal.

## Review The Report

```bash
synapsor-runner shadow report \
  --study sst_support_pilot \
  --output ./shadow-report.json \
  --store ./.synapsor/local.db

synapsor-runner ui \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The stable JSON report preserves total and comparable denominators and
classifies exact, partial, disagreement, human rejection/no action, policy
denial, unable-to-propose, stale/conflict, unmatched, and unsafe-scope cases.
It also includes amount distributions, capability/reason breakdowns, and
risk-ranked disagreements.

The report also shows the explicit trust progression:

```text
Observe -> Compare -> Manual review -> Suggested bounded policy
```

It reports an insufficient sample size until the minimum comparable evidence
exists. A suggested policy remains an inactive review artifact; the report
never widens or activates the contract.

Close a completed study:

```bash
synapsor-runner shadow study close sst_support_pilot \
  --store ./.synapsor/local.db
```

## Deterministic Reference Data

The packaged `examples/support-billing-agent/shadow-study/` directory contains
six synthetic cases and two authoritative outcomes. It covers an exact $55
waiver, human rejection, policy denial, stale state, tenant forgery, and an
unmatched task.

```bash
synapsor-runner shadow study create \
  --id sst_support_reference \
  --name "Support reference study" \
  --capability billing.propose_late_fee_waiver \
  --store ./.synapsor/shadow-reference.db

synapsor-runner shadow case import \
  --study sst_support_reference \
  --input ./examples/support-billing-agent/shadow-study/cases.jsonl \
  --store ./.synapsor/shadow-reference.db

node ./examples/support-billing-agent/app/record-shadow-outcomes.mjs \
  ./.synapsor/shadow-reference.db sst_support_reference

synapsor-runner shadow report \
  --study sst_support_reference \
  --store ./.synapsor/shadow-reference.db
```
