# Structured draft save repair: final bounded verification

Named repair and installed checks are complete. Cleanup is complete; the exact private-backup delivery receipt is stored separately after commit. Stage A NOT PASSED; Stage B NOT STARTED. This continues d422ca5 and preserves historical failures, including the old publication/accounting stores, the prior full-suite6097/21/461 failure, and this assignment's own failed attempts. Chronological checkpoints remain in verification-report-checkpoints.md.

## Product correction and retained boundaries

Product318f1fb170c300fc533f0dea9ab873f3eef9a5cd contains initial1c4c22a execution-context plumbing plus input-validation ordering. Only boundary-structured-authoring.ts changes product behavior: structuredBoundaryAuthoringCommandInner, persistStructuredDraft, and structuredExecutionContext. OperatorAuthorityRepository.currentState(false) legitimately validates existing active/draft execution using parseOperatorExecutionPolicy; the former caller passed no runtime configuration, causing POLICY_EXECUTION_CONTEXT_REQUIRED. Both original installed spellings reproduced export/preview success then save exit2 without changing independent ledger/config/source snapshots.

The repaired path reuses resolveSynapsorProject and readLocalExploreRuntimeConfig, including managed Action-companion selection, actual project/store and executionBindingDigest checks, and existing missing/mismatched/ambiguous/stale refusals. An edited draft supplies no runtime, execution or identity authority. Current execution is validated against its existing configuration; the replacement is saved DISABLED. Active Read/Action/execution, approval history, queues/receipts and business rows remain unchanged during save. read_authoring management/review bookkeeping and disabled candidate records legitimately change. No stored execution means no new writer/client/runtime prerequisite for ordinary disabled drafting.

Bounded local input read/structural validation precede runtime-gate creation. Valid export/preview then preflight existing context; final save reloads after preparation under runtime shared admission, project authority mutation, then the existing repository transaction/epoch CAS. Source metadata and compilation remain outside the small save section. Competing revisions/configuration and unconfirmed commits retain existing refusal/recovery. No global optional validation, stripping execution, fake review, config flag, alternate store, new model tool or changed identity enforcement.

Accounting a2b6b5f, publication b16f92a, migration fixture3be534f and composed fixture03e3f44 remain ancestors. retained-boundaries.json hashes verify unchanged accounting, publication/runtime gate, policy store and local identity files. Existing dispatch, exact authority, private dependencies, consent, scope/effect/receipt and replay checks remain enabled. Clock and all-process upgrade assumptions below remain limitations.

## Source verification and attempts

| Check | Actual result and identity |
|---|---|
| Before installed onboard/start | Export/preview0; save2 POLICY_EXECUTION_CONTEXT_REQUIRED; unchanged independent state; old tree b2ec50... |
| Initial execution-backed regression | Same omitted-context failure; genuine repository/parser/active execution fixture |
| Final focused structured suite | execution-after04:33 passed, exit0; both command spellings;16 real execution-backed cases |
| Existing malformed-input assertions | cli-invalid-after:2 passed,157 filtered out, exit0; assertions unchanged |
| Types | types04:tsc -b --pretty false exit0; types03 root-only noEmit is explicitly not a whole-project check |
| Combined | combined01:481 passed/223 skipped,18 files, exit0; two nonexistent filters disclosed, no fabricated selection |
| Separate recovery/lifecycle | publication-recovery01:23 passed; lifecycle01:16 passed; both exit0 |
| Real PostgreSQL CONTROL gate | postgres-gate01:41 passed exit0 via verify-publication-accounting-postgres.sh; recorded source manifest; these accounting/publication components were unchanged by the later input-parse correction |
| First full suite | stable-full on1c4c22a:actual test exit1,6132 passed/2 failed/461 skipped;295 files passed/1 failed/21 skipped |
| Final full suite | stable-full02 on318f1fb:actual exit0,6134 passed/461 skipped;296 files passed/21 skipped;1198.59 seconds |
| Offline checks | All ten exit0 on first attempt, including local package, bundle freshness, public commands and locally packed Runner+Spec installation |

The first full run exposed a genuine named preflight regression: invalid draft input created .synapsor before rejection. It finished unchanged, then318f1fb moved parsing ahead of coordination. Original failure/source/logs remain in full-suite-save-preflight-finding.md. One explicit budget amendment allowed a single follow-up full run, with original elapsed/count budgets retained; no third run. The final run's source manifest matched afterward. Earlier fixture/measurement corrections, including types03 and the original wrapper returning0 while recording child exit1, remain in test-attempt-notes.md. Test child status, not wrapper status, determines the verdict. No skipped/expected-failure conversion or timeout increase obtained green tests.

The command regression uses real stored execution/repository/compiler behavior with synthetic metadata inspection; it is implementation evidence. The following separate installed checks use actual frozen CLI/MCP/worker entrypoints and normal operator reviews.

## Immutable installation

- Source/package evidence revision: c82b01420a1aca785c4567af709242424ce5d809.
- Product revision: 318f1fb170c300fc533f0dea9ab873f3eef9a5cd; added command-test revision: 1c4c22a007ed5d7bea758e85e03e01507ada6780 (existing invalid-input CLI tests unchanged).
- Runner 1.8.0, local Spec 1.11.0, complete installed dependencies and7569 entries.
- Installed tree SHA256: ee313994a4a542915f5ad9efca04ed29a027b5b86f8b6c717df7a451a786266f.
- Lockfile SHA256: 85477733ab314a02c52ca9b0ab37b630689653a542ff28dc4a5fae74fd69a8a0.
- Full manifest: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/structured-save-repair-d422ca5-20260913/frozen/installed-artifact-manifest.json; archive/tarballs stay in that owned frozen directory.
- All five installed entrypoints matched the offline-tested build. The entire installation was verified before fixture creation/application starts and after installed schedules. It was never patched. Later harness/report changes do not alter its product bytes.

## Installed public-path outcomes

These are PostgreSQL BUSINESS rows with SQLite CONTROL storage, not the separate PostgreSQL control gate. Every copy starts from the exact original40-row synthetic insurance baseline, schema and reviewed source/writer relationships. Original roles/grants and full-directory logical mounts were preserved. No new44-row extension was made; its historical copy remains preserved.

| Named installed check | Result |
|---|---|
| Local original identity prerequisites | PASS on main/edit/edit_02/admission_first/replacement_first/replacement_first_02:doctor0, MCP startup and own allowed rows; other-insurer CL-701 absent |
| A1 identical/replay/restart + worker | PASS:one canonical proposal/approval/queue/receipt/effect; replay and MCP restart add none |
| Insurer A2 | PASS same-principal subcase:two legitimate automatic approvals become exactly3; second request completes while first facts are held; loser pending human review; no source effect |
| Exact normal same-client edit | PASS in fresh edit_02 after preserved observer failure; disabled save, exact Read/Action review, separate execution review, fresh human review at maximum1 and retained history2 |
| Old unstarted work | PASS in edit_02:reviewed worker invocation exit0, old queue remains unleased with attempts0; no new job/receipt/source effect; old approval retained |
| Admission-first / installed start spelling | PASS in admission_first:approval committed with old current Action, retained history2 after replacement, separate valid current request pending human review |
| Replacement-first | PASS in replacement_first_02:replacement committed before held old request resumed; stale refusal; history1/no new approval, queue, budget/effect admission, job or receipt; duplicate guard retained; distinct fresh claim pending human review |
| Installed overall/shared-principal A2 and A4 | BLOCKED:separately reviewed local contexts sharing the same canonical budget are not established by the existing managed-local route |
| A3 on this artifact | NOT RUN in this narrowed assignment; earlier collection/portfolio passes remain tied to their earlier package and do not establish simultaneous effect transactions here |
| Already dispatched work during replacement | NOT EXERCISED by these old-unstarted/order checks; no universal exactly-once or already-dispatched behavior claim |

A1 stored receipt 2 is applied,1 row, hash sha256:4eac416a8d80fb5b78b3766e0c88184f78fc57109440608c8edaba2255c5a1be; independent full source comparison proves CL-103 reserve10000->25000 and version1->2, all other rows unchanged. Insurer A2 history consists of the original legitimate CL-101 approval plus that normal A1 approval; neither proposal, reservation, queue nor human approval is counted as a committed automatic approval. Its contention is overlapping requests with controlled source-fact delay and naturally serialized authority/database admission, not simultaneous SQLite writers.

Normal edit used the documented literal export/edit/dry-run/submit argv with ./boundary-authoring.json via installed cli.js. Each command returned0, the saved normalized candidate re-exported exactly, the only input edit was reserve_adjustment_per_insurer_24h maximum3->1, tenant scope/window86400/overall8 unchanged. Entire unrelated catalog, private verification/effect rules, selectors and approval settings were compared. start used the same installed export/preview/save route in admission_first. This is structured JSON/operator-flow evidence, not natural-language UX qualification.

The documented boundary review --project-root . --access command was also executed. C and explicit Y activated the saved exact Read. Exiting that command returned1 ACTION_RULE_READ_AUTHORITY_STALE for the still-retained old Action; its Read activation had committed. The following documented action review opened normally and separately published the candidate (explicit Yes selection), then the existing writer check and separate execution Yes created execution revision policy:386804f0dd5d4467227c34aea6bebd95f23340c909f7aa55ed9b4f3ad2908a65. This is an intermediate old-authority refusal, not a claim that every review command exited0. The published command sequence is usable end to end; the documentation change in1c4c22a describes execution context and the separate reviews. No extra model job, unsupported --config flag or identity workaround was needed.

The exported unchanged Read normalizes only the order of kept_out_fields (same insurer_id/adjuster_id set), changing its exact fingerprint from b049393e... to a1465f6f.... Full Read pack equality with only that set ordering normalized is checked, and every Action rule must bind the exact newly reviewed Read digest. Rule/catalog/verification/effect content is otherwise exact; review provenance and digests are recorded rather than falsely asserted identical. The same MCP process remained connected throughout each edit schedule.

Normal edit Action revision: policy:82b07f1a89ac5811ac2f2dc7405424aadb987359c5deb745709999c6810c60c5 -> policy:51a13430e25c835f6c45a2a35eaf1d4efc4404b8eb02ad13a22985378a99b5f2.
Admission-first replacement: policy:50fa6a0ef9b3db8907fb53b12bf61c8ce41cd47977f92aba23d9fcb8ed8f6b33.
Replacement-first replacement: policy:022ac9a0102d982586a523215fb29443dfc31f9cdf03caddf802afc062b51f1b.
Replacement-first02 held facts at 2026-09-13T04:04:57.909Z, observed Action publication at 2026-09-13T04:05:00.499Z, then released at 2026-09-13T04:05:00.503Z. Exact Read replacement also occurred while facts were held. This installed evidence covers that actual combined Read/Action operator sequence; pure Action-only ordering remains the separately labeled host regression. It is not a PostgreSQL advisory-writer wait. No barrier is held inside exclusive admission/publication coordination.

## Preserved installed corrections and remaining issues

Original runtime/edit stopped on a read-only observer SQLite BUSY during Read publication, before observing the later Action commit. The failed script and fixture remain untouched; no worker ran there. The fresh edit_02 observer catches only ERR_SQLITE_ERROR/errcode5 inside the unchanged bounded polling deadline. It changes no product lock or request delivery. installed-observer-correction.md and installed-first-edit-policy-differences.json preserve cause/metadata evidence.

Original replacement_first passed the strict stale/no-extra-approval safety assertions, but its fresh-control assertion failed with PROPOSAL_ALREADY_EXISTS because it reused CL-103. A fresh reference does not make an already-pending subject otherwise valid. The host test uses a separate fresh subject. The second owned copy preserves the duplicate guard explicitly and uses existing CL-901 for the independent human-review control. Original expected/actual result remains a failed attempt; no third schedule. See replacement-first-followup-finding.md.

Separate unrepaired reporting finding: the late stale refusal says no proposal was created, but a pending_review proposal remains from work before authoritative admission. No approval or executable permission was added. Preserve the exact result/proposal for a separate reporting/recovery decision; no cleanup, refund or requeue feature was implemented. The primary next prerequisite decision remains shared-context-prerequisite-decision.md: the managed-local path reuses one reviewed identity file and no supported per-client common-budget review route was established. A4 is blocked, not a demonstrated row-scope failure.

## Operational limits and closeout

Stored automatic approvals consume allowance for the rest of their applicable window even if execution remains blocked or never completes. The old unstarted approval here remains counted; stuck work reduces future automatic capacity until the window rolls. No refunds. Inclusive rolling shared_limits.window_seconds and the separately documented legacy UTC-day accounting remain unchanged. Admission time is still chosen after writer/authority coordination; prior committed approvals must carry timestamps at/before that admission time. Backwards clock steps, unsynchronized admission-process clocks and mixed versions that timestamp earlier can break that assumption. No arbitrary clock-skew, multi-host durability or new starvation guarantee is claimed. All cooperating admission/publication processes must use the repaired versions/restart; mixed-version coordination is not established.

The save defect is reachable by an ordinary operator using the documented flow on a project with stored execution; no timing instrumentation is needed. Earlier publication races are likewise reachable during normal live edits while clients are active; deterministic local delays establish order, not special client privileges. Existing local shared-store/process limits from the publication report remain applicable.

Private writable /var/tmp, NO_COLOR=1, controlled HOME/umask0077 and absent provider/unrelated credentials were retained. Owned PostgreSQL has network none, no published ports, an existing local image and a private Unix socket. Only database tests/operators receive its synthetic local references. All old91404 entries and historical b2ec50.../c430... installations remain preserved. Complete logs and exact commands are in reviewer-commands.md and *-exit.json; installed-evidence-index.json maps synthetic snapshots/results back to owned raw stores.

Actual runtime budget: 92 total operations (85 new-package +7 reproduction), 2 worker invocations. Normal edit2 attempts, replacement-first2, admission-first1, A1/A2 each1; clocks/counters were not reset. Both full runs, the single offline attempt and single freeze are accounted for in assignment-plan.json. Cleanup saved and validated nine owned PostgreSQL dumps, container logs and retained SQLite state before stopping only synapsor-structured-save-7ed59302. All95 recorded test/application PIDs were gone. preservation-final.json verifies all91404 original entries unchanged; immutable-final-verification.json verifies the new7569-entry installation unchanged. Private backup is verified as Synapsor/Synapsor-Runner-Backup (private, ADMIN). The exact delivered ref is recorded in the owned delivery.json after commit/push. No public release/deployment. STOP after delivery; Stage A NOT PASSED, Stage B NOT STARTED.

Delivery receipt location: /home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/structured-save-repair-d422ca5-20260913/delivery.json. No public origin push is authorized or performed. Raw logs/bundled preflight contain retained whitespace; git diff --check reports those evidence bytes, not a product-source formatting failure. They are not rewritten to hide the original output.
