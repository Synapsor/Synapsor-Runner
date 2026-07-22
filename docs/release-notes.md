# Release Notes

These notes track public Synapsor Runner behavior. Starting with `1.0.0`, the
documented production-loop compatibility line uses the untagged stable package:

```bash
npx -y -p @synapsor/runner synapsor-runner demo --quick
```

The OSS runner command is `synapsor-runner`. The `synapsor` command is reserved
for the Synapsor Cloud CLI.

## 1.5.4 (published 2026-07-22)

### Networked MCP authentication hardening

- Local stdio still opens no network listener and needs no HTTP credential.
  Loopback HTTP remains authenticated by default with an operator-provisioned
  opaque token.
- Remote HTTP now refuses to bind over an undeclared cleartext channel. Operators
  must use Runner-owned TLS, explicitly declare a trusted TLS proxy, or select an
  authenticated and prominently diagnosed break-glass posture.
- Opaque endpoint tokens are constrained to local or explicit single-tenant use.
  Remote use requires adequate entropy; one active and one previous env-provided
  value support bounded rotation without logging either value.
- Shared deployments require signed per-session identity and `http_claims`
  trusted context. Runner revalidates issuer, audience/resource, time, scope,
  tenant, principal, signature, and algorithm on every request and rejects token
  or identity swaps inside an MCP session.
- RFC 9728 protected-resource metadata and Bearer challenges let compatible MCP
  clients discover the configured external authorization server. Runner verifies
  access tokens but does not implement user login or token issuance.
- TLS/mTLS preflight, public-only bounded JWKS handling, exact Origin/Host checks,
  request/session bounds, doctor diagnostics, client recipes, and fleet examples
  now share one documented deployment ladder.
- `lifecycle`, `lifecycle show`, and `lifecycle show latest` now inspect the
  newest complete proposal lifecycle without an id. Filters and known
  proposal/evidence/replay/job/intent/receipt/audit handles resolve a stable,
  read-only `synapsor.lifecycle-view.v1` domain document across local SQLite
  and shared PostgreSQL runtime stores.
- DSL UPDATE authoring now requires an exact `CONFLICT GUARD <column>` instead
  of silently choosing projection hashing. A reviewer-visible weak compatibility
  clause remains only for ordinary single-row source-DB UPDATE and is rejected
  for the stronger operation modes.
- Runner rejects canonical `FROM SESSION` with
  `SESSION_BINDING_UNSUPPORTED` rather than treating its key as a process
  environment variable. Explicit ENVIRONMENT, verified HTTP_CLAIM, verified
  CLOUD_SESSION, and STATIC_DEV behavior remains distinct.

Published package versions: `@synapsor/runner@1.5.4` and
`@synapsor/dsl@1.4.4`. `@synapsor/spec@1.4.2` and the Cloud CLI were
unchanged.

## 1.5.3 (published 2026-07-21)

### Intent to Safe Action

- `start --action <name> --description <intent>` creates one inert TypeScript
  Safe Action scaffold from an existing reviewed read boundary. Project-scoped
  instructions let a coding agent complete and validate only the draft.
- `action validate` statically parses the restricted object and emits a
  digest-addressed disabled canonical draft, explanation, and deterministic
  allow/deny/effect tests. It does not import adopter code, activate the action,
  or alter the active MCP tool catalog.
- The secured Workbench runs one real source-unchanged staging Data PR before
  activation and requires `ACTIVATE` plus the complete digest. Cloud-linked
  projects use governed Cloud activation. Existing proposals remain bound to
  the exact active contract digest they were created under.
- The package includes a current-format Cursor plugin with
  `/synapsor-protect`, diagnostics, deterministic package verification, and
  project-safe MCP wiring. Cursor host claims remain evidence-labeled; a stable
  UI pass and Marketplace submission are owner gates.
- MCP audit now renders a model-authority map and opt-in bypass evidence as
  text, JSON, Markdown, or SARIF. A checked-in GitHub Actions workflow and Safe
  Action team CI are deterministic and non-mutating.
- Proposal-only integration recipes cover Claude Code, Codex, VS Code, OpenAI
  Agents, LangChain/LangGraph, Google ADK, LlamaIndex, and generic MCP clients.
- The first two README screens, public website, article, discovery routes, and
  36-second evidence-backed demo now lead with the own-project Data PR path.

Published package version: `@synapsor/runner@1.5.3`. Spec, DSL, and Cloud CLI
packages were unchanged.

## 1.5.2 (prepared, not published)

### First safe action in an existing application

- `start --from-env DATABASE_URL` and
  `try --prove --from-env DATABASE_URL` now converge on one own-data
  onboarding path. It inspects a staging database read-only, asks the developer
  to choose trusted scope and one reviewed action, emits canonical files, and
  never substitutes synthetic data after an own-data failure.
- The localhost workbench presents Project, Data source, Trust scope, Action,
  Agent, Test, and Review plus an exact proposal Data PR. Test is complete only
  after a scoped tool call records query audit, not after config validation.
- Project-scoped Cursor install/status/uninstall previews and owns only its MCP
  entry, preserves other entries, and launches the exact Runner version.
  Approval, apply, revert, credentials, and trusted identity stay outside MCP.
- Local activation reports measure proof, onboarding, Cursor, first read, and
  first proposal without telemetry or business identifiers. Product time
  excludes initial package download; cold `npx` time is reported separately
  as an observed environment-specific measurement.
- Optional TypeScript authoring emits the same canonical Spec contract. Shadow
  trust progression and provider-neutral effect regression remain
  non-activating and preserve deterministic/external-model provenance.
- MCP audit candidates can open directly in the secured workbench, and the
  release includes the host-compatibility matrix and support/billing reference
  workflow.
- The package now requires Node 22.13.0 or newer, the first Node 22 release
  where Runner's `node:sqlite` dependency is available without an experimental
  runtime flag. Older Node versions fail immediately with an actionable error.

Prepared package version: `@synapsor/runner@1.5.2`. Spec, DSL, and Cloud CLI
packages are unchanged. Nothing has been published by this repository change.

## 1.5.1 (prepared, not published)

### Safe disposable state ownership

- `try --state-dir` no longer treats the supplied directory as disposable.
  The supplied path is a caller-owned container and Runner uses a marked
  managed child beneath it.
- Cleanup removes only known direct try-state files. Unrelated files remain in
  place, and roots, home/cwd/repository paths, traversal, symlink escapes,
  unmarked lookalikes, and linked managed files fail closed.
- An atomic state lease prevents concurrent runs from corrupting each other and
  permits recovery from a valid lease whose process is no longer alive.
- `demo inspect --state-dir` resolves the same managed child. The default
  `.synapsor/try` path safely adopts only the recognized legacy file layout.
- Explicit `--force` replacement of generated schema and MCP-audit candidate
  directories now rejects protected paths, symlinked ancestors, and linked or
  invalid ownership markers.
- The embedded `try` data source is consistently identified as synthetic.
- The packaged YAML parser is updated to `2.8.3` to include the upstream fix
  for deeply nested collection denial of service.

Prepared package version: `@synapsor/runner@1.5.1`. Spec, DSL, and Cloud CLI
packages are unchanged. Nothing has been published by this repository change.

## 1.5.0 (published 2026-07-20)

### Complete guarded-action developer proof

- `synapsor-runner try --prove` now demonstrates the complete embedded
  business-action boundary without an account, database, Docker daemon, MCP
  client, or model key: scoped evidence, exact `late_fee_cents: 5500 -> 0`
  proposal, no pre-approval mutation, guarded commit, duplicate-free retry,
  changed-intent collision refusal, stale conflict, receipt, and replay.
- Deployments can explicitly select application-level shared-credential scope,
  PostgreSQL RLS defense in depth, or a tenant-bound credential resolver.
  Diagnostics report the active assurance and remaining trust boundary;
  hardened modes fail closed when prerequisites are missing.
- Strict Shadow Mode now has durable studies, bounded case imports,
  authoritative human outcomes, deterministic comparison/readiness reports,
  and effect-level regression fixtures. No study or evaluation path grants
  authority or writes source data.
- Proposal tools advertise a standard display-only MCP App where the host
  supports it. The app and standalone local UI share one reviewer-facing view;
  approval/apply authority and privileged tokens remain outside MCP.
- `audit` can generate disabled canonical replacement candidates, while
  Prisma, Drizzle, and OpenAPI generators create bounded review-only candidate
  contracts without executing adopter source.
- The `support-billing-agent` reference now provides a live disposable
  PostgreSQL/RLS proof for tenant/principal scope, kept-out fields, proposal,
  approval/apply, receipt/retry, stale conflict, replay, strict shadow, and
  effect regression.
- The bundled app-owned handler helper now uses a pre-provisioned receipt table
  without requiring schema `CREATE`; DDL is attempted only when the table is
  absent. The source-workspace and packed billing-handler examples both verify
  transactional apply and idempotent retry.
- The public README leads with `try --prove`, keeps MCP database-risk audit
  immediately second, and distinguishes application scope, PostgreSQL RLS, and
  tenant-bound isolation without overstating any of them.

Published package version: `@synapsor/runner@1.5.0`. Spec, DSL, and Cloud CLI
packages were unchanged.

## 1.4.123 (2026-07-17)

### Advisory capability-surface fitness lint

- `contract lint` now reports high-signal breadth-drift advisories for generic
  query/predicate-style string arguments, capability density above eight on one
  target, operation names that do not read as business actions, and structural
  near-duplicates with identical or loosened arguments.
- Findings are deterministic across declaration order and share stable codes in
  text, JSON, and SARIF. JSON/SARIF include reviewer-safe metrics and structural
  differences without reading a database or environment values.
- Advisory-only lint still exits successfully by default. Teams may opt into a
  CI policy gate with `--strict` or `--fail-on warning`; canonical validity and
  runtime enforcement are unchanged.

Published package version: `@synapsor/runner@1.4.123`. Spec, DSL, and Cloud CLI
packages are unchanged.

## 1.4.122 (2026-07-17)

### Trusted principal scope and Cloud-linked authority

- Contracts may bind a reviewed target column to a required trusted principal
  in addition to the existing tenant lock. Runner applies both predicates in
  SQL and never accepts the principal value from model arguments.
- Same-tenant rows owned by another principal and cross-principal evidence,
  proposal, receipt, and replay handles return the same generic miss as absent
  or cross-tenant resources.
- PostgreSQL/MySQL live tests cover scoped read/propose/insert/update/delete,
  aggregate and bounded-set operations, conflict/idempotency, compensation,
  signed HTTP sessions, and generic denial behavior.
- In explicit `cloud_linked` mode, Cloud is authoritative for governance while
  the local/shared Runner store remains the durable operational spool. An
  idempotent outbox synchronizes bounded proposal/activity/result metadata;
  full evidence, source rows, SQL details, replay payloads, and credentials
  remain local.
- Cloud-linked approval and apply cannot fall back to local operator commands.
  The trusted Runner still verifies the exact local contract, proposal hash,
  tenant/principal guards, bounds, conflict checks, and receipt rules before
  source mutation.
- A separate `@synapsor/cli@0.1.0-beta.1` package manages Cloud contracts,
  projects, scoped credentials, Runner connections, proposal decisions, and
  audit records. Runner keeps the `synapsor-runner` binary and local boundary.

Published package versions: `@synapsor/spec@1.4.2`,
`@synapsor/dsl@1.4.3`, `@synapsor/runner@1.4.122`, and
`@synapsor/cli@0.1.0-beta.1`.

## 1.4.121 (2026-07-15)

### Contract trust surface and bounded-set parser correctness

- Fixes BUG-018, where a documented fixed predicate containing multiple
  equality terms joined by `AND` could compile as one string-valued term and
  then fail closed with no matching source rows.
- The DSL compiler now consumes the complete clause, keeps `AND` inside quoted
  strings, preserves ordered typed literals, and rejects malformed or
  unsupported expressions before serving or proposal creation.
- This does not add free-form SQL predicates: only fixed literal equality terms
  joined by `AND` are supported. `OR`, parentheses, inequalities, ranges, and
  model-authored predicates remain unsupported.
- PostgreSQL and MySQL live verification proves all terms are applied together
  within trusted tenant scope, source rows remain unchanged before approval,
  and guarded apply, receipt/replay, retry, caps, and drift checks remain green.
- Contract authors gain one parser-backed review path: stdio LSP diagnostics,
  completion, hover, and formatting; plain-language explanation; deterministic
  lint; and adopter-owned static/disposable contract tests.
- Scoped object/principal reports export redacted JSON, Markdown, or PDF ledger
  metadata with digest/signature verification. They are tamper-evident exports,
  not a claim that local SQLite is immutable compliance storage.
- DSL enum arguments compile to the canonical enum shape and are enforced by
  every Runner transport. Canonical aggregate reads return one fixed
  tenant-scoped COUNT/SUM/AVG scalar, suppress small groups, and persist no
  member rows or identities in evidence/query audit.
- Graduated trust remains disabled by default and operator-only. It can create
  and export a verified, bounded policy recommendation artifact, but cannot
  auto-approve, push, or activate it.
- C++/Cloud validators and exporters preserve the new additive enum/aggregate
  fields for canonical round-trip compatibility.

Published package versions: `@synapsor/spec@1.4.1`,
`@synapsor/dsl@1.4.2`, and `@synapsor/runner@1.4.121`.

## 1.4.12 (2026-07-14)

### Runtime-store smoke-call consistency

- Fixes BUG-017, where `smoke call` could put proposal artifacts in the
  requested local SQLite path even though the config selected authoritative
  shared Postgres `runtime_store` mode.
- Smoke calls now use the same runtime storage resolver as MCP tool calls. A
  second Runner can immediately inspect the proposal, evidence, query audit,
  events, and replay from the shared ledger.
- Shared-ledger unavailability fails closed with a safe retryable error,
  nonzero exit status, no credential leakage, and no local orphan proposal.
- Local SQLite and mirror modes retain their existing behavior; no source row
  changes before the normal external approval/apply path.

Published package version: `@synapsor/runner@1.4.12`.
`@synapsor/dsl` remains `1.4.1`; `@synapsor/spec` remains `1.4.0`.

## 1.4.1 (2026-07-14)

### Bounded-set digest compatibility patch

- Contract-authored bounded-set proposals now use deterministic recursive
  object-key ordering for member and set digest material.
- Valid proposals created by `1.4.0` remain applyable; the compatibility path
  accepts only the known deterministic `1.4.0` serializations reconstructed
  from the complete stored reviewed data.
- Genuine member, version, value, aggregate, membership, or tenant drift still
  fails closed before source mutation on PostgreSQL and MySQL.
- The Runner package now includes the linked bounded-set guide and validates
  all shipped local Markdown links while packaging.
- The DSL package description and README no longer label the current `1.4.x`
  package as a `0.1 preview`. Canonical contract `spec_version: "0.1"` is
  unchanged.
- Adds an honest prompt-and-application-guardrails decision guide covering SQL
  authority, hand-built semantic tools, structural enforcement, build-vs-adopt
  fit, and regulated-data boundaries.

Published package versions: `@synapsor/dsl@1.4.1` and
`@synapsor/runner@1.4.1`. `@synapsor/spec` remains `1.4.0`.

## 1.4.0 (2026-07-14)

### Reviewed Reversible Change Sets

- Adds canonical and DSL opt-in reversibility for direct SQL operations with
  human/operator approval and exact version/dedup guards.
- Records only bounded, allowlisted inverse data after an unambiguous apply.
- Adds operator-only `revert`, which creates a new independently reviewed
  proposal and never writes, approves, or becomes model-facing.
- Proves UPDATE, INSERT, soft-delete, and exact bounded-set compensation on
  PostgreSQL and MySQL, including stale-state refusal, atomic set rollback,
  crash reconciliation, inverse redaction, receipts, and replay.
- Keeps hard DELETE restoration, app-owned handlers, payments, messages, and
  other external effects outside Runner's automatic compensation claim.

Published package versions: `@synapsor/spec@1.4.0`,
`@synapsor/dsl@1.4.0`, and `@synapsor/runner@1.4.0`.

## 1.3.0 (prepared, not published)

### Bounded Set Writeback

- Adds fixed-predicate set UPDATE/DELETE and exact-review batch INSERT for
  PostgreSQL and MySQL, capped at 100 rows.
- Requires mandatory row and aggregate-value bounds, a frozen exact target set,
  integer version guards for set UPDATE, human/operator approval, atomic apply,
  and per-member receipt/replay evidence.
- Rejects cap overflow instead of truncating, rolls back the full transaction
  on any stale or failing member, and refuses hard set DELETE when hidden
  triggers or widening cascades are present.
- Keeps model-generated predicates, policy auto-approval for sets, unbounded
  batches, UPSERT, cross-table transactions, and external effects on the
  app-owned executor path.
- Adds `corepack pnpm test:bounded-set`, which runs the safety matrix and local
  1/10/100-row measurements against disposable PostgreSQL and MySQL.

Prepared package versions: `@synapsor/spec@1.3.0`,
`@synapsor/dsl@1.3.0`, and `@synapsor/runner@1.3.0`.

## 1.2.0 (prepared, not published)

### Guarded CRUD And Receipt Authority

- Adds canonical and DSL operation semantics for guarded single-row INSERT,
  UPDATE, and DELETE while preserving legacy UPDATE contracts.
- Adds atomic source receipts with precreated or auto-migrated tables and an
  opt-in Runner-ledger mode that creates no source receipt table.
- Adds durable writeback intents and a fail-closed operator reconciliation
  workflow for ambiguous ledger/source crash windows.
- Extends onboarding, doctor, preview, schema inspection, protocol v2,
  Postgres/MySQL adapters, the support-plan-credit example, and disposable live
  conformance tests.
- Keeps multi-row writes, UPSERT, DDL, cross-table work, and external effects
  on the app-owned executor path.

Prepared package versions: `@synapsor/spec@1.2.0`,
`@synapsor/dsl@1.2.0`, and `@synapsor/runner@1.2.0`.

## 1.1.2 (prepared, not published)

### Retry And Shared Batch Correctness

- Makes transient source pool and recognized database saturation errors
  consistently retryable with a bounded retry hint and safe normalized logs.
- Fixes `apply --all-approved` in shared `runtime_store` mode so every selected
  proposal uses the same authoritative bridge and durable outcome ledger.

Prepared package version: `@synapsor/runner@1.1.2`. Canonical Spec and DSL stay
at `1.1.0`.

## 1.1.1

### Resource Read Authorization

- Reauthorizes local proposal, evidence, and replay resources against the
  current trusted tenant and principal instead of treating opaque handles as
  bearer authority.

Released package version: `@synapsor/runner@1.1.1`.

## 1.1.0

### Bounded Small-Fleet Runtime

- Fixes claim/context authority conflicts before serving and keeps
  object-filtered receipts/activity scoped to the requested object.
- Adds asymmetric session/operator identity, readiness, protected HTTP
  metrics, bounded native source pools, and shared fleet rate limits.
- Adds portable distinct-reviewer quorum in the OSS canonical spec and DSL.
  Existing 1.0 contracts still default to one approval. Cloud/C++ enforcement
  of this optional field is not claimed until independently verified there.
- Adds bounded shared-ledger CLI/UI review, startup-safe schema migration,
  dead-letter recovery, backup/restore/retention, and tested worker recovery
  before write and after durable commit.
- Adds [Running A Small Runner Fleet](running-a-runner-fleet.md) and the
  `corepack pnpm test:fleet` synthetic two-Runner verification.

Released package versions: `@synapsor/spec@1.1.0`,
`@synapsor/dsl@1.1.0`, and `@synapsor/runner@1.1.0`.

## 1.0.0

### Production Approval Loop

- Adds batch apply for approved proposals with independent per-proposal
  outcomes, rerun-safe idempotency, and `--capability`, `--tenant`, and
  `--max` filters.
- Adds aggregate policy ceilings to canonical contracts and DSL authoring so
  small proposals fall back to human review once daily count or total limits are
  reached.
- Adds signed operator-key approval/apply enforcement, tamper-evident approval
  records, operational counters/logs, and a supervised local writeback worker.
- Adds shared Postgres ledger support, runtime-store mode, per-session trusted
  context, managed secret hydration, token rotation hooks, and Streamable HTTP
  mTLS for scale-out deployments.
- Keeps local SQLite as the default while allowing runtime-store workers to run
  long-lived shared ledger drain loops under a Postgres advisory lock.
- Declares the first semver contract for the documented CLI, schema, contract,
  MCP result, writeback, approval, metrics, and replay surfaces.

Released package versions: `@synapsor/spec@1.0.0`,
`@synapsor/dsl@1.0.0`, and `@synapsor/runner@1.0.0`.

## 0.1.16

### Fleet-Lab Runner Hardening

- Preserves Postgres microseconds in proposal conflict guards and proves normal
  `now()` rows apply exactly once while genuinely stale rows conflict.
- Allows a new proposal after conflict without deleting or rewriting the old
  proposal, receipt, or replay history.
- Returns semantic active-proposal errors and rejects non-primary DSL lookups.
- Removes schema-creation requirements from steady-state writeback, aligns audit
  paths and JSON Schema with contract configs, and creates local ledgers with
  owner-only POSIX permissions.
- Adds complete DSL, Runner config, and ledger inspection/security references.

Prepared package versions: `@synapsor/dsl@0.1.6` and
`@synapsor/runner@0.1.16`. `@synapsor/spec@0.1.4` remains unchanged.

## 0.1.15

### Editor-Friendly DSL Source Files

- Prefers `.synapsor.sql` for DSL source files so editors can provide generic
  SQL highlighting; `.synapsor` remains supported for compatibility.
- The filename suffix does not change DSL semantics or generated canonical JSON.
- Stages `@synapsor/dsl@0.1.5` and `@synapsor/runner@0.1.15`; `@synapsor/spec`
  remains `0.1.4`.

Prepared package versions: `@synapsor/dsl@0.1.5` and
`@synapsor/runner@0.1.15`. The already-published `@synapsor/spec@0.1.4` does
not change and must not be republished for this release.

## 0.1.12

### Runner Version Invocation

- Keeps `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` stable if an npm/npx wrapper forwards a duplicated
  executable token.
- Uses Runner's bundled package metadata instead of the invoking project's
  `npm_package_version` environment value.
- Adds source-wrapper and installed-tarball verification for all three forms.

## 0.1.11

### Cloud Adoption Loop

- Adds complete Claude, Cursor, OpenAI Agents SDK, and generic MCP templates to
  local and Cloud-generated Runner bundles.
- Adds a flagship adoption verifier and a real local Cloud registry/version/ZIP
  bundle round trip.
- Expands the `support-plan-credit` walkthrough from no-database validation to
  Docker-backed policy tiers, MCP setup, Cloud push, bundle download, replay,
  cleanup, and troubleshooting.
- Supports `SYNAPSOR_CLOUD_WORKSPACE` and verifies distinct 401/403/404/409/422,
  server, and network errors without exposing tokens.
- Clarifies that Cloud registry/versioning is beta-ready while managed runners,
  SAML/SCIM, hosted policy enforcement, legal hold, and enterprise SLA are not
  part of this release.
- Corrects `cloud push --help` to describe the real authenticated registry
  upload and network-free dry-run behavior.

## 0.1.10

### Policy Auto-Approval

- Adds portable approval-policy references and threshold rules.
- Adds DSL `AUTO APPROVE WHEN field <= integer` and the three-tier
  `support-plan-credit` example: policy approval, operator review, and bound
  rejection.

## 0.1.9

### CLI Hygiene

- Adds top-level `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` output.

## 0.1.8

### DSL / JSON Contract Parity

- Adds portable spec fields for capability `returns_hint`, proposal
  `numeric_bounds`, and proposal `transition_guards`.
- Extends the DSL with `DESCRIPTION`, `RETURNS HINT`, arg descriptions,
  numeric arg min/max, text `MAX LENGTH`, patch `BOUND`, and `TRANSITION`
  clauses.
- Adds DSL warnings and `--strict` mode so proposal capabilities cannot
  silently lose reviewed safety metadata.
- Preserves compiled bounds through `contracts: []` into Runner propose-time
  enforcement and accepts pure-contract configs with `capabilities: []`.
- Adds `docs/dsl-json-parity.md` as the field-by-field support matrix across
  JSON spec, DSL, Runner, C++/Cloud, and Cloud push.

### Cloud Registry Push

- Wires non-dry-run `synapsor-runner cloud push` to the Cloud control API.
- Keeps dry-run network-free and prints server-confirmed contract, version,
  digest, and registry details for real uploads.
- Adds clearer 401/403/404/409/422/network error messages without printing
  bearer tokens.

### Release Verification

- Adds `corepack pnpm test:live-apply` as the documented Docker-backed live
  apply smoke for disposable Postgres/MySQL MCP examples, guarded writeback,
  idempotent retry, stale-row conflict, receipts, and replay.

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

### OSS Launch Readiness

- Reworked the README and packaged npm README so the first screen leads with
  the `execute_sql` risk, the reviewed-business-action alternative, badges, and
  the no-database quick demo.
- Added the self-contained `examples/support-billing-agent/` flagship demo with
  schema, seed data, reviewed contract, app-boundary note, one-command
  `make demo`, and the exact support/billing model-facing tool list.
- Added copy-paste example entry points for raw SQL vs Synapsor, Claude
  Desktop, Cursor, OpenAI Agents SDK over Streamable HTTP and stdio, and MySQL
  refund review.
- Added agent-native repo guidance files and verified that an agent can create
  an inspect/propose capability with the non-interactive CLI without reading
  generated `dist/` files.
- Restructured the docs index into a task-first path and added release-gate
  repo hygiene assets.
- Hardened package building so generated `.synapsor` local ledgers are not
  included in npm examples.

## 0.1.0

### Stable Channel

- Promotes the alpha.17 safety/onboarding surface to the first stable
  `@synapsor/runner` release.
- Documents the `0.1.x` compatibility promise for the `synapsor-runner` binary,
  `synapsor.runner.json` schema version `1`, result envelope v2, stdio and
  Streamable HTTP MCP surfaces, MCP client snippets, local inspection commands,
  direct SQL writeback, and app-owned executor contracts.
- Keeps alpha/prerelease builds available through the `@alpha` tag for preview
  behavior.

### Included From Alpha.17

- Prompt-free onboarding for scripts, CI, and LLM agents.
- Review-mode configs that avoid silently disabled writeback.
- `up --serve`, stale lease reclaim, result envelope v2 defaults for new
  configs, app-owned handler warnings, final wizard preview, friendlier
  capability names, local event webhooks, and smoke-call first-run guidance.

## 0.1.0-alpha.17

### Scripted Onboarding

- `onboard db` and `init` now have a prompt-free path for scripts, CI, and LLM
  agents. Use `--yes`, `--non-interactive`, or `--answers <file.json>`.
- Added friendly flags that match the first-run mental model:
  `--tenant-column`, `--id-arg`, `--patch column=fixed:value|arg:name`,
  `--patch-bounds`, `--status-guards`, `--read-description`,
  `--read-returns-hint`, `--read-tool`, `--proposal-tool`,
  `--handler-output`, and `--emit-handler`.
- Answers-file onboarding writes the reviewed config, `.env.example`, MCP
  snippets, and optional handler template without opening a TTY prompt.
- When `--namespace` is omitted, generated capability names now derive a
  namespace from the selected table instead of falling back to `source.*`.
- The guided wizard now has a final "what I am about to write" preview where
  users can revise visible fields or capability names before files are written.
- README Start Here now tells users to run `tools preview` and `smoke call`
  before wiring an MCP client.
- `events webhook` / `events push` can POST local proposal/writeback lifecycle
  events to a local/dev/staging HTTP endpoint for review UIs or notifications.

### Writeback Readiness

- App-owned executor configs generated by Runner now mark the Runner source as
  `read_only: true` when no writer env is supplied. `config validate` no longer
  reports `WRITEBACK_DISABLED` for handler-owned writeback paths.
- Direct SQL review-mode proposals still surface `WRITEBACK_DISABLED` if the
  source has no `write_url_env`, because Runner cannot apply those proposals
  without a trusted writer connection.

### Handler Docs

- README and runner README now include a short "How An External Handler Works"
  section: agent proposes, human approves outside MCP, Runner POSTs to your
  endpoint, and your code writes in its own transaction.
- Published docs/examples no longer include install-looking imports for a
  separate handler package. Use `synapsor-runner handler template ...` or the
  bundled `synapsor-handler.mjs` shim in the app-owned example.

## 0.1.0-alpha.16

### Review-Mode Bring-Up

- Added `synapsor-runner up` as the local review-mode orientation command. It
  validates the config/store, checks active store leases, summarizes
  model-facing tools, identifies direct SQL versus app-owned executor writeback
  paths, and prints the next smoke, approval, apply, replay, UI, and doctor
  commands.
- `up` is guidance-only by default. `up --serve` starts the standard MCP
  Streamable HTTP server after the same validation and guidance.
- `up --dry-run` gives the full checklist without starting a server.
- `up --handler-check` or `up --with-handler` runs the redacted handler
  env/reachability doctor path before serving.
- The guided wizard now writes model-facing capability descriptions,
  per-argument descriptions, returns hints, and defaults generated configs to
  `result_format: 2`.
- `result_format: 2` gives MCP clients a stable envelope with `ok`, `summary`,
  `data`, `proposal`, `error`, `evidence`, `source_database_changed`, and
  `_meta.canonical_capability`. Pass `--result-format v1` or
  `"result_format": 1` only when an older client needs the legacy shape.
- `tools list`, `tools list --aliases`, and
  `mcp client-config --include-instructions` help users inspect exposed tools
  and generate client snippets without source reading.

### Handler Security

- Generated handler templates, template-list output, app-owned writeback docs,
  and examples now explicitly warn that the app handler owns the final business
  write. Handlers must re-check tenant/scope, expected-version or conflict
  guard, idempotency, allowed business action, transaction/rollback, and safe
  error receipts before mutating application state.
- The guided review-mode wizard can now write a starter handler template when
  the app-owned HTTP or command handler path is selected.

## 0.1.0-alpha.15

### Handler Wording Clarification

- README and app-owned executor docs now state that users install only
  `@synapsor/runner`. A handler is the user's own app endpoint or script for
  rich approved writes, not a second Synapsor package to install.

## 0.1.0-alpha.14

### Handler Helper And Changelog Clarity

- Public docs now state that the handler helper is not a standalone npm package
  yet. The helper currently ships as source under `packages/handler` and as the
  bundled `synapsor-handler.mjs` shim in the app-owned executor example
  included with `@synapsor/runner`.
- `CHANGELOG.md` is included in the `@synapsor/runner` npm tarball.

## 0.1.0-alpha.13

### README First-Five-Minutes Polish

- The README now opens with the plain mental model: the agent talks to Runner,
  can inspect scoped data, can create proposals, cannot commit, and writeback
  plus replay happen outside the model-facing tool.
- Capability, proposal, writeback, and executor are defined before the first
  command so a new reader can understand the rest of the docs.
- The README now states the direct-writeback rule early: guarded one-row updates
  can use Runner direct writeback; inserts, multi-table work, events, and other
  rich writes belong in an app-owned executor.
- The own-database section now includes a tiny readable config with one read
  capability and one proposal capability so users can picture what the wizard
  generates before they run it.

## 0.1.0-alpha.12

### Doctor And Writeback Checks

- `synapsor-runner doctor --config synapsor.runner.json --check-writeback`
  verifies direct SQL writer connectivity, receipt-table readiness, and
  rollback-only target-table access for reviewed proposal capabilities.
- Plain `doctor` warns when direct SQL writeback exists but has not been probed.
- The writeback probe uses fixed identifiers from reviewed config only. It does
  not accept model SQL, user SQL, arbitrary table names, or arbitrary columns.
- Probe failures are redacted to safe categories such as `connection failed`,
  `permission denied`, and `configured object not found`.
- `docs/doctor.md` explains handler checks, direct SQL writeback checks, and
  receipt-table DDL/grant guidance.

### Store Lifecycle

- `synapsor-runner store reset --store ./.synapsor/local.db --yes` removes only
  local SQLite ledger files and reports `source_database_changed: false`.
- Destructive store reset refuses active server leases by default and requires
  `--force` for advanced/stale-lease recovery.
- Packed and public verifier scripts now cover `store reset`.

## 0.1.0-alpha.11

### OpenAI MCP Aliases

- `synapsor-runner mcp serve` and `synapsor-runner mcp serve-streamable-http`
  now accept `--alias-mode openai` and `--openai-tool-aliases`.
- `synapsor-runner mcp serve --transport streamable-http` is available as a
  unified command form for the standard HTTP MCP server.
- `synapsor-runner mcp client-config --client openai-agents` prints a
  Streamable HTTP start command and OpenAI Agents SDK snippet.
- `synapsor-runner tools preview --alias-mode openai` shows model-visible alias
  names and the canonical Synapsor capability each alias maps to.
- `examples/mcp-postgres-billing-app-handler/` adds a disposable Postgres proof
  for the app-owned executor path: proposal first, approval outside MCP,
  account-credit row inserted by the app handler, idempotent retry, and replay.
- `--alias-mode both` exposes canonical dotted names and OpenAI-safe aliases
  together for migration/debugging.
- OpenAI alias mode exposes MCP tool names such as
  `billing__inspect_invoice` instead of canonical dotted names such as
  `billing.inspect_invoice`.
- Tool metadata includes `synapsor.canonical_tool_name`,
  `synapsor.exposed_tool_name`, and `synapsor.tool_name_style`, so reviewers
  can still see the canonical Synapsor capability.
- Runner routes alias calls back to the canonical capability. This removes the
  need for user-written OpenAI wrapper code whose only job is replacing dots in
  tool names.
- The OpenAI Agents SDK stdio and Streamable HTTP examples now document the
  built-in alias mode.

## 0.1.0-alpha.10

### First-Run Flow

- `synapsor-runner start --from-env DATABASE_URL` is the shortest own-database
  onboarding command. It is an alias for the guided `onboard db --from-env`
  flow, not the legacy cloud worker.
- The wizard inspects database metadata, creates trusted context bindings,
  generates semantic capabilities, writes `.env.example`, previews MCP tools,
  and prints exact smoke-call, MCP, and UI commands.
- If you provide a real object id and the required environment variables are
  set, onboarding attempts the first smoke tool call and stores local evidence
  and query audit. If not, it prints the exact `smoke call` command to run
  after setting the values.
- `synapsor-runner ui --open` opens the local review UI and is the preferred
  way to inspect proposals, evidence, receipts, and replay after a demo or
  smoke call.

### MCP Transport

- `synapsor-runner mcp serve` is standard stdio MCP for local MCP clients that
  can launch Runner, such as Claude Desktop, Cursor, and similar clients.
- `synapsor-runner mcp serve-streamable-http` is the standard Streamable HTTP
  MCP path for app/server agents and SDK clients. It implements MCP
  initialize/session behavior on the `/mcp` endpoint.
- `synapsor-runner mcp serve-http` is an authenticated JSON-RPC bridge for
  simple `tools/list`, `tools/call`, and `resources/read` wrappers. It is not
  the standard Streamable HTTP MCP transport and prints a runtime warning when
  started.
- The OpenAI Agents SDK HTTP example uses the Streamable HTTP MCP path. Use the
  JSON-RPC bridge only when you intentionally want a thin app-owned wrapper.

### Writeback

- Direct SQL writeback is intentionally narrow: guarded single-row `UPDATE`
  only. It does not support arbitrary SQL, DDL, `INSERT`, `DELETE`, `UPSERT`,
  stored procedures, or multi-row writes.
- Direct SQL writeback reads the trusted writer connection from the source
  `write_url_env` in `synapsor.runner.json`, such as
  `SYNAPSOR_DATABASE_WRITE_URL`.
- `SYNAPSOR_DATABASE_URL` is accepted only as a legacy fallback for older
  direct worker/apply flows without a local config.
- Direct SQL writeback writes `synapsor_writeback_receipts` for idempotency and
  replay. Current releases require an administrator-created table and grant the
  trusted writer table access without schema `CREATE`.
- Use `synapsor-runner writeback doctor`, `writeback migration`, and
  `writeback grants` to inspect and prepare the direct writeback path.
- Use app-owned `http_handler` or `command_handler` executors for rich writes
  such as inserting credit rows, opening tickets, deleting records through app
  policy, or updating multiple related rows.
- `synapsor-runner handler template` writes starter Node/Fastify,
  Python/FastAPI, or command-handler files so rich writes can start from an
  app-owned transaction boundary instead of hand-writing a handler from
  scratch.

### Evidence And Replay

- Read-only capabilities produce scoped semantic tools, trusted context
  binding, evidence handles, query audit, and local inspection records.
- Proposal workflows add full local replay across evidence, approval,
  writeback jobs, execution receipts, and events.
- `synapsor-runner events tail` prints local lifecycle events from the SQLite
  ledger and can follow new proposal/writeback events while a local flow runs.
- `synapsor-runner events webhook` pushes those local lifecycle events to a
  local/dev/staging HTTP endpoint for review UIs or notifications without
  polling. It is not a hosted central ledger.
- MCP server modes write an active-store lease next to the local SQLite file.
  Destructive `store prune --yes` refuses while that lease points at a live
  process unless `--force` is provided.
- External Postgres/MySQL databases are not physically branched by Runner.
  Replay covers records captured by Runner; it is not external database
  time travel.

### Known Limitations

- This is an alpha local runner, not Synapsor Cloud, not the Synapsor DBMS, and
  not a generic MCP security platform.
- Runner does not expose model-callable approval, commit, apply, or raw SQL
  tools.
- Runner does not implement Synapsor Cloud workflow DAGs, native branches,
  auto-merge, settlement policies, hosted RBAC/SSO, hosted evidence retention,
  CDC, managed runner fleets, compliance exports, production SLA, or C++ DBMS
  internals.
- The local store is single-node SQLite for local/dev/staging usage.
- Node >= 22.13.0 is required because the local ledger uses Node's unflagged
  `node:sqlite` runtime. Use a supported Node runtime or the Docker-backed
  source demo path.

### Upgrade Notes From Earlier Alphas

- Public command examples now use `synapsor-runner`, not `synapsor`.
- Standard HTTP MCP examples now use `mcp serve-streamable-http`; `mcp
  serve-http` is documented as the JSON-RPC bridge.
- Direct SQL writeback docs now use `write_url_env` for writer credentials and
  document `SYNAPSOR_DATABASE_URL` only as a legacy fallback.
- Receipt-table permissions are now a documented writeback requirement.
- The quick demo is guided in interactive terminals, concise in noninteractive
  mode, and keeps the longer explanation behind `--details`.

## Stable Release Policy

Use untagged `@synapsor/runner` for stable installs. Use an exact prerelease
only when intentionally testing preview behavior. Stable `1.x` releases should
keep the compatibility promise documented in `docs/release-policy.md`.

The first stable `0.1.0` release was gated on:

- the README's npm commands match the published package;
- a clean temporary directory can run the quick demo, own-database onboarding,
  MCP config generation, smoke call, UI, and replay commands;
- stdio MCP and Streamable HTTP MCP are covered by tests and examples;
- direct and app-owned writeback requirements are documented and verified; and
- known limitations are still accurate.

For the local tarball before publish, run:

```bash
./scripts/verify-release-gate.sh
```

After publishing an alpha, verify the public package from a clean temporary
directory:

```bash
VERIFY_PUBLISHED_ALPHA=1 ./scripts/verify-release-gate.sh 0.1.0-alpha.17
```

After publishing/promoting stable `latest`, verify the stable channel:

```bash
./scripts/verify-published-stable.sh 0.1.0
```
