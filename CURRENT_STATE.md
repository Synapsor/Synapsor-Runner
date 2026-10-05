# Current project state

Checkpoint: 2026-10-05 UTC. **Unfrozen development; final installed acceptance is pending.**

## What Synapsor Runner is

An OSS MCP safety layer for PostgreSQL/MySQL agents: reviewed business Reads/Actions, proposal-first writes, approval outside the model, guarded execution and durable evidence. The model sees four tools: `app.describe_data`, `app.explore_data`, `app.describe_actions`, `app.request_change`. It never receives raw SQL, approval or apply tools.

## Architecture relevant to this work

The CLI authoring flow turns policy text and operator answers into disabled Read/Action drafts, then performs BUSINESS review and explicit activation. The new conversation layer separates assistant question wording, captured raw answers, typed interpretation, Runner-owned business readback and explicit operator confirmation. Source/context bindings, provenance, currentness and compare-and-swap persistence remain host-controlled. Unknown answers remain pending; cancellation and uncertain model consumption retain durable fences.

Main implementation is in `apps/runner/src`; runtime tools in `packages/mcp-server`, metadata in `packages/schema-inspector`, control/evidence persistence in `packages/proposal-store`, guarded writeback in `packages/postgres` and `packages/mysql`. Source databases remain authoritative.

**Work in this checkout**, not the older primary checkout:
`/home/sandesh-tiwari/.codex/worktrees/b36-scoped-private-evidence/synapsor-runner`

Branch: `codex/b41-operator-resolution-20261001`.
Product/test HEAD: `db67a64ed907db189aa2a208b0f14325d80ed58e`, pushed to verified PRIVATE `backup` (`Synapsor/Synapsor-Runner-Backup`). Earlier WIP commits `9542de71` and `3c9d419f` are retained. No freeze is implied. Other worktrees contain no identified unique current tracked implementation; historical branches/evidence remain separate.

Evidence directory **E**:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-reliability-20260930/authoring-dead-end-lab-20261002/operator-conversation-470`

## Files/components changed

44 product/test files since `47a57ec0`; exact inventory: `git diff --name-only 47a57ec0..db67a64e`.

- Conversation/controller/model: `authoring-operator-question*.ts`, `authoring-input-policy*.ts`, `authoring-version-conversation.ts`.
- Public CLI/readback/resume: `boundary-commands.ts`, `boundary-authoring-chat.ts`, `boundary-authoring-resume.ts`, `boundary-cli-picker.ts`, `terminal-prompt.ts`, `guided-scope-admission.ts`.
- Authoring/provenance/recovery: `action-rule-authoring-checkpoint.ts`, `action-rule-model.ts`, `action-work-unit-source-assessment.ts`, `authoring-generation-recovery.ts`, `authoring-owner-handoff.ts`, `authoring-policy-source.ts`, `authoring-prepared-policy-review.ts`, `authoring-retained-duties.ts`, `authoring-tool-call.ts`, `model-ask.ts`, `read-workload-model.ts`, and corresponding regression tests.

## Implemented

- Read-meaning, Input and Version operator conversations with typed interpretation, exact host readback and explicit confirmation; focused mapping receives bounded relevant identity/provenance rather than a full Source dump.
- Saved Input Review uses the conversation controller. Pending Input decisions and confirmed-answer reuse preserve their distinct states.
- Durable blank Resume, terminal interpretation boundaries, answer provenance, precise whitespace/UTF-16 readback and sanitized transcript rollback.
- Fully consumed coverage is checkpointed before cancellation; fenced Resume does not create a requestless iteration; fresh repair reservation follows genuine turn creation.
- Each decision's details view uses its own prompt/context or explicitly bound complete details. Unrelated cached client/Version text no longer substitutes for the current decision.

These are implemented and tested at stated development scopes; whole-program/installed correctness is not yet established.

## Verification completed

- Latest affected-source rerun: **731 passed, 0 failed, 1 existing live-provider skip**, 20 files; explicit TypeScript build passed. Selected CLI controls: **51 passed**, 363 unselected.
- Independent tester's current-details review: five real terminal probes passed, including original failures and a new withheld Version variant. Evidence: E/`MAIN-INDEPENDENT-DETAILS1191.json`.
- Earlier listed source causes have original and independent unseen-variant passes at their recorded scopes: E/`COVERAGE-CAUSES.json`. Do not treat older aggregate fields as current whole-package acceptance.
- Focused request sufficiency: seven Read/Input/Version families in both serializer modes, 14 positives and eight missing/hidden-data refusals. Broader helper audit: 14 families/23 controls. External expected Action/full-review ASTs remain labelled derived-oracle evidence.
- Helper: harness controls, isolated component execution/receipt checks and package launch/metadata smoke passed. Installed question flow remains unestablished.
- One real Terra diagnostic completed question → natural answer → mapping → Runner Input readback → explicit confirmation/save. Its next held operation is Class C fenced; no continuation or fifth diagnostic is authorized.
- **Full suite1194 remains running at checkpoint:** PID 1040626, one worker, normal 20-second test/hook limits, isolated network/HOME/TMP. Read E/`settled-source-full1194/{PROCESS.json,EXIT.json,results.json,RUN.log}`; absent EXIT is not PASS. This is standalone Vitest, not the entire package gate.

## Current bugs/blockers

- No final freeze or independent installed/F3 acceptance. Current-details source acceptance does not cover the whole lifecycle.
- Remaining Q04/Q07/Q08/Q16 integration, coherent journey B (both Actions/quorum/shared rules), connected-client rule edits, current F3/privacy traces, and original full50/all12 → review/publication → edit37 → removal43 → restart remain incomplete.
- Historical full50 partial operation126 and other Class C descendants stay fenced. Do not clear/replay them or import partial drafts into a supposed clean run.
- Connected-client A plan has agreed fictional facts/oracles, but fresh complete restore, role-collision checks, current public revalidation and sufficient review responses remain undone: E/`helper-harness-smokes1160/connected-rule-edit-prep1189-v1`.
- Current 20/50/64 final-request size measurement and final PostgreSQL/offline/package gates remain pending. Preserve complete Source/contracts; no limit increase or silent truncation.
- Prior full1192 aborted after a launcher admission error; preserved as harness failure. Corrected `shared-dev-command-launch1193.py` requires positive resource admission and existing environment directories.

## Decisions in force

- Existing independent Tester chat: `01a0bcb8-0925-7380-911a-8bab207b9e0b`. Tester owns oracles/unseen variants/installed verdict and all paid operations; Main makes no provider calls. Helper `action_gap_prepare` is implementation support, not a substitute reviewer.
- Generic fixes only: failing-first, blast-radius regressions and independent unseen variants. No fixture-specific product logic or weakened expectations. Preserve failed evidence.
- Commit product/tests together and push each DEV checkpoint to verified private `backup` only. Never commit root `synapsor.runner.json`, credentials or private fixtures. No force-push/rebase/squash.
- Caps: campaign **$70.31628470**, retest **$50.64**, lab **$8**, protected full50 **$20**, maximum $40 new exposure from its recorded anchor. Last liabilities: campaign **$37.063564975**, retest included **$17.384217375**, lab **$1.177714375**. Reconcile durable ledger before any send; retain holds.
- 800 inference/100 count per journey; historical counters remain. Recorded ledger: 391 inference/43 count; retest historical 266/800; recovery 2/6, Class B 2/3. These have different scopes—do not reset or conflate them. One chargeable request globally; rolling 1.25× reservations.
- Storage **40 GiB maximum**, free-disk floor **8 GiB**. Remeasure before fixtures. No pruning/deleting indexed evidence or uncovered resources.
- Product cutoff **2026-10-06T17:00Z**; final deadline **2026-10-07T17:00Z**. Conditional final extension to **2026-10-08T05:00Z** is preapproved only if needed for installed acceptance/full50; unused.
- One integrated freeze plus the existing conditional replacement; fallback `8fc487da` retained. Post-freeze Terra and full50 require independent acceptance/F3 and joint preflight.

## Explicitly rejected approaches

No replay/reclassification of partial Class C work; no new reconciliation framework. No model guessing business meaning, invented answers, automatic confirmation, model-filled private amounts or new private Read access. No hidden-oracle “good model” replies. No splicing separate fixtures into a composed PASS. No repeated terminal-driver redesign: prefer source tests and a small set of real screen checks. No product edits inside frozen installations or paid samples used as repair loops.

## Exact next task and stopping point

1. Inspect full1194's process/result files; collect its actual verdict without starting a duplicate heavy suite. Diagnose any failures at their real scope.
2. Continue the agreed remaining integration checks above, coordinating resource slots with Tester. Use E/`CURRENT-PLAN1139.json`, `COVERAGE-CAUSES.json`, `SETTLED-GATE-PREPARATION1196-v2.json` and `size-current1195` for exact existing plans; do not reconstruct them from chat.
3. After required source checks: settled full/types/real-PG/ten offline gates and 20/50/64 measurement → immutable freeze → independent installed/F3 → authorized post-fix Terra → protected full50 → sealed private delivery.

Stop at completed delivery, controlling deadline, or a genuine safety/authority/financial boundary; continue unaffected offline work where permitted. This handoff does not pause or terminate full1194. No container restart is currently needed; do not restart all containers.

