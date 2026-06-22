# Config Migrations

Synapsor Runner config files are versioned with `version: 1`.

Command examples use the public `synapsor ...` runner CLI. From a source
checkout, use `./bin/synapsor ...` if the global binary is not linked yet.

Current behavior:

- `synapsor config validate` validates the current schema;
- `synapsor config show --redacted` prints a secret-safe view;
- `synapsor config migrate` checks whether the config is already current;
- `synapsor init --spec onboarding-selection.json --non-interactive` generates
  a version 1 config from reviewed selections.

The current alpha keeps `version: 1` and adds optional fields without requiring
a file rewrite:

- `contexts` lets capabilities reference named trusted context bindings;
- `capabilities[].context` selects one of those named contexts;
- `executors` and `capabilities[].executor` select `sql_update`,
  `http_handler`, or `command_handler` writeback execution.

Existing `trusted_context` configs remain valid. If both global
`trusted_context` and a named capability context exist, the capability-level
context wins for that capability. Missing context or executor references fail
validation.

Because version 1 is the only supported schema today, migration is conservative:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner config migrate --config synapsor.runner.json
```

prints that the config is already current and writes nothing.

To write a normalized copy:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner config migrate \
  --config synapsor.runner.json \
  --output migrated.json \
  --yes
```

To rewrite in place, the command requires an explicit write and creates a
timestamped backup:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner config migrate \
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
