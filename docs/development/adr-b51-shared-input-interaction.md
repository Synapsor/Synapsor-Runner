# ADR B51: share the Input interaction boundary

Status: Owner approved one Input-only implementation slice; development and
independent acceptance are in progress on the separate B51 branch.
Source inspected: `62e4bf54c3cb6ab9f58f423991f0c121d6e760ad`.
T0: 2026-10-06T14:31:23Z. This work follows frozen candidate1508 and
independent Tester installed acceptance starting. Demo verification has priority.
The frozen candidate remains unchanged. All same-connection live-edit work is stopped.

## Decision

Keep the existing Input controller and durable records. Extract its CLI host
transitions into one production adapter, and derive typed interaction views from
those records. The CLI and an internal headless test adapter must submit responses
to the same handlers. The next slice covers Input in onboarding and editing only.
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
this case and the unchanged healthy control; independent replay is pending.

This is a development checkpoint, not accepted delivery. Selected-baseline
editing, independent route verdicts, final gates and installed acceptance remain
required. The earlier 88 assertions
retain their limited scope. Controlled successful replies in the new restart
fixtures derive references from actual transmitted frames and declared answers.
Version blank/unknown handling already exists; the added Version raw-save
interruption work is characterization only, with no Version product change.
