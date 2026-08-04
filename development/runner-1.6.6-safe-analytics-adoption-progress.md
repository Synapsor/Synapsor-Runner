# Runner 1.6.6 Safe Agent Analytics Integration Progress

## Goal

Implement `/home/sandesh-tiwari/Desktop/C++/goal.txt` without weakening the
Runner trust boundary. The release improves the existing Auto Boundary and
Scoped Explore adoption path, fixes confirmed first-run defects, adds
host-neutral analytical interoperability, preserves existing operational
capabilities, and prepares (but does not publish) Runner/alias 1.6.6.

## Starting State

- Date started: 2026-07-26
- Starting commit: `18da2531a9ed3936b05f99cd285cca3cda519bac`
- Starting branch: `main`
- Working branch: `feat/runner-1.6.6-safe-agent-analytics`
- `main` matched `origin/main`: yes
- Starting worktree: clean
- Node: `v22.22.2`
- Package manager: `pnpm@10.14.0`

Package baselines:

- `@synapsor/runner`: `1.6.5`
- `synapsor-runner`: `1.6.5`
- `@synapsor/spec`: `1.7.0`
- `@synapsor/dsl`: `1.7.0`

Trusted/adoption hotspot line counts:

- `apps/runner/src/local-ui.ts`: 6806
- `apps/runner/src/boundary-workbench.ts`: 2255
- `apps/runner/src/auto-boundary.ts`: 2443
- `apps/runner/src/scoped-explore.ts`: 1889
- `apps/runner/src/ask-mcp-gateway.ts`: 232
- `apps/runner/src/model-ask.ts`: 1075
- `apps/runner/src/boundary-commands.ts`: 752
- `apps/runner/src/guided-start.ts`: 444

## Repository Instructions Read

- `/AGENTS.md`
- `/apps/runner/AGENTS.md`

Load-bearing constraints retained:

- no raw SQL or model-facing approval/apply/writeback;
- trusted tenant/principal context remains outside model arguments;
- proposals do not mutate the source before approval;
- guarded apply and receipt/replay behavior remain unchanged;
- SQLite lease/concurrency safety remains intact;
- generated secrets, ledgers, `.env` files, and npm tarballs are not committed.

## Preliminary Finding Classification

These classifications must be confirmed with source and packed evidence before
the implementation checkpoint is closed.

| Finding | Preliminary classification | Evidence/status |
| --- | --- | --- |
| Missing `start --no-open` | stale | Current `guided-start.ts` already accepted it; packed no-open behavior and help/recovery were verified. |
| All-blocked Workbench renders no resources | confirmed, then repaired | The boundary API constructed an instant candidate before returning review evidence. Source, packed healthcare, and browser evidence now prove blocked resources render and remain resolvable. |
| CLI cannot resolve/include row identity, tenant, or principal | confirmed by source | Current boundary command confirms/activates existing decisions but has no per-resource mutation surface. |
| Headless activation missing | stale | Existing signed `boundary activate --headless` is retained. |
| Analytics Ask receives combined authoring/runtime tools | confirmed by source | `ask-mcp-gateway.ts` combines catalogs. |
| Natural-language CLI Ask missing | confirmed by command/source inventory | Workbench provider loop exists and must be reused. |
| `start` overwrites existing config | stale | Current refusal behavior was preserved; ownership, collision, rollback, and packed resume tests prove existing files are not silently replaced. |
| Bootstrap token recovery | partly stale, narrow UX defect repaired | One-time exchange was intentional. Same-session reopen and explicit same-process reissue now work while copied-token reuse remains unauthorized. |

## Decisions

1. Build on existing Auto Boundary, Scoped Explore, Workbench Ask, provider
   adapters, encrypted Protect-plan state, and Protect generation.
2. Workbench and CLI boundary review will share one domain implementation.
3. Dynamic Explore remains explicit local/development/staging authority.
   Production continues to expose only activated named capabilities.
4. BI/analytics is the adoption example, not a Runner UI/product category.
   External applications own charts, dashboards, exports, and reports.
5. Do not add a BI connector. Add a host-neutral MCP integration example and
   conformance harness instead.
6. Spec/DSL stay at 1.7.0 unless a genuine public contract change is proven and
   separately authorized.

## Verification Log

| Check | Result | Evidence |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | pass | Lockfile current; all 16 workspace projects already up to date. |
| `corepack pnpm typecheck` | pass | TypeScript project references clean. |
| `corepack pnpm check:trusted-core-dependencies` | pass | 146 modules, 736 internal edges. |
| `corepack pnpm test` baseline | pass | Starting baseline: 63 files, 950 tests; license, human-command surface, DSL paths, and Cursor plugin passed. |
| `corepack pnpm test` final root gate | pass | Typecheck, trusted-core architecture, 70 files/984 tests under four workers, license/content, human-command surface, DSL paths, and Cursor plugin all passed after the 1.6.6 version preparation. |
| trusted-core architecture extraction | pass | Shared MCP input-schema construction moved below both tool catalogs, and the persisted boundary-review artifact shape moved below generation/review services. The architecture checker now covers 156 modules and 775 internal edges with no cycle or upward dependency. |
| `node scripts/verify-cursor-plugin.mjs` | pass | Plugin manifest and every pinned command now target 1.6.6; official format, path-with-spaces, copied reinstall, clean uninstall, unrelated config preservation, and absence of embedded secrets/activation authority passed. |
| previously flaky paths, three sequential runs | pass | Each one-worker run passed signed approval/apply, independent Streamable HTTP session context, cross-process SQLite contention, and the cwd poison/recovery pair: 6 passed per run, no downstream contamination or leaked process state. |
| `corepack pnpm test:auto-boundary-explore:packed` | pass on 1.6.6 artifact | Four immutable published baselines plus the current packed artifact. Stale pre-activation review progress cannot widen demand-driven relationship review; exact catalog-proof review/activation/retry completes in 3 interactions and 4.569s; two comparison cohorts returned, two suppressed, one incomplete; semantic aliases, exact two authoring tools, one production protected tool, read-only transaction, and no source mutation verified. Full client discovery is 22,033 bytes; the actual model-facing surface is 7,311 bytes / about 1,828 tokens. |
| `corepack pnpm test:packed-backward-compatibility` | pass | Fresh packed Runner verified against exact npm tarballs and hashes for Runner 1.5.4/1.6.0/1.6.3/1.6.5 and their Spec/DSL 1.4.2/1.4.4, 1.5.0, 1.6.0, and 1.7.0 package graphs. Canonical digests, legacy tools, TypeScript authoring, recent CLI routes, and protected DSL remain compatible. |
| `corepack pnpm test:published-compatibility` | pass | Seven legacy contracts and four DSL sources retain exact canonical digests across all four published baselines. |
| `corepack pnpm test:workbench-ask` | pass | 5 provider requests, 2 reviewed tool calls, desktop/mobile captures, no persisted key/browser state, no source mutation. |
| `corepack pnpm test:auto-boundary-visual` | pass | 17 captures and 40-resource fixture; existing fixture does not reproduce the all-blocked API failure. |
| `corepack pnpm test:guided-onboarding:packed` | pass on 1.6.6 artifact | Packed FitFlow: 40 resources; schema summary 2.721s, first safe read 4.308s, aggregate 6.211s, optional Protect 7.148s, first proposal 15.942s, one shell command, no manual edits. OIDC approval/apply separation, competing supervised workers, limits, stale-source conflict, receipts/replay, compensation, and quiet signed notifications also passed. |
| all-blocked Workbench regression | pass | `/api/boundary` returns all inspection/review evidence with zero candidate resources; instant onboarding is ineligible and direct instant activation returns 409 without authority. |
| bootstrap same-browser regression | pass | A consumed URL token redirects only when the request already carries the valid HttpOnly session cookie; copied-token reuse remains 401. |
| shared boundary-review focused gates | pass | Typecheck plus Auto Boundary, signed CLI review, and local Workbench suites pass; CLI resolves blocked scope into disabled state and Workbench uses the same mutation module. |
| batch boundary-review decision file | pass | A strict v1 file binds the exported review bundle, draft/candidate digests, generation lock, schema/role fingerprints, and review revision; duplicate/unknown/stale input fails, while exact signed application commits two disabled resources as one revision. |
| managed artifact collision/rollback | pass | `--force` refuses unowned generated/state paths. An injected failure after output swap restores generated output, lock/report/overrides, active authority, and review progress byte-for-byte. |
| Phase 1 focused regression | pass | Typecheck; Auto Boundary 17/17; boundary CLI 3/3; local Workbench 30/30. |
| CLI Ask and mode separation | pass | `try ask` supports OpenAI, Anthropic, and loopback/OpenAI-compatible configuration through the existing provider loop; exact consent, no CLI key, secret non-persistence, and separate untrusted prose/verified analysis are covered. Active authoring mode exposes exactly `app.describe_data` and `app.explore_data` even when runtime read/proposal tools exist. |
| Ask authority drift | pass | Authority is revalidated before/after provider requests and before tool calls; a changed authority aborts before the requested tool executes and clears history. |
| Repeated Explore and optional Protect | pass | Workbench and CLI make another bounded question the primary continuation, emit no protected artifact merely for running a plan, and carry exact expiring analysis references into optional Protect. |
| Phase 2/3 focused regression | pass | Typecheck plus Ask gateway, CLI Ask, provider loop, and local Workbench suites: 52/52. |
| Scoped analytical result contract | focused pass | New authority binds UTC for newly generated boundaries without changing absent legacy fields. Comparison ranges execute in one repeatable-read/read-only transaction, return semantic aliases plus deterministic absolute/percentage changes, and distinguish empty, fully suppressed, and incomplete comparison outcomes. Scoped Explore focused suite: 14/14. |
| Shared analytical output schemas | focused pass | `app.describe_data` and `app.explore_data` advertise structured outcome discriminators from shared Zod/JSON Schema. Success, empty, suppression, incomplete-comparison, refusal, malformed value, and mutation-state variants are schema-tested. |
| Safe analytics catalog | focused pass | Deterministic digest-pinned CLI/MCP catalog includes only derivable active analytical contracts and omits SQL, scope columns/values, kept-out fields, credentials, and generation-lock internals. |
| External-client conformance | focused pass | Official MCP client exercised generic stdio and bearer-authenticated Streamable HTTP for discovery, catalog pinning, bounded analytics, semantic read/proposal, illegal scope argument refusal, and absent approval/apply tools. |
| `corepack pnpm test:host-neutral-example:packed` | pass | Clean tarball install contains readable TypeScript source plus a generated Node 22 `.mjs` executable. The official SDK client discovers reviewed schemas/digest pins over stdio with no SQL/operator tools and no source mutation. |
| post-version clean-room package identity | pass | FitFlow, 45-table retail, all-blocked healthcare/PHI, and live community-solar evidence were regenerated from `synapsor-runner-1.6.6.tgz`; Spec remained `1.7.0`. |
| `corepack pnpm test:reviewed-relationships` | pass | Live PostgreSQL and MySQL proved exact star/depth-two totals, explicit nullable semantics, per-relation scope, and fan-out refusal. |
| `corepack pnpm test:aggregate-read` | pass | Live PostgreSQL and MySQL proved fixed count/sum/avg, trusted tenant selection, cohort suppression, safe evidence/audit, timeout classification, and no member-row leakage. |
| `corepack pnpm test:principal-scope` | pass | PostgreSQL and MySQL each passed both DSL source forms; principal and tenant scope held across participating relations and shared-ledger handles. |
| `corepack pnpm test:proposal-freshness` | pass | Live PostgreSQL/MySQL target and supporting-evidence drift, DELETE, bounded sets, quorum, shared store, Cloud-linked local revalidation, idempotency, and kept-out-value cases passed. |
| `corepack pnpm test:smoke` | pass | The complete release smoke passed: 441 core tests, generated MCP client configs, installed Claude Code/Codex config acceptance, first-run Docker proof, public/local/packed Runner checks, packed own-database flow, content/license gates, npm publish dry run, and worktree diff validation. |
| publish manifests and packed packages | pass | Frozen install, build, `verify:runner-publish-manifest`, `verify:packed-runner`, and `verify:packed-runner-alias` passed for Runner/alias 1.6.6. Spec/DSL remained 1.7.0. |
| final process/container/secret cleanup | pass | No Runner/browser test process or test Docker resource remained. Exact authorized OpenAI key scan found zero occurrences across tracked and untracked repository files. No tarball, `.env`, credential, or temporary runtime file is staged for source control. |
| Protected reporting-timezone authority | focused pass | New generation locks and Runner configs bind UTC without changing public Spec/DSL or legacy lock digests. Preflight rejects mismatch; PostgreSQL and MySQL set UTC inside/before the same read-only transaction; output/catalog metadata reports the reviewed timezone. |

Baseline interpretation:

- Existing happy-path fixtures prove the analytical engine, suppression,
  Protect, production narrowing, and write boundary are healthy.
- The packed healthcare clean room starts with every resource blocked and the
  real browser flow renders, resolves, confirms, and activates reviewed
  authority. This closes the original all-blocked browser failure.

## Phase 1 Implementation Notes

- `GET /api/boundary` no longer constructs an invalid one-resource candidate
  when the generated pack is empty.
- Workbench blocked-resource filters now include identity/scope/status blockers,
  sort blocked resources first, state one next action, and provide useful empty
  and failed-load recovery controls.
- Bootstrap URLs remain one-time. A browser already holding the valid session
  cookie can safely reopen the original URL and is redirected to the clean URL.
- Boundary-review state and mutation logic now live in focused
  `boundary-review-domain.ts` and `boundary-review-mutation.ts` modules.
- The CLI can inspect one resource, select source-proven row/tenant/principal
  columns, include/exclude it, narrow fields/relationships, preview a semantic
  diff and exact digest, and apply disabled review state with a signed operator
  decision. It does not activate authority.
- Large schemas can use one strict versioned decision file. The file is review
  input only; preview/application and activation remain separate, and
  noninteractive application still requires a short-lived signed-key or OIDC
  operator decision.
- Reviewer identity/reason/timestamp remain in audit artifacts but no longer
  alter the generated authority digest. Equivalent Workbench and CLI authority
  choices therefore converge on the same digest.
- Auto Boundary output and its private lock/report/override/progress state are
  now staged and committed together with managed ownership and rollback
  protection. Rescan and review mutation no longer leave a mixed artifact set
  after a caught filesystem failure.
- The local UI process can mint a fresh one-time bootstrap URL on explicit
  terminal request while keeping the established HttpOnly browser session;
  consumed or copied bootstrap URLs remain unauthorized.

## Phase 2/3 Implementation Notes

- `try ask` is now a first-class command. It uses the existing in-memory MCP
  gateway and existing OpenAI/Anthropic/OpenAI-compatible provider loop rather
  than a second function-calling implementation.
- API keys come only from a conventional or explicitly named environment
  variable, or an interactive hidden prompt. `--api-key` and generic `--yes`
  are refused. JSON automation still requires exact non-secret consent bound to
  provider, model, endpoint origin, profile, active boundary, config, and tool
  surface.
- Ask sessions select one catalog: the exact two authoring tools while Scoped
  Explore is active, or named runtime tools after Explore is disabled. They
  never combine the surfaces or silently switch.
- Workbench and CLI label provider prose as untrusted and show numbered
  Runner-verified tool executions separately. Each successful Explore execution
  carries its existing encrypted, expiring local Protect reference.
- Successful Explore now leads to another bounded question. Protect remains a
  visible optional promotion path and accepts an exact `--from` reference; no
  DSL, contract, test, draft, or authority is created merely by asking.

## Phase 3/4 Implementation Notes

- Newly generated exploration boundaries bind `reporting_timezone: UTC` into
  the exact reviewed authority digest. The field is additive and omitted from
  legacy authority reconstruction when absent, preserving existing digests.
- A two-period comparison is one repeatable-read, read-only database
  transaction. It aggregates each bounded range at the reviewed grouping,
  computes period values, absolute change, and percentage change only when the
  earlier denominator is nonzero, and never introduces a formula language.
- Analytical rows now use stable semantic aliases instead of implementation
  placeholders such as `measure_0`. Result metadata names the counted entity,
  grain, measures, dimensions, redacted filter shapes, reviewed relationship
  paths, reporting timezone, snapshot/as-of state, suppression outcome,
  returned bytes/cells/groups, remaining budgets, query-audit handle, and
  unchanged source state.
- `boundary status` is the canonical resume surface. It does
  not rescan the database and reports config/review/active-boundary state,
  cumulative local Explore budgets, recent expiring analysis references,
  protected drafts, active named tools, production blockers, and one next
  action.
- `synapsor.analytics-catalog.v1` and `tools catalog` derive from the same
  capability/output schema builders used by tools/list. External clients must
  pin capability plus exact contract digest.
- A host-neutral official TypeScript MCP client example now covers local stdio
  and secured Streamable HTTP without SQL, database credentials, provider
  coupling, trusted-scope arguments, policy duplication, or product UI. The
  packed build compiles the readable TypeScript source to a dependency-free
  Node entrypoint so consumers do not need a global compiler or `tsx`.
- Newly generated protected analytics bind `UTC` into the private generation
  lock and matching Runner config. The protected capability already binds the
  exact lock fingerprint, so production promotion keeps identical time-bucket
  semantics without adding a public Spec/DSL field. Legacy locks and configs
  omit the field and retain their prior digest/behavior.
- Demand-driven relationship review now reconstructs its candidate from the
  exact currently active boundary, never from potentially broader saved
  pre-activation progress. It preserves the active boundary's complete reviewed
  decision set and reporting timezone, then adds only the selected
  catalog-proven path before exact-digest activation.
- The packed model-facing authoring surface is 7,311 bytes / about 1,828
  tokens and retains its 8,000-byte/2,000-token
  ceiling after excluding client-only `outputSchema` response contracts. The
  complete client discovery response has a separate 24,000-byte ceiling and
  must include an output schema for both authoring tools.
- The post-version packed 45-table retail clean room completes in 77.5 seconds from one
  public `start --from-env DATABASE_URL` command with no manual file edits. It
  exercises ten successful legal Explore plans before Protect: count,
  count-distinct, sum, average, two reviewed many-to-one dimensions, alternate
  groupings, bounded date filters, day/week grains, top-N, bottom-N, and an
  exact two-period comparison.
- Those ten analyses create no protected artifact and leave 20 durable,
  redacted query-audit entries. The same packed project proves Workbench Ask,
  CLI `try ask`, and official MCP execution against the same authoring
  authority; an incorrect CLI egress consent fails before provider access.
- The retail production runtime publishes only the activated protected
  analytical capability and proposal capability. Its MCP analytics catalog and
  CLI `tools catalog` agree, local JSON Schema references resolve to the same
  output contract, the digest-pin resource reports current, and Scoped Explore
  remains disabled after authoring.
- The packed retail timing checkpoints are: schema summary 24.0s, activation
  25.9s, first safe row 26.3s, first aggregate 26.9s, protected named
  capability 42.9s, first proposal 44.6s, and guarded apply 59.8s.
- The second packed clean room is a synthetic multi-tenant healthcare
  coordination application with 10 PostgreSQL tables, forced RLS, independent
  hospital and care-manager scope, PHI, a small cohort, and stored prompt
  injection text. All 10 resources begin blocked because `hospital_id` is not
  guessed as authority.
- The healthcare browser flow resolves the fact resource in Workbench and two
  related dimensions through a versioned signed CLI decision. The CLI decision
  changes disabled review state only and does not activate authority or read
  rows. Exact human activation follows in Workbench.
- PHI is classified before source-row access. Patient name, date of birth,
  medical-record number, insurance member ID, contact details, medical notes,
  diagnosis code, and clinical notes never appear in returned data, tool
  catalogs, normalized audit, or generated positive authority. Generated DSL
  records applicable fact-table fields explicitly under `KEEP OUT`.
- The healthcare boundary executes 10 useful legal Explore plans without
  Protect, while denying hidden dimensions/filters, patient identifier
  aggregation, raw SQL, formulas, model-selected tenant scope, unreviewed
  relationships, and excessive group requests. Same-hospital rows assigned to
  another care manager and rows from another hospital remain invisible.
- Workbench composer, Workbench Ask, CLI `try ask`, and official authoring MCP
  return the same bounded analysis. Stored instruction-like text renders as
  inert text, small cohorts are suppressed, 20 redacted query-audit entries
  survive refresh/tabs/process boundaries, and no protected artifact exists
  before the operator chooses Protect.
- Analytical output aliases now include the reviewed related resource, avoiding
  ambiguous `name`/`name_2` fields. Workbench renders those as “Name from Care
  units” and “Name from Discharge reasons.” Protect foregrounds the exact
  selected analysis, collapses alternate recent handles, and displays the
  generated DSL with syntax highlighting.
- After exact human activation of one protected analysis, Scoped Explore is
  disabled. Production stdio and secured Streamable HTTP advertise only
  `healthcare.weekly_avoided_cost_by_unit_and_reason`, return the same result,
  agree with the safe catalog digest, and leave the source checksum unchanged.
- The post-version packed healthcare run completed in 193.7 seconds. Timing
  checkpoints were: schema summary 21.5s, boundary activation 25.8s, first safe
  row 26.1s, and first aggregate 26.7s. Nine desktop/mobile browser captures
  were inspected directly.
- The authorized live OpenAI acceptance gate passed from the packed community
  solar artifact. `gpt-5-mini` first called `app.describe_data`, then called
  `app.explore_data` with exact reviewed identifiers and returned the same
  aggregate rows as the official MCP client. The live request could not
  activate, approve, or apply; changed no source data; persisted no browser
  storage or conversation; and the exact API key remained absent from process
  arguments, project artifacts, screenshots, browser profile, and evidence.
  The post-version live call used 8,288 tokens and completed in 18.2 seconds.
- Deterministic OpenAI, Anthropic, and OpenAI-compatible provider contracts pass
  24 focused tests, including malformed and unknown tool calls, redirects,
  unsafe destinations, timeouts, oversized responses, and authority
  restrictions. The built Workbench Ask browser journey also passes with the
  exact two-tool authoring catalog, explicit egress consent, cancellation,
  authority-drift refusal, two successful reviewed analyses, zero browser
  storage, and direct desktop/mobile visual inspection. No Ollama, LM Studio,
  or other local-model runtime or process is currently installed/running on the
  test host, so the real local-engine smoke is honestly not run; deterministic
  loopback OpenAI-compatible conformance remains blocking and green.

## Checkpoints

- [x] Baseline tests and packed finding reproductions recorded.
- [x] Shared Workbench/CLI review and bootstrap defects fixed.
- [x] CLI Ask, exact authoring surface, repeated Explore, and Protect references complete.
- [x] Output schemas, safe catalog, external-client example/conformance complete.
- [x] Documentation/examples/help/version preparation complete.
- [x] Full compatibility, packed, browser, provider, database, and clean-room gates pass.
- [x] Requirement-by-requirement completion audit finished.

## Deviations And Blockers

- MCP TypeScript SDK 1.29 advertises an `outputSchema` only when its root is a
  Zod object. Root discriminated unions disappear from `tools/list`. Authoring
  outputs therefore use a root object with a nested discriminated `outcome`;
  runtime v1/v2 preserve their published root objects. The shared schemas test
  every success/refusal/suppression/error variant, and the official client
  exercises SDK output validation, but the runtime JSON Schema cannot express
  a root `oneOf` without replacing the SDK registration layer or breaking the
  published result shape.
- No Ollama, LM Studio, or other local OpenAI-compatible engine/model was
  installed or running on the test host. The deterministic loopback conformance
  gate is blocking and passed, including authority parity and non-loopback HTTP
  refusal, but this release does not claim that a real local engine was
  certified.
- The external technical deep dive was deliberately not edited because the
  owner required explicit permission first. Later documentation work should
  update its Workbench review, CLI Ask, repeated Explore, optional Protect,
  structured analytical result, analytics catalog, host-neutral client, and
  Runner 1.6.6 clean-room sections without deleting its existing teaching
  material.

## Final Requirement Audit

- The core boundary is unchanged: no SQL, credentials, model-selected scope,
  authoring activation, approval, apply, worker, notification, or production
  Scoped Explore entered the model-facing surface.
- Review once and repeated bounded Explore work through composer, Workbench
  Ask, CLI Ask, authoring MCP, deterministic provider adapters, and the
  authorized live OpenAI smoke. Protect remains optional and operator-only.
- Exact structured output schemas and `synapsor.analytics-catalog.v1` are
  derived from shared builders and digest-pinned. The host-neutral official MCP
  client passes over stdio and secured Streamable HTTP.
- Retail/subscription and healthcare/PHI clean rooms run from the packed 1.6.6
  artifact with real browser interaction. Both execute at least ten legal
  analyses before Protect; healthcare proves independent tenant/principal
  scope, PHI hiding, prompt-injection inertness, and suppression.
- Production profiles advertise only activated named capabilities. Existing
  reads, proposals, verified operator approval/apply, guarded writeback,
  receipts, replay, compensation, workers, and notifications retain their
  established behavior.
- Published compatibility fixtures preserve legacy canonical digests, CLI
  routes, generated projects, TypeScript authoring, and tools. New output
  metadata and analytics features are additive.
- Runner and alias are prepared at 1.6.6. Spec and DSL remain 1.7.0. No commit,
  merge, push, tag, dist-tag, npm publication, or release was performed.

## 2026-07-27 Resumed Goal Revision

The owner revised `/home/sandesh-tiwari/Desktop/C++/goal.txt` after manually
rejecting the prior first-run UX. Work continues on the same
`feat/runner-1.6.6-safe-agent-analytics` branch and unpublished 1.6.6 worktree.
No prior implementation or evidence was reset.

Resumed state:

- HEAD: `18da2531a9ed3936b05f99cd285cca3cda519bac`
- Worktree: the substantial previously recorded 1.6.6 implementation remains
  modified/untracked as expected; no unrelated user change was reverted.
- Newly superseding scope: natural-language interactive `try ask`, quiet
  authoritative result rendering, operator-only bare `/protect`, explicit
  dependency-scoped schema-evolution behavior, the confirmed analytical
  evidence-continuity gap, and the owner-rejected Quick Start/Workbench UX.
- Version constraints: Runner/alias remain 1.6.6; Spec/DSL remain 1.7.0.
- Release constraints: no commit, merge, push, tag, publication, or dist-tag
  movement without separate owner authorization.
- External technical deep dive remains untouched until the owner gives explicit
  permission.

Current-source findings at resume:

1. `try ask` requires a positional question, is one-shot only, and can fall
   back to runtime named/proposal tools when Scoped Explore is absent.
2. Human `try ask` output still prints the authority digest, analysis
   reference, `Source database changed: no`, and operator-state boilerplate
   after every read.
3. Existing `try protect` defaults to the most recent entry without proving
   current-answer uniqueness and lacks the required interactive ambiguity
   picker.
4. Scoped Explore records normalized query audit and Protect state but no
   evidence bundle; generated protected-read execution still records query
   audit without fresh required evidence.
5. Workbench still renders `Review for access`, an unexplained disabled
   `Activate this access`, the manual tenant/principal binding form, readiness
   hashes/checks, and the report-builder-like first Explore form reported by the
   owner.
6. Newer generation locks already contain resource/relationship dependency
   fingerprints. Existing runtime tests prove unrelated protected-authority
   schema drift is tolerated and dependent drift is rejected; the revised goal
   requires explicit Explore/additive-schema coverage and actionable scoped
   recovery UX, not a second drift engine.

Next checkpoint: implement focused shell/result/reference modules and tests over
the existing provider/MCP/Explore/Protect implementations, then close evidence
continuity and Workbench Quick Start defects before rerunning packed/browser
gates.

### 2026-07-27 Shell and Evidence Checkpoint

Implemented without rebuilding the completed provider, MCP, Explore, or Protect
engines:

- `try ask` remains one-shot when a positional question is supplied and now
  opens a bounded conversational shell when it is not.
- The analytics shell forces the exact authoring catalog
  (`app.describe_data`, `app.explore_data`) and refuses runtime fallback.
- Human output renders provider prose as untrusted interpretation and renders
  actual structured rows/groups independently. Routine reads no longer print
  mutation, evidence, digest, handle, or analysis-reference footers.
- The existing encrypted Protect state now allocates stable local `A1`, `A2`,
  ... references and can bind several references to one provider answer without
  storing the question, prose, or result rows.
- `/analyses`, `/details`, bare `/protect`, explicit reference selection,
  single-plan automatic selection, and multi-plan ambiguity selection use the
  canonical Protect compiler. Every generated capability remains disabled.
- Terminal values and provider prose are escaped before rendering; narrow
  terminals use a stacked deterministic result layout.
- Scoped Explore now writes one metadata-only evidence bundle and its linked
  query audit atomically before returning a result or Protect reference.
- Every successful generated protected-read invocation creates fresh evidence
  linked to that invocation's audit. It does not reuse authoring evidence.
- Returned rows/groups, trusted tenant/principal values, SQL, raw arguments,
  provider prose, and kept-out fields are absent from analytical evidence.
- The shared Postgres store inherits the atomic evidence/audit operation through
  its existing advisory-lock transaction and SQLite ledger projection.

Focused verification:

- TypeScript project build: passed.
- Ask shell/one-shot, model provider, Scoped Explore, Protect, protected read,
  analytics output schema, proposal store, and generated-authority tests:
  `104/104` passed.
- The atomic ledger test proves a mismatched linked audit rolls back the
  evidence bundle.

Remaining before Phase 2 is complete: standalone `try protect --last` tests,
provider-stage/Ctrl+C tests, packed interactive provider proof, real OpenAI and
available local-model smoke, help/docs, and full release gates.

### 2026-07-27 Explicit Explore Lifecycle And Drift Checkpoint

The resumed implementation now closes the owner-reported lifecycle and schema
evolution gaps without introducing another query, provider, or authority
engine:

- Completing guided action authoring no longer silently disables Scoped
  Explore. The primary action opens proposal review while preserving the
  activated local authoring boundary. A separate, explicit
  `Disable Explore and review proposal` action is the only path that ends it.
- The packed retail journey now proves the activated boundary remains
  byte-identical through proposal creation, operator approval, guarded apply,
  receipt, replay, and a subsequent analytical question. It then disables
  Explore explicitly and proves production publishes only activated named
  capabilities.
- Every Scoped Explore call re-inspects and revalidates the exact resource and
  reviewed relationship dependencies used by the plan immediately before
  source execution.
- Every generated protected-read call performs the same per-capability current
  dependency check. One stale generated capability no longer blocks an
  unrelated current capability at runtime startup.
- A stale encrypted `A1`/`A2` Protect reference is revalidated against current
  authority before any DSL, JSON, test, or review artifact is created.
- Deleting or changing a reviewed field, or changing a reviewed FK/uniqueness
  proof, fails closed with an actionable stale-authority refusal before a
  source read. Unaffected resources and relationship paths continue working.
- Adding an unrelated table or column leaves current authority usable while the
  new identifier remains absent from the catalog and unavailable for select,
  filter, sort, group, join, aggregate, or Protect until explicit rescan,
  review, and exact-digest activation.
- Kept-out fields remain absent from every currently supported analytical
  operation. The active grammar remains count, count-distinct, sum, and
  average; this release does not add global min/max, percentile, variance, or
  expression authority.

Focused verification:

- Workbench/local-UI lifecycle tests: `34/34` passed.
- Scoped Explore and Protect drift tests: `25/25` passed.
- Generated protected-authority tests: `15/15` passed.
- Interactive shell, one-shot Ask, authoring gateway, and provider tests:
  `38/38` passed after terminal control/bidirectional-text hardening.
- TypeScript project build: passed.
- Packed retail clean room: passed. The preserved result is
  `development/runner-1.6.6-retail-results.json`; the run proved ten legal
  repeated analyses, quiet interactive Ask, single- and multi-plan Protect,
  proposal/approval/apply/receipt/replay, Explore continuity, explicit
  shutdown, and production narrowing.

### 2026-07-27 Packed Workbench Apply Refresh Checkpoint

The final per-call drift and explicit Explore-lifecycle changes were repacked
and rerun through the complete retail clean room.

The first rerun exposed a presentation race rather than a writeback defect:
guarded apply had committed the source row and durable receipt, but the browser
discarded the authoritative apply response, waited for two sequential ledger
reads, and could still display the prior approved detail when the browser proof
timed out. The fix does not increase a timeout or change write semantics:

- proposal GET, approval, and apply now use one complete redacted Data PR detail
  projection;
- approval and apply render their authoritative response immediately while the
  activity list refreshes concurrently;
- a monotonically increasing detail-request revision prevents an older
  asynchronous response from repainting newer proposal state.

Verification:

- focused hash-bound Workbench approval/apply regression: passed;
- TypeScript project build: passed;
- final packed retail clean room: passed in `279354ms`;
- live source transition: `processing:1` to `fulfilled:2`;
- Workbench timeline showed operator authorization, writeback intent, durable
  commit, receipt, and replay;
- active Explore authority stayed byte-identical through proposal, approval,
  apply, receipt, and replay;
- a subsequent model-mediated Explore analysis succeeded before the operator
  explicitly disabled Explore;
- visual captures `10-human-review.png`, `12-guarded-apply.png`, and
  `13b-ask-after-write-lifecycle.png` were inspected at original resolution;
  the review surface is full-width, committed state is current, and the
  analytics surface remains active.

The final packed result is
`development/runner-1.6.6-retail-results.json`.

### 2026-07-27 Healthcare PHI Clean-Room Checkpoint

The packed healthcare journey now passes from a fresh project through
production serving. The reruns repaired test and product resume behavior rather
than relaxing any boundary:

- Quick Start is available only before durable full-review progress exists.
  Choosing full review persists that state, reload resumes it, and the instant
  activation endpoint rejects attempts to bypass the saved review.
- The Workbench again states `Hidden from the agent by default` for PHI rather
  than using an ambiguous shortened label.
- Browser review actions are idempotent in the proof: already-confirmed
  resource and global decisions are not toggled off during resume.
- Packed scripts now exercise the current progressive-disclosure controls for
  opening the reviewed composer, adding a second grouping, creating the final
  fingerprint, and starting Explore without typing tenant or principal values
  into the analytics UI.
- Provider parity is measured before intentional cumulative budget stress.
  Loopback OpenAI-compatible Ask correctly requires no hosted-egress consent.
  The prompt-injection row test runs before differencing-budget exhaustion so
  injection containment and budget enforcement are independent assertions.
- The exact browser analysis selected for Protect remains bound to its rendered
  query reference while later MCP calls advance project history.

Verification:

- Workbench renderer and local UI tests: `35/35` passed.
- TypeScript project build: passed.
- Packed healthcare PHI clean room: passed in `206440ms`.
- All 10 inspected resources began blocked; one Workbench decision and a signed
  CLI review enabled only three resources.
- PHI fields, other-principal rows, and other-tenant rows remained unavailable.
- Ten legal aggregate combinations, one-record reads, suppression, prompt
  injection, Workbench Ask, CLI Ask, and authoring MCP all used the same
  reviewed authority without mutation.
- Protect produced and human-activated one exact DSL capability, then Scoped
  Explore disappeared from production `tools/list`.
- Production stdio and authenticated Streamable HTTP returned the same bounded
  result.
- Result: `development/runner-1.6.6-healthcare-phi-results.json`.
- All nine desktop/mobile screenshots in
  `development/runner-1.6.6-healthcare-phi-visual` were inspected at original
  resolution; no overlap, horizontal overflow, hidden controls, or alignment
  defect was observed.

### 2026-07-27 Community Solar And Live OpenAI Checkpoint

The packed 40-table community-solar lab passes against a real PostgreSQL
fixture and a real `gpt-5-mini` provider call:

- one shell command produced the schema summary and Workbench in `25229ms`;
- full review, exact activation, first scoped row read, and first reviewed
  aggregate completed without manual file edits;
- the no-model composer, official stdio MCP, deterministic loopback Ask, and
  live OpenAI Ask returned authority-equivalent results;
- the live model first attempted one invalid plan, received a bounded refusal,
  then corrected to the reviewed plan without any authority widening;
- the exact API key was absent from generated artifacts, Workbench output,
  process arguments, browser storage/profile, screenshots, evidence, and saved
  conversation state;
- Protect generated highlighted public DSL, canonical JSON, and ten tests;
- guided action authoring produced a proposal without mutation, and separate
  Workbench approval/apply advanced `open:1` to `in_progress:2`;
- production retained only the activated protected read and proposal tools.

Verification:

- packed community-solar clean room: passed in `103844ms`;
- live OpenAI: `app.describe_data` succeeded, one invalid
  `app.explore_data` call was refused, and the corrected call succeeded;
- result: `development/runner-1.6.6-community-solar-results.json`;
- all 16 light/dark lifecycle screenshots in
  `development/runner-1.6.6-community-solar-visual` were inspected at original
  resolution; the fast lane, first-question surface, suppression result,
  human review, and proposal-only Ask state are aligned and non-overlapping;
- visual review found and fixed one misleading named-tool state: after Scoped
  Explore is disabled, Ask now says `Reviewed named tools are active` and uses
  a generic read/proposal prompt instead of claiming the surface is still
  temporary analytics access.

### 2026-07-27 Packed Auto Boundary, Relationship Review, And Protect Checkpoint

The packed PostgreSQL + Next.js + Prisma + host-neutral MCP journey now passes
against the current progressive Workbench and exact-review protocol:

- the fixture tears down stale Compose state before starting a fresh database;
- current activation saves the exact narrowed candidate, confirms its current
  decisions, creates a final review fingerprint, and activates that fingerprint;
- the browser opens the progressive-disclosure composer before building a
  relationship-backed plan;
- dynamic data-area controls no longer replace their own select element while
  dependent fields refresh, preserving normal keyboard focus;
- the first relationship-backed plan is refused before source access and names
  the exact catalog proof, many-to-one cardinality, uniqueness, and max fan-out;
- staging that path now creates a final current preview before activation, so
  the hardened preview requirement and the demand-driven review UX agree;
- the operator reviews, activates, and retries the exact path in three
  interactions;
- the differencing test accounts for the initial comparison query when
  consuming the three-query family budget;
- Workbench selects the intended golden plan by normalized metadata rather than
  exposing or copying a model-facing Protect token.

Verification:

- packed Auto Boundary/Explore gate: passed;
- demand-driven relationship journey: `5103ms`, three interactions;
- first useful bounded answer: `30594ms`;
- first disabled protected draft: `32967ms`;
- first exact-digest protected activation: `33101ms`;
- authoring tools: exactly `app.describe_data` and `app.explore_data`;
- production tools: exactly `analytics.churn_contributors_by_week`;
- suppression, differencing, hard limits, role/read-only posture, production
  Explore removal, and protected-capability survival all passed;
- before/after source snapshots were byte-equivalent: no source mutation.

### 2026-07-28 Completion-Audit Correction

The prior automated completion summary is not sufficient to close the goal's
human adoption gate. The packed browser scripts, inspected screenshots, timing
records, provider calls, and clean-room fixtures prove technical behavior, but
they are not an uncoached owner run or an independent-developer run.

Current audit status:

- the automated, packed, browser, provider, database, compatibility, and
  security evidence remains valid;
- no recorded evidence proves that the owner completed the redesigned Quick
  Start after the final fixes without coaching or hesitation;
- no recorded evidence proves that a technically capable developer unfamiliar
  with Runner internals independently completed and explained the same journey;
- Definition of Done items 14, 19-26, 28-30, and 37, and the explicit human
  release gate, therefore remain open;
- Runner 1.6.6 must not be represented as complete or published on the basis of
  the automated evidence alone.

The separately requested owner-controlled minimum-cohort override is not part
of the 1.6.6 goal. At this checkpoint, its local staging path had reached the
public-contract gate and was paused for explicit owner authorization. The owner
subsequently authorized the additive public behavior, and the later
`Owner-Authorized Minimum-Cohort Follow-Up` checkpoint records its completed
implementation, tests, and remaining immutable-version release collision.

The human protocol in `docs/fresh-developer-usability.md` was corrected after
this audit:

- owner and independent-developer runs are separate required observations;
- an unpublished run uses the exact packed tarball, not npm `latest`;
- the tarball path and SHA-256 are recorded;
- the candidate command
  `npm exec --yes --package <runner-1.6.6.tgz> -- synapsor-runner --version`
  was exercised successfully against a newly packed artifact;
- the eligible first-safe-read target is 60 seconds;
- confusion, coaching, contradictory state, or abandonment are explicit
  failures rather than qualitative notes.

`corepack pnpm test:license-content` and `git diff --check` pass after the
protocol correction. The two actual participant records remain missing.

### 2026-07-28 Owner-Authorized Minimum-Cohort Follow-Up

The owner explicitly authorized the additive public Spec/DSL validation change
needed by the separately requested minimum-cohort override. Package versions
were not changed or published.

Implemented behavior:

- Auto Boundary still generates minimum cohort 5. Without an owner decision,
  review may keep or increase it but retains the existing refusal when asked to
  lower it.
- Workbench and CLI allow an operator to record a resource-specific value from
  1 through 4 only with reviewer identity and a reason. Setting 5 removes the
  override. A value of 1 plainly states that small-group suppression is
  disabled and groups of one may identify individuals.
- The effective value and explicit-override marker flow through review
  evidence, the immutable boundary digest, `describe_data`, the safe analytics
  catalog, Workbench review, and Explore result/audit metadata. Reviewer
  identity and reason remain in operator evidence rather than model authority.
- Quick Start refuses overridden boundaries so this disclosure decision cannot
  pass through the narrow convenience lane.
- Protect requires a separate exact threshold confirmation and actor. Protected
  activation requires another confirmation bound to the exact contract digest,
  resource, and threshold. Generated runtime config binds the contract digest,
  value, and non-secret review digest.
- Activation re-derives the threshold from the canonical contract and
  revalidates both the draft metadata and current owner review. Removing either
  record fails closed.
- MCP/Ask inputs contain no threshold/override field. Attempts to add one are
  refused without advertising the operator mechanism. `suppression_aware_totals`
  remains forced and budgets are unchanged.
- Public Spec, DSL, Runner config validation, and both public Runner JSON Schema
  copies now accept the explicit value 1 and reject 0. Legacy absent fields and
  normalization remain unchanged.

Verification:

- focused Spec, DSL, config, Auto Boundary, Workbench, Scoped Explore, Protect,
  catalog, and output-schema matrix: 11 files / 241 tests passed;
- final root suite before the schema-parity correction: 71 files / 1,020 tests
  passed; license/content, human command surface, DSL source paths, and Cursor
  plugin passed after the one documentation correction;
- public JSON Schema parity now includes the exact generated production
  override map; config suite: 41/41 passed;
- live PostgreSQL and MySQL aggregate verification now proves default
  suppression and an explicit threshold-1 scalar with zero member rows in
  evidence, safe query audit, and no source mutation;
- published compatibility passed against Runner 1.5.4, 1.6.0, 1.6.3, and 1.6.5;
- packed backward compatibility passed against all four exact published package
  graphs;
- Runner and alias clean-install pack verifiers passed at 1.6.6;
- the complete release smoke passed before the version-collision guard was
  added: 443 core tests, real Claude Code/Codex config checks, first-run Docker
  proof, public/local/packed Runner, packed own-database apply/replay, content,
  dry-run publish, and cleanup.

The audit found that npm already contains immutable `@synapsor/spec@1.7.0` and
`@synapsor/dsl@1.7.0` artifacts with the older minimum of 2. A new release guard
now compares actual packed contents instead of checking only the version
number. It reports both current source manifests as collisions and blocks
release. Development packing detects the content difference and installs the
local authorized Spec, so the candidate can still be tested honestly.

Remaining release prerequisites:

- select and prepare new public Spec/DSL versions, update dependency ranges and
  release text, publish those packages before Runner, then rerun every package
  and release gate;
- rerun the final complete root suite after all public-version preparation;
- perform and record the uncoached owner and independent-developer human
  adoption runs. Automated browser evidence does not satisfy those gates.

### 2026-07-28 Exact Source Candidate And Final Automated Root Gate

The final root suite after the public JSON Schema correction and
owner-controlled cohort work passed:

- test files: 71/71;
- tests: 1,020/1,020;
- trusted-core dependency check: 159 modules / 791 edges;
- license/content, human command surface, DSL source-path, and Cursor plugin
  checks: passed.

An exact unpublished source candidate was packed under:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-source-candidate
```

Candidate hashes:

```text
@synapsor/spec@1.7.0
76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71

@synapsor/dsl@1.7.0
4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e

@synapsor/runner@1.6.6
9132a22c93d73c936315940ba69d7f959c07a06384af4d96a23218a85a0d81c8

synapsor-runner@1.6.6 alias
e8643f2a579e1b42aa91aa5a9dcb59783b7e0857b0167d7a456e6f44f4103a64
```

`SHA256SUMS` in that directory records the exact files. Scoped Runner and the
unscoped alias use the same tarball basename, so they are deliberately stored
in separate `runner/` and `alias/` directories.

Clean-temp verification proved:

- local Spec plus local Runner launches `synapsor-runner --version` as 1.6.6;
- local DSL compiles `MIN GROUP SIZE 1`;
- local Spec validates the resulting canonical contract;
- the compiled contract contains `minimum_group_size: 1`;
- `MIN GROUP SIZE 0` is refused.
- the repacked Runner verifier passes while deliberately selecting the local
  Spec candidate;
- the unscoped alias verifier passes at 1.6.6;
- `sha256sum --check SHA256SUMS` validates all four packed artifacts.

The fresh-developer protocol now requires the exact Spec, DSL, and Runner
candidate hashes. Its startup command installs local Spec and Runner together
so a participant cannot silently receive the older immutable npm Spec with the
same 1.7.0 version.

The candidate is suitable for the two required human observations, but it is
not publishable as-is. The public-version collision guard remains an expected
release failure until new Spec/DSL versions are authorized and prepared. Its
current failure names only the expected changed files in Spec and DSL.

### 2026-07-28 Owner Human-Gate Environment

The exact-candidate owner observation is prepared but not yet performed:

- empty project:
  `/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-owner-test-1.6.6`;
- local synthetic fixture:
  `examples/fitflow-guided-onboarding`;
- PostgreSQL container:
  `fitflow-guided-onboarding-postgres-1`, healthy on loopback port 55463;
- first-use role:
  `fitflow_analytics_reader`;
- verified role posture:
  login-only, non-owner, non-superuser, non-`BYPASSRLS`, schema usage and
  SELECT allowed, INSERT/UPDATE/DELETE denied;
- `check_ins`, `locations`, and `members` use forced RLS with trusted
  organization predicates.

No Runner command has been executed in the owner project and it contains no
files. This preserves the clean first-run and timing gate. The database and
credentials are synthetic and local; no AWS or production database is used.

Both actual participant records remain pending. Do not convert this prepared
environment into a passing owner observation until the owner personally
completes the protocol without implementation coaching.

The exact candidate, participant prompt, measurements, and separate pending
records are initialized in
`development/runner-1.6.6-human-usability-observations.md`. That file must
record failures verbatim and may not be completed from automated evidence.

The current 50-item evidence map is recorded in
`development/runner-1.6.6-definition-of-done-audit.md`. It marks DoD 14,
19-26, 28-30, and 37 as human-dependent and DoD 18 as pending public-version
and final release preparation; all other items identify their direct current
source, test, packed, database, provider, or browser evidence.

### 2026-07-28 Owner Quick-Start Disabled Finding

The first owner observation against Runner candidate SHA-256
`9132a22c93d73c936315940ba69d7f959c07a06384af4d96a23218a85a0d81c8`
failed before first value. The large Quick Start action was disabled in
`/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test`.

Read-only inspection proved that `DATABASE_URL` and `SYNAPSOR_TENANT_ID` were
set while `SYNAPSOR_PRINCIPAL` was absent. Quick Start selected
`public.classes` with principal key `trainer_id`, even though the same reviewed
draft contained tenant-only `public.check_ins`. The selection score gave any
principal-scoped resource a 40-point bonus, then the UI disabled activation
when that extra binding was missing.

Repair:

- Instant-development selection now prefers the highest-ranked tenant-only
  resource whenever one exists. It never removes principal scope from a
  resource; all-principal schemas still fail closed until externally trusted
  principal setup exists.
- The exact project draft now selects `public.check_ins`, retains
  `organization_id` tenant scope, and requires no principal.
- If no executable starter exists, a disabled control now says
  `Trusted scope setup required` and presents the missing operator environment
  names in a prominent warning rather than looking silently broken.

Verification:

- Workbench candidate and local UI: 39/39 tests passed;
- the instant runtime test now passes with `SYNAPSOR_PRINCIPAL` genuinely
  absent;
- TypeScript build passed;
- 40-resource desktop/mobile browser gate passed with principal absent;
- direct inspection of `workbench-instant-ready-desktop.png` confirms the
  primary action is enabled, aligned, and visibly says principal is not
  required for the selected first value.

The failed owner run remains a failure. Create a new exact candidate and repeat
the owner observation; automation cannot replace it.

### 2026-07-28 Quick-Start Replacement Candidate

The principal-absent Quick Start repair passed the final automated root gate:

- test files: 71/71;
- tests: 1,021/1,021;
- trusted-core dependency check: 159 modules / 791 edges;
- license/content, human command surface, DSL source-path, and Cursor plugin
  checks: passed;
- `git diff --check`: passed;
- 40-resource desktop/mobile Workbench browser gate with
  `SYNAPSOR_PRINCIPAL` absent: passed.

The replacement unpublished candidate is:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-quick-start-fix-candidate
```

Candidate hashes:

```text
@synapsor/spec@1.7.0
76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71

@synapsor/dsl@1.7.0
4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e

@synapsor/runner@1.6.6
a766ad71adabd27de6555f68f5100d6f05282779c48167ac65c4cf1699d9e2fc

synapsor-runner@1.6.6 alias
e8643f2a579e1b42aa91aa5a9dcb59783b7e0857b0167d7a456e6f44f4103a64
```

`sha256sum -c SHA256SUMS` passed. A clean temporary installation proved:

- local Spec and the replacement Runner install and report Runner 1.6.6;
- packed Runner verification passes with the local corrected Spec;
- packed alias verification passes;
- local packed DSL compiles `MIN GROUP SIZE 1`;
- local packed Spec validates the emitted canonical contract;
- the canonical result contains `minimum_group_size: 1`.

The public-version collision guard still fails only because the changed local
Spec and DSL use immutable npm version 1.7.0. New public Spec/DSL versions
remain an owner-authorized release prerequisite. No version, publication, tag,
dist-tag, merge, or push occurred.

The prior owner observation remains failed and attached to the old Runner hash.
The owner and independent developer must each run the human protocol against
the current candidate hash before the human release gates can pass.

### 2026-07-28 Model-First Start Repair And Current Candidate

Owner testing established that a deterministic safe read is useful as a quick
proof, but a form-first analytical composer does not create the intended first
value. The post-activation Workbench hierarchy now is:

1. configure OpenAI, Anthropic, or a loopback OpenAI-compatible model and ask in
   plain language;
2. connect an existing model-enabled MCP client to the same reviewed authoring
   tools;
3. optionally open the no-model exact-plan composer.

All three paths retain the same activated boundary. Workbench Ask and external
authoring clients expose exactly `app.describe_data` and `app.explore_data`;
none receives Protect, activation, approval, apply, worker, notification,
configuration, shell, file, or credential authority. Workbench can detect the
presence of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and select its environment
variable name, but the value never reaches the browser.

The model-first implementation passed:

- focused Workbench/API tests: 35/35;
- full root tests: 71/71 files and 1,021/1,021 tests;
- trusted-core dependency check: 159 modules and 791 internal edges;
- desktop/mobile Auto Boundary visual gate: 19 screenshots over a 40-resource
  fixture, including model-first and existing-client states;
- deterministic Workbench Ask browser gate: five provider requests, two
  reviewed tool calls, no persisted provider key, no browser storage, and no
  source mutation;
- packed FitFlow onboarding: schema summary 3.629s, first safe read 7.790s,
  aggregate 12.280s, protected draft 14.355s, first proposal 28.233s, no manual
  file edits;
- packed Runner and alias verification;
- README/content, human-command, DSL-source, Cursor-plugin, and
  `git diff --check` gates.

The packed onboarding verifier previously assumed loopback port 55463 and
collided with the owner's active test database. The fixture now preserves 55463
as its default but lets the verifier choose an available loopback port. The
owner's `project-postgres-1` container was not stopped or changed.

README positioning was tightened without behavior changes: `start` is first;
the proof and audit paths are clearly separate; generated DSL/JSON require no
manual authoring; existing safe application services are a supported app-owned
executor path; policy approval and separately opted-in worker execution are
presented beside writes; and an honest "You May Not Need Runner" section
defines the adoption boundary. Root and npm README files remain identical and
the content gate passes.

The current unpublished candidate is:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-model-first-messaging-candidate
```

Candidate hashes:

```text
@synapsor/spec@1.7.0
76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71

@synapsor/dsl@1.7.0
4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e

@synapsor/runner@1.6.6
91e5b40586634479d78069991db4ff9da23eeb59eaf41bd12b77a2698459c6ca

synapsor-runner@1.6.6 alias
e8643f2a579e1b42aa91aa5a9dcb59783b7e0857b0167d7a456e6f44f4103a64
```

`sha256sum -c SHA256SUMS` passed. A clean install resolved the exact local
Spec, DSL, Runner, and alias versions; installed Runner reported 1.6.6 and
`try --prove --json --yes` passed with duplicate mutations 0 and stale apply
refused.

The public-version collision guard remains pending because changed local Spec
and DSL behavior cannot reuse immutable npm 1.7.0. No version, publication,
tag, dist-tag, merge, or push occurred. The failed owner observation remains a
failure; both human gates must run against the current hash.

### 2026-07-28 Activated-Authority Advertising Failure

The owner tested Workbench Ask from a fresh project against Runner artifact
SHA-256
`91e5b40586634479d78069991db4ff9da23eeb59eaf41bd12b77a2698459c6ca`.
The exact active Quick Start boundary contained only `public.check_ins`, the
`outcome` grouping, count-distinct `id`, time buckets on `checked_in_at`, and no
relationships. Workbench nevertheless advertised a canned region question.

Both `How many members do we have?` and the advertised region question caused
bounded tool refusals, followed by the cryptic terminal state
`The provider returned no final answer.` The provider was not the root failure:
the advertised question was outside the active authority, and the Ask loop
discarded its actionable refusal context when no final model prose arrived.

The model-first candidate is superseded. In-progress repairs must:

- derive Ask starters and placeholders only from the exact activated boundary;
- validate the structured plan behind every advertised question against that
  boundary before showing it;
- exclude review-required relationships from immediately executable starters;
- preserve attempted plans and refusal codes;
- return a deterministic Runner-authored explanation of current boundary
  coverage when all data attempts are refused and the provider returns no final
  answer;
- add a browser and packed-artifact gate for the exact
  advertised-question-to-active-authority seam.

No current candidate exists until these repairs pass. The failed owner
observation remains failed and must be repeated against the next exact hashes.

The owner also reported that the initial Quick Start viewport was not a
convincing security decision: the green action was enabled, but the owner
clicked it without understanding the complete boundary being activated. The
existing facts were present but the hierarchy was wrong. The repair must name
the exact selected table/resource, state that all other inspected resources
remain blocked, preview the executable first question, and provide a
development-appropriate `Review or change access` route for table/column
selection. It must keep the narrow one-gesture path for speed rather than
turning the first viewport into a mandatory permissions matrix.

The owner reconfirmed that the default must be genuinely model-first. Quick
Start currently renders a no-model result before offering Ask, so the previous
post-activation hierarchy was incomplete. The primary journey must activate the
reviewed boundary and open Workbench Ask or an existing model-enabled MCP
client. The no-model composer/read stays available as an explicit alternative,
with no difference in authority.

Owner testing of a valid generated weekly check-in question showed safe model
recovery but poor presentation. Runner refused two invalid provider plans,
accepted the third, enforced cohort suppression, and returned the correct
verified result. Workbench then flattened the catalog lookup, recovered
refusals, verbose model duplication, and final result together. The UI must
collapse metadata/recovered attempts when a valid plan succeeds, keep them
prominent only when no plan succeeds, and request concise provider prose that
does not reproduce the structured result.

### 2026-07-28 Guided-Profile And Modern First-Run Repair

The owner clarified that selecting the database URL for the fresh local
`start --from-env DATABASE_URL` journey is the environment-selection action.
Asking the developer to sign, select, or repeat "development", "staging", or
"not production" in Workbench adds ceremony without creating trusted evidence.

The guided path now establishes `development` from trusted local launch context
and records `launch_context: start_from_env_local_authoring` in activation
evidence. Quick Start no longer accepts a profile assertion. Requests that try
to set `profile`, `deployment_profile`, or `profile_assertion` are rejected.
Workbench shows the launch-established profile as read-only status. Explicit
manual, production, unknown, remote, and shared routes keep their existing
configuration and fail-closed behavior. Database-role posture, secured
loopback, exact digest, generation lock, trusted scope, and read-only
transactions remain mandatory.

The first-run and access-review information architecture was also replaced
using the owner-supplied modern design direction:

- Quick Start names the single selected resource, visible and kept-out fields,
  trusted scope, hard limits, and one validated first question.
- Activation opens model-first Ask; existing MCP clients and the no-model
  composer are equivalent secondary paths.
- Ask keeps model prose separate from the deterministic Runner result, collapses
  recovered intermediate refusals after success, and explains an all-refused
  turn from the exact active boundary.
- The access editor is a searchable resource list with one focused resource at
  a time. It has no drag-and-drop, permissions matrix, global approve-all, or
  hidden profile selector.
- The final access-review action follows the focused editor on narrow screens
  rather than preceding the resource list.

Verification at this checkpoint:

- `corepack pnpm typecheck` passed.
- `corepack pnpm build` passed.
- focused Workbench, Ask, analytics shell, authoring gateway, Explore, and
  review tests passed: 8 files and 100 tests.
- the Workbench visual gate passed 19 desktop/mobile screenshots across a
  40-resource fixture, including the focused mobile access editor.
- the deterministic Workbench Ask browser gate passed with seven provider
  requests, two reviewed calls, one safely refused call, no source mutation,
  no persisted provider key, and no browser-storage entries.

No replacement release candidate is named yet. Full root, packed-artifact, and
clean-room journeys must still pass, and the owner and independent developer
must repeat their human observations against the exact resulting hashes.

Owner clarification: the files under
`/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/Chatgpt designs` are
visual references only. They may guide styling, layout, hierarchy, and
responsive presentation, but they do not authorize workflow, onboarding,
first-run, authority, persistence, command, or functional changes. The
model-first flow and one-time local authoring profile are retained because they
were separately and explicitly requested, not because they appeared in a
design reference.

### 2026-07-28 Packed Verification After The First-Run Repair

The current source passed:

- typecheck and build;
- the full root gate: 71 files and 1,025 tests;
- license/content, human-command, DSL-source-path, Cursor-plugin, and
  `git diff --check` checks;
- focused Workbench/Ask/shell/Explore/review tests: 8 files and 100 tests;
- Workbench visual and deterministic Ask browser gates;
- public command, local Runner, first-run proof, packed Runner, packed alias,
  packed own-database, host-neutral client, and MCP client-recipe gates;
- packed backward compatibility against the published 1.5.4, 1.6.0, 1.6.3,
  and 1.6.5 baselines;
- packed generic Auto Boundary/Explore/Protect/production verification.

All three packed clean-room domains passed against Runner tarball SHA-256
`976e041968d996019e61c40e56748ada284753984f6ac544d2c07ad156c4b8c4`:

- Retail: first safe read in 30.295 seconds and first aggregate in 31.061
  seconds from the clean-room clock; ten repeated legal plans, Workbench Ask,
  interactive shell follow-ups, `/analyses`, single/multi-plan Protect,
  guarded write lifecycle, and post-write Explore survival passed.
- Community Solar: first safe read in 25.112 seconds and first aggregate in
  25.664 seconds; hidden notes, Ask/MCP parity, Protect, proposal-only model
  behavior, approval, apply, and replay passed.
- Healthcare: first PHI-safe read in 27.474 seconds and first aggregate in
  28.145 seconds; all-blocked recovery, signed CLI review, stored-prompt
  injection inertness, small-cohort suppression, repeated Explore,
  refresh/second-tab/history recovery, Ask/MCP parity, Protect, and production
  absence of Scoped Explore passed.

During packed verification, stale automation assumptions were corrected to
follow the new presentation without changing product authority: the scripts
now use the focused final-review action, explicitly choose the retained
no-model path where that path is under test, and expect current labels. A real
fallback defect was also fixed: if Workbench Ask cannot initialize on an
otherwise valid authoring route, the no-model composer now becomes available
instead of being hidden by model-first styling. Programmatic task transitions
use non-animated scrolling so browser clicks do not target moving controls.

The public-version collision gate remains intentionally blocking:

```text
@synapsor/spec@1.7.0 differs from the immutable npm artifact
@synapsor/dsl@1.7.0 differs from the immutable npm artifact
```

New public Spec/DSL versions must be explicitly selected before release. No
version, publication, tag, dist-tag, merge, or push occurred. The owner and
independent-developer human observations remain pending against a final exact
candidate.

### 2026-07-28 Visual-Only Overview Edge Motion

The new ChatGPT HTML reference was used only to restore its visual connector
treatment in the existing three-node Quick Start overview graph. Both boundary
edges now render a muted base line with a moving mint dashed overlay. No graph
nodes, onboarding steps, authority, setup behavior, persistence, or commands
changed.

The motion respects `prefers-reduced-motion`. The Workbench renderer regression
test passed, and the full 19-screenshot browser gate passed with an additional
computed-style check proving the connector position changes over time and that
reduced-motion disables the animation.

The owner then exposed a packaging-only mismatch: `corepack pnpm build` had
updated the modular `dist/boundary-workbench.js` used by browser verification,
while the disposable test installation still served an older generated
`dist/runner.mjs`. The visual gate now runs `build:runner-package` and refuses a
packed bundle that lacks the verified edge animation or reduced-motion rule.
A fresh local `@synapsor/runner@1.6.6` tarball was installed into
`Synapsor-runner-test/install`; no package version or published artifact changed.

### 2026-07-28 Workbench Visual Specification Repair

The latest files under `/home/sandesh-tiwari/Desktop/C++/Chatgpt designs` are
now treated as the Workbench visual specification, not as an edge-animation
reference. Existing authority, onboarding, persistence, commands, and runtime
behavior remain unchanged.

The rendered Workbench now uses the supplied visual hierarchy across:

- first-run boundary review on desktop and mobile;
- the model-first provider choice;
- the configured Ask surface;
- the first successful verified result and follow-up composer;
- resumed boundary review, which no longer falls back to the legacy sidebar
  dashboard composition;
- the detailed access editor and responsive states.

The Quick Start diagram is a real inline boundary graph with animated reviewed
paths and a reduced-motion fallback. The completed Ask state removes setup
ceremony from above the answer, distinguishes model interpretation from the
deterministically rendered Runner result, and preserves every existing
advanced detail and Protect action.

Verification after the visual repair:

- packed-bundle Workbench visual gate: 19 screenshots and all responsive,
  overflow, keyboard, blocked, stale, failure, attention, motion, and
  reduced-motion assertions passed;
- deterministic Workbench Ask browser gate: first-result desktop, accumulated
  conversation desktop, and two mobile captures passed; provider/tool/refusal,
  secret-persistence, and browser-storage assertions remained green;
- focused Workbench renderer and local UI: 36/36 tests passed.

The disposable test installation was refreshed from the post-repair tarball:

```text
/tmp/synapsor-current-ui-BRbNkY/synapsor-runner-1.6.6.tgz
sha256:b3191c2d5e706095f99d1d2199d0e72826642752665e96e5086f4e2f7c339fed
```

The installed generated `dist/runner.mjs` was checked directly for the modern
overview, SVG motion, and result-focused Ask selectors. The full root gate also
passed again: 71 files and 1,025 tests. No publication, version change, tag,
merge, push, or dist-tag movement occurred.

### 2026-07-28 Model-First Ask Interaction Repair

The Workbench interaction now follows the product journey rather than a
five-step setup wizard:

- an existing project with active local Explore authority reopens directly in
  Ask;
- Ask is the first Workbench destination, with review, activation, Protect, and
  safe-action authoring available as operator destinations;
- the active boundary has a compact `What can I ask?` disclosure showing only
  reviewed data areas, measures, groupings, dates, filters, and validated
  examples;
- that disclosure offers `Review or expand access`, which opens the existing
  human boundary editor and does not change authority inline;
- a model request has an explicit `Asking...` state, `aria-busy`, progress copy,
  and a live Cancel action;
- model interpretation and the independently rendered Runner result are paired
  side by side on desktop and stack on mobile;
- verified result rows/groups are collapsed behind `View verified data` by
  default, while suppression and refusal facts remain visible;
- the next-question composer remains available as a sticky chat control.

The browser gate found and fixed two presentation defects while exercising the
real generated boundary: array-backed filter fields had rendered as numeric
indices, and the desktop answer-grid selector overrode the intended mobile
stacking rule. Both are now covered by browser assertions.

Verification after this interaction repair:

- deterministic Workbench Ask browser gate passed with active-project direct
  landing, boundary-editor navigation, boundary/kept-out-field checks, visible
  cancellable loading, collapsed/expanded verified data, desktop side-by-side
  and mobile stacked layouts, refusal recovery, authority drift, and
  secret/storage checks;
- the full 19-screenshot Workbench visual gate passed across desktop, mobile,
  first-run, resumed review, loading, blocked, stale, failure, attention, and
  40-table states;
- focused renderer and local UI tests passed (1 + 35);
- the full root gate passed: 71 files and 1,025 tests, followed by trusted-core,
  license/content, human-command, DSL-source-path, and Cursor-plugin checks;
- `git diff --check` passed.

The disposable test installation now uses:

```text
/tmp/synapsor-current-ui-E03szL/synapsor-runner-1.6.6.tgz
sha256:8c64e4b1ba419289b4470a7bb200b14635082cbc01e37bf9074036196cf1f2cd
```

The installed bundle was checked directly for `Review or expand access` and
the new verified-data disclosure. The previous Workbench process was stopped
before replacement. `npm audit --omit=dev` reports one transitive moderate
Windows path-traversal advisory through
`@modelcontextprotocol/sdk -> @hono/node-server`; npm reports no available fix,
and this local Workbench flow does not use that Hono static-file path.

No technical deep-dive edit, version change, publication, tag, merge, push, or
dist-tag movement occurred.

### 2026-07-28 Column-First Access Editor Side Task

The Workbench access editor now makes its heading literal: selecting a table
immediately shows one flat column list, and an ordinary visibility checkbox is
the next click. Each row contains the checkbox, column name, database type, and
an inline reason badge. Kept-out columns remain in that same list and continue
to use the existing recorded sensitive-field review path when a human attempts
to widen access.

Record/customer scope, reviewed relationships, aggregate privacy, and advanced
field operations remain available below the list but are closed by default.
No validation, narrowing rule, digest, activation, kept-out override, or API
behavior changed.

Visibility changes are compared with the candidate loaded into the Workbench.
A sticky staged bar reports exact added/removed column counts and only navigates
to the existing fingerprint and activation view. It cannot activate authority.
Successful activation, rescan, and start-over reset the local comparison
baseline as appropriate.

Ask refusals now derive a safe resource/field hint from the refused structured
plan and error details. `Review or expand access` opens the access editor with a
known table selected and a known field highlighted; an unknown resource only
narrows the editor search. The model still cannot edit or activate the boundary.

Verification:

- renderer regression test passed;
- focused Workbench/local UI tests passed: 36/36;
- Workbench Ask browser gate passed, including a refused
  `public.accounts.payment_token` plan deep-linking to the exact kept-out field;
- Workbench visual gate passed with 20 screenshots and a direct assertion of
  table click, immediately visible column toggle, closed secondary sections,
  second-click staged count, and inline kept-out reason;
- packed Runner verification passed;
- full root gate passed: 71 files and 1,025 tests, followed by trusted-core,
  license/content, human-command, DSL-source-path, and Cursor-plugin checks;
- `git diff --check` and TypeScript build passed.

The disposable install was refreshed without touching its database or generated
project state:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:428156379460c50f696fbb846652578e2c13c18c8e85434b067f9d1f03fb0be1
```

The existing Workbench process was intentionally left running and therefore
still has its prior bundle in memory. Its next restart will load the refreshed
install. No technical deep-dive edit, version change, publication, tag, merge,
push, or dist-tag movement occurred.

### 2026-07-28 Provider Authentication Recovery

Owner testing found that an OpenAI HTTP 401 appeared as:

```text
Request refused safely
The provider returned HTTP 401.
```

That presentation incorrectly made a provider credential failure look like a
Synapsor boundary refusal. The known reference OpenAI key was accepted by the
provider, while the running Workbench process had no `OPENAI_API_KEY` in its
environment. The failing session therefore used a different or malformed
session-pasted credential; no credential value was printed or persisted.

Provider HTTP failures are now classified without retaining provider response
bodies:

- 401: `ASK_PROVIDER_AUTHENTICATION_FAILED`;
- 403: `ASK_PROVIDER_PERMISSION_DENIED`;
- 429: `ASK_PROVIDER_RATE_LIMITED`;
- all other non-success statuses retain the redacted generic provider error.

Workbench now presents provider authentication as **OpenAI could not
authenticate**, explains that the configured key was rejected, and offers one
**Change provider or key** action that reopens credential setup. It no longer
labels cancellation, authority drift, or provider failures as a boundary
refusal. A session-pasted `.env` assignment or quoted value is rejected before
any provider request with instructions to paste only the key value.

Verification:

- focused Ask transport, Workbench API, and renderer tests passed: 58/58;
- TypeScript build passed;
- the deterministic browser gate passed the complete desktop/mobile Ask flow,
  including one provider-authentication failure and recovery, normal analyzed
  results, cancellation, a kept-out-field refusal and access-editor deep link,
  and authority drift;
- browser proof retained zero provider keys and zero browser-storage entries;
- `git diff --check` passed for the touched files.

An accidental package-scoped test invocation also ran the full Runner package
suite from `apps/runner`, where tests that intentionally expect repository-root
`process.cwd()` resolved fixtures incorrectly and unrelated five-second tests
starved under parallel load. The same three relevant files passed
deterministically from repository root; this invalid invocation is not counted
as a release gate.

The disposable test installation was refreshed without changing its database
or generated project artifacts:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:fb278da20d33c5bf699ac213ce05330e163ef8110843d8e1e3ebca2c57b4f83d
```

The already-running Workbench process still has the previous bundle in memory
and must be restarted before owner retesting. No technical deep-dive edit,
version change, publication, tag, merge, push, or dist-tag movement occurred.

### 2026-07-28 Stable Table Navigation, Terminology, And Packed CLI Follow-Up

The column-first Workbench left navigation no longer moves a selected table to
the top. It remains sorted by unresolved risk count and then table identifier.
Selection is shown in place with an accent left border and background; the
selected row scrolls only when it is outside the visible navigation viewport.
The browser verifier now records the full navigation order, clicks the third
table, and fails if any position changes.

Workbench, terminal output, runtime recovery messages, and tests now use
`table` by default. Where an inspected resource is actually a view, Workbench
uses `tables and views` or `table or view`. The retired generic term is absent
from executable UI/CLI source and documentation outside historical development
records.

Owner testing also showed that bare `synapsor-runner try` was easy to mistake
for the connected-database analytics shell. Its behavior remains backward
compatible: bare `try` is still the isolated synthetic commit-safety proof and
may open its separate demo review screen. It now says that explicitly before
running and points to:

```text
synapsor-runner try ask --provider openai --model <model>
```

as the active-project terminal analytics shell. JSON automation remains one
JSON document with no banner.

Verification:

- focused renderer, local Workbench, analytics-shell, and candidate tests:
  54/54;
- full root gate before the final CLI-only clarity copy: 71 files and
  1,027/1,027 tests, followed by trusted-core, license/content,
  human-command-surface, DSL-source-path, and Cursor-plugin checks;
- every CLI-focused test after the clarity copy: 10 files and 204/204 tests,
  including all 143 main Runner CLI cases, boundary/headless review,
  notifications, lifecycle, cloud CLI, Explore, `try ask`, and the interactive
  analytics shell;
- Auto Boundary browser gate: passed with 20 desktop/mobile captures and the
  stable-third-table-order assertion;
- Workbench Ask browser gate: passed with provider authentication recovery,
  cancellable loading, boundary refusal, mobile layout, no persisted key,
  seven provider requests, two reviewed calls, one refused call, and no source
  mutation;
- packed Runner verifier: passed after the final CLI copy;
- packed backward compatibility: exact published baselines 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 passed;
- packed Auto Boundary/Explore: passed against live PostgreSQL, including
  model-first routing, two authoring tools, suppression, relationship review,
  Protect, production isolation, and no source mutation;
- packed FitFlow guided onboarding: passed from one command with zero manual
  file edits; schema summary 3.629s, first safe read 6.864s, PM aggregate
  10.621s, protected capability 12.617s, and first proposal 25.671s
  (package download and database startup excluded);
- direct disposable-install JSON proof: parsed successfully and applied the
  isolated synthetic receipt without opening a browser;
- `git diff --check` and the executable terminology sweep passed.

The disposable unpublished install now contains:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:d12ea6fe29331b2aa2569a342da093099ba472f9a7add1eeb49f967fb2221c17
```

No technical deep-dive edit, version change, npm publication, release, tag,
merge, push, or dist-tag movement occurred.

## 2026-07-29: Default-Yes Interactive Provider Egress Review

Owner testing found that the CLI analytics shell required typing an
`ALLOW EGRESS sha256:...` fingerprint after the developer had already selected
a hosted provider and supplied its credential. The authority-bound fingerprint
remains the internal and noninteractive consent identity, but the interactive
TTY now presents the provider, model, endpoint, and disclosure once and asks:

```text
Continue? [Y/n]
```

Enter, `y`, or `yes` accepts. `n` or `no` cancels before any provider request.
Invalid input is prompted again. Loopback OpenAI-compatible models continue to
skip remote-egress review, while JSON and other noninteractive automation still
require the exact `--consent` value and cannot silently default to Yes.

Verification:

- focused `try-ask.test.ts`: 7/7;
- root TypeScript project build/typecheck: passed;
- Runner package build and pack: passed;
- installed artifact contains the new prompt and updated CLI help;
- `git diff --check`: passed.

An accidentally broad package-test invocation ran under excessive parallel
load and hit unrelated five-second timeout/cwd-leak failures. The changed test
itself was rerun directly with one worker and passed. The refreshed unpublished
test artifact is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:113ae4088554d2eb03d9bc27bb03c85eea84e788b36a82de710c8799cfa92bd8
```

## 2026-07-29: In-Place Analytics Shell Progress

Owner CLI testing showed that each provider/tool phase was being appended as a
permanent transcript line. Interactive TTY sessions now render one dim animated
status line, replace it in place as the phase changes, and erase it before the
answer or error. Redirected and other non-TTY output contains no progress
chatter. Cancellation also clears the transient status before printing its
durable message.

Verification:

- `analytics-shell.test.ts` and `try-ask.test.ts`: 21/21;
- explicit TTY control-sequence test proves provider status replacement, tool
  status replacement, and complete erasure before normal output;
- root TypeScript build/typecheck: passed;
- Runner package build and pack: passed;
- `git diff --check`: passed.

The refreshed unpublished test artifact is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:79ab7373d76119cff5d42101e5fbc884c7c550722480387bef6b7b5de1d973cd
```

## 2026-07-29: Unmistakable Runner Output And Collapsed Attempts

Owner CLI testing showed that model prose, successful Runner data, catalog
inspection, and refused intermediate plans had nearly equal visual weight.
Interactive TTY output now presents dim `MODEL INTERPRETATION`, a visible rule,
and green/bold `RUNNER-VERIFIED DATA` with an explicit statement that structured
values come from Runner and cannot be replaced by model prose.

The primary answer omits metadata-only catalog calls and renders successful
structured data first. Refused attempts that preceded a valid plan collapse to
one quiet summary line. `/attempts` reveals safe refusal details for the latest
answer, while `try ask --verbose` retains them inline for expert and one-shot
use. If every plan is refused, the latest actionable Runner refusal remains
visible rather than being hidden.

Verification:

- `analytics-shell.test.ts` and `try-ask.test.ts`: 24/24;
- tests prove authorship styling, success-first ordering, hidden catalog
  chatter, collapsed refusals, and explicit `/attempts` expansion;
- root TypeScript build/typecheck: passed;
- Runner package build and pack: passed;
- installed help advertises `/attempts` and `--verbose`;
- `git diff --check`: passed.

The refreshed unpublished test artifact is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:7766e2e532fde73f84278caeed5ac0aac439f0e0eb2b26ce9af9a7245f464d2a
```

## 2026-07-29: Model-Withheld Fields And Shell Access Recovery

Implemented a third reviewed field-egress tier:

- **Visible to model:** reviewed values may enter provider context.
- **Withheld from model:** the field remains legal for its reviewed operations,
  but each distinct returned value is replaced with a random response-local
  opaque token before any provider request.
- **Kept out:** the field is unavailable to every plan operation.

Workbench presents all three states in one column list. Every transition opens
a reviewer-and-reason decision; it never activates authority from the editor.
Tightening remains a normal review, while exposure loosening emits the existing
sensitive-override attention event. Blocked-resource columns now render their
real kept-out state instead of a disabled control that misleadingly displayed
`Visible to model`.

Scoped Explore executes once and derives two views. The model-facing view is
tokenized; the local verified view retains the full bounded result. Workbench
and CLI warn only when a result actually contains withheld values. Suppression,
scope, rate, extraction, differencing, response, and complexity controls apply
before both views.

For MCP, both `content` and `structuredContent` are tokenized because standard
hosts may put either into model context. The full local result is carried only
in `_meta["synapsor.local_full_result"]`, which the in-process Workbench
gateway consumes without forwarding it to the provider. This is intentionally
stricter than placing full values in `structuredContent`.

Protect emits public `MODEL WITHHELD` DSL and canonical
`model_withheld_fields`. Named and protected reads tokenize affected outputs,
advertise `no_model_egress: true`, and retain full values only in local
non-model metadata. Legacy contracts omit the optional field and preserve their
canonical representation and digest.

The analytics shell now:

- includes `/access` in `/help` and opens the secured Workbench boundary editor;
- keeps review, activation, approval, and apply outside the model surface;
- no longer flags a legitimate derived value such as `0 = 11 - 11` merely
  because that literal is not an underlying result cell;
- keeps model prose and Runner-rendered structured facts visually distinct.

Verification:

- focused security/config/Spec/DSL/runtime set: 265/265;
- final focused set after copy review: 232/232;
- complete root gate: 71 files, 1,045/1,045 tests, plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Auto Boundary Workbench browser gate: passed on desktop/mobile, including
  stable table order and the three-tier recorded-review control;
- Workbench Ask browser gate: passed with seven provider requests, an
  authentication recovery, cancellation, a refusal, no persisted key, and a
  locally visible withheld-result table;
- recording-provider test: no withheld value entered any provider request
  across a successful tool result, refused retry, and final answer turn;
- packed Runner verification: passed;
- packed backward compatibility: passed against published 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 baselines;
- packed live PostgreSQL Auto Boundary/Explore/Protect verification: passed;
- `git diff --check`: passed before the final progress entry.

The disposable install was refreshed without rewriting its generated project:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:bfdb8ef4bd666f838bc5e6d47f78db92d13379046de20703edc022bd0b19cbb7
```

Release-management blocker: the source manifests for `@synapsor/spec` and
`@synapsor/dsl` still say `1.7.0`, and registry collision checks report both
artifacts as changed from those immutable published versions. No version was
changed because the owner explicitly prohibited an automatic bump. New public
Spec/DSL versions must be authorized before publication.

No technical deep-dive edit, npm publication, release, tag, merge, push, or
dist-tag movement occurred.

## 2026-07-29: Boundary Review CLI Front Door And Interactive Picker

Fixed the owner-reported model-withheld review path without changing authority
semantics:

- flag-based review now opens with an explicit unsaved preview, resolves the
  requested field to its inspected type and database-declared values when
  available, names model-withheld additions, collapses unchanged state, hides
  raw digests from normal output, and ends with the exact `--apply` command;
- `boundary draft` now continues first to the exact terminal
  `boundary review` command and presents `ui --boundary-root ... --open` only
  as the visual alternative; JSON returns the same `next_action` and
  `visual_alternative`;
- unknown field names now fail before regeneration and list the inspected
  columns for the selected table;
- `--apply` persists the reviewer/reason-bound model-withheld override and
  disabled candidate, while activation remains absent and separate;
- bare `boundary review` in a TTY now opens a risk-first table picker, and bare
  resource review opens a column picker with visible, model-withheld, and
  kept-out tiers plus plain consequences and inline risk labels;
- the picker now presents those tiers explicitly as V Model + Runner, W Runner
  output only, and K Kept out; its instructions say to press the Spacebar to
  change the selected column and show the complete three-state order, while
  V/W/K remain direct choices;
- selected rows, headings, key hints, tier badges, and review states use
  terminal-safe bold/color/inverse styling, while `NO_COLOR` retains an
  uppercase, structurally distinct fallback;
- B, Backspace, or Escape returns from columns to the table list without
  saving; M opens a structural map of allowed field operations, trusted-scope
  column names, reviewed many-to-one paths, fan-out, and cohort suppression;
- `boundary review resource <table> --map` prints the same metadata-only map
  without a TTY and refuses to combine inspection with decision flags;
- reviewable tables excluded by conservative generation can be deliberately
  included through the same picker and explicit confirmation, while tables
  blocked on unresolved identity or trusted scope still fail closed;
- trusted tenant/principal columns remain fixed outside model arguments and
  cannot be widened by the picker;
- non-TTY resource review without decision flags prints usage and exits nonzero;
- picker and flag paths use the same prepare/commit implementation and produce
  identical candidates and digests.

Verification:

- focused boundary CLI/picker set: 14/14;
- complete root gate: 72 files, 1,055/1,055 tests, plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- packed Runner verification: passed;
- packed backward compatibility: passed against published 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 baselines;
- packed live PostgreSQL Auto Boundary/Explore/Protect verification: passed,
  including suppression, drift/limit refusals, separate activation, and
  `source_database_changed: false`;
- real FitFlow CLI front-door probe: resolved `public.check_ins.outcome`,
  emitted the exact apply command, and rejected `banana` with all seven real
  columns;
- real packed TTY probe: displayed the risk-first table picker and cancelled
  without saving or activating;
- `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:88280e54ff82f8e13e14e2bfbbce8a9a15af5350e25b79e9947307ad7397700e

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:88280e54ff82f8e13e14e2bfbbce8a9a15af5350e25b79e9947307ad7397700e

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Fresh TrailPeak Signature-Journey Proof

The latest packed Runner was exercised from an empty project against the live
tenant-isolated TrailPeak PostgreSQL fixture and the live OpenAI provider. The
operator used one command, `start --from-env DATABASE_URL --cli`, entered no
tenant or principal value, edited no file, wrote no SQL/DSL/JSON, and installed
no MCP client configuration. Auto Boundary proposed one connected five-table
boundary from six inspected tables, with 28 model-visible fields and eight
fields kept out. One Enter recorded the exact local review and activation, then
continued directly into the model-first analytics shell.

Measured from process start through the first independently rendered verified
result, the journey took 55.790 seconds, including the human interaction and
live provider latency. The exact first question, `How did order totals change
by week?`, returned 12 reviewed weekly totals and identified the July 6 drop.
The latest automated 40-table browser run separately measured 322 ms to the
first action and 1.790 seconds to a verified result with exactly two
interactions.
Those automated and maintainer-operated measurements do not replace the still
required owner and independent-developer observations.

The same live session then proved the complete signature journey:

- `Which product category is growing fastest?` used one bounded 28-day versus
  preceding-28-day comparison over the reviewed Order Items -> Products and
  Order Items -> Orders star paths. Runner returned Trail Apparel at +130 items
  and +44.982699 percent without widening the 50-group ceiling.
- a reviewed customer-region question returned four visible regions and
  withheld one group below the minimum cohort;
- requesting customer email and another organization's data executed no query
  and returned neither kept-out values nor cross-tenant data;
- bare `/protect` selected the latest eligible analysis and generated disabled
  `analytics.order_items_count_by_category_and_week`; agent authority remained
  inactive and the exact Workbench review link was shown.

The first category-growth attempt exposed a real authority-to-interpretation
defect: the provider requested an all-history category-by-week cube larger than
the reviewed group ceiling, then local fallback copy incorrectly claimed the
reviewed Category path was absent. The correction keeps the ceiling intact,
guides unqualified growth questions into one bounded two-period comparison,
and computes access guidance from the complete active boundary set. Focused
model, access-summary, and Explore regressions pass 99/99, and the exact live
question now succeeds without an unnecessary widening prompt.

Release verification for this candidate includes the 1,178-test root suite,
Workbench Auto Boundary and Ask browser gates, official-SDK stdio and HTTP MCP
conformance, an external OpenAI agent over MCP, live PostgreSQL/MySQL aggregate
and reviewed-relationship gates, and packed Runner 1.5.4/1.6.0/1.6.3/1.6.5
backward compatibility. The release smoke reaches the public-version collision
check and stops honestly because authorized local Spec/DSL behavior differs
from immutable npm 1.7.0 packages. Resolving those public package versions
requires separate owner release authorization; the check was not bypassed.

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Column-review wrapping correction

The column-review table no longer lets the trusted-scope review note wrap in
the middle of `output tier reviewed`. The compact table now uses the concise
`[trusted scope]` badge and `RUNNER ONLY` access label; the selected-field
consequence below the table retains the complete explanation of raw-value
egress and reviewed derived operations. The access column was narrowed so the
longest standard row fits a 100-column terminal.

Verification:

- focused terminal picker regression: 20/20;
- TypeScript/package build: passed;
- `git diff --check`: passed;
- refreshed installed Runner reports `1.6.6` and contains the corrected labels.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:e9987f6ebcb0c2b3b71dce71267633810d8ceb231c33a82b99b08be9dbc1b653

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:e9987f6ebcb0c2b3b71dce71267633810d8ceb231c33a82b99b08be9dbc1b653
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Conversational Follow-Ups And Runner-Only Analytics

Owner testing exposed two authority-to-experience gaps. Ask retained prior
human/model prose but not the safe Runner tool context needed to resolve a
clarification such as `both`, and a field reviewed as Runner-only could lose
useful aggregate authority even though its raw values were correctly withheld.

The corrected behavior is:

- bounded Ask history now carries only provider-safe prior tool plans and
  results, so follow-ups and clarification answers retain analytical context;
- history remains in process memory, is bounded to four turns and 16,384
  characters, and clears on `/clear`, provider change, authority change, or
  process exit;
- local full values from the MCP `_meta` presentation channel never enter that
  history or a later provider request;
- a field reviewed as **Raw values: Runner only** remains named and typed in
  the reviewed catalog and may retain its separately reviewed operations;
- reviewed `count_distinct` results for text/identifier fields and reviewed
  `sum`/`avg` results for numeric fields may reach the model, while raw row
  values, group labels, and time values remain local or become response-local
  opaque tokens;
- suppression, scope injection, extraction/differencing/rate budgets, and
  read-only transactions still apply; kept-out fields remain unavailable to
  every operation;
- the tier copy in CLI, Workbench, help, and public docs now distinguishes raw
  value egress from derived-result authority;
- Protect continues to produce public DSL and canonical JSON. Derived measure
  aliases are not incorrectly marked model-withheld merely because their source
  field is Runner-only, while raw dimensions and time aliases remain withheld.

Verification:

- focused generation, Explore, Protect, Ask, MCP, CLI, and Workbench tests:
  112/112 before the final external-client regression, then 98/98 with the new
  MCP front-door case;
- full root gate: 77 files and 1,145/1,145 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- the official MCP client test proves that `app.describe_data` advertises a
  Runner-only field's reviewed `count_distinct` operation and withheld egress
  tier, then receives the derived count without raw values or local `_meta`;
- a live independently orchestrated OpenAI `gpt-5-mini` session connected over
  stdio MCP, discovered exactly `app.describe_data` and `app.explore_data`,
  answered a weekly check-in/outcome question, then answered `Now show only
  attended` with one fresh Explore call using retained conversation context;
- the provider key remained in the verifier process and was not forwarded to
  the Runner MCP child;
- the packed Auto Boundary/Explore gate passed published compatibility,
  multi-boundary live discovery, suppression, drift, Protect, production
  exclusion, and no-source-mutation checks; first useful answer was measured at
  36.426 seconds in that fixture;
- the refreshed packed install advertised exactly the two read-only authoring
  tools through a final official stdio MCP smoke;
- `git diff --check`, TypeScript build, package build, and package installation
  passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:7d26756e922486f2c488f41d3a19be5827a1033aa975c89ddc5cba2db8564e3b

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:7d26756e922486f2c488f41d3a19be5827a1033aa975c89ddc5cba2db8564e3b
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Two-Step First Verified Value

The first-run acceptance budget is now a measured invariant rather than an
informal UX target. With the database URL, trusted application scope, and one
hosted provider credential already in the operator environment, first verified
value requires exactly two human interactions:

1. accept the displayed conservative boundary;
2. submit the first natural-language question.

The fresh terminal route is one command:

```text
synapsor-runner start --from-env DATABASE_URL --cli
```

It performs metadata-only inspection, generates the zero-authority project,
shows one deterministic one-table/zero-relationship boundary, records one human
review gesture, rechecks schema and read-only role posture, activates only that
exact digest, and starts the sole configured provider. It does not open a
provider picker or require a second egress confirmation in that golden path.
The provider, model, origin, visible-field boundary, and excluded-value posture
are displayed before the first question; submitting that question records the
egress decision. Runner sends no provider request before submission.

Workbench now follows the same two-interaction path. Its browser gate counts
the activation click and first-question submission directly and fails unless
`first_value_human_steps === 2`. It also verifies zero provider requests before
the question and two bounded provider/tool turns afterward. The first screen
shows what crosses the boundary, what stays out, trusted scope, hard limits,
and one question that is valid against the exact candidate. The answer screen
separates model interpretation from collapsible Runner-verified data.

This fast lane does not weaken authority:

- before the human gesture, generated authority is zero and no source row has
  been read;
- the model cannot review, activate, widen, change scope, approve, apply, or
  configure provider egress;
- a stale schema, non-read-only role, missing trusted scope, overridden privacy
  posture, or ineligible candidate falls back to detailed human review;
- broader generated tables and relationships remain disabled;
- production and shared/remote authoring surfaces still refuse Scoped Explore;
- repeated legal Explore questions need no repeated review and no Protect;
- Protect remains optional and creates public DSL, canonical JSON, and tests as
  a disabled named capability with `model_can_activate: false`.

Measured proofs:

- **Live CLI:** a completely fresh temporary project used the real read-only
  FitFlow PostgreSQL role and a real OpenAI `gpt-5-mini` request. Interaction
  1 accepted `public.check_ins`; interaction 2 asked which outcomes had the
  most check-ins. Runner returned `attended: 15`, `late_cancel: 5`, and one
  suppressed group. Command count: 1. Human interactions to first verified
  value: 2. Manual file edits: 0. The same live request was repeated through
  the refreshed npm-tarball install and again completed in exactly two
  interactions with the same Runner-verified result.
- **Optional Protect:** the resulting `A1` analysis generated
  `analytics.check_ins_by_outcome` with DSL, canonical contract, and tests.
  State was `disabled`, source data was unchanged, and the model could not
  activate it.
- **Workbench:** the deterministic browser gate passed 21 desktop/mobile and
  adverse-state captures and reported `first_value_human_steps: 2`.
- **Focused tests:** guided start, provider handoff, Ask, boundary picker,
  Workbench, candidate, and local UI passed 72/72.
- **Root tests:** all 74 files and 1,080/1,080 tests passed on a quiet machine,
  including the two signed-role tests that had previously timed out under
  load. The initial composite command then found the README three words over
  its 1,500-word budget; the copy was reduced and license/content,
  human-command, DSL-source, and Cursor-plugin checks all passed. A final clean
  composite rerun then passed all 1,080 tests and every policy check in one
  command.
- **Workbench Ask browser gate:** seven provider requests, one authentication
  recovery, two reviewed calls, one refusal, no persisted provider key, no
  browser storage, and no source mutation.
- **Packed Runner:** clean packed installation, public declarations, command
  aliases, bundled docs/examples, state isolation, and proof flow passed.
- **Packed compatibility:** published Runner/DSL/Spec baselines 1.5.4,
  1.6.0, 1.6.3, and 1.6.5 remained compatible.
- **Packed Auto Boundary/Explore:** staging Explore, drift, suppression,
  budgets, disabled Protect, production narrowing, and protected-capability
  survival passed. The verifier was corrected to assert the documented
  `result_format: 2` `ok` envelope rather than the legacy v1 `status` field.
- **Database parity:** live PostgreSQL and MySQL aggregate-read gates passed,
  including default suppression, explicit cohort override, evidence, audit,
  and timeout behavior. Reviewed star/depth-two relationship gates also passed
  on both engines with exact totals, scope enforcement, nullable semantics,
  and fan-out refusal.
- **Diff hygiene:** `git diff --check` passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:f3038ea48ab65300ba4b89737aab20cd80df48e136e8298f65596cfe2e844ef4

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:f3038ea48ab65300ba4b89737aab20cd80df48e136e8298f65596cfe2e844ef4

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, source-project edit, package-version change, npm
publication, release, tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Named Multi-Table Boundary Lifecycle

The CLI and Workbench now present Scoped Explore as one named, digest-bound
boundary pack containing multiple tables and reviewed relationship paths:

- `schema.table` rows are explicitly tables inside the boundary, not separate
  boundaries;
- `boundary status` reports the active and next boundary names and exact table
  membership;
- the TTY starts at `NEXT BOUNDARY - <name>`, explains that review-item counts
  are checks for operations, privacy, scope, visibility, and relationships,
  and provides direct `P` explanations with the matching edit path;
- `A/B`, `Enter`, and `R` add, navigate, edit, or remove tables from the
  disabled next version; `M` inspects its paginated map; `N` renames the
  digest-bound pack; and `C` runs the complete final review checklist;
- Workbench exposes the same boundary name, table membership, field tiers,
  Active now / Next boundary / Available to add / Blocked lanes, and direct
  add/remove/edit controls;
- active Explore can be disabled from the TTY lifecycle menu, the
  `boundary disable` command, or Workbench. This is intentionally not a
  destructive delete: the disabled next boundary, review decisions, protected
  capabilities, evidence, ledger, and source database remain intact;
- when Explore is not active, Workbench says `Explore already disabled`
  instead of offering an inapplicable destructive action.

The project deliberately keeps one active broad authoring boundary and one
editable disabled next version. Different production/persona surfaces continue
to use protected named capabilities or separate project/configuration packs;
the model cannot select, rename, activate, or disable any boundary.

Verification after the lifecycle changes:

- TypeScript build and focused picker/CLI/Workbench tests: 22/22;
- direct Workbench Quick Start activation/disable preservation test: passed;
- complete root gate: 72 files, 1,063/1,063 tests plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: passed across 21 screenshots and 40 inspected
  tables, including the named multi-table overview and lifecycle state;
- live PostgreSQL/MySQL aggregate gate: passed with trusted scope, read-only
  execution, count/sum/average, suppression, explicit threshold 1,
  evidence/audit, timeout classification, no member-row leakage, and no source
  mutation;
- packed Runner verification: passed from a clean install;
- packed backward compatibility: passed against published Runner 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 baselines;
- packed Auto Boundary/Explore/Protect journey: passed with two authoring tools,
  protected-only production authority, suppression, separate digest activation,
  and `source_database_changed: false`;
- `git diff --check`: passed.

The real 40-table owner project was inspected through the refreshed packed
binary without saving review state. It reported one disabled boundary named
`reviewed_staging` containing `public.classes`, `public.locations`, and
`public.members`, two reviewed many-to-one paths, 37 additional tables
available to add, and no active Explore authority. Opening and quitting the TTY
saved and activated nothing.

Refreshed unpublished disposable artifacts:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:b1309c3744f5b5998d95b7d7c481bfce7ed5ce368674c3dbb0863ddf1105ffec

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:b1309c3744f5b5998d95b7d7c481bfce7ed5ce368674c3dbb0863ddf1105ffec

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Whole-Boundary Review And Candidate Parity

Corrected the false one-table impression in both operator review surfaces
without widening the Quick Start authority:

- Auto Boundary still drafts every deterministically reviewable table/view in
  the inspected schema.
- Full CLI and Workbench review now call one shared deterministic candidate
  selector. With no saved review, it proposes at most three high-value/related
  tables and keeps every other reviewable or blocked table visible.
- Quick Start remains an explicitly labeled one-table, zero-relationship fast
  lane. Its copy now says that Runner inspected the whole schema, selected one
  conservative starter, and lets the operator review or add tables before
  activation.
- A blocked-only metadata draft remains inspectable but cannot be mistaken for
  activatable authority.

Workbench now has a whole-boundary overview above the per-table editor. It
shows:

- exact disabled-candidate and active table/path counts;
- current/staged, available-to-add, and blocked lanes;
- model-visible, Runner-output-only, and kept-out field counts for each table;
- active, candidate, and available proven relationship paths;
- direct Add, Remove, Edit, and Inspect blocker controls.

Adding or removing a table changes only the disabled candidate. The browser
gate stages one add and one remove and compares the active boundary artifact
byte for byte after both operations. The per-table editor remains the detailed
field/operation view.

CLI review now provides:

```text
synapsor-runner boundary review --map
```

for a noninteractive whole-boundary map, while `M` opens the paginated map
inside the TTY picker. `Enter` reviews or adds a table and `R` stages removal.
The 80-column rendering distinguishes `ACTIVE`, `ACTIVE - STAGED FOR REMOVAL`,
`CANDIDATE`, `NOT INCLUDED`, and `BLOCKED`; relationship facts use short
multi-line output instead of truncating the useful target/cardinality detail.
The existing `boundary review resource <table> --map` remains the separate
per-table field/operation map.

The first complete gate exposed one regression: active-boundary summary parsing
had accidentally entered every mutation load, preventing canonical
regeneration from repairing an intentionally invalid obsolete active artifact.
Active parsing was moved back to the read-only overview path. The focused
regeneration test and the second complete gate passed.

Verification:

- focused boundary/Workbench set: 22/22;
- executable Workbench renderer test: passed;
- Workbench visual browser gate: passed with 21 screenshots, including
  `workbench-whole-boundary-desktop.png`, 40-table layout, long identifiers,
  desktop/mobile states, actual add/remove controls, and unchanged active
  authority;
- real bundled 80-column TTY probe: whole map paginated correctly and cancelled
  without saving or activating;
- complete root gate: 72 files, 1,057/1,057 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- packed Runner verification: passed;
- packed backward compatibility: passed against published 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 baselines;
- packed live PostgreSQL Auto Boundary/Explore/Protect verification: passed
  with suppression, drift/limit refusals, separate activation, protected-only
  production tools, and `source_database_changed: false`;
- the disposable installed binary printed a three-table candidate, all 40
  inspected tables, and candidate/available many-to-one paths from the real
  owner test project;
- `git diff --check`: passed before this progress entry.

The disposable install was refreshed without rewriting its generated project
or database:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:2210f4ffb438d32ceceabe11972da47309304ec589325c4f91bf87b660fb8b15

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:2210f4ffb438d32ceceabe11972da47309304ec589325c4f91bf87b660fb8b15

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Concise Boundary Navigation And Dual-Engine Final Gate

The whole-boundary review now defaults to progressive disclosure instead of
printing the complete inspected schema:

- `boundary review --map` explains active authority, the disabled next
  boundary, six available-table examples, and bounded proven-path suggestions;
- `boundary review --map --all` is the explicit complete 40-table catalog;
- the TTY starts with only active/candidate tables, `A` opens all inspected
  tables, `B` returns to the boundary, and the viewport states exactly how many
  tables continue below;
- `Enter` edits a table, `R` stages removal, `M` opens its structural map,
  `Esc` returns, and `Q` exits without saving;
- column review uses `Space` to cycle access, direct `V/W/K` tier keys,
  `Enter` to review changes, and `Esc` to return;
- the map and tier copy explain that Runner-output-only fields may support
  separately reviewed local operations or proven joins without model egress,
  while kept-out fields remain unavailable to every read operation.

Workbench now presents the same authority model as four separate lanes:
`Active now`, `Next boundary`, `Available to add`, and `Blocked`. It provides
direct edit/add/remove/inspect controls, a field-tier legend, and bounded
`+N more` indicators rather than a long page dump. Candidate edits still do
not change active authority.

Installed-artifact probes against the real 40-table owner project proved:

- the default map is 42 lines / 1,654 bytes;
- the exhaustive map is 131 lines / 5,421 bytes and begins with
  `WHOLE BOUNDARY MAP (ALL TABLES)`;
- the first TTY view contains 3 boundary tables, `A` expands to a 10-row
  viewport over all 40, and the footer says 30 more tables are below;
- `M` shows field operations, trusted tenant/principal scope, a reviewed
  many-to-one relationship, fan-out, and cohort suppression;
- the final command strip uses the conventional `Up/Down Navigate`,
  `Enter Review table`, `Esc Back`, and `Q Quit` language while retaining old
  keys as compatibility shortcuts;
- returning with `Esc` and exiting with `Q` saved and activated nothing.

Final verification after these changes:

- focused CLI, Workbench, PostgreSQL, and MySQL tests: 5 files, 91/91;
- final picker/CLI/Workbench wording and behavior gate: 3 files, 18/18;
- complete root gate: 72 files, 1,059/1,059 tests plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: passed with 21 desktop/mobile/light/dark,
  keyboard, loading, stale, blocked, long-name, and 40-table captures;
- live aggregate/evidence gate: passed against both PostgreSQL and MySQL,
  including tenant/fixed scope, count/sum/average, suppression, threshold 1,
  evidence/audit, timeout, no member-row leakage, and no source mutation;
- the packed CLI inferred a live MySQL source from `DATABASE_URL`, performed a
  metadata-only inspection, generated a disabled MySQL boundary draft, and
  correctly kept structurally unresolved fixture tables blocked; the source
  row count remained 3;
- packed Runner verification: passed;
- packed backward compatibility: passed against published 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 baselines;
- `git diff --check`: passed.

The final refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:0c8839e707a068a49745f1bb2ab9353a5b7a0b57d2b63c63c05a27d3f69d39cf

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:0c8839e707a068a49745f1bb2ab9353a5b7a0b57d2b63c63c05a27d3f69d39cf

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Boundary-Version Naming And Save UX Follow-Up

Owner testing exposed that the review picker still presented member tables as
though each table were a boundary, described unresolved confirmations as vague
`review items`, and used a default-no save prompt that made Enter discard a
reviewed change. The CLI and Workbench now use the same explicit model:

- a project has one active boundary version and one disabled next boundary
  version;
- each boundary version may contain multiple member tables and reviewed
  relationship paths;
- the next-boundary name is shown before its member tables and persists across
  CLI and Workbench reloads;
- per-table counts are called `safety checks` and are explained as required
  confirmations for columns, operations, trusted scope, privacy limits, and
  relationships, not separate boundaries or unsaved field changes;
- selected-table actions and whole-boundary actions are visually and textually
  separated in the terminal;
- interactive rename, table-removal, and field-tier previews now use `[Y/n]`,
  so Enter records the disabled decision immediately; `n` explicitly discards
  it;
- interactive review no longer tells the developer to rerun a generated
  resource command after making the same choices in the picker;
- activation remains a separate exact-digest human-authority step.

Workbench presents matching Active boundary and Next boundary cards, identifies
the table rows as members of the next boundary, calls unresolved items safety
checks, and persists a renamed disabled boundary through its API without
activating it.

Verification after the follow-up:

- focused CLI picker, boundary CLI, Workbench rendering, and local API tests:
  4 files, 58/58;
- complete root gate: 72 files, 1,064/1,064 tests plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: passed with 21
  desktop/mobile/light/dark/keyboard/loading/stale/blocked/long-name/40-table
  captures;
- packed Runner verification: passed;
- refreshed disposable installation contains the new boundary-version and
  default-save behavior;
- `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:91027a124f78be415d7e2f871c2ca0228105c092934e6054f2adb0191f6aadee

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:91027a124f78be415d7e2f871c2ca0228105c092934e6054f2adb0191f6aadee
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Boundary-Only First View

Owner testing showed that the first terminal boundary-review screen still
flattened boundary status, member tables, safety-check explanations,
relationship summaries, and commands into one overwhelming view. CLI and
Workbench now use strict progressive disclosure:

1. The first view shows only the boundary versions that exist.
2. Opening the disabled next boundary reveals its member tables.
3. Opening a member table reveals columns and table-specific checks.

The packed CLI first view is now eight short lines: active status, one disabled
boundary row, one primary action, compact advanced actions, and one authority
sentence. It does not render table names. The table view uses compact
`[6 checks]` states, omits an unnecessary pagination sentence when every table
fits, and returns to the boundary list with Esc.

Workbench now shows only Active and Next boundary cards in its boundary
overview. **Review boundary** is the sole primary action. Table membership,
field tiers, paths, and checks live in the table/column editor; generated table
details and boundary naming options are collapsed. Add and remove remain
available from the same editor and update only the disabled next version.

Verification:

- focused CLI picker and Workbench renderer tests: 11/11;
- complete root gate: 72 files, 1,064/1,064 tests plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: passed with 21 desktop/mobile/light/dark and
  adverse-state captures, including add/remove without active-authority change;
- real packed TTY probe against the 40-table owner project: boundary-only first
  view, Enter to tables, Esc back, Q exit, and no save or activation;
- packed Runner verification: passed;
- `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:5ed55c2f914a1bdee5d1c4f46c2c5de7a1346fdd680d2c86020d6a7a78c0cc96

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:5ed55c2f914a1bdee5d1c4f46c2c5de7a1346fdd680d2c86020d6a7a78c0cc96
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Understandable Boundary Sign-Off

Owner testing showed that the boundary-only first view was concise, but the
next step still exposed 17 table-level internal decision IDs and two global
IDs as separate typed confirmations. Inspecting columns without changing them
also provided no natural way to confirm that the proposed access was correct.

CLI and Workbench now explain a boundary in plain English:

> A boundary is the reviewed set of tables, fields, relationships, and limits
> an agent may use. A draft grants no access; activation is separate.

The operator interaction is grouped without weakening the stored authority:

- the first CLI view is a table with `Version`, `Name`, `Status`, `Tables`, and
  `Review left` columns;
- the owner project now shows `3 tables + boundary` instead of 19 unexplained
  checks;
- one table sign-off displays and confirms its exact field tiers, operations,
  row identity, trusted tenant/principal scope, privacy minimum, and reviewed
  relationship paths;
- every underlying stable decision and reviewed-input digest is still stored
  independently;
- `boundary review --json` retains the advanced IDs and digests;
- `C` presents one boundary-settings sign-off and one sign-off per outstanding
  table, with no raw `CONFIRM <decision-id>` loop;
- opening a table, inspecting unchanged columns, and pressing Enter now leads
  to that table sign-off instead of discarding the review;
- `M` is paginated and Esc returns to the previous screen;
- `P` now appears directly below `TABLES`, before any rows or footer controls;
- `[6 checks]` is now `[6 safety categories]`, and `P` expands those categories
  into short explanations that fit an 80-column terminal;
- table and guided boundary sign-offs now use `[Y/n]`; Enter records the exact
  review already displayed, while `n` declines and saves nothing;
- activation remains a separate exact-boundary-digest operator action.

Workbench mirrors the same model with an Active/Next boundary table and
table-level sign-off counts. Its new table scrolls locally on narrow screens
instead of widening the mobile page. No model-facing tool gained review,
activation, approval, or apply authority.

Verification:

- focused boundary CLI picker, CLI front door, Workbench renderer, and syntax
  tests: 4 files, 27/27;
- complete root gate: 72 files, 1,066/1,066 tests plus trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- the two previously reported signed-role CLI tests passed in 2.6s and 3.1s;
- Workbench boundary visual gate: passed with 21 desktop/mobile/adverse-state
  captures and no horizontal overflow;
- Workbench Ask browser gate: passed with seven provider requests,
  authentication recovery, cancellation, one safe refusal, model-withheld
  output, no persisted key, and no browser-storage entries;
- packed Runner verification: passed;
- real installed 80-column TTY probe against the 40-table owner project:
  definition and boundary table rendered, map opened, Esc returned, and exit
  saved or activated nothing;
- refreshed installed-binary probe: `P` visibly explained allowed operations,
  privacy limits, user and customer row scope, column access, and the reviewed
  related-table path; the real table prompt rendered `[Y/n]`, declining
  returned to the unchanged draft, and 24/24 focused picker/front-door tests
  passed.

The Workbench Ask visual gate also now waits for credential reconfiguration to
finish before typing the next question. This removes a test race where the
asynchronous provider-status refresh could clear text entered too early.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:db4463ce55d72b664558510c964ad01a7b195ebc41ccc6fbebd283eafd9b7664

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:db4463ce55d72b664558510c964ad01a7b195ebc41ccc6fbebd283eafd9b7664
```

The owner project and database were not rewritten. No technical deep-dive
edit, package-version change, npm publication, release, tag, commit, merge,
push, or dist-tag movement occurred.

### 2026-07-30 Continuous Review to First Ask

Owner testing found that a fully reviewed boundary still required a second
`boundary activate` command and a copied `ACTIVATE sha256:...` phrase before
the developer could ask a first question. Workbench similarly exposed
fingerprint creation and activation as two visible actions.

The interactive path is now continuous without weakening authority:

- `C Final review` records grouped sign-offs, displays the exact reviewed
  fingerprint, and immediately asks
  `Activate "<boundary>" now? [Y/n]`;
- pressing Enter is the explicit activation gesture; the exact digest is still
  passed to and revalidated by the canonical activation implementation;
- declining leaves the complete review inactive and resumable;
- running `boundary activate` later uses the same default-yes prompt;
- non-TTY/headless activation still requires the complete
  `ACTIVATE sha256:...` value, a current review bundle, a verified signed-key or
  OIDC identity, role, reason, expiry, and nonce;
- successful CLI activation continues into the provider handoff described
  below instead of ending at a command hint;
- the boundary list now distinguishes `DRAFT - NO ACCESS` from
  `REVIEWED - NOT ACTIVE` instead of showing a contradictory complete draft.

Workbench now saves the final sign-off and advances directly to activation.
One **Activate and ask** action then saves review state, creates and revalidates
the exact fingerprint, activates only that digest, and opens Ask. Fingerprints
remain available as advanced/audit details, and no model-facing activation
tool was added.

Verification:

- focused boundary picker, CLI front-door, and Workbench renderer tests:
  27/27;
- full root gate: 72 files and 1,068/1,068 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: 21 desktop/mobile/adverse-state captures;
- packed community-solar clean room: final sign-off auto-advanced, one
  activation click opened Ask, first safe read completed in 42.0 seconds, and
  aggregate Explore, Protect, proposal, guarded apply, evidence, and MCP parity
  all passed;
- packed Runner isolated-install verification: passed;
- real installed TTY probe against the owner project: the first view showed
  `REVIEWED - NOT ACTIVE`; `C` opened `[Y/n]` directly; declining preserved all
  19 review decisions, no active authority, and no source change;
- local clean-room containers were removed after verification;
- `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:6c0f9d181c67c8bcf119d81c6e92544e8dabd9fa6e0a777c7efaba57b199a190

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:6c0f9d181c67c8bcf119d81c6e92544e8dabd9fa6e0a777c7efaba57b199a190
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-30 Activation to Provider Handoff

Owner testing showed that successful CLI activation still ended with an
incomplete command hint instead of taking the developer to first value. The
hint omitted the required model argument, and a project created through the
browserless `boundary draft` route did not have the config/store required by
`try ask`.

The browserless path is now continuous:

- successful interactive activation opens one arrow-key choice for OpenAI,
  Anthropic, a loopback OpenAI-compatible model, an existing MCP client, or
  **Later**;
- OpenAI and Anthropic use the same tested defaults as Workbench; local mode
  asks for a loopback base URL and model with editable defaults;
- a model choice invokes the canonical `try ask` implementation in the same
  process, so provider adapters, egress consent, tool limits, authority
  validation, and result rendering are not duplicated;
- **Later** leaves the boundary active and prints a complete retry command;
- the MCP path prints project-correct managed Cursor, Claude Code, and VS Code
  commands plus generic stdio guidance;
- provider setup failure states plainly that the reviewed boundary remains
  active;
- JSON and headless activation do not launch the chooser;
- fresh `boundary draft` now prepares the validated zero-authority Runner
  config, SQLite ledger, environment-name template, and MCP snippets without
  storing credential values; established configs are preserved.

Verification:

- TypeScript build: passed;
- focused activation, provider-handoff, Ask, and picker tests: 39/39 before the
  fresh-project repair, then 28/28 for the affected activation/draft/Ask set;
- full root gate: 73 files and 1,074/1,074 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- packed Runner isolated-install verification: passed;
- real TTY activation against a disposable copy of the reviewed FitFlow
  boundary displayed all five choices; Esc selected **Later** and preserved
  active authority;
- a clean browserless FitFlow project ran `boundary draft`, automatically
  created `synapsor.runner.json`, `.synapsor/local.db`, and guided state, then
  completed review/activation and entered the actual `Synapsor Analytics`
  prompt through the local-model choice;
- the refreshed disposable npm install reports Runner 1.6.6 and contains the
  provider-handoff and fresh-project initialization paths;
- the source project was not modified and no model/provider request was sent
  during the TTY proof.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:95acbe5b1e2a0affbbbef917f441b77bc4fc9d0dfbaf618773489d5c4d5b1eae

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:95acbe5b1e2a0affbbbef917f441b77bc4fc9d0dfbaf618773489d5c4d5b1eae
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-31 Saved Boundaries and Add/Remove DX

Owner testing exposed three related lifecycle gaps in the focused CLI editor:
an outside table appeared to require column-level entry before it was added,
`R` could terminate the command instead of staging removal, and there was no
discoverable way to create another named boundary. The same lifecycle also
needed a first-class Workbench surface.

The corrected operator experience is:

- selecting an addable related table records it in the disabled boundary first,
  prints `Draft added`, and then opens its column tiers;
- only tables connected by inspected foreign-key paths appear in the default
  add view; `Tab` deliberately expands to all inspected tables;
- `R` stages removal, prints `Draft removed`, and returns to the same editor;
- non-contained relationships are pruned after both additions and removals, so
  a fact table with several foreign keys cannot retain a path to a table outside
  the boundary;
- the boundary overview uses `A` to create another named disabled boundary,
  Enter to open one, `N` to rename, and `X` to delete a selected inactive draft;
- multiple disabled boundary drafts may be saved, but only one exact boundary
  may be active for Scoped Explore; activating another replaces authority and
  never unions the drafts;
- Workbench exposes the same create, open/edit, rename, delete, add-table,
  remove-table, and disable-active lifecycle;
- Workbench now refreshes the boundary-list authority state on activation and
  disable, preventing an unchanged active digest from being mislabeled as
  `Active + draft edits`.

Verification:

- focused CLI/Workbench/API regression set: 70/70;
- realistic multi-foreign-key CLI regression: adding one target retains only
  that contained path, and removing the target removes all now-dangling paths;
- full root gate: 75 files and 1,102/1,102 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: 22 desktop/mobile/adverse-state captures,
  including a 40-table schema and the measured two-human-step first value;
- packed Runner isolated-install verification: passed;
- real packed TTY proof against the existing 40-table FitFlow Postgres fixture:
  `public.classes` was added before its columns opened, `R` removed it without
  exiting, a second `membership_analytics` boundary was created and listed next
  to `reviewed_staging`, and deleting the inactive draft preserved authority;
- Postgres and MySQL package tests remained green;
- `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:ad07dcb9ad6d1a1061712516b4a92a1401cf40f0c071c0de68829b5dade63132

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:ad07dcb9ad6d1a1061712516b4a92a1401cf40f0c071c0de68829b5dade63132
```

The disposable first-time project used for the packed TTY proof is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/first-time-boundaries-0Vdpth
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-31 Interactive Boundary Name Containment

Owner testing found that an invalid name entered while creating a saved
boundary escaped the boundary editor. The surrounding Analytics launcher then
misreported the validation error as `Ask did not start` and ended the flow.

The corrected behavior is:

- ordinary capitalization is normalized visibly during creation and rename,
  so `Test_hotel` becomes `test_hotel`;
- malformed names are refused inline with the short naming rule;
- duplicate or library-level create failures are also contained inside the
  boundary review loop;
- active authority, source data, and existing Ask access remain unchanged;
- Workbench applies the same lower-case normalization and keeps validation
  errors in its boundary form;
- the strict boundary-library validator remains authoritative for API and
  automation callers.

Verification:

- focused CLI and Workbench regressions: 21/21;
- full root gate: 75 files and 1,103/1,103 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: 22 desktop/mobile/adverse-state captures;
- packed Runner isolated-install verification: passed;
- real packed TTY proof copied the owner's test project, entered `Test_hotel`,
  created disabled boundary `test_hotel`, renamed it from `Hotel_Analytics` to
  `hotel_analytics`, and returned directly to its access editor without
  invoking the Ask handoff;
- the owner's original project was not modified.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:265f923ad117a6c444991c5e12c60ffc88696b96c97ca0a0ab55162b320fba7a

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:265f923ad117a6c444991c5e12c60ffc88696b96c97ca0a0ab55162b320fba7a
```

The disposable packed TTY proof copy is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/boundary-name-final-proof-idgiyV
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-07-31 Principal Scope Inference And First-Ask Blocker

Owner testing found that adding `public.classes` to a reviewed boundary caused
the post-activation Ask handoff to require `SYNAPSOR_PRINCIPAL`. The inspected
FitFlow credential had tenant RLS for `public.classes`, but no principal policy
applicable to that database role. Auto Boundary had incorrectly promoted the
descriptive `trainer_id -> trainers` foreign key into principal authorization.

The corrected rule is:

- a person-like or assignee-like foreign key may be listed as descriptive
  review evidence, but it cannot prove per-principal authorization;
- Auto Boundary selects principal scope only from an applicable database RLS
  policy, an existing reviewed Synapsor contract, or an explicit human scope
  decision;
- PostgreSQL policies assigned to another role do not create authority for the
  inspected role;
- a boundary that explicitly reviews a principal key still requires the trusted
  principal outside model arguments and fails closed when it is missing;
- the exact activation review now states either `Principal scope: Not required
  for this boundary` or the precise table, field, and environment binding that
  will be required before Ask.

Verification:

- focused inference, trusted-scope, CLI-review, and Workbench-review regressions:
  39/39;
- full root gate: 75 files and 1,105/1,105 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: 22 desktop/mobile/adverse-state captures;
- packed Runner isolated-install verification: passed;
- live packed-draft/runtime proof against the existing 40-table FitFlow
  PostgreSQL fixture, with both `SYNAPSOR_PRINCIPAL` and `SYNAPSOR_TENANT_ID`
  unset: `public.check_ins`, `public.classes`, and `public.locations` all had no
  generated principal key; tenant scope resolved from the verified PostgreSQL
  role setting; runtime principal source resolved to `not_required`;
- packed `start --no-open --rescan` proof on a copy of the owner's affected
  project generated the same three-table candidate with no principal key; the
  real terminal review activated it, offered the provider picker, accepted the
  provider-egress decision, and reached the `synapsor>` prompt while
  `SYNAPSOR_PRINCIPAL` remained unset;
- explicit reviewed-principal regression: missing `SYNAPSOR_PRINCIPAL` remains
  a hard refusal, preserving the core trusted-context boundary.

The live proof project is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/principal-runtime-proof-ZQHqYA
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/principal-rescan-proof-YPgFOz
```

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:39ff6abdfeb4fcab32e71e6b6ef7df1ebdad6e8eb54355599f7f17e0622c22bf

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:39ff6abdfeb4fcab32e71e6b6ef7df1ebdad6e8eb54355599f7f17e0622c22bf
```

Existing active boundaries are not silently rewritten on upgrade. A fresh or
explicitly rescanned draft must be reviewed before this corrected generated
authority replaces an older digest.

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Trusted Scope Output Tiers

Owner review identified an unnecessary coupling between trusted row scope and
output visibility. A tenant or principal column was fixed outside model
arguments, but the access editor prevented the database owner from choosing
how that column could appear in a result.

The corrected rule is:

- trusted tenant and principal values remain injected outside model arguments
  in every output tier;
- the conservative generated default remains **Kept out**;
- a human may explicitly review **Runner output only**, which shows the raw
  value in Runner's local verified result and sends only a response-local
  opaque token to the configured model;
- a human may explicitly review **Model + Runner**, which permits the raw
  output value to enter model context without creating a model-controlled
  tenant/principal argument;
- either disclosure change requires a reviewer reason, changes the exact
  boundary fingerprint, and remains disabled until exact human activation;
- trusted scope fields remain unavailable as model-selected filters, sorts,
  groups, measures, count-distinct fields, time buckets, or scope overrides;
- query audit and evidence continue to omit raw trusted scope and result
  values.

CLI, Workbench, generated public DSL, canonical contract JSON, provider-egress
copy, and the packed documentation now describe the same distinction between
scope authority and output visibility.

Verification:

- focused generator, CLI, Workbench, and real Scoped Explore runtime tests:
  84/84;
- full root gate: 76 files and 1,123/1,123 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench browser visual gate: 23 desktop/mobile/adverse-state captures;
- packed Auto Boundary/Explore gate and published backward-compatibility
  fixtures for Runner 1.5.4, 1.6.0, 1.6.3, and 1.6.5: passed;
- live reviewed relationship, scope, nullable-link, and fan-out verification:
  passed on PostgreSQL and MySQL;
- `git diff --check` and TypeScript typecheck: passed.

The refreshed unpublished disposable artifact is:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:cc9c1d92b443f223d91cdc0ec5241ceaaf20da2b294369db67752f7fe70f02c9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Ask Consent Handoff And Slash Menu Redraw

Owner testing found two terminal-session defects. Backspacing through filtered
slash-command suggestions could leave stale menu rows in the terminal, and an
Ask session whose boundary was widened through `/access` deferred renewed
provider consent until the next natural-language question.

The corrected behavior is:

- slash suggestions are rendered as one replaceable block directly beneath the
  active prompt;
  filtering, Backspace restoration, and complete clearing redraw that block
  without appending stale rows or relying on unsupported cursor save/restore
  sequences;
- the final exact boundary activation review now shows the current provider,
  model, and endpoint before the operator confirms activation;
- that single `Activate ... and continue to Ask` decision renews the exact
  authority-bound provider consent for the current in-memory Ask session;
- activation rebinds the new active boundary-set digest, clears bounded model
  conversation context, retains the in-memory provider credential, and returns
  to `synapsor>` without a second consent prompt;
- activation itself makes no provider request;
- if authority changes outside the current `/access` handoff, the pending
  question is not sent and Runner gives a safe recovery action instead of
  opening a consent prompt inside the conversation.

Verification:

- focused boundary, Ask, and terminal-shell regressions: 52/52;
- full root gate: 76 files and 1,124/1,124 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- packed backward compatibility for Runner 1.5.4, 1.6.0, 1.6.3, and 1.6.5:
  passed;
- packed Auto Boundary/Explore journey, including stable two-tool
  multi-boundary authoring and no source mutation: passed;
- real TTY probe through the refreshed installed binary: `/`, `a`, Backspace,
  Backspace restored and then fully cleared the command menu; Ctrl+D exited
  cleanly without a model request;
- TypeScript typecheck and `git diff --check`: passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:7f8cfd02a0d8e8efa858a5e57f03ffb9903ce200aef644774667ac88d2a4fc55

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:7f8cfd02a0d8e8efa858a5e57f03ffb9903ce200aef644774667ac88d2a4fc55
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Boundary Access Continuity, Privacy, And Workbench Handoff

Owner testing exposed the remaining friction between the Analytics shell,
terminal boundary editor, and visual Workbench. The corrected behavior is:

- slash actions render as a transient menu below the active `synapsor>` prompt,
  filter as the operator types, and clear without stale rows on Backspace;
- `/access-workbench` is the canonical command; the old
  `/access workbench` spelling remains accepted but is no longer advertised;
- the secured Workbench launched from Ask resolves the generated boundary
  artifact root, so its token bootstrap loads the actual candidate rather than
  failing with `Boundary review could not load`;
- `/access` opens at the named-boundary list, then lets the operator select a
  boundary and edit several tables or columns before one explicit final review;
- a table edit, related-table addition, or privacy change returns to the same
  boundary editor instead of forcing immediate activation or a new model login;
- each selected table exposes a discoverable `Privacy` action showing its
  effective minimum cohort;
- the operator may keep the reviewed default of 5 or record a reasoned,
  digest-bound owner override down to an effective minimum of 1; the model
  cannot request, trigger, or confirm the override;
- suppression output points to that exact access path instead of naming a
  control that the CLI does not provide;
- Workbench shows the effective privacy threshold in the boundary list and
  table header, links directly to its owner-review form, and stages changes
  until the same final human activation;
- model prose, Runner-verified data, system status, interactive keys, exact
  boundary values, and warnings now have distinct terminal hierarchy. Model
  prose is italic where the terminal supports ANSI styling.

Verification:

- full root gate: 76 files and 1,126/1,126 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- Workbench Auto Boundary visual gate: 23 desktop/mobile/adverse-state
  captures, with the first-value path still measured at two human steps;
- Workbench Ask browser gate: five captures, seven provider requests, one
  expected authentication refusal, two reviewed tool calls, one safe refusal,
  no source mutation, no persisted provider key, and no browser-storage entry;
- packed backward compatibility: Runner 1.5.4, 1.6.0, 1.6.3, and 1.6.5
  baselines all passed with their published DSL and Spec baselines;
- packed Auto Boundary/Explore journey: stable two-tool multi-boundary
  authoring, protected-capability promotion, suppression, drift and authority
  checks, and no source mutation passed;
- live PostgreSQL and MySQL reviewed star/depth-two verification: exact totals,
  nullable semantics, tenant scope, and ambiguous fan-out refusal passed;
- refreshed installed-binary proof from an empty directory: one Enter activated
  the conservative boundary and opened Ask, `/access-workbench` returned a
  token-protected page whose `/api/boundary` response loaded
  `reviewed_staging`, `/access` opened the boundary list first, the table
  view exposed `P Privacy`, quitting resumed the same Ask session, slash
  actions rendered below the prompt, and Ctrl+D exited cleanly;
- generated test containers and temporary proof projects were removed;
- `git diff --check` passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:04b75d3d13df4150b3f75330821f0baad0d365d795cabfbb2613a41cad3d3c12

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:04b75d3d13df4150b3f75330821f0baad0d365d795cabfbb2613a41cad3d3c12

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-spec-1.7.0.tgz
sha256:1ed4e4875c6de287edf1d212f1db5bfae1ec06bd2465c1b13edb1f4db3b293e9
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-01 Escape-Back Prompt Navigation

Owner testing found that line-entry prompts such as `New boundary name` and
hosted/local model selection had no one-level return path. An accidental entry
required Ctrl+C and a restarted command, while raw-key menus already understood
Escape.

The corrected terminal convention is:

- every affected text and yes/no prompt visibly advertises **Esc Back**;
- Escape returns one level immediately and never acts like an empty Enter;
- an empty Enter still accepts an explicitly displayed default;
- boundary naming, reviewer identity, review reason, privacy-threshold, and
  activation prompts discard only the pending input on Escape;
- Escape from an OpenAI or Anthropic model name returns to provider choice;
- local-model setup returns from model name to endpoint, then from endpoint to
  provider choice;
- Escape from provider choice returns to Quick Start with the previous model
  selection intact;
- Escape from a hidden hosted-provider credential prompt returns to model
  selection without retaining or printing the partial credential;
- Escape from the standalone provider-egress confirmation returns without a
  provider request;
- Escape from Quick Start pauses onboarding without opening another review
  surface or activating authority;
- existing `B` compatibility remains limited to raw-key menus and is not used
  as a back command in free-text input.

Verification:

- focused boundary, Quick Start, and provider-selection regressions passed;
- full root gate: 77 files and 1,137/1,137 tests, followed by trusted-core,
  license/content, human-command, DSL-path, and Cursor-plugin checks;
- packed backward compatibility passed for Runner 1.5.4, 1.6.0, 1.6.3, and
  1.6.5 with their published DSL and Spec baselines;
- packed Auto Boundary/Explore passed multi-boundary authoring, suppression,
  Protect, drift, production-surface, and no-source-mutation checks;
- a real TTY against the refreshed installed artifact proved `New boundary
  name -> Esc -> boundary list`, `OpenAI model -> Esc -> provider choice`,
  `provider choice -> Esc -> Quick Start`, `hidden API key -> Esc -> model
  selection`, and `Quick Start -> Esc -> clean exit`; the partial test key was
  not printed, no provider request was made, and no boundary was activated or
  saved by those cancellations;
- TypeScript typecheck and `git diff --check` passed.

The refreshed unpublished disposable artifacts are:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6.tgz
sha256:f75502007b785872a0b3b8765dfa76f0008dba1a11024fd17316c6084db8d07a

/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/install/synapsor-runner-1.6.6-local.tgz
sha256:f75502007b785872a0b3b8765dfa76f0008dba1a11024fd17316c6084db8d07a
```

No technical deep-dive edit, package-version change, npm publication, release,
tag, commit, merge, push, or dist-tag movement occurred.

### 2026-08-02 CLI Protect, Explore Evidence, And Final Visual Audit

The final operator-plane gap is closed without weakening the separation between
model requests and human authority:

- `/protect` now completes generation, review, and exact activation in the
  current terminal session. It creates public DSL, canonical JSON, tests, and a
  disabled capability before showing one concise human review. Enter is the
  separate activation gesture; No or Escape leaves the capability disabled;
- a sole latest analysis is selected without requiring its short reference,
  multi-plan answers open a readable picker, and stale or changed artifacts
  fail closed before activation;
- Workbench remains an equivalent optional visual surface. Its Protect button
  binds the secured preview and exact digest internally, so the normal path no
  longer asks the operator to copy or type `ACTIVATE sha256:...`;
- missing, stale, wrong-capability, expired-session, and duplicate Workbench
  activation requests are rejected through the canonical activation path;
- CLI `/details` and Workbench now separate the original question, model's
  typed tool arguments, Runner's normalized plan, reviewed boundary and
  relationships, trusted-scope mechanism, read-only transaction posture,
  suppression/budget decisions, execution shape, and audit/evidence linkage;
- external MCP evidence states when the host's original question is unavailable
  instead of inventing one;
- optional parameterized PostgreSQL/MySQL statement inspection is local
  operator diagnostics only. Values, trusted scope, credentials, and URLs are
  redacted; SQL is never sent to the model/MCP client or stored in ordinary
  evidence;
- slash-command suggestions redraw directly beneath the active `synapsor>`
  prompt and clear on Backspace-to-empty, Enter, or Escape without stale rows;
- packed screenshot helpers now wait for the active view's 200 ms entry
  animation to finish. The previously dim Community Solar and healthcare
  captures were intermediate animation frames, not a runtime overlay; refreshed
  captures are fully rendered.

Final verification on the current unpublished worktree:

- focused Protect, shell, Workbench, Scoped Explore, output-schema, and external
  MCP regression set: 128/128;
- full root gate: 79 files and 1,187/1,187 tests; trusted-core dependency,
  license/content, human-command, DSL-path, and Cursor-plugin checks passed;
- PostgreSQL/MySQL aggregate-read and reviewed star/depth-two relationship gates
  passed, including nullable semantics, scope, suppression, and fan-out refusal;
- packed backward compatibility passed against Runner 1.5.4, 1.6.0, 1.6.3,
  and 1.6.5;
- packed Auto Boundary/Explore, FitFlow onboarding, Workbench Ask, host-neutral
  MCP, managed client configuration, disposable first-run write proof, package
  manifest, Runner package, and Runner alias checks passed;
- packed Retail, Community Solar, and healthcare/PHI browser journeys passed.
  The refreshed Community Solar run reached activation in 28.922s and its first
  safe read in 29.399s. The refreshed all-blocked healthcare run reached
  activation in 30.066s and its first safe read in 30.479s;
- the healthcare run again proved PHI classification before source-row access,
  RLS isolation, stored prompt-injection inertness, ten legal Explore plans,
  Workbench/MCP parity, Protect, production narrowing, and browser recovery;
- the technical deep dive was not edited. No package version, publication,
  release, tag, commit, merge, push, or dist-tag changed.

### 2026-08-02 Security Audit Remediation (ACTIVE - RESUME HERE)

This section is the authoritative resume checkpoint for the post-DX security
audit. The work below is release-blocking and is not complete. Preserve all
earlier 1.6.6 work; do not restart or reimplement completed onboarding, Ask,
Explore, Protect, Workbench, CLI, MCP, or write-governance work.

Current repository state:

- repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`;
- branch: `feat/runner-1.6.6-safe-agent-analytics`;
- base/current committed HEAD: `18da253`;
- worktree: intentionally very dirty with the unpublished 1.6.6 implementation;
- package versions: unchanged;
- no npm publication, tag, release, commit, merge, push, or dist-tag movement;
- `SYNAPSOR_TECHNICAL_DEEP_DIVE.md` must not be edited without explicit owner
  permission.

Verified baseline immediately before remediation:

- `corepack pnpm test`: PASS, 79 files and 1,208/1,208 tests; trusted-core,
  license/content, human-command surface, DSL-path, and Cursor-plugin checks
  passed;
- `apps/runner/src/boundary-cli-picker.test.ts`: PASS, 23/23. The previously
  reported five ANSI/cursor assertion failures do not reproduce in this
  worktree;
- `corepack pnpm test:workbench-ask`: PASS with seven desktop/mobile captures,
  eight provider requests, one authentication refusal, no persisted key, no
  browser storage, and no source mutation;
- `corepack pnpm test:auto-boundary-visual`: FAILS only while waiting for stale
  text `Cursor is connected`. The actual UI now correctly says the project
  config is prepared and that no live client session is connected. Update the
  visual assertion; do not revert the honest UI copy;
- `git diff --check`: PASS.

Confirmed release-blocking findings:

1. Cohort subtraction gap. `requiresDifferencingProtection` currently charges
   only aggregate plans with a filter or explicit comparison. An unfiltered
   grouped aggregate and an unfiltered scalar total therefore cost no
   differencing allowance. Subtracting visible groups from the total reveals
   the combined suppressed value, and reveals the exact value when one group is
   suppressed. The proof and docs currently overstate this guarantee.
2. Model-withheld enum disclosure. `describeBoundary` applies model-withheld
   status to `field_egress` but emits `field_enums` for every reviewed field.
   A withheld categorical field's raw domain therefore reaches provider/model
   context. Type metadata also remains visible; determine the minimum type
   shape needed for legal typed plans, but no withheld raw enum value may leave
   Runner.
3. Weak row-hash guard omitted at apply. Supported legacy/compatibility
   single-row proposals can produce `conflict_guard.kind = row_hash`, while the
   PostgreSQL and MySQL lock/update paths enforce only `version_column`. Until
   an exact projection-bound hash can be proven, direct database adapters must
   reject this guard explicitly before mutation rather than silently omit it.
   Modern bounded-set writes already reject weak guards.
4. PostgreSQL write posture omits assumable table owners. The writeback RLS
   inspection rejects direct owner, superuser, and BYPASSRLS roles but does not
   check `pg_has_role(current_user, c.relowner, 'MEMBER')`. Schema inspection
   and Scoped Explore already reject that posture. Add the equivalent write
   check and tests without weakening FORCE RLS requirements.

Confirmed lower findings that are included in this remediation:

- source-receipt COMMIT acknowledgement loss is serialized as
  `failed/OUTCOME_UNKNOWN`; supervised local execution moves the queue item to
  reconciliation, but the result/proposal semantics remain inconsistent. An
  ambiguous source outcome must be represented as reconciliation-required and
  must never be retried as an ordinary failure;
- INSERT performs a pre-read without proving source uniqueness at apply. A
  missing-row `FOR UPDATE` is not sufficient. Generated onboarding already
  requires a primary/unique proposal identity; direct adapters must fail closed
  unless the effective deduplication columns are protected by a current,
  non-partial source uniqueness guarantee;
- differencing allowance is currently per plan family, so changing filter
  shapes/dimensions/measures multiplies the allowance. Global query/extraction
  limits reduce but do not remove this issue;
- the session fingerprint includes the UTC date, so privacy accounting resets
  at midnight even where copy calls it per-session;
- budget enforcement reads an audit snapshot before execution and records use
  afterward, allowing concurrent calls to pass against the same snapshot.

Proof and UX requirements:

- extend the real deterministic `Boundary held` proof with a subtraction or
  complementary-total attack through the actual authoring path;
- do not display a complete `N/N held` guarantee unless that attack is included
  and refused;
- keep the useful model-withheld banner only after provider-request capture
  proves withheld enum values and raw values never enter any request, retry, or
  refusal turn;
- update the stale boundary visual assertion to the honest project-config copy;
- keep the Ask visual behavior already verified: model answer primary, Runner
  result collapsible, clear authentication recovery, no key persistence;
- update all affected public docs and proof wording, except the technical deep
  dive, so no surface claims stronger protection than the runtime proves.

Implementation order and status:

- [x] Reproduce and classify the root, picker, Ask visual, and boundary visual
  gates.
- [x] Implement an atomic, durable complement-release guard shared by both
  database engines. Scalar totals and suppressed groupings for the same
  reviewed source/scope/cohort/measure cannot both be released, in either
  order, across UTC-day rollover, boundary revisions, processes, or concurrent
  requests. Only HMAC/digest metadata is stored; no source values are stored.
- [x] Charge every cohort-protected aggregate against differencing accounting,
  while exact replays remain one variant. This closes the prior unfiltered
  zero-cost path; it is not described as differential privacy.
- [x] Remove model-withheld enum domains from `app.describe_data` while
  retaining safe type and legal-operation metadata needed to compose typed
  Runner-only aggregates. The direct external-MCP projection now proves the
  withheld enum literals are absent.
- [x] Add the final recording-provider request-body regression for withheld
  enums/values across provider retries and refusal turns.
- [x] Reject unsupported legacy `row_hash`, missing exact update guards, and
  reserved `__row_hash` pseudo-column guards in both direct adapters before the
  first source query. Public compatibility parsing remains additive, but the
  adapter no longer silently drops the guard.
- [x] Reject PostgreSQL writer roles that can inherit/assume the target owner
  role. The same catalog attestation applies recursively to security-invoker
  view dependencies and remains additive to FORCE RLS, superuser, BYPASSRLS,
  and direct-owner checks.
- [x] Correct ambiguous source outcomes and revalidate INSERT uniqueness.
- [x] Replace pre-query privacy snapshots with atomic durable reservations for
  Scoped Explore and protected named reads. Accounting now uses a rolling
  24-hour source/scope/resource window, survives restart and UTC midnight,
  treats only an exact normalized-plan replay as the same variant, and shares
  allowance across changed measures, dimensions, filters, time grains, and
  limits. Pending concurrent work counts conservatively; failed/unreleased
  work releases its extraction and differencing charge.
- [x] Extend Boundary Proof, Workbench copy, CLI details, docs, and visual
  assertions without over-claiming. The technical deep dive was not edited.
- [x] Run focused unit/integration tests, both visual gates, full root gate,
  live PostgreSQL/MySQL safety gates, packed compatibility, packed adoption,
  publish-manifest/dry-run, secret scan, and final process/container cleanup.

Completed remediation checkpoint (2026-08-02):

- Added `explore_privacy_releases` to the local proposal store and an atomic
  `BEGIN IMMEDIATE` claim operation. A second complementary release fails
  closed before any result reaches the caller. Post-query refusals now record
  that a source query executed and that no result was released.
- Added regressions for grouped-then-scalar, scalar-then-grouped, cross-midnight
  persistence, and a true concurrent race using two runtimes/stores against the
  same local ledger.
- Added an external MCP catalog regression proving a Runner-only field retains
  its type/count-distinct grammar while its raw enum domain is absent.
- Focused verification: `scoped-explore.test.ts` passes 36/36; proposal-store
  and Runner TypeScript/package builds pass.
- Writeback verification: PostgreSQL adapter passes 42/42, MySQL adapter passes
  34/34, and both package TypeScript builds pass. Regressions assert that weak
  guards issue zero client queries and that an assumable owner issues no target
  mutation.
- Source-receipt COMMIT acknowledgement loss now returns
  `reconciliation_required` with `OUTCOME_UNKNOWN`, the actual `source_db`
  authority on normalized results, and a deterministic source reconciliation
  intent. It is never serialized as an ordinary retryable failure. The
  additive legacy-v1 result/receipt shape now carries the same reconciliation
  state and intent; existing non-ambiguous v1 output is unchanged.
- PostgreSQL and MySQL INSERT apply now inspect current source uniqueness before
  the deduplication pre-read. Every single/batch member must cover a complete,
  non-null unique key; PostgreSQL additionally requires a valid, ready,
  non-partial plain-column index, and MySQL rejects prefix/functional keys.
  Missing or insufficient proof fails closed with
  `INSERT_DEDUP_UNIQUENESS_UNPROVEN` before any business INSERT.
- Focused verification after this checkpoint: protocol 35/35, PostgreSQL
  adapter 44/44, MySQL adapter 36/36; all three package builds, the Runner
  build, and `git diff --check` pass. Tests cover normalized and legacy COMMIT
  ambiguity, deterministic intents, no rollback after an unknown COMMIT, and
  single/batch INSERT refusal without source uniqueness.
- Added `explore_budget_reservations` to the local ledger with atomic
  `BEGIN IMMEDIATE` claim/finalize operations. The reservation metadata is
  redacted, contains no SQL or source/scope values, and round-trips through
  the shared PostgreSQL runtime-store ledger under its advisory transaction
  lock.
- Scoped Explore now uses one stable keyed privacy scope instead of a
  UTC-calendar-day budget partition. Existing same-day/previous-day audit
  fingerprints are counted during upgrade, and rolling-window usage is
  reflected in result metadata. Full normalized query fingerprints are the
  variants; changing `top_n`, measures, dimensions, filters, or time shape no
  longer opens another per-family allowance.
- Protected named reads reserve before source execution and finalize before
  returning/evidence creation. Source failures and refused results release the
  disclosure charge; a crash leaves a conservative pending charge. The same
  mechanism works through local SQLite and the shared PostgreSQL ledger bridge.
- New regressions prove restart across UTC midnight does not reset allowance,
  allowance expires only after the rolling window, measure/dimension/time
  families share one resource allowance, and two concurrent stores/runtimes
  cannot both cross query or differencing limits before source execution.
- Focused verification after privacy-accounting hardening: Scoped Explore
  40/40 including the final cross-family assertion; proposal store
  72/72; protected named reads 9/9; proposal-store, MCP-server, and Runner
  TypeScript builds pass; focused `git diff --check` passes.
- Final focused privacy/proof verification: Scoped Explore 40/40; model Ask
  30/30 with every provider request body captured across describe, tokenized
  result, refused retry, and final-answer turns; Boundary Proof 3/3; Runner
  TypeScript and the boundary visual script syntax check pass. Boundary Proof
  now includes an eighth suppressed-total subtraction probe, persists no probe
  values, reports source-query behavior honestly, and the browser gate expects
  the current honest managed-client copy.
- Public documentation now describes atomic rolling 24-hour resource-scoped
  accounting, exact normalized replay, conservative concurrent reservations,
  complementary-total refusal, and withheld enum-domain removal. Focused
  Workbench/local-UI verification passes 40/40 from the repository root; the
  earlier root-relative fixture errors were invocation mistakes, not product
  failures.
- Full root verification is green: 79 test files and 1,224 tests, followed by
  trusted-core dependency, license/content, human command-surface, DSL source
  path, and Cursor plugin checks. The run used the repository root and the
  configured 20-second test/hook timeouts; no cwd leak or timeout cascade
  occurred.
- Both browser gates are green on the remediation worktree.
  `test:auto-boundary-visual` produced 25 captures, reached an actionable
  boundary in 515 ms and a verified result in 1.846 s, and showed the expanded
  8/8 Boundary Proof. `test:workbench-ask` produced seven captures, exercised
  eight provider requests plus handled authentication/refusal states, and
  retained no provider key or browser storage. The generated screenshots were
  inspected and render coherently.
- Live PostgreSQL/MySQL `test:aggregate-read` and
  `test:reviewed-relationships` gates pass, including suppression, tenant
  scope, star/depth-two relationships, nullable semantics, and fan-out
  refusal.
- The live Auto Boundary gate exposed one upgrade-reader defect after the
  privacy reservation change: explicit pre-execution refusal audits without a
  reservation ID were being counted as legacy executed queries. The legacy
  reader now excludes only audits that explicitly prove no source execution;
  ambiguous older audits remain conservatively counted. Proposal Store passes
  73/73 with the regression. The live Auto Boundary/Explore/Protect journey
  then passed with two returned groups, two suppressed groups, exact two-tool
  authoring exposure, one activated protected production tool, and no source
  mutation. The verifier also now passes its fixture environment explicitly to
  Protect instead of depending on the parent shell's `DATABASE_URL`.
- Packed backward compatibility passes against Runner 1.5.4, 1.6.0, 1.6.3,
  and 1.6.5 with their immutable Spec/DSL package graphs. The corrected packed
  Auto Boundary 1.6.6 tarball journey passes with two live boundaries, stable
  two-tool authoring discovery, two returned and two suppressed groups,
  demand-driven relationship review, shared cross-shape differencing
  enforcement, Protect, production narrowing, and no source mutation. Its
  first useful answer completed in 46.662 s in the full proof-heavy fixture.
- Packed FitFlow onboarding passes. Schema summary completed in 3.785 s,
  activation in 4.713 s, first safe read in 7.695 s, aggregate in 11.756 s,
  and optional Protect in 13.697 s. The same gate passed proposal, OIDC
  approval/apply separation, policy automation, competing workers, limits,
  conflict, receipts/replay, compensation, and quiet signed notifications.
- The packed host-neutral TypeScript client passes with the official MCP SDK,
  reviewed schemas, digest pins, no operator tools, and no source mutation.
- The packed Community Solar browser clean room passes from
  `synapsor-runner-1.6.6.tgz`, including Workbench interaction, official MCP
  parity, Protect, proposal/approval/apply, reversible write evidence,
  tenant/principal isolation, credential non-disclosure, and 16 refreshed
  screenshots.

Resolved healthcare budget checkpoint (2026-08-03):

- New Auto Boundaries review a finite default of 16 distinct
  cohort-protected aggregate variants per root resource per rolling 24 hours.
  This supports the explicit ten-plan first-use acceptance plus suppression and
  injection checks while retaining one shared cross-shape pool. Existing
  boundaries retain their exact digest-bound value, reviewers may narrow the
  generated value, and no model input can change it.
- This remains stricter than the published behavior: the old six-attempt
  allowance restarted across plan families and did not charge unfiltered
  totals/trends. The new finite 16 applies globally across measures,
  dimensions, filters, time shapes, ordering, boundary revisions, processes,
  and UTC midnight; the complementary-release guard remains independent.
- Focused Auto Boundary and Scoped Explore verification passes 65/65,
  including exact replay, cross-family accounting, restart/midnight,
  concurrent reservations, and both complement-release orders.
- Packed healthcare/PHI now passes from the rebuilt 1.6.6 tarball. One
  activated boundary executes all 10 required legal plans without Protect or
  repeated review and creates 20 metadata-only query-audit entries. The run
  also proves all-blocked review recovery, PHI exclusion, principal/tenant
  isolation, stored prompt-injection inertness, small-cohort suppression,
  Workbench/CLI/MCP parity, optional selected-plan Protect, production
  stdio/HTTP parity, browser recovery with budgets preserved, and no source
  mutation. Nine browser captures were regenerated; first safe read completed
  in 61.426 s in this all-blocked proof-heavy fixture.
- Packed Retail now passes from the same rebuilt tarball. Its 45-table project
  executes all 10 required legal plans with two reviewed relationships,
  ranking, comparison, bounded filters, multiple measures/dimensions, and no
  automatic Protect. Workbench, CLI Ask, interactive shell, and official MCP
  agree; the reviewed-view derived-measure recipe, selected-plan Protect,
  proposal/approval/apply lifecycle, reversible write evidence, 20
  metadata-only audits, and no unintended source mutation all pass. Sixteen
  browser captures were regenerated; first safe read completed in 53.755 s in
  the full 45-table proof fixture.

Final remediation verification checkpoint (2026-08-03):

- The final root gate passes 79/79 test files and 1,225/1,225 tests. The
  trusted-core dependency check covers 171 modules and 866 internal edges;
  license/content, human command-surface, DSL source-path, and Cursor plugin
  checks also pass.
- `verify:runner-publish-manifest`, `test:mcp-client-configs`,
  `verify:packed-runner`, and `verify:packed-runner-alias` pass. Installed
  Claude Code 2.1.220 and Codex CLI 0.146.0 accept their generated configs;
  Cursor, VS Code, Claude Desktop, generic stdio, LangChain, ADK, and
  LlamaIndex examples parse and pass the secret scan.
- Runner's npm publish dry run passes without publishing: 352 files, 2.0 MB
  packed, and 9.1 MB unpacked.
- The public-package collision guard correctly blocks a release because the
  current source contents of `@synapsor/spec@1.7.0` and
  `@synapsor/dsl@1.7.0` differ from those immutable versions already on npm.
  No version was changed. Owner-authorized new Spec/DSL versions are required
  before any real publication.
- The exact authorized OpenAI key was read only for a repository-wide leak
  scan. Zero occurrences were found across 1,000 tracked and untracked files.
  No key value was printed or persisted.
- `git diff --check` passes. No Runner, Vitest, Playwright, or verification
  process remains. Running Docker containers belong to unrelated local
  projects and were left untouched. Existing ignored `.synapsor` demo notes,
  logs, and local state were also retained rather than treating owner material
  as disposable test output; the pre-refactor ledger database is an
  intentional tracked compatibility fixture.
- No package was published, no tag/release/commit/push was created, and no
  package version was changed during this remediation. The technical deep
  dive was not edited.

Next owner-controlled actions:

1. Complete and record the remaining uncoached human adoption measurement if
   it has not already been accepted from the owner's manual runs.
2. Decide when to commit and release the prepared package set. Publication,
   tags, commits, pushes, and dist-tag changes remain outside this checkpoint.

Spec/DSL 1.8.0 release-preparation checkpoint (2026-08-03):

- The owner authorized the additive public package update while retaining the
  unpublished Runner release at 1.6.6. Prepared versions are now
  `@synapsor/runner@1.6.6`, `synapsor-runner@1.6.6`,
  `@synapsor/spec@1.8.0`, and `@synapsor/dsl@1.8.0`.
- Spec/DSL 1.8.0 contain four additive reviewed-authority features:
  model-withheld fields, explicit minimum cohort 1, a separately reviewed
  ranked-candidate ceiling, and absolute/percentage ordering of exact
  two-period comparisons. Omitted fields preserve legacy normalization and
  digests. Generated-authority readers continue to accept Spec 1.7.0.
- Runner and DSL workspace dependency ranges now require `@synapsor/spec
  ^1.8.0`; generated Auto Boundaries declare Spec 1.8.0. The frozen lockfile,
  source publish manifest, release notes, changelog, migration guide, and
  current usability guide agree.
- The npm collision guard passes and confirms that Spec/DSL 1.8.0 are not yet
  published. Publish dry runs pass without publishing: Spec has 83 files and a
  50.4 kB tarball; DSL has 14 files and a 30.4 kB tarball; Runner has 352 files,
  a 2.0 MB tarball, and registry dependency `@synapsor/spec ^1.8.0`; the alias
  has four files and a 4.7 kB tarball.
- Focused Spec/DSL/Auto Boundary/generated-authority/catalog/protected-read
  verification passes 164/164 tests. Workspace typecheck and build pass.
- Packed backward compatibility passes against immutable Runner 1.5.4, 1.6.0,
  1.6.3, and 1.6.5 dependency graphs. The packed 1.6.6 Auto Boundary journey,
  packed Runner, packed alias, host-neutral TypeScript client, and managed MCP
  client configuration gates all pass.
- Community Solar, Healthcare/PHI, and Retail clean rooms pass independently
  from the same `synapsor-spec-1.8.0.tgz` and
  `synapsor-runner-1.6.6.tgz`. Their browser, CLI, official MCP, Explore,
  Protect, isolation, suppression, and no-unintended-mutation assertions all
  pass. Retail's first cold rerun exceeded the existing 60-second harness
  clock while the workstation was heavily loaded; the isolated warm rerun
  passed unchanged at 36.668 seconds, so no timeout was raised.
- Both browser gates pass: the boundary/attention gate produced 25 captures
  with two first-value human steps, and Workbench Ask produced seven captures
  with zero provider-key persistence and zero browser-storage entries.
- The final root gate passes 79/79 test files and 1,226/1,226 tests, followed by
  trusted-core, license/content, human command-surface, DSL source-path, and
  Cursor plugin checks. `git diff --check` and frozen-lockfile installation
  pass.
- No package was published; no commit, push, merge, tag, release, or dist-tag
  change was made. The technical deep dive remains untouched.

ANSI picker-test reconciliation checkpoint (2026-08-03):

- The first final root run inherited `NO_COLOR=1` from the Codex environment.
  Five boundary-picker assertions incorrectly compared semantic copy across
  ANSI styling boundaries, so that run passed while an ANSI-enabled shell
  failed the same tests. This was test staleness, not a picker runtime failure,
  but the earlier environment-limited green claim was incomplete.
- A direct reproduction with `NO_COLOR` unset produced the reported five
  failures. The affected semantic assertions now compare ANSI-stripped output;
  dedicated raw-output tests still verify cyan headings, colored focus,
  no inverse-video selection, cursor redraw behavior, and control-sequence
  sanitization.
- `boundary-cli-picker.test.ts` passes 23/23 with `NO_COLOR=1` and separately
  passes 23/23 with `NO_COLOR` unset.
- The complete root gate was rerun with `env -u NO_COLOR` and passes 79/79 test
  files and 1,226/1,226 tests, followed by trusted-core, license/content,
  human command-surface, DSL source-path, and Cursor plugin checks.

Post-audit hardening checkpoint complete (2026-08-03):

- Person-name defaults are now conservative. High-confidence qualified person
  names (`full_name`, first/last/given/family/surname forms, and qualified
  customer/contact/member/employee names) are classified sensitive;
  `display_name` is held for review because it is context-dependent. Bare
  `name`, product/category/organization names remain structurally low risk.
  Auto Boundary independently re-runs the current classifier and takes the
  more restrictive result, so an old low-risk inspection snapshot cannot
  preserve the former exposure suggestion. Focused classifier and Auto
  Boundary regressions pass.
- Normal human CLI rejection output no longer starts with raw JSON telemetry;
  structured rejection logging remains available in JSON mode or through
  `SYNAPSOR_OPERATIONAL_LOG=json`. Bare non-TTY `boundary review` now returns
  the concise project-specific boundary overview instead of generic usage.
  Front-door regressions pass.
- Writeback now compares every job/proposal freshness authority with the
  current reviewed freshness policy. Adding, removing, or materially changing
  that policy after proposal creation fails closed and requires a new proposal.
  The existing apply-time guarantee remains the stronger locked re-read of the
  target and every supporting dependency; proof `valid_until` intentionally
  remains an approval-time property rather than replacing state revalidation.
- MySQL direct writeback now has a client-enforced pre-commit transaction
  deadline in addition to `max_execution_time` and InnoDB lock waits. Expiry
  destroys the connection before any COMMIT is sent, causing the open
  transaction to roll back; lost acknowledgement after COMMIT remains an
  unknown outcome requiring reconciliation. Duplicate-key failures map to
  `INSERT_DEDUP_CONFLICT` only for single/batch INSERT, not UPDATE/DELETE.
  MySQL adapter verification passes 38/38.
- Worker retry/dead-letter/completion paths now require the exact fenced lease
  ID at runtime. Missing IDs fail with `WORKER_LEASE_ID_REQUIRED`; stale IDs
  still fail with `WORKER_LEASE_MISMATCH`. Proposal Store passes 73/73.
- `jwt_oidc` operator identity now requires exact issuer and audience/resource
  values during config validation. Shared HTTP already required these values;
  local signature-only session compatibility is unchanged. Config passes
  42/42.
- Notification receivers now have an async durable replay-verification API
  whose caller supplies an atomic insert-if-absent event-ID claim. The legacy
  process-local Set remains suitable only for tests/single-process demos and
  is documented honestly. Dispatch isolates a lost/expired lease on one item
  and continues the rest of the claimed batch. Notification tests pass 12/12.
- No release metadata, package version, publication, commit, push, merge, tag,
  or dist-tag changed. The technical deep dive remains untouched.
- Qualified person-name classifier tests cover 57 cases; the combined changed
  safety/operator suites pass 272/272. The picker passes 23/23 with ANSI color
  enabled and independently 23/23 with `NO_COLOR=1`.
- The final ANSI-enabled root gate passes 79/79 files and 1,245/1,245 tests,
  followed by trusted-core dependency, license/content, human command-surface,
  DSL source-path, and Cursor plugin checks. Typecheck, package build, and
  `git diff --check` pass.
- The complete release gate was rerun after correcting a late README policy
  failure. The problem-language README was reduced from 1,630 to 1,447 words,
  synchronized to the npm package, and retains the exact supervised-execution
  and notification boundary wording. The rerun passes 457/457 trusted tests,
  MCP client configuration, Docker first-run, public commands, local Runner,
  packed Runner, own-database onboarding, content/license checks, manifest and
  registry-collision checks, publish dry-run, and final diff validation.
- Both browser gates pass. Boundary/attention verification produced 25 captures,
  measured two first-value human steps, first actionable UI at 221 ms, and a
  verified result at 1,584 ms. Workbench Ask produced seven captures, eight
  provider requests, two reviewed calls, one refusal, zero source mutation,
  zero provider-key persistence, and zero browser-storage entries.
- Live guarded CRUD passes against PostgreSQL and MySQL for every receipt mode,
  retry, crash windows, concurrent apply, and DELETE hazards. A real MySQL
  `BEFORE UPDATE` sleep trigger proves the new client deadline interrupts DML,
  leaves the row/version unchanged, and rolls back the source receipt before
  COMMIT.
- Live freshness verification passes on PostgreSQL and MySQL for approval
  preflight, proof binding, source and runner-ledger apply, target/supporting
  drift, DELETE, bounded-set rollback, quorum, shared runtime store,
  Cloud-approved local revalidation, doctor lock probes, idempotency, and
  kept-out-value redaction.
- Packed backward compatibility passes against Runner 1.5.4, 1.6.0, 1.6.3,
  and 1.6.5 dependency graphs. Packed 1.6.6 Auto Boundary/Explore and the
  `synapsor-runner` alias pass. The packed first-use journey reports 36.684 s to
  a useful answer and 39.758 s through protected capability promotion, with no
  source mutation.
- Honest residual boundaries: ambiguous `display_name` stays unresolved rather
  than guessed; durable webhook replay depends on the embedding service's
  atomic insert-if-absent store, while the legacy in-process helper remains for
  tests and single-process demos; a lost MySQL COMMIT acknowledgement still
  requires reconciliation and is deliberately distinct from the pre-COMMIT
  deadline.
- Release notes and the changelog now cover this audit pass. No Cloud repository
  was touched. No package was published and no commit, push, merge, tag, release,
  or dist-tag change was made. The technical deep dive remains untouched.

Post-1.6.6 first-run repair checkpoint (2026-08-03):

- Release status is blocked. Published 1.6.6 can dead-end on the first
  `start --from-env DATABASE_URL --cli` access screen when a normal schema has
  source-proven record-ID and tenant candidates but no pre-resolved trusted
  scope. A green unit suite did not substitute for the missing packed Enter-key
  journey; no replacement release is ready until that exact journey passes.
- The terminal access editor now identifies candidate-resolvable blocked tables,
  opens an inline `RESOLVE TABLE ACCESS` screen, constrains choices to inspected
  unique-key/tenant candidates, records the reviewer decision through the
  canonical boundary mutation path, then opens column review without activating
  authority or terminating the parent `start --cli` session. The CLI front-door
  regression passes.
- Workbench exposed a second form of the same defect: it submitted record identity
  and tenant isolation separately while each request demanded immediate table
  inclusion. The first valid choice therefore failed because the second remained
  unresolved. Partial scope choices can now be staged as disabled review evidence;
  inclusion occurs only after all required choices resolve. A real secured
  `/api/boundary/regenerate` regression selects `id`, then `tenant_id`, proves the
  table enters only the disabled candidate, and verifies no active-boundary file
  exists.
- Startup summaries and Workbench preflight now use an operator-only metadata
  catalog that defers reviewed time-coverage aggregates. The model-facing
  `app.describe_data` catalog still receives cohort-safe date coverage when it is
  actually requested for analysis. A regression proves startup description makes
  zero executor calls, keeping the UI's `No source rows have been read yet` claim
  true.
- Additional repairs currently on the branch include natural foreign-key
  `count_distinct` defaults with an actionable operator-only refusal, path-free
  no-boundary errors, hosted-provider default models, friendly two-period CLI
  comparison flags, invocation-scoped `try protect --last`, explicit invalid
  Protect-name errors, noninteractive boundary rename/delete, and cohort-safe
  reviewed time coverage.
- Current verification: typecheck passes; the combined changed Runner suites pass
  207/207, and the new Workbench blocked-scope route passes independently. Packed
  PostgreSQL/MySQL first-run, browser visual, and full root/release gates remain
  outstanding and must be recorded literally before completion.

Post-release first-run human verification (2026-08-03):

- A durable packed-TTY gate now installs a newly packed Runner into a clean
  directory, starts the real PostgreSQL and MySQL example databases, and drives
  `start --from-env DATABASE_URL --cli` through the same Enter/arrow-key screens
  a first-time developer sees. On both engines it resolved the blocked record
  identity and tenant key inline, kept the column editor open, performed the one
  whole-boundary review and activation, reached model selection, and proved the
  source snapshots were byte-for-byte unchanged. The measured runs were 3.170 s
  for PostgreSQL and 3.117 s for MySQL.
- The equivalent secured Workbench browser journey exposed a state bug that the
  route-only test missed: the first of two scope choices discarded a renamed
  disabled boundary while an older boundary remained active. Partial decisions
  now preserve a freshly rebased review revision whenever the selected candidate
  already contains tables; the legacy empty-candidate first-run behavior remains
  valid. A route regression covers the exact active + renamed + two-choice state.
- Physical browser testing also found two interaction defects: the second scope
  form could be rerendered while a fast user was entering text, and the remaining
  blocked-access decision collapsed below an unreachable diagnostic column list.
  Managed review updates are now single-flight and expose `aria-busy`; unresolved
  access stays open above column diagnostics until the table is usable.
- The complete Workbench visual journey passes with 40 inspected tables, blocked
  and ambiguous fixtures, mobile and desktop layouts, two human actions to first
  value, first actionable UI at 501 ms, and a verified answer at 1.830 s. The
  independent Ask browser gate passes with eight provider requests, two reviewed
  tool calls, one safe refusal, no source mutation, no persisted provider key,
  and zero browser-storage entries.
- Full root, packed compatibility, and release gates are still in progress. No
  version, publication, tag, release, merge, push, or dist-tag change was made.

Packed Workbench approval repair (2026-08-03):

- The retained retail clean-room run exposed a load-sensitive integration defect
  after an explicit fresh source proof: Workbench delegated approval to the
  canonical CLI implementation, which discarded the still-valid proof and ran
  the same database check again. Under the complete browser journey that
  redundant read exceeded the fixture's statement timeout, so approval failed
  closed even though the operator-created proof was unexpired.
- Workbench now selects the current project-local proof on the server, never from
  browser input. Canonical approval reuses it only when it is the latest exact
  digest, fresh, unexpired, unused, proposal hash/version/dependency bound, and
  still matches the current reviewed freshness policy. Proposal Store repeats
  the exact proof and expiry checks atomically while recording approval; guarded
  apply still revalidates the live source independently.
- Focused tests pass 45/45. They cover the server-selected digest, rejection of a
  browser-supplied digest, wrong/expired/already-used proofs, and freshness-policy
  drift. Runner typecheck and diff validation pass for this repair.
- A clean packed Runner installation completed the full physical-browser retail
  journey in 332.110 seconds. It performed one schema start, boundary activation,
  verified Explore and Ask, Protect, disabled guided write proposal, explicit
  live freshness check, human approval, guarded apply, receipt/lifecycle review,
  and post-write Ask. Approval advanced to apply without a redundant failing
  source read; `order-005` moved only at apply from `processing:1` to
  `fulfilled:2`. Proposal and approval reported no source mutation.
- The packed proof used `@synapsor/runner` 1.6.6 and `@synapsor/spec` 1.8.0
  tarballs built from this worktree, generated 19 browser captures, exercised 10
  legal aggregate plans plus refusal cases, exposed only `app.describe_data` and
  `app.explore_data` to authoring MCP, and completed with exit 0. No publication,
  version, tag, release, merge, push, or dist-tag change occurred.

Final post-release repair verification (2026-08-03):

- The full root suite passes 81 files and 1,269 tests, including the trusted-core
  graph, license/content checks, human-surface checks, DSL source paths, and the
  Cursor plugin. The focused freshness-proof regressions pass 45/45.
- The packed PostgreSQL/MySQL first-run TTY gate passes from clean installations.
  Both engines resolve blocked scope inline, keep column review open after the
  first Enter action, activate the reviewed boundary, reach model selection, and
  leave the source database unchanged. The final release-gate measurements were
  3.378 seconds for PostgreSQL and 3.227 seconds for MySQL.
- The Workbench boundary visual gate passes with 27 captures, and the independent
  Workbench Ask gate passes with seven captures, eight provider requests, two
  reviewed tool calls, one safe refusal, no source mutation, no persisted key,
  and zero browser-storage entries.
- Packed backward compatibility passes against Runner 1.5.4, 1.6.0, 1.6.3, and
  1.6.5 with their corresponding published DSL/spec dependency graphs. The
  packed guided-onboarding journey passes through schema review, activation,
  first read, aggregate analysis, Protect, proposal, guarded apply, OIDC refusal
  cases, supervised modes, compensation, and notifications.
- `scripts/verify-release-gate.sh` passes end to end for Runner 1.6.6. It includes
  typecheck; 458 trusted release tests; current Claude Code 2.1.220 and Codex CLI
  0.146.0 MCP configuration checks; the disposable Docker proof; public command,
  local-runner, source-manifest, registry-only packed-install, own-database, and
  publish-dry-run checks; byte-identical npm collision checks for spec/dsl 1.8.0;
  and `git diff --check`.
- No package was published. No version, commit, merge, push, tag, release, or
  dist-tag change was made, and the Cloud repository and technical deep dive
  remain untouched.

Inactive-boundary error closure (2026-08-03):

- External follow-up was correct: the earlier path-redaction fix covered
  `try explore` and `try ask`, but both `try protect --last` and explicit
  `try protect --from A1` still exposed the absolute legacy active-boundary path
  through a raw `ENOENT` error.
- All analytics boundary loaders now share one `EXPLORE_DISABLED` translation.
  Missing authority returns one recovery action; unreadable or malformed
  authority returns a separate path-free review/recovery message. Protect's
  analysis-reference resolver uses the same translation as Explore and Ask.
- Fast regressions cover direct Explore and both Protect selectors. A CLI
  front-door regression invokes Explore, Ask, Protect `--last`, and Protect
  `--from` through the production error renderer and asserts that no project
  path, active-boundary filename, or `ENOENT` text is emitted.
- A newly packed Runner 1.6.6 tarball was installed into a clean temporary npm
  prefix. All four commands were run against an empty project and returned only:
  `No reviewed analytics access is active. Run synapsor-runner start and complete
  the local data-access review.` No provider request or source query ran.
- Typecheck, package build, focused tests, and `git diff --check` pass. The final
  full root suite passes 81 files and 1,271 tests, including license/content,
  human command-surface, DSL source-path, and Cursor-plugin verification.
- No package was published. No version, commit, merge, push, tag, release, or
  dist-tag change was made.
