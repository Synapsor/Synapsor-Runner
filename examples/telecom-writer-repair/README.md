# Dedicated Telecom Writer

This administrator-assisted repair supports the tutorial's two-relation offered-plan
switch, not arbitrary database policies. It preserves the shared writer, source
rows, saved business rules and active authority records. Runner never applies the
generated SQL. Do not use it on a production database without independent review.

## Export From The Pending Review

For a **new disposable tutorial database**, initialize `07_plan_writer.sql`
after the tutorial's schema/security scripts. This creates the separate
`synapsor_plan_writer` role for the exact seven plan fields plus version, with
scoped offer locking. It leaves the shared writer unchanged. Use this role in
`SYNAPSOR_DATABASE_WRITE_URL` for the single offered-plan-change walkthrough.
This older initializer does not grant offer consumption. A combined plan change
and permanent offer consumption needs the exact handoff below and a separately
reviewed dedicated writer; do not silently broaden the initialized role.
Its password is a public test credential, not suitable for production. A role
collision fails rather than rewriting an existing role. Do not run this fresh
initializer as a repair against an existing database; use the checked handoff
generator below instead.

Run `verify-plan-writer.sql` as the new role to check the full fixture privilege
envelope, scoped locks and tenant/principal refusals. Its test writes roll back.
Runner must still check the actual compiled outcome: this fixture check is not
proof of arbitrary-rule compatibility or execution readiness. Adding another
outcome may require another dedicated writer selected in its execution review,
not broadening this role to all business tables.

## Repair An Existing Tutorial Database

In the same saved project, choose **Prepare a dedicated writer handoff** after
the configured writer is refused. Runner creates a private directory containing
`requirements.json`, `grants.sql` and administrator instructions. Nothing in the
database changes. Exact requirements and retry remain in the same review.

Generic onboarding does not select or export this recipe based on table names.
It is an optional tool for this specific example, not a requirement for other
databases. Similar names do not establish compatibility. The generated SQL still
checks the exact fixture policies, ownership and helper definitions.

Set `HANDOFF` to the directory displayed by Runner and `REPAIR` to a new local SQL
file. Run this script from the packaged example directory:

```bash
node prepare.mjs "$HANDOFF" "$REPAIR"
```

Review this combined repair **instead of** applying the exported `grants.sql`,
not after it. If its dedicated role already exists, leave that role untouched.
For a deliberately separate provisioning attempt, pass `--fresh-role` and
review the newly generated role and unchanged privilege requirements before use.

The generator checks the actual compiled effect: eight subscription columns,
SELECT on subscriptions and offers, and either the offer identity privilege for
private row locking or the exact `status` and `version` updates for atomic offer
consumption. Only the reviewed exported effect selects that grant set. It refuses
a different effect instead of widening grants.
Review the generated SQL before administration. The script itself is offline.

## Authorized Administrator Step

Use an administrator connection to the intended tutorial database. Do not use the
Runner read connection, alter the shared writer, reset the database, or send the
administrator URL to a model. `ADMIN_DATABASE_URL` is an administrator-supplied
secret environment variable; this example neither supplies nor stores it.

```bash
psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$REPAIR"
```

Before changes, SQL checks forced RLS, table ownership, the exported policy
snapshot, trigger absence, and the exact reviewed membership helper definitions.
Any mismatch rolls back the transaction. It creates a dedicated NOLOGIN,
non-owner, non-superuser, non-bypass role with exact grants, two scoped UPDATE
policies and two helper grants. It does not edit existing policies or source rows.

Configure authentication separately through your normal secret system. In an
interactive administrator psql session, use `\password ROLE` for the role printed
by the generator, then `ALTER ROLE ROLE LOGIN;`. Never paste a password into the
saved SQL or model chat. Configure the resulting connection privately in
`SYNAPSOR_DATABASE_WRITE_URL` in the terminal that launches Runner and its worker.
The new role must not inherit the shared writer role.

## Resume Without Reauthoring

Adding an RLS policy changes the reviewed database contract, even though the
reader's intended access and business rules are unchanged. Resume the **same**
project with the new Runner build and `start --from-env DATABASE_URL
--schema telecom --cli --rescan`. Select **Revalidate the saved job against changed
database**. Review the retained Read/Action revisions before execution; do not
start a new job or reattach the same business document.

Ordinary `start` deliberately retains the saved inspection; `--rescan` requests
the metadata check after this administrator repair.
The exact diagnostic also provides `boundary rescan --from-env DATABASE_URL` for
explicit metadata reconciliation. Neither rescan nor a writer check activates
authority. The guided execution review rejects a stale Read contract.

After revalidation, **Check the configured write connection**, then explicitly
review execution. Continue to the existing guided worker and client setup.
Execution enabled, worker running, client connected, customer identity tested,
and request completed are separate states. A request is complete only after its
guarded source transaction succeeds and Runner records a receipt.

The role's lock-key privilege never becomes permission for an agent to change
an identity. Scope, verified facts, effect columns, conflict guards, approval
limits and apply-time checks still constrain every request.
