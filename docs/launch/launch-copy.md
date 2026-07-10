# Synapsor Launch Copy

These drafts are prepared for review. They have not been posted or sent.

Links:

- Article: https://synapsor.ai/blog/stop-giving-agents-execute-sql
- GitHub: https://github.com/Synapsor/Synapsor-Runner
- npm: https://www.npmjs.com/package/@synapsor/runner
- Example: https://github.com/Synapsor/Synapsor-Runner/tree/main/examples/support-plan-credit
- Design partners: https://synapsor.ai/contact

## LinkedIn

The fastest way to connect an AI agent to a database is also the most
dangerous: give it `execute_sql(sql: string)` and hope it behaves.

We built Synapsor Runner around a different boundary. The model receives
reviewed business capabilities such as `support.propose_plan_credit`. It can
inspect tenant-scoped data and create an exact proposal, but it cannot approve
or commit the write. An operator approves outside MCP; guarded writeback checks
the row, tenant, allowed columns, and expected version; then Synapsor records a
receipt and replay.

The Runner, canonical contract spec, and SQL-like authoring DSL are open
source. The demo uses a real disposable Postgres database and pushes the same
contract to the versioned Synapsor Cloud registry.

Read the architecture: https://synapsor.ai/blog/stop-giving-agents-execute-sql

Try the Runner: https://github.com/Synapsor/Synapsor-Runner

We are onboarding design partners building agents against business data. Bring
a staging Postgres/MySQL database and one risky workflow; we will help turn it
into reviewed capabilities with approvals, receipts, and replay.

## X Thread

1. Stop giving agents `execute_sql`. Give them reviewed business actions
   instead.

2. Synapsor Runner exposes semantic MCP capabilities, binds tenant/principal
   scope outside model arguments, and turns requested writes into exact
   proposals. The model does not receive credentials, approval, or commit
   tools.

3. After operator approval, guarded writeback checks the primary key, tenant,
   allowed columns, expected row version, and one-row result. Receipt + replay
   preserve what happened.

4. The contract spec, DSL, and Runner are open source. Synapsor Cloud is
   available to design partners who need a shared versioned registry and team
   review surface.

5. Demo + code: https://github.com/Synapsor/Synapsor-Runner
   Architecture: https://synapsor.ai/blog/stop-giving-agents-execute-sql

## Show HN

Title:

```text
Show HN: Synapsor Runner - reviewed database actions instead of execute_sql for agents
```

Body:

```text
We open-sourced Synapsor Runner, a local-first MCP runtime for agents that need
to inspect or propose bounded changes to Postgres/MySQL-backed state.

The model sees semantic capabilities such as support.inspect_customer and
support.propose_plan_credit. Tenant/principal scope comes from trusted runtime
context. A proposal records the exact diff and evidence without mutating the
source row. Approval and apply stay outside MCP; the supported direct path is a
guarded single-row UPDATE with version, tenant, column, affected-row, and
idempotency checks. Receipt and replay remain local.

The public contract spec and SQL-like DSL are separate packages, so capability
definitions can be reviewed in Git and run locally. The project deliberately
does not claim safe arbitrary SQL, prompt-injection prevention, or direct
INSERT/DELETE/multi-row writes.

Quick demo and source:
https://github.com/Synapsor/Synapsor-Runner

Technical rationale:
https://synapsor.ai/blog/stop-giving-agents-execute-sql

I would value feedback from teams already letting agents touch staging
databases: which business action is hardest to expose without handing the model
too much authority?
```

## Concise Direct Message

Are you letting an agent query or modify Postgres/MySQL yet? We open-sourced
Synapsor Runner so the model gets tenant-bound business capabilities and
proposal authority instead of raw SQL or commit authority. I would like to help
you try it against one risky staging workflow:
https://github.com/Synapsor/Synapsor-Runner

## Technical Direct Message

I am looking for a few engineers already wiring Claude, Cursor, OpenAI Agents,
or another MCP client to business data. Synapsor Runner replaces generic SQL
tools with a reviewed contract: trusted tenant/principal bindings, visible and
kept-out fields, evidence-backed proposals, external approval, guarded
single-row writeback, receipt, and replay. The OSS path runs locally; Cloud is a
design-partner control plane for shared contract versions and review.

If you have a staging Postgres/MySQL database and one bounded workflow, I can
help map it to a capability and test the safety boundary with you.

Article: https://synapsor.ai/blog/stop-giving-agents-execute-sql
Example: https://github.com/Synapsor/Synapsor-Runner/tree/main/examples/support-plan-credit

## Design-Partner Qualification

A strong first design partner:

- already has an agent prototype touching database-backed business state;
- can start with a staging or disposable Postgres/MySQL database;
- has one concrete bounded workflow such as support credit, fee waiver, ticket
  resolution, order review, or account-status change;
- values tenant scope, approval, evidence, receipts, or replay;
- can assign an engineer to a focused onboarding session;
- accepts that Runner direct writeback currently supports guarded single-row
  updates, while richer writes require an app-owned executor;
- understands that Synapsor Cloud is a design-partner/private-beta control
  plane, not Enterprise GA.

Defer teams that require SAML/SCIM, a managed runner fleet, arbitrary SQL,
multi-row direct writes, or an enterprise production SLA before evaluating the
local boundary.
