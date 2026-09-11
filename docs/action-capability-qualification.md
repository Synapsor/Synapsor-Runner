# Action Capability Qualification

This is an evidence inventory, not a claim that onboarding is complete or that
arbitrary SQL/business logic is supported. Last updated: 2026-09-11.

Current bounded qualification: Gate 1 authoring lifecycle reliability PASSED
on source commit `d018290f9d5ca0444ecceaf3c7dc29442f8913c4`, branch
`codex/tui-safe-action-control-plane`. The user subsequently accepted Gate 1 and
authorized the bounded Gate 2 qualification below. This is not a
release-readiness or unaided-onboarding claim. Pinned R12 and original acceptance
projects are unchanged.

**Gate 2 stopped with a FAILED / INCOMPLETE qualification result.** Both fresh
model-guided cases failed Read mapping. Assisted recovery did not complete either
operational journey. No Gate 2 execution, receipt, concurrency or live rule-edit
pass is claimed. The result below distinguishes product failures from tester
cancellation and untested work. Gate 1 acceptance remains unchanged.

Historical public student evidence was based on `a4a720af8df051125ac26e4875eafacbcadce4f9`.
Its last completed public test used CLI SHA-256
`31616b6d832e6cffd1cf1c115cffea3e15506d958b48d3b5a6d2b1c1d62dee65`.
The full Luna completion and live rule-edit evidence below used the preceding
`15227986a28788a0b563b1808b64f769af5ec349ee1b4150061388425b5a7f4d` executable.
Those earlier executables are not the current Gate 1 artifact.

## Latest Public Qualification

### Current Checkpoint

#### Gate 2: Frozen Artifact And Public Qualification

Gate 2 authorized 2026-09-11; stopped with the report below, no public pass claimed. Starting
commit `b955c836b70553347785a8050dbf26493144375b`, clean tree. Product source
remains `d018290`. Before selecting any new cases, verify actual authoring
provider/client calls and freeze the complete installed Runner, local pre-release
Spec and transitive dependencies. Preserve the package lock and content manifest,
not just the CLI executable hash. Evidence: existing external
`r13-e07-20260911/gate2-b955c83/`; the existing generalization tracker owns progress.

Declared envelope: PostgreSQL 17, exact reviewed tenant/principal scope under
supported ENABLE/FORCE RLS, non-owner/non-bypass roles, validated immediate FKs
including composite relationships, one stable identity and maintained integer
conflict counter per mutation target. Scoped Read projections/analysis and opaque
references; one exact UPDATE or atomic two-to-four UPDATE effects; private related
facts and immediate inverse-FK complete collections with bounded typed predicates
and count/sum/min/max. Explicit overall and trusted-scope rolling automatic limits,
human fallback only for valid requests, separate Read/Action/execution reviews,
generated narrow writer requirements, explicit local test identity and worker.
Record the actual receipt mode; do not relabel ledger receipts as source receipts.

Excluded before selection: arbitrary SQL, DELETE, mixed-operation transactions,
bulk effects, composite-only mutation identities, arbitrary/hidden RLS collection
predicates, unbounded aggregates, unsupported calendar conversions, unproved
version maintenance, external side effects and real production session integration.
No envelope changes to turn a failed selected case into a pass. No saved authority,
injected draft JSON or internal activation in the public setup journey.

Two previously unused policies/layouts were selected only after freezing;
one must be structurally different. Test real four-tool execution, receipts and
independent readback, refusals, human review, private values and analytical uses,
concurrency, same-client edits/add/remove and pending-request behavior. Record all
questions, repeated questions, reviews, retries, detours, setup/edit time and
administrator/developer assistance. Failures remain failures; no automatic
capability expansion or repair loop. This gate is not a universal support claim.

Prerequisites verified: Node 22.22.2, Docker 29.5.2, Claude Code 2.1.268 with
an actual `claude-opus-5` response and an observed neutral MCP ping; Terra
returned HTTP 200 and the required function through Responses. Two initial
probe requests used incompatible Chat Completions defaults and failed HTTP 400.
This was test-harness assistance, not a Runner defect: Runner already uses
Responses. These failures are retained; the neutral ping is not Runner runtime
qualification. No policy, database rows or credential values were sent by these
prerequisite tests.

Complete installed artifact frozen **2026-09-11T19:29:43.990Z**, before choosing
either case. Runner 1.8.0, local Spec 1.11.0 and all transitive packages: 7,569
file/directory/symlink entries, with file bytes, modes and symlink targets recorded.

| Frozen evidence | SHA-256 |
| --- | --- |
| Canonical complete installed-tree manifest contents | `38cc0e0621bf29000f071b7cf6d66c2b26d96da6a79005503d429303de8feab4` |
| `installed-artifact-manifest.json` | `d71209b09f222b35e1714ae06b6e28cf9fba2b4328a32596dc78cc6f2cc9053a` |
| `installed/package-lock.json` | `be1139da587e9cfebabc6de1c2c9c46014f973159592212e8792cf4ab846efde` |
| `installed-artifact.tar.gz` (entire installation) | `df2788145966b076a8adfd7d6bd1f232b0ca540f2ca9cee5291dc4e2f8d55a86` |
| Local Runner tarball | `135672cabe598cac477026afd2849e7f0947ec7a2062b24f56974e00867bb141` |
| Local pre-release Spec tarball | `27cfef8a1f3d85e8897b5da378e50518e67e69facfced6b566b7731c8376f12e` |

The manifest also records the Node executable hash and source commit. The only
uncommitted repository change at freeze was this qualification documentation.
`freeze-artifact.mjs --verify` rechecks the entire installation without changing it.

Cases selected **after** freezing, 2026-09-11 19:32 UTC:

- Editorial production release: publisher/editor scope, an embargo and rights
  clearance, and atomic manuscript publication plus final-review completion.
  Private routine classification separates automatic approval from a production
  reviewer. Initial rolling caps: 6 overall and 2 per trusted publisher / 24h.
- Insurance portfolio reserve adjustment: active claim/portfolio, no active
  freezes, and a complete current active-claim reserve total after the proposed
  change within the portfolio cap. This is a different parent/inverse-collection
  layout, not another two-record release. Initial automatic caps: 8 overall and
  3 per trusted insurer / 24h, plus an explicit routine ceiling.

These specific policies/layouts were absent from the prior qualification/tracker
search. Each original policy, schema and fixture was fixed and hashed before
its first public provider run. The planned later policy edits were not reached.
Both cases remain unqualified; actual failed/incomplete evidence follows.
The complete frozen installation is shared read-only by convention and checked
for drift; each case has an independent disposable database, project and evidence.

##### Gate 2 Results

Product source remained `d018290`; qualification started at `b955c83` and the
prerequisite/freeze documentation was committed as `2f6e12c`. No product repair,
fixture narrowing, installed-file change, injected authority or new protocol was
introduced during this gate. Both agents used the actual public CLI with Terra.
Claude Opus and MCP connectivity were verified only in the neutral prerequisite
test, not through either unfinished Runner client journey.

| Check | Editorial Release | Insurance Reserve Adjustment |
| --- | --- | --- |
| Original policy/layout frozen before its first provider call | PASS: 19:38:07.106Z | PASS: 19:40:55.715Z |
| Fresh model-guided setup | FAIL: empty admitted scope/catalog; initial and one retry refused Read clarification | FAIL: same initial and retry refusal |
| Same-project public scope recovery | ASSISTED: three exact disabled scope/privacy reviews | ASSISTED: two exact disabled scope/privacy reviews |
| Saved Action | One disabled atomic publication/final-review outcome | Four partial components, zero completed Action revisions |
| Final recovery result | INCOMPLETE: tester cancelled during streaming policy checks | BLOCKED: final resume could not establish complete child scope for private freezes |
| Complete privacy/coverage and authority review | NOT COMPLETED | NOT COMPLETED; broad disabled freeze workspace remains a privacy concern |
| Writer review/application, rescan, execution review and worker | NOT RUN: recovery was cancelled before setup completed | BLOCKED before completed Action |
| Generated persistent four-tool client and eligible execution | NOT RUN | BLOCKED |
| Runtime receipts plus effect readback, invalid refusals, human review | NOT RUN | BLOCKED |
| Raw/analytical privacy, cross-scope and changed-private-fact tests | NOT RUN | BLOCKED |
| Same/different-target races, rolling limits and duplicate handling | NOT RUN | BLOCKED |
| Same-client limit edit, add/remove behavior, old pending request after edit | NOT RUN; no edit-time metric available | BLOCKED; no edit-time metric available |
| Safe pause and persisted work, without activation | PASS, bounded snapshot evidence | PASS, bounded snapshot evidence |
| Independent backup restore and unchanged source rows | PASS: all 60 rows match original hashed fixture | PASS: all 40 rows match pre-provider baseline |

The last two rows do not prove runtime isolation, effect correctness or operational
readiness. Both stores have only management active pointers, zero active database
authority, and zero proposals, approvals, receipts, observed references, query
audits and worker jobs. Editorial has one current disabled Action outcome (two
stored revisions of its bundle), not two business outcomes. Insurance has none.

Original policy SHA-256:
- Editorial: `6c8d8a259f5ae1b8c54425fa784dbcc9af4a34a945c908908a4b4ea16592df2d`.
- Insurance: `31cf8412c3cde34fa57341762ddb878c427d2363e1c0a53435e40ee3a5607875`.

Original schema SHA-256:
- Editorial: `9570270ba98be264e6690506a8ce3478bc3eef584b3d7ca37c261a919477ea67`.
- Insurance: `54e8debabb1493534bcb5153e0b7b208a2fb31623994b6cf411efc055078876a`.

##### Observed Failures And Evidence Limits

Both original attempts displayed `READ_WORKLOAD_CLARIFICATION_REFUSED` with
`clarification_request.resource must be one exact reviewed catalog resource.`
Exact public metadata simultaneously showed effective two-identity ENABLE/FORCE
RLS, but no tenant/principal candidates and no included resources. The operator
chose separate customers, not whole-organization access. The Read failure details
still labeled the offered retry as attempt 1 and did not expose the failed raw
arguments. The reports retain the two visible failures without inventing internal
correction counts or blaming model capability.

Read-only source inspection identifies the reusable mapping boundary:
`auto-boundary.ts` uses `rankedScopeInference` / `rlsExpressionSupportsScope`,
which still gate RLS role suggestions through known column/setting conventions.
`guided-start.ts::reviewUnresolvedOrganizationScope` offers model review of coded
ownership but returns the organization mode, not a reviewed existing-column
mapping. `read-workload-model.ts::parseReadClarificationRequest` can then reject a
question outside the admitted catalog. The documented public `boundary review
resource --include --tenant-key ... --principal-key ...` path accepted the same
existing columns after exact review. This supports a mapping/orchestration defect;
it does not establish an unsupported enforcement engine. No extra column-name
allowlist or permission relaxation was added as a qualification workaround.

Insurance's final ordinary resume ran validation before another input prompt.
The model reported that it could not establish `freezes` as a complete, explicitly
child-scoped inverse collection. Its final catalog corroborates derived scope via
the full parent FK, without a direct reviewed child identity. The low-level
compiler error was not exposed; the model's explanation is not independently
treated as an engine verdict. All four components were checkpointed, but the
host's `/details` correctly said the question had not changed a saved Action.
Calling the draft "prepared" earlier did not make it ready. The intermediate
disabled freeze workspace also included private fields for selection/analysis;
it needed narrowing before any activation. This is an unresolved privacy review,
not an observed data leak. The no-active-freeze requirement was never removed.

Editorial's assisted run did save the atomic Action. After one business answer,
the tester observed four policy-check episodes (63s, 62s, 55s and 15s), then pressed
Esc while output was still streaming. **This was a tester stopping decision, not
a proven loop, provider timeout or final validation refusal.** The saved coverage
changed between two snapshots, despite matching draft/context digests. Continued
completion was not tested. Earlier informal descriptions of a "stall" are not
the qualification verdict. Later runtime work is untested because of cancellation,
not a demonstrated runtime failure.

The preserved editorial coverage also classifies Terra drafting as unsupported
against the runtime-client interface and asks for a read-only credential already
used for inspection. These are concrete interpretation/evidence concerns, not
established causes of the cancellation. The owner counter-maintenance promise
was present, but its exact host confirmation had not been reached. A further
**case-selection caveat** is retained: the original editorial prose specified
database-origin current UTC, whereas the declared envelope promised trusted
evaluation time. The exported draft uses `transaction_time`; clock-origin
equivalence was not established. The wording was not changed after freezing,
and this caveat does not explain the earlier empty-catalog failure.

##### Friction And Assistance

| Observed measure | Editorial | Insurance |
| --- | --- | --- |
| Initial public CLI time | About 191s | 157.869s |
| Assisted recovery CLI time | About 374s before cancellation | 179.953s plus 102.725s final resume |
| First launch through final pause | About 14m04s | 11m34.098s |
| Business answers after initial failure | One manuscript-reference meaning answer | One repeated portfolio-reference definition already in policy |
| Manual disabled mapping reviews | Three, with typed exact digests | Two, with typed exact digests |
| Model retry after initial failure | One | One |
| Additional navigation | Two detail views, manual-editor detour, revalidate, final Esc | Two failure detail views, manual-editor detour, revalidate, two Action details, help, pause and extra resume |
| Runtime authority confirmations and completed edits | Zero | Zero |

Times include operator inspection/coordination, not provider latency alone. Total
provider requests/tokens and unseen internal correction counts were not captured.
Both policies supplied engineering-level column meanings, identity/RLS roles,
maintenance guarantees and deployment instructions. Fixture creation, attaching
those documents, reading CLI help, manually enumerating privacy fields, entering
scope-review flags/digests and diagnostic inspection are assistance, not unaided
onboarding. Neither result meets the CEO's few-step operational standard.

Harness mistakes are retained separately: initial prerequisite transport misuse;
one editorial PostgreSQL bootstrap readiness retry and CLI option/output-path
corrections; one insurance evidence-collector array-decoding correction. None was
a product repair, a source-policy change, or passing runtime evidence. Public
revalidation referred to a "changed database" after disabled local mapping edits;
the database schema and rows were unchanged. Renewed metadata consent is counted
separately from repeated business meaning.

##### Evidence, Reproduction And Stop

Durable evidence root:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/gate2-b955c83/`.
The original policies, schemas, fixture scripts, complete frozen installation,
launch arguments, raw terminal/timing logs, exact public exports, local checkpoints,
sanitized diagnostics and final case reports are preserved there. Credentials,
database dumps and ledgers remain outside Git with owner-only permissions.

- `editorial/RESULT.md` and `sanitized-actual-diagnostics.json` distinguish initial
  failure from tester cancellation; `launches.jsonl` records public commands.
- `insurance/RESULT.md`, `public-invocations.jsonl`, final public resource reviews
  and `final-control-state.json` record the separate collection/privacy blocker.
- `parent-final-evidence-audit.json` independently rechecks all 7,569 installed
  entries, Node, lock, package/archive hashes, unchanged original fixture files,
  read-only control stores and inactive runtime counters.
- The parent actually restored both editorial dumps and the insurance dump into
  an isolated no-network disposable PostgreSQL server. All 60 editorial rows
  matched the original hashed schema/fixture; all 40 insurance rows matched their
  pre-provider baseline. Restore success is evidence durability, not an MCP effect.

Editorial final dump SHA-256:
`f78b80f22a184e75ca29f1f3a626da3f662d0d1e7a252f0a881398ea1228d7e2`.
Insurance dump SHA-256:
`68bdd187a8abc64d473a809392abfb0948f36538dc40a588503cf4516a27afa9`.
Read-only installation recheck:
`node <evidence-root>/freeze-artifact.mjs --verify`.
Durability/state audit:
`node <evidence-root>/final-evidence-audit.mjs` (creates/removes only its labeled,
no-network restore fixture). Public setup replays must restore the owned case
database first and use the preserved original inputs and recorded commands;
the stopped project must not be reset or silently replaced by a generated draft.

Final audit at **2026-09-11T20:07:59.177Z** passed. Only the two case containers
and the parent's restore container were removed. All 57 preexisting container
IDs remain; both test agents and their sessions are closed, with no owned worker,
client or qualification process left running. Frozen tree hash is unchanged.

Stopping point: **Gate 1 accepted; Gate 2 fresh onboarding FAILED and full public
qualification INCOMPLETE.** Remaining work is separately scoped: mapping/admission
and truthful recovery diagnostics; private collection scope/coverage propagation;
editorial interpretation/clock-origin questions; then the unrun deployment/runtime
and edit matrix. No runtime safety conclusion or universal support claim follows
from checks never reached. A later repair requires its own bounded authorization,
new frozen artifact and the audit's new unseen evidence, with these cases retained
as regressions. No automatic expansion or additional repair loop was started.

#### Consolidation Milestone: Gate 1 Only

The resumed assignment (2026-09-11) is bounded to existing authoring lifecycle
reliability. Starting commit: `1ef96d954709b3cd2c3563e767ea189ac4b0d194`.
Preserved paused changes include execution-intent negation, policy lifecycle
context, clarification recovery and the saved-action helper/tests. Gate 2,
new domains and feature expansion are deferred until separately requested.
The UX reference guides this CLI's decisions, reviews and recovery; it is
not a second feature checklist. Gate 1 is PASSED; implementation stops here.
The preserved uncommitted baseline consisted of execution-intent source/tests,
policy coverage source/tests and evidence context, command orchestration, this
qualification document, and saved-action helper/tests. Relevant repairs were
integrated rather than discarded. No parallel job ledger, patch language or
authorization protocol was introduced.

Ownership and focused diagnosis:

| Information | Existing owner and recovery | Assessed result |
| --- | --- | --- |
| Current disabled Actions | Action authority draft; selected disabled replacement precedes the same named active revision | Reproduced: normal resume recovered only stale dependencies, so current separately saved outcomes disappeared from model review. Two new public orchestration cases failed before the helper integration and pass after. Explicit removal remains respected. |
| Unfinished intents and partial model components | Existing resume action agenda/checkpoint | Preserved separately from saved outcome inventory. Initial integration incorrectly intercepted the one-shot continuation after a Read edit; the existing parity tests caught it and the corrected path passes. |
| Accepted business context and counter commitments | Conversation, policy-source interpretations, top-level reviewed version fields and scoped prerequisite answer records | Host-scoped decision IDs and separate applicability are integrated. Exact current policy references and inspected source/subject scope govern reuse; legacy prose is context only. Actual host tests cover paraphrase reuse, changed requirements, unrelated edits, missing references, stale proof and failed/no-op saves. |
| Clarification versus revision | Existing coverage check, cache identity and disabled edit operation | Earlier fix retained. Added checks for clarifying a disputed counter interpretation and provider failure: no Read/Action edit or active-authority change. |
| Draft and resume storage | Governed transaction/revision checks plus atomic resume-file replacement | Seven actual storage failure/restart/concurrent-save cases pass. No storage defect or new ledger. A public orchestration defect WAS reproduced: a saved Action followed by a failed resume/delegation save reported misleading status and could proceed to review. It now pauses with the exact saved revision. Restart reconciles stale pending edits only after an explicit current-revision choice; competing drafts are protected. |

Development evidence (existing external `r13-e07-20260911` evidence directory):
`gate1-current-actions-before.log`: 2 reproduced failures;
`gate1-current-actions-after.log`: 26 selected tests passed;
`gate1-preservation-integrated.log`: 335 passed, 3 continuation regressions,
1 existing skip (failed run retained);
`gate1-preservation-parity.log`: corrected 36 selected tests passed.
Focused selection exclusions are not unavailable checks. Storage integration:
56 passed across four files, no skips. These are controlled-provider/host tests,
not first-time-user or real-model qualification. Stable results follow below;
the failed intermediate runs have not been replaced or counted as passes.

Current combined regression: `gate1-combined-lifecycle.log`, 27 PASS (217
unselected), including eight actual scoped-answer host sequences and 18
post-commit/clarification neighbors. The compound sequence starts with active
Read/Action and two separately confirmed counters, interrupts a saved job,
clarifies a disputed window without editing, changes only the account limit
3 -> 1, rescans and resumes twice. The same one Action, private dependency,
counter confirmations and separate unanswered intent survive. Active records
are byte-for-byte unchanged. One operator clarification, zero repeated answers,
zero repeated counter confirmations, one three-turn structured limit edit;
no model re-planning or manual-editor detour. Controlled inspection is used in
this compound; it is not live writer provisioning evidence.

Separate real PostgreSQL 17 integration: generated narrow writer grants and
scoped RLS policies are reviewed/applied in an owned disposable empty fixture,
then the public rescan and two resumes revalidate the private Action dependency.
One live test passes; active Read remains exact, Action remains disabled,
business rows and model-drafting calls are zero. Evidence and generated SQL:
`r13-e07-20260911/manufacturing-qualification-agent/gate1-storage-public/`.
The initial fixture's single-argument `current_setting` was outside the existing
repair grammar; failed attempts remain evidence. The successful fixture uses
the existing supported `current_setting(setting, true)` shape. No parser,
policy or enforcement rule was weakened to make it pass.

Scoped helper/model/resume/consent coverage: 257 PASS, no skips. The parent
intermediate run `gate1-integrated-host.log` had 509 PASS / 1 FAIL / 1 existing
skip while the unrelated-RLS regression was being added; retained as a failed
iteration, not final qualification. Initial final typecheck found a test-only
parameter-index error, now corrected and included in the passing stable gate.
Execution-intent negation is committed as `1d0410a` and pushed only to private
backup after 29 focused tests passed. The complete bounded implementation is
committed as `d018290` and pushed only to private backup.

##### Stable Gate 1 Results And Artifact

Source commit: `d018290f9d5ca0444ecceaf3c7dc29442f8913c4`.
Source tree: `b780a1a952f6e6d18701f8fecc8e9e79d380ecc4`.
The working tree was clean throughout the stable test and installed-package
checks. The subsequent qualification update changes documentation only.

| Check | Stable result | Durable evidence |
| --- | --- | --- |
| Whole-tree types, tests, dependencies and packaging | 5,821 PASS / 446 environment-gated SKIP; 283 test files passed / 20 skipped; exit 0 | `gate1-final-full.log` |
| Compound saved-job lifecycle and eight actual scoped-answer host sequences | Included in the passing whole-tree run; focused combined run 27 PASS (217 unselected) | `gate1-combined-lifecycle.log`, `gate1-lifecycle-complete.log`; regressions in `apps/runner/src/boundary-cli.test.ts` |
| Actual governed storage, restart, conflicting saves and uncertain retry | 7 PASS in the stable run; SQLite, filesystem errors and independent child processes, not mocked storage | `gate1-final-full.log`; `control-policy-authoring-storage.integration.test.ts` |
| Actual writer setup, rescan and two resumes | 1 PASS / 0 SKIP, PostgreSQL 17; 7.048s in stable run | `gate1-final-full.log`, `gate1-rescan-*`; `boundary-writer-rescan-postgres.integration.test.ts` |
| Clean packed install with local pre-release Spec | PASS, exit 0; public declarations, launchers, fixtures and managed client install/status/uninstall preservation | `gate1-packed.log` |
| License/content, public command surface, source paths, Cursor plugin, bundle freshness and six launcher shutdown cases | PASS within whole-tree gate | `gate1-final-full.log` |

The 446 skipped tests include other opt-in database, real-provider, delegation
and runtime deployment cases whose environments were not enabled. They are not
fresh passing evidence. The required Gate 1 live rescan case was explicitly
enabled. The packed check uses local `@synapsor/spec@1.11.0`, not proof that this
pre-release Spec is available from the public registry. No package was published.

SHA-256 of the tested/rebuilt package entrypoints:

| Artifact | SHA-256 |
| --- | --- |
| `apps/runner/dist/runner.mjs` | `edba1f0b1265caf60506308e9e6f6d4bf83a9c96b1a4cda06418f62c0c245bde` |
| `apps/runner/dist/authoring.mjs` | `b82d745464b0e275993266d6eff074f4e0752a69117e75e8166a3f9d5b177116` |
| `apps/runner/dist/runtime.mjs` | `3b352535fe52c59ed5a545659f18fa31c7c3bc3f8b736a07a70c7f11585b9a00` |
| `apps/runner/dist/shadow.mjs` | `5fa8c286ad426a72e67f0d4b0c034f0cb4056c15110267f91d6b368d3f504ed6` |
| `apps/runner/dist/cli.js` | `fd5383c5bd241f7c1f917ee548bc679b00a188ebeac0f117ac3e6224a7ea6acc` |

Evidence root on the qualification host:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/`.
Reproduce from the source commit with Node >=22.13, pnpm and Docker available:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  SYNAPSOR_TEST_BOUNDARY_WRITER_RESCAN_LIVE=1 corepack pnpm test
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC=1 ./scripts/verify-packed-runner.sh
```

The live test creates and removes its own labeled empty database. It reviews
generated narrow writer grants/RLS using an administrator credential owned by
the fixture. It does not request a production credential, alter an existing
tutorial, read business rows or grant an agent authority. The cleanup check
found no remaining `synapsor.test=gate1-writer-rescan` containers. Existing
recovery projects, policies and older containers were preserved.

##### Measured Friction And Remaining Scope

Controlled successful lifecycle: two existing counter confirmations before
interruption; one clarification with no configuration change; one approval-limit
edit with three structured provider turns; zero repeated accepted answers or
counter confirmations; zero model re-planning, manual-editor detours or lost
saved outcomes. The independent unfinished intent stays explicitly unanswered.
Scoped-answer host cases distinguish a reused business answer from renewed
metadata consent and semantic review: unrelated policy edits reuse the answer,
while changed relevant requirements require a new decision. A stale proof is
refused before another model transfer/review, not converted into trusted proof.

Failure recovery is deliberately not zero-step: after an acknowledged Action
save and failed follow-up save, one checkpoint-only retry is allowed, then the
flow pauses with the saved digest. A stale pending edit requires inspection and
an explicit keep-current or edit-current decision. No automatic merge, repeated
model edit or silent competing-revision overwrite occurs. A failed/no-op answer
save does not report confirmation or trigger further drafting; asking again on
restart in that case is necessary, not loss of an acknowledged saved answer.

Engineering intervention: fixtures, deterministic model responses and failure
injection were authored by engineers. The live fixture had seven development
attempts (five failed, two passed before the stable run), including correction
to the already supported RLS expression shape. This is internal qualification,
not an unaided operator completion score. Failed iterations remain evidence.

| Category | Remaining status |
| --- | --- |
| Selected lifecycle defects | No unresolved defect in the qualified sequences; current/stale saved inventory, explicit removal, clarification, limit edit, failed follow-up saves and rescan pass. |
| Interpretation / metadata | Legacy unscoped prose is not auto-confirmed. Missing references, genuinely changed meaning and unavailable current proof still require evidence or a decision. Arbitrary prose extraction completeness is not established. |
| Unsupported capability | SQL/RLS/effect envelope unchanged. Unsupported repair grammar and broader business operations are not made supported by these tests. |
| Deployment prerequisites | Writer setup, trusted identity, explicit publication and worker readiness remain independent requirements. Unanswered historical advising limits and absent real credentials remain unresolved outside this milestone. |
| Runtime safety / receipt limits | Four runtime tools and existing validators unchanged. Authoring tests do not prove cross-process runtime request idempotency or universal safety. Existing receipt modes, duplicate handling and already-dispatched work limitations below still apply. |
| Untested combinations | New real-model/first-time-user journeys, new domains, arbitrary concurrent conversation-only edits and all possible multi-store interleavings are not qualified. |

**Gate 2: PENDING, not started.** Broader unfamiliar-schema qualification and
feature expansion require a separate request. UX-reference ideas beyond this
milestone, including a new persistent workspace layout, expanded behavior
previews and new deployment modes, remain later work. No background agent or
test continues this assignment after the Gate 1 report and private backup.

#### Earlier R13 Checkpoints (Historical)

2026-09-11 16:05 UTC: paused at the operator's request, not complete. Parent
coded/radio CLI sessions exited without changing authority; both agents
confirmed their sessions closed with no workers or clients running. No parent
worker, build or test remains running. Preserve all uncommitted changes and test
projects. Resume checkpoint outside git:
`../Progress docs tracking/r13-generalization-20260911.md`.

Committed `1ef96d954709b3cd2c3563e767ea189ac4b0d194`, backed up privately,
passed the full gate: 5,734 tests / 446 optional skips, types, packaging and
launcher checks. Its frozen `candidate-mCo99N` executable SHA-256 is
`14c62fd06473502645a9b59ac2f8ab611d900eadfd39fed36f85b892c9b9cbad`.
Subsequent uncommitted negated-proposal-only fixes passed 134 focused tests /
one existing skip. New lifecycle evidence and conversational coverage recovery
passed type checking but still need their focused regressions and public runs.
Current saved-action recovery helper tests passed 23 cases in isolation;
parent integration is pending. None of this establishes final-artifact or
unaided onboarding completion. Original student and unfamiliar-schema public
journeys still have unresolved review/correction failures.

2026-09-11 15:33 UTC: the generic clarification-before-revision change passes
358 integrated CLI/coverage/resume/conversation tests with one existing skip,
plus Runner type checking. A clarification that resolves a mistaken concern
does not invoke Read or Action editors. A failed recheck retains the same
disabled draft and active authority, with a visible retry diagnostic. Genuine
changes still receive separate validation after their revision. Coverage-cache
identity now includes the saved clarification history; exact deployment-profile
evidence does not attest to production authentication or waive explicit controls.
Public coded recovery and final-artifact qualification remain pending.

Garden public recovery on `ca836d7` / `candidate-9MfvPL` reached generated writer
administration, separate authority reviews, managed Claude setup and a real
atomic assignment/offer update. The tester reports independent two-row readback,
50 privacy checks, human review and refusals. Canonical applied receipt:
`b58f4dc4098d99fbd3bac55b3d4232c4c8e63c7545d8df33fb44f0e21969da2c`.
The same-client limit edit is still underway. This is assisted recovery on the
preceding frozen artifact, not final-tree or unaided onboarding qualification.

2026-09-11 15:04 UTC: host counter-review persistence and ordinary-field
naming correction pass the integrated 583-test suite / 2 existing skips and
Runner type checking. Four public-CLI harness cases cover unchanged atomic
drafts, cancellation/resume, declined review and failed second-counter saves.
Active Read/Action and the business rule remain unchanged in these cases;
failed persistence cannot become positive coverage evidence. These are
metadata-only CLI regressions, not database effect evidence.

The full 83-case Read-mapping suite passes. The new ordinary-field correction
cases failed before the fix; a bounded model retry now uses already approved
operator context, preserves the complete workload and still rejects invented
quotes. Genuine ambiguous meanings remain operator decisions. Next: isolate
this executable and resume the saved public garden, coded and student cases.
The coded environment-classification/routing defect remains open; no overall
completion or final-artifact runtime pass is claimed.

2026-09-11 14:38 UTC: `49e2f8f` is backed up privately; isolated
`candidate-uA19Ni` executable SHA-256
`569ac3ca872e2f1d29d7c8aff4ff46a506f1733acf7f7cb7a545b058b34e0c29`.
Its stable full gate passed 5,674 tests / 446 optional skips, types and
package/launcher checks (`49e2f8f-full-gate.log`). This is not qualification
of the subsequent working tree or a complete public journey.

Garden resume exposed host counter confirmations being discarded with a no-op
model revision checkpoint. Separate durable host records and exact current
metadata evidence are in progress; external-writer behavior remains unproved.
Renamed library resume now proves RLS-only customer scope and activated its
reviewed Read. Coverage then incorrectly treated "development fixture" as a
requirement to change the `staging` configuration enum, even after an explicit
operator clarification. It is paused with Read active, Action/execution off.
A radio review fixture, selected after uA was frozen, exposed repeated ordinary
field-meaning questions during fresh public intake. Its Read mapping remains
unactivated. Both failed runs are retained, not counted as successes. Original
student public recovery and all final-artifact runtime checks remain pending.

2026-09-11 13:55 UTC: student older-Read recovery, inspected RLS coverage
evidence and actionable policy diagnostics are integrated. The combined
CLI/resume/chat/coverage/scope suite passes 484 tests / 1 existing skip; separate
writer integration passes 29 tests. Type checking passes. The recovery-menu
regression failed before its context was made visible and passes in this run.
The new scope proof is bound to the exact Read, Action catalog, current schema
and non-bypass reader posture. It distinguishes RLS-enforced private principal
scope from projected columns, without claiming authentication wiring, arbitrary
business eligibility or write readiness. Swapped identities, broad ALL policies,
type drift, stale locks and unrelated Action sources remain unproved/refused.

Garden public setup on scX passed the two separate existing-counter confirmations
and reached Read review. Exact public details confirmed private IDs, counters and
service classifications unavailable for both values and analysis. This used
operator maintenance attestation, not proof of arbitrary external writers.
The next frozen artifact still needs public student/coded recovery and final
runtime qualification. The prior municipal canonical applied receipt is
`sha256:b49965d03518b79536cadb1109c579c0c127e0db808656cc4611b2dc444f8778`;
its worker result hash is a different artifact. Durable municipal RECOVERY-01
records the full same-client edit, preserved pending work and measured friction.

2026-09-11 13:45 UTC: `f7d5164` is backed up privately. Frozen
`candidate-scXzLp` executable SHA-256
`c4045bccff71c1afa566fb6c794a51807838a1dcd37dc85f405956d4367099e6`.
The stable full gate passed 5,587 tests / 446 optional skips, type checking,
dependency/license checks and package/launcher checks. This predates the next
student recovery and inspected-scope evidence changes; it is not a final-tree
qualification. Durable log: `r13-e07-20260911/f7d5164-full-gate.log`.

Municipal public recovery on scX reached generated writer provisioning, separate
Read/Action/execution review, managed Claude setup and a completed N-101 change.
An actual Opus client observed the receipt; independent owner readback found
only that record changed. The same connected four-tool SDK client remained
connected through a public organization-limit edit from 2 to 1 (overall 8
unchanged). Fresh valid requests then required human review; prior approval
history counted, and the prior receipt and pending human request were preserved.
The edit required one explicit retry after a coverage diagnostic. This is
assisted recovery, not an unaided fresh-onboarding pass. Final sanitized agent
evidence and reproducible checks are being consolidated.

Student recovery on the prior `93fb317` passed private-admission source review
but stranded saved actions bound to the older disabled Read revision. Generic
resume and access-edit inventory now retain that exact dependency for fresh
recompilation, without treating it as active or reusable authority. Two new
regressions failed before the fix; the expanded CLI/resume/private-source suite
passes 279 tests. A separately saved unfinished action remains pending. Public
student retesting and integration with the inspected-RLS evidence repair remain
required; no advising limits have been invented.

A new two-table garden-exchange fixture was chosen after scX was frozen. Its
fresh public setup retains a required atomic assignment change plus offer
consumption. It exposed repeated meanings, a provider failure and confusion
between an owner-reviewed counter-maintenance prerequisite and independent
proof of all external software. Existing exact counter review is being tested
for both records. No garden authority, writer or source effect is enabled yet.
All original projects, policies and pinned builds remain untouched.

2026-09-11 13:08 UTC: the combined naming/review/writer repair passes 403
focused tests and type checking. Fourteen live PostgreSQL writer-policy tests
also pass, including a public-role inspection to generated-policy to scoped
UPDATE regression. A missing private principal-column annotation can now be
recovered only from one exact inspected two-identity policy over reviewed
fields; ambiguous, custom, restrictive or changed-type policies still refuse.
No field name or tutorial table selects this behavior.

Missing table/field meanings are checked before activation is offered. The
model can repair them using previously supplied meanings without changing
permissions; partial repairs are refused. Failed activation now refreshes the
chat's own exact saved review binding, so subsequent revision does not mistake
its own signoff for someone else's edit. Concurrent edits remain rejected.
These are implementation passes; coded and municipal public recovery on the
next isolated artifact remains required. Student public recovery is using
`93fb317` / candidate-sAKtQ9, executable SHA-256
`0b8f2967af35ae64ffa96b59f6274304e3f4384268627c5342cfd75e6789000c`.

Manufacturing evidence correction: the earlier B1 worker result hash is not
the canonical execution receipt hash. Read-only verification recomputed B1's
canonical applied receipt as
`sha256:8e7c1c45d8912ff3781b9ead17d3a965d62759168df9fb1674a0fd540f58968f`
and the later failed mutation-race receipt as
`sha256:49cfd0c5be58ca4abe2277905c297858c0ed7585604361ee73b8e142bc5a6eca`.
The original worker result hashes and verifier mistakes remain in the durable
RECOVERY-04 report. No pre-edit canonical receipt byte snapshot was captured;
byte-for-byte before/after preservation is not claimed.

2026-09-11 12:43 UTC: commits `040ac98` and `d8bae39` are backed up privately.
Frozen `candidate-FQ51HU` executable SHA-256
`4a527edec8c7234c72539c3627505c8c58b8f0a8a23a8f6fe55aa0b75ee0f4d0`.
Both coded and municipal saved jobs recovered their owner-confirmed existing
conflict counters. Exact Read details verified internal identifiers, counters
and classifications unavailable for raw return and all analysis. Municipal
Read/Action activation succeeded; generated writer repair now reports missing
column-to-identity mappings. Coded activation correctly refuses missing table
vocabulary, but drafting/recovery failed to resolve that known meaning before
review. Both failures are retained as generalization regressions, not passes.

Student private-source recovery now loads current saved Action dependencies,
including older disabled Read bindings, and freshly revalidates their metadata,
source, scope and guard proofs. History is not used as authority. Exact consent
and pre-save guards reject concurrent dependency changes. Generic helper,
consent and complete CLI suite: 276 passed; types passed. The host regression
exercises the actual private-review callback and confirms declined metadata
review leaves saved and active authority unchanged. Public student recovery on
the newly integrated artifact is still pending; advising limits remain unknown.

Manufacturing agent reports FQ same-client rule-edit checks passing, including
old-request refusal, a fresh above-threshold human review and duplicate-request
serialization. Historical approvals were checked against unchanged semantic
selectors despite generated identifier churn. A combined private sample
insert/update/delete race produced a failed receipt with zero source effect.
This is assisted qualification, not three independent mutation races or an
overall completion claim; final sanitized evidence is being consolidated.

2026-09-11 12:15 UTC implementation checkpoint: explicit existing-counter review
and resume integration passed 456 tests / 1 optional skip; the final role-drift
addition passed in a 23-case counter suite. Types passed. Coded and municipal
jobs are both paused at the same missing-mapping defect in the frozen binary;
the follow-up must be tested through those public jobs. No source rename, writer
grant or public-field exposure is used to repair a counter selection.

The duplicate-request repair passed 309 distinct focused runtime/store/MCP tests.
It serializes matching subject requests sharing a store object and rechecks every
waiter's authority, scope, reference and inputs. It is not cross-process identical
request idempotency; separate-store competing requests still retain uniqueness
and automatic-limit enforcement. Unexpected MCP failures retain only a bounded
operator error category, not raw messages, arguments or credentials. Frozen
artifact and actual connected-client retest are still pending.

2026-09-11 11:55 UTC: `6f28649` is committed and backed up privately. Frozen
`candidate-gJxM04` executable SHA-256
`6d70286bc0bbd0d7a527e383908dba9fe2bab95eef23155dbdffdd6615612486`.
Manufacturing recovered the missing structural evidence, completed public writer,
execution and Claude setup, and applied B1 once with worker result hash
`sha256:4a6b646e62fd8e50814b64a1cfbe0ed068bc01bcb9b8320c0bbc6fc5f78f1c94`.
Independent owner readback found only B1 released, version 2. B2 required human
review; failed-sample, insufficient-sample and already-released requests refused.
Eighteen protocol privacy/scope/injection checks passed. A concurrent identical
request pair instead produced one generic failure and one approval; a real-store
regression reproduced duplicate approval admission. Narrow shared-path repair is
under way. The subsequent 50-to-30 rule edit hit a provider failure twice and is
saved pending; no edit/runtime-change pass is claimed. Worker stopped, B5 queued.

Coded recovery no longer fails checkpoint persistence, but cannot map the
owner-documented `c09` counter because inspected name suggestions omit it. A
generic explicit counter-review operation is being implemented and tested;
integer shape alone never establishes maintenance or authority. Coded setup was
paused with no authority. Student private-source recovery remains in progress.

A further unseen municipal-notice schema/policy was selected after this freeze
and provisioned in an owned PostgreSQL container. Public fresh onboarding is in
progress. It repeated the documented opening-time meaning and authenticated
person setting; both are recorded as friction, not an unaided qualification.
No municipal authority or source change yet. Durable evidence stays under the
external `r13-e07-20260911` directory; original projects and policies unchanged.

2026-09-11 11:33 UTC: final-action retirement fix `acd63fc` is backed up privately.
Frozen executable `a1310a7bd08f17f44454fb7985301c6a776e556cac263942e609b836bdb723e9`
(`candidate-KBDw2N`) passed the actual library same-connected-client sequence:
four tools unchanged, empty Action discovery after public deactivation, Read
still succeeds and new requests return `SEMANTIC_ACTION_UNAVAILABLE`. Requests,
receipts and source changes were not rewritten; the worker was already stopped.
The harness first looked for error.code instead of documented error_code;
the captured five responses passed a corrected read-only verifier. Both the
failed harness report and verification remain. Client artifact was upgraded
before connecting; its configuration did not change during retirement.

The coded public run failed checkpoint persistence after a supplied symbolic
identity explanation. The exact sentence reproduces a false positive in the
private-material guard ("tenant is the trusted ..."). A narrow descriptive
sentence fix preserves concrete-value/credential refusal, and checkpoint errors
now retain their sanitized underlying category. Regression shows refused private
checkpoint data is not saved; a corrected checkpoint survives normal resume.
Resume/removal/CLI integration: 249 passed; types passed. This is not yet a
successful coded public recovery. The removal panel heading is also corrected
from a generic Read review title to Removal review.

Manufacturing MF-03: authoring had omitted inspected UNIQUE/CHECK facts. Exact
source constraints now accompany current reviewed Read/Action sources only,
bound to the generation lock/schema. Nullable, partial, stale and missing proof
remain explicitly limited or refused. No authority schema or runtime permission
changed. Sidecar focused suites: 336 passed / 2 existing skips; current combined
package is building, public recovery pending.

Student recovery on `38b2349` still fails private-admission scope proof because
saved Actions reference an older disabled Read digest and their private evidence
is absent from the correction context. Refusals preserve the saved drafts. The
generic recovery path is under investigation; no student runtime pass or invented
advising policy is claimed. Original projects and policies remain untouched.

2026-09-11 11:09 UTC: `38b2349` is committed and pushed only to private backup;
its frozen executable is `8b85ed8783bfd4004b46ccfd76e62046b008b83cddc50be9662da1346f6a969d`
in durable `candidate-yUqQWI`. Public museum final-action removal succeeded
through explicit deactivation and retained Read/client/history. However, the
already-connected older client returned `EXPLORE_INTERNAL` after deactivation.
The initially-active runtime skipped the dynamic activation wrapper. The
follow-up uses that wrapper for both initial states, retains reference context,
and still fails closed for missing/corrupt active dependencies. Full focused
CLI/removal/runtime group: 265 passed; typecheck passed. Public retest pending.
Removal also now presents its exact permission panel and returns to guided
navigation instead of a manual-editor detour.

The full integration run recorded 5,453 passes, 445 optional skips and one
failure: its worker loaded the old removal module while the test was edited to
expect the new details panel. The current focused run passes, but that mixed
source run is NOT a final qualification. Rerun the pipeline on stable source.

Manufacturing recovery preserved private ordering/collection evidence and
activated Read/Action, but public rescan after authorized writer administration
now reports missing uniqueness despite an inspected full-key UNIQUE constraint.
Execution remains off; generic constraint-evidence recovery is under investigation.
The renamed/coded library case is in fresh public onboarding. It repeated source
meanings already supplied in the policy, then requested a legitimate explicit
review of the distinct trusted person binding. No coded authority is active yet.
The original student, unfamiliar complete-collection operation, further fresh
journeys and final-artifact gates remain open. This is not overall completion.

2026-09-11 10:49 UTC implementation follow-up: private verification-only fields
now have exact coverage evidence, including all public Read and Action uses;
nonexistent pointers and exposed fields still fail validation. Minimal rule edits
retain already reviewed fields needed only for deterministic collection ordering.
Read-only corrections bind to the current disabled revision, revalidate dependent
Actions before publication and retain unfinished agenda/checkpoints. Own-save
refresh is separate from refusal of a competing saved revision.

The public museum removal test found that final-outcome removal still fell into
an unsupported-empty-bundle error and manual editor. Guided removal now offers
separate exact deactivation, preserves Read/client/history, supports pause/resume,
and checks the full Action baseline under the publication lock before revoking.
It does not create empty authority or undo dispatched/completed transactions.
Focused integration: 181 passed / 1 optional skip; final-removal CLI continuation
passed separately, including cancellation and resume. Types and package build
passed. The full pipeline is running; live recovery on this follow-up is pending.

2026-09-11 10:26 UTC: latest frozen candidate is `9fcc942615213687169b4ced439dce6bb72610c4`,
executable SHA-256 `01220968ed4d1d60bd7f467fff0ecc508f02872e56f8eb6bcda2ace90a5a9397`.
It is committed on the existing branch and pushed only to private `backup`.
The following supersedes the older public checkpoint entries, which remain
historical evidence. This is still assisted qualification, not final acceptance.

| Public journey on this artifact | Result and remaining limits |
| --- | --- |
| Library live limit edit | One ordinary-language edit lowered only automatic limits to 2 overall and 1 per library in 24 hours. Public review retained privacy, eligibility, fallback and execution. New P-105 correctly needs human review. P-104, approved under the old rules but not dispatched, remains queued with zero attempts and an explicit changed-rules blocker. P-101 remains the sole completed change and receipt. |
| Museum setup recovery and operation | Saved policy recovered without weakening it. Generated exact writer instructions, owned administrator application, public rescan, separate authority reviews, managed Claude installation, explicit local test identity and worker startup passed. Actual Claude completed EX-104 at 80 lux and replayed the identical request without a tester hint to obtain durable execution confirmation. Independent fixture-owner SELECT found only that row changed, version 2. Other valid requests required two reviewers; an in-storage exhibit was refused. |
| Museum live policy edit | One plain-language edit added a 75-lux automatic ceiling, retaining the private ceiling, hard bounds, quorum, scope, limits and execution. EX-105 at 80 now needs human review. The generated Claude configuration is byte-for-byte unchanged; no client reinstall or new tool was needed. |
| Privacy and protocol negatives | Actual generated SDK connections passed 14 library and 13 museum checks: four tools, scoped reads, private raw/filter/sort/group refusals, injected SQL/identity and forged-reference refusals. The library old approved request cannot be resubmitted under the new authority. No new write or permission was introduced by these checks. |
| Fresh student | Blocked after two disabled Actions. A Read correction encountered stale revision handling, and the unfinished advising component disappeared from the continuation view. Approximately 676 seconds with assistance, no active authority/client/worker or completed operation. Generic correction/checkpoint repairs are in progress; advising limits remain unanswered. |
| Manufacturing protected collection | Blocked by privacy-coverage references to a resource absent from public Read, and an edit exporter dropping a private field used only for deterministic collection ordering. Exact typed private evidence and dependency-preserving export fixes are under test. No completed operation or generalization pass. |

Museum receipt: `sha256:4337f2437e74b2def97b72bf1241431d25d253c65fb805fde4178290c57aabc1`,
applied once at `2026-09-11T10:03:08.418Z`. Status replay now explicitly confirms
verified execution, without returning private identifiers or adding a tool.
The first museum test request mislabeled 120 lux as eligible despite a private
100-lux ceiling; its human-review result was correct. The subsequent eligible
case used 80. Both workers were stopped gracefully; pending requests remain.

Durable evidence: external `r13-e07-20260911/library-edit-terminal.log`,
`library-after-limit-edit-client.jsonl`, `library-worker-after-edit.json`,
`library-runtime-readback.json`, `museum-recovery-terminal.log`,
`museum-rescan-terminal.log`, `museum-eligible-client.jsonl`,
`museum-edit-terminal.log`, `museum-stricter-rule-client.jsonl`,
`museum-runtime-readback.json`, and both `*-after-edit*-protocol.json` reports.
Client JSONL files are private raw evidence, not shareable credential dumps.
Setup required administrator assistance and recovery; timing includes separately
recorded model calls, navigation and tester pauses, not a claimed unaided duration.
Museum same-connected-client removal is being tested. New unseen/coded cases,
student completion, remaining lifecycle cases and final-artifact gates are open.

2026-09-11 public follow-up on `231d589`, frozen executable
`15dd2e7ac3310a405b8e4cc814c0be05e8276c10d4687076d8187de2c6fd9a2a`:
the owned library recovery now passes generated writer administration, public
rescan, preserved private dependencies, separate Read/Action/execution review,
managed Claude Code installation, private test identity, four-tool handshake
and foreground worker startup. The generated grants/policies changed no source
rows. Actual Claude Opus 5 used all four tools. P-101 was automatically approved,
executed once with receipt 1, and independently read back as collected/version 2;
other rows stayed unchanged. P-102 required human review and expired P-103 was
refused. No original project or policy was modified.

This is assisted recovery, not fresh unaided completion. The first Claude request
did not discover status replay and stopped at approval plus source readback.
An explicit tester hint to repeat the identical call returned the recorded
completed result without another proposal. The working follow-up adds status
replay guidance and a private-value-free durable receipt confirmation, with no
new tool or authority. Runtime retest of that follow-up remains pending.
The follow-up's focused/CLI regression passed 314 tests with one optional skip;
type/package build and trusted-core dependency checks passed (368 modules,
1948 internal edges). These checks do not complete the public qualification.

The further unseen museum fixture was selected after the same freeze. Fresh
Terra drafting reached review with correct private fields and two-reviewer
fallback, but its overall counter selected the entire bundle instead of the
requested outcome. A public model correction fixed that selector and preserved
the rest; repeated coverage-link correction and a fixed-four-tool-interface
coverage concern still blocked activation. No museum authority was enabled.
The working follow-up retains the rejected coverage submission during bounded
correction and supplies explicit supported-interface evidence, without claiming
client installation or permitting unsupported effects. Manufacturing recovery,
museum completion, fresh student, unfamiliar edits and final artifact gates
remain unfinished. Full transcripts, fixture policies and owned projects are in
the durable `r13-e07-20260911` external directory. Library worker was stopped
gracefully after testing; the valid human-review request remains pending.

2026-09-11 follow-up: shared PostgreSQL scope proof now supports trusted-setting
UUID casts only against inspected native UUID columns. Writer handoffs record
and recheck those types; Read collection preflight and runtime use the same
grammar. Unknown casts, swapped settings and extra predicates remain refused.
Focused suite: 133 passed; real PostgreSQL handoff/collection/concurrency suite:
27 passed; full CLI plus Action-draft reviews: 251 passed. Types/build passed.
The live rescan regression fixture was completed with an explicit full-key FK:
its prior private source had neither direct reviewed scope nor a proven parent,
so its old setup was correctly refused. This is a test-fixture correction, not
relaxed source proof. No original acceptance fixture was edited.

The writer and collection public recovery tests on this follow-up are pending.
Manufacturing diagnostic resume on the PREVIOUS frozen build did produce a valid
Read mapping and protected-collection Action without a business-policy edit.
It then stopped at UUID collection preflight and an unresolved policy-coverage
check about sample constraints/counter selectors. The initial repeated-question
root cause remains unconfirmed; new diagnostics preserve sanitized original and
repeated questions plus available links for future recovery. Do not represent
that diagnostic improvement or eventual remapping as a confirmed root-cause fix.
All public sessions exited gracefully, preserving saved work. Library Read and
Action are active only in its owned fixture; execution/client/worker remain off.
Manufacturing has one disabled Action. Conference has not begun onboarding.
The whole setup/edit/runtime qualification is still incomplete.

2026-09-11 E-07 checkpoint: `91cfb03` was committed on the existing branch and
pushed only to the private `backup` remote. Its full local pipeline passed:
5,399 tests, 443 optional skips, type/dependency checks, packaging and bundle
freshness. This is an implementation checkpoint, not completed qualification.

Frozen executable `5aea505b1ec2759eab75325944bee032064bb2e594f4902620fc85888703fc4c`
was captured before selecting new library-collection and manufacturing-release
fixtures. The latter has a structurally different private complete inspection
collection. Source and runtime snapshots, policies, terminal logs and owned
projects now live in durable external storage, not only `/tmp`:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/`.

The library fresh public CLI/Terra attempt failed before activation. It prepared
the rule and privacy settings, then classified missing dedicated-writer setup
as unfinished business drafting. Asking to proceed opened "Choose what to
revise" rather than the writer handoff. The operator paused safely; no active
authority or source change occurred. The roughly ten-minute attempt also
repeated an explicit Claude Code choice. It has no client/worker/runtime success.
Exact records and friction notes are in `library-run.md` beside the transcript.

The follow-up now provides typed execution-setup evidence for compiled supported
effects, retaining writer review, execution consent and worker startup as
unverified later stages. Unsupported effects and unresolved business/privacy/
approval requirements cannot use this category. Client preference can accompany
the existing model plan; the host retains it through the saved job. Focused
checks: 166 passed, one optional skip; all 284 CLI/chat/resume tests passed,
as did types, dependency checks and packaging. The CLI regression reaches review
without an extra business edit or repeated client choice. Real-model recovery
tests now include frozen `8d68988` executable
`f376e16a5bc0eb46d233029283205b5b1faa682c83bbae6e0f7319fd2d47ff46`.
Library recovery reached explicit Read and Action activation with correct private
fields, but the writer handoff refused its UUID-cast scoped filters. No grants,
execution, client or worker were enabled. It also asked a staging clarification
and a redundant follow-up about leaving Read unchanged. Manufacturing fresh
mapping and its bounded retry both stopped at
`READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED`; the actual question was missing
from diagnostics. Those are failures to investigate, not successful journeys.
A further unseen conference meal-preference case was chosen after this freeze
and provisioned, but has not run. Both failed/recovered projects and terminal
logs remain in the durable external directory. Do not count only repaired known
fixtures as generalization.

No original project/policy was changed. Advising limits remain unanswered;
OpenRouter live qualification still lacks a credential. Continue independent
work without inventing either. The full student journey, unfamiliar operations
and same-client edits, then final-artifact gates remain incomplete.

Post-reboot update: PUBLIC40 finished with correct private admission mapping,
21 privacy changes, two preserved Actions and separately reviewed Read/Action
activation. Two generated administrator handoffs were applied to the owned test
database. Reader rescan succeeded, but continuation lost the third action's
partial components and compiled the prepared actions against a public-only
catalog, refusing the private supporting resource. No positive execution or
receipt was reached. The durable external PUBLIC40 report supersedes earlier
in-progress entries below.

The reboot removed the temporary positive project/container, frozen executables
and `/tmp` logs referenced in older entries. Their recorded results remain
historical observations, not currently runnable evidence. The full40 pipeline
was observed passing (5,378 tests, 443 optional skips); its release-gate completion
was not collected and must not be counted. Original acceptance projects and
pinned R12 remain unchanged.

The new working patch reproduces and fixes private prepared-catalog/partial-job
rescan recovery using non-student metadata. It isolates tutorial writer tooling
and legacy demo identity defaults from reviewed four-tool setup. See the
[domain audit](onboarding-domain-audit.md). Required unfamiliar-layout and fresh
student runtime qualification is still pending; the overall goal is not complete.

Earlier frozen build `5b28e74` passed the full repository test pipeline: 5,281 tests
passed and 443 optional tests were skipped. Its release gate also passed, on an
immutable source snapshot with executable SHA-256
`5b28e749848bbada3f5fe26df0362d8de9aba1ff9f2f0595300d85fde6f7d844`. The gate took
17m34s after the 17m25s test pipeline. Evidence is retained at
`/tmp/r13-releasegate-parent35-PAv6mZ`; postflight confirmed that original
containers were unchanged and no gate containers, networks or volumes remained.
The test-only image tag was subsequently removed. This is not a public release
or qualification of changes made after that snapshot.

The preserved student recovery on that build reached a managed four-tool Claude
Code handshake, two separately enabled execution policies and a running worker.
Scoped reads, private-admission discovery refusal and hold-based Action refusals
passed. No eligible request was completed: the original eligible-looking student
has a financial hold, while the hold-free cases lack prerequisite evidence. No
existing fixture facts were changed to evade those policy checks. The assisted
run took 19m51s, with seven help calls and two editor detours; this is not unaided
onboarding success.

A separate fixture adds explicitly synthetic, admitted positive cases while
preserving every original row and the reviewed schema/roles/RLS. Its fresh
Terra run saved two Actions and correctly kept advising pending its unanswered
limits. It then stopped on a Read-revision routing rejection, followed by a
505-character routing-summary refusal during correction. A discovery contract
also exceeded the complete-response bound by 37 bytes. No authority, client,
worker or source operation was enabled in that fresh run. These are onboarding
blockers under investigation, not a completed student journey. Evidence:
`/tmp/synapsor-r13-student-positive-20260911-35` and the external
`r13-student-positive35-public-journey.md` report. Admission fixture completion
does not prove integration with a production admissions system.

The next candidate adds direct client setup from active Action review and
truthful status when an already-active Read revision is inspected again. Build
`cb4e436` passed the actual saved-appointment terminal path through client setup,
Later and back to the same Action review. Before/after public authority status
was identical; no model request, connection, activation or source effect occurred.

The student routing failure was traced to a missing workload-review record after
standalone disabled signoff of a partial multi-action job. The candidate bridges
the exact signed-off nonempty Read revision without replacing the earlier pending
analysis, and adds direct model revision from linked Read review. Routing schemas
now distinguish the 500-character new read question from a 2000-character edit.
The combined review regressions passed 457 tests, with three additional governed
menu/stale-selection cases passing after the final guard. Follow-up review found
that a no-change routing result could discard a partial job's checkpoint. The
guard now retains the requested edit before any reduced checkpoint is saved;
283 review/planner regressions pass, including both no-change route variants.
Public student recovery on isolated build `e1d5442` reached that direct Read edit,
preserving both saved Actions and the pending third intent. Its private admission
mapping reversed the institution/person columns; the tester declined it. Asking
for a correction produced only an explanation and left the same mapping in place.
The previous Read, rules and source data stayed unchanged. This supersedes the
earlier routing blocker, not the unfinished student journey.

The next candidate also keeps saved drafting progress inside the model's bounded
tool conversation instead of asking the operator to type "continue" after a
status statement. Real business questions, validation failures and missing policy
remain visible; no business answer or authority is inferred. Focused model/chat
tests pass (192 passed, one optional skip). Frozen build `a828c90` additionally
passed the full test pipeline (5,309 passed, 443 optional skips) and release gate
against an immutable snapshot at `/tmp/r13-releasegate-parent39-KVhd71`. The
pipeline took 16m48s and the gate 20m05s. Postflight verified the exact executable,
unchanged original containers, and no remaining gate containers/networks/volumes.
It has not yet passed a public student journey. The next candidate routes private
mapping questions back to structured authoring and requires a new exact operator
confirmation. Host/chat/correction regressions pass (172 tests), along with 47
targeted scope/revision/query cases and 138 Action-authoring parity cases (one
optional skip). Full integrated/public qualification of that later candidate
is still pending. That public retest uses `31616b6`; its full regression/release
checks run separately on an identical immutable build at
`/tmp/r13-releasegate-parent40-mTmYgT`. A further host-input correction rejects
oversized, credential-shaped or control-character answers before saving them in
mapping history; its 175 focused tests pass, but it is not in that frozen build.
Advising limits remain unanswered and OpenRouter live
qualification still requires a credential. Neither has an invented default.

### Earlier Recovery Evidence

The chronology below records the particular earlier artifacts used; pending
statements there are superseded only by the current checkpoint above.

Broader regression testing caught an optional saved-job summary blocking Action
recovery in migrated projects without guided Read authoring history. The summary
now reports unavailable job status without preventing review of separately
validated authority or claiming completion. Repository integrity and storage
failures still propagate; no authority check was relaxed. Targeted recovery and
summary regressions pass. An isolated full suite passed 5,265 tests, with 439
optional tests skipped. That snapshot predates the later exact saved-rule
revalidation correction. The next snapshot's full suite failed five timing/lock
cases under concurrent load; those exact cases passed serially without changed
assertions or timeouts. That is not a full-suite qualification pass. Qualification
of the latest snapshot remains pending.

The `6469162` student review displays two prepared changes and one explicitly
unfinished request. Exact details name the pending advising work, then return
to the same review. Public terminal checks preserved the Read, Action exports
and resume record byte-for-byte; they made no model request and granted no
authority. This qualifies pending-work visibility, not the full three-action
student workflow. Partial Read and two-Action activation subsequently passed.
The generated writer's exact grants were applied with administrator assistance,
but writer verification found missing admission SELECT and row-locking policies.
It also incorrectly required a student setting on tenant-only shared references.
The bounded per-binding correction and PostgreSQL tests are documented in
[Private shared references](action-rule-shared-reference-scope.md); genuine policy
prerequisites required a separately reviewed repair. No student client or worker operation is yet
qualified. Advising approval limits remain unresolved, not defaulted or waived.

The candidate administrator handoff now exports a separate, bounded repair for
missing simple scoped policies. Eight isolated PostgreSQL cases qualify generated
SQL execution, unchanged source data, policy drift, unforced RLS, privileged roles,
both directions of role membership and SQL-like metadata names. The broader writer
review/deployment suite passes 109 cases. Custom predicates remain explicit blockers.
The preserved owned student test applied exactly seven generated writer-only
policies after administrator review; existing grants, reader policies and source
records were unchanged. Its required reader rescan then failed because the
private admission proof included the newly added policies. The new candidate
refreshes that disabled proof only after reproducing its entire prior fingerprint
and confirming that the added policies do not apply to the reader. A real
PostgreSQL saved-store regression covers preview, commit, unchanged conditions,
old-runtime-proof refusal and rejection of a subsequent reader-policy change.
The public `3ed97f5` retry now confirms that rescan recovery, with all private
admission semantics, fields and both compiled rules preserved. Saved-job planning
then failed after its bounded correction: its agenda contained only the unfinished
advising request, while the two completed rules were stored independently. The
new candidate revalidates those exact stored rules without model replanning,
including recovery after that failed planning stage. A disabled replacement
shadows its older active bundle, so removed outcomes are not resurrected. Pending
requirements and policy coverage remain separate and are not waived. Independent
review also found omitted unused verification fields during reconstruction;
unchanged-rule recovery now retains them. Regressions compare the full verification
contract except its necessarily refreshed generation fingerprint.

Public `2e65289` now passes that recovery: both complete rules differ only in
their refreshed Read and generation dependencies. No planner or Action-generation
request was needed; normal policy coverage retained the unfinished advising
request. Separate public Read and two-outcome proposal activation passed, followed
by seat-acceptance writer verification and execution authorization. Restoration
correctly refused the seat-only writer, which lacks UPDATE on `drop_reason` and
`dropped_at`; it offers a dedicated writer handoff instead of expanding the shared
connection silently. That handoff exposed a second-writer defect: equivalent
SELECT policies from the existing writer were rejected solely because more than
one existed. The bounded repair now accepts them only when every policy proves
the same complete reviewed scope. Twelve live PostgreSQL cases cover independent
writers, unchanged prior policies and data, and rollback on post-export predicate,
role or removal drift. Thirty-four focused writer tests pass. The direct saved
Read-review path from Action review also now preserves the pending decision and
returns to the same Action review; 120 review tests pass. Public continuation on
`5b28e74` is pending and is not counted as a student runtime success.
No student client request or receipt is qualified yet. Three interactive sessions
took approximately 325 seconds, including a separate Read-review navigation detour;
this remains assisted recovery, not a fresh or unaided setup pass. Original
fixtures and policy are untouched, and advising limits remain pending.

The student link-restoration attempt on `a71d774` failed on a malformed model
clarification. Its old diagnostic cannot establish whether the reason was
missing, empty or too long. `625d2bc` now distinguishes those cases, keeps the
current question in exact details, and provides a bounded host-reviewed way to
restore an existing generated unique relationship through model chat. It does
not invent join keys or activate access. The exact selected proof and candidate
digest are checked again during preview. Model, mutation and relationship tests
pass (101 cases), with separate orchestration checks and type checking. Public
recovery on `625d2bc` restored exactly the offer-to-registration path, preserved
both completed Actions and private admission, and kept advising pending without
invented limits. One subsequent whole-Read review recorded reviewed-but-disabled
state. The combined guided/review sessions took 326.499 seconds and did not reach
activation or runtime. The fixed candidate document marker `disabled_unreviewed`
is not the computed review state; current decision records and the explicit
review receipt remained intact. No core document/digest migration was required.

The fresh warehouse retest on `3afe1a0` asked for coded-field meanings correctly
and activated two reviewed actions. It then hit a confirmed writer-setup bug:
generated instructions alternated between combined and per-action grants while
reusing a connection variable. One action's execution was enabled, but no client,
worker or source request ran. Candidate corrections give dedicated replacement
writers stable action-specific references and grants, refuse changed credentials
shared with another action, and preserve separate execution authorization.
Three failing-before regressions reproduce the problem; the corrected broader
deployment/recovery suite passes 263 cases. The public retest on `fe404e1`
verified both dedicated writer setups and enabled execution for both outcomes.
Client startup then failed: the default Read launch was incorrectly checked
against the Action-bound execution policy before selecting its companion. A
direct companion-only launch correctly exposed two tools, not the required
combined four. Neither attempt submitted a request. The `3ee63c8` default launch,
tool preview and client-configuration paths select and fully admit the same
runtime as managed local setup; no binding check is removed. Reviewed local test
identity is reused explicitly, and the read-only override still disables changes.
Five deployment/configuration test files pass 162 cases (28 PostgreSQL cases
skipped without their configured database); another 16 runtime/identity cases
and type checking pass. The separate `3ee63c8` default-primary launch subsequently
connected, listed exactly four tools and read the three permitted public item
labels without a change request. The managed `fe404e1` warehouse client completed
both initial changes through its supervised worker, with receipts and source
readback. A third behavior was drafted and activated after a legitimate coded
field clarification, but writer-metadata refresh and Read activation then made
the saved Action dependency stale. Runtime correctly refused it; operator Action
review and guided resume also failed instead of offering repair. No third request
was sent, and the original client stayed connected. Public `2b1bec3` then offered
a metadata-only recheck into a disabled replacement, preserving all three rules.
After separate Action and execution reviews, the same original client discovered
all three outcomes and requested the third one through its unchanged four tools.
The worker applied it with a receipt; independent fixture-owner readback confirmed
the requested value and the two prior changes. Client access to the private third
field remained refused, as required. The worker was restarted with the third
dedicated writer; the client was not restarted or reconfigured. This qualifies
the assisted two-actions-then-third journey, not unaided onboarding. Evidence:
`r13-fresh-terra-three-outcome-warehouse.md` and sanitized MCP events in the external
progress directory. No user fixture or pinned artifact was changed.
Independent review found another early-check gap: the selected reader
reference or duplicate connection value could be proposed as a writer. `801d2ff`
rejects both before inspection or publication; reader-only requirements drafting
remains supported. Seventy-two writer/recovery tests and 235 terminal, provider
contract and relationship tests pass. Live OpenRouter remains unqualified.

Public testing on `3afe1a0` exposed two additional authoring blockers. Student
privacy revision failed four provider responses because Runner incorrectly
applied the 500-character read-question ceiling to access-edit instructions.
Manual entry worked, but rejected a representable guided rule containing an
input alias, explicit range guards and shared account counters. No authority
or source data changed in either attempt. The latest `a71d774` executable
separates access-revision text from read questions and preserves those manual
rule forms without discarding additional conditions. Seventy-seven focused
authoring tests, thirteen whole-orchestration access-edit cases and type checking
pass. The public manual retest now saves a disabled 60-to-45-minute threshold
revision, preserves its explicit guards/shared counters and the unrelated
reminder outcome, and recovers invalid names and numbers in the same form.
It does not activate or execute the rule. The public export subsequently exposed
a strict-import mismatch: stored review metadata included an `outcome` property
that the authoring schema deliberately forbids. `edb7b84` projects the exact
authoring fields, checks the stored review's outcome identity and retains strict
import validation. Its unchanged public export now validates with both disabled
outcomes intact. Seventy-three focused tests and a broader 324-test recovery
suite pass. The attempted ordering diagnostic was not applicable to this
single-row fixture; it is not counted as a successful repair demonstration.
An actual undeclared-input fault in an exported copy subsequently produced an
exact effect path and correction; repairing only that copy's field reference
passed public validation without changing stored or active authority.

Student privacy recovery on `a71d774` saved three public-resource exclusions and
six field-withholding changes. Both completed Action definitions and the private
admission prerequisite stayed exactly equal. The unfinished advising action was
newly checkpointed and saved pending its unanswered approval limits; an older
lost checkpoint was not reconstructed. Three changed field-review acknowledgements
remain for the current revision, not three missing business meanings. Guided
final Read review can acknowledge them together. The model also removed the
previously reviewed offer-to-registration link unnecessarily; the `625d2bc`
recovery above restores it without changing field exposure. The complete student
journey remains incomplete; the later warehouse extension is qualified above.

The preceding `34f2a2b` student retry failed before its requested privacy revision:
the unfinished advising work item was incorrectly treated as an exhaustive
index of two separately saved outcomes. General edit entry also erased its
partial checkpoint before the planner ran. The existing Read and two completed
Action drafts were unchanged, but advising components were lost from resume.
Before-export evidence retains those components, not a complete trusted replay
checkpoint. New source regressions cover retention, both multi-intent and
separate-pending-work shapes, and compiler revalidation after Read edits.
The `a71d774` continuation above now qualifies preservation of completed Actions
through a public privacy revision; it does not restore historical lost work or
qualify the full student journey.

A fresh Terra warehouse tester on `34f2a2b` also found a restart into the manual
editor from saved metadata-only progress and a legacy action path that guessed
the meaning of a coded field. No authority, client or source operation resulted.
The first terminal interruption has insufficient evidence to attribute it to
Runner. New entry-routing fixes require another public warehouse run.

An isolated earlier source snapshot passed 5,073 automated tests (416 skipped).
Its release gate found an obsolete verifier import, subsequently fixed and
verified against MySQL. The next gate failed at a Docker host-port collision,
not a runtime safety assertion; lifecycle cleanup fixes passed eleven tests and
a live owned collision/cleanup reproduction. Test-only dynamic-port propagation
passed 26 tests and the actual Docker demo with unchanged product assertions.
The next isolated `edb7b84` gate passed live PostgreSQL/MySQL, packaged guarded
write/receipt, client configuration and demo stages, then stopped on an obsolete
first-run verifier that required identity before metadata-only drafting. Its
navigation was corrected while retaining runtime identity and authority
assertions. The subsequent immutable `EB0JEA` snapshot passed the entire gate
in 24m50.164s, including PostgreSQL/MySQL, packed public CLI, guarded writes and
receipts, client configuration, license checks and publish dry-run. Its executable
SHA-256 is `fefed56ba67a7453607bb397757df1acf0bb469726f648b68566d953c73196c2`;
this is not gate coverage of later public26/27 changes or an actual publication.
A newer isolated full suite passed 5,087 tests (416 optional tests skipped),
plus type, dependency, packaging and launcher checks. It predates the last
manual/planner corrections, which have the focused evidence above. Neither
test counts nor verifier repairs qualify the missing student and fresh
multi-action setup/edit journeys.

Public26 manual editing on `be0896c` reduced one threshold revision from 17
prompts and five setting choices to two prompts and one choice, after outcome
selection. Disabled save took 11.480 seconds from the focused summary. Cancellation
preserved the exported draft byte-for-byte. The same managed four-tool client
reported automatic approval for 17 before the reviewed 17-to-16 change and human
review afterward; tool definitions were identical. No execution was requested or
claimed for this proposal-only fixture. Pending requests were resolved with public
operator commands, preserving history. Remaining wording/help friction is tracked
in the external `r13-e05-public-manual-runtime-report.md`; this was an assisted test,
not a blanket unaided usability pass. The subsequent menu calls this "Edit
business rules manually". Pending-request guidance distinguishes an unqueued
proposal's rejection from cancellation of queued work, leaves dispatched or
uncertain work for inspection, and documents noninteractive `--yes`. Those
changes passed 144 tests, type checking and actual terminal menu/help checks.

The independently installed candidate
`15227986a28788a0b563b1808b64f769af5ec349ee1b4150061388425b5a7f4d`
completed the full, unchanged Luna telecom policy through the public CLI in an
owned PostgreSQL fixture. The generated administrator handoff provisioned an
exact writer; public rescan/resume preserved the saved job and rules. Separate
Read, Action and execution reviews preceded generated Claude Code configuration,
explicit local fixture identity setup and an actual four-tool SDK connection.
An operator-started worker atomically changed the subscription and consumed the
offer. Independent source readback and one receipt confirmed both changes.
The client reported completion only after that receipt. A valid nonautomatic
offer went to human review; a repeated request reused the pending proposal.

Through the same live client connection, a plain-language edit lowered the
overall automatic-approval maximum from 10 to 1, preserving the per-account
maximum of 3, eligibility, private fields, human fallback and atomic execution.
Review identified one approved request tied to the previous rules. The complete
tool definitions remained unchanged. A one-shot worker could not claim the
old-digest request. After explicit public cancellation of that unstarted
request, a fresh reference submitted through the same client correctly reached
human review because the new automatic limit failed. Repetition reused that
pending request; independent source readback confirmed no second change.
Invalid, now-plan-mismatched offers were refused without proposal creation.
Old approvals and their history were not rewritten or reset by the edit.

This is implementer-operated public-path evidence, not unaided completion.
The edit exposed unnecessary repeated client/identity setup and contradictory
readiness text, plus a stale queue item described only as waiting. On the newer
`3af3e0e` executable, a separate owned telecom project reused its saved local
identity without reentry, updated its generated client entry through the public
installer, and passed both the built-in handshake and an independent four-tool
SDK connection. Worker startup was offered separately and declined. This is
client recovery evidence, not another completed source operation. The newer
worker-status explanation passed both current-digest and changed-rules public
cases. In the later full Luna edit, public review preserved the atomic effect
and changed the per-account limit from 3 to 2. After separate Read, Action and
execution reviews, the old approved request was shown as blocked by changed
rules with a public cancellation/resubmission path; completed and cancelled
items were not mislabeled. Client installation reused the reviewed test identity
and verified the handshake. Worker startup was explicitly declined. That edit
also required an extra clarification to restore two customer-facing data/hotspot
fields and exposed an oversized, unrelated private-condition catalog request.
The latter has a source fix and focused regressions, not a new frozen public
qualification yet. Evidence: external
`Progress docs tracking/r13-telecom-luna-e6c991-public-run.md`, with owned
sanitized terminal/MCP records and exact fixture/artifact identifiers, and
`Progress docs tracking/r13-telecom-f384-public-repeat.md`.

The full Luna CLI used `receipts.authority=runner_ledger`. Its completed result
and independent source readback are not proof of a source-database receipt in
that deployment. Source-transaction receipt behavior is qualified separately in
the engine tests below. No additional source change was made by the later
stale-queue status test.

On the same candidate, the original student project's private admission Read
condition was saved after explicit metadata and semantic review. On `3af3e0e`,
public recovery then saved an exact seat-acceptance counter-filter correction,
preserving its maxima, windows, eligibility and effect. The earlier coverage
schema error did not recur in that continuation. One later interrupted attempt
was conclusively traced to erroneous tester cleanup, not Runner; two earlier
exits lack sufficient diagnostics to classify. These are not successful
journeys. A subsequent clean public continuation saved restoration's private
admission check while preserving its effect and registrar review, then retained
a distinct third advising intent with Verification/Effect checkpoints. That
third policy is still incomplete: its automatic-approval caps are unanswered.
A read-only audit also found genuine excess public fields and misleading
passage-wide privacy flags. The later privacy correction is recorded above;
the useful Read association and student client/worker/runtime journey remain
outstanding. See external
`Progress docs tracking/r13-student-collections-cli-report.md`.

The manual semantic editor separately passed public creation and a subsequent
disabled policy edit on candidate
`0950b14f408d803737a683e725482ad1a3ea14a26f30304a10fef7738017186d`.
An appointment reminder rule preserved its 0-72 hour bounds and changed only
the automatic threshold from 24 to 20. No raw JSON, legacy DSL, activation or
source repair was used. This qualifies disabled authoring, not live execution
for that manual fixture. See external
`Progress docs tracking/r13-e05-public-manual-editor-report.md`.

## Earlier Candidate Findings

The following chronology describes earlier artifacts, not the current status
of fixes subsequently qualified above.

The later isolated candidate `e6c9916bca1af089515ed06f522d9e50250e0f201af5fcb5ca78f162b3fad76f`
reached explicit private admission-source confirmation in the public student
CLI. It then falsely rejected compatible tenant-only and tenant/principal RLS
bindings. The source fix compares roles independently; 98 focused tests pass,
including refusal of genuine conflicts. Public recovery on the next artifact
is still required. The manual editor became reachable but its public test found
a missing numeric unit and an invisible sequential prompt; those fixes are
being tested, not counted as a completed manual journey.

A fresh owned telecom database on that same `e6c9916` candidate used the full,
unchanged 6,048-byte `luna-customer-service-policy.txt` (SHA-256
`3fcbf73428afe5b8e272d0e5ba13f5266a9c1a2315f616f0440e779046d8d691`).
It prepared private field access and an atomic plan-change/offer-consumption
draft, but the required-decisions repair returned to the same menu. Exact
coverage identified a genuine outcome-counter filter mismatch and disputed
Read-scope enforcement. Both drafts were left disabled. Thirteen input events
over about 20 minutes include engineering pauses; this is not an unaided
completion measurement. No writer, connected client, source change or receipt
was reached in this full-policy run. Recovery and a complete repeat remain open.

The subsequent receipt/privacy/removal tester artifact is
`0f029c22bd2d3ba4ed4f97a72e34071a8ef0db6eadf2b0019c8b078448e91378`.
Later source-only syntax recovery tests are identified separately below; they
must not be attributed to that frozen executable.

The isolated private-Read authoring candidate from 2026-09-10 16:48 UTC is
`fb4b446c9e9d49e097eec242db0f59b011530545752d11af759f65138e474ac3`.
It includes the new private current-state Read condition, host metadata and
business confirmation, combined field/privacy revision, and pause/removal
continuation fixes. Its dependencies are installed independently of the
checkout; lock hash
`59d30ed39eb7e0b7104a90cde46ac3999ccf7fa1c70195bb37418309a6cf4aff`.
Public student recovery on this artifact failed on an overly short internal
clarification limit. That is a Runner defect, not missing admission evidence.
The subsequent independently installed candidate
`f38498ddaabbb66dd66c6ab1997837daa690ec4a77047ac3a24652c673bfc91f`
fixed that limit and rendered complete private metadata by source. Its public
student retry exposed another pre-provider defect: the helper tried to hash
ordinary optional `undefined` inspection properties as strict canonical JSON.
The current source uses an exact deep snapshot comparison for that in-memory
staleness check, retaining strict authority hashes. Three failing regressions
were reproduced before the fix; 87 focused model/consent/host tests now pass.
This source fix has not yet passed the public student retry.

The same `f38498d` public manual test completed disabled Read review but could
not reach the new semantic Action editor. That navigation fix is in progress;
the original policy, authority and source were not changed to evade the blocker.
A separate fresh telecom test using `f38498d` and the earlier short
`telecom-boundary-rules.txt` reached Read and Action review,
generated and applied the administrator-reviewed narrow writer handoff in an
owned fixture, and resumed after rescan without repeating the job. Execution
was explicitly enabled and the generated four-tool client handshake passed.
The CLI then exited with local identity still missing and the worker stopped;
the connected finish needs correction. This repeat is not qualification of the
fuller current `luna-customer-service-policy.txt` or a completed customer change.

## Reading The Evidence

- **Live verified (implementer):** assertions ran against a real owned engine.
  This does not establish independent qualification or a first-time CLI journey.
- **Implementation-tested:** compiler, simulated provider, adapter or UI tests;
  not proof of real engine execution.
- **Blocked:** a requested acceptance journey has an unresolved prerequisite.
- **Unsupported:** the current fixed-tool authority cannot represent this case.
- **Not tested:** no current-candidate live evidence for this combination.

## Fixed Client Interface

The client uses `app.describe_data`, `app.explore_data`, `app.describe_actions`
and `app.request_change`. Reviewed resources/outcomes change behind these tools;
adding a business rule does not add a tool. Discovery is not eligibility or
permission to execute. The request path verifies the nominated opaque subjects,
current facts and exact active authority. Approval and execution stay outside
model authority. An approval without a successful execution receipt is not a
completed change.

| Capability | PostgreSQL | MySQL | Limits and evidence |
| --- | --- | --- | --- |
| Scoped row reads, reviewed joins and analysis | Live telecom four-tool SDK journey; student journey blocked | Implementation-tested; current R13 client journey not tested | Reviewed projections, paths, operators, disclosure budgets and trusted identity remain mandatory. Large student discovery contract has a bounded, complete representation; this alone does not prove an activated read. Read contract tests: `apps/runner/src/read-discovery-compatibility.test.ts`. |
| One exact UPDATE | Live verified (implementer) | Live verified (implementer) | Versioned row, allowed fields, scope, reverified facts, affected-row count and replay. Engine qualification: `scripts/verify-semantic-action-rule-engines.mjs`. |
| Related target UPDATE using composite foreign keys | Live verified (implementer) | Live verified (implementer) | Every key pair retained; exact unique target required, ambiguous/missing/drifted relationships refused. Same engine qualification script. |
| INSERT through semantic outcomes | Implementation-tested; current R13 live journey not tested | Implementation-tested; current R13 live journey not tested | Reviewed subject/verification, bounded fields and supported proposal-identity deduplication only. Not an arbitrary INSERT endpoint. Draft tests: `apps/runner/src/action-rule-draft.test.ts`. |
| DELETE through semantic outcomes | Unsupported | Unsupported | Compatibility/code-first operations are not evidence of support through this four-tool authoring contract. |
| Atomic two-to-four-record UPDATE | Live verified (implementer), including durable receipt | Live verified (implementer) for two records and a source receipt; three/four records implementation-tested | Same database; distinct exact versioned targets. All updates and source receipt commit together. Live tests: `apps/runner/src/semantic-atomic-postgres.test.ts`, `apps/runner/src/semantic-atomic-mysql.live.test.ts`. Real MySQL verifies scoped readback, replay, permanent offer consumption, changed companion refusal and receipt-failure rollback. This is engine qualification, not a completed MySQL CLI journey. |
| Mixed INSERT/UPDATE/DELETE transaction, arbitrary bulk effect | Unsupported | Unsupported | Do not split a required atomic operation into independently committed requests. |
| Positive prerequisite existence | Live verified (implementer) for bounded reviewed relationships | Live verified (implementer) for bounded reviewed relationships | Complete typed conditions, exact scope and bounded cardinality, not arbitrary queries. Engine script and collection suites. |
| Effective-dated admission evidence | Live guarded worker verified (implementer); original student journey still open | Not tested | Separate private institution/student-scoped evidence, admitted status and an inclusive start/exclusive end. Missing, future, expired, withdrawn and non-admitted evidence refuse new requests. Withdrawal, removal or expiry after approval stops execution with no success receipt. This is disposable fixture/engine qualification, not a real admissions integration or proof of admission-gated Read access. |
| Private current-state condition before every Read | Native executor live verified (implementer), PostgreSQL 17.11; public student journey in progress | Native executor live verified (implementer), MySQL 8.4.9; public client journey not tested | One exact private status register, unique trusted organization/person pair, positive declared enum and half-open UTC effective period. Missing, future, expired and withdrawn evidence deny both data and coverage-shaped queries; withdrawal is rechecked instead of serving cached coverage. Does not add a public resource or agent write permission. Exact source metadata and business meaning need host review; changing models/mapping invalidates saved metadata permission. Tests: `read-prerequisite-postgres.live.test.ts`, `read-prerequisite-mysql.live.test.ts`, `read-prerequisite-revision.test.ts`, `read-boundary-revision-model.test.ts`, `scoped-explore.test.ts`. Other arbitrary Read eligibility expressions are not advertised as supported. |
| No matching active holds / negative existence | Live verified (implementer) for complete scoped collection | Live verified (implementer) for complete scoped collection | One scoped parent, inverse immediate FK, complete child visibility, parent/child locking and overflow refusal. Additional RLS predicates cannot be bypassed. [Design](action-rule-complete-collections.md), PG live tests: `packages/postgres/src/complete-collections.live.test.ts`, MySQL live tests: `packages/mysql/src/complete-collections.live.test.ts`. |
| Current totals with filtered collections | Live verified (implementer) for same-parent complete collection | Live collection locking verified; full application total/worker journey not tested | Typed count/sum/min/max after complete loading. Unknown filters/null summands and overflow refuse; no unmaintained stored total substituted. Expression tests: `packages/action-rules/src/collection-expressions.test.ts`. |
| Date/timestamp and elapsed-time comparisons | Implementation-tested | Implementation-tested | Explicit UTC `date_of` for calendar-day comparisons; `add_duration` for elapsed windows. Other calendar timezone conversion unsupported. |
| Clear nullable fields in guarded update | Live verified (implementer), including rollback and receipt | Core/authoring implementation-tested; live nullable worker not tested | Explicit typed null plus immutable null allowlist; never missing-value coercion. Nullable enum strings and timestamps covered through conversational tools. Core tests: `packages/action-rules/src/nullable-effects.test.ts`, tool tests: `apps/runner/src/action-rule-model.test.ts`, PG worker tests: `apps/runner/src/semantic-collections-postgres.test.ts`. |
| Automatic approval and human fallback | Live verified (implementer) for exact rule predicates | Live verified (implementer) for exact rule predicates | Invalid differs from valid-but-review-required. Automatic approval requires reviewed global and trusted-scope rolling caps. Uncapped automatic advising release is blocked, not silently rerouted or assigned invented limits. |
| Policy replacement before execution | Live verified (implementer) for stale authority refusal | Core tested; MySQL original setup/edit journey not tested | Old approvals cannot authorize changed effects. PG worker tests: `apps/runner/src/semantic-collections-postgres.test.ts`. |
| Activation/dispatch race and unknown receipt recovery | SQLite and PostgreSQL control-store tests live verified (implementer) | Same control-store service; no claim of MySQL-specific distributed atomicity | Revocation blocks new dispatch; previously dispatched work may finish under admitted rules. Exact one-use identity, reservations and recovery retained. Admission tests: `packages/proposal-store/src/control-effect-admissions.test.ts`, [operator semantics](owner-controlled-rules.md). |
| Source-database durable receipt | Live verified (implementer), atomic and nullable updates | Live verified (implementer) for atomic updates using a narrow writer and precreated schema-qualified receipts | Receipt/replay/rollback must be tested with the selected deployment mode, not inferred from a successful UPDATE. MySQL live regression asserts independent receipt state and rolls back both updates and the receipt claim on a receipt trigger failure. |

## Schema And Deployment Conditions

The latest complete-collection adapter rerun passed 20 live tests across
PostgreSQL and MySQL, including concurrent insert, reactivation, deletion and
cross-customer retargeting. Those mutations cannot invalidate the checked
collection before the verification transaction ends. This is adapter evidence,
not a substitute for the still-pending student authoring/execution journey.
The separate guarded PostgreSQL worker suite passes 19 cases, including an
admission effective-date correction after approval and refusal when only another
student's or institution's current admission exists. These use owned fixture
evidence and do not establish a real admissions-system integration.

| Existing schema feature | Supported scope / current qualification |
| --- | --- |
| Composite relationships | All inspected FK pairs retained. Exact unique targets and collation proof required. A composite FK is not a composite mutation identity. |
| Composite-only primary key | The current effect needs one supported exact row identity plus trusted scope. No arbitrary composite-only mutation key promise. |
| PostgreSQL RLS | Retained for source reads/locks/writes. RLS-backed Actions require ENABLE and FORCE RLS, non-owner/non-bypass roles and applicable reviewed policies. Setup now uses the same base-table prerequisites as runtime; no administrator SQL runs automatically. Complete collection proof currently accepts only the closed reviewed tenant/principal predicate shape; a function or additional hiding predicate may be unsupported even when positive reads work. |
| Deferrable/unvalidated FK | Cannot establish complete-collection phantom prevention. Refused with a prerequisite diagnostic, not treated as a missing grant. |
| MySQL isolation | Complete collections need InnoDB REPEATABLE READ and the trusted active-transaction contract; READ COMMITTED is refused. |
| Multiple conflict candidates | Unique inspected integer conflict candidate can be selected over timestamps; genuinely ambiguous counters need review. A name alone does not prove all source writers maintain the guard. |
| No conflict field | Verification-only resources can be used with exact rechecks/locks. Versionless UPDATE is not supported merely by adding writer grants. |
| Triggers and external side effects | Trigger-induced receipt failure is tested for rollback. Arbitrary trigger side effects, external systems and domain invariants are not universally proved. The operator must review the actual deployment; no cross-system rollback guarantee. |
| SELECT-only onboarding credential | Can draft metadata-only authority. Writer grants, locking permissions, RLS and receipt provisioning are separately reviewed execution prerequisites. |
| Unknown outcome after dispatch | Preserve reservations, reconcile the exact receipt; do not retry as a new change or report completion without proof. |

## Original Journey Scorecard

| Required journey | Current result | Evidence / remaining requirement |
| --- | --- | --- |
| Fresh student, all three original actions | Incomplete | Public `2e65289` recovered both exact stored rules after the metadata refresh, preserving their full verification contracts and the separate pending advising request. Read and two-outcome proposal activation passed; seat execution is enabled. Restoration correctly needs a separately reviewed writer for its clearing columns. Client/worker/source effects are not yet qualified. Advising approval caps remain unanswered, not waived. |
| Student scoped client operation and later rule edit | Not tested end to end | Must reach actual public activation, writer/client/worker setup, real positive and negative cases, then a separately reviewed stricter policy on the same client. Financial hold refusal must remain intact. |
| Fresh coded warehouse: two actions, same client, then a third | Runtime verified by tester; assisted setup and recovery | `2b1bec3` revalidated three exact outcomes after writer metadata refresh. The original continuously connected client discovered the third outcome through the same four tools without reconfiguration. Its reviewed worker completed the change with a receipt and independent fixture-owner readback; the prior two changes stayed intact and private-field access remained refused. Coded meanings required legitimate clarification. This supersedes the earlier writer/recovery blockers, not the requirement for an unaided setup pass. |
| Fresh telecom plan change and offer consumption | Full Luna policy runtime verified by tester; assisted setup, not an unaided onboarding pass | `1522798` public resume, generated exact administrator handoff, rescan, separate Read/Action/execution review, hidden local identity setup and generated client handshake completed. Official SDK used the exact generated entry and four tools. One eligible request completed with a two-row receipt and independent subscription/offer readback. A valid exception stayed in human review, duplicate requests reused their proposal, and an invalid offer was refused. This supersedes the earlier short-policy-only runtime evidence, not the remaining UX qualification. |
| Telecom plain-language edit and changed behavior | Full Luna policy, same live client, runtime verified with navigation assistance | On `1522798`, chat lowered only overall automatic approvals from 10 to 1 while retaining 3 per account and all other controls. Review identified the old approved request. A worker could not claim its old digest; public cancellation of the unstarted request preserved history. Fresh submission of the same valid offer then required human review because the new limit failed; repeat reused that request. Complete tool definitions and client remained unchanged. No second source change occurred. Repeated client/identity setup and unclear stale queue status are being repaired. Privacy tightening, removal and new-writer lifecycle evidence are separate below. |
| Warehouse setup, supervised completion and same-client rule edit | Runtime verified by tester; assisted owned-fixture credential repair and guided operator entry | On frozen `/tmp/synapsor-r13-evidence-reviewed-zuYeQh/dist/runner.mjs` (`e0786750b08e73fa133b03660f458c7bcec0d51bb0eeb51861fead636f8cfc9b`), the owned warehouse fixture completed four-tool SDK discovery. Password-only refreshes of the owned reader and exact generated writer credentials were administrator assistance; no grants, RLS, policy, rows, schema, or authority changed. The public guided `boundary review --access --job-first` route created a separate revision from proposal-only to supervised direct SQL completion, retaining the reviewed bounds, rolling caps, scope, version guard, and human review above `40`. A same-client automatic `40` request was approved, queued, and applied by the supervised worker; public proposal status showed one receipt and independent select-only source readback found one scoped `c07=40`, version `2`, row. The existing `150` request remains `pending_review`, `0/1` approved, with no receipt or source mutation. This is not an unaided onboarding completion. |
| Inspect receipts after changing rules/configuration | Public e078 receipt and lifecycle verified; owned fixture assistance disclosed | The public worker produced one applied receipt for proposal `wrp_rule_87e67bdc21c32b61a5ae33f4090b311e` (`sha256:4443f0683fec067386d34d976fc8b6412c57fed1be468045ec66e1289f8cd675`), and `proposals show` confirmed `1/1` execution, one receipt, and source mutation. The unrelated older `150` proposal remains pending with no approval, receipt, or bypass. |
| Public warehouse privacy edit | Public e078 runtime verified after assisted test-credential refresh | Default private `item_name` selection is opaque and response-local, with values and equality withheld; it is not represented as a raw filter-equality result. Public `item_name` filter, group, and sort attempts each refuse with `EXPLORE_FIELD_FORBIDDEN` / `field_operation_not_reviewed`, while the scoped `c07` read remains available (12 rows). No raw private values were recorded. |
| Retire one outcome and resume its review | Public two-outcome appointment removal and same-client discovery verified; approval recovery under qualification | Explicit removal prepares a disabled replacement, preserves the other rules and Read dependencies, and binds resume to that exact replacement. The same client subsequently lists only the retained reminder outcome and refuses the removed duration outcome. A public approval command initially selected a Read-only config; that is not proof of the stale-approval guard. Default same-project/same-store Action companion selection and retained collision/authority checks are now regression-tested. Removing the final outcome uses the existing whole-Action deactivation path, not an empty authority bundle. |
| Manual C then Y success/failure | Warehouse success independently tested; original student qualification open | Public manual activation persisted all eight warehouse decisions and a real four-tool scoped count respected the cohort floor. First-action navigation's legacy file-lock error was fixed and the public recovery retest passed without changing Read authority. Narrow/normal failure panels are implementation-tested with injected callbacks: `apps/runner/src/manual-activation-terminal.test.ts`. |
| Semantic manual rule edit and runtime change | Public four-tool same-client behavior verified; assisted test | `be0896c` changed a threshold from 17 to 16 with two prompts and one setting choice after outcome selection, taking 11.480 seconds to save. Cancellation preserved the exported draft. Separate activation changed a request for 17 from automatic approval to human review through the unchanged client/tools. Proposal-only fixture: no execution claimed. Complex constructs outside the documented structured-editor subset remain guided/advanced authoring, not claimed DSL parity. |
| OpenRouter authoring + Ask | Implementation-tested; live qualification blocked on credential | Provider selection, disclosure, bounded tools, errors and resume tested. Public model discovery is not paid authenticated authoring/Ask qualification. [Provider contract](openrouter.md). |
| Composite contract consumption and query recovery | Live Terra passed; local Ollama did not qualify | The exact captured student contract was delivered over all four actual MCP tools in memory. Terra submitted the required three-link plan; this checks metadata and validation only, not source rows. A prior Terra call used `operator` rather than `op`; source now permits one model resubmission changing only that syntax key, with full runtime validation and authority checks. Installed Ollama `qwen2.5:7b` omitted the resource and selected internal IDs. Its request was refused, not executed or counted as successful qualification. |

External sanitized tester reports record the exact artifact, preserved project,
clarifications, retries, permission decisions, elapsed time and administrator
assistance. Current student report: `r13-student-collections-cli-report.md` in
the operator's external progress directory. The first run took approximately
20 minutes and six substantive clarification answers; recovery took about ten
minutes and repeated three meanings. Neither run reached client setup, so neither
passes the first-time-user bar. The later `f38498d` failure is recorded above,
not counted as a completed recovery. Telecom initially reached Read and proposal
activation in about seven minutes but required administrator work and resume
repair before execution. These failures remain evidence, not successes because
newer unit tests pass. The original projects and pinned R12 remain untouched;
testers use only their own disposable projects and databases.

## Reproduction

From this checkout, first build the workspace. Live tests create isolated schemas
or their own containers; never point the optional PostgreSQL URL at a production
or preserved tutorial database.

```sh
corepack pnpm typecheck
corepack pnpm exec vitest run apps/runner/src/action-rule-model.test.ts apps/runner/src/action-rule-draft.test.ts
SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE=1 corepack pnpm exec vitest run packages/postgres/src/complete-collections.live.test.ts packages/mysql/src/complete-collections.live.test.ts
SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE=1 corepack pnpm exec vitest run apps/runner/src/semantic-collections-postgres.test.ts
SYNAPSOR_TEST_ATOMIC_MYSQL_LIVE=1 corepack pnpm exec vitest run apps/runner/src/semantic-atomic-mysql.live.test.ts
node scripts/verify-semantic-action-rule-engines.mjs
# Optional authorized hosted/local contract consumption (metadata, no source rows):
SYNAPSOR_TEST_DISCOVERY_CONSUMER_LIVE=1 corepack pnpm exec vitest run apps/runner/src/read-discovery-compatibility.test.ts
SYNAPSOR_TEST_DISCOVERY_CONSUMER_OLLAMA=1 corepack pnpm exec vitest run apps/runner/src/read-discovery-compatibility.test.ts
# With SYNAPSOR_TEST_POSTGRES_URL set to an explicitly owned disposable database:
corepack pnpm exec vitest run apps/runner/src/semantic-atomic-postgres.test.ts packages/proposal-store/src/control-effect-admissions.test.ts
# With owned disposable PostgreSQL/MySQL admin URLs, never a preserved project:
corepack pnpm exec vitest run apps/runner/src/read-prerequisite-postgres.live.test.ts apps/runner/src/read-prerequisite-mysql.live.test.ts
```

R13 recorded runs: PG/MySQL complete-collection suites 10+5 passing tests;
nullable PG worker suite five; direct/composite engine smoke four scenarios;
atomic PG plus both control-store admission suites 48 passing tests; real MySQL
8.4.9 atomic completion/source-receipt regression three passing tests. These are
implementer observations tied to the candidate above, not independent acceptance.
The later PostgreSQL collection repeat has 11 passing cases, including an
administrator policy change blocked until verification finishes. The pre-syntax
recovery full gate passed 4708 tests (397 optional tests skipped) plus packaging
and launcher checks. The subsequent focused runtime/provider pass has 390
passing tests, and the actual Terra contract-consumer repeat has 14. These are
separate evidence points, not a substitute for either original user journey.
The native Read-condition run at 2026-09-10T16:41:42Z passed on PostgreSQL 17.11
and MySQL 8.4.9, before the `fb4b446` candidate was built. Its two live tests
create disposable schemas/readers, exercise current and refused evidence and
coverage withdrawal, and clean up their owned resources. Full host allow/deny
metadata-transfer regressions passed separately; they are simulated-provider
tests, not live model qualification.
Final artifact hashes, full release gate and both complete setup/edit journeys
are still required before the release can be called qualified.

The stable 2026-09-10 full gate subsequently passed 4,969 tests with 411
optional tests skipped, plus dependency, type, package and launcher checks.
It predates the private-Read snapshot fix and the manual entry repair. The
result-panel row-preservation regression separately passes 174 tests, including
actual terminal rendering at 54 and 120 columns. Neither result is a substitute
for the blocked student workflow or the final artifact qualification.
