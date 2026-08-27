# AI Agent Database Permissions And Tenant Isolation

The model must not choose its own tenant, user, role, or database credential.
Runner binds those values from trusted process or authenticated session state
outside tool arguments and rejects plans that attempt to override them.

## Three Permission Layers

1. **Database floor.** A least-privilege role, PostgreSQL RLS, restricted
   views, or isolated credentials limits what the Runner process can reach.
2. **Reviewed Runner boundary.** Activated tables, fields, operations,
   relationships, privacy limits, and write effects narrow that reach further.
3. **Per-request trusted context.** Tenant and principal bindings are injected
   and reverified independently of the model before execution.

The model can select only reviewed business inputs. Tenant IDs, principal IDs,
database URLs, deployment profiles, approval identity, and authority digests
are not MCP arguments.

## The Model-Facing Reader Must Be Dedicated

Runner verifies the effective source credential before it creates or executes
model-facing read authority. A writable, owner, elevated, unverifiable,
PostgreSQL superuser, or PostgreSQL `BYPASSRLS` role is refused. On MySQL,
global authority, `GRANT OPTION`, ownership/write posture, or privilege
evidence Runner cannot verify also fails closed.

Metadata-only `inspect` remains available because it is the recovery tool:

```bash
synapsor-runner inspect --from-env DATABASE_URL
```

Human output shows **SAFE** or **UNSAFE**, the observed posture, and the
environment-variable name to update. It does not print the URL or password.
`doctor` separately reports metadata connectivity and read-role safety, so a
successful catalog query is never described as proof of least privilege.

Use a dedicated SELECT-only, non-owner credential for Runner reads. Keep
schema migration, setup, and write credentials separate and outside the
model-facing source URL. See [Troubleshooting First
Run](troubleshooting-first-run.md#scoped-explore-is-not-advertised) for
PostgreSQL and MySQL examples.

## Field And Relationship Permissions

Fields can be model-visible, Runner-output-only, or kept out. Relationships
must be catalog-proven, many-to-one, human-reviewed, and revalidated before a
query. One-to-many, many-to-many, ambiguous, or unproven paths fail closed.
Runner-output-only keeps raw values out of the complete MCP response, but it
does not remove separately reviewed filter, group, or sort authority; those
operations may still reveal membership, frequency, or order. Keep a field out
when the model must not operate on or infer from it.

Runner does not silently infer that a column named `organization_id` is the
tenant boundary. The operator must confirm the actual trusted scope mechanism.
For MySQL, where native RLS is unavailable, use restricted views, isolated
credentials, or another database-enforced scope design appropriate to the
deployment.

```bash
npx -y @synapsor/runner start
```

Read [Database-Enforced Scope](database-enforced-scope.md), [Reviewed
Relationships](reviewed-relationships.md), and [Security Boundary](security-boundary.md).
