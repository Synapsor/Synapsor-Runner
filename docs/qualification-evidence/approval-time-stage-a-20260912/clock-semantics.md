# Admission time and window semantics

The repaired normal semantic caller supplies only action_boundary/shared_limits;
it no longer supplies the earlier subject-claim timestamp. Both normal product
call sites (semantic-actions.ts and approval-policy.ts) omit the internal now
override. Fact evidence and proposal creation timestamps remain claim-time facts.

utcDayWindow in proposal-integrity.ts constructs UTC midnight to next midnight.
It is a calendar bucket, not admission time minus 24 hours. The store uses it for
legacy options.limits, whose public Spec type explicitly requires period: day.
This mechanism is distinct from action_boundary shared limits. Those use
[admission_time - window_seconds, admission_time], inclusive at both ends, and
stable boundary/outcome/trusted scope history across revisions. The original
insurance policy's 8/3 limits and the gym-style window_seconds:86400 expression
use that rolling mechanism. A legacy caller can configure both mechanisms; they
are evaluated separately, not converted into one another.

The saved midnight-mechanisms.json control commits three approvals at 23:59 UTC
and attempts three more at 00:01. Semantic rolling results are T,T,T,F,F,F; explicit
legacy period:day results are T,T,T,T,T,T. No reviewed rolling-to-calendar mismatch
was found in this path. Accordingly there is no midnight semantics repair or
separate claimed policy violation. The exact 60-second lower-bound test also
continues to include an approval at the boundary and expire it one millisecond later.

Admission invariant for ordinary cooperating semantic callers: after acquiring
the shared ledger's writer coordination and before evaluating limits, choose the
trusted wall-clock admission time. Every automatic approval committed before that
writer acquisition must carry a timestamp no later than this admission time.
Counts and insertion of the one approval decision occur under the same writer
transaction. PostgreSQL's outer advisory transaction lock and fresh ledger
materialization occur before the shared SQLite primitive selects its default time.
The saved PG sequences record real failed/successful advisory acquisition,
materialized approval counts, COMMIT acknowledgement and stored timestamps.

This assumes synchronized, nondecreasing clocks across cooperating admission
processes and the repaired caller in every process. A backward clock step or
another process's ahead clock can put a committed approval beyond the upper
bound. A mixed-version caller can itself reuse its earlier evidence time and
exclude later committed approvals; backdated history can also expire too early.
An old timestamp need not violate the inequality for a later repaired caller,
but it violates the requirement that timestamps represent authoritative admission.
No arbitrary skew/backward-clock resilience or uncertain COMMIT recovery is claimed.
Update all cooperating admission processes before any later deployment.

A committed automatic approval consumes allowance until its applicable window
expires even when its worker is blocked or execution never completes. It does not
vanish or receive a refund. Operationally, stuck work reduces future automatic
capacity for the rest of that window. The fix adds no refund, requeue, reservation
ledger, schema change or migration. PostgreSQL controls reopen the existing schema
with autoMigrate:false and still count its decisions; server restart is unrun.
