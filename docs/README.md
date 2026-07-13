# Synapsor Runner Docs

Start with the README. Use this index when you need the task-specific next
step. The order is intentional: audit the model-facing risk first, run the
no-database demo, wire your database, then read deeper concepts.

## 01 Quickstart

- Audit a deliberately risky database MCP surface without cloning the repo or
  connecting a database:

  ```bash
  npx -y @synapsor/runner audit --example dangerous-db-mcp
  ```

  Then use [MCP Audit](mcp-audit.md) to inspect your own tool manifest, remote
  MCP endpoint, or stdio server. The audit is useful independently of whether
  you adopt Runner.
- [README](../README.md): audit-first proof, no-database demo, safety diagram,
  and the shortest own-database path.
- [Troubleshooting First Run](troubleshooting-first-run.md): common first-run
  failures, redacted diagnostics, and fixes.

## 02 Why Raw SQL Is Dangerous

- [Security Boundary](security-boundary.md): what the model can and cannot see.
- [MCP Audit](mcp-audit.md): static review for risky database MCP tools such as
  `execute_sql`, broad query tools, model-controlled tenant filters, or
  model-facing approval/commit tools.

## 03 Run The Demo

- `examples/support-billing-agent/`: flagship support/billing agent demo with
  `make demo`, expected output, and the raw-SQL-vs-Synapsor contrast.
- `examples/raw-sql-vs-synapsor/`: no-database fear/fix demo.
- `examples/reference-support-billing-app/`: shared fixture used by the
  flagship demo and package smoke tests.

## 04 Connect Your DB

- [Connect Your Own Database](getting-started-own-database.md): inspect a
  staging Postgres/MySQL database, generate `synapsor.runner.json`, preview
  semantic tools, and serve them over MCP.
- [Use Your Own Database](use-your-own-database.md): short entry point that
  links to the canonical own-database guide.
- [Doctor](doctor.md): redacted setup checks, handler probes, direct SQL
  writeback probes, and receipt-table guidance.

## 05 Generate Capabilities

- [Capability Authoring](capability-authoring.md): define read/proposal
  capabilities, model-facing descriptions, result envelopes, trusted context,
  and writeback guards.
- [DSL Reference](dsl-reference.md): complete supported grammar, clause order,
  compiled meaning, and constraints.
- [Runner Config Reference](runner-config-reference.md): every public wiring
  key, default, environment binding, and path-resolution rule.
- [Recipes](recipes.md): starter business-capability templates.
- [JSON Schema](../schemas/synapsor.runner.schema.json): editor validation for
  `synapsor.runner.json`.

## 06 Serve MCP

- [MCP Client Setup](mcp-client-setup.md): connect Claude, Cursor, VS Code, or
  another stdio MCP client.
- [MCP Client Configs](mcp-clients.md): complete Claude, Cursor, OpenAI Agents,
  generic stdio, and Streamable HTTP templates.
- `examples/claude-desktop-postgres/`: copy-paste Claude Desktop config for the
  Postgres billing fixture.
- `examples/cursor-postgres/`: copy-paste Cursor config for the Postgres
  billing fixture.
- [HTTP MCP](http-mcp.md): run Synapsor Runner as an authenticated HTTP MCP
  service for app/server agents.
- [OpenAI Agents SDK](openai-agents-sdk.md): use Streamable HTTP MCP with
  OpenAI-safe tool aliases.

## 07 Propose, Approve, Apply

- [Local Mode](local-mode.md): local store, proposals, approval, replay, and
  writeback flow.
- [Writeback Executors](writeback-executors.md): app-owned writeback handlers
  for approved proposals.
- [App-Owned Executors](app-owned-executors.md): short entry point for rich
  business transactions handled by your app.
- [Handler Helper](handler-helper.md): TypeScript helper for safe app-owned
  rich-write handlers.

## 08 Replay And Audit

- [Result Envelope v2](result-envelope-v2.md): stable
  `ok`/`summary`/`data`/`proposal`/`error` MCP tool results.
- [Store Lifecycle](store-lifecycle.md): active-store leases, prune safety,
  deleted-store behavior, and concurrent server guardrails.
- `synapsor-runner activity search`, `evidence`, `query-audit`, `receipts`,
  `events tail`, and `events webhook`: local evidence, audit, receipt, replay,
  and lifecycle inspection.
- `examples/mysql-refund-agent/`: MySQL order/refund review example using the
  same proposal, approval, guarded writeback, and replay loop.

## 09 App-Owned Handlers

- [Writeback Executors](writeback-executors.md): call direction, endpoint
  contract, receipt shape, and the requirement to re-check tenant/scope,
  expected version, idempotency, and allowed action inside your handler.
- [Handler Helper](handler-helper.md): helper API and examples.

## 10 Concepts

- [Current Scope](current-scope.md): compact v0.1 scope summary.
- [Current Limitations](limitations.md): intentional safety limits.
- [Production-Candidate Guide](production.md): single-node and bounded-fleet
  OSS deployment scope, database roles, receipt grants, restart
  behavior, Docker/systemd shapes, TLS, and release-gate expectations.
- [Running A Small Runner Fleet](running-a-runner-fleet.md): tested two-Runner
  topology, claim-bound sessions, pools, fleet rate limits, quorum, metrics,
  dead letters, backup/restore/retention, and kill/recovery evidence.
- [Cloud Mode](cloud-mode.md): what stays local and what Cloud-linked mode adds.
- [OSS Runner Vs Synapsor Cloud](oss-vs-cloud.md): detailed product and
  operational boundary.
- [Cloud Push](cloud-push.md): register a validated local contract in the
  versioned Cloud registry.
- [Runner Bundles](runner-bundles.md): download the same immutable contract and
  its local MCP wiring from Cloud.
- [Release Notes](release-notes.md): release history and behavior changes.
- [Release Policy](release-policy.md): stable gates and publish verification.
- [Licensing](licensing.md): Apache-2.0 scope, trademark boundary, and what is
  not included in this runner repo.
- [Dependency License Inventory](dependency-license-inventory.md): current
  dependency license summary for release review.
- RFC source context:
  [001 result envelope](rfcs/001-result-envelope-v2.md),
  [002 handler helper](rfcs/002-app-owned-handler-helper.md),
  [003 integrator teardown](rfcs/003-integrator-feedback-teardown.md).

The public docs intentionally stay task-first. Historical implementation
reports, release checklists, and internal planning notes are not part of the
getting-started path.

## Core Terms

- Capability: a reviewed model-facing business tool such as
  `billing.inspect_invoice` or `billing.propose_late_fee_waiver`.
- Proposal: an exact suggested change saved without mutating the source
  database.
- Writeback: execution of an approved proposal outside the model-facing MCP
  surface.
- Executor: Runner's guarded one-row updater or an app-owned handler for richer
  approved business transactions.

## Repository Map

- `apps/runner`: CLI, local review UI, and packaged npm documentation.
- `packages/spec`: canonical contract schemas and conformance fixtures.
- `packages/dsl`: SQL-like contract authoring.
- `packages/mcp-server`: stdio and HTTP MCP runtime.
- `packages/proposal-store`: local evidence, proposal, receipt, and replay
  ledger.
- `packages/postgres`, `packages/mysql`: guarded writeback adapters.
- `examples`: disposable demos and client integrations.
- `docs`: task guides, security boundaries, operations, and release policy.
