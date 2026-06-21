# Config Migrations

Synapsor Runner config files are versioned with `version: 1`.

Current v0.1 behavior:

- `synapsor config validate` validates the current schema;
- `synapsor config show --redacted` prints a secret-safe view;
- `synapsor config migrate` checks whether the config is already current;
- `synapsor init --spec onboarding-selection.json --non-interactive` generates
  a version 1 config from reviewed selections.

Because version 1 is the only supported schema today, migration is conservative:

```bash
synapsor config migrate --config synapsor.runner.json
```

prints that the config is already current and writes nothing.

To write a normalized copy:

```bash
synapsor config migrate \
  --config synapsor.runner.json \
  --output migrated.json \
  --yes
```

To rewrite in place, the command requires an explicit write and creates a
timestamped backup:

```bash
synapsor config migrate \
  --config synapsor.runner.json \
  --write \
  --yes
```

The migration command rejects invalid configs and unsupported versions. It does
not silently reinterpret an old config as broader authority.

Future migrations should follow these rules:

- require an explicit `synapsor config migrate` command;
- keep secrets out of migrated files;
- preserve or narrow permissions by default;
- never widen source, table, tenant, conflict, or mutable-column authority
  without explicit user confirmation;
- write a backup before modifying a config;
- test old-to-new migrations with fixtures.
