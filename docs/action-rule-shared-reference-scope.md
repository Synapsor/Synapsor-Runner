# Private Shared References Under PostgreSQL RLS

## Reported Failure

An authorized student's registration can refer to an institution or class section
shared with other students in that institution. The reviewed lookup has an
institution predicate but no student column. Applying the connection's global
principal-policy requirement to that shared table incorrectly blocks both writer
preflight and private fact loading.

## Bounded Correction

Policy inspection may omit the principal-setting requirement only for a compiled
one-row forward relationship with a proven unique target, an explicit tenant
column matching the resource's tenant key, and that tenant column in the reviewed
relationship's target tuple. Neither the verification binding nor its catalog
resource may require a local principal column. The relationship name, target and
cardinality must match. Both tenant and principal values remain bound to the
trusted database session; the model supplies neither.

The fact loader still obtains the parent through the reviewed subject/relationship
path, loads only its exact related row and adds the explicit tenant predicate.
Composite relationships retain their complete tuple and live uniqueness/FK checks.
This is private verification access, not additional model-visible Read authority.

Root subjects, inverse or multiple-row lookups, inherited/unproven scope and
principal-guarded resources retain the existing principal-policy checks. Readiness
combines the strongest requirement when one table appears in several bindings;
primary and additional effect targets remain strict. The fact-loader cache also
distinguishes effective scopes so a shared lookup cannot satisfy a stricter check.
FORCE RLS, non-owner/non-bypass roles, applicable policies and tenant checks remain
required. Approval, source writes and activation are not changed by this fix.

## Deployment Still Requires Review

SQL grants do not make another role's policies applicable. Missing writer SELECT
policies and UPDATE policies needed for row locking remain real prerequisites.
Runner must report them separately; it must not invent student-specific shared
records, disable RLS or inherit an unrestricted writer to make readiness pass.

For exact, simple reviewed column-to-session filters, the administrator handoff
can include a separate `scoped-policies.sql`. It preserves the existing predicate,
adds missing SELECT/write/row-lock policies only for the dedicated role, and checks
the full prior policy snapshot, forced RLS and role posture in one transaction.
Run only after administrator review and the separately generated grants; Runner
never executes it. Refreshing database metadata and revalidating the same saved job
remain required before execution review. The repair grants no agent permission to
write private verification fields merely because a SQL locking privilege exists.

Provisioning another independent action may encounter several SELECT policies
for existing reader and writer roles. This is supported only when every policy's
USING/CHECK expression independently proves the same complete reviewed identity
scope using the closed predicate grammar. At least one SELECT policy is required.
The new policy copies a proven SELECT predicate; it never combines partial
predicates or edits another role's policies. The entire prior policy set remains
in the drift check, including policies not applicable to the new writer.

Custom or restrictive predicates, helper functions, ambiguous scope, triggers,
conflicting SELECT policies, unsupported operations, and unforced RLS do not receive
a guessed repair. The README names the concrete prerequisite. In particular,
do not replace a policy that hides records with a broader identity-only policy to
make a complete-collection check pass. A missing predicate is a deployment decision,
not evidence that a business prerequisite is true.

## Refreshing Private Read Evidence

The private current-state Read proof fingerprints all policies on its source,
including policies that do not apply to the reader. After provisioning a separate
writer, rescan may refresh that proof in the disabled candidate only when it can
reproduce the entire previous fingerprint using the policy-name inventory from
the saved, validated authoring catalog. Every previous policy must still exist
unchanged; source identity, columns, types, enums, uniqueness, clock and reader
posture must still match. Every added policy must be confirmed inapplicable to
the reader by fresh PostgreSQL inspection, never guessed from its name.

This is not a runtime exception or a general schema-drift acceptance. Unknown
applicability, a PUBLIC/reader policy addition, removed or edited prior policies,
unforced RLS, or changed evidence semantics still stop rescan with the saved state
intact. The new proof includes the complete current policy set. Existing active
proofs remain stale; Read activation and dependent Action/execution revalidation
are still separate. No prerequisite, private field or business rule is dropped.

## Verification

`action-rule-rls-scope.test.ts` checks guarded selection and cache separation.
`action-rule-rls-readiness.test.ts` checks connection preflight and stricter targets.
The isolated PostgreSQL test uses compiled scalar institution and composite
section relationships, proposal and transactional fact loading, wrong identity,
missing tenant policy, inconsistent tuples and changed current prerequisites.
Run it with `SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE=1`; it creates and removes
only its named temporary container. It does not by itself qualify full onboarding
or prove that a business change was executed.
