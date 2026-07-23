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

- [Choose The Smallest Safe Database Boundary](alternatives.md): compare raw
  database MCP, direct read-only access, hand-built application tools, and
  Synapsor Runner, including when each is sufficient and what remains outside
  Runner's protection.
- [Security Boundary](security-boundary.md): what the model can and cannot see.
- [Why Synapsor Over Prompt And Application
  Guardrails](why-synapsor-vs-app-guardrails.md): where SQL authority lives,
  what a hand-built semantic tool already gets right, and when the shared
  contract, approval, receipt, and replay layer is worth adopting.
- [MCP Audit](mcp-audit.md): concise static review for risky database MCP tools
  such as `execute_sql`, broad query tools, model-controlled tenant filters, or
  model-facing approval/commit tools, plus explicit generation of disabled
  canonical review candidates.

## 03 Run The Demo

- `examples/support-billing-agent/`: flagship support/billing agent demo with
  `make demo`, expected output, and the raw-SQL-vs-Synapsor contrast.
- `examples/raw-sql-vs-synapsor/`: no-database fear/fix demo.
- `examples/reference-support-billing-app/`: shared fixture used by the
  flagship demo and package smoke tests.

## 04 Connect Your DB

- [Auto Boundary, Scoped Explore, And
  Protect](auto-boundary-and-scoped-explore.md): deterministically inspect a
  whole staging application, review one digest-bound boundary, ask bounded row
  and PM-style aggregate questions in Cursor, and turn a useful query into a
  disabled named production capability.
- [Connect Your Own Database](getting-started-own-database.md): inspect a
  staging Postgres/MySQL database through the new whole-schema path or an
  established one-object/headless route.
- [Use Your Own Database](use-your-own-database.md): short entry point that
  links to the canonical own-database guide.
- [Fresh-Developer Usability Protocol](fresh-developer-usability.md): the
  repeatable five-person launch gate, timing rules, safety blockers, and honest
  reporting template. External participant results are not yet claimed.
- [Doctor](doctor.md): redacted setup checks, handler probes, direct SQL
  writeback probes, and receipt-table guidance.
- [Database-Enforced Scope](database-enforced-scope.md): application-level
  scope, hardened PostgreSQL RLS, tenant-bound credentials/deployments, and
  honest MySQL alternatives.
- [Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md): native
  INSERT/UPDATE/DELETE, receipt modes, crash semantics, privileges, and
  reconciliation.
- [Bounded Set Writeback](bounded-set-writeback.md): fixed-predicate set
  UPDATE/DELETE, exact-review batch INSERT, mandatory caps, atomicity, and
  exact receipts.
- [Reviewed Reversible Change Sets](reversible-change-sets.md): opt-in bounded
  inverse capture and the separate operator proposal/approval/apply flow.

## 05 Generate Capabilities

- [Auto Boundary, Scoped Explore, And
  Protect](auto-boundary-and-scoped-explore.md): generate disabled public DSL
  from deterministic schema/ORM/OpenAPI evidence, then Protect a reviewed
  exploratory plan without giving the model SQL or activation authority.
- [Connect Your Own
  Database](getting-started-own-database.md#draft-another-safe-action-with-a-coding-agent):
  describe one action, let a coding agent complete only the restricted
  TypeScript draft, validate it deterministically, preview an exact staging
  Data PR, and activate the reviewed digest outside MCP.
- [Cursor Plugin](cursor-plugin.md): project-scoped `/synapsor-protect`, Safe
  Action diagnostics, package verification, and the explicit no-activation
  boundary.
- [Reviewed Prisma, Drizzle, And OpenAPI
  Candidates](schema-api-candidates.md): turn structural developer artifacts
  into deterministic, disabled canonical review candidates without executing
  adopter code or inferring authority.
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
- [Contract Review](contract-review.md): LSP setup, plain-language explanation,
  and deterministic lint/SARIF output.
- [Contract Testing](contract-testing.md): adopter-owned static and disposable
  PostgreSQL/MySQL allow/deny/redaction assertions.
- [Agent Effect Regression](effect-regression.md): provider-neutral,
  propose-only fixtures that catch changed capability calls, business diffs,
  policy outcomes, tenant handling, and hidden-field behavior.
- [Bounded Aggregate Reads](aggregate-reads.md): fixed production scalar
  aggregates plus the separate authoring-only reviewed aggregate Explore path.

## 06 Serve MCP

- [Host Compatibility](host-compatibility.md): exact Tested,
  Protocol-tested, Unsupported, and Unknown claims for Cursor and other MCP
  hosts, including the inline-review fallback.
- [Inline Proposal Review With MCP Apps](mcp-apps.md): display-only proposal
  cards where supported, exact protocol versions, tested compatibility, and
  secure standalone review fallback.
- [MCP Client Setup](mcp-client-setup.md): connect Claude, Cursor, VS Code, or
  another stdio MCP client.
- [MCP Client Configs](mcp-clients.md): complete Claude, Cursor, OpenAI Agents,
  generic stdio, and Streamable HTTP templates.
- [Client And Framework Recipes](client-recipes.md): one proposal-only
  support-plan-credit flow for Claude Code, Codex, VS Code, OpenAI Agents,
  LangChain/LangGraph, Google ADK, LlamaIndex, and generic MCP clients, with
  explicit evidence labels.
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
- [Shadow Studies](shadow-studies.md): compare what an agent would propose
  with explicit authorized outcomes before granting write authority.
- [Writeback Executors](writeback-executors.md): app-owned writeback handlers
  for approved proposals.
- [App-Owned Executors](app-owned-executors.md): short entry point for rich
  business transactions handled by your app.
- [Handler Helper](handler-helper.md): TypeScript helper for safe app-owned
  rich-write handlers.

## 08 Replay And Audit

- [Result Envelope v2](result-envelope-v2.md): stable
  `ok`/`summary`/`data`/`proposal`/`error` MCP tool results.
- [Result Envelope v3](result-envelope-v3.md): frozen-set jobs and receipts
  with every bounded member identity and safe digest.
- [Compensation Protocol v4](result-envelope-v4.md): reviewed inverse
  descriptors, compensation proposals/jobs/receipts, lineage, and
  reconciliation semantics.
- [Store Lifecycle](store-lifecycle.md): active-store leases, prune safety,
  deleted-store behavior, and concurrent server guardrails.
- `synapsor-runner activity search`, `evidence`, `query-audit`, `receipts`,
  `events tail`, and `events webhook`: local evidence, audit, receipt, replay,
  and lifecycle inspection.
- `examples/mysql-refund-agent/`: MySQL order/refund review example using the
  same proposal, approval, guarded writeback, and replay loop.
- [Scoped Ledger Reports](compliance-reports.md): object/principal JSON,
  Markdown, and PDF exports with digest/signature verification.
- [Graduated Trust](graduated-trust.md): off-by-default operator
  recommendations that never auto-activate a policy.

## 09 App-Owned Handlers

- [Writeback Executors](writeback-executors.md): call direction, endpoint
  contract, receipt shape, and the requirement to re-check tenant/scope,
  expected version, idempotency, and allowed action inside your handler.
- [Handler Helper](handler-helper.md): helper API and examples.

## 10 Concepts

- [Current Scope](current-scope.md): compact current 1.x scope summary.
- [Current Limitations](limitations.md): intentional safety limits.
- [Production-Candidate Guide](production.md): single-node and bounded-fleet
  OSS deployment scope, database roles, receipt grants, restart
  behavior, Docker/systemd shapes, TLS, and release-gate expectations.
- [Running A Small Runner Fleet](running-a-runner-fleet.md): tested two-Runner
  topology, claim-bound sessions, pools, fleet rate limits, quorum, metrics,
  dead letters, backup/restore/retention, and kill/recovery evidence.
- [Cloud Mode](cloud-mode.md): what stays local and what Cloud-linked mode adds.
- [Synapsor Cloud CLI](cloud-cli.md): command, credential, entitlement, and Cloud-linked authority reference.
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
  [003 integrator teardown](rfcs/003-integrator-feedback-teardown.md),
  [004 guarded CRUD and receipt authority](rfcs/004-guarded-crud-receipt-authority.md),
  [005 bounded set writeback](rfcs/005-bounded-set-writeback.md), and
  [006 reviewed reversible change sets](rfcs/006-reviewed-reversible-change-sets.md).

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
- Executor: Runner's guarded one-row/bounded-set database adapter or an
  app-owned handler for richer approved business transactions.

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
