# Changelog

## 1.7.0 (prepared, not published)

### Production Scoped Explore Over Secured HTTP

- Adds an explicit read-only production Explore deployment over MCP Streamable
  HTTP. It serves only `app.describe_data` and `app.explore_data`; SQL,
  credentials, Protect, activation, approval, apply, and configuration remain
  outside the model-facing surface.
- Requires separately generated and reviewed production boundaries with trusted
  identity taken only from verified asymmetric JWT claims. Direct and derived
  tenant scope remains mandatory for tenant-owned rows; a human may separately
  review an exact tenant-independent table as a shared reference with no tenant
  predicate. Reviewed principal scope and per-principal privacy accounting remain
  enforced in both cases.
- Adds durable shared-Postgres privacy accounting with atomic principal and
  tenant reservations, rolling query/extraction/differencing limits, rate
  limits, and tenant-level complementary-release protection. Concurrent calls
  cannot both consume the final allowance.
- Reconciles rescans against each immutable boundary's own reviewed policy
  instead of destructively rebuilding or sharing resource overrides. Unchanged
  field, enum, path, shared-reference, metadata, metric, and limit decisions
  survive; changed schema, role, or trusted-context inputs fail closed for
  focused re-review without mutating overlapping boundaries.
- Fails startup closed without explicit opt-in, read-only mode, secured shared
  HTTP, required OAuth scope, exact JWT issuer/audience/claims, shared HMAC
  material, shared accounting, and current exact-digest production authority.
- Proves PostgreSQL and MySQL source execution through the official MCP client,
  including scope isolation, suppression, concurrency, source immutability,
  `doctor`, the public CLI entrypoint, and a clean packed installation.
- Proves a real Ollama `qwen2.5:7b` agent against both local Explore and the
  RS256/JWT-bound production HTTP MCP surface. Loopback model discovery,
  compact catalog guidance, strict benign argument normalization, intent-checked
  JSON-plan recovery, and Runner-owned fallback results improve small-model DX
  without widening the two-tool grammar or trusted scope.
- Extends deterministic Ask intent checks to official OpenAI and Anthropic
  adapters. Explicit unavailable-entity or grouping substitutions are refused
  before `app.explore_data`, consume no Explore query/differencing budget, and
  cannot be narrated as the requested answer. Canonical field IDs match in
  underscore, hyphenated, and readable forms; reviewer labels match exactly;
  and a bare trailing term can identify exactly one reviewed grouping field on
  the named resource, such as `shipments by mode` for `carrier_mode`. If the
  term also matches `delivery_mode`, Runner refuses before execution and names
  both choices instead of guessing. Adds bounded CLI/Workbench Ask
  token settings, including an in-session `/limits` update that preserves
  conversation context; these client-side spend/context controls remain outside
  reviewed database and privacy authority.
- Refuses ambiguous SQL-null filter literals with missing-data guidance, omits
  undated records from sequential metrics, restores MySQL session timezone
  before pooled reuse, and gives each Workbench relationship a separate
  labeled graph lane.
- Adds bounded reviewer-authored labels and descriptions as metadata-only model
  guidance, plus reviewed automatic quantile/equal-width numeric bands whose
  scoped edges are Runner-computed and never model-authored or exposed raw.
- Makes shape caps and statement timeout reviewed CLI/Workbench controls with
  product hard ceilings. Relationship and derived-scope depth remain two by
  default and can be raised independently only through an explicit reviewed
  opt-in to the absolute hard cap of three, with cost advisories intact.
- Qualifies that independence on live PostgreSQL and MySQL: a three-link
  model-facing analysis relationship is refused at the default analysis depth
  of two, returns exact results after only `max_analysis_relationship_hops` is
  reviewed as three, and remains capped below four while
  `max_derived_scope_hops` stays two.
- Reads production evidence and query audits from the shared PostgreSQL control
  store in CLI and Workbench, including for MySQL application sources, without
  persisting result values or revealing raw trusted scope. Generates secret-free
  Streamable HTTP setup for Claude Code, Cursor, and VS Code using environment
  token references and the exact two-tool surface.
- Keeps whole-organization databases simple through explicit boundary-wide
  single-organization review, while mixed databases can add only individually
  acknowledged shared-reference tables. Neither posture is inferred, and field
  visibility, cohort suppression, budgets, schema locks, and read-only checks
  remain unchanged.
- Leaves local/staging Explore, protected named capabilities, and existing
  boundary digests unchanged. Spec/DSL `1.9.0` add only the reviewed fixed
  aggregate operations and post-suppression transforms; they do not admit
  model-authored SQL or expressions.
- Keeps repeated shared-reference review previews digest-stable by separating
  reviewer provenance from database evidence, and makes signed headless
  activation confirm the exact post-review candidate decision set.
- Clarifies when a table is absent because the reviewed read role cannot see it,
  and gives an exact reviewed-limit remedy when a valid three-hop scope path is
  attempted under the default two-hop authority.
- Keeps source-checkout diagnostics usable when the ignored local Runner bundle
  is stale: help/version, `config validate`, metadata-only `inspect`, and
  `boundary status` run with an explicit warning, while authoring, activation,
  serving, and reviewed execution remain blocked until the bundle is rebuilt.
- Makes `production_explore.enabled` select the locked Streamable HTTP two-tool
  surface directly, while retaining `--production-explore` as an explicit
  generated launch marker. Enabled production configs now refuse incompatible
  transports instead of silently serving no tools, and `tools list` recognizes
  active local/production Explore-only projects without a false failure.
- Applies the same deterministic selection to local stdio Explore. Active
  read-only development/staging projects with no named capabilities now expose
  exactly `app.describe_data` and `app.explore_data` even through older
  config/store-shaped launch entries; new client configs and managed installs
  emit the explicit authoring command, and inactive projects refuse instead of
  producing a zero-tool server.
- Preserves explicit MySQL tenant/principal binding evidence through every
  CLI and Workbench review mutation, so the policy-neutral baseline and
  production generation lock cannot be reset during review. Production config
  scaffolding now carries reviewed bindings and requires an explicit tenant
  column for multi-tenant MySQL instead of producing an unusable setup.
- Activates independently reviewed saved boundaries against their own immutable
  review state and generation-lock snapshot instead of whichever boundary owns
  the project-global draft. CLI and Workbench can now add a second boundary
  without weakening shared schema, role, source, or trusted-context checks.
- Preserves exact configured tenant/principal binding candidates in the
  policy-neutral authoring baseline used to create additional MySQL boundaries.
  Only inspected non-null scalar columns named by explicit configuration become
  review candidates; implicit names, nullable or unsafe columns, and policy from
  another boundary remain excluded. A real production HTTP regression activates
  two overlapping MySQL boundaries, requires an exact selector, and routes both.
- Applies that policy-neutral MySQL baseline consistently through standalone
  `boundary draft`, guided CLI/Workbench startup, Workbench review reset, and
  reconciliation. A no-change rescan repairs an older empty private authoring
  baseline without changing the reviewed draft, overrides, active authority, or
  source database. Source checkouts also refuse to launch an unpublished
  `runner.mjs` bundle older than their TypeScript source, preventing stale local
  builds from masquerading as verification of current code. The Workbench now
  renders that same reconciliation report shape, distinguishes a private
  baseline repair from a reviewable authority change, and keeps its exact
  preview confirmation stable immediately after a review reset.
- Versions source-database grammar authority instead of assuming the newest
  engine. PostgreSQL 13-18 and MySQL 8.x expose the complete reviewed Explore
  grammar; MySQL 5.7 uses a supported limited tier with automatic bands and
  unreliable `CHECK`-derived vocabularies omitted in CLI, Workbench, locks, and
  MCP discovery. Below-floor PostgreSQL/MySQL and MariaDB fail before review or
  execution. Future unverified majors also fail instead of inheriting authority
  accidentally. Every draft, generation lock, and activated boundary records
  the exact detected version, resolved tier, and stable grammar authority;
  PostgreSQL major or MySQL 5.7/8.x changes fail closed until reconciling rescan
  and re-activation. The release matrix runs PostgreSQL 12 refusal, PostgreSQL
  13-18, MySQL 5.7/8.0/8.4, local MCP, and JWT-authenticated production HTTP.

Prepared package versions: `@synapsor/runner@1.7.0` and the optional
`synapsor-runner@1.7.0` command alias, plus `@synapsor/spec@1.9.0` and
`@synapsor/dsl@1.9.0`. No package is published by this change.

## 1.6.7 (published 2026-08-04)

### First-Run, Explore, And Privacy Review Corrections

- Completes fresh interactive setup inside the CLI by resolving source-proven
  identity and tenant scope in place, preserving existing config by default,
  and keeping blocked-table review in the active session.
- Makes common analytics operations and recovery paths discoverable: reviewed
  time coverage, provider defaults, shell history, access summaries, field-level
  refusal guidance, ranked aggregates, comparisons, distinct counts, and the
  latest-analysis Protect shortcut now behave consistently.
- Keeps privacy restrictions intact while making them operable. Cohort edits
  use plain language, default to saving the requested change, support a
  whole-boundary value, advertise pending inactive changes, and offer immediate
  exact-digest review and activation. Complementary releases remain blocked.
- Separates model prose, Runner-verified data, structured JSON, and redacted
  parameterized SQL in both operator surfaces. External MCP clients still
  receive neither SQL nor operator-only evidence.
- Tightens conservative name classification, withheld-domain egress,
  differencing accounting, conflict guards, PostgreSQL role posture, freshness
  expiry, worker fencing, and MySQL write deadlines without widening model
  authority.
- Adds packed first-run and human-PTY coverage alongside the full test,
  Workbench visual, compatibility, PostgreSQL, and MySQL gates.

Published package versions: `@synapsor/runner@1.6.7` and the optional
`synapsor-runner@1.6.7` command alias. Spec and DSL remain at `1.8.0`.

## 1.6.6 (published 2026-08-03)

### Repeated Safe Analytics And Host-Neutral Integration

- Repairs the all-blocked first-run path so Workbench shows every unresolved
  resource instead of an empty review, and makes Workbench/CLI resource review
  use one shared domain implementation. CLI review can resolve source-proven
  identity/scope, apply versioned multi-resource decision files atomically, and
  never activates authority.
- Makes Auto Boundary artifact replacement transactional and ownership-checked.
  Output, generation lock, review report, overrides, active authority, and
  review progress roll back together on a failed regeneration.
- Adds `try ask` over the same OpenAI, Anthropic, and loopback
  OpenAI-compatible provider/MCP engine as Workbench Ask. Provider keys never
  enter command arguments; exact egress consent, one-catalog authority,
  untrusted prose, verified tool traces, and authority-drift refusal remain
  enforced.
- Keeps Scoped Explore useful for repeated legal combinations after one human
  boundary review. Each successful execution gets an encrypted expiring local
  reference, but no DSL, contract, or named capability is created until an
  operator explicitly protects one selected result.
- Adds exact two-period analytical comparisons in one read-only repeatable-read
  snapshot, semantic measure/dimension aliases, reviewed UTC reporting
  authority, top/bottom-N, and explicit empty, fully suppressed, and incomplete
  comparison outcomes.
- Adds a separately reviewed candidate-group ceiling for high-cardinality
  top/bottom queries and ranked two-period movers. Runner validates the complete
  population, applies cohort suppression before ordering, returns only the
  reviewed top-N, and refuses partial rankings. Period movers support only
  signed absolute or percentage change, not model-authored expressions.
- Advertises shared analytical `outputSchema` contracts and a deterministic
  `synapsor.analytics-catalog.v1` MCP/CLI catalog pinned to exact active
  contract digests. The catalog excludes SQL, credentials, trusted-scope
  columns/values, kept-out fields, and generation-lock internals.
- Adds a packaged host-neutral TypeScript MCP client and conformance harness
  for stdio and authenticated Streamable HTTP. It discovers schemas/catalog
  authority, forwards typed legal/refused calls, exercises semantic
  reads/proposals, and proves approval/apply are absent.
- Expands conservative PHI classification and adds packed Retail and Healthcare
  clean-room journeys with real desktop/mobile Workbench interaction, repeated
  analytics, suppression, cross-tenant/principal isolation, stored-injection
  inertness, CLI/provider/MCP parity, optional Protect, production narrowing,
  and unchanged-source evidence.
- Keeps Auto Boundary's minimum cohort at 5 by default while allowing a human
  owner to record a reviewer-and-reason-bound override from 1 through 4.
  Threshold 1 is presented as disabling small-group suppression; effective
  values are marked in Workbench, `describe_data`, and the safe catalog, and
  Protect plus production activation require separate exact confirmations.
- Adds a reviewed third field-egress tier between model-visible and kept-out.
  Model-withheld fields remain usable by their reviewed operations, but Runner
  sends response-local opaque tokens to model providers and renders the real
  values only in its local verified result. The tier survives Protect through
  public `MODEL WITHHELD` DSL and canonical `model_withheld_fields`; protected
  MCP output marks affected columns `no_model_egress` and keeps full local
  values in non-model metadata. Model-facing catalogs retain reviewed type and
  legal-operation metadata but omit withheld enum/value domains.
- Makes privacy accounting atomic and durable. Every cohort-protected aggregate
  reserves against a stable source/scope/resource pool before execution;
  variants share a rolling 24-hour allowance across restart, UTC midnight,
  boundary revisions, plan-shape changes, and concurrent requests. Exact
  normalized replays reuse a differencing variant, while a complementary
  suppressed grouping and scalar total cannot both be released.
- New Auto Boundaries review a finite default of 16 distinct cohort-protected
  variants per root resource per rolling 24 hours. Existing boundaries retain
  their exact value, reviewers may narrow it, and changing plan families cannot
  create another allowance.
- Fails closed on unsupported row-hash write guards instead of silently
  applying without the reviewed conflict check, rejects PostgreSQL writers
  that can assume the target owner role, proves source uniqueness before an
  INSERT deduplication pre-read, and reports an ambiguous COMMIT as
  reconciliation-required rather than an ordinary failure.
- Treats qualified person-name columns as sensitive Auto Boundary inputs and
  leaves ambiguous display names unresolved for human review. Auto Boundary
  re-runs the current classifier and keeps the more restrictive result, so a
  stale inspection snapshot cannot preserve a former low-risk suggestion.
- Revalidates proposal freshness authority against the current reviewed policy
  before apply, requires exact fenced lease IDs on every worker terminal path,
  and gives MySQL writes a client-enforced pre-COMMIT deadline. A live MySQL
  trigger proof verifies timeout rollback of both the source row and receipt.
- Requires issuer and audience for OIDC operator identity, provides an atomic
  durable webhook replay-claim API, and isolates notification lease loss so one
  item cannot abort the claimed batch. Human CLI errors no longer begin with
  raw telemetry JSON, and bare non-TTY `boundary review` shows the concise map.
- Adds `/access` to the natural-language analytics shell so an operator can
  open the secured boundary editor after a refusal without giving the model
  review or activation authority. CLI result validation no longer treats a
  derived number such as a zero delta as fabricated merely because the literal
  zero was not present in an underlying result cell.
- Lets one local authoring session use up to eight independently reviewed
  active boundaries through the same two MCP tools. `app.describe_data`
  catalogs them and each `app.explore_data` plan selects exactly one; overlapping
  resource aliases require an explicit boundary and cross-boundary joins/unions
  remain impossible. Adding authority retains the configured provider and
  in-memory key, clears stale conversation, rebinds consent to the active-set
  digest, and shares privacy-budget history across boundaries.
- Repairs the model-withheld boundary-review CLI front door: previews now name
  the resolved column and exact requested tier, unknown columns fail with the
  inspected column list, and the one next command records the disabled
  decision. Adds a risk-first TTY table/column picker with the same mutation
  path as flags; explicit V/W/K controls distinguish model-and-Runner,
  Runner-output-only, and kept-out access. Styled focus states, back navigation,
  and a safe structural map make fields, operations, trusted scope, and reviewed
  relationships inspectable without saving or activating authority.
  `boundary draft` now keeps CLI users in that register by presenting
  `boundary review` as the primary next action and Workbench as an explicit
  visual alternative.
- Makes the boundary shape explicit in both review surfaces. Auto Boundary
  still inspects every deterministically reviewable table; full CLI and
  Workbench review now share one conservative disabled candidate of at most
  three related tables, while Quick Start remains an explicitly labeled
  one-table, zero-relationship fast lane. The default CLI map is a bounded
  explanation of active authority, the next disabled boundary, available
  tables, and useful proven paths; `--map --all` is the explicit exhaustive
  catalog. The TTY starts with boundary tables, reveals the full catalog only
  on request, shows below-fold counts, and uses conventional navigation and
  back keys. CLI and Workbench now identify this as one digest-bound named
  boundary pack containing multiple tables, rather than implying that each
  `schema.table` row is a separate boundary. Operators can rename the disabled
  next version, inspect the audit dimensions behind one table sign-off, inspect
  and stage table additions/removals, complete review, and disable active
  Scoped Explore from either surface. Disable preserves the next boundary,
  review decisions, protected capabilities, evidence, ledger, and source data.
  CLI and Workbench now use progressive disclosure: their first boundary view
  shows only the active and disabled-next versions, and opening the next version
  reveals its member tables and then its columns. Interactive disabled-draft
  edits use a default-yes save prompt after human identity, reason, and validated
  preview, so pressing Enter records the decision without a generated-command
  rerun; activation remains separate. Per-table access maps explain legal
  operations, trusted scope, and reviewed relationships:
  Runner-output-only fields may support separately reviewed local operations or
  joins while real values stay out of model requests; kept-out fields cannot be
  selected, filtered, grouped, joined, or aggregated.
- Adds a continuous terminal Quick Start to `start --cli`. A fresh project
  presents the same conservative one-table, zero-relationship candidate as
  Workbench; one default-yes human gesture records review, binds and rechecks
  the exact digest, activates local read-only Explore, and continues directly
  to model/MCP-client selection. With exactly one hosted provider configured,
  Runner skips the provider picker and the first submitted question confirms
  the displayed provider/model/origin egress review. Declining or failing
  eligibility opens the detailed editor. Models still cannot review, activate,
  widen, approve, or apply, and noninteractive/headless routes retain their
  exact verified-decision requirements.
- Proves the reviewed aggregate executor and evidence path against live
  PostgreSQL and MySQL fixtures, including trusted scope, read-only execution,
  count/sum/average, cohort suppression and its explicit threshold-1 override,
  audit/evidence records, timeout behavior, and absence of source mutation.
- Preserves published 1.5.4, 1.6.0, 1.6.3, and 1.6.5 contract digests,
  generated projects, CLI routes, and tool surfaces. The authorized Spec and
  DSL source change additively accepts explicit `minimum_group_size: 1`
  without changing defaults or legacy normalization.

Published package versions: `@synapsor/runner@1.6.6`, the optional
`synapsor-runner@1.6.6` command alias, `@synapsor/spec@1.8.0`, and
`@synapsor/dsl@1.8.0`. Spec/DSL 1.8.0 add the canonical model-withheld egress
tier, explicitly reviewed minimum cohort 1, a separate ranked-candidate group
ceiling, and absolute/percentage comparison-change ordering. These additions
preserve legacy normalization and digests when omitted.

## 1.6.5 (published 2026-07-26)

### Managed Claude Code and VS Code project MCP installs

- Extends Runner's reviewed project MCP lifecycle from Cursor to Claude Code
  and VS Code. `mcp install`, `mcp status`, and `mcp uninstall` now manage only
  Runner's project-local entry in `.mcp.json` or `.vscode/mcp.json`.
- Preserves unrelated servers and settings, creates backups, pins the exact
  Runner package version, tracks ownership with an integrity marker, refuses
  tampered or unowned entries, and keeps credentials and trusted scope out of
  client configuration.
- Preserves VS Code JSONC comments and trailing commas. Static status and a
  real optional stdio `tools/list` launch check prove that each client receives
  the same reviewed model-facing authority.
- Makes onboarding, Workbench guidance, README positioning, host recipes, and
  `doctor` client-neutral while retaining the existing Cursor lifecycle and
  `--check-cursor` compatibility.

Published package versions: `@synapsor/runner@1.6.5` and the optional
`synapsor-runner@1.6.5` command alias. `@synapsor/spec@1.7.0` and
`@synapsor/dsl@1.7.0` remained unchanged.

## 1.6.4 (published 2026-07-25)

### Review-correct onboarding and reviewed relationship paths

- Repairs generated-boundary review state so edits invalidate only dependent
  confirmations, stale browser revisions fail compare-and-swap checks, and
  unrelated reviewed decisions survive. Secure headless activation now uses the
  same exact-digest/operator boundary as Workbench.
- Reworks the first Workbench experience around a small starter resource pack,
  clearer plain-language authority and source-change status, stable
  progressive disclosure, managed identity/scope decisions, and one primary
  next action. Nested-project config discovery and resume behavior no longer
  force a developer to rediscover paths or restart review.
- Adds a no-argument first-run path that accepts the database URL through a
  hidden terminal prompt or explicitly confirmed, key-specific environment-file
  discovery. A conservative local-development fast lane reaches a real safe
  read with at most two plain questions and one recorded exact-digest human
  gesture, without exporting the URL or editing generated files.
- Tightens deterministic sensitive-field classification across unfamiliar
  schemas and combines database, Prisma, Drizzle, OpenAPI, and existing
  Synapsor evidence without an LLM. Ambiguous identity/scope and high-risk
  fields stay blocked or kept out for human review.
- Adds public, additive reviewed relationship paths for protected aggregate
  reads: up to three activated paths, each containing one or two
  catalog-proven many-to-one links with fan-out one. The model may reference an
  active path by name but cannot supply identifiers, join semantics, or
  activation.
- Adds demand-driven relationship review. A plan requiring an inactive proven
  path fails closed, Workbench stages that exact proof for an operator, nullable
  links require an explicit `EXCLUDE` or `KEEP NULL` choice, and a new digest is
  required before retry.
- Enforces trusted tenant/principal scope on every participating relation,
  suppression after final grouping, generation-lock/catalog-proof drift, and
  permanent rejection of one-to-many, many-to-many, ambiguous-cardinality,
  over-depth, and model-improvised joins. Complex formulas and relationship
  graphs remain on reviewed database views.
- Adds clean-room Community Solar and Retail onboarding/PM-analysis journeys,
  plus live PostgreSQL/MySQL star/depth-two, nullable-link, drift, privacy, and
  deliberately wrong fan-out tests. Published `1.6.3` contracts, digests,
  startup routes, and tool surfaces remain byte-compatible unless the new
  feature is explicitly adopted.
- Adds optional local Workbench Ask over the exact reviewed MCP/runtime tool
  surface. OpenAI, Anthropic, and custom OpenAI-compatible adapters use
  digest-bound direct-egress consent, in-memory credentials/history, fixed
  size/time/tool/token bounds, escaped model output, and proposal-only writes;
  the no-model composer remains complete and enabled by default.
- Hardens provider endpoints with fixed official origins, remote HTTPS,
  loopback-only plaintext, redirect refusal, per-connection DNS validation and
  address pinning, private/special destination refusal, and redacted failures.
  The pinned lookup supports Node 22's multi-address callback shape.
- Extends both packed clean-room labs through the actual Ask UI. Retail visibly
  refuses a kept-out customer-note aggregate, and Community Solar proves a
  proposal cannot commit. An owner-authorized live OpenAI `gpt-5-mini` run
  matched official MCP results and passed exact-key artifact/browser scans;
  Anthropic and generic compatible claims remain protocol-scoped.
- Uses direct `npx` only for first acquisition and the installed
  `synapsor-runner` binary afterward. The optional unscoped command package is a
  version-locked delegate with no independent runtime or authority logic;
  explicit pinned and automation invocations remain compatible.
- Adds one local, escaped, copy-exact DSL syntax highlighter for every
  Workbench DSL preview, with no CDN or unsafe HTML path, and gives activity,
  review, and apply detail the full available width on desktop and mobile.
- Published `@synapsor/runner@1.6.4`, `@synapsor/spec@1.7.0`,
  `@synapsor/dsl@1.7.0`, and the optional `synapsor-runner@1.6.4` command
  alias.

## 1.6.3 (published 2026-07-24)

### Guided adoption without weaker authority

- Turns a fresh interactive
  `npx -y @synapsor/runner@latest start --from-env DATABASE_URL` into one
  resumable journey: metadata-only inspection, conservative classification,
  disabled project generation, review-by-exception in the loopback Workbench,
  exact-digest activation, a real bounded read, and host-neutral MCP setup.
- Generates the complete local project without requiring hand-edited DSL, JSON,
  config, store paths, DDL, or grants for the reference development journey.
  Existing selectors, automation, headless startup, hand-authored projects,
  active contracts, and tool lists retain their prior behavior.
- Adds no-ID, project-aware CLI paths for trying active named tools, bounded
  row/aggregate exploration, protecting a successful analysis, guided action
  authoring, proposal review, apply, receipt, replay, and compensation.
- Reworks Workbench onboarding around one plain-language boundary summary,
  conservative defaults, unresolved exceptions, one primary next action, and
  progressive disclosure of DSL, canonical JSON, digests, role posture, and
  generated tests.
- Adds a guided write-action flow that drafts public DSL, canonical JSON,
  tests, policy limits, conflict guards, receipt mode, and optional reviewed
  compensation. It never derives business write authority from schema and
  never activates, approves, or applies for the human.
- Adds the FitFlow 30-50-table packed-artifact acceptance journey, including
  first read, PM-style aggregate Explore, Protect, proposal, bounded policy
  approval, guarded writeback, receipts/replay, compensation, host parity,
  privacy gates, and source-unchanged assertions before commit.
- Documents the full `APPROVAL ROLE` lifecycle from contract requirement
  through external IdP claims and a verified immutable decision. A separate
  local OIDC/JWKS issuer proves accepted reviewer/applier roles, role
  separation, key rotation, and rejection of missing/similar roles, bad or
  unknown signatures, expired/not-yet-valid tokens, wrong issuer/audience,
  malformed claims, proof tampering, and cross-proposal replay.
- Adds default-off operator-supervised automatic apply as a separate execution
  axis. Contract permission plus an independent deployment allowlist must match
  one exact digest; old `AUTO APPROVE` remains manual-apply. Eligible
  single-row INSERT/UPDATE work reuses guarded apply and repeats policy, limit,
  scope, target/supporting-evidence freshness, writer-posture, receipt, and
  lease checks before every execution.
- Adds durable redacted human-attention events and a coalesced Workbench inbox
  for proposal, worker, boundary, schema, credential, policy, and sensitive
  override lifecycle. A separately operated dispatcher supports quiet
  per-sink routing, budgets, cooldowns, digests, JSONL development output, and
  signed HTTPS webhooks. Notifications are disabled by default and never
  authorize approval or mutation.
- Binds dead-letter notification replay to a fresh verified signed-key or OIDC
  operator decision over the exact delivery revision and reason. Replay
  requeues only the immutable redacted event, records `notification.replayed`,
  and cannot replay approval or source mutation. The packed gate exercises two
  competing dispatchers, zero default success noise, duplicate suppression,
  metadata-endpoint SSRF refusal, and event-only replay with an unchanged
  source snapshot.
- Adds pause/drain, exact-digest enable/disable/revoke, queue cancellation,
  dead-letter, UNKNOWN/reconciliation, writer-posture, and optional required
  attention-sink controls outside MCP. Fenced leases, limit reservations,
  duplicate-consumption, process-death, known-commit, and ambiguous-outcome
  paths retain the established fail-closed behavior.
- Makes CLI failure output recovery-oriented and keeps supported `--json`
  failure paths to one parseable document with redacted diagnostics on stderr,
  preserved-state information, source-change status, and one next action.
- Allows an explicit empty canonical `capabilities` array to represent a
  validated zero-authority review draft and adds the optional canonical
  `execution.supervised_worker` permission plus its public DSL clause. This
  additive behavior is staged as `@synapsor/spec@1.6.0` and
  `@synapsor/dsl@1.6.0`; legacy contracts retain their exact normalization and
  digests.
- Published `@synapsor/runner@1.6.3`, `@synapsor/spec@1.6.0`, and
  `@synapsor/dsl@1.6.0`.
- The clean Runner tarball gate used the locally packed public Spec before the
  coordinated release, then returned to the stronger registry-only
  dependency-resolution proof once npm had that exact Spec.

## 1.6.2 (published 2026-07-23)

### Registry-installable packaging hotfix

- Keeps Runner linked to the local `@synapsor/spec@1.5.0` workspace during
  development while requiring pnpm to transform that dependency to the public
  `^1.5.0` range in the release tarball.
- Adds a `prepublishOnly` fail-closed guard that rejects `npm publish` and
  requires `corepack pnpm publish`. It also rejects unexpected `workspace:`,
  `file:`, `link:`, `portal:`, absolute-path, or incorrect Spec dependencies.
- Changes the packed Runner release gate to inspect pnpm's actual transformed
  tarball manifest and install that tarball by itself from a clean project.
  This reproduces the public `npx` dependency-resolution path instead of
  masking it with a simultaneously packed local Spec.
- Contains the same proposal/evidence freshness runtime behavior prepared in
  `1.6.1`; this patch changes packaging and version surfaces only.
- Published only `@synapsor/runner@1.6.2`. `@synapsor/spec@1.5.0` and
  `@synapsor/dsl@1.5.0` remain unchanged.

## 1.6.1 (published 2026-07-23; install-broken)

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
- Published with `@synapsor/spec: "workspace:^"` in the registry manifest,
  causing clean npm/npx installs to fail with `EUNSUPPORTEDPROTOCOL`.
  Superseded by the `1.6.2` packaging hotfix and should remain deprecated.

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
