# Limitations

Synapsor Runner is intentionally narrow. Version 1.6 adds deterministic
whole-application boundary drafting and a local authoring-only Explore ->
Protect path on top of guarded writes. It does not turn Runner into a generic
database query tool, claim Synapsor Cloud scale, or claim an enterprise SLA.

## Supported

- Stdio MCP server for semantic database capabilities.
- Local read and proposal tools.
- Local SQLite evidence/proposal/query-audit/replay store by default.
- Optional shared Postgres proposal/evidence/replay runtime store for MCP serving.
- Asymmetric claim-bound Streamable HTTP sessions and explicit readiness.
- Native Postgres/MySQL source pools and operational/fleet-wide rate limits.
- Verified operator approval through CLI, optional distinct-reviewer quorum,
  and shared local review UI reads.
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
- Reviewed PM-style aggregate Explore with `count`, `count_distinct`, `sum`,
  `avg`, categorical dimensions, fixed time buckets, typed filters, bounded
  top-N, optional one-hop proven many-to-one relationships, cohort suppression,
  and durable extraction/differencing budgets.
- Protect This Query to public DSL, canonical JSON, tests, and a disabled named
  capability that survives Explore shutdown after exact-digest activation.
- Generation-lock drift detection for generated authority. Manually authored
  projects without a lock retain their previous behavior.
- Local indexed search for proposals, evidence bundles, query audit, writeback
  receipts, and proposal replay.
- DSL enum arguments and fixed, tenant-scoped aggregate count/sum/avg tools
  with mandatory minimum-group suppression and no source-row output.
- Contract LSP, explanation, deterministic lint, adopter-owned contract tests,
  and scoped tamper-evident JSON/Markdown/PDF ledger reports.
- Off-by-default graduated-trust recommendations that require verified operator
  review and explicit artifact export without activation.

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
- Physical branching of Postgres/MySQL.
- Full Synapsor workflow/DAG execution.
- `CREATE AGENT WORKFLOW` or hosted Synapsor SQL generation.
- Auto-merge or settlement policy semantics.
- Automatic rollback, database time travel, or model-facing revert.
- Inferred compensation for app-owned handlers or external effects.
- General restoration of hard-deleted rows, cascades, or trigger side effects.
- Model-callable approval or commit tools.
- Generic MCP firewall behavior.
- Prompt-injection prevention.
- Unbounded/high-throughput or multi-region ledger scale.
- Managed fleet, SLA, compliance certification, or production support guarantee.
- Production, shared HTTP, remote, or non-loopback Scoped Explore.
- Arbitrary aggregate expressions, dynamic identifiers, unrestricted joins,
  many-to-many joins, formulas, window functions, subqueries, `HAVING`,
  user-defined functions, or a statistical privacy guarantee. Version 1.6
  supports only the explicitly reviewed authoring cube described above and
  fixed protected named capabilities produced from it.
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

Only homogeneous 1.x fleet operation is claimed for protocol-v4 compensation
jobs. Mixed-minor v3/v4 rolling compensation is not claimed.
See [Running A Small Runner
Fleet](running-a-runner-fleet.md).

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
