# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Let AI agents query and update Postgres/MySQL without giving the model raw
SQL, unrestricted schema access, or database credentials.**

**MCP connects the agent. Synapsor enforces the reviewed database boundary.**

Synapsor Runner is an open-source safety layer between an AI agent and your
database. You review which tables, fields, relationships, operations, and
limits are allowed. The agent can then ask new questions or propose bounded
changes, but it cannot exceed that reviewed access.

```text
Agent sees       reviewed tools, reviewed data names, allowed operations, bounded results
Agent never sees database credentials, raw SQL, excluded fields, unrestricted schema
Runner handles   validation, trusted scope, execution, proposals, evidence
Human controls   reviewed access, activation, approval, production rollout
```

Use Runner when you want flexible agent access without building a new database
tool for every question, and without falling back to `execute_sql`.

Start with the problem you are solving: [safe Postgres MCP](docs/safe-postgres-mcp.md),
[prevent arbitrary LLM SQL](docs/prevent-llm-arbitrary-sql.md), or
[human approval for agent writes](docs/human-approval-ai-database-writes.md).

## Start With Your Database

Use a SELECT-only, non-owner development or staging credential:

```bash
npx -y @synapsor/runner start
```

The first command needs no install. Later examples assume a global install:

```bash
npm install --global @synapsor/runner
```

Otherwise, prefix them with `npx -y @synapsor/runner`.

Paste the URL into the hidden prompt or export `DATABASE_URL`. Runner first
inspects schema metadata, not source rows. It proposes conservative read access
that grants the agent nothing until you review and activate it. You do not need
to write DSL or JSON to begin.

For the interactive terminal first run:

```bash
synapsor-runner start --from-env DATABASE_URL --cli
```

For automation, run `synapsor-runner onboard --help`; missing decisions are reported together.

Review the conservative starting boundary, then press Enter to activate it. Use
`M` to choose OpenAI, Anthropic, or a loopback model, and `E` to change tables
or field access. Runner asks permission before reviewed visible data can leave
the machine. Every access change remains disabled until a human confirms it.

See [Database To First Safe Tool](docs/guided-onboarding.md).

## Ask A Useful Question

After review, use either of these paths. Both call the same validation and
execution code and receive no more authority than the reviewed boundary.

**Use the built-in Workbench or terminal Ask.** Supply your own OpenAI or
Anthropic key, or use a loopback OpenAI-compatible model. Keys and conversation
history stay in memory. A loopback model keeps provider traffic on the machine.

```bash
synapsor-runner try ask --provider openai --model gpt-5-mini
```

**Use an MCP client that already has a model.** Runner can prepare project-local
configuration without putting database credentials in the client file:

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

The agent receives reviewed names and legal operations, not a SQL tool. It can
combine reviewed totals, distinct counts, dimensions, filters, comparisons,
time buckets, top-N rankings, and many-to-one relationships. Every plan is
scope-injected, read-only, budget-bounded, and small-cohort suppressed.

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

The CLI and Workbench show the same review and require a separate human
activation. No browser or copied digest is required in the CLI; changed
artifacts fail closed. The model cannot invoke Protect or activation.

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

For writes, describe one business action. Runner generates an inert TypeScript
draft; it does not silently add a tool or change active authority:

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

Humans do not need to approve every routine request. A team can review a policy
once so low-risk requests inside fixed value, rate, and scope limits are
policy-approved. Automatic application still requires a separate deployment
opt-in and a trusted worker that repeats every guard. Exceptions wait for a
person.

Auto-approval does not mean auto-apply: the exact contract digest and deployment both opt into supervised execution.
External notifications are disabled and quiet by default.
A webhook response cannot approve or apply.

Immediately before a Runner-managed commit, live scope, evidence freshness,
version, bounds, limits, and idempotency are rechecked. Drift causes no
mutation. See [Supervised Apply](docs/supervised-automatic-apply.md),
[Proposal Freshness](docs/proposal-evidence-freshness.md), and
[Verified Operator Identity](docs/approval-roles-and-operator-identity.md).

## Other Ways To Start

### See The Guardrails Without A Database

Run a complete guarded-write proof with no database, Docker, MCP client, model,
account, or configuration:

```bash
npx -y @synapsor/runner try --prove
```

The embedded fixture demonstrates an exact proposal, outside-model approval,
one guarded mutation, a durable receipt, restart-safe retry, and stale-write
refusal. It proves Runner's local mechanics, not a live database connection.
Temporary proof state stays project-local under `./.synapsor/try/`.
`demo --quick` remains a noninteractive compatibility alias.

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

A dedicated read-only account or one or two fixed low-risk application
operations may already be enough. Runner becomes useful when flexible agent
questions or multiple tools need one reviewed boundary, when writes need
outside-model decisions, or when evidence, retries, conflicts, receipts, and
replay would otherwise be rebuilt for every integration.

## Trust And Verification

Start with the [Security Boundary](docs/security-boundary.md). Conformance and
live disposable-database gates cover trusted scope, excluded fields, no
pre-approval mutation, idempotency, conflicts, freshness, privacy suppression,
receipts, and replay across PostgreSQL and MySQL. Runner does not replace
least-privilege roles, host security, or application authorization.

Runner works alone with local SQLite or an opt-in shared Postgres ledger.
Synapsor Cloud adds shared registry, approval, leased jobs, and redacted
activity chronology; credentials and guarded execution stay local. Browse
[Capability Authoring](docs/capability-authoring.md), [OSS vs Cloud](docs/oss-vs-cloud.md),
or the [documentation index](docs/README.md).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md).
