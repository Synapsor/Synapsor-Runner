# Synapsor vs PostgreSQL RLS Alone

PostgreSQL row-level security is an excellent database authorization floor.
Use it. Runner checks role and RLS posture where supported and injects trusted
scope, but it does not replace the database policy.

RLS and Runner answer different questions:

| Concern | PostgreSQL RLS | Synapsor Runner |
| --- | --- | --- |
| Which rows can this database role reach? | Yes | Verifies and narrows through trusted scope |
| Which fields and relationships may the agent request? | Not by itself | Reviewed boundary |
| Can the model submit arbitrary SQL? | RLS does not remove SQL authority | No SQL tool or SQL argument |
| Query, response, cohort, and comparison limits | Not by itself | Enforced per reviewed boundary |
| Exact proposal before a write | No | Yes |
| Approval outside the model | No | Human or reviewed policy |
| Conflict, idempotency, receipt, and replay lifecycle | No | Yes for supported paths |

RLS cannot prevent every disclosure available through legal queries, and a
table owner or role that can bypass or assume the owner role can defeat it.
Use a non-owner runtime role, test the policy, and keep grants narrow.

For MySQL, use restricted views, isolated credentials, or per-tenant database
access because native PostgreSQL-style RLS is unavailable.

Read [Database-Enforced Scope](database-enforced-scope.md), [Production](production.md),
and [Security Boundary](security-boundary.md).
