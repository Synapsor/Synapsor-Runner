# Approval-time repair verification — bounded continuation closure

**Stage A is NOT PASSED. Stage B is NOT STARTED.** This continuation finished the
prepared independent local checks and stopped. Two publication-order product
failures, one full-suite failure, and unverified installed-runtime prerequisites
remain. No product behavior changed and no failed publication path was rerun.

## Source and recovered work

The checkout was preserved on `codex/tui-safe-action-control-plane`, starting at
evidence commit `a0942d1bf6e45b21cae041cc4a6ff49823908678`, whose product parent is
repair `a2b6b5f870f544ca608d7fb0e6bc834da1e27196`. No reset occurred. New local
commits `b666202` and `c0b81b8` contain tests/evidence and a freeze harness correction.
The four product-file hashes remain identical to the assignment baseline; final
harness hashes are in [final-harness-source-identity.json](final-harness-source-identity.json).
Later changes correct harness measurement and record results only.

The original full-suite process was recovered, not replaced. It started
2026-09-12 22:18:37.500629 UTC, finished 22:37:47.535927 UTC and **exited 1**:
**6,101 passed, 1 failed, 450 skipped**, across 315 files (293 passed, 1 failed,
21 skipped). No descendants remained at the continuation inspection. The complete
[log](stable-full.log), [machine report](stable-full.json), and actual command/exit
in [stable-local-plan.json](stable-local-plan.json) are retained. No retry ran.

The exact failing test is `apps/runner/src/control-policy-store.test.ts`:
`governed policy-store binding and recovery > chooses one complete binding during concurrent migration`.
Both concurrent migrations should resolve to one binding, with imported/already_imported
statuses. Actual: Promise.all index 1 rejected with `POLICY_RUNTIME_BUSY` at the
five-second exclusive runtime gate before convergence assertions. The underlying
cause is unconfirmed; this is not established as an environment-only failure or
an authorization bypass. See [full-suite-failure.md](full-suite-failure.md).

The 450 skips are individually inventoried in [stable-skips.json](stable-skips.json):
447 require database prerequisites or live-database opt-in; 3 require external
live-authoring provider opt-in. Three skipped PostgreSQL accounting cases were
separately executed below. The earlier 6,096/5/449 run and 104-test rerun remain
historical results, not this run's verdict. Types exited 0. All ten prepared
offline checks exited 0, including MCP client configurations, local runner,
bundle freshness, public commands and packed clean install; exact commands and
exits are in [offline-package-plan.json](offline-package-plan.json).

## Accounting and the stopped publication cases

The focused accounting file completed **7/7**, comprising four SQLite tests and
three real PostgreSQL control-store tests. Its earlier five-case run also passed;
these are overlapping runs, not twelve independent cases.

- **SQLite control store:** combined selectors and human-approval exclusion,
  inclusive rolling-window edge, midnight mechanism comparison, and actual writer
  exclusion using two native child processes passed. Prior failing-before/passing-after
  insurer and overall regressions remain in the original repair evidence.
- **Real PostgreSQL control store:** distinct pools contended on the real schema
  advisory lock and materialized fresh ledger state. Last-insurer count 2→3 and
  last-overall count 7→8 granted exactly one slot and left the loser pending human
  review. The ample control granted all four concurrent valid requests. A definite
  failure before COMMIT submission rolled back; retry granted once; reopening the
  store/pools with `autoMigrate:false` retained history and allowed the next valid
  grant. This is not an uncertain-COMMIT, crash, database-server-restart or multi-host test.

Commands/logs: [focused-02-accounting.log](focused-02-accounting.log). Durable
observations: [insurer](observations/pg-last-insurer.json),
[overall](observations/pg-last-overall.json), [controls](observations/pg-controls.json).
The installed insurance checks below instead use a **PostgreSQL business source
with a SQLite control store**; they do not add PostgreSQL control-store coverage.

The stopped tests originally executed as
`apps/runner/src/semantic-admission-publication.test.ts` have exact names
`publication versus admission (BACKEND) > preserves exact current authority: replacement_first`.
Their unchanged strict assertions expect the old request to return an error and
approval history to remain at one after a reviewed replacement lowers maximum
three to one. Both actual results were an approved old request and **two durable
approvals**. The subsequent fresh request was pending and stale-reference replay
was rejected; those controls do not undo the failures.

| Backend | Observed ordering | Actual result and preserved evidence |
| --- | --- | --- |
| SQLite, governed policy | Old request reaches acknowledged barrier before real admission at 22:15:10.652; replacement commits 22:15:10.750; old admission returns 22:15:10.806 UTC | Product assertion fails; proposal `wrp_rule_182d80074e330142361fbe728d9f6a83` approved. [Full sequence](publication-attempt1/publication-sqlite-replacement_first.json), [log](focused-03-publication.log). This barrier is not a claimed SQLite database-lock wait. |
| PostgreSQL, governed policy | Actual `hashtext` ledger writer wait observed at 22:16:26.419, backend PID 158; replacement commits 22:16:26.568; old admission returns 22:16:26.763 UTC | Product assertion fails; proposal `wrp_rule_ccf6709d016ebda929c5f3886adbf726` approved. [Full sequence](observations/publication-postgres-replacement_first.json), [log](focused-04-pg-publication.log). |

The first PostgreSQL attempt used the wrong `hashtextextended` lock expression,
failed to establish the required wait, and failed before replacement. It remains
a separate **harness setup failure**, not a product verdict. The corrected attempt
above was the only retry. Admission-first passed on both backends: the earlier
legitimate approval stayed counted, fresh requests used the new maximum, and old
references were refused. No worker ran in these publication tests; queued-worker
behavior across replacement remains unverified.

The exact next repair decision is [publication-finding.md](publication-finding.md).
It traces an early current-rule check followed by asynchronous work and admission
using captured limits, without an atomic check against the now-current governed
revision. Strict source is preserved outside ordinary test discovery at
`apps/runner/src/semantic-admission-publication.qualification.ts`, with an explicit
[replay configuration](publication-vitest.config.mjs). Assertions were not weakened
or converted to expected failures. Do not replay it as part of this closed assignment.

## Installed runtime results

One new installation was frozen from `c0b81b8e8a8c676a08fe495798414ca09260a6c6`, with
unchanged product `a2b6b5f`, Runner 1.8.0, Spec 1.11.0 and 7,569 entries. Five
installed entrypoints matched the tested build. The complete
[manifest](installed-artifact-manifest.json), [summary](artifact-summary.json) and
[final verification](artifact-final-verification.json) distinguish it from all
historical packages. Manifest `cases` describes preparation intent, not execution.

| Identity | SHA-256 |
| --- | --- |
| Installed tree | `c4300519538be9cb2befd08b8d99b0b897a33801cbd57f48cf4f088ea417e10e` |
| Full manifest | `bd2095615469325a3394e7ac90f9928400ed1be96b55d981618c7738e5602615` |
| Installed archive | `e7dc746906c6fb90dc4bee303e8596e51e08c6564beeb1d6d32e3431c9f0c51b` |
| Lockfile | `5b132513cb50b28819ccdc9b883c08c1b73c01766d08b91e48202d2ab934b467` |
| Runner package | `11d032f5d6f5c1cd4e9922c585a5f49d7abc3cf56b26ce208fe39e9ce919eb37` |

| Prepared check | Verdict | Evidence and limits |
| --- | --- | --- |
| A1 identical requests, execution, replay and MCP restart | **PASSED observed single-process schedule** | Actual subject-mutex wait; two concurrent identical calls create one new proposal/automatic approval/queue item. Source unchanged before worker. One stored applied receipt and only CL-103 reserve 10,000→25,000/version 1→2. Replay and actual MCP process restart add no durable records/effects. [Result](installed-runtime/main/a1-result.json), [stored ledger](installed-runtime/main/a1-executed-ledger.json), [readback](installed-runtime/main/a1-executed-source.json), [measurement corroboration](installed-runtime/main/a1-measurement-corroboration.json). |
| A2 last insurer slot | **PASSED same-principal schedule** | Two real earlier approvals become exactly three; two distinct proposals, one human-review loser; no source changes. Earlier fact response remains held while the competing request finishes. [Result](installed-runtime/main/a2-insurer-result.json), [before](installed-runtime/main/a2-insurer-before-ledger.json), [after](installed-runtime/main/a2-insurer-after-ledger.json). No cross-principal or extra installed writer-lock schedule is claimed. |
| A2 last overall slot | **NOT RUN — identity prerequisite blocked** | Only the separate third-insurer fixture was prepared; no approval-history creation or race executed. [Ownership/additions](installed-runtime/overall/ownership.json), [blocker](installed-context-blockers.json). |
| A3 competing collection requests | **PASSED observed source coordination** | Two real reviewed human approvals for CL-401/402 at 60,000; first worker's database transaction wait observed, then the second worker invocation started and the blocker was released. Worker process lifetimes overlapped; a second simultaneous database-lock wait was not measured. Exactly one applied receipt; other failed safely. Readback total 90,000≤100,000, exactly one version advance, other source rows unchanged. Existing worker concurrency policy stays enabled; this does not establish simultaneous competing effect transactions. [Result](installed-runtime/collection/a3-result.json), [ledger](installed-runtime/collection/a3-final-ledger.json), [readback](installed-runtime/collection/a3-collection-after-source.json). |
| A3 owned competing portfolio update | **PASSED observed refusal** | Worker waited on the owned UPDATE transaction; owner committed closed portfolio/version increment. Stored non-applied receipt, `SEMANTIC_AUTHORITY_STALE`, no claim effect; independent source readback shows only the owner's portfolio change. Same A3 result and [final readback](installed-runtime/collection/a3-final-source.json). |
| A4 local user contexts | **BLOCKED during setup, process exit 1** | Original identity initialized/explored. Alternate principal startup refused with `LOCAL_TEST_RUNTIME_ENV_CONFLICT`; no foreign-reference or own-positive assertions ran. [Original attempt](installed-runtime/main/a4-result.json), [stderr](installed-runtime/main/mcp-stderr.log), [classification](installed-context-blockers.json). This is enforcement of the reviewed identity prerequisite, not a demonstrated scope bypass. |
| Fresh exact limit edit; additional installed lock/replacement schedules | **NOT RUN** | Required machinery was not prepared under the narrowed continuation, or depends on a stopped failure. No new review flow or identity bypass was built. |

A1's canonical stored receipt hash is
`sha256:3727ab7947f5a5e0e2fe01e3bcc2a58ae5b64200be5d07d17afa5fa97d584ba0`.
A3's applied receipt hash is
`sha256:02981c85acc747708128dd095e289745a25dd7f00c4907eda2238d06441c25ee`.
These are read from stored receipt JSON, distinct from worker diagnostic hashes.
The [A2 baseline provenance](installed-a2-baseline-provenance.json) consists of the original legitimate applied CL-101 approval and
the new A1 applied CL-103 approval, each with a matching proposal/receipt. Neither
is a reservation, human approval, proposal-only record or queue item being counted.
The old 2→4 failure and its excess queue remain untouched and unexecuted.

## Fixtures, corrections, assumptions and closure

Main and collection start from separate copies of the reviewed recovery project,
each preserving all original 40 business rows (9 portfolios, 29 claims, 2 freezes).
The overall copy adds **only** third insurer UUID suffix 5, portfolio UUID suffix
1000 (`PF-OVERALL-THIRD`) and claims 1001–1003, with valid original relationship
structure. It has 44 rows (10/32/2). Original row values, schema, business rules
and limits 8/3 are unchanged during preparation. No approval rows were inserted.
This is an extended synthetic fixture, not an untouched original or unseen onboarding.
The [baseline and ownership hashes](fixture-identities.json) establish each pre-test identity.

All local runtime interfaces use the new installed artifact and verified owned
SQLite destinations under the original logical project path mounted onto owned
copies. The existing review, permission, policy, accounting, transaction and
execution checks remain enabled. Local operator identity is synthetic `dev_env`,
not production authentication. A4 exposed the prepared harness's incompatible
alternate-identity override; no reviewed identity file was removed or rewritten.
The overall test was consequently not attempted.

A1 showed that public responses omit proposal IDs. Remaining prepared helpers
were corrected to identify unique new proposals through read-only ledger deltas,
checking target, tenant and inputs. Exact prior helpers/hashes are retained in
[response-measurement-correction](response-measurement-correction/reason.md).
A1's response-ID equality was vacuous; its separate durable-count/receipt/effect
and restart evidence was corroborated offline without rerunning the schedule.
Concurrent request delivery was not serialized to obtain a pass.

The private writable `/var/tmp`, `NO_COLOR=1`, controlled HOME and existing offline
cache were retained. Only intended database tests received task-local database
URLs; provider/unrelated credentials were absent. PostgreSQL 17.10 came from an
already installed image with network disabled and no published ports. Two initial
socket setup failures remain separate from product failures. Offline packaging
used installed dependencies without registry access. The first freeze preflight
exposed the unrelated ignored `.claude/` directory under isolated HOME; its exact
exclusion was recorded without opening or changing it. A dump-saving size heuristic
also rejected an already-empty integration database; exit 0, complete dump footer
and zero remaining user tables justified correcting only that measurement.

[Clock semantics](clock-semantics.md): `utcDayWindow` is a UTC calendar-day bucket
used by explicit legacy `period:day` limits. Semantic `shared_limits.window_seconds`
is a separate inclusive rolling window; insurance's 8/3 policy uses rolling 86,400
seconds. Across UTC midnight, rolling grants 3 then refuses 3; explicit daily grants
3 then 3. No rolling-policy/calendar mismatch was found, and no semantics repair made.
The admission invariant remains an assumption: every automatic approval committed
before acquiring the writer lock must have a timestamp no later than admission time
chosen under that lock, with timestamps representing actual admission. Backward clock
steps, unsynchronized hosts or mixed old/new callers break the premises. No new clock
guarantee is established. A committed approval consumes allowance until window expiry
even if execution never completes, reducing future capacity; no refund/requeue exists.

The original accounting defect is reachable through concurrent ordinary public
requests for distinct valid subjects; instrumentation selects a reproducible legal
ordering, not extra authority. Single MCP process and cooperating shared-control-store
processes can encounter it. Purely sequential, read-only or human-only flows do not
exercise this automatic-admission race. Separate ledgers are separate budgets.
The publication defect additionally requires an authorized operator publication to
overlap the request; the four model-facing tools cannot themselves publish authority.
Natural incidence, unsupported shared-file deployments and multi-host behavior were
not measured. Passing subsets establish neither universal exactly-once execution
nor overall Stage A completion.

Budgets were not reset: installed checks used 24 operations (18 MCP and 6 operator,
including 4 worker invocations) and one schedule each for A1, insurer A2 and the two
A3 cases. A4 stopped before schedule execution; overall remained prepared. Work
finished within the original 90-minute runtime deadline and overall deadline.
Final states, SQL dumps and logs were saved before cleanup. All recorded MCP/worker/
driver processes had exited. Only the three verified task-owned containers and their
anonymous volumes were removed; final exits were 2, 2 and 0. New fixtures, ledgers,
dumps, frozen installation/archive and logs remain in the private owned evidence root:

`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/approval-time-stage-a-a0942d1-20260912`

See [cleanup-result.json](cleanup-result.json) and the evidence inventory. All 64,723
original protected entries were unchanged before cleanup; final preservation is
recorded in [preservation-final.json](preservation-final.json), with zero changes. No public release, deployment, external model call or new
qualification domain occurred. Remaining decisions are the stopped publication
repair, concurrent-migration failure analysis and valid reviewed identity fixtures.
This assignment stops here; Stage B remains NOT STARTED.
