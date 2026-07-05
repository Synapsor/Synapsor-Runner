# Cursor + Postgres

This example prints a Cursor MCP config for a reviewed Postgres-backed Synapsor
Runner capability set.

It uses the local `examples/mcp-postgres-billing/synapsor.runner.json` fixture.
The config contains command paths and environment variable names only; it does
not include database URLs or write credentials.

## Run

```bash
make config
```

Expected output includes a Cursor-compatible `mcpServers.synapsor` entry that
launches:

```text
synapsor-runner mcp serve --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
```

Set the database and trusted-context variables in the environment that launches
Cursor:

```bash
export BILLING_POSTGRES_READ_URL="postgres://readonly:..."
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_billing_agent"
```
