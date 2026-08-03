# Use Your Own Database

The canonical guide is [Connect Your Own Database](getting-started-own-database.md).

Use it when you want to point Synapsor Runner at a staging Postgres/MySQL
database, inspect the whole schema without sampling source rows, review a
disabled boundary by exception, and ask repeated bounded questions without
exposing raw SQL or write credentials to the model. A selected analysis can
later be protected as a disabled named capability for explicit production
activation; protecting every exploratory question is not required.

Short path:

```bash
npx -y @synapsor/runner start
```

Paste a read-only URL into the hidden prompt, explicitly approve a regular
project `.env` file for this process, or export `DATABASE_URL`. PostgreSQL
defaults to `public`; explicit `--from-env`, `--schema`, and `--project-root`
flags remain available and always win. Runner stores environment-variable names
in `synapsor.runner.json`, not database URLs.
