# Current Scope

The canonical scope page is [Current Limitations](limitations.md).

Current `1.6.4` scope:

- local semantic MCP tools over Postgres/MySQL without raw SQL tools;
- one-command, resumable, review-by-exception onboarding from
  `DATABASE_URL` to a real safe read, bounded exploration, protected named
  tools, guided write proposals, and host-neutral MCP client setup;
- deterministic whole-schema Auto Boundary drafting from database metadata,
  statically parsed Prisma/Drizzle schemas, OpenAPI documents, and existing
  Synapsor definitions;
- disabled generated `.synapsor.sql`, canonical JSON, tests, review evidence,
  and generation locks; no generated authority activates itself;
- local development/staging Scoped Explore through exactly two temporary MCP
  tools, using typed row plans or a reviewed PM-style analytical cube;
- optional secured-loopback Workbench Ask over the exact same active tool
  registry, with OpenAI, Anthropic, or a configured OpenAI-compatible endpoint,
  digest-bound direct-egress consent, in-memory credentials/history, bounded
  provider loops, and proposal-only writes;
- aggregate `count`, reviewed `count_distinct`, `sum`, `avg`, reviewed
  dimensions and day/week/month buckets, typed filters, bounded top-N, and at
  most three activated star/depth-two relationship paths, each containing one
  or two proven many-to-one links with fan-out one;
- demand-driven operator review for an exact inactive catalog-proven path,
  explicit nullable-link semantics, per-relation trusted scope, and fail-closed
  rejection of one-to-many, many-to-many, stale, or ambiguous paths;
- cohort suppression plus durable extraction, differencing, rate, query,
  response, and complexity limits;
- Protect This Query from a successful local plan to public DSL, canonical
  Spec, tests, and a disabled digest-bound named production capability;
- schema, grant, ownership, RLS, role, compiler, and Spec drift checks for
  generated authority explicitly bound to a generation lock;
- trusted context from environment, verified HTTP claims, Cloud sessions, or
  explicit development-only static values;
- verified operator decisions through signed local keys or external OIDC/JWKS
  identity, with exact contract-role matching, token-time/issuer/audience
  checks, immutable decision evidence, key rotation, and independent approval
  and apply authority;
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
- default-off operator-supervised automatic apply for exact-digest,
  contract-permitted single-row INSERT/UPDATE capabilities, with an independent
  deployment allowlist, fenced worker leases, policy/limit/freshness/source
  revalidation, hardened writer-posture checks, and explicit UNKNOWN
  reconciliation;
- durable redacted proposal/worker/boundary/policy attention events, a
  coalesced no-ID Workbench inbox, quiet per-sink routing and digests, JSONL
  development output, signed generic HTTPS webhooks, and an optional
  exact-capability supervision-sink health gate;
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
- production/shared/remote Ask, model-selected provider configuration,
  Synapsor-relayed model calls, persisted chat history, or a claim that every
  OpenAI-compatible server is supported;
- general join planning, many-to-many exploration, arbitrary formulas,
  functions, windows, `HAVING`, subqueries, or statistical privacy guarantees;
- model-selected tenant/principal, activation, approval, or commit authority;
- automatic worker execution for DELETE, reversible changes, set writes,
  app-owned/external effects, or capabilities without deterministic
  single-row conflict/deduplication and receipt guarantees;
- UPSERT, DDL, free-form predicates, unbounded writes, or cross-table direct
  transactions;
- strict atomic freshness for app-owned handlers, APIs, or cross-source
  dependencies; those executors own their transaction preconditions;
- physical branching of external Postgres/MySQL or automatic rollback/time
  travel;
- self-hosted Synapsor Cloud, an unbounded/multi-region shared ledger, a managed
  Runner fleet, production SLA, or compliance certification.
