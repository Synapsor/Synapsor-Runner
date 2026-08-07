# Runner 1.7.0 Production Explore Hardening

Last verified: 2026-08-06

## Workspace

- Worktree: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner-production-explore`
- Branch: `feature/production-scoped-explore-http`
- Base: `origin/main` at Runner 1.6.7
- No commit, push, publish, or Spec/DSL change has been performed.

## Completed Hardening

- Production Explore audit/evidence uses a dedicated append-only PostgreSQL sink. It no longer reloads, rewrites, locks, or consumes capacity in the proposal ledger.
- Audit append failure is best effort and cannot discard an already bounded query result. Metadata content and redaction are unchanged.
- Source executors use a process-wide, reference-counted pool per source and engine. `source_max_connections` defaults to 8 and is reported by doctor/startup attestation.
- Streamable HTTP enforces `max_sessions_per_principal`, default 4, independently for each verified principal.
- Production session idle timeout defaults to 120 seconds. Runtime close is awaited with a five-second bound, failures are logged, and server shutdown awaits pending closes.
- Budget cleanup moved off the reservation hot path into hourly maintenance. Created-at indexes support all retention work.
- Budget reservations and production audit events retain seven days. Privacy releases retain the active rolling 24-hour differencing window using the same PostgreSQL clock for conflict checks and cleanup, so application-clock skew cannot shorten the defense.
- The privacy-release subtraction defense, per-principal accounting key, tenant/principal JWT scope, suppression, atomic reservations, and exact two-tool model surface are unchanged.

## Live-Gate Defect Found And Fixed

The first MySQL HTTP run passed its workload but stack-overflowed during shutdown. `runtime.close()` synchronously closed its transport before `closePromise` had been assigned, allowing `onclose` to re-enter disposal recursively. Runtime shutdown is now deferred until the close guard is installed, with a focused re-entrancy regression test.

## Follow-Up Audit Regressions Fixed

- A transient shared-executor bootstrap failure no longer poisons the process. Rejected bootstrap promises clear only their own cached entry, so a later MCP session retries; a successful process-wide lease remains cached and still enforces the configured source-connection ceiling.
- Production factory shutdown tolerates a rejected bootstrap and a failed executor release. Streamable HTTP cleanup now attempts the session factory, shared runtime resources, and shared store closes independently, then reports any collected failures only after every close has run.
- Streamable HTTP startup failure uses the same resilient cleanup path while preserving the original startup error.
- The retention-maintenance warning now states that a failed run retries at the next hourly maintenance window, matching the scheduler's actual behavior.
- Focused regressions prove first-bootstrap failure followed by successful retry with one acquired executor, and prove shared resources plus the store close even when the session factory close throws.

## Verification

- Full suite with live PostgreSQL accounting enabled: 86 files, 1,333 tests passed; `production-explore-postgres.test.ts` ran 8/8 rather than skipping.
- Release gate: passed for `@synapsor/runner@1.7.0`, including typecheck, 564-test release subset, MCP client configs, first-run proof, source and packed package checks, and npm publish dry-run.
- PostgreSQL production HTTP: passed; exact two tools, principal isolation, row isolation, atomic reservation, source ceiling 2, session ceiling 2, dedicated audit sink, suppression, doctor attestation, and no source mutation.
- MySQL production HTTP: passed with tenant isolation, source ceiling 2, session ceiling 2, and no source mutation.
- Packed production HTTP: passed with the same controls through the public packed CLI artifact.
- Packed first-run CLI: PostgreSQL and MySQL both resolved blocked scope inline, kept column review open, activated the reviewed boundary, and reached model selection without source mutation.
- Workbench Ask visual gate: passed on desktop/mobile; provider key not persisted and browser storage remained empty.
- Auto Boundary Workbench visual gate: passed across desktop, mobile, keyboard, blocked, stale, failure, and large-schema states.
- `git diff --check`: passed.

## Owner Decision Preserved

The required tenant-wide budget ceiling and tenant advisory lock remain unchanged as the documented coordinated-probing backstop. Hitting that ceiling can refuse all principals in one tenant, while other tenants remain unaffected. This was not silently removed or converted to principal-only accounting; changing that tradeoff requires explicit owner direction.

Production Explore audit append remains deliberately best effort. A temporary audit-sink outage can lose forensic metadata, but cannot bypass or skip the separately awaited budget reservation, suppression, trusted-scope, or subtraction-defense paths. Changing audit availability to fail queries closed remains an explicit owner decision.

## Production Explore DX Follow-Up

The post-hardening DX audit is resolved without changing the production security register:

- Doctor and startup attestation now reject an active production boundary set that spans more than one source. The report names each `boundary -> source` mapping and tells the operator to split sources across Runner deployments, so doctor can no longer mark a deployment healthy when the first session would fail.
- Tenant response limits now have a dedicated optional `max_response_cells_per_response` setting. Runtime enforcement clamps that tenant value to the selected boundary's reviewed response cap; the 24-hour extracted-cell allowance is no longer reused as a per-response limit.
- `synapsor-runner config init --production-explore` generates a complete zero-authority runtime skeleton from the reviewed production boundary and generation lock. It derives the source, engine, database URL environment name, and scope claim names, while requiring explicit issuer, audience, and accounting namespace values. It writes no URLs, credentials, JWTs, or HMAC material.
- Production `boundary draft` now points directly to the generator when no runtime config exists.
- Serve startup failures render the complete attestation report and the exact `doctor` command instead of failing one prerequisite per restart.
- HMAC validation and docs require at least 32 bytes of random key material and explicitly reject short hexadecimal strings such as a 32-character hex value, which has only 16 bytes of entropy.
- Doctor emits non-blocking warnings when tenant query, cell, differencing, response, or rate ceilings are lower than a reviewed boundary's per-principal budgets. Tenant ceilings remain authoritative and unchanged.
- Production examples no longer put ignored static values under `trusted_context` when `http_claims` is authoritative.
- README wording was trimmed to 1,487 words after the content gate caught a 20-word overage; root and packaged copies remain identical.

## Final Verification After DX Follow-Up

- `corepack pnpm typecheck`: passed.
- `git diff --check`: passed.
- Full suite with live PostgreSQL accounting enabled: 86 files, 1,339 tests passed; `production-explore-postgres.test.ts` ran 8/8.
- Production runtime regressions: 17/17 passed, including multi-source attestation, aggregate startup errors, tenant-budget warnings, and short-hex HMAC rejection.
- PostgreSQL production HTTP E2E: passed with exact two-tool surface, principal budget isolation, tenant/principal row isolation, atomic reservation, source ceiling 2, session ceiling 2, dedicated audit, suppression, doctor attestation, and no source mutation.
- MySQL production HTTP E2E: passed with the same tool surface, principal budget isolation, tenant row isolation, source/session ceilings 2, and no source mutation.
- Packed production HTTP E2E: passed through the public packed CLI artifact with all PostgreSQL controls above.
- Release gate: passed for `@synapsor/runner@1.7.0`, including 571 release-subset tests, MCP client config checks, disposable first-run proof, production PostgreSQL/MySQL HTTP E2E, public commands, local bundle, packed bundle, packed own-database onboarding, packed PostgreSQL/MySQL first-run onboarding, license/content checks, and npm publish dry run.
- Packed first-run onboarding reached model selection in about 4.4 seconds for both PostgreSQL and MySQL without source mutation.
- Test containers created by the gates were removed; only unrelated pre-existing containers remain.

No commit, push, publish, Spec/DSL bump, or technical deep-dive edit was performed.

## First-Developer Onboarding DX Follow-Up

The fresh-adopter onboarding findings are resolved without relaxing tenant scope, principal scope, review, or production Explore controls:

- Root help now starts with two explicit choices: `synapsor-runner try` without a database, or `synapsor-runner start --from-env DATABASE_URL` for an own-database first run. It distinguishes interactive `start` from scriptable `onboard db` before listing the full command surface.
- A table selector no longer silently switches a real TTY into automation. Interactive `start` and `onboard db` prompt for the capability mode, trusted tenant column, and remaining decisions; selecting the table continues to primary-key and scope review instead of exiting.
- Non-TTY onboarding validates the whole requested journey first and reports every missing decision in one error, including table, mode, tenant posture, write patch, review acknowledgement, and overwrite acknowledgement where applicable. Help includes one canonical read-only automation recipe.
- Existing generated files require explicit replacement in both interactive and scripted paths. Interactive setup asks before replacement; noninteractive setup requires `--force`. A write-free `--dry-run` does not require `--force`.
- Guided onboarding runs `doctor --setup`. Expected unset environment values render as `Synapsor Runner setup: incomplete` with the exact next environment variables, while real config/runtime problems still render as failed and return nonzero.
- Explicit production tenant/principal claim flags must match the reviewed boundary draft. Config generation refuses mismatches instead of producing a config that passes schema validation but fails runtime attestation.
- PostgreSQL control-database separation is reported as passed only when a PostgreSQL production boundary actually reached and passed that check. Failed or MySQL-only boundary sets cannot emit the PostgreSQL pass line.
- Production Explore rejects result-envelope and tool-alias presentation flags instead of silently ignoring them. Help and operator docs state that the production model surface is exactly `app.describe_data` and `app.explore_data` with one fixed reviewed envelope.
- Guided onboarding, HTTP MCP, and production Explore documentation now provide consistent interactive and noninteractive recipes and preserve the fixed production surface.

## Final Verification After Onboarding DX Follow-Up

- Focused onboarding/production regressions: 4 passed; 148 unrelated CLI tests skipped.
- Full suite with live PostgreSQL accounting enabled: 86 files, 1,344 tests passed; the PostgreSQL accounting suite ran 8/8 rather than skipping.
- Manual PTY first-developer run used the built `@synapsor/runner@1.7.0` CLI against a fresh read-only PostgreSQL role and table. Table selection continued into primary-key and tenant review, conservative read-only defaults completed, `customer_email` was kept out automatically, config/contract/MCP snippets were generated, the semantic-tool proof passed, and expected unset tenant/principal values ended as `setup: incomplete` rather than `doctor: failed`.
- Built CLI no-argument help displayed the two `New here?` paths before the command list.
- Built CLI non-TTY setup reported table, mode, tenant scope, and overwrite decisions together; the canonical dry run succeeded against an existing output without `--force` and did not replace it.
- Release gate passed for `@synapsor/runner@1.7.0`: typecheck; 13 release files and 576 tests; MCP client config/live tool-list checks; disposable first-run proof; PostgreSQL and MySQL production HTTP Explore; source/public command checks; packed runner; packed production HTTP; packed own-database writeback; packed PostgreSQL/MySQL first-run onboarding; license/content checks; and npm publish dry-run.
- Packed fresh first runs resolved scope inline, kept column review open, activated the reviewed boundary, and reached model choice in 3.2 seconds for PostgreSQL and 3.2 seconds for MySQL without source mutation.
- `git diff --check` passed. Root and packaged READMEs are byte-identical and exactly 1,500 words each.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical deep-dive edit was performed.

## Onboarding DX Round 2 Follow-Up

The two follow-up reports were reproduced and fixed without weakening normal
doctor checks or production Explore attestation:

- `doctor --setup` now classifies missing environment bindings by role instead
  of treating every `env:*` failure as deferred setup. Human-supplied tenant and
  principal bindings, writer credentials, and handler settings may remain
  `setup: incomplete` immediately after artifact generation. The primary source
  read credential and required shared-HTTP session-auth secret, public-key, or
  JWKS bindings are deployability requirements; missing any of them reports
  `setup: failed` and exits nonzero.
- Setup formatting marks only genuinely deferred bindings as `is not set yet`.
  Required credentials remain hard failures in the same report, so a mixed
  pending-plus-required state cannot produce a false green result.
- Noninteractive shadow/review onboarding now reports all operation and
  writeback decisions in its initial preflight. UPDATE and DELETE require
  `--conflict-column`; INSERT requires `--dedup`. Review-mode direct SQL, HTTP
  handler, and command handler paths require `--write-url-env`,
  `--handler-url-env`, and `--handler-command-env`, respectively. Runner-ledger
  UPDATE also requires `--version-advance`.
- Shadow mode keeps its correct proposal-only semantics: operation guards are
  required, but a writer credential is not required because shadow authority
  cannot apply a source mutation.
- CLI help and onboarding docs now use the real `--dedup` mapping syntax and
  include complete read-only and reviewed-write automation examples.

## Verification After Onboarding DX Round 2

- Focused setup-status tests: 3/3 passed, covering deferred trusted bindings,
  missing required read credentials, and missing required JWKS with a deferred
  tenant binding.
- Focused CLI onboarding regressions: 5/5 passed, including one-shot INSERT and
  HTTP-handler preflight plus nonzero setup behavior for a missing read
  credential.
- Full suite with live PostgreSQL accounting enabled: 87 files, 1,347 tests
  passed; the PostgreSQL accounting suite ran 8/8 rather than skipping.
- PostgreSQL production HTTP, MySQL production HTTP, and packed production HTTP
  E2E checks passed with principal isolation, source/session ceilings, and no
  source mutation.
- The complete 1.7.0 release gate passed: typecheck; 13 release files and
  576 tests; MCP client configurations; disposable first-run proof; PostgreSQL
  and MySQL production HTTP; source and public-command checks; local and packed
  artifacts; guarded own-database writeback; packed PostgreSQL/MySQL fresh CLI
  onboarding; license/content checks; manifest and public dependency checks;
  npm publish dry run; and `git diff --check`.
- Packed fresh CLI onboarding resolved blocked scope inline, kept column review
  open, activated the boundary, and reached model choice in about 3.2 seconds
  on both PostgreSQL and MySQL without source mutation.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical
deep-dive edit was performed.

## Derived Scope Implementation Progress

Derived tenant and principal scope remain part of the same unpublished Runner
1.7.0 branch. Checkpoint commit `38de8a4` still preserves all preceding 1.7.0
production-Explore, catalog, enum, and DX work; the derived-scope changes below
are currently uncommitted.

- Auto Boundary now discovers bounded one- and two-hop derived tenant/principal
  candidates only through non-null, catalog-proven foreign keys targeting an
  exact primary/unique key. A human must select the path in CLI or Workbench;
  direct scope remains unchanged and ambiguous/nullable/unproven paths block.
- Activated resources store the reviewed path and proof digest. Review
  decisions, summaries, maps, final signoff, Workbench requests, and generation
  lock dependencies all carry the same canonical path representation.
- Scoped Explore injects each path as an unmodelled mandatory correlated
  `EXISTS` semijoin for roots and relationship targets. It applies to rows,
  aggregate/group/time, ranked, and both period-comparison statements without
  multiplying rows or weakening optional model joins. PostgreSQL and MySQL use
  their existing trusted parameter binding and read-only execution paths.
- Scope ancestors are included in runtime role/RLS posture, drift validation,
  and metadata-only evidence. PostgreSQL role-bound scope is proven on the
  terminal ancestor rather than incorrectly requiring RLS on the normalized
  child; removing the ancestor's effective RLS proof fails closed.
- Rescans prune a reviewed derived path when FK nullability, target uniqueness,
  or path proof changes. A generated activated child executes successfully,
  then refuses before source execution after its FK becomes nullable.
- Public DSL/Protect and guarded writes remain direct-scope only. Protect now
  refuses conversion of a successful relationship-scoped Explore analysis.
  Guided write options omit relationship-carried tenant or principal scope,
  and explicit write attempts return the corresponding direct-scope error.
- No Spec/DSL shape or package version was changed. Existing direct resources
  omit `tenant_scope` and `principal_scope`, preserving their serialized shape.

Focused verification completed at this checkpoint:

- `corepack pnpm typecheck`: passed.
- Auto Boundary derived inference, two-hop, principal, and drift pruning:
  34/34 passed.
- Trusted environment/role/HTTP scope including derived ancestor RLS: 10/10
  passed.
- Workbench renderer and real route submission for a derived path: passed.
- Generated derived runtime/drift regression: passed.
- Protect suite including the direct-scope conversion fence: 15/15 passed.
- Guided write relationship-carried-principal regression: passed; the complete
  guided-action file remains to be rerun with the broader focused gate.

Remaining before the derived-scope checkpoint can be called complete:

- Run the complete focused CLI, review-domain, Workbench, local UI, Protect,
  guided-action, trusted-scope, and Scoped Explore files together.
- Add and run real PostgreSQL and MySQL cross-tenant adversarial queries for a
  normalized child, including aggregate/comparison and relationship-target
  shapes, and verify no source mutation.
- Run browser parity, packed/public artifact, full live-PostgreSQL suite, and
  complete 1.7.0 release gates.
- Remove only the generated test artifacts under `apps/runner/synapsor*`, run
  final diff/status checks, then commit the derived-scope checkpoint on the same
  feature branch. Do not push or publish without separate owner direction.

## Derived Tenant Scope Analysis Checkpoint

Checkpoint commit `38de8a4` preserves the verified production-Explore and
catalog work. Derived scope remains part of the same unpublished 1.7.0 release.

The proposed isolation proof holds against the current compiler with these
implementation refinements and additional invariants:

- A derived scope will be flattened into a bounded, catalog-proven path ending
  at one direct tenant or principal column. Every hop must be a non-null foreign
  key to an exact primary/unique key, many-to-one, maximum fan-out one, and part
  of the reviewed digest. Direct resources keep their existing `tenant_key` and
  `principal_key` bytes; optional derived fields appear only where used.
- The compiler will inject the path as a mandatory correlated `EXISTS`
  semijoin containing only INNER FK-to-unique joins. This is equivalent to the
  proposed mandatory top-level join for isolation, cannot multiply source rows,
  keeps aliases structurally separate from model joins, and preserves reviewed
  `LEFT JOIN ... keep_null` semantics for optional model relationships.
- Root rows, aggregate/group/time plans, both period-comparison queries, and
  every model relationship target all pass through the same mandatory scope
  compiler. The model cannot request, omit, weaken, or change the scope path.
- Scope ancestors must be included in each compiled query's resource posture.
  That is required for PostgreSQL RLS `set_config`, long-running read-only role
  checks, and metadata-only execution evidence even though the scope path is not
  a model-facing relationship.
- Generation-lock dependencies must record and revalidate the hidden scope
  path's FK, source nullability, referenced uniqueness, columns, and proof
  digest for every plan. A stale path fails before source execution.
- Database-role tenant resolution must validate the terminal direct ancestor's
  effective RLS policy rather than incorrectly demanding RLS on the normalized
  child. MySQL remains Runner-enforced through the mandatory predicate.
- MySQL binds parameters in textual statement order. Derived-scope values must
  remain in the WHERE/join parameter segment after any SELECT enum-bucket
  parameters; PostgreSQL numbered placeholders retain current behavior.
- Public generated DSL, named read capabilities, and all writes remain limited
  to direct tenant columns. Derived scope changes only read-only Explore and
  does not expand the DSL or writeback authority.
- Self-joins, nullable paths, ambiguous paths, one-to-many/fact-to-fact joins,
  and paths beyond the existing hop ceiling remain unresolved and blocking.
  Referenced uniqueness already entails an indexed target lookup; requiring an
  additional source-FK index would block valid schemas without strengthening
  the isolation proof.

Implementation, operator review, adversarial database tests, browser parity,
and release gates remain in progress. No Spec/DSL bump or package publication
is planned.

## Generation Lock, Model Choice, Catalog, And Sensitive-Access DX Follow-Up

The final 1.7.0 DX findings are implemented without weakening generation-lock
validation, boundary activation, sensitive-field review, or the model-facing
tool surface:

- Every stale generation-lock error now includes a copy-paste regeneration
  command derived from the reviewed `source_env`. Guided `start --cli` also
  offers `R Regenerate against current posture`, then returns to the ordinary
  disabled review and separate human activation flow. The stale check itself
  remains fail-closed.
- A first-run Enter no longer commits the preselected OpenAI model. Before any
  provider credential prompt, Runner requires an explicit choice among OpenAI,
  Anthropic, a local OpenAI-compatible model, an existing MCP client, or Later.
  `M` continues to change the provider/model after that choice.
- `/catalog` now shows the active reviewed join graph alongside each table's
  analytical surface. `/catalog --diagram` renders one shared boundary catalog
  model as a terminal relationship map and a copyable Mermaid `erDiagram`.
  Workbench uses the same model for its paginated `What can I ask?` view and
  reviewed relationship map.
- The catalog is strictly boundary-scoped and metadata-only. It omits external
  tables, never exposes kept-out values, redacts hidden join-key names, and was
  not added to `app.describe_data` or `app.explore_data`; the model-facing
  surface remains exactly those two tools.
- Sensitive-field widening keeps its actor and concrete-reason requirement.
  Empty reasons now print `Rejected: ... no change was made` and re-prompt;
  Escape prints a cancelled/no-change result; successful edits name the exact
  field, new access, actor, and reason; and identical repeats report unchanged
  without creating another revision or requesting another reason.
- Choosing Runner-only now explains that visibility is not analytical
  capability: it does not grant Group, Total/Average, or Count unique, and the
  editor points to the separate advanced operation controls.

## Final Verification After DX Follow-Up

- `corepack pnpm typecheck`: passed.
- `git diff --check`: passed before and after all gates.
- Focused boundary CLI and picker suite: 61/61 passed.
- Focused guided-start, auto-boundary, and Scoped Explore suite: 83/83 passed.
- Shared catalog, Analytics shell, Workbench, and local UI suite: 100/100
  passed.
- Ask regressions: 14/14 passed with the real active-boundary catalog loader
  remaining strict; only explicit in-memory test gateways omit that loader.
- Full suite with live PostgreSQL accounting enabled: 88 files, 1,352 tests
  passed; the PostgreSQL accounting suite ran 8/8 rather than skipping.
- PostgreSQL, MySQL, and packed production HTTP Explore E2Es passed with the
  exact two-tool surface, principal budget isolation, tenant/principal scope,
  atomic reservation, source and session ceilings, suppression, attestation,
  and no source mutation.
- Workbench boundary visual gate passed across 27 captured states. Workbench
  Ask visual gate passed across 7 captured states, including paginated access,
  relationship counts, session-only provider credentials, and zero browser
  storage. The tracked visual baselines were refreshed for the intended UI.
- A real PTY first-run against PostgreSQL confirmed that Enter opens provider
  choice before any OpenAI key prompt. Choosing the existing MCP-client path
  activated only the reviewed boundary and continued without a provider key.
- A real PTY active two-table boundary confirmed `/catalog` join/reachability
  output and `/catalog --diagram` ASCII plus valid Mermaid output.
- A real PTY sensitive-field edit confirmed empty-reason rejection and
  re-focus, exact success confirmation, unchanged/idempotent repeat behavior,
  Runner-only capability guidance, and the persistent pending-activation
  banner after returning to Ask.
- The complete release gate was rerun with captured output and exited 0 for
  `@synapsor/runner@1.7.0`: 13 release files and 576 tests; MCP-client config
  checks; disposable first-run proof; PostgreSQL/MySQL production HTTP Explore;
  public commands; local and packed artifacts; packed production HTTP; packed
  guarded own-database onboarding; packed PostgreSQL/MySQL fresh CLI onboarding;
  license/content and manifest checks; npm publish dry-run; and final diff
  validation.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical
deep-dive edit was performed.

## Operation-Specific Onboarding Recipe Follow-Up

- The noninteractive recovery example now matches the requested write
  operation. INSERT prints `--operation insert`, a patch, and the required
  `--dedup` mapping; DELETE prints `--operation delete` with a conflict guard;
  UPDATE retains its existing update recipe.
- The detected missing decisions, generated authority, review, activation, and
  runtime behavior are unchanged. This is presentation-only first-run guidance.
- The focused INSERT recovery regression passed, typecheck passed, and the
  complete CLI suite passed 152/152.
- A built-CLI human check reproduced the incomplete INSERT command and verified
  that the visible recovery block is titled `Canonical review-mode INSERT
  automation` and contains `--operation insert` plus the deduplication mapping.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical
deep-dive edit was performed.

## Schema Enum Review And Boundary Diagram Follow-Up

The final catalog and categorical-value work is implemented in both terminal
and Workbench operator surfaces without adding a model-facing tool or reading
source rows for metadata:

- PostgreSQL native enums and exact `CHECK field IN (...)` / `field =
  ANY(ARRAY[...])` constraints, plus MySQL `ENUM`, `SET`, and exact `CHECK IN`
  constraints, now provide schema-declared value vocabularies to an activated
  boundary. No `SELECT DISTINCT`, sampling, or row-derived inference is used.
- Schema value sets are all-or-nothing and bounded to 64 values, 64 characters
  per value, and 2,048 serialized bytes. Oversized, identifier-like,
  sensitive, kept-out, and model-withheld vocabularies are omitted rather than
  truncated or exposed.
- CLI and Workbench let an operator narrow a generated vocabulary or disable
  its analytical use through the normal boundary review. The decision records
  actor, reason, and timestamp, changes the boundary digest, remains disabled
  until separate activation, and can never add a value absent from the
  schema-declared set.
- A reviewed vocabulary is enforced before source execution for filters and
  grouped/selected results. Removed or unknown values receive a concrete
  `not a reviewed value` refusal with the allowed values. Selecting no values
  disables filter/group for that field; it never silently restores free-text
  filtering and therefore remains subtractive-only.
- Later resource edits preserve an earlier enum decision, repeated identical
  reviews report unchanged, and the active boundary remains byte-for-byte
  unchanged until the reviewed draft is activated.
- `/catalog` includes reviewed relationships and cross-table question shapes.
  `/catalog --diagram --boundary <name>` renders exactly one active boundary;
  multiple active boundaries require an exact name and are never merged.
- `/catalog --diagram --boundary <name> --export [path]` writes a standalone
  Markdown relationship map and valid Mermaid ER diagram. The default file is
  digest-bound under `.synapsor/catalog/`, uses exclusive creation, and will
  not overwrite an existing export. Large boundaries direct the operator to
  export instead of printing an unreadable terminal graph.
- Workbench uses the same canonical boundary-catalog model. It provides an
  exact-boundary selector, real SVG nodes and arrows, proven join details,
  visible cross-table question suggestions, Mermaid copy, and Markdown
  download. Large maps retain the downloadable artifact while avoiding a
  cluttered inline graph.
- Slash-command parsing and completion now accept argument-bearing actions such
  as `/details last` and `/catalog --diagram --boundary ...`; valid multiword
  actions no longer fall through to `No matching action`.
- Documentation now states the correct 1.7.0 posture: protected capabilities
  remain the default production surface, while flexible production Explore is
  explicit, attested, secured-HTTP-only, and fail-closed without every trusted
  principal, per-principal budget, rate-limit, JWT, and transport prerequisite.

## Final Verification After Enum And Diagram Follow-Up

- `corepack pnpm typecheck`: passed.
- Full suite with live PostgreSQL accounting enabled: 88 files, 1,361 tests
  passed; the PostgreSQL accounting suite ran 8/8 rather than skipping.
- Focused catalog, Analytics shell, Workbench, local UI, enum persistence, and
  runtime allowlist regressions passed, including external MCP Runner-only
  redaction and pre-execution removed-value refusal.
- Workbench Ask visual gate passed across 8 captured states, including an exact
  boundary selector, real SVG relationship arrows, valid Mermaid, download,
  and visible cross-table prompts. The Auto Boundary visual gate passed across
  27 states after a real browser narrowed a three-value enum, supplied actor and
  reason, observed the pending review, and repeated it idempotently.
- Live PostgreSQL production HTTP verified an exact four-value `CHECK`-derived
  vocabulary. Live MySQL production HTTP verified an exact four-value native
  `ENUM` vocabulary. Both retained the exact two-tool model surface, trusted
  tenant/principal scope, isolated budgets, source/session ceilings, and no
  source mutation.
- The complete release gate exited 0 for `@synapsor/runner@1.7.0`: typecheck;
  13 release files and 580/580 tests; current Claude Code and Codex MCP config
  acceptance; disposable first-run proof; PostgreSQL/MySQL production HTTP;
  public commands; local and packed packages; packed production HTTP; guarded
  own-database onboarding; packed PostgreSQL/MySQL fresh CLI onboarding;
  license/content and manifest checks; npm publish dry-run; and final diff
  validation.
- Packed fresh CLI onboarding reached explicit provider choice in 3,180 ms on
  PostgreSQL and 3,178 ms on MySQL, with inline scope resolution, column review
  retained, exact boundary activation, and no source mutation.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical
deep-dive edit was performed.

## Reviewed Enum And Catalog Safety Follow-Up

The three independently reported catalog/enum findings are closed without
expanding model authority or exposing row-derived values:

- Grouping by a reviewed enum no longer silently removes source rows whose
  schema value appeared after boundary review. Reviewed labels remain visible;
  every outside-reviewed label is combined into one deterministic opaque
  `[outside-reviewed-values]` group. Aggregate totals therefore remain complete
  while the unreviewed labels remain unavailable to the model.
- Row-shaped queries that select or explicitly filter a reviewed enum retain
  the restrictive reviewed-value allowlist. Their result metadata and both
  operator UIs now state when rows outside that allowlist were excluded.
  Explicit filters on removed or unknown enum values still refuse before source
  execution. `count_distinct` remains complete when no explicit enum filter was
  requested.
- The safe `reviewed_value_controls` result metadata contains only the affected
  field and outcome mode. It never includes the full schema vocabulary, removed
  labels, source labels, or kept-out/model-withheld values. CLI and Workbench
  show equivalent hardcoded notices; no model-facing tool was added.
- Explicit catalog diagram exports are confined to the project root. Runner
  rejects lexical `..`/absolute escapes and also compares real parent paths
  after directory creation, preventing a project-local symlink from redirecting
  an export outside the project. Exclusive-create/no-overwrite behavior remains
  unchanged.
- Catalog operation summaries no longer present model-withheld fields as normal
  model-visible analysis. CLI diagrams, paginated catalog output, and Workbench
  separately label Runner-only aggregate operations as raw-value-withheld and
  Runner-only group/time operations as label-tokenized. Mermaid output retains
  counts only and does not expose those field names.
- Real MySQL production HTTP verification found an additional parameter-binding
  defect: enum CASE placeholders occur in SELECT before trusted-scope
  placeholders in WHERE, but the bound values were ordered scope-first. MySQL
  now binds SELECT CASE values first, then join/WHERE/scope values, then LIMIT;
  PostgreSQL's numbered-placeholder order is unchanged. A dialect-specific
  regression locks the exact ordering.

## Final Verification After Reviewed Enum And Catalog Safety Follow-Up

- `corepack pnpm typecheck`: passed after the final MySQL correction.
- Focused Scoped Explore, Analytics shell, catalog, and Workbench regressions:
  110/110 passed before the dialect correction; the final exact MySQL binding
  regression passed afterward.
- Direct live MySQL production HTTP Explore passed after the binding fix with
  the exact two-tool surface, principal budget isolation, tenant isolation,
  source/session ceilings, and no source mutation.
- Full suite with live PostgreSQL accounting enabled: 88 files, 1,364/1,364
  tests passed. The PostgreSQL accounting suite ran 8/8 rather than skipping.
- Auto Boundary Workbench visual gate passed across 27 captured states.
  Workbench Ask visual gate passed across 8 states with reviewed catalog maps,
  no persisted provider key, zero browser-storage entries, and no source
  mutation.
- The complete 1.7.0 release gate traversed typecheck, 13 release files and
  580/580 tests, MCP-client configs, disposable first run, live PostgreSQL and
  MySQL production HTTP, public/local/packed artifacts, packed production HTTP,
  guarded own-database onboarding, and packed first-run CLI. After the original
  output handle was lost during session compaction, the final packed first-run
  and publish/diff tail were rerun independently and passed.
- Packed first-run CLI passed from fresh projects on PostgreSQL (3,890 ms) and
  MySQL (3,939 ms), including inline blocked-scope resolution, retained column
  review, exact activation, provider choice, and no source mutation.
- `corepack pnpm publish --dry-run --access public --no-git-checks` passed for
  `@synapsor/runner@1.7.0`; `git diff --check` passed.

No commit, push, publish, Spec/DSL bump, Cloud-repository change, or technical
deep-dive edit was performed.

## Derived Scope Completion And Final Verification

This section supersedes the earlier "Remaining" list under Derived Scope
Implementation Progress. Reviewed derived tenant and principal scope is complete
for the same unpublished Runner 1.7.0 branch.

- Normalized read resources without direct scope columns can use a human-reviewed
  one- or two-hop mandatory scope path to a directly scoped ancestor. Every hop
  remains a non-null, catalog-proven many-to-one foreign key targeting an exact
  primary or unique key; ambiguous, nullable, cyclic, unproven, or deeper paths
  remain blocked.
- The mandatory path is authority metadata, not a model argument. Scoped Explore
  compiles it as a correlated `EXISTS` semijoin for root resources and reviewed
  relationship targets across rows, aggregate/group/time, ranked, and period
  comparison plans. This constrains every source row without multiplying
  aggregates or allowing the model to remove, weaken, or outer-join the scope.
- CLI and Workbench use the same canonical path review, digest, generation-lock,
  drift, summary, and activation behavior. No path becomes active without the
  existing exact human boundary review.
- PostgreSQL role-bound scope proves effective RLS on the terminal ancestor;
  MySQL enforces the same trusted tenant/principal values through the mandatory
  Runner predicate. Path ancestors participate in posture checks and safe
  metadata-only evidence.
- Protect/public DSL and guarded writes still require direct tenant and principal
  columns. A successful relationship-scoped Explore analysis cannot be converted
  into authority that the production read/write compilers do not support.
- Existing direct-scope serialized boundaries remain shape-compatible. No Spec,
  DSL, package-version, model-tool-surface, or Cloud-repository change was made.

Final verification:

- Focused Auto Boundary, CLI picker/review, Workbench, local UI, trusted-scope,
  Guided Action, Protect, and Scoped Explore regressions passed after correcting
  two stale colorized-label assertions.
- Full suite with live PostgreSQL accounting enabled: 88 files and 1,376/1,376
  tests passed; the PostgreSQL accounting suite ran 8/8 rather than skipping.
- Direct PostgreSQL production HTTP and direct MySQL production HTTP passed with
  the exact two-tool surface. Cross-tenant and cross-principal normalized-child
  queries were isolated through derived scope, concurrent budget reservation and
  source/session ceilings held, and Explore did not mutate either source.
- Auto Boundary Workbench visual gate passed across 27 captured desktop, mobile,
  light/dark, blocked, stale, loading, and large-schema states. Workbench Ask
  passed across 8 states with 2 reviewed tool calls, 1 refused call, no persisted
  provider key, no browser storage, and no source mutation.
- Packed production HTTP passed with derived tenant/principal isolation,
  per-principal budget isolation, source/session ceilings, doctor attestation,
  the exact two-tool surface, and no source mutation.
- The complete `./scripts/verify-release-gate.sh 1.7.0` gate exited 0: typecheck;
  13 release files and 589/589 tests; current Claude Code and Codex MCP config
  acceptance; disposable first-run proof; live PostgreSQL/MySQL production HTTP;
  public commands; local and packed packages; packed production HTTP; guarded
  own-database onboarding; packed fresh CLI onboarding; license/content and
  package-manifest checks; npm publish dry-run; and final `git diff --check`.
- Packed fresh CLI onboarding passed from empty projects on PostgreSQL (3,275 ms)
  and MySQL (3,330 ms), resolving blocked scope inline, keeping column review
  open, activating the exact boundary, reaching explicit model choice, and not
  mutating the source.

The derived-scope work was committed as `1478875` on
`feature/production-scoped-explore-http`. It has not been pushed or published.

## Missing Authority-Dependency Defensive Hardening

- `assertPreparedExplorePlanAuthority` no longer accepts a prepared boundary
  with derived tenant or principal scope when its generation lock lacks
  `authority_dependencies`. It fails closed with `EXPLORE_LOCK_STALE`, states
  that no query executed, and includes the existing regeneration guidance.
- Dependency-less legacy locks remain compatible only for boundaries whose
  resources all use direct scope. Activation and generation-lock fingerprints
  already prevented the malformed derived state from normal disk loading; this
  adds defense in depth at the final pre-execution assertion.
- Focused Scoped Explore regression: 50/50 passed. Typecheck passed.
- Full suite against a fresh live PostgreSQL accounting database: 88 files and
  1,377/1,377 tests passed, including the PostgreSQL accounting suite at 8/8.
  License/content, human command-surface, DSL path, and Cursor plugin gates also
  passed.

This hardening remains part of unpublished Runner 1.7.0. No Spec/DSL bump,
Cloud change, push, or publish was performed.

## Derived Scope Index Doctor Advisory

- `doctor` now reads live PostgreSQL `pg_index`/`pg_attribute` metadata and
  MySQL `information_schema.STATISTICS` metadata for the exact derived tenant
  and principal paths already recorded in each active reviewed boundary. It
  does not infer alternative relationships or read source rows.
- Every mandatory path link checks that the child foreign-key columns are the
  leading columns of a usable, non-partial index and that the referenced
  ancestor key is index-backed. The terminal tenant/principal filter column is
  checked as a lower-severity optimization note.
- Missing child coverage produces a non-gating warning; missing referenced-key
  or terminal-filter coverage produces a non-gating note. Each finding names
  the exact boundary, reviewed path, table, and columns and includes
  engine-correct `CREATE INDEX` SQL for separate operator review. Runner never
  executes that SQL.
- A clean run explicitly attests that every reviewed derived-scope path is
  index-backed. Direct-scope and unscoped resources produce no derived-path
  advisory output.
- The structured catalog index fields are deliberately excluded from reviewed
  schema fingerprints. Adding, dropping, or rebuilding an advisory performance
  index cannot silently alter authority, activation digests, or generation-lock
  bytes.
- The check is advisory only: it does not gate `doctor`, startup, local Explore,
  or production HTTP Explore; it does not alter mandatory scope predicates,
  budgets, model tools, or source data.

Verification:

- Focused derived-scope doctor, schema-inspector fingerprint, and runtime-doctor
  regressions: 25/25 passed. Typecheck passed.
- Direct live PostgreSQL production HTTP passed. It attested two indexed tenant
  and principal paths, detected a deliberately dropped child FK index with two
  non-gating warnings and copyable SQL, then passed the real public `doctor`
  path after the index was restored. Source mutation by Explore remained false.
- Direct live MySQL production HTTP passed using actual
  `information_schema.STATISTICS` leading-column metadata, with both reviewed
  paths attested and no source mutation by Explore.
- Full suite with live PostgreSQL accounting enabled: 89 files and
  1,385/1,385 tests passed; the PostgreSQL accounting suite ran 8/8 rather than
  skipping.
- Packed production HTTP passed with the exact two-tool model surface, derived
  tenant/principal row isolation, per-principal budget isolation, concurrent
  reservations, source/session ceilings, public doctor attestation, derived
  scope index attestation, and no source mutation.

This advisory remains part of unpublished Runner 1.7.0. No Spec/DSL bump,
Cloud-repository change, push, or publish was performed.

## Single-Organization Scoped Explore (Complete)

Requested outcome: allow a genuinely one-organization PostgreSQL or MySQL
source with no tenant column to use local/staging and production HTTP Explore
without adding a fake column or view. Multi-tenant behavior must remain
unchanged and fail closed.

Implemented so far:

- Added an optional, additive boundary-level `organization_scope` declaration:
  `single_organization`, a fixed organization ID, and the exact
  `all_rows_belong_to_one_organization` acknowledgment. Its absence preserves
  legacy boundary JSON and multi-tenant behavior.
- Bound the declaration into draft authority, activation digest, generation
  lock, active-boundary validation, and active-boundary-set compatibility.
- Added a hard generation, activation, and pre-query refusal guard when live
  inspection finds tenant candidates, tenant-marked columns, or RLS metadata.
  The error enumerates the evidence and confirms no boundary/query activation.
- Single-organization resources must have neither direct nor derived tenant
  scope. Multi-tenant resources still require exactly one. Direct and derived
  principal scope remain unchanged and optional.
- SQL compilation emits no tenant predicate only when the active boundary has
  the exact reviewed declaration. Principal predicates still compile normally.
- Local Explore resolves the fixed organization ID without requiring
  `SYNAPSOR_TENANT_ID`; a reviewed principal still requires
  `SYNAPSOR_PRINCIPAL`.
- Production HTTP config supports mutually exclusive
  `production_explore.single_organization_id` or `session_auth.tenant_claim`.
  The principal claim remains mandatory. JWT verification ignores any
  request-supplied tenant in single-organization mode and binds the fixed ID for
  accounting/audit. Session creation rejects an identity mismatch.
- `start` and `boundary draft` accept the explicit pair
  `--single-tenant --organization-id <stable-id>`. Production draft generation
  additionally requires `--principal-claim` and forbids `--tenant-claim`.
- `config init --production-explore` derives the fixed identity from a reviewed
  draft or accepts `--single-tenant-organization-id`; generated config omits
  the tenant claim.
- Boundary review decisions now include and retain the global organization
  acknowledgment plus per-resource whole-organization access. The CLI review
  summary states that no tenant predicate is applied; model-facing
  `describe_data` reports the posture without exposing the organization ID.
- Boundary regeneration, review mutations, and Workbench rescan preserve the
  exact mode. Doctor reports the reviewed one-organization posture.
- Protect conversion fails early with a clear message because protected named
  capabilities still require a direct tenant column. Writes remain unchanged.
- Updated CLI help and the production/local Explore operator documentation.

Final implementation corrections from live use:

- A tenant-free query exposed a compiler assumption that every query had at
  least one scope predicate, producing `WHERE GROUP BY` or `WHERE LIMIT`.
  Aggregate and row compilers now omit `WHERE` when there are no predicates;
  focused regressions cover both shapes.
- The strict MCP output validator initially omitted the new model-safe
  `organization_scope` posture. It now accepts only the fixed posture fields and
  still excludes the configured organization ID.
- Generated local config and `.env.example` no longer request a tenant binding
  for a fixed-organization boundary. Doctor accepts that exact authoring posture
  without `SYNAPSOR_TENANT_ID`, while retaining principal checks where reviewed.

Final verification completed:

- Full suite with live PostgreSQL accounting enabled: 90 files and
  1,404/1,404 tests passed; the PostgreSQL accounting suite ran rather than
  skipping.
- A fresh real PostgreSQL source with no tenant column or RLS completed
  interactive draft, review, exact activation, provider selection, and a real
  aggregate. It returned six `open` rows totaling 2,100 and six `paid` rows
  totaling 5,700 with no tenant environment value and an unchanged source
  snapshot.
- Doctor passed that active local boundary, reported the fixed-organization
  posture, and did not request `SYNAPSOR_TENANT_ID`.
- PostgreSQL secured HTTP production Explore passed with a principal-only JWT,
  exact two-tool exposure, safe model-facing posture, whole-organization
  analytics, per-principal budget isolation, mandatory principal identity,
  fixed-organization startup mismatch refusal, and no source mutation.
- MySQL secured HTTP production Explore now includes the same real tenant-free,
  principal-only scenario. It passed whole-organization analytics,
  per-principal budget isolation, mandatory principal identity, exact two-tool
  exposure, and source-mutation checks alongside the existing multi-tenant and
  derived-scope scenarios.
- Packed production HTTP passed through the public CLI artifact and includes
  the fixed-organization PostgreSQL scenario.
- Auto Boundary and Workbench Ask visual gates passed on desktop and mobile,
  including the reviewed whole-organization posture and exact activation path.
- Existing multi-tenant PostgreSQL/MySQL behavior, tenant/principal isolation,
  suppression, differencing, atomic accounting, source/session ceilings,
  derived scope, and read-only source verification remained green.

No Cloud-repository files, package versions, Spec/DSL versions, tags, releases,
or published artifacts were changed.

## Multi-Boundary Discovery, Live Access, and Catalog UX (Complete)

This unpublished 1.7.0 follow-up fixes the first-time and smaller-model failure
cases found while using more than one active boundary. It changes discovery,
resource resolution, and operator presentation; it does not widen reviewed
authority.

Model-facing discovery and routing:

- `app.describe_data` now advertises one canonical actionable vocabulary: exact
  resource IDs, field IDs, and relationship IDs. Alternate human labels are no
  longer presented beside exact identifiers, so a model is not asked to choose
  between two names for the same operation.
- The catalog still provides the planning metadata needed to use those IDs:
  legal operations and operators, reviewed enum values, time coverage,
  relationship targets and structural proof, path depth/cardinality, egress
  posture, suggested legal plans, result bounds, and privacy posture.
- Runtime recovery accepts an unambiguous bare, humanized, or case-insensitive
  resource name only when it resolves to exactly one resource in active
  reviewed authority. The canonical exact ID is substituted before validation,
  execution, evidence projection, and provider output.
- Ambiguous recovery remains fail-closed and lists the exact boundary/resource
  pairs. Unknown resources return bounded valid exact IDs and a nearest reviewed
  suggestion. No alias can resolve to an inactive or unreviewed resource.
- Explore refusals retain their specific resource/boundary error instead of
  collapsing the useful recovery context into a bare `MCP_TOOL_REFUSED`.
- Local and production boundary-set runtimes refresh the activated boundary set
  before describe and explore calls. A newly activated boundary or revision is
  available without restarting the CLI or reconnecting an HTTP MCP client.

Operator access UX:

- Terminal `/access` activation rebinds the current Ask shell to the exact new
  authority while retaining the selected provider, model, and memory-only key.
  The old conversation is cleared so stale catalog context cannot influence the
  new authority.
- `/refresh-access` performs the same exact-authority rebind after activation in
  Workbench or another terminal. It previews the authority and provider-egress
  consequence, rechecks the digest at confirmation, and fails closed on a stale
  race without making a provider request.
- Pending-change notices scan all boundaries, explain whether the cause is a
  schema/role posture change or an operator access edit, and give the exact
  boundary-overview action: `/access`, highlight the boundary, then press `C`
  to review and activate. The intentional first Quick Start staging review is
  not mislabeled as an unreviewed user change.
- Enum editing keeps staged column-access changes, Enter saves the enum and
  staged access decision atomically after any required actor/reason review, and
  returns to the column screen. Apply, reject, unchanged, discard, and cancel
  outcomes are explicit.
- Help and onboarding docs now state that `--rescan` deliberately re-inspects
  both single-organization and multi-tenant projects. Ordinary restart resumes
  pinned review; a rescan creates a disabled revision while the previous exact
  authority stays active. `--force` remains overwrite/reset behavior.

Catalog and diagram UX:

- `/catalog` is relationship-aware and lists exact reviewed join paths,
  cardinality, proof, path depth, available analysis, and useful single-table or
  cross-table questions.
- `/catalog --diagram --boundary <name>` renders exactly one active boundary.
  Connected terminal maps include directional paths and questions; a one-table
  boundary becomes a useful analysis map and does not pretend an empty ERD is a
  relationship diagram.
- Mermaid is generated from the same redacted canonical model used by CLI and
  Workbench. Parser tests cover one-node, disconnected, multi-hop, nullable,
  unproven, identifier-collision, special-character, and multi-boundary cases.
  Every per-boundary export is parser-valid. Large maps favor a non-overwriting
  project-local export.
- Workbench provides the same boundary selector, questions, downloadable map,
  Mermaid source, and a readable directional graph. Arrow direction and proof
  styling are explained; hidden keys and fields remain redacted.
- Multiword shell actions including `/catalog --diagram`,
  `/catalog --diagram --boundary <name>`, and `/details last` are parsed as
  commands rather than autocomplete misses.

Preserved boundary and security behavior:

- Direct tenant/principal scope, mandatory derived tenant/principal paths,
  authority-dependency re-proof, single-organization scope, reviewed
  relationship proofs, schema-declared enum allowlists and audited enum
  narrowing, time coverage, suppression, differencing, extraction and rate
  budgets, read-only execution, and source-mutation checks remain intact.
- The model surface remains exactly `app.describe_data` and
  `app.explore_data`. It gains no SQL, activation, review, Protect, approval,
  apply, credential, tenant, or principal authority.
- PostgreSQL, MySQL, packed, local CLI, and secured production HTTP paths use
  the same canonical reviewed IDs and boundary resolution rules.

Verification completed:

- Focused changed-surface tests passed: 9 files and 211 tests, followed by the
  Ask-authority/boundary CLI regression set at 39/39.
- Strict MCP output-schema tests passed at 5/5 and reject removed alternate
  label fields while accepting all retained planning and privacy metadata.
- PostgreSQL secured production HTTP passed canonical discovery, unadvertised
  alias recovery, direct and derived tenant/principal isolation,
  single-organization principal-only JWT, per-principal budgets, concurrent
  reservation, connection/session ceilings, suppression, doctor/index
  attestation, exact two-tool exposure, and no source mutation.
- MySQL secured production HTTP passed the corresponding multi-tenant,
  derived-scope, fixed-organization, privacy, transport, and no-mutation gates.
- Packed production HTTP passed through the public packed artifact with the
  same controls and exact two-tool surface.
- Auto Boundary Workbench visual verification passed 27 states. Workbench Ask
  browser verification passed eight rendered states with no persisted API key,
  no browser storage, expected refusal/auth behavior, and no source mutation.
- A disposable real PostgreSQL human PTY run completed first-run provider
  selection, connected `/catalog --diagram`, `/details last`, staged column and
  enum edits with actor/reason, exact `C` activation, and same-process Ask
  rebinding. The activated catalog reflected the new Runner-only field and
  narrowed enum without exposing the enum values to the model. The source was
  unchanged.
- Final full suite with live PostgreSQL accounting enabled: 90 files and
  1,415/1,415 tests passed. License/content, human command-surface, DSL source
  path, and Cursor plugin checks also passed.

No Cloud-repository files, package versions, Spec/DSL versions, tags, pushes,
releases, or published artifacts were changed.
