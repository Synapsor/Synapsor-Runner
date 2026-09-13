# Publication/admission repair design, before implementation

Baseline 779b2dc: both strict replacement-first cases reproduced in new fixtures;
both admission-first controls passed. Original source/assertions/stores unchanged.
SQLite uses its acknowledged pre-admission async barrier; PostgreSQL additionally
waits on the actual runtime-store schema advisory lock. Exact sequences and exit1
are retained under before-publication.

The current-rule check precedes asynchronous fact/proposal work. Approval receives
captured limits without a current-revision transaction guard. The cutover gate
(shared runtime, exclusive migration) is not an ordinary publication lock. The
local authority writer mutex serializes authoring, but not this automatic decision.

Governed composition validates that the policy repository is the actual selected
runtime store: same SQLite database or same PostgreSQL repository/schema. PostgreSQL
policy tables and materialized ledger entries are separate state in that same DB.
The repair will carry the existing exact active Action record identity from the
validated load into the automatic decision, not duplicate authority content.

SQLite: after BEGIN IMMEDIATE, definitively compare the active operator Action
pointer with the expected exact record, then choose admission time and count/insert.
Publication's policy transaction needs the same DB writer lock.
PostgreSQL: existing ledger advisory writer lock, then lock the existing deployment
row FOR SHARE, check the active Action pointer, materialize current ledger, and
count/insert under the existing transaction. Every policy publication starts with
an UPDATE/CAS of that deployment row; the row lock orders publication against the
approval commit. No new ledger, distributed transaction or post-commit refund.
Time selection remains in the SQLite primitive after all preceding coordination.

File-backed compatibility authority lacks a policy row in the ledger. Its existing
persistent local SQLite authority mutex must protect a definitive current-rule
load through the ledger approval commit, after fact preparation. Publication and
retirement already use that same mutex. No whole conversation/source execution lock.

Lock order: runtime shared admission (or exclusive migration) first; authority
mutex where needed; existing ledger writer coordination; governed deployment row;
ledger decision. Policy publication holds authority mutex then policy transaction
and deployment UPDATE; it does not acquire the ledger advisory lock inside that
policy transaction. No reverse acquisition or async operation inside a native
SQLite decision transaction. Failure must roll back and release every held lock.

New row-lock waits must be bounded, including publication waiting on admission.
Use the existing five-second local writer/cutover bound and configured PostgreSQL
ledger bound (default ten seconds), plus a five-second policy-row bound. Return
clean busy on exhaustion; preserve exceptions and rollback. Tests will distinguish
bounded attempts from claims of successful admission under all possible load.
All cooperating admission processes must upgrade/restart; old callers omit the
new guard, so mixed-version safety is not implied.

Audit activation, replacement, conditional/unconditional deactivation and native
reviewed commit paths, retaining their current validation and exact confirmations.
An operator's ordinary edit overlapping an active valid client request can reach
the defect. Instrumentation makes that legal ordering deterministic; it supplies
no publication/model authority. Natural incidence is unmeasured.
