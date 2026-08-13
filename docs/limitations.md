# Limitations

Synapsor Runner is intentionally narrow. It combines deterministic
whole-application boundary drafting, local repeated Explore with optional
Protect, explicit production HTTP Explore under a stricter identity/privacy
posture,
guarded writes, opt-in proposal/evidence freshness, verified operator identity,
default-off supervised execution, and quiet human-attention delivery. Reviewed
aggregate paths are limited to proven star/depth-two many-to-one relationships,
not a general join planner. Optional local Workbench Ask is a client of the
existing reviewed tools; the complete no-model path remains the default.
Runner does not become a generic database query tool, Synapsor Cloud, or an
enterprise SLA.

## Supported

- Stdio MCP server for semantic database capabilities.
- Local read and proposal tools.
- Local SQLite evidence/proposal/query-audit/replay store by default.
- Optional shared Postgres proposal/evidence/replay runtime store for MCP serving.
- Asymmetric claim-bound Streamable HTTP sessions and explicit readiness.
- Native Postgres/MySQL source pools and operational/fleet-wide rate limits.
- Verified operator approval through CLI or the secured local Workbench,
  optional distinct-reviewer quorum, separate apply authority, and
  proposal-centered lifecycle inspection.
- Optional live target and explicitly declared supporting-row freshness checks
  before every approval, with immutable proof binding and final transactional
  revalidation for PostgreSQL/MySQL direct SQL writeback.
- Separately protected scrapeable metrics and dead-letter recovery commands.
- Shared-ledger backup/digest verification, clean restore, and
  archive-before-retention.
- Public protocol objects:
  - `synapsor.change-set.v1`
  - `synapsor.writeback-job.v1`
  - `synapsor.execution-receipt.v1`
  - backward-compatible operation-aware v2 change sets, jobs, and receipts
  - bounded-set v3 change sets, jobs, and receipts
  - compensation change sets and protocol-v4 jobs/receipts with bounded inverse
    descriptors
  - `synapsor.runner-registration.v1`
- Guarded single-row `INSERT`, `UPDATE`, and `DELETE` for Postgres and MySQL.
- Fixed-predicate set `UPDATE`/`DELETE` and exact-review batch `INSERT` with
  mandatory row/value caps, a hard 100-row ceiling, human approval, frozen
  members, atomic apply, and exact receipts.
- Opt-in reviewed compensation for direct SQL UPDATE, INSERT, soft-delete, and
  exact frozen sets. Revert is a new operator proposal with independent
  approval and a fresh conflict guard.
- Atomic source receipts with precreated or auto-migrated tables, or
  zero-source-schema Runner-ledger receipts with explicit reconciliation.
- App/API handler writeback through approved `http_handler` executors.
- Local script writeback through approved `command_handler` executors.
- Primary-key guard.
- Tenant guard.
- Allowed-column validation.
- Exact version-column conflict guards, plus an explicit legacy
  `CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED` escape hatch for ordinary
  single-row source-DB UPDATE only.
- Idempotency receipts.
- Named local trusted contexts for capability configs.
- Capability recipes that generate reviewed starter configs.
- Shadow-mode proposal-vs-human-action comparison.
- Static MCP database risk review.
- Deterministic whole-schema Auto Boundary drafting from database metadata,
  statically parsed Prisma/Drizzle schema artifacts, OpenAPI documents, and
  existing Synapsor definitions. Generated authority starts disabled.
- Local development/staging Scoped Explore through exactly
  `app.describe_data` and `app.explore_data`, with no SQL-string argument.
  Up to eight independently reviewed active boundaries support repeated legal
  combinations without per-question review or creation of named authority.
  Each plan selects one boundary; overlapping resources require its name and
  cross-boundary joins/unions are unavailable. Session privacy budgets remain
  shared across boundary changes.
- Explicit production Scoped Explore through the same exact two read-only
  tools over secured shared Streamable HTTP. It requires a separately reviewed
  production boundary, mandatory verified tenant/principal JWT claims,
  per-principal and tenant privacy/rate ceilings, and atomic shared-Postgres
  accounting. It remains unavailable through static-token, anonymous,
  cleartext, legacy JSON-RPC, and model-controlled activation paths.
- Optional development/staging loopback Workbench Ask through OpenAI,
  Anthropic, or a configured OpenAI-compatible endpoint. Provider calls use the
  exact active MCP/runtime surface, explicit direct-egress consent, in-memory
  credential/history state, fixed tool/time/size/token bounds, and
  proposal-only write behavior.
- CLI `try ask` through the same provider/MCP engine. It accepts no command-line
  key, opens a bounded conversational shell when no question is supplied,
  labels model prose as untrusted, renders Runner-verified results
  independently, and keeps expiring analysis references out of routine output.
  `/protect` remains an operator command and never becomes a model tool.
- Reviewed bounded aggregate Explore with `count`, `count_distinct`, `sum`,
  `avg`, categorical dimensions, fixed UTC time buckets, typed filters,
  bounded top/bottom-N over a separately reviewed candidate population,
  Runner-resolved fixed relative UTC windows, signed absolute/percentage movers
  from an exact or relative two-range comparison, up to
  three reviewed relationship paths of at most two proven
  many-to-one links each, cohort suppression, and durable
  extraction/differencing budgets.
- Relative windows in Runner 1.7.0 require reviewed UTC authority. Arbitrary
  IANA business timezones and DST-aware relative calendar semantics are not yet
  supported; use exact ISO ranges where UTC is not the intended authority.
- Demand-driven operator review for an exact catalog-proven relationship,
  including an explicit missing-row choice for nullable links. The model cannot
  activate a relationship, and every participating relation receives trusted
  tenant/principal scope.
- Protect This Query to public DSL, canonical JSON, tests, and a disabled named
  capability that survives Explore shutdown after exact-digest activation.
  Explore never protects automatically; only one operator-selected unexpired
  analysis is promoted.
- Structured MCP analytical output schemas and a safe digest-pinned analytical
  catalog that omit SQL, trusted-scope values/columns, kept-out fields,
  credentials, and generation-lock internals.
- Generation-lock drift detection for generated authority. Manually authored
  projects without a lock retain their previous behavior.
- Local indexed search for proposals, evidence bundles, query audit, writeback
  receipts, and proposal replay.
- DSL enum arguments and fixed, tenant-scoped aggregate count/sum/avg tools
  with a mandatory reviewed minimum-group threshold and no source-row output.
  Runner-generated authority defaults to suppression at 5; an explicitly
  reviewed threshold of 1 permits groups of one.
- Contract LSP, explanation, deterministic lint, adopter-owned contract tests,
  and scoped tamper-evident JSON/Markdown/PDF ledger reports.
- Off-by-default graduated-trust recommendations that require verified operator
  review and explicit artifact export without activation.
- Default-off operator-supervised apply for eligible exact-row direct
  `INSERT`/`UPDATE`, requiring both public contract permission and an
  independent deployment allowlist for the exact active digest. It reuses
  guarded apply and preserves legacy `AUTO APPROVE` as manual-apply.
- Durable redacted human-attention events, a coalesced Workbench inbox,
  no-ID CLI inspection, optional JSONL output, and signed generic HTTPS
  webhooks with quiet routing, budgets, digests, and safe delivery replay.

## Runtime Contract

Local capabilities are config-defined, not built into the server. The runtime
does not special-case billing, support, orders, refunds, invoices, or tickets.
Those domains appear only in demos, smoke tests, and optional recipe JSON files.
When you connect your own database, `synapsor.runner.json` is the source of
truth for the model-facing tools.

## Not Supported

- Arbitrary SQL.
- Model-generated SQL.
- DDL.
- UPSERT.
- Model-generated/free-form set predicates or dynamic identifiers.
- Unbounded set writes or more than 100 reviewed members.
- Policy auto-approval for bounded sets.
- Stored procedures.
- Cross-database transactions.
- Strict atomic proposal freshness across databases, app-owned handlers, or
  external APIs. Those paths must enforce their own final preconditions.
- Physical branching of Postgres/MySQL.
- Full Synapsor workflow/DAG execution.
- `CREATE AGENT WORKFLOW` or hosted Synapsor SQL generation.
- Auto-merge or settlement policy semantics.
- Automatic rollback, database time travel, or model-facing revert.
- Inferred compensation for app-owned handlers or external effects.
- General restoration of hard-deleted rows, cascades, or trigger side effects.
- Model-callable approval or commit tools.
- Model-callable worker, notification-routing, acknowledgement, recovery, or
  reconciliation controls.
- Generic MCP firewall behavior.
- Prompt-injection prevention.
- Unbounded/high-throughput or multi-region ledger scale.
- Managed fleet, SLA, compliance certification, or production support guarantee.
- Production Scoped Explore without its explicit production boundary, verified
  principal, per-principal and tenant budgets, shared atomic accounting, rate
  limits, OAuth/JWT checks, and secured HTTP transport attestation.
- Production, shared HTTP, remote, or non-loopback Workbench Ask; model-facing
  provider configuration; Synapsor-relayed provider traffic; durable chat
  history; automatic provider retries; exact monetary spend enforcement; or
  universal compatibility with OpenAI-compatible servers.
- Automatic supervised execution for hard DELETE, reversible changes, bounded
  sets, app-owned/external effects, or writes without deterministic conflict,
  deduplication, freshness, and receipt authority.
- Arbitrary aggregate expressions, dynamic identifiers, unrestricted joins,
  many-to-many joins, model-authored formulas or window functions, subqueries, `HAVING`,
  user-defined functions, or a statistical privacy guarantee. Runner supports
  only the explicitly reviewed authoring cube described above. Named running,
  lag, rank, moving-average, and share operations run after suppression and do
  not accept SQL or window definitions from the model.
- PostgreSQL older than 13 or newer than 18, MySQL older than 5.7 or newer than
  major 8, MariaDB, and unrecognized MySQL-compatible products. MySQL 5.7 is supported only through its explicit
  limited grammar tier; technical compatibility does not imply current vendor
  security support. See [Database Server Compatibility](database-server-compatibility.md).
- Automatic policy widening or activation from graduated-trust metrics.
- Immutable/WORM compliance storage from the local report exporter.

## Important External Database Semantics

External Postgres/MySQL databases are not branched or merged by Synapsor Runner.

The proposal, evidence, replay, and approval state live in Synapsor Runner locally or in Synapsor Cloud. The external source database changes only when a trusted runner applies an approved writeback job.

Local replay means replay of records captured by the runner:

- trusted context values used by the capability;
- captured/projected source-row excerpts;
- query audit fingerprints and redacted parameter metadata;
- proposal before/proposed diffs;
- approval/rejection events;
- guarded writeback jobs;
- applied/conflict/failed receipts.

It does not mean external Postgres/MySQL time travel. Runner cannot reconstruct
arbitrary historical rows that were never captured as evidence, and it does not
provide `AS OF` queries over an external source.

Local search uses SQLite by default. In `runtime_store` mode, CLI/UI reads can
inspect one bounded shared Postgres ledger across a small fleet. This is still
not a hosted central evidence service, organization RBAC/SSO, compliance
retention system, or unbounded search engine. Each bridge operation serializes
through an advisory lock and fails above configured `max_entries`.
Production Explore does not route its high-volume query evidence through that
bridge: it uses a dedicated append-only metadata sink with seven-day retention,
so analytics traffic cannot consume proposal/writeback ledger capacity.

Only homogeneous 1.x fleet operation is claimed for protocol-v4 compensation
jobs. Mixed-minor v3/v4 rolling compensation is not claimed.
See [Running A Small Runner
Fleet](running-a-runner-fleet.md).

Workbench Ask token accounting uses provider-reported usage. A provider that
omits or misreports usage cannot provide exact token or monetary enforcement.
Runner still enforces request/response, tool-result, iteration, history, and
wall-clock bounds. A provider outage does not disable the no-model composer or
external MCP path. See [Workbench Ask With Your Model](workbench-ask.md).

Use this wording:

```text
External DB = Synapsor review state + trusted writeback
Synapsor-native = real branch + merge
```

Do not describe external approval as merge.

## Weak Conflict Guards

A version/timestamp column is the preferred conflict guard. UPDATE authoring
fails if no guard is declared. A weak row-hash guard can be selected only with
the reviewer-visible `CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED` clause for a
narrow ordinary single-row source-DB UPDATE. It hashes the captured projection,
may miss concurrent changes outside that projection, and must not be presented
as equivalent to a durable version column.

Runner-ledger UPDATE and DELETE require an exact guard; UPDATE must advance it
inside the source transaction. INSERT requires a reviewed source-unique dedup
identity. See [Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md).

Approval-time freshness also depends on a correct exact version column. It
does not freeze source state until apply. Direct SQL apply rechecks again;
app-owned/cross-source effects do not receive that Runner-owned atomic
guarantee. See
[Proposal And Evidence Freshness](proposal-evidence-freshness.md).
