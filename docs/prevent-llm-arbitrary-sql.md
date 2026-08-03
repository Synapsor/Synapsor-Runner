# Prevent An LLM From Executing Arbitrary SQL

Do not try to secure arbitrary model-generated SQL with prompt instructions or
a keyword blocklist. Remove SQL authority from the model-facing interface.

Runner exposes typed plans and named business actions instead of `execute_sql`.
Trusted code validates every resource, field, operator, relationship, limit,
and scope binding against the activated boundary, then compiles a fixed
parameterized statement for Postgres or MySQL.

## The Enforcement Path

1. A human reviews a disabled boundary or named capability.
2. Activation binds the exact canonical digest outside MCP.
3. The model chooses only values allowed by a strict tool schema.
4. Runner normalizes and validates the plan again at execution time.
5. The database adapter binds values as parameters and enforces read-only or
   guarded-write posture.
6. Unreviewed fields, joins, scope changes, result sizes, and write effects are
   refused before execution.

The model never receives the compiled SQL. Operators can inspect a redacted,
parameterized diagnostic locally, but it is not an execution surface and is
not sent through MCP.

## What This Does Not Solve

Runner cannot make prompts trustworthy, guarantee that a model picked the
right reviewed metric, or constrain a separate raw-SQL tool. Least-privilege
roles, PostgreSQL RLS or restricted views, network controls, and application
authorization remain required beneath Runner.

Try the structural audit without connecting a database:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

Then connect a read-only development or staging role:

```bash
npx -y @synapsor/runner start
```

Read [Secure Text-to-SQL](secure-text-to-sql.md) for the benchmark evidence and
[Security Boundary](security-boundary.md) for the exact model-facing surface.
