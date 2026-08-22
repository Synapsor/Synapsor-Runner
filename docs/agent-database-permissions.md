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
