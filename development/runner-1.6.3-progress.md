# Runner 1.6.3 Progress

Branch: `feature/runner-1.6.3-guided-adoption`

Baseline OSS commit: `6a6f49f` (`fix(release): make Runner 1.6.2 registry-installable`)

Goal source: `/home/sandesh-tiwari/Desktop/C++/goal.txt`

Goal SHA-256 at start:
`90eaa49fc71a663c9fc392ccbda7a3583de1e20ed4fdb58a496a8632155a886e`

Current goal SHA-256 after the 2026-07-24 P0 onboarding,
approval-identity, supervised-worker, complete Workbench-operations,
human-attention/notification, and release-wide documentation revisions:
`88d303f576c26989623aefce9a3f1d4697c380b209817a46c1f8bf38ab66dcad`

The current goal adds Ardent-level onboarding as a release-blocking DX
benchmark. Ardent is not a dependency and database branching is not in scope.
The public first command must orchestrate a resumable path from `DATABASE_URL`
to Workbench and a real safe read, while preserving every existing security and
backward-compatibility invariant. The clean packed-artifact journey is the P0
integration surface; disconnected primitive or component tests cannot by
themselves satisfy the release.

The current goal also makes the `APPROVAL ROLE` to `operator_identity`
lifecycle release-blocking: ship one packaged end-to-end guide and prove the
normal public approval/apply flow against a simulated external OIDC/JWKS issuer,
including fail-closed role, signature/key, issuer/audience, time, tamper, and
separate apply-authorization cases. Keep the corresponding deep-dive TODO until
that evidence exists.

The 2026-07-24 operator-supervised-apply addendum is now integrated as Phase
8B. It requires a digest-bound contract permission plus an independent
deployment allowlist before the existing trusted worker may automatically
consume approved work. Existing `AUTO APPROVE` remains manual-apply by default.
Policy-auto-approved work must still fail closed on target or supporting-
evidence drift before execution and cannot inherit approval onto a refreshed
diff. Runner stays at 1.6.3; the new public contract/DSL permission moves Spec
and DSL to 1.6.0.

Phase 8C now requires one durable human-attention pipeline: authoritative ledger
transition plus transactional outbox, a separate dispatcher, a no-ID Workbench
inbox, CLI/JSON inspection, a JSONL development sink, and a signed generic HTTP
webhook. Notifications inform but never authorize. The subsystem is additive
and disabled by default; an optional exact-capability worker policy may hold
automatic production writes while all designated supervision sinks are
unhealthy. Release documentation and public messaging must cover the full
event, security, delivery, inbox, recovery, and compatibility boundaries.

The default external-delivery preset is quiet. Workbench/ledger retain every
event, while successful lifecycle traffic stays internal unless explicitly
routed or included in a digest. Human-attention incidents coalesce related
events, transient recovery does not interrupt operators, sink-specific budgets
and routes bound noise, and critical UNKNOWN/reconciliation states still
dispatch promptly.

Supporting evidence:

- `/home/sandesh-tiwari/Desktop/C++/bug.md`
- `/home/sandesh-tiwari/Desktop/C++/DX-NOTE.md`
- `/home/sandesh-tiwari/Desktop/C++/RESULTS.md`

Target: complete the additive Runner 1.6.3 guided-adoption release without
publishing, pushing, tagging, releasing, deploying, or changing external
services.

## Status

| Phase | Status | Evidence |
| --- | --- | --- |
| Baseline and architecture audit | completed | Registry, Git, package, source, CLI, Workbench, and untouched test baselines recorded below |
| Shared sensitivity classifier | completed | Database, Prisma, Drizzle, and OpenAPI use one classifier; high-risk and uncertain free text default to kept out |
| Workbench review-by-exception UX | completed | Dedicated overview/review/sign-off/Explore/Protect/Add Action renderer, managed field decisions, persisted narrowing/confirmation progress, browser-JS validation, packed product journey, and desktop/mobile visual gates pass. The external first-timer observation script is prepared for the owner and is not falsely reported as completed. |
| Row identity, principal scope, and operator identity UX | completed | Row identity is restricted to source-proven single-column primary/unique keys; blocked scope is resolved through persisted regeneration; trusted tenant/principal decisions, role posture, and operator identity are visible without exposing their values. Packed organization/trainer RLS and OIDC cases pass. |
| Approval-role identity lifecycle | completed | Packaged guide, localhost RS256/JWKS fixture, and packed public-CLI integration prove exact role acceptance; role/claim/key/time/issuer/audience/JWKS/attestation denials; token non-retention; proposal binding; proof tamper/replay refusal; independent rotated-key apply; receipt; and replay |
| Operator-supervised automatic apply | completed | Dual contract/deployment opt-in, exact-digest authority, eligible native shapes, full CLI/Workbench controls, honest MCP status, TTL, current-policy/limit checks, least-privilege writer posture, fencing, a real two-process policy-reservation proof, packed live policy/human worker execution plus source-drift conflict, the shared fleet crash/recovery matrix, and release documentation pass. |
| Human attention and generic notifications | completed | Additive SQLite/shared-ledger schemas, immutable redacted events, coalesced/reopening attention items, fenced delivery leasing, quiet-default routing, cooldown/rate budgets, quiet hours, signed CloudEvents-compatible HTTPS webhook delivery, pinned DNS/SSRF protection, JSONL delivery, no-ID CLI inspection, tenant-scoped Workbench Human Attention Inbox, digest flushing, retry/backlog/health/expiry escalation, required-sink execution gate, and acknowledgement-without-authority are implemented and documented. Production acknowledgement and dead-letter replay require exact verified signed-key/OIDC decisions. Packed two-process dispatch proves unique interruption delivery, zero success noise, metadata-endpoint SSRF refusal, event-only replay, and no source mutation. |
| Host-neutral Try | completed | Additive `try call`, `try explore`, and `try protect` reuse the named-capability and Scoped Explore/Protect runtimes; packed Workbench/generic-stdio/CLI parity and generated Cursor/Claude/Codex/generic configs pass |
| First-timer ad hoc Explore and Protect | completed | Built-in preflight, aggregate/exact-row controls, result-first Protect, blocked-state remediation, production absence, and packed no-plan-JSON PM journey pass across Workbench, CLI, and generic stdio. The owner-observation protocol remains the explicit post-engineering manual check. |
| Guided write-action authoring | completed | Public-DSL compiler, source-prerequisite validation, disabled artifacts, exact proposal preview, activation, resumability, Workbench wizard, live human/policy apply, retry, conflict, receipt/replay, and reviewed compensation pass through the packed FitFlow journey |
| Complete project generation and discovery | completed | Guided initialization stages every managed file and SQLite store, preserves `.env.example`, refuses conflicts before writing, and treats rescans as resume/reset. Nearest-project discovery, zero-authority `config init`, packed compatibility, and clean own-database installation pass. |
| JSON output, setup, lint, and recovery | completed | Mode-aware `writeback setup`, exact digest confirmation, no-DDL ledger mode, production plan-only behavior, naming-lint precision, one-document JSON failures, and recovery guidance pass the source and release gates. |
| Documentation and deep dive | completed | README/package README, help, security/threat model, release notes, operator guides, Workbench copy, examples, and the external technical deep dive now distinguish published 1.6.2 from verified unpublished 1.6.3 and document the full guided, OIDC, worker, drift, notification, and compatibility boundaries. |
| FitFlow, compatibility, packed, visual, and release verification | completed | Clean packed FitFlow first-command/read/aggregate/Protect/proposal/manual-and-supervised-apply/retry/conflict/replay/compensation, 39-resource large-schema, two competing workers/dispatchers, host parity, client configs, desktop/mobile visual gates, both compatibility baselines, live safety suites, package dry-runs, and the complete release gate pass. |

## Published And Local Baseline

Verified on 2026-07-24:

- local and npm `@synapsor/runner`: `1.6.2`;
- local and npm `@synapsor/spec`: `1.5.0`;
- local and npm `@synapsor/dsl`: `1.5.0`;
- npm `latest` and `next` agree for all three packages;
- `main` was clean and synchronized with `origin/main`;
- the feature branch was created before source changes.

## Untouched Baseline Verification

`corepack pnpm test`:

- TypeScript build passed;
- 46 test files and 727 tests passed;
- one test failed deterministically:
  `apps/runner/src/scoped-explore.test.ts` -
  `fails closed on excessive groups, repeated differencing, remote transport,
  and changed role posture`;
- the failure occurred because a successful call at line 276 already exhausted
  the reviewed differencing budget;
- the same failure reproduced with the scoped test file in isolation;
- this is baseline source evidence and must be fixed before release.

`corepack pnpm test:packed-backward-compatibility` passed against:

- `@synapsor/runner@1.6.0`;
- `@synapsor/dsl@1.5.0`;
- `@synapsor/spec@1.5.0`.

`corepack pnpm test:auto-boundary-explore:packed` passed:

- exact two-tool authoring surface;
- PM aggregate with five returned and two suppressed groups;
- source database unchanged;
- protected capability survived Explore shutdown;
- production omitted broad Explore;
- `tools/list` measured 6,325 bytes / about 1,582 tokens;
- first useful answer measured 10,673 ms after package installation;
- first protected capability measured 11,538 ms.

The packed gate proves the underlying 1.6.x architecture. It does not prove the
new first-timer Workbench UX because the script drives internal HTTP and MCP
operations programmatically.

## Canonical Decisions

- Preserve the exploration boundary as the normalized, digest-bound temporary
  local authoring authority.
- Keep each structured exploration plan as bounded runtime input, not a
  capability and not a generic query AST in the public Spec.
- Emit public DSL and canonical Spec only for protected named capabilities and
  guided write actions.
- An explicit empty canonical capability array represents a safe zero-authority
  review contract. This additive Spec behavior lets Workbench open when every
  inspected object is blocked instead of inventing a placeholder tool.
- Reuse the existing authoring MCP, Scoped Explore validator/executor, privacy
  machinery, Protect implementation, runtime, and stores.
- Workbench is a projection/editor over canonical managed inputs, never a
  second authority model.
- Existing projects, commands, contracts, normalized forms, digests, and
  `tools/list` remain compatible unless the adopter explicitly uses the new
  guided features.
- Scoped Explore remains local development/staging authoring only and absent
  from production/shared/remote runtime surfaces.
- Do not infer business write authority, approval, auto-approval,
  reversibility, tenant, or principal from schema structure.
- Under scope pressure: security and compatibility first, then classifier,
  one-command resumable value, review by exception, host-neutral Try/Protect,
  zero-manual-file onboarding, guided actions, and finally lower-priority
  polish.
- The measured packed golden path must reach the schema summary in at most
  sixty seconds, safe read in three minutes, PM aggregate in five, Protect in
  eight, and the first proposal in ten, excluding package download and database
  startup.
- One public `npx ... start --from-env DATABASE_URL` command must reach
  Workbench; no more than three shell invocations may be needed through the
  first proposal.
- Project discovery precedence is explicit CLI, documented environment, then
  the nearest valid project within the repository/home boundary. Explicit
  relative paths retain their previous caller-relative meaning.
- `try call` is a thin presentation layer over the same named-capability call
  function as `smoke call`; `try explore` and `try protect` call the existing
  Scoped Explore and Protect implementations rather than adding another
  authority or query engine.
- Human-attention events extend the existing authoritative proposal/runtime
  stores transactionally. The dispatcher and Workbench are projections over
  that state; webhook delivery, acknowledgement, and replay never become
  approval or mutation authority.
- Policy-backed proposals do not page a reviewer merely because their initial
  durable state is pending while deterministic policy evaluation runs. A
  successful auto-approval stays externally quiet; an actual policy fallback,
  freshness block, dead letter, UNKNOWN outcome, or reconciliation requirement
  projects the appropriate durable attention state.
- The first external integration is one secure generic signed webhook plus
  JSONL development output. Proprietary Slack/Teams/email adapters remain out
  of scope; operators connect those systems behind the generic event contract.
- The default dispatcher route is intentionally quiet. Informational success
  events are durable but suppressed externally unless a sink explicitly opts
  into all events or a digest. Related attention events share one incident,
  ordinary bursts batch at sink budgets, non-critical quiet hours are honored,
  and critical attention bypasses ordinary budgets while retaining an
  emergency ceiling and incident coalescing.

## Resume Instructions

1. Read this file and the current goal before changing code.
2. Check `git status --short --branch` and preserve unrelated changes.
3. Preserve the now-passing packed FitFlow first-command path; continue with
   its live guarded writeback and compensation coverage.
4. Complete the packaged approval-role guide and public-CLI OIDC/JWKS
   integration proof. (Completed.)
5. Complete the exact-digest supervised-worker path, then implement the
   transactional attention outbox, Workbench inbox, secure generic dispatcher,
   and optional healthy-sink execution gate over that authoritative state.
6. Complete JSON/recovery, release-wide documentation/messaging, versioning,
   compatibility, packed-manifest, and final release work.
7. Keep this table and verification log current after every coherent slice.

## Verification Log

- TypeScript typecheck passed after the initial classifier and Workbench slice.
- Focused Auto Boundary and sensitivity tests passed before the latest OpenAPI
  all-fields review correction.
- Workbench browser JavaScript is parsed by a real `vm.Script` test.
- `boundary-workbench`, `local-ui`, and `scoped-explore` focused tests passed:
  18 tests.
- The baseline differencing-budget fixture now uses independent test state and
  passes without weakening extraction or differencing enforcement.
- Typecheck plus 121 focused Spec, DSL, Auto Boundary, Workbench-renderer, and
  local-UI tests passed after the managed-review checkpoint.
- Human inference corrections now persist in
  `.synapsor/review-overrides.json`, are digest-bound in the generation lock,
  regenerate DSL/contract/tests/review files, invalidate prior Explore
  activation, and reset the journey to review.
- Ordinary narrowing and completed review confirmations persist in
  `.synapsor/boundary-review-progress.json`; reopening Workbench restores the
  candidate without schema inspection or artifact regeneration.
- Source-row authority remains zero when all resources are blocked. The public
  Spec now accepts a required but empty `capabilities` array, and both Spec and
  DSL regression tests cover this additive zero-authority form.
- Guided project creation now validates and stages config, MCP snippets,
  writeback/action plans, journey state, and the local SQLite store before
  committing any managed target. A conflicting target fails before another
  project file is created.
- Existing application `.env.example` content is preserved byte-for-byte except
  for an appended block containing only missing environment-variable names.
  Values are never copied from the process or generated.
- Reopening or explicitly rescanning an existing guided project no longer
  rewrites its Runner config, MCP snippets, `.env.example`, or local store.
  Fresh CLI initialization preflights managed targets before schema inspection,
  and rolls back a fresh Auto Boundary write if guided-project commit fails.
- Runner typecheck and all four guided-project regression tests pass after this
  checkpoint.
- Config/store discovery now works from nested directories without repeated
  flags, stops at safe project boundaries, rejects symlink/path escapes and
  conflicting config environments, and preserves explicit-path precedence.
  Five project-resolution tests pass.
- `config init` emits and validates a parser-valid read-only zero-authority
  config, uses environment-variable names only, and refuses overwrite. Config
  validation distinguishes ordinary zero-authority shells from generated
  lock-bound shells without inventing a capability.
- Additive project-aware `try call`, `try explore`, and `try protect` commands
  are implemented. Bare `try`, `try --prove`, `try --from-env`, and
  `smoke call` retain their established routes and output contracts.
- Runner TypeScript typecheck passes after the host-neutral Try slice.
- The first attention-outbox slice now projects proposal events into immutable
  redacted attention events inside the proposal transaction. Focused tests
  prove transaction rollback on outbox failure, cross-proposal review
  coalescing, acknowledgement without approval, quiet successful policy
  auto-approval, critical dead-letter attention, tamper detection, and exact
  supervised-worker lease fencing. Typecheck and the focused seven-test slice
  pass; the pre-slice full proposal-store suite passed 53/53.
- Workbench authority lifecycle transitions now produce durable events for
  review-required drafts, digest-bound activation, revocation, applied schema
  drift, and explicit sensitive-field exposure overrides. Field and resource
  names are keyed only by canonical fingerprints in the override event; the
  focused local-UI suite proves the payload does not contain either source
  identifier. Informational activation/revocation remains externally quiet,
  sensitive override remains attention-visible but non-immediate, and schema
  drift is one critical coalesced attention item.
- `corepack pnpm build` and the 21-test focused local-UI suite pass after the
  Workbench lifecycle-event integration.
- Notification configuration validates exact webhook/JSONL sinks, delivery
  routes, quiet hours, budgets, private-destination opt-in, and required
  supervision-sink references. Config has 38 passing focused tests.
- The dispatcher uses a minimal CloudEvents-compatible envelope, stable event
  and delivery identities, fenced at-least-once leasing, quiet default routes,
  coalescing/cooldowns, per-minute/hour budgets, HMAC request signing,
  timestamp/replay verification, HTTPS-only destination validation, DNS pinning,
  redirect refusal, bounded I/O/timeouts, and default SSRF denial for
  loopback/link-local/private/cloud-metadata destinations.
- `attention list/show/acknowledge` and
  `notifications status/test/dispatch/replay` are project-aware and have JSON
  output. Bare attention inspection selects the highest-priority item, so no
  proposal or attention id has to be copied for the common path.
- Workbench now contains a tenant/principal-scoped Human Attention Inbox and
  notification status. Acknowledgement explicitly remains separate from
  proposal approval or apply.
- Production and unknown-profile acknowledgement now require an exact,
  cryptographically verified operator decision. The proof binds the immutable
  attention key, severity, capability/digest, latest event, occurrence count,
  and timestamp-derived item version. A new related event reopens the incident
  and clears the prior acknowledgement instead of silently treating new work as
  seen.
- Verification after this checkpoint: Runner typecheck passed; proposal-store
  passed 61/61; notification dispatcher and CLI passed 9/9; Workbench local UI
  passed 19/19.
- Notification configuration and public JSON Schema validation pass 38/38
  tests. The dispatcher uses direct immutable-event lookup, stable delivery
  ids, fenced leases, versioned HMAC-SHA256 envelopes, HTTPS-only webhooks,
  pinned validated DNS addresses, redirect refusal, bounded response handling,
  and receiver-content ignorance. Focused notification/config/full-store
  verification passes 104/104 tests; monorepo typecheck and `git diff --check`
  pass.
- Full `apps/runner/src/cli.test.ts` passed on 2026-07-24: 125/125 tests in
  125.8 seconds, including nested project discovery for `try call --list`.
- Guided actions now use one server-side compiler over public DSL and canonical
  Spec. It persists disabled drafts, validates inspected source prerequisites,
  blocks incompatible auto-approval/reversibility/delete/quorum combinations,
  requires a real immutable proposal preview, and activates only an exact
  reviewed digest.
- The Workbench adds a resumable “Add a safe action” step with source-proven
  operation availability, field/type/bound controls, trusted-scope
  confirmation, approval and receipt choices, and no browser-owned authority.
- Focused guided-action, Workbench renderer, and local-UI suites pass:
  16/16 tests. Runner TypeScript typecheck also passes.
- `writeback setup` now previews or applies the exact runtime receipt migration
  according to receipt mode, requires an explicit development/staging profile
  and exact digest, uses a separate setup credential for precreated source
  receipts, performs no source DDL in runner-ledger mode, and keeps production
  plan-only. Focused setup tests pass.
- The full source suite passed after the setup slice: 52 files and 779/779
  tests, plus license/content, DSL-source, and Cursor-plugin checks.
- Workbench now labels `app.explore_data` as temporary local authoring
  authority, keeps Explore active through guided action authoring, then offers
  one primary action that disables Explore and opens the outside-model proposal
  review console. Focused Workbench and local-UI routing tests pass.
- Added the live PostgreSQL + Next.js + Prisma FitFlow fixture with separate
  organization-analytics, trainer-reader, guarded-writer, and setup roles.
  The fixture is healthy; organization RLS shows 22 in-tenant check-ins and 30
  members, trainer RLS shows only 15 assigned members, and the three planted
  payment/address/medical fields classify as high-confidence sensitive.
- Added deterministic friendly aggregate authoring for CLI Try. `try explore
  --suggested` needs no plan JSON; explicit reviewed flags support count,
  count-distinct, sum, average, grouping, time buckets, filters, top-N, and one
  reviewed relationship. The helper's three tests and full typecheck pass.
- Added the repository-owned `docs/agent-guided-setup.md` source and package
  copy configuration. It contains the public prompt, no-secret rules,
  stop-at-human-authority behavior, resume procedure, Try path, MCP setup, and
  task-first recovery guidance. The packed gate confirms that the guide and
  FitFlow fixture are present in the install artifact.
- Fixed generated-authority runtime compatibility so existing compiler marker
  `1.6.0` and the current `1.6.3` marker are accepted explicitly; unknown
  compiler versions still fail before database inspection.
- Guided action preview and activation now retain separate read/write
  credentials, carry reviewed PostgreSQL RLS tenant/principal session settings,
  and support both legacy and result-envelope-v2 proposal identities. The
  model-facing preview remains proposal-only and source-unchanged.
- `corepack pnpm test:guided-onboarding:packed` passes from a clean packed
  install against live FitFlow PostgreSQL. One public `start --from-env
  DATABASE_URL` invocation reached Workbench and completed the measured path
  with no manual files and no source mutation:
  - schema summary: 2,522 ms;
  - first safe read: 3,890 ms;
  - PM aggregate: 4,601 ms;
  - protected named capability: 5,241 ms;
  - first immutable guided proposal: 12,172 ms.
- The packed path proves high-confidence payment/address/medical exclusions,
  organization and trainer RLS packs, suppression, no silent named-tool
  activation, exact-digest Protect/activation, Explore shutdown, protected-tool
  survival, non-destructive resume, and the four-part boundary comprehension
  summary.
- The live FitFlow schema now contains 39 reviewable resources, exercising the
  realistic 30-50-table onboarding target. The packed journey still passes:
  schema summary 2,521 ms, first safe read 3,944 ms, PM aggregate 4,704 ms,
  protected capability 5,369 ms, and first proposal 12,403 ms.
- The existing 40-table scale gate passes with only the two bounded authoring
  tools advertised: 6,359 serialized bytes and about 1,590 estimated tokens.
- The rewritten 1.6.3 visual gate passes across desktop, mobile, light, dark,
  keyboard, loading, empty, blocked, partial, stale, failure, long-name,
  unresolved-field, ambiguous-identity, and 40-table states. Manual inspection
  found no overlap, hidden primary action, or dense-matrix regression.
- The packed FitFlow gate now executes the same reviewed PM aggregate through
  secured Workbench, generic stdio using the official MCP SDK, and CLI Try.
  Their bounded data, suppression, digest, and result-size metadata are
  identical. Generated Cursor, Claude, Codex, and generic snippets use the same
  two-tool authoring command and contain no secrets or trusted-scope values.
- `corepack pnpm test:mcp-client-configs` passes. Current installed Claude Code
  2.1.219 and Codex CLI 0.145.0 accept the documented stdio configurations;
  all shipped MCP recipes parse, safety-scan, and expose semantic tools only.
- The packed FitFlow journey now also proves the complete trusted write path
  against live PostgreSQL: runner-ledger setup performs no source DDL; a human
  approval applies once; a terminal retry produces no duplicate mutation;
  one bounded proposal is policy-auto-approved; the next low-risk proposal
  falls back to human review when the daily count/value budget is exhausted;
  an out-of-band version change fails closed as a conflict; receipts and replay
  preserve the result; and a reversible freeze is undone only through a new,
  separately approved compensation proposal.
- Fixed two bugs found by that packed proof. Nested guided-action drafts now
  rebase pre-existing contract paths relative to the nested preview config,
  preserving multi-action projects. Compensation proposals preserve the
  original trusted principal scope rather than substituting the operator who
  requested the revert.
- Fixed runner-ledger decoding for protocol-v4 compensation intents. The
  persisted operation allowlist now includes `restore_update`,
  `remove_insert`, and `restore_insert`; a regression proves a compensation
  job can be claimed, read, and advanced to `applying`.
- The current packed timings, excluding npm download and database startup, are:
  schema summary 3,277 ms; boundary activation 3,527 ms; first safe read
  5,970 ms; PM aggregate 8,868 ms; protected capability 10,025 ms; first guided
  proposal 19,484 ms; and first guarded apply plus the complete identity matrix
  103,289 ms.
- Added a packaged `Approval Roles And Verified Operator Identity` guide and
  localhost-only synthetic RS256 issuer. The guide's marked
  `operator_identity` JSON is parsed directly from the packed tarball and used
  by the integration, preventing configuration drift.
- The packed public-CLI identity proof rejects missing and similar roles, bad
  signatures, unknown keys, expired and not-yet-valid tokens, wrong issuer and
  audience, unsafe subjects, malformed roles, missing expiry, short
  attestation key material, and unavailable JWKS. Every refusal leaves the
  proposal pending, records no successful approval, and leaves PostgreSQL
  unchanged.
- A valid key-1 token with the exact `membership_reviewer` role records the
  verified provider, subject, role, issuer, key ID, algorithm, exact proposal
  ID/version/hash, decision hash, attestation, and integrity hash. No tested
  bearer token appears in project text or SQLite bytes.
- The reviewer token is refused at apply. After overlapping a rotated key, a
  separate key-2 token with `writeback_operator` performs the guarded apply.
  Replay contains the independent `writeback_authorized` event and receipt.
  Direct ledger corruption of the stored proof and copying a valid proof onto
  another proposal are both rejected before source mutation.
- Supervised execution now has a persistent, integrity-hashed operator control
  state. Exact signed decisions can pause, resume, drain, enable or disable one
  capability/digest, irreversibly revoke a digest, and cancel an unleased job.
  Claim and pre-apply paths enforce that state; queued work is preserved rather
  than discarded. Focused exact-digest, fencing, control-revision, concurrency,
  and CLI dual-opt-in tests pass.
- Supervised workers now use the same canonical guarded-apply implementation as
  manual apply. The worker carries its exact fenced lease into apply, rechecks
  capability/digest/deployment eligibility and required sink health, renews
  immediately before source execution, retries only proven non-commit transient
  outcomes, and sends UNKNOWN outcomes to reconciliation instead of guessing.
- Notification digests are now durable, idempotent ledger events rather than
  parked rows. Due informational activity is folded into one redacted summary;
  component events remain immutable and traceable, repeated incidents remain
  coalesced, sink reminder and immediate-informational budgets are enforced,
  and critical reconciliation bypasses digest mode. Typecheck and the focused
  dispatcher, CLI, attention, and proposal-store tests pass.
- The Trusted Worker Workbench projection is now filtered by the verified
  tenant/principal scope before queue metadata is constructed. Exact pause,
  resume, drain, capability/digest, cancellation, dead-letter requeue/discard,
  and queue views remain outside MCP; another tenant's proposal ids and failure
  state are absent from both list and action routes.
- Workbench reconciliation now delegates to the established live-source
  inspection and signed operator path. It returns only classification, field
  names, member counts, and digests, binds confirmation to the exact intent and
  supported outcome, re-inspects before resolution, and atomically closes a
  matching worker reconciliation item. Focused Workbench, store, and typecheck
  gates pass.
- External retry escalation is quiet by default: ordinary retry attempts stay
  in the ledger and Workbench, only the configured escalation threshold creates
  one delayed interruption, and later attempts do not create notification
  storms. Recovery messages require an explicit per-sink opt-in.
- Required-sink supervision now distinguishes execution gating from human
  interruption. A missing or unhealthy required sink holds automatic writes
  immediately, but a critical worker incident is raised only after the
  configured sustained-health duration; recovery resolves the same Workbench
  incident.
- Queue backlog attention uses configured age/depth thresholds, groups work by
  capability, digest, and trusted scope, creates one evolving warning, and
  resolves when the queue drains. Coalesced approval items likewise remain open
  until the last proposal in the exact role queue is no longer pending, then
  resolve and reopen for later work. Focused store, notification, worker CLI,
  and typecheck gates pass.
- Supervised execution now enforces the reviewed proposal TTL and current
  policy count/value ceilings atomically at lease time, including concurrent
  leases and conservative reconciliation accounting. Apply rechecks the exact
  policy snapshot, conditions, limits, TTL, and generated-authority lock
  immediately before mutation. Focused config, store, and typecheck gates pass.
- Hardened supervised workers now bind execution to a live non-secret database
  role/grant/RLS posture fingerprint. Source-receipt mode requires an explicitly
  named precreated table; the runtime writer may hold only the selected target
  operation and receipt privileges, may not own relations, and must satisfy
  effective configured RLS. Unavailable, widened, privileged, or changed
  posture leaves work queued before lease and creates one coalesced critical
  `credential.posture_changed` item. The same verification repeats after lease
  before guarded apply. Workbench exposes only safe status, fingerprints,
  counts, and reason codes. Focused config, CLI, Workbench, and typecheck gates
  pass.
- Approved supervised proposals now enter one deterministic pre-expiry warning
  window (10% of their reviewed TTL, bounded to 60-3,600 seconds). Repeated
  scans create one event/attention item, the payload grants no authority, and
  cancellation or terminal queue movement resolves the same item. Focused CLI
  and typecheck gates pass.
- The immutable automatic-approval policy snapshot is now regression-tested
  directly: changing either its aggregate limits or qualifying rule after
  approval raises `SUPERVISED_WORKER_POLICY_STALE` before any receipt or source
  effect.
- Two separate Node worker processes now contend on one file-backed SQLite
  ledger under an execution-time count limit. Exactly one obtains a fenced
  supervised lease; the other proposal is atomically blocked with
  `SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED`, and neither process creates a
  receipt in this lease-only proof.
- `corepack pnpm test:guided-onboarding:packed` passes after extending the
  packed FitFlow journey through supervised execution. The public v2 result
  reports `queued_for_trusted_execution`, policy approval, and that trusted
  writeback/apply remains separate. Two competing worker processes apply the
  policy-approved proposal exactly once; a separately human-approved proposal
  is also applied by the worker; the next proposal falls back to review when
  the reviewed policy circuit is exhausted; and an out-of-band source-version
  change becomes a supervised-worker conflict without overwriting the row.
  One receipt and one worker claim are recorded for the contested successful
  proposal. Current packed timings, excluding package download and database
  startup, are: schema summary 2,716 ms; boundary activation 2,858 ms; first
  safe read 4,223 ms; PM aggregate 5,885 ms; protected capability 6,555 ms;
  first proposal 14,704 ms; and first guarded apply plus the complete identity
  and worker matrix 92,209 ms.
- `corepack pnpm test:fleet` passes against live PostgreSQL and MySQL. The
  canonical worker core produces one effect under competing consumers,
  recovers without duplication after forced termination before source write,
  during the open source transaction, and after source commit, and preserves
  explicit dead-letter requeue/discard history. The same run proves shared
  runtime-store batch authority, two-person quorum, bounded source-pool
  saturation, and backup/restore/retention.
- The full source test stage passes 55 files and 839/839 tests under bounded
  four-worker concurrency and 20-second test/hook timeouts. License/content
  and DSL source-path checks also pass. The final Cursor-plugin check exposed
  stale `1.6.2` plugin metadata; all plugin package, MCP pin, README, and
  command references were advanced to `1.6.3`, after which
  `corepack pnpm verify:cursor-plugin` passed with no embedded secrets or
  authority.
- A focused shared-ledger regression now proves two review-required proposals
  coalesce across separate `PostgresProposalRuntimeStore` instances, one
  notification delivery round-trips through the shared store, tenant filters
  hold, and acknowledgement changes neither proposal approval nor receipts.
- Corrected the staged public package graph to Runner `1.6.3`, Spec `1.6.0`,
  and DSL `1.6.0`. Generated authority accepts the legacy `1.5.0`/`1.5.1`
  compiler markers and the new `1.6.0` marker explicitly; unknown markers
  still fail closed. A focused seven-file compatibility slice passes 265/265
  tests, including exact legacy normalization and digest fixtures.
- Guided action activation now appends only the required writer environment
  variable name to the generated `.env.example`. It never copies the
  credential value and rolls the file back if activation fails. The focused
  guided-action slice passes 13 tests.
- Proposal expiry now moves the corresponding pre-expiry attention item to the
  explicit `expired` state, updates its title to `Approved proposal expired
  without execution`, and preserves the immutable event history. Applied,
  cancelled, and refused terminal events resolve the same item instead of
  creating a new interruption.
- The visual release gate now seeds real open, acknowledged, resolved, and
  expired attention states and captures them on desktop plus the open inbox on
  mobile. Worker controls have accessible names, the inbox exposes a status
  selector, and all 14 screenshots pass title, overflow, duplicate-id,
  labeling, authority-separation, and source-of-truth checks. Manual inspection
  confirms the corrected expiry title and readable desktop/mobile layouts.
- `corepack pnpm build` passes after the package-version, guided-action,
  attention-lifecycle, Workbench-accessibility, and documentation slices.
- The expanded visual release gate now verifies review-required, retry
  escalation, dead-letter, UNKNOWN, reconciliation-required, sustained
  supervision-sink failure, and queue-backlog incidents in one coalesced
  Workbench inbox. Open desktop/mobile plus acknowledged, resolved, and
  expired views pass DOM, accessibility, overflow, and authority-boundary
  assertions. Manual inspection confirms that the seven open incidents remain
  readable at both viewport sizes.
- The final source-suite rerun passes 55 files and 841/841 tests after the
  terminal attention-state correction. The previously timing-sensitive signed
  Streamable HTTP session and cross-process SQLite writer-contention tests
  both pass within the bounded 20-second test/hook ceiling. License/content,
  DSL source-path compatibility, and the packaged Cursor-plugin check pass in
  the same command.
- Notification dead-letter replay now requires an exact verified signed-key or
  OIDC operator decision plus a bounded recovery reason. The decision is bound
  to the delivery id, sink, immutable event, attention item, status, attempt
  count, error, and update timestamp. Requeue and a redacted immutable
  `notification.replayed` audit event commit atomically; approval and mutation
  state are unchanged. Focused config, CLI, and proposal-store verification
  passes 110/110 tests.
- The packed FitFlow journey now includes two competing notification
  dispatcher processes against the same SQLite ledger. It delivered two unique
  coalesced human-review interruptions, delivered no proposal/approval/queue/
  retry/apply success noise, redacted trusted scope and credentials, and did
  not redeliver on a second pass. A synthetic JSONL sink test remained free of
  database data.
- The packed webhook proof refused `169.254.169.254` before transport, recorded
  `NOTIFICATION_DESTINATION_BLOCKED` as a durable dead letter, then required a
  fresh verified OIDC decision to requeue only that notification. The source
  PostgreSQL snapshot was identical before and after dispatch/replay. Current
  packed timings, excluding package download and database startup, are: schema
  summary 3,271 ms; boundary activation 3,485 ms; first safe read 5,743 ms; PM
  aggregate 8,357 ms; Protect 9,709 ms; first proposal 20,530 ms; and the full
  identity, guarded-write, worker, and notification matrix 147,961 ms.
- Final packed compatibility gates pass against both the published Runner
  1.5.4/DSL 1.4.4/Spec 1.4.2 baseline and the Runner 1.6.0/DSL 1.5.0/Spec
  1.5.0 baseline. Packed Auto Boundary/Explore passes after explicitly
  reviewing the fixture's `owner_id` principal binding rather than weakening
  its RLS boundary. Guarded CRUD, bounded-set, reversible, proposal-freshness,
  database-scope, principal-scope, and generated MCP-client live gates all
  pass.
- The final full source suite passes 55/55 files and 843/843 tests, followed by
  license/content, DSL source-path, and Cursor-plugin verification.
- `corepack pnpm publish --dry-run --no-git-checks` passes independently for
  `@synapsor/spec@1.6.0`, `@synapsor/dsl@1.6.0`, and
  `@synapsor/runner@1.6.3`. The Runner tarball is 1.6 MB compressed, 7.2 MB
  unpacked, and contains 305 files including the four new operator/onboarding
  guides and both packed fixtures.
- The clean Runner install gate now distinguishes pre-release and registry
  verification. Before Spec 1.6.0 exists on npm it installs the locally packed
  public Spec tarball beside Runner; once that exact Spec is published it
  automatically returns to Runner-only registry resolution. This exposed and
  resolved the expected publish-order `ETARGET` without weakening the packed
  manifest assertion.
- `./scripts/verify-release-gate.sh 1.6.3` passes uninterrupted after that
  correction: 428/428 selected release tests, current Claude/Codex/generic MCP
  client checks, the Docker first-run proof, public checkout commands, local
  Runner, packed Runner, packed own-database live Postgres apply, license/
  content, no phantom handler package, Runner publish dry-run, and
  `git diff --check`.
- After writing the final handoff and release-order note, the Runner package
  rebuilt successfully, packaged Markdown links remained valid, the
  license/content check passed, `bash -n scripts/verify-packed-runner.sh`
  passed, and the final worktree diff remained whitespace-clean. No external
  service action was performed.
