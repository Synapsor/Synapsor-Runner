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

Timing begins after package resolution; cold `npx` download time varies.

The embedded synthetic source requests a $55 waiver and proves:

```text
Proposed effect: late_fee_cents: 5500 -> 0
Source changed before approval: No
Guarded commit: 1 row, receipt recorded
Restart-safe retry: yes; duplicate mutations: 0
Stale apply refused: yes
```

Review happens outside model-facing tools. State is stored under
`./.synapsor/try/`; this proves the boundary, not your database connection.
`demo --quick` remains a noninteractive compatibility alias.

## Audit An Existing MCP Server

Audit a typical raw-SQL MCP server without launching or calling one:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Audit your own tool manifest, remote `tools/list`, or stdio server:

```bash
npx -y @synapsor/runner audit ./tools-list.json
```

It flags raw SQL, arbitrary identifiers, model-controlled authority, and
model-facing writeback without calling business tools. See [MCP Database Risk
Review](docs/mcp-audit.md) and the [alternatives
guide](docs/alternatives.md).

## Connect Your Staging Application

Use a dedicated SELECT-only, non-owner staging credential. Runner combines the
whole database schema with statically parsed Prisma, Drizzle, OpenAPI, and
existing Synapsor definitions. It does not execute adopter code, sample source
rows, or use an LLM:

```bash
npm install -g @synapsor/runner
export DATABASE_URL="postgresql://runner_reader:REPLACE_ME@db.example.com:5432/app?sslmode=require"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="developer-1"
synapsor-runner start --from-env DATABASE_URL --schema public
```

A fresh project opens the secured localhost Workbench and emits disabled DSL,
canonical JSON, tests, review evidence, and a generation lock. Review scope,
fields, aggregate members, relationships, privacy budgets, profile, and exact
role/RLS posture, then activate the exact digest. Existing tools stay unchanged.

## Ask Your First Real Question In Cursor

After activation, let Runner add only the local authoring entry to this Cursor
project:

```bash
synapsor-runner mcp install cursor \
  --project \
  --authoring \
  --project-root . \
  --yes
```

Cursor sees exactly two temporary tools:

```text
app.describe_data
app.explore_data
```

Ask a bounded question such as:

```text
Which reviewed regions and reason categories contributed most to the increase
in churned accounts by week?
```

Runner accepts a typed plan, not SQL. It validates every member against the
activated digest, injects trusted scope, and runs a read-only transaction.
Small cohorts are suppressed and durable budgets limit repeated differencing.
This is descriptive analysis, not proof of causation.

Scoped Explore is local authoring only. Missing/unknown/production profiles,
write-capable or owner credentials, stale generation locks, remote/shared HTTP,
and non-loopback runtimes never advertise these tools.

## Protect This Query

Choose the useful result in Workbench. No opaque ID needs to be copied. Runner
freezes the reviewed shape into public DSL, canonical JSON, and tests under
`synapsor/protected/drafts/`. The named capability starts disabled and requires
exact-digest human activation outside MCP.

After activation, Scoped Explore is disabled. Update Cursor to the production
config:

```bash
synapsor-runner mcp install cursor \
  --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

Production exposes the protected named capability, not `app.explore_data`.
Read the complete [Auto Boundary, Scoped Explore, And Protect
guide](docs/auto-boundary-and-scoped-explore.md).

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

Approve in Workbench outside MCP; a trusted operator or worker commits. Runner
supports guarded single-row INSERT/UPDATE/DELETE, fixed-predicate bounded
UPDATE/DELETE, and exact-review batch INSERT. Rich transactions and external
effects use app-owned executors.

Runner rechecks scope, policy, row version, bounds, idempotency, and affected
rows before returning a receipt. A retry cannot duplicate the mutation and a
stale proposal conflicts. Inspect the latest lifecycle without copying an ID:

```bash
synapsor-runner lifecycle --details --store ./.synapsor/local.db
```

For proposals whose review depends on other source rows, Runner 1.6.1 can also
require a live target/supporting-evidence check immediately before every local
approval. Apply rechecks those declared same-database dependencies again inside
the write transaction; stale evidence produces zero mutation and requires a new
proposal:

```bash
synapsor-runner proposals check-freshness latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

See the [own-database guide](docs/getting-started-own-database.md),
[Cursor plugin guide](docs/cursor-plugin.md), and
[proposal freshness](docs/proposal-evidence-freshness.md) and
[store lifecycle](docs/store-lifecycle.md) guides for the complete paths.

## Safety Model

Contracts fix trusted context, fields, bounds, transitions, and approval.
Model-facing tools can inspect scoped data and propose exact changes, but cannot
approve, apply, or revert. A trusted operator/worker performs guarded writeback;
the ledger links evidence, proposal, decision, receipt, and replay. Runner does
not make raw SQL or prompt-injection-prone clients safe.

## Choose An Isolation Mode

| Mode | Boundary |
| --- | --- |
| Embedded `try` | Synthetic source; proves the lifecycle, not your database. |
| `application_scope` | Shared role plus Runner predicates. A Runner bug or compromised process can cross scope; retain database controls. |
| `postgres_rls` | PostgreSQL also checks transaction-bound tenant/principal scope. Arbitrary trusted-context or credential control remains outside this guarantee. |
| `tenant_bound` | Authenticated context selects a restricted per-tenant credential or process. |

Use stdio; no socket opens. HTTP requires authentication; non-loopback
listeners require TLS or an explicit trusted TLS proxy. Shared services require
signed claims. Model-controlled input and MCP session IDs never establish
identity. See [HTTP MCP].
MySQL has no native RLS; use restricted views or tenant credentials. See
[Database scope] and the
[build-vs-adopt guide](docs/why-synapsor-vs-app-guardrails.md).

## Review And Prove Your Contract

Use `contract explain`, `contract lint --strict`, and `contract test`; the
language server handles `.synapsor.sql` and legacy `.synapsor`. See [Contract
Review](docs/contract-review.md), [Contract Testing](docs/contract-testing.md),
and the [own-database guide](docs/getting-started-own-database.md).

## Trust And Verification

Start with the **[Threat Model](THREAT_MODEL.md)**. It defines protected assets,
trust boundaries, covered threats, non-goals, and required operator controls.

[Conformance fixtures](docs/conformance.md) and `contract test` cover trusted
scope, kept-out fields, proposals, approval, receipts, and replay. Resource
handles re-check tenant/principal rather than acting as bearer authority. Live
gates cover principal denial, no pre-approval mutation, idempotency, conflict,
bounded sets, compensation, and proposal/evidence freshness on disposable
databases.

Runner is a narrow agent/database safety boundary, not a replacement for
least-privilege database access, host security, or application authorization.
See [Security Boundary](docs/security-boundary.md) and
[Current Limitations](docs/limitations.md).

[Database scope]: docs/database-enforced-scope.md
[HTTP MCP]: docs/http-mcp.md

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
- Author and [push a validated contract to Cloud](docs/cloud-push.md).
- Browse the [task-first documentation index](docs/README.md).
- Report bugs or request features through [GitHub Issues](https://github.com/Synapsor/Synapsor-Runner/issues).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`). See
[Licensing](docs/licensing.md) and [Trademarks](TRADEMARKS.md). Synapsor Cloud
and proprietary Synapsor platform components are outside this repository.

Maintainer and contributor workflows live in [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md).
