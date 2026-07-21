# Synapsor Runner

[![npm version](https://img.shields.io/npm/v/@synapsor/runner.svg)](https://www.npmjs.com/package/@synapsor/runner)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Synapsor/Synapsor-Runner/actions/workflows/ci.yml?query=branch%3Amain)

**Let AI agents change real application data without giving the model SQL.**

**MCP connects the agent. Synapsor controls the commit.**

Synapsor Runner is an open-source MCP runtime for Postgres and MySQL. It gives
agents reviewed business actions, records proposed changes as exact Data PRs,
and keeps credentials, activation, approval, and commit authority outside the
model-facing surface.

## Prove The Boundary In Four Seconds

No database, Docker, config, MCP client, LLM, or account is required:

```bash
npx -y @synapsor/runner try --prove
```

The four-second product measurement begins after package resolution. A cold
`npx` download is recorded separately because registry and network time vary.

The embedded synthetic source requests a $55 waiver and proves:

```text
Proposed effect: late_fee_cents: 5500 -> 0
Source changed before approval: No
Guarded commit: 1 row, receipt recorded
Restart-safe retry: yes; duplicate mutations: 0
Stale apply refused: yes
```

Review happens outside the model-facing tools. The command stores inspectable
state under `./.synapsor/try/`; it teaches the boundary and does not claim to
test your database connection. `demo --quick` remains a noninteractive compatibility alias.

## Protect One Action In Your Application

Start with a staging database and a read-only credential. Runner inspects
metadata, creates one reviewed read boundary, and opens the secured localhost
Workbench:

```bash
npm install -g @synapsor/runner
export DATABASE_URL="postgresql://runner_reader:REPLACE_ME@db.example.com:5432/app?sslmode=require"
synapsor-runner start --from-env DATABASE_URL --schema public
```

Describe one business action. This creates an inert TypeScript draft; it does
not add a tool or change the active contract:

```bash
synapsor-runner start \
  --action plan_credit \
  --description "Propose one reviewed customer plan credit" \
  --based-on support.inspect_customer
```

Add the reviewed tools to the current Cursor project:

```bash
synapsor-runner mcp install cursor --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

In Cursor, use the Workbench's exact prompt. The checked-in project
instructions require the coding agent to draft and validate the action while
leaving effect review and activation to you. Once activated, a request such as
"give CUS-3001 a $25 plan credit" can only create a semantic proposal:

```text
Data PR  wrp_...
Action   support.propose_plan_credit on CUS-3001
Effect   plan_credit_cents: 0 -> 2500
Source unchanged before approval: Yes
```

Review the exact effect in the secured Workbench, select **Approve outside
MCP**, then run the displayed guarded apply command from a trusted terminal.
The agent has no approval or commit tool. Runner rechecks scope, policy, row
version, bounds, and idempotency before returning a receipt; a retry cannot
duplicate the mutation and a stale proposal conflicts.

See the [own-database guide](docs/getting-started-own-database.md) for the full
staging path and [Cursor plugin guide](docs/cursor-plugin.md) for
`/synapsor-protect` and the plugin boundary.

## Audit An Existing MCP Server

Audit a typical raw-SQL MCP server without launching or calling one:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Audit your own tool manifest, remote `tools/list`, or stdio server:

```bash
npx -y @synapsor/runner audit ./tools-list.json
```

It flags raw SQL, arbitrary identifiers, model-controlled authority,
model-facing approval/writeback, and missing conflict or idempotency signals.
It does not call business tools. See [MCP Database Risk
Review](docs/mcp-audit.md) for local manifests, selected-server checks, CI,
SARIF, evidence labels, and limits. You may not need Runner: use the
[alternatives guide](docs/alternatives.md) to compare direct read-only access,
hand-built tools, and this reviewed boundary.

## Safety Model

```text
AI agent or MCP client
        |
        | reviewed semantic tool
        v
+--------------------------------+
| Synapsor Runner MCP            |
| trusted tenant/principal scope |
| evidence + query audit         |
| proposals, not direct writes   |
+--------------------------------+
        |
        | scoped read / approved guarded writeback
        v
+--------------------------------+
| Your Postgres or MySQL         |
| source of truth                |
+--------------------------------+

Local SQLite ledger:
evidence -> proposal -> approval -> receipt -> replay
```

The model can inspect scoped data and propose an exact change. It cannot call
approval, apply, or revert tools. A human or trusted operator approves outside
MCP, then Runner performs a guarded write or routes the proposal to an
app-owned executor.

Contracts fix trusted context, fields, bounds, transitions, and approvals;
evidence, query audit, receipts, and replay preserve the lifecycle. Runner does
not make raw SQL or prompt-injection-prone clients safe.

## Choose An Isolation Mode

| Mode | Boundary |
| --- | --- |
| Embedded `try` | Synthetic source; proves the lifecycle, not your database. |
| `application_scope` | Shared role plus Runner predicates. A Runner bug or compromised process can cross scope; retain database controls. |
| `postgres_rls` | PostgreSQL also checks transaction-bound tenant/principal scope. Arbitrary trusted-context or credential control remains outside this guarantee. |
| `tenant_bound` | Authenticated context selects a restricted per-tenant credential or process. |

Stdio commonly trusts process environment; shared HTTP must use verified signed
claims. Model arguments, query parameters, and arbitrary tenant headers are
never trusted. MySQL has no native RLS; use restricted views or tenant
credentials. See [Database scope] and the
[build-vs-adopt guide](docs/why-synapsor-vs-app-guardrails.md).

## Connect A Staging Database

The setup above stores environment-variable names, not connection strings, and
never falls back to synthetic data if inspection fails. Keep staging, database
permissions, restricted views, and RLS underneath Runner. Bind trusted tenant
and principal values in the launching process, then review the exact field and
tool surface before connecting Cursor.

The [complete own-database guide](docs/getting-started-own-database.md) covers
validation, scoped reads, disabled Prisma/Drizzle/OpenAPI candidates, guarded
single-row writes, and app-owned executors. Use the [host compatibility
matrix](docs/host-compatibility.md) for accurately tested client behavior.

## Review And Prove Your Contract

Before serving, use `contract explain`, `contract lint --strict`, and `contract
test` for reviewer-readable boundaries and allow/deny/redaction cases. The
built-in language server supplies diagnostics, completion, hover, and formatting for
`.synapsor.sql` and legacy `.synapsor` files. See [Contract
Review](docs/contract-review.md) and [Contract
Testing](docs/contract-testing.md).

Runner also supports reviewed [aggregate reads](docs/aggregate-reads.md),
tenant-scoped tamper-evident [ledger reports](docs/compliance-reports.md), and
opt-in [graduated-trust recommendations](docs/graduated-trust.md). Aggregate
tools return one scalar and no source rows. Graduated trust is disabled by
default, remains operator-only, and can export a reviewable artifact but never
activate it.

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)**. It defines protected assets,
trust boundaries, covered threats, non-goals, and required operator controls.

- [Conformance fixtures](docs/conformance.md) prove trusted context, scoped
  reads, kept-out fields, proposal boundaries, approval, receipts, and replay
  behavior rather than only validating JSON shape.
- `contract test` lets adopters encode the same boundary checks for their own
  synthetic fixtures; it never invokes an LLM and refuses remote live targets
  by default.
- MCP proposal, evidence, and replay handles are references rather than bearer
  authority: resource reads re-check the owning tenant and principal against
  the current trusted session.
- `test:principal-scope`, `test:live-apply`, `test:guarded-crud`,
  `test:bounded-set`, and `test:reversible` prove cross-principal denial,
  no pre-approval mutation, guarded writes, idempotent retry, conflicts,
  bounded atomic sets, receipts, and reviewed compensation on disposable
  PostgreSQL/MySQL fixtures.

Runner is a narrow agent/database safety boundary, not a replacement for
least-privilege database access, host security, or application authorization.
See [Security Boundary](docs/security-boundary.md) and
[Current Limitations](docs/limitations.md).

[Database scope]: docs/database-enforced-scope.md

## Operate The Approval Loop

Policies can combine per-proposal and aggregate ceilings; exceeding one routes
to human review. Local SQLite is the default, while bounded fleets can use
verified HTTP claims and a shared Postgres runtime store. See
[Production](docs/production.md), [Runner Config](docs/runner-config-reference.md),
and [Small Runner Fleets](docs/running-a-runner-fleet.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@synapsor/runner` | CLI, MCP runtime, local ledger, proposals, approval, guarded writeback, replay, and MCP audit. |
| `@synapsor/spec` | Canonical portable contracts for contexts, capabilities, workflows, evidence, proposals, receipts, and replay. |
| `@synapsor/dsl` | SQL-like authoring that compiles contexts, capabilities, and workflow declarations into canonical contract JSON. |
| `@synapsor/cli` | Synapsor Cloud administration, contract governance, human review, Runner connections, and shared audit records. |

Runner, JSON, `.synapsor.sql`, and the optional TypeScript
`@synapsor/runner/authoring` frontend all use the same canonical spec. The
`@synapsor/runner/shadow` helper records app-owned outcomes without granting
write authority. Start with [Capability Authoring](docs/capability-authoring.md)
and the [Runner Config Reference](docs/runner-config-reference.md).

## OSS And Cloud

Synapsor Runner works by itself for local, single-node, and bounded small-fleet
deployments: your database remains the source of truth and Runner stores review
artifacts in the default local SQLite ledger or an opt-in shared Postgres
runtime store.
Synapsor Cloud adds a shared contract registry, immutable versions,
source-scoped Runner connections, downloadable bundles, a human approval
inbox, durable leased writeback jobs, and a redacted shared activity/receipt
chronology. Database credentials and guarded execution remain local. See [Cloud
Mode](docs/cloud-mode.md) for the design-partner path and [OSS Runner vs
Synapsor Cloud](docs/oss-vs-cloud.md) for the detailed boundary.

`synapsor-runner` owns the local MCP/database boundary. `synapsor` from
`@synapsor/cli` manages Cloud review and audit. Both Cloud push commands use
the same contract digest and scoped service-key API. See the [Cloud CLI
guide](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/cloud-cli.md).

## Next Steps

- Follow the [step-by-step Synapsor Tutorial](https://github.com/sandeshtiwari/Synapsor-Tutorial).
- Run the [`support-billing-agent` flagship example](examples/support-billing-agent).
- Connect [Claude, Cursor, OpenAI Agents SDK, or another MCP client](docs/mcp-clients.md).
- Author and [push a validated contract to Cloud](docs/cloud-push.md).
- Browse the [task-first documentation index](docs/README.md).
- Report bugs or request features through [GitHub Issues](https://github.com/Synapsor/Synapsor-Runner/issues).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Maintainer and contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md).
