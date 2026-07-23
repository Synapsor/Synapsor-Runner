# Current Scope

The canonical scope page is [Current Limitations](limitations.md).

Current `1.6` scope:

- local semantic MCP tools over Postgres/MySQL without raw SQL tools;
- deterministic whole-schema Auto Boundary drafting from database metadata,
  statically parsed Prisma/Drizzle schemas, OpenAPI documents, and existing
  Synapsor definitions;
- disabled generated `.synapsor.sql`, canonical JSON, tests, review evidence,
  and generation locks; no generated authority activates itself;
- local development/staging Scoped Explore through exactly two temporary MCP
  tools, using typed row plans or a reviewed PM-style analytical cube;
- aggregate `count`, reviewed `count_distinct`, `sum`, `avg`, reviewed
  dimensions and day/week/month buckets, typed filters, bounded top-N, and at
  most one proven many-to-one relationship;
- cohort suppression plus durable extraction, differencing, rate, query,
  response, and complexity limits;
- Protect This Query from a successful local plan to public DSL, canonical
  Spec, tests, and a disabled digest-bound named production capability;
- schema, grant, ownership, RLS, role, compiler, and Spec drift checks for
  generated authority explicitly bound to a generation lock;
- trusted context from environment, verified HTTP claims, Cloud sessions, or
  explicit development-only static values;
- evidence handles, normalized query audit, proposals, receipts, local replay,
  and read-only lifecycle inspection without copying proposal ids;
- optional proposal/evidence freshness: live target and declared same-source
  supporting-row checks before every approval, proof-bound human/quorum/policy
  decisions, and atomic direct-SQL dependency revalidation at apply;
- guarded single-row `INSERT`, `UPDATE`, and `DELETE`;
- fixed-predicate set `UPDATE`/`DELETE` and exact-review batch `INSERT`, with
  mandatory row/value caps, frozen members, human approval, atomic execution,
  and protocol-v3 exact receipts;
- opt-in reviewed compensation for supported direct SQL changes, using a
  separate operator proposal and protocol-v4 receipt;
- safety-wrapped app-owned `http_handler` and `command_handler` executors for
  richer approved business transactions;
- stdio MCP, authenticated Streamable HTTP MCP, and a legacy JSON-RPC bridge;
- bounded small-fleet operation with signed claim-bound sessions, shared
  Postgres review state, pools, rate limits, readiness, quorum, dead letters,
  and backup/restore/retention.

Scoped Explore is an authoring-plane feature, not a production runtime feature.
It is disabled by default, requires an explicit development/staging profile and
a demonstrably read-only non-owner role, and is never advertised by production,
unknown-profile, shared HTTP, remote, or non-loopback surfaces. Production uses
only activated named capabilities, including capabilities created through
Protect.

Stable `1.x` compatibility covers the documented `synapsor-runner` binary,
config schema version `1`, canonical public contracts, result envelopes,
stdio/Streamable HTTP, established onboarding and CI routes, proposal/evidence/
replay inspection, guarded writeback, and app-owned executor contracts.
Existing hand-authored projects do not need Auto Boundary, Workbench,
generation locks, schema rescans, or new fields; their tool lists do not change
unless the feature is explicitly adopted.

Out of scope:

- raw `execute_sql`, SQL strings, model-generated SQL, or arbitrary identifiers;
- production Scoped Explore or a general-purpose analytics/query AST;
- general join planning, many-to-many exploration, arbitrary formulas,
  functions, windows, `HAVING`, subqueries, or statistical privacy guarantees;
- model-selected tenant/principal, activation, approval, or commit authority;
- UPSERT, DDL, free-form predicates, unbounded writes, or cross-table direct
  transactions;
- strict atomic freshness for app-owned handlers, APIs, or cross-source
  dependencies; those executors own their transaction preconditions;
- physical branching of external Postgres/MySQL or automatic rollback/time
  travel;
- self-hosted Synapsor Cloud, an unbounded/multi-region shared ledger, a managed
  Runner fleet, production SLA, or compliance certification.
