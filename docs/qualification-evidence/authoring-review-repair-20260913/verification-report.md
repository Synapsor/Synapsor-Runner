# Clarification saving and evidence-aware review repair

Status: product/tests committed as `dba1800d069406e6d1e45ce3ef4e19721ef76617`; full stable verification and final types passed. All ten offline package checks passed. Installed recovery and fresh known-case trials are not yet executed. This is not a completion verdict.

Baseline: clean `9c7219d617d5347ae9ee5c2f5587a947347abbb4`, descendant of product/test `23e51b1e17c5ec22492518be6d3f6bb0d752bfe7`. The accepted installed tree `278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2` remains historical and immutable. Original Stage B remains NOT PASSED. These two cases are known-case regressions, not unseen qualification.

## Traced causes and changes

The reconstructed next complete tournament checkpoint fails in `conversation[5].answer`, produced by `rememberModelAuthoringClarification` and serialized by `persistAuthoringResume` / `buildBoundaryAuthoringResumeState`. The literal-identity regex interprets the quantifier in “tenant is exactly one …” as an identity value. The actual exact answer also survives separately in policy-source `operator_messages[2]`; `originalPolicyStatements` carries it into a later pending revision before another answer. The second deterministic reproduction uses a synthetic revision envelope with that saved statement at `pending_action_revision.operator_statements[0]`. Neither reconstruction fills the missing historical provider-response bodies.

The guard now recognizes a generic quantified role definition while retaining explicit assignment and mixed-content checks over the complete checkpoint. It assigns no trusted identity or scope. The attached-rule answer recorder validates before its separate history write, preventing prohibited input from becoming the next resumed revision's unavoidable input. Failed checkpoint writes retain their last acknowledged state; a failed revision clarification is not returned to the generator as saved progress. Existing bounded correction/pause behavior remains.

Original software calls 34/41/42 concern the exact `checks.elapsed_seconds` base column behind an inverse composite foreign-key, complete locked collection. DDL and the saved portable catalog say NOT NULL; canonical review evidence omitted non-key column nullability and the compiled field's nullable flag. Current generation-lock-bound source evidence now exposes exact column nullability, with exact pointers and binding identity. This proves the stored column, not every optional/derived expression or a nonempty collection. Existing count bounds, complete loading and policy conditions remain required. The extra saved non-null-count guard is redundant for this exact base column; the repair does not remove it or force a particular AST.

Software's whole-source assertion was repeatedly classified as a policy override after the owner clarified it. An existing non-override `operator_message_id` was accepted but dropped when coverage was stored. Coverage now retains the exact supporting statement separately, validates its provenance when reloaded, and supplies supporting interpretations for re-review only while the complete source/draft dependencies and statement still match. A source assertion remains an operator assertion, not independent database proof, row eligibility or permission to waive enforcement. Actual overrides remain separately identified.

Calls 14/21/30/34/50 cite a receipt contract that described only the control ledger. Authoring context now distinguishes the existing `runner_ledger` and `source_db` modes. Source-atomic receipts require separately reviewed source objects/grants, execution verification and worker setup. Compilation does not select or verify that setup. Independent readback is a separate verification step. No receipt-engine or runtime semantics changed.

Every product instruction/context edit is recorded in `prompt-context-before-after.patch`, linked to captured request/response hashes in `prompt-change-basis.json` and `software-call-classification.json`. Added product instructions contain no case-specific literals or rescue sentences. Supplied fixture policy/metadata remains distinct from product instructions. Both known-case context replays preserve their inputs; their provider responses are deterministic stubs, not live model verdicts.

## Completed local evidence

- Original composed candidate: both variants refused before; both save/reload after, retaining Read, Action, counter confirmations, client choice, policy reference and binding. See `checkpoint-before.json` and owned `deterministic/after/result.json`.
- Public source CLI pause/resume/answer/save/restart: historical guard replay fails at the checkpoint guard in the corrected isolated harness; both current-code sequences pass. This uses deterministic provider fixtures. See `public-before-isolated-exit.json`, its log and `public-sequence-after01.log`.
- Initial direct replay attempts stopped earlier due enclosing project configuration resolution from a temporary directory under the tracking tree. Those are harness/environment failures, not checkpoint evidence. The established private `/tmp` namespace reaches the intended path.
- New non-key-column test initially had an incomplete synthetic `ColumnInfo`; that setup error is preserved separately. Corrected fixture fails before at the missing exact evidence pointer. Generic nullable/missing/stale variants pass the expected refusal checks after repair.
- Combined authoring/resume/policy tests: 576 passed, 1 skipped, exit 0, source unchanged. The command's mistaken nonexistent `model-action-rule.test.ts` selector added no coverage; the actual `action-rule-model.test.ts` was run subsequently.
- Final focused policy/model tests: 215 passed, 2 skipped, exit 0, source unchanged. Development types: exit 0.
- Full stable suite: 6,165 passed / 461 skipped, 296 files passed / 21 skipped; complete `corepack pnpm test` exit 0 including post-test gates. Source remained unchanged; started 15:50:56Z, completed 16:11:59Z. Final types exit 0. All ten offline checks exited0 using local Spec/dependencies and an unshared network namespace; new installation freeze is next. Real PostgreSQL control-store integration remains opt-in/skipped on this authoring-only change; no adapter/control-store logic changed.

## Installed scorecard (pending one final artifact)

| Check | Current state |
| --- | --- |
| Original tournament checkpoint recovery | NOT RUN |
| Assisted tournament checkpoint recovery | NOT RUN |
| Software stopped-checkpoint recovery | NOT RUN |
| Fresh known tournament onboarding/deployment | NOT RUN |
| Tournament receipt/readback and representative outcomes | NOT RUN |
| Tournament ordinary-language limit edit / same connected client | NOT RUN |
| Fresh known software review / exact receipt prerequisite | NOT RUN |
| Software source-atomic execution / receipt / edit if ready | NOT RUN |

No runtime-core changes were made. The full suite retains the automated accounting/publication/identity/structured-save/receipt regressions. The new authoring view consumes inspector and compiled metadata; it does not change either database adapter or control-store accounting. Installed PostgreSQL business sources with SQLite control stores will be labeled separately from historical PostgreSQL-control evidence. Clock, process/version coordination, receipt mode and source concurrency limits remain those actually established, with no new multi-host or arbitrary-clock guarantee.

## Follow-up requested during this work

The independent manual retest closes Finding 8 for the accepted artifact's freight scope/Read path only: correct carrier binding and five permitted rows, other carrier excluded. No writer, worker or execution was exercised. Finding 9 remains a separate queued task: expose the existing reviewed counter operation without a model, preserving explicit choice between `rev_no` and `weight_kg`, source-owner maintenance confirmation, current metadata validation, disabled mapping save and separate activation. It is not a new Stage A condition or current repair scope. Create that task after this repair's closure; see `queued-counter-follow-up.json`.

Preservation checkpoint: the first strict comparison retained its exit1 because the independently updated `FINDINGS.md` differs from the starting manifest. The exact original/current hashes and user-reported provenance are recorded in `external-finding-update.json`; all other132284 entries match. Subsequent checks keep this explicit delta and require the updated file to remain exact, rather than replacing the baseline or claiming it never changed. The full accepted7569-entry installed tree was independently recomputed here at16:18:04Z and remains278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2.
