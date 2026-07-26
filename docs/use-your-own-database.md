# Use Your Own Database

The canonical guide is [Connect Your Own Database](getting-started-own-database.md).

Use it when you want to point Synapsor Runner at a staging Postgres/MySQL
database, inspect schemas/tables, generate one reviewed context/capability, and
serve semantic MCP tools without exposing raw SQL or write credentials to the
model.

Short path:

```bash
npx -y @synapsor/runner start
```

Paste a read-only URL into the hidden prompt, explicitly approve a regular
project `.env` file for this process, or export `DATABASE_URL`. PostgreSQL
defaults to `public`; explicit `--from-env`, `--schema`, and `--project-root`
flags remain available and always win. Runner stores environment-variable names
in `synapsor.runner.json`, not database URLs.
