# Publication coordination review

The early context/reference check was followed by asynchronous facts and proposal
work. Automatic approval then used the captured rule without a publication-
coordinated definitive current-revision check. Ordinary reviewed operator edits
while a normal client is active can reach this ordering. The deterministic
barriers make the ordering observable; they do not confer publication powers on
the four public tools. Natural incidence was not measured.

Governed runtime binding already requires the policy repository to be the actual
selected runtime store. SQLite policy tables and approval history share one DB;
PostgreSQL policy tables and ledger_entries share one repository/schema. The new
trusted revision token is the existing deployment/name/immutable revision ID,
not a second policy copy. The definitive check and decision are protected together:

* SQLite BEGIN IMMEDIATE, exact active operator Action check, fresh admission time,
  count and insert, COMMIT. Publication needs the same native writer lock.
* PostgreSQL schema ledger advisory writer lock, existing deployment row FOR SHARE,
  exact active Action check, fresh ledger materialization, fresh admission time,
  count/insert, COMMIT. The row lock remains until that commit. Publication's
  first change statement UPDATEs/CASes this same deployment row and holds it
  through its revision/pointer/event commit. A publication that commits first
  therefore makes the later guarded approval stale. If approval locks first,
  publication waits and the legitimate committed history remains counted.
* File authority retains its existing persistent local authority writer mutex
  across a definitive activation comparison and the ledger decision. This section
  starts after facts. It does not lock source execution or a whole conversation.

Lock order: runtime shared gate for requests, exclusive gate for migration;
project authority mutex where applicable; ledger writer coordination; governed
policy deployment row; decision. Governed publication holds authority mutex then
its policy transaction/deployment UPDATE; it never takes the ledger advisory lock
inside that transaction. Migration holds exclusive runtime then authority mutex.
Every new error path rolls back before releasing its connection/mutex. Raw
active-pointer rewrites outside governed APIs are not a supported publication path.

Sibling audit: activateActionRuleAuthority (including runtimePublication/config
settlement), disabled draft writes, deactivateActionRuleAuthority,
deactivateActionRuleAuthorityIfCurrent and native reviewed repository commits all
reach the same policy changeStatements deployment UPDATE before pointer mutation.
File activation/replacement/unconditional and conditional retirement already use
the same project mutex. createOptionalActionRuleRuntimeServices is Runner's only
semantic runtime constructor; its context supplies the trusted automatic callback.
No model argument, new public tool, altered operator identity or weaker review.

Wait bounds, not a new end-to-end I/O guarantee: each local authority/runtime-gate
acquisition defaults to5seconds (existing explicit options can select up to60s).
SQLite's native store busy timeout remains5seconds. The PG ledger advisory wait
retains its configured bound (default10seconds), followed by at most5seconds for
the new policy-row lock. PG policy writes also set transaction-local lock_timeout
5seconds so a waiting publication returns POLICY_MUTATION_BUSY and rolls back.
Thus new guarded PG admission has at most10+5seconds of these two lock waits by
default; legacy authority+SQLite decision has5+5seconds. Runtime entry and prior
facts/store operations have their existing independent bounds. This is not a
bound on stalled filesystems, connection establishment, arbitrary SQL duration or
an entire conversation. No FIFO/eventual-success claim under unlimited retries
or unbounded load is made: a single contended operation returns a clean bounded
busy result rather than waiting indefinitely. Tests hold each side beyond its
bound and verify refusal plus progress after release.

Admission-time invariant retained: assuming no backward clock step and aligned
clocks on all cooperating admission processes, every approval committed before
this transaction acquired the writer lock has a timestamp at or before the new
admission time. The clock is selected after the writer and all new coordination
points. Tests observe the SQLite revision read before the clock and PostgreSQL's
revision lock before a held decision's timestamp. Existing inclusive rolling
windows are unchanged. Rule shared_limits.window_seconds remains rolling; legacy
period=day uses UTC calendar buckets. These are separate mechanisms. No new clock
skew tolerance is claimed. Committed automatic approvals consume allowance for
the rest of their applicable window even if execution stays blocked forever;
stuck work reduces future capacity until the approval ages out. No refunds or
requeue feature was added.

All cooperating admission processes must upgrade/restart. Old processes do not
supply the guarded decision and mixed-version safety is not established. Tests
cover independent local handles/processes on supported local storage; they do
not establish multi-host or NFS behavior, universal exactly-once execution,
production readiness or unseen onboarding qualification. StageB NOT STARTED.
