# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Open-ended investigations. Bounded actions.**

**Let customer-facing agents answer questions you did not prebuild without
crossing tenant boundaries.**

Synapsor gives agents open-ended exploration inside a reviewed Postgres or
MySQL boundary. Tenant and principal scope, allowed fields and relationships,
query limits, approvals, and database commits remain enforced outside the
model.

Already use RLS, views, or authenticated service methods? Keep them. Runner
adds the agent-facing exploration, proposal, approval, evidence, receipt, and
replay lifecycle above them.

**The model chooses the question. Runner enforces the authority.**

## Start With Your Database

**The CLI is preferred. Workbench remains preview.**

Use a SELECT-only, non-owner development or staging credential:

```bash
npx -y @synapsor/runner start --cli
```

Later examples assume a global install; otherwise prefix them with
`npx -y @synapsor/runner`:

```bash
npm install --global @synapsor/runner
```

Paste the URL into the hidden prompt or export `DATABASE_URL`. Runner inspects
metadata, not rows, and proposes conservative access. Nothing is granted until
review and activation. No DSL or JSON is required.

With `DATABASE_URL`, use the CLI:

```bash
synapsor-runner start --cli --from-env DATABASE_URL
```

For automation, `synapsor-runner onboard --help` reports missing decisions together.

Review the starting boundary, then press Enter to activate it. Use `M` for
OpenAI, Anthropic, or a loopback model, and `E` to edit access. Runner asks
before reviewed visible data leaves the machine. Changes remain disabled until
human confirmation.

See [Database To First Safe Tool](docs/guided-onboarding.md).

## Prove The Boundary Without A Database

Use the terminal-only proof with no database, Docker, account, API key, MCP
client, model, or global install:

```bash
npx -y @synapsor/runner try --prove --no-open
```

Type `APPROVE` or `REJECT` at the trusted terminal prompt. Runner uses a
deterministic simulated agent; after approval, output includes this abridged,
verbatim sequence:

```text
Actor:
  deterministic simulated agent (no LLM call)
Model-facing tools:
  billing.inspect_invoice
  billing.propose_late_fee_waiver
  No execute_sql, approve, apply, or commit tool
Proposed effect:
  late_fee_cents: 5500 -> 0
Source changed:
  No

Guarded commit complete.
Receipt status: applied
Rows affected: 1

Extended proof:
  restart-safe retry: yes
  changed-intent operation reuse rejected: yes
  stale apply refused: yes
```

The simulated agent can inspect reviewed evidence and form an exact proposal,
but cannot approve or commit it. Runner waits for an outside-model decision,
rechecks the effect, and records a receipt.

This proves local mechanics, not your database configuration. Temporary state
stays under `./.synapsor/try/`. `demo --quick` remains a noninteractive compatibility alias.

## What Runner Controls

Synapsor Runner is an open-source database-authority layer between an AI agent
and Postgres/MySQL. You review tables, fields, relationships, operations, and
limits. Agents may explore within that boundary or create exact proposals;
activation, approval, and commit stay outside model-facing tools.

RLS and database permissions decide which rows the runtime can reach. Runner
decides what an agent may ask, combine, reveal, and propose within that
database-enforced foundation. It complements those controls rather than
replacing them.

```text
Raw database MCP   Agent -> execute_sql --------------------------> Database
Synapsor Explore   Agent -> app.describe_data / app.explore_data
                            -> reviewed boundary -----------------> Database
Synapsor writes    Agent -> exact proposal -> outside-model decision
                            -> trusted guarded commit ------------> Receipt
```

The authority path is `Explore -> Protect -> Propose -> outside-model decision
-> Commit -> Receipt`, without falling back to `execute_sql`.

Read [Database Authority And Application Guardrails](docs/why-synapsor-vs-app-guardrails.md),
or start with [safe Postgres MCP](docs/safe-postgres-mcp.md),
[prevent arbitrary LLM SQL](docs/prevent-llm-arbitrary-sql.md), or
[human approval for agent writes](docs/human-approval-ai-database-writes.md).

## Ask A Useful Question

After review, use terminal Ask, preview Workbench, or an MCP client. All share
one validation and execution path. Supply an OpenAI or Anthropic key, or use a
loopback model. Keys and history stay in memory; loopback traffic stays local.

```bash
synapsor-runner try ask --provider openai --model gpt-5.6-luna
```

Runner can also configure an MCP client without putting database credentials
in its project file:

```bash
synapsor-runner mcp install \
  <cursor|claude-code|claude-desktop|vscode|generic-stdio> \
  --project --authoring --project-root . --yes
```

See [Client Recipes](docs/client-recipes.md) for supported MCP hosts.

Local development/staging Explore exposes only:

```text
app.describe_data
app.explore_data
```

Agents receive reviewed operations, never SQL. Plans may combine totals,
distinct counts, dimensions, filters, comparisons, time windows, rankings, and
many-to-one relationships. Every plan is scope-injected, read-only,
budget-bounded, and small-cohort suppressed.

```text
Question
Which reviewed regions contributed most to failed payments last week?

Runner-verified result
region       failed_payments
west         184
north        121

1 additional group and its label were withheld below the reviewed cohort minimum.
```

When a question crosses the boundary, refusal is the result:

```text
REFUSED
The requested customer relationship is proven by the schema but has not been reviewed.
No source query executed.
```

The model cannot activate the offered review path. Normal answers keep model
interpretation separate from Runner-rendered facts; `/details` shows the exact
typed request, validated plan, runtime checks, suppression, and evidence.

Explore is local by default. Production opt-in over secured Streamable HTTP
requires verified JWT scope, per-principal and tenant budgets, rate limits, and
atomic shared-Postgres accounting. See
[Production Scoped Explore Over HTTP](docs/production-scoped-explore-http.md)
and [Explore And Protect](docs/auto-boundary-and-scoped-explore.md).

## Turn A Useful Question Into Production Access

After an answer proves useful, run `/protect`. Runner freezes that one successful
analysis into a named read-only capability with generated DSL, canonical JSON,
tests, and provenance. It starts disabled.

CLI and Workbench use the same review and separate human activation. The CLI
needs no browser or copied digest; changed artifacts fail closed. Models cannot
invoke Protect or activation.

`/details A2 --sql` can show an operator-only parameterized statement with all
values redacted. SQL never reaches the model, MCP response, or durable evidence.

For fixed production question shapes, switch the selected project client from
temporary Explore to the activated named capability:

```bash
CLIENT=claude-code # or cursor / vscode
synapsor-runner mcp install "$CLIENT" --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

Protected capabilities remain the narrowest production choice. For reviewed
ad-hoc analytics, `synapsor-runner config init --production-explore` generates
secured runtime config from the boundary without secrets.

## Let Agents Propose Bounded Changes

Open the write control plane from Ask:

```text
synapsor> /actions
```

Or directly:

```bash
synapsor-runner action review --project-root .
```

Runner ranks schema-proven candidates. Humans review bounds, scope, approval,
and execution. Proposal-only `WRITEBACK NONE` is the default; model suggestions
grant nothing. The TUI handles rehearsal, activation, drafts, and the inbox.

Code-first remains:

```bash
synapsor-runner start \
  --action plan_credit \
  --description "Propose one reviewed customer plan credit" \
  --based-on support.inspect_customer
```

After a human reviews and activates that action, the agent can create an exact
proposal, sometimes called a Data PR. It still cannot approve or apply it:

```text
Proposal  support.propose_plan_credit on CUS-3001
Effect    plan_credit_cents: 0 -> 2500
Database  unchanged until an outside-model decision
```

Auto-approval does not mean auto-apply: the exact contract digest and deployment both opt into supervised execution.
External notifications are disabled and quiet by default.
A webhook response cannot approve or apply.

Immediately before a Runner-managed commit, live scope, evidence freshness,
version, bounds, limits, and idempotency are rechecked. Drift causes no
mutation. See [Supervised Apply](docs/supervised-automatic-apply.md),
[Proposal Freshness](docs/proposal-evidence-freshness.md), and
[Verified Operator Identity](docs/approval-roles-and-operator-identity.md). The
TUI, Workbench, CI, DSL/Spec, stdio, Ask, and HTTP lifecycle is in the
[Safe Action Human Control Plane](docs/safe-action-control-plane.md).

## Other Paths

### Audit An Existing MCP Server

Already have database MCP tools? Inspect a manifest, remote `tools/list`, or
stdio server without invoking its business tools:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
synapsor-runner audit ./tools-list.json
```

The audit flags raw SQL, arbitrary identifiers, model-controlled authority, and
model-facing write execution. See [MCP Audit](docs/mcp-audit.md).

### Keep Your Existing Service Layer

If your application already exposes narrow authenticated business operations,
keep them. Runner can add the agent-specific review, proposal, policy,
approval, evidence, receipt, and replay lifecycle around those operations.
Multi-step transactions and external effects remain in an application-owned
executor. See [Application Guardrails](docs/why-synapsor-vs-app-guardrails.md).

## Why Not Raw Text-To-SQL?

Text-to-SQL can produce confident, plausible, wrong answers while holding much
more authority than the question requires. A published
[ReFoRCE](https://arxiv.org/abs/2502.00675) pipeline reports about 11% execution
accuracy on the enterprise-scale [BEAVER benchmark](https://arxiv.org/abs/2409.02038).
In [EntSQL](https://arxiv.org/abs/2606.03363), 54.6% of 982 observed failures
were wrong filters.

These benchmark-specific figures are not a Runner accuracy claim. Runner cannot
decide what a business term means. It removes arbitrary SQL authority, limits
the legal plan space, injects trusted scope, and records what was actually
validated and executed.

## Safety Model

Reviewed capabilities fix context, fields, relationships, operations, bounds,
and approval rules. Model-facing tools may inspect bounded data or create exact
proposals, but they cannot activate access, choose tenant/principal scope,
approve, apply, or revert. Runner does not make a raw-SQL client safe.

Choose application scope, PostgreSQL RLS, or tenant-bound credentials for your
threat model; Runner does not replace database permissions. Stdio opens no
socket. Network MCP requires authenticated encrypted transport and verified
session context. See [Threat Model](THREAT_MODEL.md), [Database Scope](docs/database-enforced-scope.md),
and [HTTP MCP](docs/http-mcp.md).

## You May Not Need Runner

A read-only account, a view, or a few fixed low-risk operations may suffice
when the questions and actions are known in advance. Runner is useful when an
agent must investigate questions you cannot enumerate ahead of time within one
reviewed boundary, when writes require outside-model decisions, or when
integrations need common evidence, retries, conflicts, receipts, and replay.

## Trust And Verification

Start with the [Security Boundary](docs/security-boundary.md). Live gates cover
scope, mutation, freshness, suppression, and replay. Runner does not replace
database or application authorization. Supported sources are PostgreSQL 13-18,
full-grammar MySQL 8.0.16+, and limited-tier MySQL 8.0.11-8.0.15 or 5.7.
Unsupported grammar is hidden before model discovery. See
[Database Server Compatibility](docs/database-server-compatibility.md).

Runner uses SQLite or a Postgres ledger. Synapsor Cloud adds
registry, approval, jobs, and redacted activity; credentials and
execution stay local. Browse
[Capability Authoring](docs/capability-authoring.md), [OSS vs Cloud](docs/oss-vs-cloud.md),
or the [documentation index](docs/README.md).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md).
