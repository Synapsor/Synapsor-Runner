# PostgreSQL Writer Column Grants

Onboarding must distinguish table privileges from narrower effective column
privileges. PostgreSQL requires UPDATE on at least one column for SELECT FOR
UPDATE, including privately verified relations that the action never changes.
Requiring a table UPDATE grant on those relations would unnecessarily widen
the database credential. Ignoring column writes can also misclassify a writer
as a read-only login.

Runner inspects effective column grants when the corresponding table grant is
absent and binds them into the role-posture fingerprint. INSERT/UPDATE column
grants make a login write-capable, including the global posture check used by
resource-scoped inspection. No source rows are read during inspection.

For verified Action execution, a PostgreSQL writer may update the exact
reviewed effect columns. A private verification relation may additionally
grant UPDATE on its reviewed primary-key column solely to satisfy the row-lock
prerequisite. This is a database credential privilege, not agent authority to
change that key: the compiled effect, immutable fields, trusted scope, version,
row-count, approval and receipt checks remain unchanged. Broad table UPDATE on
a verification-only relation and unrelated column grants remain refused.

An RLS-protected relation also needs an applicable permissive UPDATE/ALL policy
for locking SELECTs. SELECT permission and a SELECT policy alone can return the
row for ordinary reads but zero rows for SELECT FOR UPDATE. Writer preflight
checks this prerequisite using effective role memberships. It does not prove
the policy's predicates for any customer, bypass RLS, or install policies.
The database owner must review a suitable narrowly scoped policy. Its change
requires reinspection of affected authority and writer posture before execution.

Generated Action configurations carry RLS session setting names from their exact
activated Read dependencies. Missing wiring is restored during guided connection
setup; conflicting settings are refused. Values still come only from trusted
runtime context. Principal-only RLS without a reviewed tenant session setting
currently needs explicit source-binding review for the Action runtime.

All outcomes using one writer are assessed together. A later grant change
invalidates the recorded writer posture. No setup operation grants/revokes
database permissions automatically. Existing table-grant fingerprints remain
unchanged when there are no additional column-only grants. Column INSERT and
column SELECT do not yet replace required table INSERT/SELECT in the worker
preflight; unsupported grants fail closed rather than being assumed sufficient.

Regression coverage includes real PostgreSQL column-only writers, a failed
private row lock followed by the minimal column grant, missing effect columns,
excess private-control grants, and fingerprint changes.
