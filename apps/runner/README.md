# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Let AI agents query and update Postgres/MySQL without giving the model raw
SQL, unrestricted schema access, or database credentials.**

**MCP connects the agent. Synapsor enforces the reviewed database boundary.**

Synapsor Runner is an open-source safety layer for database agents. A human
reviews the tables, fields, relationships, operations, and limits once; the
agent can then ask new questions or propose bounded changes without exceeding
that access. Credentials, trusted tenant scope, activation, approval, and
commit stay outside the model surface.

Why not give the model `execute_sql`? A published
[ReFoRCE](https://arxiv.org/abs/2502.00675) pipeline reports about 11% execution
accuracy on the enterprise-scale [BEAVER benchmark](https://arxiv.org/abs/2409.02038).
In [EntSQL](https://arxiv.org/abs/2606.03363), 54.6% of 982 observed failures
were wrong filters that can return plausible numbers. These benchmark-specific
figures are not a Runner accuracy claim. Runner cannot supply business meaning;
it removes SQL authority, injects trusted scope, and records what ran.

Start with the problem you are solving: [safe Postgres MCP](docs/safe-postgres-mcp.md),
[prevent arbitrary LLM SQL](docs/prevent-llm-arbitrary-sql.md), or
[human approval for agent writes](docs/human-approval-ai-database-writes.md).

## Start With Your Database

Use a SELECT-only, non-owner development or staging credential:

```bash
npx -y @synapsor/runner start
```

Paste the URL into the hidden prompt or export `DATABASE_URL`. Runner reads
metadata, not rows, creates a zero-authority project, and opens secured localhost
Workbench. You write no DSL or JSON; Runner generates reviewable artifacts.

For a terminal-only journey, use the same flow with `--cli`:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL --cli
```

Accept the conservative read-only boundary, then ask. Use `M` to change the
model and `E` to edit access. Nothing reaches a provider before egress consent;
access changes stay disabled until human confirmation.

See [Database To First Safe Tool](docs/guided-onboarding.md).

## Prove The Boundary In Four Seconds

Want to see the write boundary first? No database, Docker, config, client, LLM,
or account is required:

```bash
npx -y @synapsor/runner try --prove
```

The embedded fixture proves:

```text
Proposed effect: late_fee_cents: 5500 -> 0
Source changed before approval: No
Guarded commit: 1 row, receipt recorded
Restart-safe retry: yes; duplicate mutations: 0
Stale apply refused: yes
```

State stays under `./.synapsor/try/`. This proves the boundary, not a live
connection; `demo --quick` remains a noninteractive compatibility alias.

## Audit An Existing MCP Server

Already have MCP tools? Audit a typical raw-SQL surface without launching or
calling it:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Or audit your own manifest, remote `tools/list`, or stdio server:

```bash
npx -y @synapsor/runner audit ./tools-list.json
```

It flags raw SQL, arbitrary identifiers, model-controlled authority, and
model-facing writeback without calling business tools. See [MCP
Audit](docs/mcp-audit.md).

## Keep Your Existing Service Layer

If your application already exposes narrow, authenticated business operations,
keep them.

Runner adds reviewed capabilities, trusted context, proposals, outside-model
decisions, evidence, receipts, and replay. It executes bounded reads and guarded
writes directly; multi-step transactions or external effects use an app-owned
executor. See [Application Guardrails](docs/why-synapsor-vs-app-guardrails.md).

## Ask Your First Real Question

Runner gives agents no `execute_sql` tool. A reviewed boundary limits tables,
fields, and relationships; scope, suppression, and budgets apply to every
read-only plan. This is governed analytics, not BI; derived formulas use
reviewed views.

Four host-neutral paths enforce identical authority:

1. **Workbench Ask:** your OpenAI/Anthropic key with egress consent, or a
   local-only loopback model; keys/history stay in memory.
2. **Existing MCP client:** Cursor, Claude Code/Desktop, VS Code, Codex, OpenAI
   Agents, LangChain/LangGraph, Google ADK, LlamaIndex, or generic stdio.
3. **CLI Ask:** the same provider loop and MCP tools from a terminal.
4. **Workbench composer:** an optional no-model exact-plan fallback.

```bash
synapsor-runner try ask \
  --provider openai \
  --model gpt-5-mini
```

Credentials use environment or hidden input, never arguments. Ask supports
follow-ups, `/analyses`, and `/protect`; Runner results stay separate from prose.

```bash
synapsor-runner mcp install cursor --project --authoring --project-root . --yes
synapsor-runner mcp install claude-code --project --authoring --project-root . --yes
synapsor-runner mcp install vscode --project --authoring --project-root . --yes
```

Installers back up config, pin Runner, and omit credentials. See
[Client Recipes](docs/client-recipes.md).

Authoring exposes two temporary tools:

```text
app.describe_data
app.explore_data
```

`app.describe_data` catalogs active boundaries; each plan uses one. Cross-boundary
joins/unions are unavailable and budgets stay shared.

```text
Question:
Which reviewed regions and reason categories contributed most to the increase
in churned accounts by week?

Result:
counted_entity: churned_account
week        region  reason         churned_accounts
2026-07-06  west    price          42
2026-07-06  south   missing_value  31
suppression: 1 group and its labels withheld (minimum cohort: 5)
```

A human reviews measures, dimensions, time grains, and relationships once; the
agent combines but cannot exceed them. Ranked questions may inspect a separately
reviewed candidate population while returning at most 25 groups. Runner
withholds small cohorts before ranking and refuses incomplete populations.

```text
REFUSED: subscriptions.customer_id -> customers.id is catalog-proven but not
active in this boundary. Source rows read: 0.
```

Workbench offers operator-only **Review and add this relationship**; the model
cannot activate it. One- or two-link many-to-one paths are bounded; unsafe
joins fail closed. See [Reviewed Relationships](docs/reviewed-relationships.md).

Tools expose safe schemas, never SQL, scope values, or kept-out fields. Protect
promotes one analysis into a named reviewed capability. See [Workbench
Ask](docs/workbench-ask.md).

## Protect This Query

Choose a result without copying an ID. Runner freezes public DSL, canonical
JSON, and tests under `synapsor/protected/drafts/`; it starts disabled.

In the shell, `/protect` previews generated authority, then asks for a separate
human activation gesture. Enter activates only that digest and returns to Ask;
no browser or typed hash is required. Workbench offers the same exact-digest,
stale-safe review through **Activate this reviewed capability**.

`/details` shows the typed request, normalized plan, scope, suppression, budgets,
and execution metadata. `/details A2 --sql` adds operator-only parameterized SQL
with values redacted; it never reaches the model, MCP, or ordinary evidence.

When the selected analysis is ready for production, activate its exact digest
and switch the selected project client to the production config. This disables
temporary Scoped Explore without removing the protected named capability:

```bash
CLIENT=claude-code # or cursor / vscode
synapsor-runner mcp install "$CLIENT" --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

Production exposes the activated named capability, never `app.explore_data`.
See [Explore And Protect](docs/auto-boundary-and-scoped-explore.md).

## Create An Exact Data PR

For a write, describe one business action. This creates an inert TypeScript
draft; it does not add a tool or change the active contract:

```bash
synapsor-runner start \
  --action plan_credit \
  --description "Propose one reviewed customer plan credit" \
  --based-on support.inspect_customer
```

After exact-digest activation, an agent can create only a semantic proposal:

```text
Data PR  wrp_...
Action   support.propose_plan_credit on CUS-3001
Effect   plan_credit_cents: 0 -> 2500
Source unchanged before approval: Yes
```

### Review Policies, Not Every Routine Action

Approval stays outside MCP, but need not be manual for every routine action.
Teams review a capability and policy once; bounded requests may be policy-approved
and separately enabled workers repeat every guard. Exceptions wait for a person.

Auto-approval does not mean auto-apply: the exact contract digest and deployment both opt into
supervised execution. External notifications are disabled and quiet by default.
A webhook response cannot approve or apply.
See [Supervised Apply](docs/supervised-automatic-apply.md).

Immediately before a Runner-managed commit, live scope, evidence freshness,
version, bounds, limits, and idempotency are rechecked. Drift produces no
mutation. Inspect the linked lifecycle without copying an ID:

```bash
synapsor-runner lifecycle --details --store ./.synapsor/local.db
```

See [Proposal Freshness](docs/proposal-evidence-freshness.md) and [Verified
Operator Identity](docs/approval-roles-and-operator-identity.md).

## Safety Model

Contracts fix context, fields, bounds, transitions, and approval. Tools inspect
scoped data and propose changes, but cannot approve, apply, or revert. A trusted
operator/worker writes guarded effects; the ledger links evidence through
replay. Runner does not make raw-SQL clients safe. Compare [application
guardrails](docs/why-synapsor-vs-app-guardrails.md).

Choose `application_scope`, PostgreSQL RLS, or tenant-bound credentials based
on your threat model; Runner does not replace database permissions. Stdio opens
no socket. Network MCP requires authenticated, encrypted transport and verified
session context. See [Database Scope](docs/database-enforced-scope.md) and
[HTTP MCP](docs/http-mcp.md).

## You May Not Need Runner

A dedicated read-only account or one or two fixed low-risk application
operations may already be enough. Runner becomes useful when multiple agents or
tools need one governed boundary, proposal/policy decisions outside the model,
evidence and receipts, safe retries, conflict handling, or replay. Keep your
existing database and application controls either way.

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)** and [Security
Boundary](docs/security-boundary.md). Conformance and live disposable-database
gates cover scope, hidden fields, no pre-approval mutation, idempotency,
conflicts, bounded sets, freshness, receipts, and replay. Runner does not
replace least-privilege roles, host security, or application authorization.

Runner works alone with local SQLite or an opt-in shared Postgres ledger.
Synapsor Cloud adds shared registry, approval, leased jobs, and redacted
activity chronology; credentials and guarded execution stay local. Browse
[Capability Authoring](docs/capability-authoring.md), [OSS vs
Cloud](docs/oss-vs-cloud.md), or the [documentation index](docs/README.md).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md).
