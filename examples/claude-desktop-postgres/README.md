# Claude Desktop + Postgres

This example prints a Claude Desktop MCP config for a reviewed Postgres-backed
Synapsor Runner capability set.

It uses the local `examples/mcp-postgres-billing/synapsor.runner.json` fixture.
The config contains command paths and environment variable names only; it does
not include database URLs or write credentials.

## Run

```bash
make config
```

Expected output includes:

```json
{
  "mcpServers": {
    "synapsor": {
      "command": "...",
      "args": ["...", "mcp", "serve", "..."]
    }
  }
}
```

Then paste the JSON into Claude Desktop's MCP settings and set these
environment variables in the client environment:

```bash
export BILLING_POSTGRES_READ_URL="postgres://readonly:..."
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_billing_agent"
```

The model sees semantic tools such as `billing.inspect_invoice` and
`billing.propose_late_fee_waiver`; it does not see raw SQL or approval/commit
tools.
