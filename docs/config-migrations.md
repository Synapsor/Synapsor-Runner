# Config Migrations

Synapsor Runner config files are versioned with `version: 1`.

Current v0.1 behavior:

- `synapsor config validate` validates the current schema;
- `synapsor config show --redacted` prints a secret-safe view;
- `synapsor init --spec onboarding-selection.json --non-interactive` generates
  a version 1 config from reviewed selections.

There is no broad config migration command yet. Do not silently reinterpret an
old config as broader authority.

Future migrations should follow these rules:

- require an explicit `synapsor config migrate` command;
- keep secrets out of migrated files;
- preserve or narrow permissions by default;
- never widen source, table, tenant, conflict, or mutable-column authority
  without explicit user confirmation;
- write a backup before modifying a config;
- test old-to-new migrations with fixtures.
