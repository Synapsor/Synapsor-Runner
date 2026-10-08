# ADR B51: share the Input interaction boundary

Status: Input slice1 accepted at `d80782e9`; Version slice2 accepted for DEV
integration at `c3ebdfa5`; initial Read slice3 accepted at `75b2cb3d` on the
separate B51 branch. Release acceptance is separate.
Source inspected: `62e4bf54c3cb6ab9f58f423991f0c121d6e760ad`.
T0: 2026-10-06T14:31:23Z. This work follows frozen candidate1508 and
independent Tester installed acceptance starting. Demo verification has priority.
The existing 72-hour B51 window ends 2026-10-09T14:31:23Z; its 48-hour settled-
source target is 2026-10-08T14:31:23Z. Neither T0 nor the allowance is reset by
the named candidate-2 checkpoint. The separate earlier demo qualification
deadline and its conditional extension remain distinct from this B51 window.
The frozen candidate remains unchanged. All same-connection live-edit work is stopped.

## Decision

Keep the existing Input controller and durable records. Extract its CLI host
transitions into one production adapter, and derive typed interaction views from
those records. The CLI and an internal headless test adapter must submit responses
to the same handlers. The accepted Input slice covers onboarding and editing only.
Those entry routes already share `ensureInputPolicyAgenda` and the same controller;
this consolidates the inline host transitions and their CLI/headless-test use.

Do not add another question engine or a separately writable UX progress store.
Do not migrate Version, Read, every old job or activation in this first slice.
A common envelope may describe those distinct interaction kinds without moving
their permission checks into a generic dispatcher.

## Current ownership, verified in source

Paths below are under `apps/runner/src`; line anchors refer to the inspected pin.

| Responsibility | Current owner and seam |
| --- | --- |
| Input entry and root selection | `boundary-commands.ts:4600 ensureInputPolicyAgenda`; called after create/revise planning at6863, saved Review at5412, and pending Input Resume before planning at6145. |
| Durable question and interpretation | `authoring-operator-question.ts:19 OperatorQuestion` carries target, context, Source binding, wording, raw answer, proposed value, confirmation and histories. `runSourceInputConversation` at `authoring-input-policy-conversation.ts:83` owns Source review, missing-information child, mapping and confirmation. |
| Raw answer and attribution | Input host `recordRawAnswer` at commands4715 captures exact raw text and performs one Resume save. Nonblank answers update the answered owner handoff and generation-answer association; blank answers retain a waiting handoff. Conversation text is separate model context. |
| Generation and allowances | The Input root owns its existing6/8 episode pool; children refer to that root. `operatorQuestionEpisode` and existing generation-recovery records reserve and retain their separate allowances. No new pool, correction reset or transport bypass is proposed. |
| Readback and decision | `operatorQuestionReadback` creates canonical facts. Controller207–209 asks default-No and saves confirmation of that exact proposal. Wording is separate from this readback. |
| Source adoption and acknowledgement | Controller211–240 performs exact Source append and Resume acknowledgement. A confirmed question alone is neither Source adoption nor an Action save. |
| Owning-stage validation | `sourceInputFidelity` and `assessInputFidelity` check the applicable review as Action producers compile. Whole-program and surviving-duty checks remain. |
| Resume and checkpoints | `persistAuthoringResume` at commands4812 routes the full stage snapshot to `writeBoundaryAuthoringResumeState` at resume437. The latter checks expected revision and immutable question, history and transport advancement. |
| Disabled revision and activation | The Action host save at commands7409 creates a disabled revision. Consent11990 and activation12017 remain separate. Model prose, Input confirmation and Source review grant no active authority. |
| Version comparison | `runVersionConversation` at version-conversation37 uses the same question record but a pending Version/Action owning turn. Host7281/7298 repeats raw-answer and Resume mechanics; host7348 and action-rule-model602–628 subsequently consume the reviewed counter. The operator's all-writers statement remains unverified even after consumption; consumption is not proof of external writer behaviour. |

`ownerQuestionContext` at commands4916–4949 includes Source, reader metadata and
the saved Action baseline. Input store/outcomes are separately checked by the
root binding and `ensureInputPolicyAgenda/assertInputCurrent` at4606–4613/4677–4687.
Similar rechecks at model dispatch,
response adoption and persistence guard different boundaries; they are not
duplicates to delete merely because their names resemble one another.

The actual duplicated lifecycle ownership is the inline Input host
`recordRawAnswer/resumePending`4715/4738 and Version7281/7298: each implements
capture, handoff update, replacement, currentness, rollback and persistence routing.
Pure question transforms are already shared. The first slice consolidates the
Input host implementation and its two entry routes; Version migration is later.

An existing seam failure is #19's interrupted Read wording handoff
(before1437 failed; after1440 retained the original wording). That is Read evidence,
not independent Input proof. Existing Input159 and Version119 tests characterize
their corresponding durable wording handoffs on this pin.

## Persistence boundary

There is one project mutation lease, with separate atomic CAS file saves for
Resume and Source. There is no cross-file transaction.

Input already supplies the usable idempotent handoff:

1. Save the exact question and raw answer in Resume before interpreting the answer.
2. Validate and save the proposal; save explicit confirmation of its exact digest.
3. Append the exact attributed Input review to the Source session under its CAS.
4. Acknowledge that append in Resume under the same project lease.

If interruption occurs between3 and4, recovery resolves the exact matching review.
The `append_recovery` route removes that exact last append to reconstruct and
verify the prior Source against the current input; otherwise `completed_review`
revalidates the exact applicable saved record. It then finishes the acknowledgement
without changing timestamps, regenerating or reconfirming. It does not accept an
arbitrary same-looking latest review. Both existing checks remain authoritative.

Production acknowledgement performs a general Resume save; it does not persist
an Input-review acknowledgement identity. Do not infer a historical acknowledgement
from a timestamp or revision. When the exact Source review exists, render
“Source interpretation saved; continuation requires revalidation” and use the
existing idempotent path. A missing matching Source review, a saved disabled
Action and active authority can be distinguished from their actual records.
Do not invent a durable “appended but unacknowledged” cursor or collapse these
different records into one “ready” state.

## Interaction envelope

This is an in-process derived view, not a public management API or stored cursor.

| Variant | Authoritative basis | Permitted response |
| --- | --- | --- |
| Business question | Exact OperatorQuestion/root/child and current business presentation | Raw answer, keep pending, or supported reopen/replacement. |
| Proposed interpretation/readback | Exact validated proposal plus raw-answer or resolved Source reference | Explicit accept/decline; default-No. |
| Consent | Existing exact disabled revision and native consent requirements | Existing activation handler only; no model-controlled actor or permission. |
| Paused/blocked | Current missing prerequisite, terminal refusal or unfinished operation | Only actions the existing handler can safely perform; details are read-only. |
| Recovery decision | Existing #19 interrupted-operation record and allowed disposition | Existing recorded recovery handler; uncertainty never becomes completion. |

Each view contains an existing owner/interaction identity, question revision,
binding of relevant Resume/Source/question/baseline records, current business
facts, optional exact details and allowed response shapes. Stable IDs are host
owned. A displayed option is not a capability: submission rereads current records
and checks the expected binding through the existing production handler.

Redisplay uses saved wording and performs no generation. Details do not advance
anything. Replacement retains prior answer, completion and allowance history.
Late responses cannot overwrite a newer question, confirmation or baseline.

Model wording and proposed meaning remain untrusted. Runner supplies known
identity and references instead of asking the model to reconstruct hashes or IDs.
Source claims, operator-answer evidence and technical capability evidence stay
distinct. Rendering a citation resolves the actual Source; a matching range or
quote is not proof of English semantic applicability. Schema comments are hints,
not permission evidence. No new row sampling or disclosure is introduced.

## Editing baseline and scope

An edit selects one published program or an intentionally chosen disabled draft.
Record that baseline, the requested change, exact intended targets, affected
requirements and surviving semantics. Never silently switch the baseline.

The Input interaction reuses the same controller and host handlers. Its current
store/outcomes/context binding must include the selected baseline. A focused
business diff does not waive whole-program validation, approval dependencies,
Source applicability or freshness keys. Active authority stays unchanged until
the separate existing activation consent succeeds.

## First implementation slice, for separate approval

| File/function | Small change |
| --- | --- |
| New internal `authoring-input-interaction.ts` | Derive Input question/readback/pending views; define strict response variants and expected binding. No storage, budgets or generic orchestration engine. |
| Existing Input host in `boundary-commands.ts` | Extract root/child selection plus `saveQuestion`4692, `createMissingQuestion`4700, raw-answer, replacement, reopen and acknowledgement transitions into one production host factory using current Resume/Source callbacks and permits. This includes completion-to-handoff/child/generation association and CAS. Remove their old inline lifecycle implementations when migrated. |
| `authoring-input-policy-conversation.ts` | Retain the controller and its existing ports/validators. Bind prompt and confirmation through the shared view adapter; retain exact append-recovery. |
| CLI presenter and internal test adapter | Render/answer that same view and call the same host transitions. Do not let the test adapter fabricate handoffs, completions, actors or saved authority. |
| Existing Input/Resume tests | Share scenario facts and add restart-at-handoff comparison through both entry routes; keep a small real PTY set for display, default-No, cancellation and navigation. |

Before final acceptance remove the title/request-order Input driver branch and
superseded inline Input transition code. Merely wrapping old and new independent
owners is not consolidation. Stage producers, generation recovery, Source CAS
and whole-program validation retain their existing responsibilities.

Compatibility risks are persisted question/root-child formats, exact Source
append recovery, callback ownership, mutable CLI closure snapshots, attribution
and stage-specific allowances. Preserve formats and freshness keys. Do not
reinterpret authentic older history or replay an uncertain model operation.

Acceptance criteria for that future slice:

- Both onboarding and selected-baseline editing use one Input host/controller.
- Restart at each durable handoff preserves business state and the actual next
  safe step relative to the uninterrupted route.
- EOF, unknown, decline and replacement retain raw words/history and counters;
  redisplay sends nothing and a resolvable positive task has a finite route.
- Stale Source/schema/role/baseline, concurrent confirmation and late result
  are refused before adopting a changed proposal or overwriting the winner.
- Source append followed by interrupted acknowledgement finishes idempotently,
  without another model call, answer, confirmation or authority grant.
- Saved disabled versus active state, unaffected semantics and duties remain
  exact; activation retains its own default-No/currentness/authority checks.
- The independent Tester supplies semantic counterexamples on another schema
  and another entry route. Scripted successes use only actual model-visible
  inputs and declared operator answers; private oracles never fill missing facts.
- Four MCP tools, privacy, financial guards, #19 history and existing recovery
  limits remain unchanged. No public management API, event sourcing or web rewrite.

## Phase 0 observations

An isolated zero-provider batch on the unchanged source passed88/88 assertions:
Input controller38, OperatorQuestion26, Version comparison19, derived public
Review/Resume5. Actual Source/Resume files and CAS were exercised; no real provider,
source DB or complete positive editing/publication observation is claimed.

These restart controls reread real persisted files but retain injected fixture
callbacks; the fixture acknowledgement Set is in memory. They do not establish
an independently durable acknowledgement identity or a separate-process cold
restart after every handoff. The future slice needs that stronger comparison.

The controller fixtures sometimes deliberately request clarification even when
their Source already contains bounds. Those tests characterize durable handoffs,
not whether the question was necessary or the model understood the policy.
The five public Resume cases prove scoped pending/refusal continuation, not a
completed editing task. Independent Tester semantic review is separate.

Detailed per-case rows, actual invocation, raw JSON/logs, tested file hashes and
closure evidence are in the external phase0 packet. Existing complete frozen
qualification is unchanged. No production code or test assertions were edited.
This ADR and Input slice do not block Luna acceptance.

## Current implementation checkpoint

`authoring-input-host.ts` implements root/child selection, question save, missing
question creation, raw answer/handoff/generation association, reopen/replacement
and exact Source acknowledgement. The old inline production implementations in
`ensureInputPolicyAgenda` are removed. That function now supplies narrow current
record access, protected mutation/save callbacks and a CLI presenter.

`authoring-input-interaction.ts` derives only question, canonical readback and
pending views. An internal adapter supplies raw text or choices bound to the
exact semantic question/root/context/proposal. Root budget advancement remains
separately protected by exact saves and existing monotonic checks. No new stored
cursor, activation/recovery dispatcher or permission is added.

Expected Source/store/outcomes are captured for the owning turn. Resume,
questions, handoffs, generation state, conversation and current outcomes are
read through narrow accessors; disk Source and reader context are reread at the
existing currentness boundaries. The protected commit installs the host's record
updates into the enclosing workflow before its existing Resume CAS save, so the
next owning-stage save uses the acknowledged records. Failure retains the existing
fence and rollback. Permit propagation uses the existing mutation helper.

The shared entry function is called by saved Review, pending Input Resume,
the newly saved plan, Resume past planning and Action production. These callers
retain their existing stage ownership; they do not implement Input transitions.

Seven production-host cases now compare uninterrupted and fresh-process runs
at root creation, unanswered question, raw answer, proposal, confirmation,
Source append before acknowledgement and return to the next owning stage.
Independent controls also passed for a competing saved decision versus a stale
displayed Yes, a forged response binding, cancellation, append before ACK and
committed ACK with a lost response. They exercise real Source/Resume writers and
preserve exact within-run evidence, without an acknowledgement registry.

A public saved-Review characterization confirms the exact attributed Input and
Source append survive the caller's currentness refusal. The first-ever Input
append can invalidate a prior Review selection; its intended positive continuation
remains a separate open route investigation. This passing persistence assertion
does not turn that refusal into task completion.

The public onboarding fixture now completes ordinary two-Action planning, the
missing Input answer and explicit confirmation, both Action drafts, Source
coverage and client duties through reviewed disabled authority. Its successful
responses use actual transmitted question IDs, Source text, work-unit contracts
and declared operator facts. Both independently declared reviewer arrangements
remain distinct; no activation or Source effect is claimed. The helper passed
this case and the unchanged healthy control. Independent replay also passed:
actual saved Source, Resume and authority agree; both native activation selectors
remain absent. This establishes the scoped scripted onboarding route only.

The selected disabled-baseline edit also passed independent replay. A plain
request changes the first Action to two reviewers while the second keeps one.
The actual before/after readback and explicit decision save the disabled revision;
Input records, independent reviewer arrangements, private eligibility, effects,
Version, Read semantics and surviving duties remain intact. Source applicability
records the exact operator override separately from the prior policy. Normal
revision/timestamp advancement is checked explicitly. No activation, provider or
source DB effect is claimed. The model-only advisory still says one reviewer and
the selected-Action footer is narrower than the saved whole program; these are
disclosed observations, not omitted peer semantics or an overall UX verdict.

The affected public regression file passed all21 cases on the integrated test pin,
and typecheck passed. Detailed independent onboarding and edit adjudications and
actual process-closure evidence remain in the external qualification packet.
The independently sealed different-schema public Resume control passed. It uses
`dispatch_lab` and `handover_note`, enters an actually saved unanswered question,
then captures the exact declared answer and proposal. Default-No decline and
later default Keep retain the question, answer, proposal, histories and counters
without Source adoption or authority. Native pending status is expected here;
this intentional pending control is not a completed positive task. It is a
same-process public replay, separate from the cold production-host controls.

The genuine terminal control also passed independent artifact adjudication.
It uses the default production presenter, a real Unix PTY and physical Escape,
Enter on default No, and Enter on default Keep through three public Resume
invocations. Exact raw whitespace and the faithful bounds proposal survive the
explicit decline; cancellation and Keep perform no mapping or allowance debit.
Saved Source and Read semantics remain exact and no Action or activation exists.
The ordinary scripted preparation retains its actual unanswered native root.
This is pending-safety coverage in one terminal child, not positive adoption or
cold-process public onboarding evidence. Independent review checked the actual
screens, code and disk artifacts without launching a second terminal replay.
Nested preparation cache is confined to its owned capture directory.

This is a development checkpoint, not accepted delivery. Final settled gates and
installed acceptance remain required. The earlier 88 assertions
retain their limited scope. Controlled successful replies in the new restart
fixtures derive references from actual transmitted frames and declared answers.
Version blank/unknown handling already exists; the added Version raw-save
interruption work is characterization only, with no Version product change.

## Input DEV integration and next slice

The dedicated independent reviewer accepted the exact Input candidate `d80782e9`
after types, completed scoped public routes, production-host cold restart and
return-to-caller controls, negative companions, and the one four-worker whole
package run: 9,076 passed, zero failed and 576 skipped across all 440 files. Every
required package-tail command completed successfully. Private generated bundle
content stayed exact; three `.mjs` modes changed from 0664 to 0600 under the
launcher umask, and the existing Vitest cache changed. These private DEV effects
are preserved and do not establish immutable release artifact equivalence.

This closes Input DEV integration only. Named delivery still requires the
settled release gates and independent installed acceptance. Frozen demo candidate
`62e4bf54` remains untouched. Version slice2 may now consolidate its actual inline
host transitions using the existing controller and owning Action budget; blank
and unknown answers already remain pending and are characterization, not fixes.
The dedicated reviewer owns its separately presealed variants and exact-pin DEV
verdict. Positive fresh-process return through the Action producer must be observed
without fabricating completion, Source proof, authority or an extra allowance.

## Version slice2 implementation checkpoint

Version now uses `authoring-version-host.ts` for its actual question creation,
raw-answer save, handoff and generation association, pending reopen/replacement,
and the existing protected checkpoint callbacks. The corresponding inline
lifecycle implementations are removed from `reviewVersionQuestion`. The Action
producer still owns Source/Read/schema/role checks, prepared Version proof,
checkpoint completion, reviewed-field adoption and return to Action drafting.
`runVersionConversation` retains its existing interpretation, default-No, blank
and unknown handling, correction allowance and owning Action logical-turn budget.

Input and Version share only derived interaction view/response types. Their
bindings and production hosts remain stage specific; no new dispatcher, stored
progress, pool, actor, authority or recovery path is introduced. Version responses
are bound to the exact Action turn, root, question revision/digest, pending marker,
context, scope and proposed statement. The presenter supplies words or choices
through that host; it cannot save or complete a generation.

The prototype passed the existing controller/Resume contracts and new binding
controls (86 assertions), plus eight affected public Version cases covering
confirmation and return to the next ordinary Action question, decline, EOF,
terminal mapping, interrupted raw-save acknowledgement, and answer replacement.
The two successful public fake responders now read identities and structural
options from actual transmitted frames; saved artifacts remain verdict inputs
only. Call-count, decline, unknown, history and authority assertions are unchanged.
These public cases invoke a new public call in one process; they do not establish
a cold-process public restart. Dedicated independent cold/caller/negative review
and the one isolated full run are still required before Version DEV integration.
Frozen demo candidate `62e4bf54` is unchanged.

## Version DEV integration and first Read slice

The dedicated independent reviewer accepted exact Version candidate `c3ebdfa5`
(production extraction `b2fd567e`) after its original five-family oracle, types,
affected public routes, cold producer/host/caller controls and the one isolated
native package gate. The gate passed 9,108 tests with zero failures and 576 skips
across all 442 files; every original package-tail command completed. All owned
gate processes closed naturally. Independent inspection verified the exact source,
private dependencies and generated bytes. Three regenerated bundle modes changed
under the private launcher umask, as in the Input baseline; those changes and the
existing Vitest cache update are retained. This is DEV integration evidence.

The 17 cold controls return through the actual Action producer after six durable
Version handoffs. Blank, unknown, EOF, decline, replacement, stale Source and
reader context, CAS races and failed saves retain their existing guards. The
overall Action remains pending at its next ordinary business question. This is
neither whole-CLI cold onboarding nor physical database, activation or installed
qualification. No additional full run is needed for this documentation checkpoint.

Owner retains eight workers, minimum one, as the B51 DEV default. The unfiltered
eight-worker gate took 936.37 seconds in Vitest and 971.90 seconds in its wrapper,
versus 1769.25 and 1805.38 seconds for the four-worker Input baseline. The later
inventory has two more files and 32 more cases, so this is an observed comparison.
Pool, isolation, global timeouts, assertions, inventory and native command tail
remain unchanged. This setting does not change the frozen demo candidate.

The first Read slice will consolidate the initial business-meaning question host
and derive its interaction view through existing question records. Keep the real
Read producer, completion/handoff creation, remapping, accepted-result callback,
Source indexing, final Read review and ordinary caller as their current owners.
Initial Read meaning is indexed into Source only after accepted remapping; the
Read-edit answer path has a different commit point and remains unchanged. Value
disclosure, private prerequisites, relationship review and all native limits stay
separate. Add actual cold producer/host/caller controls and scoped public routes;
do not infer Read acceptance from Input or Version tests.

Action review, consents/readbacks, blocked/recovery and editing maps are read-only
preparation in separate worktrees. They authorize no additional implementation
slice. In particular, a confirmed first Input append invalidating an older review
selection and an interrupted step at zero attempts without Continue are recorded
recovery inputs. Preserve currentness, uncertainty and exhausted-generation fences;
no automatic rebase, fresh counter or completion is proposed by this checkpoint.

## Initial Read implementation checkpoint

`authoring-read-meaning-host.ts` now owns the native initial meaning question's
raw capture, local proposal, default-No readback, pending/reopen/replacement and
protected decided-checkpoint transitions. The old inline save/accept/pending
implementations are removed. A stage-specific binding derives from the actual
question, owner handoff and producer assistance checkpoint; responses carry only
raw words or choices. The CLI presenter uses those same views. Existing non-native
compatibility presentation remains separate and keeps its prior trimming contract.

The original producer checkpoint callback still creates the real completion and
handoff. It still indexes confirmed naming testimony into Source only after
accepted remapping, then returns through the ordinary final Read caller. Source
and Resume CAS, short mutation permits and rollback stay with their actual writers.
Read-edit, values, private prerequisites, relationships and native allowance owners
are unchanged. A presented or confirmed meaning is not database evidence or
permission, and a failed remap or uncertain save does not become completion.

Types and 165 focused producer/checkpoint/view controls pass. All 37 affected
public assistance controls pass with unchanged assertions, including literal raw
retention, pending/default-No, replacement, competing saves, Source drift and
remapping/index acknowledgement failures. These public controls are in-process.
The independent initial Read batch is presealed; genuine cold producer/host/caller,
small changed-presenter terminal controls, its DEV verdict and the one whole
package gate remain required. This checkpoint is not Read DEV acceptance.

The public cold controls now resume three producer-created states: unanswered,
declined local proposal and confirmed meaning before remapping. Each fresh child
reuses the exact saved words and decision where present, performs one remap,
indexes the meaning once through the production accepted-result callback, and
returns to the ordinary disabled Read review. The existing model summary is a
separate narration request; it is not a wording rephrase or another mapping.
Attached-rule coverage is deliberately declined and access remains disabled.
Preparation uses fictional structural inspection and the native saved Read entry
stage. It seeds no question, completion, target answer or mapping, and supplies no
model planning or physical database evidence.

The changed presenter also passed one real terminal child with physical Escape
at the unanswered question and Enter at the default-No meaning readback. Both
rounds retain the actual pending records, make zero model requests and leave
Source and authority unchanged. Independent cold/terminal artifact adjudication
and the one full eight-worker gate are still required before Read acceptance.

## Initial Read DEV integration

The dedicated independent reviewer accepted exact Read candidate `75b2cb3d`
(production extraction `d24a7ef0`) after its original twelve-row oracle, types,
affected existing public controls, five genuine fresh-process pairs and the small
production terminal sample. The raw-save loss companion performs a real durable
rename before losing its acknowledgement; a distinct fresh process reuses the
exact raw event without another prompt or initial generation. Its before-write
companion preserves the last acknowledged state and asks once on restart. Both
return through accepted remapping, one Source meaning index and ordinary disabled
Read review. Counter exhaustion has native durable regression evidence; no separate
exhausted fresh-process negative was executed or claimed.

The single unfiltered eight-worker gate passed 9,126 tests, with zero failures and
576 skips across 445 files. All original package-tail commands and six launcher
shutdown controls passed. Vitest took 957.41 seconds; the outer wrapper took
992.37 seconds. Owned processes closed naturally, with no retry or quarantine.
The independent closure audit verified all 8,440 tracked source members against
Git and the pre-run seal, all 17,729 private dependency members and the actual
445-file reporter inventory. The historical dependency origin differs only in
one existing Vitest cache file. Ignored-build inventory is post-run only: there
was no fresh full-specific pre-run ignored-build manifest, and no before/after
byte equality is claimed. Actual prebuild and mandatory final build/freshness
checks passed. The frozen demo source and bundle remain exact.

`FINAL-READ-DEV-APPENDIX.json` in the independent Read review evidence records the
exact verdict and scoped limitations. This establishes DEV integration, not
physical database behavior, real-model planning, activation, installed acceptance
or release qualification. No new full run is needed for this documentation
checkpoint. Remaining-family maps are preparation only; their implementation
still requires the already-established migration scope or an Owner decision.

## Action business-statement extraction checkpoint

The Owner selected Action review, blocked/recovery, consents/readbacks and editing
in that order. Slice four moves the existing `reviewBusinessAnswer` lifecycle to
`authoring-business-statement-host.ts`; the superseded inline owner and structured
question branches of the broad direct answer recorder are removed. The remaining
direct recorder serves its other existing consumers. The presenter answers a
derived exact binding with raw words, a decision, or the three distinct retained
answer operations: Keep, Review and Replace. No persisted cursor, store, model
allowance, permission or alternative question engine is added.

The host owns captured testimony, attributed local readback, default-No and
handoff/history updates. Action producers, completion/journal accounting,
compilers, whole-policy review and publication remain their existing owners.
Ordinary Read editing and private prerequisite clarification/correction use a
pure decision adapter. Ordinary statements append to Source before the Resume
acceptance acknowledgement. Private prerequisite statements never append to
policy Source. Initial Read's accepted-remap/index ordering is unchanged.

Types, 24 new local host/binding controls, 455 affected existing logic controls
and nine existing public CLI cases pass at this checkpoint. The local host tests
use real short project exclusion and literal port-file writes, but establish no
native producer, accepted Action or fresh-process caller proof. Genuine public
cold completion and failure companions, spent-state restart, Read-edit adapters,
a small production terminal sample, independent adjudication and the single
eight-worker full gate remain required. Slice four is not yet DEV accepted.

Luna STOP1560 is candidate finding #20, with a frozen-source reproduction being
prepared separately. Its proposed cause remains unproven; no frozen patch or
recovery admission change belongs in this extraction. Any reproduced fix follows
in the blocked/recovery slice after Action review.

### Owner-authorized #21 Read meaning amendment

STOP1565 reproduced on the unchanged initial Read host: a native question with declined nonblank words resumed cold into the retained readback without an amendment choice. The failing-before process control is preserved in `CAUSE21-FAILING-BEFORE.json` under the Action DEV evidence packet. The Read host now offers Keep / Review / Replace for retained nonblank words. Keep saves no decision; Review reuses the exact answer; Replace appends a question revision with the same target, handoff, evidence and native allowance, preserving the old raw event. Confirmation and accepted remap still precede Source indexing. No model call, budget reset, authority or permission is granted by replacement.

This is an explicitly authorized UX correction, not an extraction-only equivalence claim. The existing special blank-wait and accepted interpretation replacement rules remain unchanged. Primary cold replacement and Keep controls passed alongside the original cold Read controls; independent withheld correction coverage and the final integrated DEV full remain pending. Frozen candidate 62e4bf54 is untouched.


## Controlling foundation completion — Owner direction, October 8, 2026 UTC

This direction supersedes historical demo-date cutoffs, instance-only delivery dispositions and line/parameter-count targets where they conflict. Keep accepted B51/B48 work; complete the existing B59 evidence resolution, B60 receipt interaction and consent ownership. This is not a new authoring engine, blanket semantic cache, prompt centralization or feature intake. Main owns integration and production-contract review; one editor owns each shared hotspot; independent reviewers accept behavior and ownership.

- B59: one derived current Read evidence resolver over applicable original request/Source, bound raw answers, confirmed mappings, saved workload analysis and current structural reviews. Return per-requirement established/missing/stale/conflicting/unsupported with native references; raw awaiting interpretation is distinct from confirmation and authority. Reuse applicable established meaning across omission, presentation edits, unrelated edits and Resume. Ask only the missing delta. Exact dependency drift, replacement/conflict retirement, explicit exclusion, privacy and FK/field-answer scope remain enforced. Restore original flows where the actual host evidence supports them; changing tests requires preserved failure and independent contract rationale.
- B60: the remaining factory may supply narrow coherent readers/protected ports, invoke the host and present typed results. The map includes transitive effects of reviewAnswer, refreshEvidence and questionContext. The receipt host owns target/applicability/predecessor/replacement/projection; shared handlers own question transitions; native writers own separate Source/Resume saves. Adopt only the corresponding acknowledged revision, with existing currentness boundaries and no wait-spanning lease or parallel pending flag.
- Consumption: meaning identity, applicability binding and producer/commit identity remain separate. Actual completed refused sequences may be checkpointed after their durable consequences without policy acceptance. Partial/unknown output and uncertain writes stay fenced. Qualify actual planning-to-Review and coverage-to-owner exits and cold interruptions; no synthetic completion or journal rewrite.
- Consent: inspect both actual prompts and decision kind, actor, destination, purpose, covered operation/payload, scope, validity, prior grant and call site. A context digest difference alone does not establish a new grant. Preserve applicable consent across route/process changes; review genuinely fresh material/purpose/authority without changing defaults or broadening scopes. Business readback, egress, per-episode admission and activation must be distinguished. Historical count changes are subject to this ownership audit.
- Independent qualification: one compact sequence matrix covers Read and receipt answer/confirm, omission, unrelated edit, restart/Review, replacement/cancel, drift, concurrent saves, interrupted Source/Resume acknowledgement and applicable consent reuse. Use actual production handlers and actual B48 routing where applicable; inspect fresh-process invocations. Component fixtures are scoped evidence, never whole public Resume-CAS acceptance. Preserve original and explicitly supplemental studio policies and all failed results. Private oracle facts cannot supply model replies.
- B61 remains separately accepted within native source_db atomic receipt/reconciliation scope. Actual runner_ledger uncertainty remains truthful. No effect replay, receipt-mode switch, grant or recovery-right expansion. Prefer existing-record projections; any genuinely new record/digest migration needs an explicit compatibility decision.

Existing scope close is 2026-10-09T21:51:08Z and final delivery is 2026-10-10T21:51:08Z. ONE additional 48-hour OFFLINE completion window is pre-authorized only if needed for these named checks; it has not been activated. If activated once, record it against that final deadline (2026-10-12T21:51:08Z). It does not extend paid permission, add samples, money or frozen candidates. Candidate3 is preserved. Candidate4 freezes only after foundation, composed workflow, settled gates and independent installed acceptance; then the existing focused paid edit, one full paid rehearsal and owner rehearsal sequence applies. Luna total remains35USD with historical liabilities/holds. Paid remains CLOSED. Demo date is movable and is not a reason to defer necessary ownership.


## B64 controlling structured authoring protocol and editable readbacks

Owner resumed work under B64 plus the direct typed-input addendum. T0 is
2026-10-08T06:32:23Z (October 7, 23:32:23 PDT), recorded once. The 120-hour
window ends 2026-10-13T06:32:23Z; implementation targets the first 96 hours,
with the final 24 hours reserved for integration, acceptance and closeout.
This replaces earlier candidate-4 product cutoffs for B64 only. The prior
48-hour extension was not activated and does not stack. Earlier requirements
to expand B59 English semantic classifiers are historical for migrated paths.
Preserve candidate3, held jobs and all financial/recovery history.

Main owns this contract, integration, protocol/field/domain interfaces and shared
boundary wiring. Read owner reuses the evidence resolver and adds reviewed
structured scope. Presentation owner extends the B51 presenter/B48 adapter;
Main owns Action typed edit/clarification/completion until a separate existing
owner is assigned. Independent Read reviewer and Reviewer2 adjudicate separate
boundaries; implementers cannot self-approve. One editor per hotspot.

| Boundary | Model proposal / validator owner | Operator decision | Protected save / view | Entry routes |
| --- | --- | --- | --- | --- |
| Read scope | boundary-job-model/read-workload-model plus read-boundary-revision-model; exact catalog and host-resolved request/Source refs; read-current-evidence derives confirmed evidence | Existing Read question/review host confirms exact inclusions/exclusions/intended use, never whole-resource access from FK/field meaning | Source/OperatorQuestion/Resume and saved workload owners; normalized scope card distinct from activation | setup, mapping/correction, saved Review, edit, Resume/Replace |
| Action edit | action-rule-model bounded components and action-rule-draft compiler; selected exact baseline and actual canonical delta | Existing shared business host and grouped policy review; extra changes visible and reviewed, no preserved:all trust | Existing draft/checkpoint/Resume writers, whole-policy validation, disabled save then separate activation | setup, selected baseline edit, Review, Resume/cancel/Replace |
| Clarification/completion | Existing typed tool decoders validate target/missing value/evidence; host chooses inspected mechanics vs business host | Trusted adapter captures raw answer or typed field event; model only proposes interpretation | Existing consumed-producer handoff and acknowledged protected saves; prose/finished cannot establish completion | Read and Action ordinary/public/restart paths |
| Typed field review | Domain adapter exposes fixed integer/money/choice fields, exact target/dependencies and full proposal/diff; no model form or JSON setter | Enter keeps exact displayed suggestion in unconfirmed proposal; strict literal replaces, unresolved remains pending; one explicit default-No grouped confirmation | Versioned extension in existing question/Resume/draft owners, no keystroke Source writes or new form store; B51 presenter/B48 shared adapter | grouped/edit/missing/sequential/correction/pause, restart and ordinary public CLI |
| Consent/details | Existing egress, activation and recovery owners; decision kind/purpose/payload/prior grant explicit | Separate appropriate existing decisions; no duplicate count-based suppression | Native Source/Resume and audit records; paged authorized projection, no second journal or provider calls to view | all consequential entries, /details and /exact |

`authoring-typed-review.ts` defines the first host-only field/event/view contract.
Meaning/applicability/operation/proposal/view identities remain distinct. Domain
handlers must re-resolve field IDs, reparse raw literals, recheck currentness and
save using existing CAS owners. The renderer grants no authority. Origin is
saved-confirmed, saved-unconfirmed, model-proposal or operator-edit. Decimal
money uses an explicit domain currency/scale and exact minor-unit arithmetic;
no floating point rounding, partial parsing or runtime counter expansion.
A typed field proposal cannot hide noneditable rules: the complete normalized
proposal and calculated diff accompany the fields and final confirmation.

Actual reachable semantic sites inventoried initially: action-rule-model's
revision focus on only/keep/reviewer, punctuation/progress fallback to questions,
explicit approval requirement extraction and diagnostic phase inference;
action-execution-intent mode/negation inference; authoring-counting-requirements
clause/outcome association; read-requested-scope and Read meaning classifiers.
Each retired guard requires an explicit typed/domain replacement. Exact reference,
identifier/line/digest syntax, redaction and terminal escaping stay. No blanket
regex deletion. Receipt host/effects/currentness and B61 runtime machinery stay
with existing owners; pending preconsent admission and original failed controls
remain open. Current duplicate coverage consent is not solved by a new field view.

Protocol mode/version must be pinned in the existing job boundary with explicit
legacy handling and independent old-reader compatibility. Model-facing arguments
cannot set actor, accepted/verified status, authoritative revisions or recovery
rights. New protocol records may not silently fall back to prose inference.
The narrow Owner permission for versioned proposal/confirmation/input/inspection
records does not silently approve the old pending shared grant design.

Development proof proceeds from encoder/decoder and production-handler controls
to native save/restart and small public CLI flows. Preserve original regression
failures and map any protocol fixture changes independently. Required cases:
prose invariance, wrong value/target/ref, exact correction fidelity, blank/missing
and partial literal handling, Enter != Yes, zero inference for local edits,
stale/concurrent/late submissions, dependencies, restart/Replace/cancel, extra
changes and interrupted saves. Refund semantics remain a pending/unsupported
synthetic case where capability is absent; separate supported threshold/quorum
fixtures establish positive flow, not substituted refund behavior.

No freeze until integrated foundation and complete applicable full/type/live-DB/
offline/package gates plus independent installed acceptance. Primary candidate4
plus one conditional replacement only. Luna remains35USD total including all
holds; only existing focused edit and final rehearsal slots. Paid admission is
currently CLOSED. Early immutable DEV focused edit requires independent protocol,
privacy, consent, save/recovery and admission acceptance; final rehearsal requires
accepted installed successor. Tester alone may operate paid calls; no new samples.

B64 native Read scope slice (development, not publicly enabled): the existing
OperatorQuestion v2 owns the typed scope proposal and explicit decision;
missing-answer mode retains its actual owner handoff/raw answer and cannot
confirm the full scope. Review mode has no fabricated raw answer or answered
handoff. The native generation owner checkpoints the actual completed proposal
as read_scope/scope_proposal before waiting. Existing Resume CAS saves questions,
actual consumed generation and decisions. Replacement links retain preceding
records; cancelled or pending successors never resurrect an older Yes.
The owning review must recheck current analysis, Source/reference inventory and
applicability after waiting. The current WIP checks exact analyzed/view identity;
production reference/currentness wiring and independent native acceptance remain
open. This does not add a provider allowance, meaning store or activation path.


B64 controlling Owner decision (2026-10-08): no legacy English scope path.
The prior explicitly tested legacy handling allowance is historical. No customer
jobs exist to preserve: pre-B64 saved authoring setups must refuse with
"This setup was saved by an older version. Start a new setup." They must not be
interpreted or migrated. Delete read-requested-scope.ts and every English-reader
caller; keep only exact typed identifier validation. Model language interpretation
feeds typed scope, current native evidence and explicit operator review. Missing
or invalid protocol/context never selects English interpretation. Parser-only
tests may be removed/replaced with a compact removal inventory; privacy, omission,
scope and authority invariants require typed replacements, not weakened assertions.
The same no-legacy-copy rule applies to edit-intent/reply classifiers during Action
migration. Frozen candidate3, historical evidence, paid jobs/holds remain untouched.
Before this decision Main's 7 zero-English-call characterization controls already
passed on current structured paths (success/failure/missing context/unresolved),
so that result is not claimed as a reproduced English leak. Their temporary patch
and log remain /var/tmp/synapsor-b64-main-owned/evidence/english-scope-*; deletion
and fail-closed typed routing now replace defensive legacy gating.
