# Bounded rule-publication repair and local verification

Status: bounded implementation and applicable verification complete; stopped on
the separate installed draft-save defect and unsupported local identity prerequisites.
Stage A is NOT PASSED. Stage B is NOT STARTED.
This report continues 779b2dc without replacing any historical failure.

## Source and evidence

Baseline 779b2dc on codex/tui-safe-action-control-plane descends from accounting
repair a2b6b5f and evidence a0942d1, b666202, c0b81b8. Publication product repair:
b16f92aa01d52d6b51e74e0e1574fac7de14635b. Separate migration fixture correction:
3be534f828bbaf0ec655fb689abe60869bf59114. Composed fixture correction: 03e3f44.
Report-only package reference correction: 3aa8e0d. Exact source manifests,
commands, times, logs and exit statuses accompany every run. The final installation
records its own tree, local Spec, lockfile and dependency identities.

Original strict source, old failed stores, the previous accounting failure and
frozen installation c4300519538be9cb2befd08b8d99b0b897a33801cbd57f48cf4f088ea417e10e
remain protected. The preservation-start manifest covers 77,559 entries. No worker
uses the preserved excess-approval queue. All replay fixtures are newly owned.

## Publication result and ordering

The actual runtime checked current authority before asynchronous facts/proposal
preparation, then approved using captured rules. Runtime cutover, project authority
mutex and ledger serialization did not jointly protect that decision from normal
publication. The exact existing Action revision now participates in the definitive
decision under durable coordination. See coordination-review.md for the full
lock order, sibling audit, bounds, timestamp invariant and upgrade requirements.

| Backend/order | Before repair | After repair |
| --- | --- | --- |
| Governed SQLite, replacement first | Superseded request automatically approved; history 1 to 2 | Existing stale error; history remains 1; fresh current request requires human review |
| Real PostgreSQL control store, replacement first | Same incorrect automatic approval; history 1 to 2 | Same strict refusal and retained history 1 |
| Governed SQLite, admission first | Legitimate approval retained; history 2 | Retained; fresh stricter decisions use history 2 |
| Real PostgreSQL control store, admission first | Legitimate approval retained; history 2 | Retained; fresh stricter decisions use history 2 |

The original strict test assertions were unchanged: before 2 failed/2 passed exit 1;
after 4 passed exit 0. SQLite's original schedule paused asynchronously before
actual admission. PostgreSQL additionally observed the real schema advisory writer
wait. These are different observations, not two instances of the same DB lock.
Exact timelines, durable records and original/replacement identities are in
before-publication/, after-publication-01/ and publication-before-after-summary.json.
Expanded tests record immutable policy revision IDs as well as authority digests.

The normal SQLite regression is in semantic-admission-publication.test.ts under
standard discovery. Explicit local PostgreSQL gate:
`scripts/verify-publication-accounting-postgres.sh`, with the owned scoped
SYNAPSOR_TEST_POSTGRES_URL only. Publication/owned-worker controls passed 39/39;
the separate real PostgreSQL control-store gate passed 41/41, exit 0. Coverage
includes independent handles/processes, unchanged rules, disabled drafts, failed
confirmation, deactivation, both lock orderings, exception rollback, bounded busy
and subsequent progress. An old request is never silently reinterpreted. A stale
attempt may leave a non-executable unapproved proposal record; it adds no automatic
approval, consumption or executable permission. No committed approval is refunded.

Owned worker coverage retains approved history and refuses new dispatch of old
unstarted authority after reviewed replacement. It creates no receipt or source
effect for that refusal. Already-dispatched behavior was not changed; do not infer
new coverage of every dispatched lifecycle from an unstarted-work test.

## Accounting, clock and liveness

The earlier last-slot/time repair remains unchanged. SQLite and real PostgreSQL
control-store tests retain per-insurer and overall exact last-slot grants,
canonical history selectors, human-review loser, ample concurrent allowance,
rollback/reopen and lost-acknowledgement behavior. Real PG control-store evidence
is distinct from installed PG business-source tests using a SQLite control store.

The clock is chosen after writer exclusion and the new authority coordination.
Assumption: no backward clock step and aligned clocks across cooperating admission
processes; earlier committed approvals have timestamps at or before this admission.
Mixed-version evidence-time timestamps or skew can break it. Inclusive rolling
shared_limits.window_seconds remains unchanged. Legacy period=day is a UTC
calendar bucket, a separate mechanism. Existing midnight regression is retained;
no new clock-skew or multi-host guarantee is claimed.

Native SQLite writer waits remain 5 seconds. New PG deployment row waits and
publication lock waits are bounded at 5 seconds; the preceding ledger advisory
wait defaults to 10 seconds. Local runtime/authority acquisitions default to
5 seconds. Busy responses and cleanup/progress are tested in both directions.
These bound lock attempts, not arbitrary filesystem stalls or all I/O, nor do
they promise FIFO success under infinite retry load. No conversation or source
execution is serialized by the new rule check. Committed approvals consume the
rest of their applicable window even if execution never completes; stuck work
reduces future automatic capacity until expiry. No refund or requeue feature.

The defect is reachable by an ordinary operator publishing a reviewed rule edit
while an ordinary connected client has a request in flight. Instrumentation makes
the legal timing deterministic and grants no extra authority. Governed SQLite,
real PG control store and file-authority compatibility are covered locally. A
single client alone cannot publish through the four model tools. Natural frequency
was not measured. All cooperating admission processes must upgrade/restart;
mixed-version coordination is not established. Separate restricted policy-row
locking permissions, NFS, multi-host durability, universal exactly-once execution,
production readiness and unseen onboarding remain unqualified.

## Migration and stable tests

The separate unchanged migration test was reproduced under combined load with
POLICY_RUNTIME_BUSY. Two isolated and two representative-load runs are preserved,
including passes close to its 5-second bound. Labeled tracing measured a 4,813ms
exclusive hold dominated by first-use application-ledger DDL (2,306ms schema and
1,621ms indexes), with no observed leaked reader or nested exclusive gate.
The exact failed run has no retroactive per-I/O trace; see migration-diagnosis.md.
The test-only fix prepares that unrelated ledger before concurrent policy imports,
retaining imported/already_imported and one complete binding assertions. A separate
true-held-gate test requires bounded busy, releases and awaits the owner. No
migration product change, timeout increase or blind retry.

Final combined check: 249 passed, 21 skipped, exit 0. Earlier combined exit 1 is
retained separately. The sole full stable suite on 3be534f finished exit 1:
6,097 passed, 21 failed, 461 skipped (291 passed/4 failed/21 skipped files).
Twenty failures used unbacked composed Action fixtures; one permissions fixture
assumed creation ignored umask 0077. Their original sources and every attempt are
saved. Corrected runtime 41/41, delegation 4/4, permissions 3/3 and MCP 10/10
focused checks pass, with final types08 exit 0. This does not retroactively pass
the full suite. No second full suite was run. See full-suite-outcome.md and
composed-fixture-correction.md for exact setup corrections and limitations.

## Installed prerequisites and coverage limits

The prepared local identity is bound to one project identity contract and one
fixed local-test-runtime.json. The supported managed setup reuses a valid file;
there is no reviewed replacement/per-client path in this prepared flow. Do not
remove or edit it, use integration-only setters, or copy separate budgets to claim
common allowance. See installed-identity-prerequisites.md. The original matching
context received diagnostic/startup/own-row positive checks before every schedule.
Alternate/common-budget A2 and foreign-context A4 remain blocked unless the actual
supported prerequisite is established. Historical package passes are not reused.

The overall owned fixture extension remains exactly one synthetic third-insurer
portfolio plus three valid claims: 44 rows with the original 40 preserved, same
schema and 8/3 policy. No approval history is inserted. Actual preparations and
installed results are recorded separately below. Prepared scripts are not
executed results; no missing-ID equality is treated as proposal identity.

## Offline delivery checkpoint

All ten checks completed: the first six in attempt 1 and the remaining four in
attempt 2, each exit 0. The first local package build failure is preserved; the
report-only correction and exact command plans explain the split. No skipped
checker or source behavior change. Offline package installation used cached
existing dependencies and locally packed Spec under an unshared network namespace.
Pre-install preservation verified all 77,559 original entries unchanged.

## Final installed results

New complete offline installation: source/evidence checkpoint f9d28398ac6b896f2824d04ba28b858d6ae5cd48,
product b16f92a, test 03e3f447e1f79ffbc804b0e8b396bddb510e3e12. Runner 1.8.0 and
local Spec 1.11.0. Tree b2ec50b72e3c178cdb8fd67ed8f7af8250a00840720d0ceca33de8f21a14c8b0,
7,569 entries; lockfile 1bdb01a5cffc444530b6617ffd1c7eff8454db111098b95c0243d0bb684b06a2.
Full manifest/archive stay in the owned frozen/ directory; artifact-summary.json
and freeze-command.log record exact package and archive hashes. The new artifact
was never patched, and the previous package is not reused as current evidence.

All installed business checks below use PostgreSQL business rows with a SQLite
control store. They do NOT constitute real PostgreSQL control-store installation
coverage; the explicit host integration gate supplies that separate evidence.

| Check | Final status | What was actually established |
| --- | --- | --- |
| Configured original identity | PASS | Applicable Action-companion doctor, normal four-tool startup and own allowed rows in every used copy; identity bytes unchanged |
| A1 identical/replay/restart | PASS, one process | One canonical proposal, approval, queue entry, stored applied receipt and independently verified row effect; identical replay and MCP restart added none |
| A2 last insurer slot | PASS, same principal only | Two legitimate automatic approvals before contention; second request completed while first facts were held; exactly one further automatic approval and one human-review loser, source unchanged |
| A2 overall/shared-principal variants | BLOCKED | Alternate reviewed local identities sharing the SAME applicable ledger cannot be prepared through the supported local flow; no independent copied-budget substitution |
| A3 collection | PASS on fresh corrected fixture | First real source lock wait observed; two worker processes overlapped with unchanged concurrency one; one 60000-cent change applied, aggregate became 90000, competing change refused |
| A3 source coordination | PASS | Owned portfolio status/version UPDATE actually blocked worker verification; after owner commit, stale source effect was refused and independently read back |
| A4 cross-context references | BLOCKED | Positive original context passes; no second valid reviewed context exists for normally issued foreign references. No deeper rejection claimed from startup alone |
| Exact automatic-limit edit | FAILED at preparation, product | Export and exact 3-to-1 dry-run pass; disabled save exits 2 with POLICY_EXECUTION_CONTEXT_REQUIRED |
| Installed publication order / old unstarted after edit | NOT RUN | Failed draft save prevents a reviewed replacement; host publication and worker controls remain separately labeled |

A1 canonical proposal wrp_rule_414d5ef2ef21c87ca5101fc235af1f42 has stored receipt ID 2,
hash sha256:3617f4b3395ceed6084edb9e81528d62a2f34c35fea87cc1e3f0f136f1f0b7d1;
rows_affected=1 and semantic verification reverified. Claim CL-103 changed from
10000/version1 to 25000/version2; the independent whole-source comparison allows
no other change. Stored result, receipt, replay and restart snapshots are saved.

The A2 baseline is legitimate: original policy approval for CL-101 at
2026-09-12T18:10:52.231Z with its prior applied receipt, then A1's normal CL-103
approval. These are automatic policy decisions, not proposals/reservations/human
approvals/queue entries counted as approvals. Persisted selector/history records
show 2 to exactly 3, with one pending_review loser. The overall fixture contains
one additional third-insurer portfolio plus three valid claims (44 rows); it was
not used to claim any overall admission result. All 40 old rows were preserved.

Two demonstrated harness errors are preserved: the initial doctor selected the
Read-only primary instead of its reviewed Action companion; and A3 attempt 1 held
a blocker beyond the unchanged three-second statement timeout while waiting for
the second worker to finish. Exact database timeout logs and failed receipts remain
in the untouched collection attempt. Fresh collection_02 repeated the existing
schedule with process-spawn acknowledgement; original assertions passed. No
product behavior, request serialization, worker limit or timeout was changed.
See identity-diagnostic-config-correction.md and a3-harness-timeout-correction.md.
A3 does not claim simultaneous effect transactions from overlapping processes.

The new product issue is documented in installed-edit-save-finding.md with exact
commands, inputs, outputs and static call trace. Final independent readback proves
its active/draft policy records, decisions, queue, receipts and source unchanged.
The save was not retried, no worker ran against the edit fixture, and the prepared
publication script is not an executed result. No unrelated product repair began.

Initial host fixture preparation used the shell environment, selected only the
explicit owned fixture URL and invoked no provider. All subsequent host preparation
and runtime drivers used a cleared environment; MCP/operator subprocesses received
only their required owned DB URLs and matching reviewed values. Tests and packaging
used private writable /var/tmp, NO_COLOR=1, umask0077, unrelated/provider credentials
absent; full suite also had DB credentials absent. Existing dependencies and offline
packing were used; no registry/model/customer call or deployment occurred.

Runtime budget: 48 recorded operations corroborated against event logs, 6 worker
invocations, A1 once, A2 insurer once, A3 collection twice (first harness timeout),
A3 source-update once. The original 90-minute deadline was not reset. No fourth
combined run, second full suite or third package attempt occurred. The separate
installed blockers end these paths even though some budget remains.

## Stopping point and next decision

The publication repair is verified in the named host configurations. The stable
full suite still has its actual failed result, with subsequent fixture corrections
verified only in focused runs. Required installed rows remain blocked/unrun, so
there is no overall Stage A pass. Stage B remains NOT STARTED.

Next repair decision: installed-edit-save-finding.md. Separately decide how to
prepare supported reviewed local contexts sharing one durable allowance before
claiming installed overall/A4 coverage. After those prerequisites are repaired,
use fresh owned fixtures and rerun applicable qualification; do not reuse these
stopped stores or pretend the prepared scripts already ran. No arbitrary clock-skew,
multi-host, universal exactly-once, production or unseen-domain guarantee is made.

## Preservation and delivery closure

All 77,559 original entries were verified unchanged after the final readbacks and
cleanup (preservation-final.json). The new 7,569-entry installation retained its
exact b2ec50b7…a14c8b0 tree hash (artifact-final-verification.json). Every recorded
test/application PID was checked: 76 recorded PIDs, none still running. The one
owned PostgreSQL container synapsor-publication-273d01cd was identified by its exact
ID/label/network, dumped and logged before stop, then confirmed stopped. It was
not removed; owned SQLite files and failed fixtures remain available. Six custom
PostgreSQL dumps passed pg_restore --list, with hashes in cleanup/saved-state.json.
Roles were saved without passwords. No original resource was stopped or removed.

Private delivery destination was independently verified as
https://github.com/Synapsor/Synapsor-Runner-Backup (private), branch
codex/tui-safe-action-control-plane. Only that explicit backup ref is used; public
origin, release and deployment are untouched. The post-push ref/exit confirmation
is saved outside the commit at the owned task root's delivery.json and in the
existing primary tracker. Product, migration test, composed test, documentation
and evidence changes are separate commits. Raw databases, credentials, .env files,
npm tarballs and the installed dependency tree are retained only in owned local
artifacts, not committed.

STOP after private delivery. Next issue: installed-edit-save-finding.md.
Stage A NOT PASSED. Stage B NOT STARTED.
