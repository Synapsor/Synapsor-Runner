# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Let AI agents change real application data without giving the model SQL.**

**MCP connects the agent. Synapsor controls the commit.**

Synapsor Runner is an open-source MCP runtime for Postgres and MySQL. It lets
agents ask bounded business questions of reviewed data and propose exact Data
PRs, while keeping credentials, activation, approval, and commit authority
outside the model-facing surface.

## Prove The Boundary In Four Seconds

No database, Docker, config, MCP client, LLM, or account is required:

```bash
npx -y @synapsor/runner try --prove
```

Cold `npx` download time is excluded. The embedded source requests a $55
waiver and proves:

```text
Proposed effect: late_fee_cents: 5500 -> 0
Source changed before approval: No
Guarded commit: 1 row, receipt recorded
Restart-safe retry: yes; duplicate mutations: 0
Stale apply refused: yes
```

State stays under `./.synapsor/try/`. This proves the boundary, not your
database connection; `demo --quick` remains a noninteractive compatibility alias.

## Audit An Existing MCP Server

Audit a typical raw-SQL MCP server without launching or calling one:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Or audit your own manifest, remote `tools/list`, or stdio server:

```bash
npx -y @synapsor/runner audit ./tools-list.json
```

It flags raw SQL, arbitrary identifiers, model-controlled authority, and
model-facing writeback without calling business tools. See [MCP Audit](docs/mcp-audit.md).

## Connect Your Staging Application

Use a SELECT-only, non-owner development or staging credential. Runner combines
database metadata with statically parsed Prisma, Drizzle, OpenAPI, and existing
Synapsor definitions without executing adopter code, sampling rows, or using an
LLM:

```bash
npx -y @synapsor/runner start
```

Paste the URL into the hidden prompt, approve a regular project `.env` for this
process, or export `DATABASE_URL`. Runner creates a validated zero-authority
project and opens secured localhost Workbench. A personal-development fast lane
offers one conservative resource with sensitive fields, relationships, and
writes off; broader paths require full review.

[Database To First Safe Tool](docs/guided-onboarding.md) covers the complete
path.

## Ask Your First Real Question

For agent analytics without handing a model `execute_sql`, Runner exposes no
SQL-string tool. The model combines only resources, fields, and relationships
in a human-activated boundary; trusted scope, read-only execution, cohort
suppression, and budgets apply to every plan. This is governed analytics, not
a general BI dashboard or SQL surface; derived formulas use reviewed views.

Three host-neutral paths enforce identical authority:

1. **Workbench composer:** no client, model, or key.
2. **Workbench Ask:** your OpenAI/Anthropic key with egress consent, or a
   local-only loopback model; keys/history stay in memory.
3. **Any MCP client:** Cursor, Claude Code/Desktop, VS Code, Codex, OpenAI
   Agents, LangChain/LangGraph, Google ADK, LlamaIndex, or generic stdio.

Project-local installers:

```bash
synapsor-runner mcp install cursor --project --authoring --project-root . --yes
synapsor-runner mcp install claude-code --project --authoring --project-root . --yes
synapsor-runner mcp install vscode --project --authoring --project-root . --yes
```

Installers preserve and back up existing config, pin Runner, and write no
credentials. See [Client Recipes](docs/client-recipes.md).

Authoring exposes two temporary tools:

```text
app.describe_data
app.explore_data
```

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

A human reviews measures, dimensions, time grains, and relationships once. The
agent may combine them with filters, comparisons, and top-N without
per-question review, but cannot exceed the boundary. Review cost scales with
the boundary; usefulness with legal combinations.

```text
REFUSED: subscriptions.customer_id -> customers.id is catalog-proven but not
active in this boundary. Source rows read: 0.
```

Workbench names the boundary and offers operator-only **Review and add this
relationship**; the model cannot activate it. Up to three activated one- or
two-link many-to-one paths are supported; unsafe joins fail closed. Results are
descriptive, not causal. See [Reviewed Relationships](docs/reviewed-relationships.md).

Protect turns a useful analysis into a named, digest-reviewed metric capability.
See [Workbench Ask](docs/workbench-ask.md).

## Protect This Query

Choose a useful result without copying an ID. Runner freezes public DSL,
canonical JSON, and tests under `synapsor/protected/drafts/`; the named
capability starts disabled.

After activation, Scoped Explore is disabled. Update the selected project
client to the production config:

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

Once a human activates that exact action digest, an agent request can create
only a semantic proposal:

```text
Data PR  wrp_...
Action   support.propose_plan_credit on CUS-3001
Effect   plan_credit_cents: 0 -> 2500
Source unchanged before approval: Yes
```

Approval stays outside MCP. A trusted operator or worker rechecks scope,
freshness, policy, version, bounds, idempotency, and affected rows before a
receipt. Runner supports guarded single-row CRUD and bounded reviewed sets;
rich transactions use app-owned executors. Inspect without copying an ID:

```bash
synapsor-runner lifecycle --details --store ./.synapsor/local.db
```

Optional same-database evidence freshness is checked before approval and again
inside direct-SQL apply; drift produces zero mutation:

```bash
synapsor-runner proposals check-freshness latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

See [Proposal Freshness](docs/proposal-evidence-freshness.md) and [Verified
Operator Identity](docs/approval-roles-and-operator-identity.md).

## Safety Model

Contracts fix trusted context, fields, bounds, transitions, and approval.
Model-facing tools can inspect scoped data and propose exact changes, but cannot
approve, apply, or revert. A trusted operator/worker performs guarded writeback;
the ledger links evidence, proposal, decision, receipt, and replay. Runner does
not make raw SQL or prompt-injection-prone clients safe. Compare the boundary
with [prompt and application guardrails](docs/why-synapsor-vs-app-guardrails.md).

## Choose An Isolation Mode

| Mode | Boundary |
| --- | --- |
| Embedded `try` | Synthetic source; proves the lifecycle, not your database. |
| `application_scope` | Shared role plus Runner predicates. A Runner bug or compromised process can cross scope; retain database controls. |
| `postgres_rls` | PostgreSQL also checks transaction-bound tenant/principal scope. Arbitrary trusted-context or credential control remains outside this guarantee. |
| `tenant_bound` | Authenticated context selects a restricted per-tenant credential or process. |

Stdio opens no socket. HTTP requires authentication; remote listeners require
TLS or a trusted TLS proxy, and shared services require signed claims. MySQL has
no native RLS; use restricted views or tenant credentials. See [HTTP MCP] and
[Database scope].

## Review And Prove Your Contract

Use `contract explain`, `contract lint --strict`, and `contract test`; the
language server handles `.synapsor.sql` and legacy `.synapsor`. See [Contract
Review](docs/contract-review.md), [Contract Testing](docs/contract-testing.md),
and the [own-database guide](docs/getting-started-own-database.md).

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)** and [Security
Boundary](docs/security-boundary.md). Conformance and live disposable-database
gates cover scope, hidden fields, no pre-approval mutation, idempotency,
conflicts, bounded sets, freshness, receipts, and replay. Runner does not
replace least-privilege roles, host security, or application authorization.

[Database scope]: docs/database-enforced-scope.md
[HTTP MCP]: docs/http-mcp.md

## Operate The Approval Loop

Auto-approval does not mean auto-apply. Manual apply remains default unless the
exact contract digest and deployment both opt into a trusted supervised worker
that repeats all guards. External notifications are disabled and quiet by default.
A webhook response cannot approve or apply. See [Supervised
Apply](docs/supervised-automatic-apply.md) and
[Notifications](docs/human-attention-notifications.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@synapsor/runner` | CLI, MCP runtime, local ledger, proposals, approval, guarded writeback, replay, and MCP audit. |
| `synapsor-runner` | Optional short command alias that delegates to the exact matching `@synapsor/runner`; no separate runtime. |
| `@synapsor/spec` | Canonical portable contracts for contexts, capabilities, workflows, evidence, proposals, receipts, and replay. |
| `@synapsor/dsl` | SQL-like authoring that compiles contexts, capabilities, and workflow declarations into canonical contract JSON. |
| `@synapsor/cli` | Synapsor Cloud administration, contract governance, human review, Runner connections, and shared audit records. |

Runner, JSON, `.synapsor.sql`, and the optional TypeScript
`@synapsor/runner/authoring` frontend all use the same canonical spec. The
`@synapsor/runner/shadow` helper records app-owned outcomes without granting
write authority. Start with [Capability Authoring](docs/capability-authoring.md)
and the [Runner Config Reference](docs/runner-config-reference.md).

## OSS And Cloud

Runner works alone with local SQLite or an opt-in shared Postgres ledger.
Synapsor Cloud adds shared registry, approval, leased jobs, and redacted
activity/receipt chronology; credentials and guarded execution stay local. See
[Cloud Mode](docs/cloud-mode.md) and [OSS vs Cloud](docs/oss-vs-cloud.md).

`synapsor-runner` owns the local MCP/database boundary. `synapsor` from
`@synapsor/cli` manages Cloud review and audit. Both Cloud push commands use
the same contract digest and scoped service-key API. See the [Cloud CLI
guide](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/cloud-cli.md).

## Next Steps

- Follow the [step-by-step Synapsor Tutorial](https://github.com/sandeshtiwari/Synapsor-Tutorial).
- Run the [`support-billing-agent` flagship example](examples/support-billing-agent).
- Connect [Claude, Cursor, OpenAI Agents SDK, or another MCP client](docs/mcp-clients.md).
- Use the optional local [Workbench Ask](docs/workbench-ask.md) client without
  broadening the reviewed tool surface.
- Author and [push a validated contract to Cloud](docs/cloud-push.md).
- Browse the [task-first documentation index](docs/README.md).
- Report bugs or request features through [GitHub Issues](https://github.com/Synapsor/Synapsor-Runner/issues).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Maintainer and contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md).
