# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Open-ended investigations. Bounded actions.**

**Let customer-facing agents answer questions you did not prebuild without
crossing tenant boundaries.**

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
metadata, asks what job the agent should perform, and grants nothing before
activation.

With `DATABASE_URL`, use the CLI:

```bash
synapsor-runner start --cli --from-env DATABASE_URL
```

That command is the shortest model-guided path:

1. Runner inspects schema metadata without reading business rows.
2. You describe one agent job in ordinary language.
3. The model drafts Read and Action Boundaries; Runner asks only about business
   choices it cannot prove, validates the result, and shows separate activation
   permissions.
4. After those exact permissions, Runner prints the MCP connection command.

You do not hand-map every table, write policy JSON, or create another MCP tool
for each business action. Manual and no-model editors remain available when you
want them.

Choose OpenAI, Anthropic, or a local tool-capable model. Structural metadata and
business answers leave the machine only after explicit egress consent.

See [Database To First Safe Tool](docs/guided-onboarding.md).

### Compile From Representative Jobs

`W Agent job` reopens the saved Read and Action drafts. See
[Boundary Assist](docs/read-workload-boundary-assist.md).

## Prove The Boundary Without A Database

Try a deterministic simulation without a database or model:

```bash
npx -y @synapsor/runner try --prove --no-open
```

Type `APPROVE` or `REJECT`. A deterministic simulated agent proposes a bounded
late-fee waiver without SQL or commit authority. Runner then demonstrates
outside-model approval, guarded commit, receipt, replay, and stale-intent
refusal. Temporary state stays under `./.synapsor/try/`.
`demo --quick` remains a noninteractive compatibility alias.

## What Runner Controls

Synapsor Runner is an open-source database-authority layer for Postgres/MySQL.
Keep RLS, views, and database permissions. You review what agents may ask,
reveal, and propose; scope, activation, approval, and commit stay outside model
tools.

```text
Raw database MCP   Agent -> execute_sql --------------------------> Database
Synapsor Explore   Agent -> app.describe_data / app.explore_data
                            -> reviewed boundary -----------------> Database
Synapsor actions   Agent -> bounded proposal or reviewed outcome
                            -> Runner-derived exact effect
                            -> outside-model decision
                            -> trusted guarded commit ------------> Receipt
```

The authority path is `Explore -> Protect -> Propose -> outside-model decision
-> Commit -> Receipt`, without falling back to `execute_sql`.

Read [Database Authority And Application Guardrails](docs/why-synapsor-vs-app-guardrails.md),
or start with [safe Postgres MCP](docs/safe-postgres-mcp.md),
[prevent arbitrary LLM SQL](docs/prevent-llm-arbitrary-sql.md), or
[human approval for agent writes](docs/human-approval-ai-database-writes.md).

## Ask A Useful Question

After review, use terminal Ask, preview Workbench, or MCP. They share one
execution path. Keys stay in memory; loopback traffic stays local.

```bash
synapsor-runner try ask --provider openai --model gpt-5.6-terra
```

Runner can also configure an MCP client without putting database credentials
in its project file:

```bash
synapsor-runner mcp install claude-code \
  --project --authoring --project-root . --yes
```

See [Client Recipes](docs/client-recipes.md) for supported MCP hosts.

The single local entry exposes the four fixed tools listed below. Read and
Action authority remain separate; adding outcomes needs no client reinstall.

Replay a fixed plan with `synapsor-runner explore playground`, or open its
highlighted editor with `synapsor-runner explore workbench --project-root .`.
`explore validate` compiles placeholder-only SQL without querying rows or
spending budget; `explore run` preserves enforcement and audit. See
[Explore Plan Playground](docs/explore-plan-playground.md).

Agents receive reviewed operations, never SQL. Plans combine totals,
dimensions, filters, comparisons, time windows, rankings, and reviewed
relationships. Every query is scope-injected, read-only, budget-bounded, and
small-cohort suppressed. Boundary violations are refused before source
execution.

The model cannot activate the offered review path. Normal answers keep model
interpretation separate from Runner-rendered facts; `/details` shows the exact
typed request, validated plan, runtime checks, suppression, and evidence.

Explore is local by default. Production opt-in over secured Streamable HTTP
requires verified JWT scope, per-principal and tenant budgets, rate limits, and
atomic shared-Postgres accounting. See
[Production Scoped Explore Over HTTP](docs/production-scoped-explore-http.md)
and [Explore And Protect](docs/auto-boundary-and-scoped-explore.md).

## Turn A Useful Question Into Production Access

After an answer proves useful, `/protect` freezes it into a disabled named
read-only capability with generated DSL, canonical JSON, tests, and provenance.
Models cannot invoke Protect or activation. `/details A2 --sql` shows an
operator-only parameterized statement with values redacted.

For existing per-capability integrations only, switch the selected client to
an activated named capability:

```bash
CLIENT=claude-code # or cursor / vscode
synapsor-runner mcp install "$CLIENT" --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

The fixed-tool route uses `synapsor-runner config init --production-explore`
for secured production Read config without secrets.

## Let Agents Propose Bounded Changes

From Ask:

```text
synapsor> /actions
```

Or directly:

```bash
synapsor-runner action review --project-root .
```

Runner ranks schema-proven candidates. The reviewed Action Boundary freezes
exact actions, Read Boundary scope, policies, execution profiles, and shared
limits. Proposal-only `WRITEBACK NONE` is the default; suggestions grant
nothing. The TUI handles rehearsal, activation, and the inbox.

For new actions, activate an Action Rule. The agent then sees one
fixed surface, `app.describe_actions` plus `app.request_change`, even as the
reviewed outcome catalog grows. It sends an outcome and opaque subject
references and, where reviewed, bounded business inputs; Runner privately reloads authoritative facts and derives the only
permitted one-row effect. The model never supplies the patch, raw identity,
trusted scope, approval, or apply command. See the
[Action Rule Engine](docs/action-rule-engine.md).

Active Read and Action Boundaries present four stable tools, not one per query
or action:

```text
app.describe_data
app.explore_data
app.describe_actions
app.request_change
```

Local stdio uses one `synapsor` MCP entry with all four tools. Before Action
activation, Action discovery is empty and change requests are refused. Adding
or revising outcomes does not change the tool list. Read and Action authority
remain independently activatable. Production HTTP retains separate authenticated
Read and Action endpoints with the same four tools across them.

Describe a job or a later policy change in the model-guided `W` conversation.
The model edits disabled components, reads compiler feedback, and asks for missing
business meaning. `/details` shows exact records. Approval and source execution
still require their own reviewed authority. Existing per-capability deployments
remain a compatibility path; mixed Action Rule deployments expose those tools
only with explicit `action_rules.legacy_tools: "enabled"`.

Explicit per-action compatibility remains:

```bash
synapsor-runner start \
  --action plan_credit \
  --description "Propose one reviewed customer plan credit" \
  --based-on support.inspect_customer
```

After activation, the agent can create an exact proposal but cannot approve or
apply it:

```text
Proposal  support.propose_plan_credit on CUS-3001
Effect    plan_credit_cents: 0 -> 2500
Database  unchanged until an outside-model decision
```

Auto-approval does not mean auto-apply: the exact contract digest and deployment both opt into supervised execution.
External notifications are disabled and quiet by default. A webhook response cannot approve or apply.

Immediately before a Runner-managed commit, live scope, evidence freshness,
version, bounds, limits, and idempotency are rechecked. Drift causes no
mutation. See [Supervised Apply](docs/supervised-automatic-apply.md),
[Proposal Freshness](docs/proposal-evidence-freshness.md), and
[Verified Operator Identity](docs/approval-roles-and-operator-identity.md). The
TUI, Workbench, CI, DSL/Spec, stdio, Ask, and HTTP lifecycle is in the
[Safe Action Human Control Plane](docs/safe-action-control-plane.md).

## Audit An Existing MCP Server

Inspect a manifest, remote `tools/list`, or stdio server without invoking its
business tools:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
synapsor-runner audit ./tools-list.json
```

It flags raw SQL, arbitrary identifiers, model-controlled authority, and
model-facing write execution. See [MCP Audit](docs/mcp-audit.md).

## Why Not Raw Text-To-SQL?

Text-to-SQL can produce plausible wrong answers while holding more authority
than a question requires. Runner cannot decide business meaning; it removes
arbitrary SQL authority, limits legal plans, injects trusted scope, and records
what was validated and executed.

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

Read-only views or fixed low-risk operations may suffice when questions and
actions are known in advance. Runner is for open-ended investigations inside a
reviewed boundary, bounded writes, and shared evidence, approvals, retries,
conflicts, receipts, and replay.

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
