# Synapsor Runner Docs

Start with the practical paths, not the internals.

## Try The Local Trust Loop

```bash
./scripts/try-synapsor.sh
```

This runs disposable Postgres/MySQL fixtures and proves the core loop:

```text
MCP tool call
-> trusted context
-> scoped read
-> evidence
-> proposal diff
-> approval outside MCP
-> guarded commit or stale-row conflict
-> receipt/replay
```

Read: [First 10 Minutes](first-10-minutes.md).

## Use Your Own Staging Postgres/MySQL

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
./scripts/use-your-db.sh
```

This inspects your schema, opens the guided setup, generates
`synapsor.runner.json`, previews the semantic MCP tools, and prints the
`mcp serve` and local UI commands.

For disposable dev RDS databases with local CA issues:

```bash
./scripts/use-your-db.sh --allow-insecure-ssl
```

Use certificate verification with the database CA bundle for real staging or
production-like databases.

Read: [Connect Your Own Database](getting-started-own-database.md).

## Important References

- [Schema Inspection](schema-inspection.md)
- [MCP Client Setup](mcp-client-setup.md)
- [Capability Config](capability-config.md)
- [Local UI](local-ui.md)
- [Writeback Executors](writeback-executors.md)
- [Security Boundary](security-boundary.md)
- [Current Scope And Limitations](limitations.md)
