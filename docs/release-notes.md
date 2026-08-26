# Release Notes

These notes track public Synapsor Runner behavior. Starting with `1.0.0`, the
documented production-loop compatibility line uses the untagged stable package:

```bash
npx -y @synapsor/runner demo --quick
```

The OSS runner command is `synapsor-runner`. The `synapsor` command is reserved
for the Synapsor Cloud CLI.

## 1.7.14 (unreleased)

### Explore Plan Playground

- Adds the CLI-first `explore playground`, `explore describe`, `explore
  validate`, and `explore run` workflow for inspecting, compiling, and replaying
  one fixed `app.explore_data` JSON plan without a model. It accepts a raw plan
  or the exact `{plan, boundary?}` MCP envelope, never SQL or caller-supplied
  tenant/principal scope.
- Local validate-only repeats catalog, role, generation-lock, trusted-scope,
  reviewed-authority, complexity, relative-window, and SQL compilation checks.
  It executes no source data query, consumes no Explore budget, and writes no
  evidence or query audit. Its SQL preview contains placeholders and parameter
  types, never values.
- Local run uses the normal Explore execution path with drift checks, scope,
  suppression, response bounds, rolling budgets, evidence, and query audit.
  `explore workbench` opens its preview code editor directly, with highlighted
  JSON, line numbers, format controls, and placeholder-only SQL from the same
  shared validator and runner.
- Production HTTP replay reads a short-lived token only from an environment
  variable and calls the existing `app.explore_data` tool through authenticated
  Streamable HTTP. Verified JWT claims remain the only tenant/principal source;
  no third MCP tool or remote dry-run surface was added.

### Semantic Model Output By Default

- Model-visible MCP output now defaults to semantic authority metadata. Exact
  Runner digests, fingerprints, hashes, and query-audit hashes remain available
  to operators and internal checks but are omitted from tool results, tool
  discovery metadata, and model-readable resources.
- Reviewed identifiers, labels, operations, outcomes, privacy decisions,
  released data, and opaque evidence-resource handles remain available. Source
  data is opaque to this policy, so business columns or values that resemble a
  hash are not altered.
- Use `synapsor-runner config model-output --authority-metadata exact` for a
  diagnostic or digest-pinning client, and switch back with `semantic`. The
  setting changes presentation only: no review or activation is required, and
  evidence/query-audit records keep their exact metadata in either mode.

Package versions: `@synapsor/runner@1.7.14` and
`synapsor-runner@1.7.14`. Spec and DSL remain `1.10.0` because this release
reuses the existing public Explore plan grammar.

## 1.7.13 (published 2026-08-24)

### Safe Errors On Every MCP Path

- Legacy result-format-v1 tools now preserve their existing public error codes
  and retry metadata without returning raw exception messages. Database URLs,
  relation names, SQL text, hosts, credentials, and driver details remain
  inside Runner.
- Proposal, evidence, and replay resource reads now preserve the generic
  ownership-safe not-found response and fail with a generic public error for
  unexpected local or shared-store failures.
- The final HTTP request boundary now replaces unexpected readiness, metrics,
  session, SDK, and JSON-RPC exceptions with a fixed safe message. The
  deliberate missing-tool-name, missing-resource-URI, unsupported-method, and
  request-size guidance remains specific.
- Official MCP client tests cover local server composition and Streamable HTTP
  with hostile PostgreSQL, MySQL, and SQLite exception strings. Result envelope
  v2 and production Explore behavior remain unchanged.

### Exact Operator SQL Shape Without Values

- New Explore evidence and query-audit records retain the parameterized SQL
  statement shape that Runner handed to the source driver. Operator detail now
  shows the actual reviewed JOIN and scope structure instead of a guarded
  approximation.
- SQL parameters, trusted identities, result values, credentials, and URLs are
  never included. The model-facing result and evidence/replay resources strip
  operator SQL, and legacy records continue to use a clearly labelled
  non-executable audit template.

Package versions: `@synapsor/runner@1.7.13` and
`synapsor-runner@1.7.13`. Spec and DSL remain `1.10.0` because this patch adds
no public plan grammar.

## 1.7.12 (published 2026-08-22)

### Explore Information Flow And CLI Output

- Keeps Runner-only values out of the entire serialized MCP result, adds
  atomic related-predicate accounting for direct subtraction attempts, and
  documents the distinction between output redaction and operation authority.
- Restores terminal state after interactive audit browsing, suppresses only
  Node's SQLite experimental warning in published launchers, localizes human
  audit timestamps, and renders reconstructed queries as fail-closed SQL
  templates. Exact ledger timestamps and machine exports remain unchanged.

Package versions: `@synapsor/runner@1.7.12` and
`synapsor-runner@1.7.12`. Spec and DSL remained `1.10.0`.

## 1.7.11 (2026-08-21)

### Useful Ask With The Same Reviewed Boundary

- Local `synapsor>` Ask now treats its intent check as a semantic contradiction
  guard, not a second authorization grammar. It still refuses a plan that names
  another reviewed resource or field, an ambiguous correction, an unrequested
  grouping, a relationship substitution, an enum conflict, or a row count in
  place of a requested distinct count. Unknown domain wording alone may proceed
  through the ordinary Explore validator and all of its scope, suppression,
  drift, and budget controls. OpenAI and Anthropic use the same logic.
- Each boundary now has a local Ask plan-check mode. `Balanced` remains the
  default. `Boundary only`, selected with `T` in the terminal boundary editor
  or from Workbench, completely skips the English question-to-plan comparison
  while preserving the full reviewed Explore validator and compiler. The
  preference is local, per boundary, requires no activation, and cannot affect
  MCP or production HTTP Explore.
- Single-organization CLI and Workbench review now state that the fixed reviewed
  organization needs no tenant column or predicate. Multi-tenant remediation is
  no longer shown for those boundaries.
- Reviewers can explicitly enable exact grouping for eligible scalar fields with
  `X`, Workbench, or `--allow-exact-grouping`. This includes numeric, date/time,
  UUID, boolean, enum, and explicitly reviewed text fields without changing or
  casting the source datatype. Identity, reference, scope, sensitive, binary,
  and structural fields remain refused. A datatype change removes the grant for
  explicit re-review. Existing 1.7.1 numeric flags and review artifacts remain
  compatible.
- Terminal model interpretations render bounded bold emphasis without printing
  Markdown stars. `NO_COLOR` and non-TTY output remain plain text.
- Boundary-editor key hints now include the available setting, its current
  on/off or mode state, and a short purpose without requiring the operator to
  discover hidden controls.
- `config init --force` now performs the overwrite its earlier recovery message
  advertised. Runner first saves the prior config to a timestamped `.bak` path
  and reports that path. The default remains refusal without explicit `--force`.
- Human evidence and query-audit lists, browsers, and detail views show readable
  UTC dates. Stored ledger records, JSON output, exact filtering, and exports
  retain their original ISO timestamps.

Package versions: `@synapsor/runner@1.7.11` and
`synapsor-runner@1.7.11`. Spec and DSL remain `1.10.0` because this patch adds
no public plan grammar.

## 1.7.1 (published 2026-08-20)

### Ask Compatibility And Upgrade Recovery

- The `synapsor>` terminal Ask path now defaults OpenAI to `gpt-5.6-luna`
  when `--model` is omitted. This applies to `try ask`, guided CLI startup,
  provider selection, and post-activation resume guidance. An explicit
  `--model` remains authoritative, and Workbench Ask keeps its separate default.
- Ask now distinguishes a true multi-resource substitution from a permission
  or catalog limitation. In a one-resource boundary it no longer claims that
  the model swapped resources. An exact kept-out or non-authorized distinct
  field receives the real **Count unique** review path, while an unavailable
  entity is reported as unavailable. Natural recent-week/month comparison
  wording can identify the only reviewed time field without requiring the user
  to recite its database identifier. Every intent refusal still happens before
  source execution and privacy-budget accounting.
- Ask now accepts a conservative typo only when one reviewed resource, field,
  label, enum value, or relationship dimension is the unique correction.
  Polite `show me`/`give me`/`tell me` phrasing no longer becomes a false
  entity. Exact contradictions and ambiguous corrections still refuse before
  source execution or budget accounting. A correctable mismatch receives one
  bounded provider retry with a versioned exact-ID correction contract and a
  separate provider instruction. The model must author the corrected plan;
  Runner never rewrites it, and a second mismatch receives no additional retry.
- Valid Runner-managed projects created through standalone `boundary draft`
  and `boundary review` can now resume and reconcile through `start` even when
  they have no guided-onboarding marker. A lone disabled legacy review that has
  no surviving resource has a guarded CLI and Workbench reset. It refuses
  active or multi-boundary projects and preserves config, local ledger/evidence,
  and source data before printing the exact redraft command.
- Official OpenAI Ask now uses the native Responses API and its function-call
  protocol, including the current reasoning-model request shape, with
  `store: false` on every request. Anthropic
  remains on the native Messages API with `tool_use`/`tool_result`. Custom
  OpenAI-compatible endpoints retain Chat Completions compatibility. Structured
  provider `400` messages are bounded and redacted before display; credential,
  permission, and quota response bodies remain hidden.
- `app.describe_data` now exposes an explicit semantic contract for every
  model-facing field: exact plan ID, reviewed label/description, semantic
  status, legal operations, and bounded enum values. The first resource index
  remains compact; focused resource/relationship descriptions carry the full
  grammar, and paged indexes tell clients to follow `next_cursor` before
  concluding that a reviewed resource is unavailable. Clearly opaque identifiers
  such as `dim_a`, `c7`, or `val_1` require reviewed vocabulary before a new
  activation, while `doctor` identifies legacy active gaps. Exact IDs remain the
  only plan authority, and local stdio and production HTTP return the same
  metadata.
- Schema-proven categorical codes such as `P1 | P2 | P3` are no longer claimed
  to be descriptive vocabulary. They are reported as `coded_values` with a
  non-blocking `review_advised` status in local and production catalogs, CLI,
  Workbench, and `doctor`. Ask will not map business language onto an unlabelled
  coded field; exact field IDs and exact codes remain available, so this does
  not widen or remove reviewed authority.
- Ask now treats a named reviewed enum value as an exact filter intent, except
  when the question explicitly compares categories and therefore requires the
  enum dimension. It refuses one-sided category comparisons plus wider or
  ambiguous filter sets before execution, and gives OpenAI/Anthropic one bounded
  correction. Magnitude questions without reviewed numeric bands report the
  missing band/path authority instead of substituting another field. Ungrounded
  provider prose is discarded unless a reviewed Explore plan succeeds. Generic
  row wording such as `cases` no longer becomes
  a false missing-resource error, unqualified trends are steered to a grain that
  fits reviewed coverage/group limits, and access guidance no longer matches a
  one-character draft field inside an unrelated word.
- CLI and preview Workbench expose the same recovery and Count unique actions.
  Deterministic regressions cover native OpenAI and Anthropic tool round trips,
  provider error secrecy, standalone-project resume/rescan, guarded reset, and
  intent behavior.
- Numeric columns remain non-groupable by default, but a human reviewer can now
  enable exact grouping for one eligible low-risk field through `/access`,
  Workbench, or the additive `--allow-exact-numeric-grouping` flag. Identity,
  reference, tenant/principal, sensitive, and unavailable fields are refused.
  The change is actor/reason audited, stays disabled until exact-digest
  activation, creates no numeric band, and retains every cohort, group,
  response, timeout, query, extraction, and differencing bound.

Prepared package versions: `@synapsor/runner@1.7.1` and
`synapsor-runner@1.7.1`, plus `@synapsor/spec@1.10.0` and
`@synapsor/dsl@1.10.0`. Generated boundary compiler authority
remains `1.7.0`, so installing this patch does not itself require a rescan. No
package is published by this change.

## 1.7.0 (published 2026-08-17)

### Production Scoped Explore Over Secured HTTP

- Operators can now serve a separately reviewed production Explore boundary
  over secured MCP Streamable HTTP for genuinely ad-hoc read-only analytics.
  The remote model surface remains exactly `app.describe_data` and
  `app.explore_data`.
- Every request requires a verified asymmetrically signed JWT and uses the
  principal as the privacy/rate identity. Runner injects direct or derived tenant
  scope for tenant-owned rows and adds reviewed principal row filtering. An exact
  tenant-independent table may omit only its tenant predicate after explicit
  shared-reference review. Prompts and tool arguments cannot select any scope.
- Shared Postgres accounting atomically enforces per-principal and tenant query,
  extraction, differencing, complementary-release, and rate limits across
  replicas. One principal cannot starve another; concurrent requests cannot
  both spend the final allowance.
- New boundaries use product-scale throughput defaults of 1,000 queries per
  rolling 24 hours and 120 requests per minute while retaining the 4,000-cell,
  16-variant, cohort, and suppression disclosure defaults. CLI and Workbench
  show detailed operator usage, warn at 80 percent, and provide reviewed
  query/rate controls. Differencing status now names its root-resource pool and
  explicitly states that token renewal, reconnects, and restarts do not reset it;
  compact result metadata retains bounded budget status, never identity or
  credential values.
- Production and local audit history is now searchable from CLI and Workbench
  by plaintext-or-keyed tenant/principal, resource, boundary digest, outcome,
  and time range. `query-audit` shows refusals and failures as well as releases;
  `evidence` shows released-result proof. Interactive browse, bounded JSON,
  live NDJSON follow, and complete metadata detail require no raw SQL against
  the control ledger and never persist or echo raw trusted-scope values.
  Plaintext production scope filters now refuse when their configured HMAC key
  is unavailable instead of returning unfiltered or ambiguous empty output.
  Detail views group the auditor-critical fields and reconstruct a privacy-safe
  SQL-like reviewed query with explicit Runner scope application; it remains
  non-executable metadata, with keyed placeholders rather than stored values.
- Per-query drift checks now fetch complete catalog metadata only for exact
  generation-lock dependencies while retaining fresh global credential,
  read-only, grant, and ownership checks, dependency-scoped RLS proof, and the
  whole-database single-organization tenant/RLS guard. Draft/rescan discovery
  remains whole-schema, and no per-query inspection is cached.
- Rescan now reconciles curated boundaries instead of regenerating them from
  scratch. Unchanged field policy, enum choices, derived paths, shared-reference
  acknowledgements, reviewed metadata, metrics, and limits survive; only
  decisions whose schema, role posture, or trusted-context inputs changed are
  invalidated. Human policy is stored per immutable boundary ID, so reviewing a
  shared table in one boundary cannot mutate another boundary.
- Generated boundary authority now records compiler version `1.7.0`; boundaries
  from the `1.6.6` compiler require one reconciling rescan and explicit
  re-activation. The rescan preserves existing field and scope policy rather
  than widening it. Bounded enums and structured scalar foreign keys are no
  longer described as free text solely because a name contains `note`; the
  review UI marks genuinely unresolved fields as **Needs review**.
- New drafts conservatively keep out common government and institutional
  identifiers such as `licence_number`, `license_no`, passport and
  national-insurance identifiers, and `badge_number`. This metadata-only rule
  does not inspect source values and does not blanket-classify ordinary order,
  invoice, or tracking references as sensitive; reviewers remain responsible
  for opaque names the source schema cannot explain.
- Rescan output now distinguishes preserved reviewed authority from internal
  confirmation-record storage. It reports retained tables, reviewed paths, and
  field policies, and presents changed multi-hop relationships as readable table
  and join-column chains in the CLI and Workbench before showing the copyable path
  ID.
- Access summaries now count fields from the effective reviewed policy rather than
  sensitivity classification alone. Model-visible, Runner-only, and kept-out counts
  therefore cover every inspected field, including low-risk fields an operator kept
  unavailable explicitly.
- Production Explore is off by default and fails closed without read-only mode,
  exact production authority, verified issuer/audience/claims and OAuth scope,
  direct TLS or a trusted TLS proxy, shared HMAC material, and initialized
  shared accounting.
- Reviewed normalized child tables may derive tenant or principal scope through
  an exact non-null, catalog-proven many-to-one path. Runner injects that path
  as a mandatory scope predicate outside model arguments for every plan shape.
- A config-declared principal binding can seed an exact matching non-null source
  column into a disabled per-boundary review. CLI and Workbench can review a
  direct column or derived path, while activation and all trusted principal
  values remain outside the model.
- Config-first production Explore scaffolding now requires an explicit
  `--engine postgres|mysql` instead of silently defaulting to PostgreSQL. When a
  source environment value is available, direct tenant/principal bindings are
  checked against read-only schema metadata with actionable warnings;
  `--verify-bindings` makes connectivity or binding defects fail before the
  zero-authority config is written. Offline generation remains silent when the
  source variable is unset.
- The focused `/access` editor keeps activation and deactivation inside the
  editor. Table-level `R` is explicitly **Remove from draft**, boundary-level
  `D` is **Deactivate active boundary**, zero active boundaries remain a normal
  recoverable state, and provider handoff is deferred until the operator exits
  access review. Table removal now reports and blocks reviewed scope or metric
  dependencies without leaving `/access`; a persistent red/yellow panel names
  the dependency and leaf-first remediation, and removal never silently cascades
  authority. The terminal CLI is the preferred operator interface for this
  release; the browser Workbench remains available as a preview UI.
- Reviewed analytics now include contributor-safe standard deviation and
  variance, missing-data measures, additional calendar grains, fixed numeric
  bands, named ratios, and post-suppression running/rank/lag/moving-average/share
  operations. The model selects only reviewed names and never supplies formulas,
  SQL, window frames, or bucket edges.
- Reviewers can add bounded labels and descriptions to resources and fields
  without changing authority. Reviewed numeric fields can also opt into safe
  automatic quantile or equal-width banding; the model selects only a reviewed
  method and bucket count, while Runner computes scoped edges and never returns
  raw quantile edges.
- Rows and aggregates can use a fixed reviewed relative-time vocabulary such as
  `previous_month`, `last_30_days`, and `month_to_date`. Runner captures one
  instant, resolves one half-open range under the boundary's reviewed UTC
  authority, compiles only bound timestamps, and records the resolution for the
  operator and audit trail without returning it to the model. Relative and
  equivalent absolute ranges share differencing accounting; Protect freezes the
  resolved range rather than creating a dynamic date capability.
- A reviewer may add total or average child-count measures through one exact
  non-null child-to-parent catalog proof. Runner uses a correlated scoped
  subaggregate instead of a one-to-many join, applies tenant/principal scope to
  the child independently, and releases only parent cohorts of at least five.
  Child-count Protect conversion stays refused until protected contracts can
  freeze that inverse authority.
- Explicit single-organization mode covers whole-organization databases without
  fake tenant columns. Mixed databases can instead add an eligible global catalog
  or reference table through an audited Shared reference choice. Runner never
  infers either posture; field controls, suppression, budgets, principal scope,
  schema locks, and read-only execution remain enforced.
- `doctor` now checks live PostgreSQL and MySQL index metadata for every active
  derived-scope path. Missing supporting indexes are advisory warnings or notes
  with reviewable `CREATE INDEX` suggestions; they never weaken or gate scope.
- Shape and execution controls such as ranked rows, groups, response cells,
  response bytes, measures, dimensions, and statement timeout are editable only
  through reviewed CLI or Workbench policy with product hard ceilings. Derived
  and analysis paths still default to two hops; a separately reviewed opt-in can
  raise either authority to the absolute hard cap of three, with path-cost and
  denormalization guidance kept visible to operators.
- Production evidence and query audits are readable through the same CLI and
  Workbench views from the shared PostgreSQL control store, including when the
  reviewed source is MySQL. Reads identify ledger provenance, preserve keyed
  scope redaction, and never persist result values. Claude Code, Cursor, and VS
  Code receive secret-free Streamable HTTP configurations that reference bearer
  tokens through environment variables and retain the exact two-tool surface.
- Real PostgreSQL and MySQL HTTP journeys verify official MCP interoperability,
  row scope, suppression, budget isolation, concurrency, source immutability,
  public `doctor` attestation, and packed-package behavior.
- A real Ollama `qwen2.5:7b` run verifies both local Ask and the secured
  production HTTP path. Runner discovers bounded loopback model IDs, gives weak
  models a compact reviewed catalog and one exact plan example, tolerates only
  benign optional-argument serialization differences, and refuses a plan that
  does not match the question before source execution. When the local JSON-plan
  rescue is needed, Runner renders the verified result without asking the weak
  model to reinterpret its values.
- The same pre-execution intent guard now covers built-in OpenAI and Anthropic
  Ask. A model cannot answer a question about an unavailable entity by silently
  running a different reviewed table or grouping: Runner returns
  `ASK_PLAN_INTENT_MISMATCH`, executes no Explore query, spends no Explore query
  or differencing budget, and never gives the substituted result back to the
  provider for narration. The matcher accepts an exact reviewed identifier in
  underscore, hyphenated, or readable form, accepts reviewer-authored labels,
  and resolves a bare trailing grouping term only when it identifies exactly
  one reviewed field on the named resource. Thus `shipments by mode` can select
  `carrier_mode`, while the same question refuses and names both choices if
  `delivery_mode` is also reviewed. Ask's cumulative provider-reported token budget and
  per-call output request are bounded operator settings in CLI and Workbench;
  `/limits` can raise them without clearing the current conversation. These
  client controls do not change reviewed database or privacy authority.
- Explore's compact tool guidance includes copyable enum-filter, ranked-query,
  and relative-comparison shapes. A malformed `filter(s)`, aggregate `limit`, or
  comparison partner remains refused by the strict grammar, while the refusal
  points to the canonical `where`/`op`, `top_n`, or
  `comparison`/`compare_to` keys for a bounded retry.
- If a model leaves the relationship off a grouped field that is available
  through one reviewed path, Runner executes nothing and returns the exact
  corrected dimension with that path ID. Multiple matching paths remain an
  explicit refusal. This applies through the reviewed three-hop ceiling and to
  count-only categorical child tables.
- CLI and Workbench boundary edits persist their selected library revision
  atomically with review progress, preventing an already-activated revision from
  being reported as a pending edit. CLI help and previews also show the reviewed
  `--principal-scope-path` option for derived principal scope.
- Explore refuses ambiguous SQL-null filter literals with guidance to reviewed
  missing-data measures. Sequential metrics omit undated records, MySQL restores
  pooled session timezones, and Workbench relationship labels use separate graph
  lanes instead of overlapping.
- Source-server authority is now versioned and capability-gated. PostgreSQL
  13-18 and MySQL 8.0.16+ receive the complete reviewed grammar. MySQL
  8.0.11-8.0.15 omits unenforced `CHECK` vocabularies; MySQL 5.7 also omits
  automatic bands before review
  and model discovery. PostgreSQL 12 and older, pre-5.7 MySQL, prerelease
  servers, MariaDB, and unrecognized or future unverified products fail before
  authority can run. A
  live matrix verifies PostgreSQL 13-18, MySQL
  5.7/8.0.11/8.0.15/8.0.16/current 8.0/8.1/8.2/8.3/8.4, below-floor
  refusal, local MCP, and real production HTTP on the oldest/limited tiers.
- Exact reviewed physical identifiers now remain executable when a database uses
  reserved words, mixed case, Unicode, or printable spaces. Runner resolves the
  exact activated ID before applying PostgreSQL/MySQL delimiter escaping; labels,
  case variants, and unreviewed names remain invalid. The supported-version
  matrix runs real row and aggregate plans over these identifiers locally and
  over representative production HTTP paths.
- Legacy MySQL boundaries whose categorical filter/group authority predates
  enforced-`CHECK` vocabulary extraction can now reconcile forward. Rescan
  attaches the newly proven values only as a strict allowlist over an operation
  the boundary already had, invalidates that field-permissions confirmation, and
  leaves the revision disabled for explicit review and activation. It never
  restores a removed operation or widens an existing narrowed vocabulary; CLI,
  Workbench, and Ask handoff summaries name the exact field and recovery step.
- Source-checkout bundle freshness now fails closed for authoring, activation,
  serving, and reviewed execution while leaving explicitly read-only diagnostics
  available with a stale-build warning: help/version, `config validate`,
  metadata-only `inspect`, and `boundary status`. The complete repository test
  gate rebuilds and verifies this bundle after source tests, and package prepack
  still rebuilds it atomically before publication.
- Live PostgreSQL and MySQL qualification separately exercises the reviewed
  `max_analysis_relationship_hops` authority: depth three returns exact results only
  after that axis is raised to 3, depth two refuses the same plan, 4 exceeds the hard
  ceiling, and `max_derived_scope_hops` remains 2 throughout.
- Local/staging Explore and existing protected named capabilities retain their
  existing behavior. Spec and DSL `1.9.0` add the new fixed aggregate operations
  and post-suppression transforms without admitting model-authored expressions.

Published package versions: `@synapsor/runner@1.7.0` and
`synapsor-runner@1.7.0`, `@synapsor/spec@1.9.0`, and
`@synapsor/dsl@1.9.0`.

## 1.6.7 (published 2026-08-04)

### Clear First-Run Review And Privacy Controls

- Fresh `start --cli` sessions can resolve source-proven record identity and
  trusted tenant scope inside the boundary editor. Selecting a blocked table no
  longer exits or requires a signed headless-review command.
- Existing Runner configuration is preserved unless replacement is explicitly
  requested. Missing active boundaries, invalid capability names, and refused
  field operations now use actionable messages without leaking local paths.
- Natural-language Ask receives reviewed time coverage, safer default models,
  conversation continuity, command history, discoverable access summaries, and
  more reliable weak-model guidance. Verified JSON and parameterized SQL remain
  operator-only and are rendered separately from model prose.
- Ranked aggregates, comparisons, distinct counts, and `try protect --last`
  follow the latest reviewed analysis correctly. Refusals identify the exact
  boundary, table, field, operation, or limit that an operator may review.
- Privacy review now explains cohort changes in plain language, defaults to
  saving the operator's requested change, offers a whole-boundary threshold,
  shows pending inactive changes, and offers immediate exact-digest activation.
  Complementary-total protection and small-group suppression remain enforced.
- Auto Boundary keeps qualified person names out by default. Withheld enum
  domains stay outside model context, aggregate differencing remains durable,
  unsupported row-hash guards fail closed, and PostgreSQL write posture rejects
  roles that can assume the table owner.
- Proposal apply rechecks supporting freshness expiry, and MySQL writes retain
  the client-enforced pre-COMMIT deadline. PostgreSQL and MySQL tests continue
  to prove read-only Explore and guarded write rollback behavior.
- Workbench and CLI share the same review, activation, evidence, Protect, and
  MCP authority paths. The packed first-run, browser visual, compatibility, and
  full test gates cover the corrected journey.

Published package versions: `@synapsor/runner@1.6.7` and
`synapsor-runner@1.6.7`. Spec and DSL remain at `1.8.0`.

## 1.6.6 (published 2026-08-03)

### Review Once, Ask Repeatedly

- Workbench now renders useful review evidence even when every generated
  resource begins blocked. The CLI and Workbench share one boundary-review
  domain, so source-proven identity/scope and field decisions converge on the
  same disabled authority digest.
- A strict versioned decision file supports large-schema review without
  granting authority. Applying review state and activating it remain separate;
  headless changes still require exact signed-key or OIDC operator proof.
- Interactive final review now hands off directly to a default-yes activation
  prompt. Workbench advances after the last saved sign-off and uses one
  **Activate and ask** action for fingerprint revalidation plus activation.
  Both paths still record activation separately against the exact digest;
  neither asks a person to copy that digest.
- Successful interactive CLI activation now continues into a host choice:
  OpenAI, Anthropic, a loopback OpenAI-compatible model, an existing MCP
  client, or **Later**. Hosted/local choices enter the existing `try ask` shell
  in the same process with complete provider/model arguments. Provider failure
  cannot roll back or misreport the already active boundary; headless and JSON
  activation never launch the chooser.
- `synapsor-runner try ask` uses the same provider adapters, official-MCP
  gateway, and runtime validators as Workbench Ask. While Explore is active,
  Ask receives exactly `app.describe_data` and `app.explore_data`; named
  read/proposal tools are not mixed into that catalog.
- Up to eight independently reviewed development/staging boundaries can be
  active through that same two-tool catalog. Each plan uses one boundary;
  overlapping resources require the name and cross-boundary joins/unions are
  refused. Adding a boundary retains the provider/model/key in memory while
  clearing conversation and rebinding egress to the exact active-set digest.
  Privacy accounting is atomic and durable across the stable source and trusted
  scope. Cohort-protected variants share a root-resource pool over a rolling
  24-hour window, including across restart and UTC midnight, and complementary
  suppressed grouping/total releases are refused. Asking does not automatically
  Protect or create named authority.
- New Auto Boundaries review a finite default of 16 distinct cohort-protected
  aggregate variants per root resource per rolling 24 hours. This preserves the
  ten-plan first-use path without restoring per-plan-family budget resets;
  existing boundaries retain their digest-bound value and reviewers may narrow
  the generated allowance.
- Every successful analysis receives an encrypted expiring local reference.
  An operator may later promote exactly one result with `try protect --from` or
  Workbench; the generated DSL, canonical JSON, and tests start disabled.
- Two-period comparisons use one read-only repeatable-read snapshot and return
  semantic aliases, absolute/percentage changes, reviewed UTC time semantics,
  and explicit empty/suppressed/incomplete outcomes.
- Ranked top/bottom and two-period mover questions can evaluate a larger,
  separately reviewed candidate population while still returning at most the
  reviewed top-N. Runner bounds the complete population, suppresses small
  cohorts before ordering, and refuses partial rankings. Absolute and percentage
  change are closed typed operations; the model cannot set the candidate
  ceiling or introduce formulas.
- MCP analytical tools advertise structured output schemas. External clients
  can discover safe digest-pinned metadata through
  `synapsor://analytics/catalog/v1` or `tools catalog` without receiving SQL,
  trusted-scope details, kept-out fields, or credentials.
- The packaged host-neutral TypeScript example proves official-SDK stdio and
  authenticated Streamable HTTP integration for analytical discovery/calls and
  existing semantic reads/proposals, with operator tools absent.
- Packed Retail and Healthcare/PHI clean rooms exercise actual desktop/mobile
  Workbench paths, ten legal plans before optional Protect, suppression,
  tenant/principal isolation, stored prompt-injection inertness, provider/CLI/
  MCP parity, production narrowing, and source checksums.
- Auto Boundary still generates minimum cohort 5. A human owner can lower it to
  1 through 4 only through a reviewer-and-reason-bound decision; 1 plainly
  disables small-group suppression. Protect and activation separately
  re-confirm the exact lower threshold, while models cannot set or confirm it.
- Protected capabilities can bind a reviewed model-withheld field tier. Runner
  may use those fields for explicitly allowed typed operations and render local
  verified values, while raw values and enum domains remain outside provider
  requests. Kept-out fields remain unavailable to every operation.
- Auto Boundary now classifies qualified person-name fields conservatively and
  sends ambiguous display names to review. Current classification is reapplied
  when generating authority, so stale inspection output cannot reopen them.
- Apply now rejects drift between stored freshness authority and the current
  reviewed policy. Worker completion/retry/dead-letter paths require an exact
  fenced lease ID. MySQL uses a client-enforced pre-COMMIT deadline for writes;
  live PostgreSQL/MySQL gates prove rollback, supporting-dependency rechecks,
  and zero unintended mutation.
- OIDC operator identity requires issuer and audience. Webhook receivers can
  use an atomic durable replay claim, notification lease loss is isolated per
  item, and interactive CLI failures no longer print raw telemetry JSON.
- A live owner-authorized OpenAI `gpt-5-mini` acceptance run called the exact
  two authoring tools and matched the official MCP result without persisting the
  key or conversation. Anthropic and generic compatible claims remain
  protocol-tested; no real Ollama/LM Studio runtime was available.

Published package versions: `@synapsor/runner@1.6.6`,
`synapsor-runner@1.6.6`, `@synapsor/spec@1.8.0`, and
`@synapsor/dsl@1.8.0`. Spec/DSL 1.8.0 add the canonical model-withheld egress
tier, explicitly reviewed minimum cohort 1, a separate ranked-candidate group
ceiling, and absolute/percentage comparison-change ordering. Omitted fields
preserve existing contract normalization and digests.

## 1.6.5 (published 2026-07-26)

### Managed Claude Code and VS Code project MCP installs

- The same reviewed, backup-producing project lifecycle previously available
  for Cursor now manages Claude Code `.mcp.json` and VS Code
  `.vscode/mcp.json`.
- Install previews preserve unrelated project settings, pin the exact Runner
  version, write no credentials or trusted scope, and refuse unowned or
  tampered `synapsor` entries. Reinstall is idempotent and uninstall removes
  only Runner's intact entry.
- VS Code JSONC comments and trailing commas survive install and uninstall.
  `mcp status <client> --project --check-launch` validates the generated
  command against the exact reviewed MCP tool list.
- README, Workbench, onboarding, host recipes, and `doctor` now present Cursor,
  Claude Code, and VS Code as peer project clients. Existing Cursor commands
  and configuration remain compatible.

Published package versions: `@synapsor/runner@1.6.5` and
`synapsor-runner@1.6.5`. Spec 1.7.0 and DSL 1.7.0 remained unchanged.

## 1.6.4 (published 2026-07-25)

### Review-correct onboarding and reviewed relationship paths

- Generated-boundary review now uses dependency-scoped invalidation and stale
  revision checks. Editing one resource does not erase unrelated human
  decisions, while stale browser state cannot overwrite a newer review.
- Workbench starts with a small useful resource pack, explains current agent
  authority and source-change status in plain language, keeps advanced
  permissions behind progressive disclosure, and preserves one recommended
  next action. Project resume and nested config discovery retain existing work.
- A fresh `npx -y @synapsor/runner start` can accept the database URL through a
  hidden terminal prompt, or load only a selected `DATABASE_URL` from an
  explicitly confirmed local environment file. In the conservative local
  development fast lane, at most two plain questions and one recorded
  digest-bound human gesture lead to a real read without exporting the URL,
  editing generated files, or weakening staging/production review.
- Deterministic classification is more conservative across unfamiliar domains.
  Database, Prisma, Drizzle, OpenAPI, and existing Synapsor evidence can improve
  names and structure but cannot grant authority or resolve ambiguous trusted
  scope.
- Protected aggregate reads may contain up to three activated reviewed
  relationship paths. Each path has one or two catalog-proven many-to-one
  links with fan-out one. The model can select an activated path by name but
  cannot provide a table, key, join type, or activation decision.
- A question needing an inactive proven path fails closed and stages that exact
  path for operator review. Optional links require an explicit missing-row
  choice because excluding versus retaining an unmatched counted row can change
  totals. The reviewed choice and structural proof are digest-bound.
- Scope is enforced independently on every relation. Cohort suppression runs
  after final grouping. One-to-many, many-to-many, ambiguous, stale, over-depth,
  and model-improvised joins remain refused; complex formulas and relationship
  graphs use reviewed database views.
- Packed Community Solar and Retail clean-room journeys and live
  PostgreSQL/MySQL relationship gates cover unfamiliar-domain onboarding,
  PM-style analysis, demand-driven review, nullable semantics, drift,
  suppression, scope, and deliberate fan-out rejection.
- Workbench now leads post-activation analytics with local **Ask with your
  model** over the exact active MCP/runtime tools, while also presenting
  existing model-enabled MCP clients as a first-class path. OpenAI, Anthropic, and custom
  OpenAI-compatible adapters use explicit digest-bound direct-egress consent,
  in-memory credentials/history, bounded tool loops, escaped provider prose,
  and proposal-only writes. The no-model composer remains an optional
  exact-plan fallback.
- Remote provider requests use fixed official origins or an operator-selected
  HTTPS custom origin, refuse redirects, validate and pin DNS on every
  connection, block private/special/metadata targets, redact errors, and
  support Node 22's multi-address lookup contract. Plain HTTP remains
  loopback-only.
- Both packed clean-room domains now pass the real Ask UI. The Retail journey
  shows a kept-out-field refusal; Community Solar shows a source-unchanged
  proposal. An owner-authorized live OpenAI `gpt-5-mini` acceptance run used
  the same official-MCP path, matched its aggregate result, and passed exact-key
  project/ledger/browser/output/evidence scans. Anthropic and generic
  compatible claims are limited to the documented tested protocol matrix.
- Human-facing commands now use the shortest true form: direct `npx` for first
  acquisition and `synapsor-runner <command>` after installation. The optional
  unscoped `synapsor-runner` npm package contains no runtime or authority logic;
  it delegates to the exact matching scoped Runner version. Existing explicit
  package, pinned, CI, and machine-readable invocations remain compatible.
- Generated DSL previews use one local, escaped, copy-exact syntax highlighter
  in light and dark themes with no CDN or unsafe HTML fallback. Activity and
  human review details use the full Workbench width instead of a compressed
  side column, including mobile layouts.
- Existing hand-authored and published `1.6.3` projects do not need the new
  relationship fields, generation review, or Workbench. Legacy contracts keep
  their exact normalized bytes/digests and existing tool lists remain
  unchanged unless the feature is adopted.

Published package versions: `@synapsor/runner@1.6.4`,
`@synapsor/spec@1.7.0`, `@synapsor/dsl@1.7.0`, and the optional
`synapsor-runner@1.6.4` command alias.

## 1.6.3 (published 2026-07-24)

### Guided adoption without weaker authority

- A fresh interactive
  `npx -y @synapsor/runner start --from-env DATABASE_URL` now drives one
  resumable metadata-inspection, review-by-exception, exact-digest activation,
  first safe read, and MCP setup journey. It requires no account, model key,
  Cloud control plane, global install, or manual project files.
- Workbench explains the boundary before exposing advanced details, highlights
  only unresolved security decisions, and keeps one primary next action visible.
  Generated read, aggregate, protected, and write authorities remain disabled
  until the human activates the exact reviewed digest.
- Project-aware `try call`, `try explore`, `try protect`, and guided action
  paths remove repeated config/store flags and copied handles while preserving
  the canonical DSL/Spec/runtime boundary and existing manual/headless paths.
- The packaged FitFlow journey proves a real named read, privacy-suppressed
  PM-style aggregate, Protect This Query, proposal-only model call, bounded
  approval policy, guarded source write, receipt/replay, compensation, and
  equivalent authority across Workbench, CLI, Cursor, Claude, Codex, and
  generic stdio setup.
- The packaged approval-role guide and simulated external OIDC/JWKS flow show
  how `APPROVAL ROLE` maps to verified IdP claims and immutable decisions.
  Reviewer and applier authority remain separate; invalid signatures, token
  time/issuer/audience failures, missing or similar roles, key rotation errors,
  proof tampering, and proof replay fail closed.
- Operator-supervised automatic apply is a new default-off execution axis.
  Contract permission and an independent deployment allowlist must match one
  exact active digest. Existing `AUTO APPROVE` behavior remains manual-apply;
  eligible single-row INSERT/UPDATE work uses the same guarded apply after
  current policy, limit, scope, target/supporting-evidence freshness,
  writer-posture, receipt, and fenced-lease revalidation.
- The ledger and Workbench now project durable redacted human-attention events
  for proposal, worker, boundary, schema, credential, policy, and sensitive
  override states. External delivery is disabled and quiet by default. A
  separate dispatcher supports coalescing, budgets, digests, JSONL development
  output, and signed generic HTTPS webhooks that inform but never authorize.
- Replaying a failed notification requires a fresh verified signed-key or OIDC
  operator decision bound to the exact delivery revision and a recorded
  reason. It requeues only the redacted event. Packed tests prove competing
  dispatcher deduplication, zero immediate success noise under the default
  preset, metadata-endpoint SSRF refusal, and an unchanged source database
  across notification replay.
- Workbench and CLI expose queue status, pause/drain, exact-digest
  enable/disable/revoke, cancellation, dead-letter, UNKNOWN/reconciliation,
  notification status/replay, and no-ID attention inspection outside MCP.
- Supported JSON failure paths emit one parseable result with a stable error
  code, preserved-state and source-change status, one recovery action, and
  redacted diagnostics on stderr.
- An explicit empty `capabilities` array is now valid zero-authority review
  state. The optional canonical `execution.supervised_worker` permission and
  public `ALLOW SUPERVISED WORKER APPLY` clause are additive. Spec and DSL
  advance to `1.6.0` while preserving old contract normalization, digests, and
  generated-lock support.

Published package versions: `@synapsor/runner@1.6.3`,
`@synapsor/spec@1.6.0`, and `@synapsor/dsl@1.6.0`.

The pre-release clean-install gate used the locally packed public Spec until
Spec 1.6.0 reached npm, then returned to the registry-only dependency proof.

## 1.6.2 (published 2026-07-23)

### Registry-installable packaging hotfix

- Runner remains linked to the local Spec workspace during development, while
  pnpm must transform that link to the public `@synapsor/spec@^1.5.0` range in
  the release tarball.
- A publish lifecycle guard rejects `npm publish`, requires
  `corepack pnpm publish`, and rejects unexpected local dependency protocols or
  incorrect Spec ranges.
- The release gate inspects pnpm's transformed tarball manifest and installs
  the Runner tarball alone in a clean project before invoking its CLI. The test
  therefore exercises the dependency-resolution path used by public `npx`.
- Runtime behavior is unchanged from the proposal/evidence freshness release.

Published package version: `@synapsor/runner@1.6.2`.
`@synapsor/spec@1.5.0` and `@synapsor/dsl@1.5.0` remain unchanged.

## 1.6.1 (published 2026-07-23; install-broken)

### Fail-closed proposal and evidence freshness

- An optional `proposal_freshness` Runner overlay can require a live target and
  explicitly declared same-source supporting-row check immediately before
  every local approval.
- Each successful human, quorum, or policy approval references a distinct
  short-lived proof bound to the exact proposal hash/version and dependency
  set. Stale and unavailable checks record no approval.
- Direct PostgreSQL/MySQL apply locks and rechecks dependencies inside the
  mutation transaction. Source drift after approval returns a conflict and
  changes zero rows; bounded sets roll back completely.
- `proposals check-freshness latest`, Workbench gating, lifecycle, replay,
  compliance reports, metrics, logs, and `doctor --check-writeback` expose the
  bounded proof and operational state without source rows, kept-out values,
  trusted scope values, or credentials.
- Cloud does not read the source. A local Runner revalidates a Cloud-approved
  job before apply. Strict app-owned and cross-source freshness remains an
  explicitly unsupported topology.
- Existing contracts, exact digests, DSL, model-facing tool lists, and
  non-freshness deployments keep their prior behavior.

The `1.6.1` registry manifest accidentally retained
`@synapsor/spec: "workspace:^"`. Clean npm and npx installs reject that local
workspace protocol with `EUNSUPPORTEDPROTOCOL`. The version should remain
deprecated and is superseded by `1.6.2`. Spec and DSL were unaffected.

## 1.6.0 (published 2026-07-23)

### Connect, Explore, Protect

- A fresh interactive `start --from-env DATABASE_URL` can inspect the whole
  staging schema and structured Prisma/Drizzle/OpenAPI/Synapsor artifacts,
  then emit a disabled candidate boundary without executing adopter code,
  reading source rows, or using an LLM.
- The local Workbench requires explicit review of scope, fields, aggregate
  measures/dimensions/time buckets, one-hop relationships, privacy budgets,
  role/grant/RLS posture, profile, generation lock, and exact digest.
- The temporary Cursor authoring entry exposes only `app.describe_data` and
  `app.explore_data`. Typed row and PM-style aggregate plans are bounded by the
  activated authority, run read-only, and cannot introduce SQL, identifiers,
  tenant/principal identity, or wider limits.
- Aggregate Explore supports reviewed count/distinct/sum/avg, categorical and
  time grouping, bounded comparisons/top-N, cohort suppression, and durable
  anti-differencing/extraction/rate limits. It is descriptive analysis, not a
  causation claim.
- Protect This Query writes public DSL, canonical JSON, tests, and a disabled
  named capability. Exact-digest activation disables broad Explore; production
  serves only the named protected tool.
- Scoped Explore is absent from production, unknown-profile, shared HTTP,
  remote, and non-loopback `tools/list`. Write-capable, owner, superuser,
  `BYPASSRLS`, or unverifiable credentials cannot enable source-row Explore.
- Existing 1.x projects do not need Workbench, generation locks, rescans, or
  new fields. Published legacy contracts preserve exact normalization/digests,
  and established CLI/headless/CI routes keep their behavior.

Published package versions: `@synapsor/runner@1.6.0`,
`@synapsor/dsl@1.5.0`, and `@synapsor/spec@1.5.0`.

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
  developers can use `npx -y @synapsor/runner ...` without
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
