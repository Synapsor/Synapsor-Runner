# Changelog

## 1.6.1 (prepared, not published)

### Fail-closed proposal and evidence freshness

- Adds optional reviewed `proposal_freshness` Runner configuration for live
  target and explicitly declared same-source supporting-row checks immediately
  before every local approval.
- Binds every successful human, quorum, or policy approval to a distinct
  immutable short-lived proof covering the exact proposal hash/version and
  deterministic dependency-set digest. Stale or unavailable checks record no
  approval; stale proposals are replaced rather than silently refreshed.
- Extends PostgreSQL/MySQL direct SQL apply to lock supporting rows in
  deterministic order and compare their exact versions inside the existing
  mutation transaction. Post-approval drift returns a clear conflict with zero
  mutation, including bounded-set rollback.
- Adds no-ID `proposals check-freshness latest` text/JSON inspection, Workbench
  status and approval gating, lifecycle/replay/proof linkage, bounded
  compliance metadata, counters, structured logs, and rollback-only writer
  lock diagnostics.
- Keeps Cloud source-blind: Cloud may govern proposal/approval authority, while
  the local Runner performs final source revalidation. Strict freshness is
  rejected for app-owned and cross-source effects whose checks cannot be
  transactionally atomic.
- Preserves existing contract normalization/digests, DSL, tools lists,
  approval paths, receipts, and deployments when the optional overlay is
  absent. `@synapsor/spec` and `@synapsor/dsl` remain at 1.5.0.
- Prepares only `@synapsor/runner@1.6.1`. Nothing is published, tagged, pushed,
  or released by this change.

## 1.6.0 (published 2026-07-23)

### Connect, Explore, Protect

- Adds deterministic whole-schema Auto Boundary drafting from database
  metadata, statically parsed Prisma/Drizzle schemas, OpenAPI documents, and
  existing Synapsor definitions. It executes no adopter code, samples no source
  rows before activation, uses no LLM, and emits only disabled public DSL,
  canonical JSON, tests, review evidence, and a generation lock.
- Adds a secured local Workbench review for trusted tenant/principal scope,
  visible and kept-out fields, typed filters, aggregate-safe measures,
  `count_distinct`, reviewed dimensions and time buckets, one-hop
  relationships, cohort suppression, privacy/query budgets, and exact
  role/grant/RLS posture. Activation binds every decision to one immutable
  digest.
- Adds authoring-only Scoped Explore through exactly `app.describe_data` and
  `app.explore_data`. Row and PM-style aggregate plans contain no SQL or
  arbitrary identifiers, run with verified read-only credentials and enforced
  read-only transactions, and retain only normalized redacted audit metadata.
- Adds a deliberately small aggregate grammar for counts, reviewed distinct
  identifiers, sums/averages, categorical dimensions, day/week/month buckets,
  bounded comparisons and top-N, optional proven many-to-one relationships,
  cohort suppression, and durable extraction/differencing/rate budgets.
- Adds Protect This Query. Workbench freezes a successful plan into public
  `.synapsor.sql`, canonical `protected_read` authority, positive/deny/scope/
  suppression/drift tests, and a disabled named capability. Human exact-digest
  activation removes broad Explore while preserving the named production tool.
- Adds lock-bound schema/role/grant/ownership/RLS/compiler/Spec drift checks.
  Additive schema fields receive no authority; breaking generated-authority
  drift fails closed until regeneration and review.
- Preserves published 1.x contracts, exact legacy normalization/digests,
  established CLI selectors and automation, active tools, TypeScript authoring,
  manual/headless operation, guarded writes, Data PRs, app-owned executors, and
  deployments without generation locks through packed compatibility fixtures.
- Published `@synapsor/runner@1.6.0`, `@synapsor/dsl@1.5.0`, and
  `@synapsor/spec@1.5.0`.

## 1.5.4 (published 2026-07-22)

### Networked MCP authentication hardening

- Defines explicit local-loopback, remote single-tenant, and shared multi-tenant
  HTTP security profiles while preserving zero-configuration local stdio.
- Refuses non-loopback cleartext listeners before bind unless the operator
  explicitly selects a trusted TLS proxy or authenticated break-glass posture.
  Runner-owned TLS and optional mTLS remain supported.
- Hardens opaque endpoint tokens with environment-only provisioning, production
  entropy checks, constant-time comparison, one bounded previous-token rotation
  slot, and per-session credential pinning. Opaque tokens remain service access
  credentials, not tenant or user identity.
- Requires verified signed identity for shared deployments. Runner validates
  algorithm, signature, issuer, audience/resource, time, scope, tenant, and
  principal on every request, including requests for existing MCP sessions.
- Adds RFC 9728 protected-resource metadata and standards-correct Bearer
  challenges for external authorization servers. Runner remains a protected
  resource and does not issue passwords, access tokens, or refresh tokens.
- Adds exact Origin and Host policy, bounded headers/bodies/connections/sessions,
  TLS preflight, bounded public-only JWKS handling, and safe overload responses.
- Expands `doctor`, help, client generators, fleet examples, and deployment docs
  so operators can distinguish TLS, Bearer presentation, opaque tokens, JWTs,
  MCP session IDs, trusted context, database scope, and operator authority
  without printing credential values.
- Adds read-only, no-ID-first `lifecycle` inspection across local SQLite and
  shared PostgreSQL runtime stores. Latest, filtered business-object lookup, and
  proposal/evidence/replay/job/intent/receipt/audit handles resolve one typed,
  redacted proposal-to-receipt/replay timeline without creating jobs, leases,
  source calls, or Cloud synchronization.
- Makes UPDATE conflict guarding exact by default in the SQL-like DSL.
  Omitting `CONFLICT GUARD <column>` now fails. The explicit legacy
  `CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED` form is limited to ordinary
  single-row source-DB UPDATE and warns that projection hashing can miss outside
  changes.
- Preserves canonical `SESSION` for implementations with a real typed session
  boundary while making Runner fail closed with
  `SESSION_BINDING_UNSUPPORTED`. Runner-targeted DSL validation, contract load,
  lint/explain, and runtime no longer allow an environment fallback.
- Published `@synapsor/runner@1.5.4` and `@synapsor/dsl@1.4.4`;
  `@synapsor/spec@1.4.2` and the Cloud CLI remain unchanged.

## 1.5.3 (published 2026-07-21)

### Intent to Safe Action

- Adds one code-first Safe Action Composer from a reviewed read boundary to a
  restricted TypeScript draft, canonical contract, plain-language explanation,
  and deterministic allow/deny/effect tests. Runner statically parses the file
  and never imports or executes adopter code while deciding authority.
- Keeps every generated action disabled until a human reviews a real staging
  Data PR in the secured Workbench and explicitly activates the complete
  digest. Editing, validating, or watching a draft cannot change active MCP
  tools; proposals remain pinned to their active contract digest.
- Adds current Cursor project/plugin packaging, `/synapsor-protect`, live Safe
  Action diagnostics, owned install/uninstall, and an honest host matrix.
  Activation, approval, apply, credentials, and trusted identity stay outside
  the model-facing surface.
- Extends MCP audit with evidence-labeled authority maps, explicitly consented
  selected-server bypass checks, text/JSON/Markdown/SARIF output, fixtures, and
  a non-mutating GitHub Actions workflow.
- Adds a checked-in Safe Action CI workflow plus verified proposal-only recipes
  for Claude Code, Codex, VS Code, OpenAI Agents, LangChain/LangGraph, Google
  ADK, LlamaIndex, and generic MCP clients.
- Reframes the README and website around one existing-application Data PR,
  publishes an honest alternatives guide, and adds a deterministic 36-second
  support-plan-credit cut backed by real PostgreSQL proposal, receipt, retry,
  and stale-conflict evidence.
- Published only `@synapsor/runner@1.5.3`; `@synapsor/spec@1.4.2`,
  `@synapsor/dsl@1.4.3`, and the Cloud CLI remain unchanged.

## 1.5.2 (prepared, not published)

### First safe action in an existing application

- Establishes one canonical path from an existing application and staging
  Postgres/MySQL database to a reviewed semantic action, scoped evidence, exact
  proposal/Data PR, external human review, guarded apply, receipt, and replay.
  Own-data failures stop honestly and never fall back to synthetic data.
- Generates a canonical contract and local Runner wiring from read-only schema
  inspection while detecting Prisma, Drizzle, OpenAPI, known database
  environment names, and existing Synapsor files without executing adopter
  code. The happy path requires no hand-written JSON or DSL.
- Adds a focused localhost workbench for Project, Data source, Trust scope,
  Action, Agent, Test, and Review. Configuration validation alone no longer
  marks Test complete; a scoped read must create query-audit evidence first.
- Adds safe project-scoped Cursor install, status, and uninstall with preview,
  merge, backup, ownership/integrity checks, exact-version launch, and
  preservation of unrelated MCP entries. Approval, apply, revert, credentials,
  and trusted identity remain outside the model-facing MCP surface.
- Adds local-only activation reports for proof, own-data onboarding, Cursor,
  first read, and first proposal. Product timing explicitly excludes initial
  package download; separately reported cold `npx` timing is environment-
  specific. No activation telemetry or business identifiers are transmitted.
- Adds optional `@synapsor/runner/authoring` and
  `@synapsor/runner/shadow` exports. TypeScript authoring emits the same
  canonical public contract, while shadow progression and provider-neutral
  effect regression remain non-activating and label deterministic versus
  external-model evidence.
- Connects MCP audit candidates directly to the secured workbench and keeps
  audit prominent in the README and docs. Adds an explicit host-compatibility
  matrix and a packaged support/billing first-action reference workflow.
- Corrects the supported runtime floor to Node 22.13.0, where `node:sqlite` is
  available without an experimental flag, and fails earlier runtimes before
  loading the Runner bundle.
- Prepares only `@synapsor/runner@1.5.2`; `@synapsor/spec@1.4.2`,
  `@synapsor/dsl@1.4.3`, and the Cloud CLI remain unchanged.

## 1.5.1 (prepared, not published)

### Safe ownership for disposable try state

- Stops `try` from recursively deleting a caller-provided `--state-dir`.
  Custom paths are now unowned containers; Runner writes into a marked managed
  child and removes only its known direct state files.
- Rejects filesystem roots, home/cwd/repository paths and their ancestors,
  parent traversal, symlinked path components, unmarked lookalike directories,
  and managed files replaced by links. Unrelated caller files are preserved.
- Adds an atomic per-state lease. Concurrent runs fail clearly, while a valid
  lease left by a dead process can recover without broad cleanup.
- Keeps `demo inspect --state-dir` aligned with the managed-child layout and
  safely adopts only the known legacy default `.synapsor/try` file set.
- Hardens explicit `--force` replacement for generated schema and MCP-audit
  candidate directories against protected paths, symlinked ancestors, and
  linked or invalid ownership markers.
- Consistently identifies the embedded `try` source as synthetic.
- Updates the packaged YAML parser to `2.8.3`, which includes the upstream
  deeply nested collection denial-of-service fix.
- Corrects the repository's stale publication wording for the live `1.5.0`
  release. Only `@synapsor/runner` is staged at `1.5.1`; Spec, DSL, and Cloud
  CLI versions remain unchanged.

## 1.5.0 (2026-07-20)

### Complete guarded-action developer proof

- Adds `synapsor-runner try` as a no-account, no-database, no-Docker proof of
  scoped evidence, an exact business-data proposal, external approval, guarded
  commit, restart-safe retry, stale-state refusal, receipt, and non-mutating
  replay. `try --prove` also verifies changed-intent collision rejection.
- Adds explicit `application_scope`, `postgres_rls`, and `tenant_bound`
  assurance modes. PostgreSQL hardened mode binds tenant/principal
  transaction-locally, checks RLS and role prerequisites, and fails closed
  rather than silently downgrading.
- Productizes strict local shadow studies, authoritative human-outcome
  comparison, deterministic readiness reports, and effect-level JSON/JUnit
  regression fixtures without activating policy or mutating source data.
- Adds a standard display-only MCP App proposal resource with exact effect,
  evidence, scope, policy, and review-state presentation. Approval and apply
  remain absent from MCP, with terminal and standalone local-UI fallbacks.
- Extends static MCP risk audit into disabled review candidates, and adds
  review-only Prisma, Drizzle, and OpenAPI generators that emit canonical
  contracts without importing or executing adopter code.
- Promotes `examples/support-billing-agent` as a disposable PostgreSQL/RLS
  proof covering tenant and principal scope, kept-out fields, exact $55
  proposal, approval/apply, idempotent retry, stale conflict, replay, strict
  shadow, human comparison, and effect regression.
- Keeps app-owned handler writers least-privileged when their receipt table is
  pre-provisioned: the helper checks for the table before attempting DDL, and
  the live source and packed examples verify transactional apply and retry.
- Rewrites the README around the complete `try --prove` outcome, keeps MCP
  audit immediately second, names each isolation boundary precisely, and
  reconciles release documentation with the live npm registry.
- Published only `@synapsor/runner@1.5.0`; `@synapsor/spec@1.4.2`,
  `@synapsor/dsl@1.4.3`, and `@synapsor/cli@0.1.0-beta.1` remain unchanged.

## 1.4.123 (2026-07-17)

### Advisory capability-surface fitness lint

- Adds deterministic `contract lint` advisories for generic query-like string
  arguments, more than eight capabilities on one normalized target,
  non-business-operation names, and structurally near-duplicate capabilities.
- Keeps canonical validation, compilation, MCP serving, and runtime enforcement
  unchanged. Advisories succeed by default; explicit `--strict` or
  `--fail-on warning` remains the opt-in CI policy gate.
- Adds stable structured details and surface metrics to JSON/SARIF output, plus
  a concise text summary. No database connection, environment value, source
  row, or probabilistic classifier is involved.
- Published only `@synapsor/runner@1.4.123`; `@synapsor/spec@1.4.2`,
  `@synapsor/dsl@1.4.3`, and `@synapsor/cli@0.1.0-beta.1` are unchanged.

## 1.4.122 (2026-07-17)

### Trusted principal row scope and Cloud-linked governance

- Adds a canonical reviewer-fixed principal row scope that is always
  AND-composed with tenant scope and resolved only from a required trusted
  context binding. Missing or invalid principal authority fails closed.
- Enforces the bound principal predicate in PostgreSQL and MySQL reads,
  proposals, aggregates, guarded CRUD, bounded sets, executor envelopes,
  receipts, replay, and reviewed compensation. Same-tenant cross-principal
  access uses the same generic miss as cross-tenant or absent rows.
- Preserves the scope through DSL parse/format/compile, Spec validation and
  digesting, config normalization, protocol jobs, C++/Cloud round trips,
  contract explanation/testing, and scoped evidence/proposal/resource handles.
- Adds explicit `local_only` and `cloud_linked` authority behavior. Cloud-linked
  proposals use a durable idempotent outbox, metadata-only evidence residency,
  Cloud-governed approval/leasing, terminal-state reconciliation, and no local
  approval/apply fallback while Cloud is unavailable.
- Separates contract-registry human/service credentials from Runner machine
  tokens. Cloud push no longer accepts secrets through command arguments or a
  Runner-token fallback.
- Introduces the separately packable `@synapsor/cli@0.1.0-beta.1` Cloud client;
  `synapsor-runner` remains the local MCP/database enforcement boundary.
- Published `@synapsor/spec@1.4.2`, `@synapsor/dsl@1.4.3`, and
  `@synapsor/runner@1.4.122`.

## 1.4.121 (2026-07-15)

### Contract trust surface and bounded-set parser correctness

- Fixes BUG-018: `SELECT WHERE risk_level = 'high' AND case_status =
  'active'` now compiles into two ordered canonical equality terms instead of
  silently folding the second term into the first string value.
- Uses a quote-aware, full-clause parser. `AND` inside a quoted literal remains
  literal content, while malformed terms, trailing tokens, `OR`, parentheses,
  and non-equality operators fail during DSL compilation with location-aware
  errors.
- Preserves existing single-term contracts and literal types. The canonical
  Spec bump in this release is limited to the additive enum and aggregate-read
  fields described below.
- Adds standalone DSL and bundled Runner parity coverage plus PostgreSQL/MySQL
  live proof under source-database and Runner-ledger receipt authority. The
  proof excludes first-term-only, second-term-only, and wrong-tenant rows and
  verifies exact receipt/replay membership.
- Adds a real stdio contract language server plus canonical `contract explain`
  and deterministic text/JSON/SARIF lint for review before serving.
- Adds adopter-owned static/live contract tests with a public manifest schema,
  generic operator-boundary checks, and disposable PostgreSQL/MySQL coverage.
- Adds tenant-scoped object/principal ledger reports in JSON, Markdown, and PDF
  with redaction, canonical digests, optional operator signatures, and tamper
  verification.
- Adds typed DSL enums and canonical fixed aggregate reads for COUNT/SUM/AVG.
  Aggregate tools use trusted tenant scope, fixed equality selection, mandatory
  minimum-group suppression, one scalar result, and evidence/query audit with
  no member rows or IDs.
- Adds disabled-by-default graduated-trust recommendations. Evaluation uses
  scoped human-reviewed outcomes, excludes auto-approval as independent
  evidence, requires verified operator review, and exports a separate
  digest-bound contract artifact without activating it.
- Proves additive Spec/DSL/Runner/C++ aggregate and enum parity, shared Postgres
  recommendation durability, and transient PostgreSQL/MySQL timeout
  classification.
- Published `@synapsor/spec@1.4.1`, `@synapsor/dsl@1.4.2`, and
  `@synapsor/runner@1.4.121`.

## 1.4.12 (2026-07-14)

### Runtime-store smoke-call consistency

- Fixes BUG-017: `smoke call` now lets the MCP runtime resolve storage from the
  complete config instead of injecting a local SQLite `ProposalStore`.
- In `runtime_store` mode, proposal, evidence, query-audit, event, and replay
  records land in the authoritative shared Postgres ledger and are visible to
  other Runner processes and normal approve/apply commands.
- Shared-ledger failures return a redacted, retryable availability result with
  a nonzero CLI status and never create a local fallback proposal.
- Keeps local SQLite and mirror modes unchanged. The source database still
  remains untouched until external approval and guarded apply.
- Adds focused no-fallback coverage and a disposable two-process fleet proof
  covering ownership, approval/apply, one source receipt, replay, and safe
  ledger unavailability.
- Published only `@synapsor/runner@1.4.12`; `@synapsor/dsl` remains `1.4.1`
  and `@synapsor/spec` remains `1.4.0`.

## 1.4.1 (2026-07-14)

### Canonical Bounded-Set Digest Verification

- Fixes contract-authored bounded-set proposals that could fail unchanged
  apply with `SET_DIGEST_MISMATCH` after protocol parsing reordered aggregate
  object fields.
- Uses recursive canonical JSON key ordering for new member and set digests,
  while narrowly accepting the deterministic raw representations emitted by
  `1.4.0` so valid stored proposals remain applyable.
- Keeps every frozen member, expected version, reviewed value, aggregate,
  tenant guard, and atomic source check intact; malformed digests and genuine
  source drift still fail closed.
- Adds PostgreSQL/MySQL regression coverage for the exact DSL-to-contract path
  under source-database and Runner-ledger receipt authority, plus independent
  version, predicate, aggregate, writable-value, missing-member, and tenant
  drift checks.
- Ships the bounded-set guide and other linked public docs in the Runner
  tarball, and fails package assembly when a shipped local Markdown link cannot
  resolve.
- Removes obsolete `0.1 preview` wording from the DSL package without changing
  canonical Spec `spec_version: "0.1"`.
- Adds a build-vs-adopt guide for teams already using prompts and custom
  parameterized tools. It distinguishes behavioral instructions from
  structural authorization, explains where SQL authority lives, and documents
  the approval, receipt, replay, and compensation layer without claiming
  prompt-injection prevention or compliance certification.
- Published `@synapsor/runner@1.4.1` and `@synapsor/dsl@1.4.1`;
  `@synapsor/spec` remains `1.4.0` because the public contract schema did not
  change.

## 1.4.0 (2026-07-14)

### Reviewed Reversible Change Sets

- Adds opt-in canonical `reversibility.mode = reviewed_inverse` and DSL
  `REVERSIBLE` for direct SQL capabilities with human/operator approval and
  operation-specific exact guards.
- Captures bounded inverse descriptors only after an unambiguous successful
  source transaction. Inverses retain trusted identity, version metadata, and
  reviewed writable values; kept-out data is excluded.
- Adds operator-only `revert <proposal-id>`, which creates a new proposal and
  never writes or approves. Compensation inherits reviewer role/quorum and
  passes normal approval, guarded apply, receipt, reconciliation, and replay.
- Supports reviewed UPDATE, INSERT, soft-delete, and exact frozen-set
  compensation on PostgreSQL and MySQL. Fresh-state conflicts and one stale set
  member fail closed without partial effects.
- Reports hard DELETE and app-owned/external effects as specifically
  unavailable instead of claiming rollback or time travel. Successful
  compensation captures its own bounded inverse with linear lineage capped at
  16.
- Adds compensation change-set and protocol-v4 job/receipt schemas,
  conformance fixtures, owner-authorized resources, local UI/doctor/preview
  state, bounded metrics, crash-reconciliation tests, and the disposable
  `corepack pnpm test:reversible` gate.
- Published `@synapsor/spec@1.4.0`, `@synapsor/dsl@1.4.0`, and
  `@synapsor/runner@1.4.0`.

## 1.3.0 (prepared, not published)

### Bounded Set Writeback

- Adds canonical and DSL semantics for fixed-predicate set `UPDATE`/`DELETE`
  and exact-review batch `INSERT`, with mandatory `MAX ROWS`, aggregate value
  bounds, and a hard 100-row implementation ceiling.
- Freezes ordered primary keys, tenant scope, reviewed before/after values,
  exact versions, per-member digests, and a set digest before approval. Apply
  locks only that frozen set and never reruns a broad selection predicate.
- Applies every member in one source transaction. Cap overflow, aggregate
  overflow, stale/missing members, anomalous affected counts, dedup conflicts,
  triggers, or widening delete cascades fail closed without partial effects.
- Requires human/operator approval for all bounded sets in this release;
  policy auto-approval is rejected. Hard set delete remains exceptional and
  soft delete is preferred.
- Adds protocol-v3 change-set, writeback-job, result, and receipt envelopes
  with exact member identities and bounded safe digests, plus reconciliation
  support for Runner-ledger crash ambiguity.
- Adds executable R1-R7 conformance coverage and a disposable PostgreSQL/MySQL
  live gate for cap/aggregate rejection, atomic rollback, exact receipts,
  batch deduplication, delete hazards, reconciliation, and 1/10/100-row bounds.
- Stages `@synapsor/spec@1.3.0`, `@synapsor/dsl@1.3.0`, and
  `@synapsor/runner@1.3.0`. No npm package is published by this change.

## 1.2.0 (prepared, not published)

### Guarded CRUD And Receipt Authority

- Adds canonical and DSL operation semantics for native guarded single-row
  `INSERT`, `UPDATE`, and `DELETE`, while preserving operation-less contracts
  and v1 writeback jobs as guarded UPDATE.
- Adds operation-aware v2 change-set, writeback-job, and execution-receipt
  schemas with trusted tenant binding, source-enforced INSERT deduplication,
  DELETE cascade/trigger refusal, bounded diffs, and replay-safe digests.
- Separates receipt authority (`source_db` or `runner_ledger`) from source
  receipt provisioning (`precreated` or `auto_migrate`). Runner-ledger mode
  records durable intents without source receipt DDL and stops ambiguous
  post-commit outcomes for verified operator reconciliation.
- Extends Postgres and MySQL adapters, onboarding, doctor, tools preview, and
  the support-plan-credit example with least-privilege guarded CRUD paths.
- Adds disposable-engine verification for every operation and receipt mode,
  retries, crash windows, concurrent applies, stale guards, and hidden DELETE
  effects. No npm package is published by this change.
- Stages `@synapsor/spec@1.2.0`, `@synapsor/dsl@1.2.0`, and
  `@synapsor/runner@1.2.0`.

## 1.1.2 (prepared, not published)

### Fleet Error And Batch Apply Correctness

- Classifies bounded source-pool saturation and recognized transient
  PostgreSQL, MySQL, and network failures as `TEMPORARILY_UNAVAILABLE` with
  `retryable: true` and a bounded `retry_after_ms`, while keeping raw driver
  details out of MCP results and operational logs.
- Keeps non-transient database failures fail-closed as non-retryable
  `INTERNAL` errors.
- Preserves the existing shared `runtime_store` bridge while
  `apply --all-approved` applies each selected proposal, preventing stale
  bridge state from silently skipping policy- or human-approved proposals.
- Adds policy-approved unit coverage and a two-Runner synthetic Postgres fleet
  check for durable batch results and receipts.
- Stages only `@synapsor/runner@1.1.2`; canonical Spec and DSL remain `1.1.0`.

## 1.1.1

### Resource Read Authorization

- Reauthorizes local MCP proposal, evidence, and replay reads against the
  owning capability's trusted tenant and principal before returning content.
- Returns the same generic `RESOURCE_NOT_FOUND` result for missing resources,
  cross-tenant access, cross-principal access, and incomplete legacy ownership
  metadata so a leaked handle does not become bearer authority.
- Adds shared-store and Streamable HTTP regressions proving owner access still
  works while cross-session resource reads fail closed.
- Published only `@synapsor/runner@1.1.1`; canonical Spec and DSL remain
  `1.1.0`.

## 1.1.0

### Fleet Safety And Operations

- Fails closed when claim-authenticated HTTP serving resolves an
  environment/static contract context, and fixes object-filtered activity so
  unrelated receipts cannot enter results.
- Adds RS256/ES256 session and operator JWT verification with bounded JWKS or
  public-PEM loading, plus verified operator attestations without bearer-token
  persistence.
- Adds dependency-aware `/readyz`, separately protected `/metrics`, reusable
  bounded Postgres/MySQL pools, and trusted tenant/capability fixed-window rate
  limits that are atomic in shared runtime-store mode.
- Adds optional canonical `required_approvals` and DSL `REQUIRE n APPROVALS`,
  distinct-reviewer enforcement, `n/N` progress, terminal rejection, and
  policy-auto-approval deferral for multi-human quorum.
- Hardens shared Postgres migration startup, bounds the transient bridge with
  `max_entries`, makes CLI/UI reviewers read the shared queue, and fixes nested
  worker/apply bridge locking.
- Adds verified dead-letter list/show/requeue/discard, shared-ledger
  backup/digest/restore, archive-before-retention, and a repeatable two-Runner
  kill/recovery test over synthetic Postgres/MySQL.
- Published `@synapsor/spec@1.1.0`, `@synapsor/dsl@1.1.0`, and
  `@synapsor/runner@1.1.0`.

## 1.0.0

### Production Approval Loop

- Adds `apply --all-approved --yes` with per-proposal results, conflict
  isolation, idempotent reruns, and `--capability`, `--tenant`, and `--max`
  filters.
- Adds canonical aggregate auto-approval limits in `@synapsor/spec`, DSL
  `LIMIT` clauses, reviewer-visible limit trip events, and doctor/tool preview
  surfacing.
- Adds signed operator identity checks for approve/reject/apply while keeping
  dev env identity available for local experiments.
- Adds structured operational logs, per-tenant/capability counters, supervised
  writeback worker retries/dead letters, and continued owner-only local store
  permission tests.
- Adds Postgres shared ledger support, runtime-store mode, per-session
  HTTP-claims trusted context, managed secret hydration, token rotation hooks,
  and Streamable HTTP mTLS.
- Declares the first semver contract for the documented CLI, schema, contract,
  MCP result, writeback, approval, metrics, and replay surfaces.
- Published `@synapsor/spec@1.0.0`, `@synapsor/dsl@1.0.0`, and
  `@synapsor/runner@1.0.0`.

## 0.1.16

### Fleet-Lab Runner Hardening

- Preserves native Postgres timestamp precision from scoped reads through
  evidence, proposals, conflict guards, and guarded writeback.
- Keeps conflicts immutable and inspectable while allowing a freshly based
  successor proposal for the same object.
- Returns `PROPOSAL_ALREADY_EXISTS` with the active proposal id/state instead
  of a generic `INTERNAL` error, and emits a matching structured log event.
- Rejects DSL `LOOKUP ... BY` columns that differ from the declared primary key
  instead of silently changing contract meaning.
- Uses administrator-created receipt tables with least-privilege steady-state
  writer grants; doctor/apply no longer require schema `CREATE`.
- Aligns audit contract-path resolution, Runner JSON Schema, owner-only local
  store permissions, CLI help, and reference documentation with runtime
  behavior.
- Stages `@synapsor/dsl@0.1.6` and `@synapsor/runner@0.1.16`;
  `@synapsor/spec` remains `0.1.4` because canonical contract semantics did not
  change.

## 0.1.15

### Editor-Friendly DSL Source Files

- Prefers `.synapsor.sql` for DSL source files so editors can provide generic
  SQL highlighting while keeping `.synapsor` backward compatible.
- Keeps DSL semantics, Runner behavior, and generated canonical JSON unchanged.
- Stages `@synapsor/dsl@0.1.5` and `@synapsor/runner@0.1.15`.

## 0.1.14

### README Path Polish

- Makes the audit, demo, and staging-database adoption sequence explicit for
  readers scanning the first minute of the README.
- Trims the inline JSON example to the reviewed capability entry and links the
  generated storage, source, trusted-context, and timeout wiring to the full
  own-database guide.
- Stages `@synapsor/runner@0.1.14`; `@synapsor/spec` and `@synapsor/dsl` remain
  unchanged for that release.

## 0.1.13

### Front-Door Documentation

- Rewrites the GitHub and npm READMEs around an audit-first 60-second proof,
  one staging-database path, and direct links to task-specific documentation.
- Adds a trust and verification section that links the threat model,
  conformance fixtures, live Postgres/MySQL apply smoke, and Cloud/C++
  contract round-trip evidence.
- Untracks internal progress files, preserves them under the ignored local
  notes directory, and adds ignore guards so session state cannot return to the
  public repository root.
- Stages `@synapsor/runner@0.1.13`; `@synapsor/spec` and `@synapsor/dsl` remain
  unchanged.

## 0.1.12

### Runner Version Invocation

- Stages `@synapsor/runner@0.1.12` without changing or republishing
  `@synapsor/spec@0.1.4` or `@synapsor/dsl@0.1.4`.
- Keeps `--version`, `-v`, and `version` stable when an npm/npx wrapper forwards
  a duplicated `synapsor-runner` executable token.
- Reads the Runner version from bundled package metadata instead of the
  invoking project's ambient `npm_package_version` value.
- Adds source-wrapper and installed-tarball checks for every supported version
  form and the duplicated-token regression shape.

## 0.1.11

### Cloud Adoption Loop

- Publishes `@synapsor/spec@0.1.4`, `@synapsor/dsl@0.1.4`, and
  `@synapsor/runner@0.1.11`.
- Adds a seven-file MCP client bundle for Claude Desktop, Cursor, OpenAI Agents
  SDK, and generic stdio/Streamable HTTP clients, including OpenAI-safe tool
  aliases.
- Productizes local and Cloud-generated Runner bundles with placeholder env
  wiring, validation/run instructions, and no embedded credentials or rows.
- Adds a network-free adoption quickstart verifier and a real local
  Runner-to-Cloud-to-ZIP-to-Runner verification path around the flagship
  `support-plan-credit` contract.
- Documents the Cloud registry/version/bundle loop and avoids implying managed
  runner fleets, SAML/SCIM, hosted policy enforcement, or enterprise SLA.
- Adds `SYNAPSOR_CLOUD_WORKSPACE` support and explicit Cloud push failure tests
  for authorization, validation, conflict, server, and network outcomes.
- Corrects `cloud push --help` so it describes the implemented authenticated
  upload path and the network-free dry-run instead of the removed pre-registry
  limitation.

## 0.1.10

### Policy Auto-Approval

- Stages `@synapsor/spec@0.1.3`, `@synapsor/dsl@0.1.3`, and
  `@synapsor/runner@0.1.10` for policy-based local approval.
- Adds portable proposal approval `policy` references and typed approval policy
  rules to the canonical contract.
- Adds DSL `AUTO APPROVE WHEN field <= integer` clauses that compile to
  reviewed approval policies.
- Adds a conformance fixture for policy auto-approval thresholds.

## 0.1.9

### CLI Hygiene

- Adds top-level `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` output so published package checks do not look like
  an unknown command.

## 0.1.8

### DSL / JSON Contract Parity

- Adds portable spec fields for capability `returns_hint`, proposal
  `numeric_bounds`, and proposal `transition_guards` so reviewed safety
  metadata can live in canonical contracts instead of runner-private config.
- Extends the DSL with `DESCRIPTION`, `RETURNS HINT`, arg descriptions,
  numeric arg min/max, text `MAX LENGTH`, patch `BOUND`, and `TRANSITION`
  clauses.
- Adds DSL warnings and `--strict` mode so weak proposal contracts fail CI
  instead of silently compiling.
- Preserves compiled bounds through `contracts: []` into Runner propose-time
  enforcement and accepts pure-contract configs with `capabilities: []`.
- Adds `docs/dsl-json-parity.md` so developers can see which fields are
  authored in DSL, validated in JSON, enforced by Runner, and accepted by
  C++/Cloud.

### Cloud Registry Push

- Wires non-dry-run `synapsor-runner cloud push` to the Synapsor Cloud control
  API. The CLI validates locally, posts normalized `@synapsor/spec` JSON, and
  reports Cloud contract/version/digest details only after the server confirms
  storage.
- Keeps `--dry-run` network-free and updates error handling for invalid tokens,
  missing workspace permissions, validation errors, conflicts, and network
  failures without printing bearer tokens.
- Documents the project-scoped Cloud registry path and backend runner-bundle
  export foundation.

### Release Verification

- Adds `corepack pnpm test:live-apply` as the documented Docker-backed live
  apply smoke. It aliases the existing MCP local examples proof and verifies
  proposal diffs, approval outside MCP, guarded writeback, idempotent retry,
  stale-row conflict, receipts, and replay against disposable Postgres/MySQL
  databases.

## 0.1.7

### Contract Writeback Resolution

- Fixes contract-authored proposal capabilities loaded through `contracts: []`
  so `apply` resolves the same reviewed capability catalog used by serve,
  tools, propose, and doctor.
- Rejects duplicate capability names across embedded runner config and
  referenced contracts instead of silently shadowing a safety contract.
- Preserves canonical contract writeback modes, including direct SQL,
  app-owned handler, cloud-worker, and proposal-only/no-local-writeback
  semantics.
- Fails broken applyable writeback definitions at propose/doctor time before a
  human approves a proposal.
- Creates local store parent directories automatically and trims env-derived
  URLs, tokens, and trusted context values before use.

## 0.1.5

### Contract Authoring Front Door

- Introduces `@synapsor/spec` and `@synapsor/dsl` in the main Runner README so
  developers can find the canonical contract and SQL-like authoring layers from
  the repo and npm package front door.
- Adds a copy-pasteable `CREATE AGENT CONTEXT` / `CREATE CAPABILITY` authoring
  flow that compiles to `synapsor.contract.json`, validates, bundles, dry-run
  pushes to Cloud, and serves through Runner local wiring.
- Refreshes capability authoring docs to lead with the contract/DSL path while
  preserving direct `synapsor.runner.json` embedded capability authoring for
  local experiments and compatibility.
- Clarifies that workflow declarations are supported in contracts/DSL, while
  Runner 0.1 does not execute full Synapsor Cloud workflow DAGs, auto-merge,
  settlement policies, or native branching.
- Updates the repository map to include `packages/spec` and `packages/dsl`.

## 0.1.4

### Public Repository Metadata

- Points the packaged npm README and repository metadata at the public GitHub
  repository: `https://github.com/Synapsor/Synapsor-Runner`.
- Pins the CI badge to the `main` branch so Dependabot PR failures do not make
  the public project front door look broken.
- Adds Dependabot guardrails so semver-major dependency updates are deliberate
  migrations instead of automatic public PR noise.

## 0.1.3

### Public npm DX

- Prepares the spec-ready Runner package for the normal untagged npm path so
  developers can use `npx -y -p @synapsor/runner synapsor-runner ...` without
  knowing about the temporary `next` release-candidate tag.
- Keeps the same contract/spec functionality as `0.1.2`; this is a release
  hygiene patch for public install and README/package-page verification.
- `@synapsor/spec@0.1.0` and `@synapsor/dsl@0.1.0` remain the canonical
  contract packages.

## 0.1.2

### Contract Compatibility

- Publishes the canonical contract packages as `@synapsor/spec@0.1.0` and
  `@synapsor/dsl@0.1.0`, with `@synapsor/runner@0.1.2` available on the `next`
  npm tag for round-trip verification before promotion.
- Documents the canonical `synapsor.contract.json` path for contracts produced
  by the DSL, Cloud, or the C++ exporter.
- Adds OSS-side conformance notes for C++/Cloud export snapshots that validate
  with `@synapsor/spec` and load in Runner.
- Keeps `@synapsor/runner` publishable after `0.1.1` by reserving the next
  stable patch version for this contract round-trip readiness pass.

## 0.1.1

### Launch Readiness

- Reworked the README and packaged npm README so the first screen leads with
  the `execute_sql` risk, the reviewed-business-action alternative, badges,
  and the no-database quick demo.
- Added the self-contained `examples/support-billing-agent/` flagship demo with
  schema, seed data, reviewed contract, app-boundary note, one-command
  `make demo`, and the exact model-facing tools:
  `support.inspect_ticket`, `support.propose_plan_credit`,
  `billing.inspect_invoice`, and `billing.propose_late_fee_waiver`.
- Added copy-paste example entry points for raw SQL vs Synapsor,
  Claude Desktop, Cursor, OpenAI Agents SDK over Streamable HTTP and stdio, and
  MySQL refund review.
- Added agent-native repo guidance files for Codex/Claude/Cursor/Copilot and
  verified in a temp copy that an agent can create an inspect/propose
  capability with non-interactive CLI commands without reading generated
  `dist/` files.
- Restructured the docs index into a task-first path from quickstart to raw SQL
  risk, demo, own database setup, capability generation, MCP serving,
  propose/approve/apply, replay/audit, app-owned handlers, and concepts.
- Added release-gate and repo hygiene assets, including issue/PR templates,
  threat model/security references, README badges, and package metadata.
- Hardened package building so generated `.synapsor` local ledgers are not
  shipped in npm examples.

## 0.1.0

### Stable Channel

- Promotes the alpha.17 safety/onboarding surface to the first stable
  `@synapsor/runner` release.
- Documents the `0.1.x` compatibility promise for the `synapsor-runner` binary,
  `synapsor.runner.json` schema version `1`, result envelope v2, stdio and
  Streamable HTTP MCP surfaces, MCP client snippets, local inspection commands,
  direct SQL writeback, and app-owned executor contracts.

### Included From Alpha.17

- Prompt-free onboarding for scripts, CI, and LLM agents.
- Review-mode configs that avoid silently disabled writeback.
- `up --serve`, stale lease reclaim, result envelope v2 defaults for new
  configs, app-owned handler warnings, final wizard preview, friendlier
  capability names, local event webhooks, and smoke-call first-run guidance.

## 0.1.0-alpha.17

### Added

- Prompt-free onboarding for `onboard db` / `init` through `--yes`,
  `--non-interactive`, and `--answers <file.json>`.
- Friendly scripted onboarding flags: `--tenant-column`, `--id-arg`, `--patch
  column=fixed:value|arg:name`, `--patch-bounds`, `--status-guards`,
  `--read-description`, `--read-returns-hint`, `--handler-output`, and
  `--emit-handler`.
- Answers-file onboarding can emit the same artifacts as the wizard: reviewed
  config, `.env.example`, MCP snippets, and optional handler template.
- Guided onboarding now shows a final "what I am about to write" preview where
  users can revise visible fields or capability names before files are written.
- README and runner README now include a short "How An External Handler Works"
  explanation directly after the writeback rule.
- `events webhook` / `events push` can POST local proposal/writeback lifecycle
  events to a local/dev/staging HTTP endpoint for review UIs or notifications.

### Changed

- When `--namespace` is omitted, generated capability names derive a namespace
  from the selected table instead of defaulting to `source.*`.
- App-owned `http_handler` and `command_handler` generated configs mark the
  Runner source as `read_only: true` when no writer env is supplied. These
  configs now validate without a `WRITEBACK_DISABLED` warning.
- Direct SQL review-mode proposal capabilities still require `write_url_env`
  readiness; missing writer env remains visible as `WRITEBACK_DISABLED`.
- Published docs/examples no longer contain install-looking
  `@synapsor/handler` imports. The app-owned example uses the bundled
  `synapsor-handler.mjs` shim directly.

## 0.1.0-alpha.16

### Added

- `synapsor-runner up` for first-session review-mode bring-up. It validates
  the local config/store, checks active store leases, summarizes model-facing
  tools, explains direct SQL versus app-owned executor writeback, and prints
  the next smoke, approval, apply, replay, UI, and doctor commands.
- Guided app-owned executor setup can now write a starter handler template
  during `init --wizard` / `start --from-env ... --mode review`.
- `result_format: 2` for a stable MCP result envelope with `ok`, `summary`,
  `data`, `proposal`, `error`, `evidence`, `source_database_changed`, and
  `_meta.canonical_capability`.
- `--result-format v1|v2` for `mcp serve`, `mcp serve --transport
  streamable-http`, `mcp serve-streamable-http`, and the legacy JSON-RPC
  bridge.
- Capability config fields `description`, per-argument `description`, and
  `returns_hint`; these are surfaced in MCP tool metadata.
- `tools list` as a first-class alias for `tools preview`, including
  `tools list --aliases`.
- `mcp client-config --include-instructions` for Claude/Cursor/OpenAI-style
  client snippets with propose-first agent guidance.
- `schemas/synapsor.runner.schema.json` for editor validation.
- `docs/capability-authoring.md`, `docs/result-envelope-v2.md`, and RFC source
  docs under `docs/rfcs/`.

### Changed

- Handler templates, template CLI output, app-owned writeback docs, and
  examples now carry the explicit handler security warning: app handlers own the
  final business write and must re-check tenant/scope, conflict guards,
  idempotency, business action, transactions, and safe receipts.
- OpenAI-safe aliases include the canonical Synapsor capability name in
  descriptions/metadata so model-visible aliases can still be audited against
  dotted capability names.
- v2 MCP errors redact raw driver/infra strings and map failures to a small
  safe error-code enum.
- Release policy now keeps the stable channel gated on `up`, review-mode wizard
  verification, handler warning coverage, clean npm install checks, and at
  least one external developer following the README without source reading.

### Compatibility

- Result envelope v1 remains the default in this alpha. Opt in with
  `result_format: 2` or `--result-format v2`.
- The public command remains `synapsor-runner`.

## 0.1.0-alpha.15

### Changed

- Clarified that users install only `@synapsor/runner`. A handler is the
  user's app endpoint or script for rich approved writes, and Runner includes
  templates/examples to help build one.

## 0.1.0-alpha.14

### Changed

- Clarified that `@synapsor/handler` is not published as a standalone npm
  package yet. The TypeScript helper currently exists in the source monorepo
  and as the bundled `synapsor-handler.mjs` shim used by the packaged
  app-owned executor example.
- Included `CHANGELOG.md` in the `@synapsor/runner` npm tarball so users can
  inspect alpha changes without cloning the repository.

## 0.1.0-alpha.13

### Changed

- Reworked the README opening around a five-line mental model: agent talks to
  Runner, Runner exposes capabilities, proposals are saved but not applied, and
  approval/writeback stay outside the model-facing tool surface.
- Added plain definitions for capability, proposal, writeback, and executor near
  the top of the README.
- Added the direct-writeback versus app-owned-executor rule up front: guarded
  one-row updates can use Runner direct writeback; richer business actions use
  an app-owned executor.
- Added a tiny readable own-database config example with one read capability and
  one proposal capability so new users can picture what the guided wizard
  creates.

## 0.1.0-alpha.12

### Added

- `doctor --check-writeback` verifies direct SQL writer connectivity,
  receipt-table readiness, and rollback-only access to configured proposal
  target tables/columns without mutating business rows.
- `docs/doctor.md` documents redacted setup checks, handler reachability,
  direct SQL writeback probes, and receipt-table guidance.
- `store reset --yes` removes only the local SQLite ledger files and refuses
  active server leases unless `--force` is provided.

### Changed

- Doctor output now warns when direct SQL writeback has not been probed and
  points to `--check-writeback`.
- Packed/public verification scripts exercise `store reset` in addition to
  stats/prune.

## 0.1.0-alpha.11

See [docs/release-notes.md](docs/release-notes.md) for the current published
alpha notes.
