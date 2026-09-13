# Reviewed local clients: final local Stage A report

The **named local Stage A matrix PASSED** on the single installation below. All required rows ran; none is failed, blocked or unrun in the final scorecard. This supports review/acceptance of this bounded local milestone. **Stage B remains NOT STARTED.** It does not establish a new unseen Gate 2 result or production readiness.

Shared-context rows depend on the local-client setup code written during this assignment. Its own regressions are feature evidence, separate from the installed Stage A observations. This setup code has **not been independently exercised outside this task**.

## Exact source and artifact

- Baseline: `8d642704f8a96e87bba9a3338b96621cf213843d`, branch `codex/tui-safe-action-control-plane`; no reset and unrelated `.claude/` work preserved/unopened.
- Retained ancestors: structured-save `318f1fb170c300fc533f0dea9ab873f3eef9a5cd`, checkpoint `c82b01420a1aca785c4567af709242424ce5d809`, accounting-time `a2b6b5f`, publication-order `b16f92a`.
- Reporting repair: `05d40e2de94b00cd66d54c7fd86ac1f018d610d3`. Named setup: `6ebc4d6ce1ebfd92aa9b7ab0550a0b6d0d505981`. Final product/test revision including exact named handoff guidance: `23e51b1e17c5ec22492518be6d3f6bb0d752bfe7`.
- Frozen source checkpoint: `66adb954d5a2cdf7419d727f7c551740e6da7b5d`. Subsequent changes are qualification harnesses/reports only. All 947 recorded product/test/source files remained unchanged through the stable suite, packaging and installed matrix.
- **Complete installed tree SHA-256:** `278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2` — 7,569 entries, frozen 2026-09-13T06:21:23.221Z.
- Manifest SHA-256: `d3defd6057ab46150736339a2f08a47ca20864eb86a1d293d4d308ceb7625103`.
- Archive SHA-256: `b363f9ea100ef3da9ee1cd71a12d3835ee0a297d7973507f7402036888e4fdf0`.
- Installed lockfile SHA-256: `842f9b3e4026839ff3cf03204249abea8e0b3e86d72d10a2b28625c71b6830f7`.

`final-artifact.json` records full Runner/Spec tarball, Node and entrypoint provenance. The complete immutable installation, lockfile, local Spec 1.11.0, dependencies, full manifest and archive are under the owned root's `frozen/` directory. Runner's version string 1.8.0 is not used as artifact identity. The final tree was verified unchanged after execution. Product/test, frozen source and final evidence/delivery revisions are distinct; the last is recorded in the delivery receipt.

The earlier installation `ee313994a4a542915f5ad9efca04ed29a027b5b86f8b6c717df7a451a786266f` and its 6,134-pass/461-skip result remain prior-build evidence. The development bundle `5243116fa662c206cc90c4a3d441a12b4beb33761d5b57e5f645a2727e95c8e3` remains explicitly unqualified.

## Implemented public setup and lifecycle

Run `synapsor-runner action review --project-root .`, open the verified Action boundary, and choose **Continue client setup** → local stdio → the managed client → **Review a new named local client revision**. Enter a nonsensitive label, review hidden synthetic identity values, and confirm the exact project/identity contract and shared deployment/ledger. Saving and installation have separate explicit confirmations. The resumed `start` handoff uses this same implementation. The generated client entry selects the exact reviewed reference; MCP requests cannot select identity.

The existing `.synapsor/local-test-runtime.json` default remains compatible. Named references use constrained label plus immutable reviewed document digest, separate private files and separate managed entries. Creating a new reference preserves existing identities, entries and authority. Path containment, owner/private-mode checks, exact project/Read binding validation, role/environment binding validation and environment mismatch refusal remain enabled. Missing, changed or retired references do not fall back to default.

Values change only through a new exact review/revision. Explicitly stop/relaunch the intended client to use it; an old reference never resolves to new values. **Retire future launches** records a permanent marker and refuses new launches/reselection. Already-connected clients retain cached context until stopped; this is not immediate revocation. The installed check observed that behavior, then closed the old client, verified future-launch refusal and used the existing exact `mcp uninstall ... --local-client <reference>` control without affecting the other entry. Uninstall alone neither retires a reference nor stops a process. No profile operation cancels requests, refunds budget, requeues work or changes source rows/business authority.

Creation and registry mutations use existing shared runtime admission followed by the project authority mutex, with exact contract revalidation and atomic/exclusive persistence. Tests cover default compatibility, two references and entries, declined review, failed/concurrent save, independent-process concurrent registry installs, restart, stale project/contract/reference refusal, file protections and replacement/retirement. This remains operator-managed local development, not production authentication or a session service.

Fifteen final-artifact public create/install/launch runs passed across owned fixtures, including four clients in the final shared fixture and two separately reviewed revisions of one label in the lifecycle fixture. All nine project doctors and applicable named diagnostic/own-read/restart prerequisites passed. The four shared clients read respectively 27, 1, 1 and 3 permitted rows before scheduling and after restart. Profile setup preserved existing authority/history/queues. Generic project doctor evidence and exact named launch diagnostics are labeled separately.

## Stable source and backend results

| Check | Completed result | Evidence |
| --- | --- | --- |
| Final full stable suite on 23e51b1 | **6,152 passed, 461 skipped; exit 0**; 296 files passed/21 skipped | `stable-full02-exit.json`, complete log, `stable-full02-source-after.json` |
| Earlier same-assignment full on 6ebc4d6 | 6,151 passed, 461 skipped; exit 0; historical before handoff wording refinement | `stable-full-exit.json` |
| Final types | exit 0 | `final-types-exit.json` |
| Combined accounting/publication/migration/lifecycle/setup | 248 passed, 16 skipped; exit 0, eleven files | `combined01-exit.json` |
| Real PostgreSQL **CONTROL store**, final explicit integration gate | **41 passed; exit 0**, three files | `postgres-gate02-exit.json`, host evidence index |
| Offline checks | **all ten exit 0**, including new packed offline installation and local Spec | `offline-package-plan.json` |
| Complete installation freeze and final verification | exit 0, matching full tree/Node/manifest | `freeze-exit.json`, `final-artifact-verification.json` |

The full suite ran unchanged source from 05:50:30Z to 06:11:00Z. The final PostgreSQL gate ran separately, 05:50:31Z–05:52:40Z. No targeted results are folded into the full-suite count. `final-skip-summary.json` records all 461 skips by file; opt-in coverage is not silently claimed. Both full-suite and PostgreSQL run budgets were used (2/2); no third run occurred. The earlier first PG gate also passed 41 and remains separate evidence.

Normal SQLite discovery retains the last-slot/time and publication regressions, including replacement-first, admission-first, inactive authority, unchanged/disabled/failed-publication controls and cleanup. The explicit PostgreSQL gate retains real control-store writer serialization and exact current revision checks. PostgreSQL business rows with SQLite control storage are the installed topology below, not evidence for a PostgreSQL control-store deployment. Prior migration findings/repairs were not reopened as new implementation work.

## Single-artifact installed Stage A scorecard

Every row below uses tree `278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2`. `installed-scorecard.json` carries exact revisions, durable counts, receipt byte hashes, observed waits and private raw-result paths/hashes. `installed-evidence-index.json` links complete per-fixture evidence manifests. All final runtime and operator wrappers exited 0.

| Required row | Result and scope |
| --- | --- |
| Reviewed contexts and lifecycle | **PASS**: public setup/installation, four tools, own rows and restart, shared canonical contract/ledger, fixed revision replacement and future-launch retirement |
| A1 identical requests, execution, receipt/readback, replay/restart | **PASS**: actual subject-mutex wait, exactly one new proposal/approval/queue/receipt/source effect; stored applied receipt reverified one row; exact independent reserve/version readback; replay and restarted MCP return completed verified receipt with unchanged durable state. Two calls in one MCP process, then restart; not universal exactly-once |
| A2 different principals, same insurer | **PASS**: distinct eligible subjects, real writer contention, two counted approvals → exactly three; one automatic approval and one persisted unapproved human-review proposal without executable queue permission |
| A2 same-principal control | **PASS** in separate unchanged 40-row fixture/default client: two → three under two-process real writer contention |
| A2 joint limits, ample capacity and history retention | **PASS**: exhausted insurer requests human review while five overall slots remain; ample concurrent requests both approve, five → seven; two legitimate approvals remain counted after explicit cancellation of their unstarted executions |
| A2 last overall allowance | **PASS**: seven legitimate approvals distributed 3/2/2; two contenders with insurer capacity finish at eight, distributed 3/3/2, with one automatic approval and one persisted review-pending loser |
| A3 portfolio collection | **PASS**: required human reviews, two worker processes overlap, first effect waits on real PG transaction lock; worker concurrency remains one. Exact receipts: one applied/reverified row, one failed/refused zero rows. Independent source: 60000+30000=90000; other rows unchanged |
| A3 owned source update | **PASS**: real worker source wait before owner commits portfolio close/version increment; one failed/refused receipt with zero rows; source matches only the owner change |
| A4 own/cross configured contexts | **PASS**: four exact own-request replays work; five cross-principal/insurer attempts return SUBJECT_REFERENCE_UNAVAILABLE; all 42 ledger tables and source unchanged across cross-context refusals |
| Connected-client exact reviewed insurer limit edit | **PASS**: disabled structured save, explicit Read/Action publication and separate execution review; insurer maximum3→1, overall8 and unrelated semantics retained; same client stays connected, fresh distinct subject reaches human review; prior approvals remain counted |
| Old unstarted work after edit | **PASS**: normal owned worker exits0 without dispatch; old queue has attempts0/no lease, no new job/receipt/source effect, retained approval history. Already-dispatched behavior not exercised by this row |
| Installed admission-first | **PASS**: legitimate second approval commits while old revision is current, remains recorded/counts after replacement, fresh distinct subject human-reviewed |
| Installed genuine replacement-first | **PASS**: held old source-fact response; real operator replacement commits before authoritative admission; old request returns SEMANTIC_ACTION_UNAVAILABLE, retained pending proposal but no new approval/queue/consumption/source effect; history remains one |
| Truthful late refusal and duplicate controls | **PASS**: text acknowledges possible unapproved proposal; same-subject fresh-reference retry returns PROPOSAL_ALREADY_EXISTS; different valid subject uses current policy and reaches human review |
| Existing operator recovery | **PASS**: exact pending proposal rejected through supported public proposals reject, then a new own reference/same subject reaches current-rule human review; no approval refund or source effect |

A2 uses real product `BEGIN IMMEDIATE` serialization: both processes reach definitive admission, first writer holds exclusion, an independent write attempt receives SQLITE_BUSY, second product writer waits, then proceeds after release. Admission timestamps were observed after writer acquisition and held coordination. This is a read-only debugger observer with bounded pauses against the unchanged installed bundle, not modified accounting or serialized request delivery. A1 separately observes a per-process subject mutex wait.

A4's stored references have matching Read/generation/workflow metadata. Same-insurer clients differ in principal-scope fingerprint; cross-insurer clients differ in tenant-scope fingerprint. Current `assertObservedSubjectMatchesClaim` rejects those mismatches before source facts. This attribution combines stored metadata, successful own replay, the public reference error and source ordering; individual predicates were not instrumented. No claim is made that every deeper row-scope check ran.

The installed replacement-first barrier holds an asynchronous source-fact response; it is not a SQLite database writer wait. The real PostgreSQL control-store tests separately observe their actual advisory/schema writer ordering. Both installed orderings have real reviewed publication and exact revision records; disabled save is not counted as publication. The documented structured flow is retained with both `onboard db --draft` and `start --draft` in these final-package checks. Read dependency rebinding includes only the recorded canonical kept-out-field set ordering; unrelated policy conditions remain unchanged.

## Reporting correction and established recovery

Before repair, strict SQLite replacement-first/inactive tests retained an unapproved pending proposal while the message claimed no proposal was created. Both new before assertions failed on wording; approval/queue safety held. The public code remains compatible. The final installed late refusal says:

> Runner could not prove this reviewed outcome from current authoritative facts. No source change was executed. An unapproved proposal may remain; ask the operator to inspect existing requests before retrying.

The late path leaves one pending proposal, no additional automatic approval and no executable permission. A fresh same-subject reference still returns `PROPOSAL_ALREADY_EXISTS`; that duplicate guard remains intact. The report does not promise a blind retry succeeds.

An existing supported operator remedy was verified in the owned replacement-first fixture: inspect the recorded proposal with the existing `proposals list` / `proposals show <id>` controls, then explicitly reject the exact unapproved record with:

```bash
synapsor-runner proposals reject <exact-unapproved-proposal-id> --yes --reason "Reviewed reason" --config synapsor.actions.runner.json --json
```

The test executed rejection, observed state `rejected`, re-explored normally and submitted the same subject under a new reference. It produced a new pending human-review proposal under the replacement. Earlier committed history stayed counted. This is an operator rejection route, not automatic recovery, cancellation of dispatched effects, requeue or refund. `proposals list/show` are source-confirmed inspection commands; this schedule specifically executed the exact rejection and follow-up request.

## Preserved attempts and fixture corrections

Historical strict accounting/publication failures, prior stopped qualification results and prior packages remain unchanged. `verification-report-before-matrix.md` preserves this assignment's interim report; `test-attempt-notes.md` retains every earlier focused/development correction.

Two installed harness mistakes remain saved separately:

1. Lifecycle attempt1 successfully retired the reference and refused future launch, but expected an internal retirement code in a public diagnostic that correctly wraps it as COMMAND_REJECTED / MCP_LAUNCH_CHECK_FAILED. The original terminal/result/store remain preserved. A fresh lifecycle_02 fixture passed the corrected public-layer assertion, without product edits.
2. Shared attempt1 passed different-principal last-slot and joint controls, then reused a consumed subject reference with different inputs while creating history after explicit worker cancellation. The stored reference state and actual two requests corroborate SUBJECT_REFERENCE_UNAVAILABLE. The corrected harness re-explores normally before each distinct history request. Fresh shared_02 reused the declared 44-row preparation, repeated A1 to establish its legitimate second approval, and completed all remaining shared checks. No failed store was repaired/repeated in place. `shared-matrix-attempt01-finding.json` preserves the exact explanation and hashes.

All final baseline restores preserve the original 40 rows, schema and unchanged8/3 rolling policy. Only shared and its fresh shared_02 copy add one valid third-insurer portfolio and three claims (PF-OVERALL-THIRD, CL-1001/1002/1003), totaling44. `fixture-baseline-index.json` records each pre-schedule source hash. No additional synthetic records were needed. The final shared clients use **one** canonical project, deployment and ledger. Their profile IDs do not enter canonical history selectors. Independent fixtures for other test cases are not claimed to share one global allowance.

History is established through normal requests: original legitimate approval, A1 approval, insurer contender winner, two second-insurer approvals with reviewed unstarted cancellation, two third-insurer ample-capacity approvals, then the final overall winner. Proposals, human reviews, queue items and reservations are not counted as automatic approvals.

## Environment, limits and closure

Only synthetic owned PostgreSQL17, its private Unix socket, whole-directory isolated project restores and installed dependencies were used. The container had network-none and no published ports. Application/test environments retained private writable /var/tmp, NO_COLOR=1, controlled HOME/umask0077 and only intended database values; unrelated/provider credentials were absent. Effective-store preflight ran before writable application opens. Originals and frozen packages were read-only in task processes; saved excess-approval queues were never executed.

Accounting retains inclusive rolling86,400-second semantic shared limits. The separate legacy day-period accounting remains a UTC calendar bucket; no clock redesign occurred. Committed automatic approvals consume capacity for the rest of the window even when cancelled, stuck or never executed, reducing future automatic capacity until expiry. No refund/requeue feature was added.

The admission invariant still assumes any prior committed approval has a timestamp at or before admission time selected after writer acquisition. Backward clock steps, unsynchronized admission-process clocks and mixed versions can break that assumption. No arbitrary clock-skew guarantee is established. All cooperating admission/publication processes must upgrade/restart; passing new-code schedules do not qualify mixed versions. Existing five-second local gate/authority/SQLite writer and PG publication row-lock attempts, plus preceding ten-second PG advisory attempts, are bounded lock attempts, not a universal end-to-end I/O or infinite-load fairness guarantee.

Receipts are local stored semantic-rule execution receipts, checked by canonical bytes and independent source readback. A3 proves process overlap and actual source waiting while normal effect concurrency remains one; it does not establish simultaneous worker effect transactions. No production authentication, multi-host durability, universal exactly-once, self-serve onboarding or unseen-domain qualification is claimed.

Declared budgets were preserved: full2/2, PG2/2, offline1/2, freeze1/2; 241 total development/preparation/runtime operations of600, six workers of24. Timed matrix began06:43:27.613Z with deadline08:43:27.613Z; each case stayed within two schedules. Original overall deadline11:39:41Z was not reset. No unrelated product repair loop was started.

All106,690 original entries and the complete7,569-entry candidate were verified unchanged. Seventy complete logs and eleven owned database dumps were saved before cleanup; all250 recorded test/application/controller PIDs were gone. Only container synapsor-reviewed-clients-36250d48 was stopped (not removed), exit0; source/ledger/failure directories remain available. Cleanup receipts are in the owned `cleanup/` directory. No public release/deployment occurred.

Exact commands: `reviewer-commands.md` and each exit manifest; raw private state: the owned root recorded in `assignment-plan.json`. The next decision is independent review of this bounded Stage A result and the newly introduced local setup dependency. No required local row remains outstanding. Delivery is only to the verified private backup remote, with the final report commit/ref recorded separately. **STOP for review; Stage B NOT STARTED.**
