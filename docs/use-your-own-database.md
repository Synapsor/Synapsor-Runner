# Use Your Own Database

The canonical guide is [Connect Your Own Database](getting-started-own-database.md).

Use it when you want to point Synapsor Runner at a staging Postgres/MySQL
database, inspect schemas/tables, generate one reviewed context/capability, and
serve semantic MCP tools without exposing raw SQL or write credentials to the
model.

Short path:

```bash
export DATABASE_URL="postgresql://readonly_user:password@host:5432/app?sslmode=require"
npx -y -p @synapsor/runner synapsor-runner start --from-env DATABASE_URL --schema public
```

Runner stores environment-variable names in `synapsor.runner.json`, not database
URLs. Keep credentials in your shell, process manager, or secret manager.
