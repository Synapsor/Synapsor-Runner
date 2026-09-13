# Bounded rule-publication repair and local verification

Status: implementation and host verification completed; offline packaging and
installed matrix in progress. Stage A is NOT PASSED. Stage B is NOT STARTED.
This report continues 779b2dc without replacing any historical failure.

## Source and evidence

Baseline 779b2dc on codex/tui-safe-action-control-plane descends from accounting
repair a2b6b5f and evidence a0942d1, b666202, c0b81b8. Publication product repair:
b16f92aa01d52d6b51e74e0e1574fac7de14635b. Separate migration fixture correction:
3be534f828bbaf0ec655fb689abe60869bf59114. Composed fixture correction: 03e3f44.
Report-only package reference correction: 3aa8e0d. Exact source manifests,
commands, times, logs and exit statuses accompany every run. The final installation
will record its own tree, local Spec, lockfile and dependency identities.

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

## Installed checks (pending execution)

The prepared local identity is bound to one project identity contract and one
fixed local-test-runtime.json. The supported managed setup reuses a valid file;
there is no reviewed replacement/per-client path in this prepared flow. Do not
remove or edit it, use integration-only setters, or copy separate budgets to claim
common allowance. See installed-identity-prerequisites.md. The original matching
context will receive diagnostic/startup/own-row positive checks before schedules.
Alternate/common-budget A2 and foreign-context A4 remain blocked unless the actual
supported prerequisite is established. Historical package passes are not reused.

The overall owned fixture extension remains exactly one synthetic third-insurer
portfolio plus three valid claims: 44 rows with the original 40 preserved, same
schema and 8/3 policy. No approval history is inserted. Actual preparations and
installed results will be recorded separately below. Prepared scripts are not
executed results; no missing-ID equality is treated as proposal identity.

## Offline delivery checkpoint

All ten checks completed: the first six in attempt 1 and the remaining four in
attempt 2, each exit 0. The first local package build failure is preserved; the
report-only correction and exact command plans explain the split. No skipped
checker or source behavior change. Offline package installation used cached
existing dependencies and locally packed Spec under an unshared network namespace.
Pre-install preservation verified all 77,559 original entries unchanged.
