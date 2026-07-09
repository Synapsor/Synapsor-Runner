# MCP Client Configs

Synapsor Runner exposes reviewed semantic tools over standard MCP. The model
receives inspect/propose capabilities; it does not receive raw SQL, database
credentials, approval commands, or apply commands.

The complete copy-paste templates live in:

- [`examples/support-plan-credit/mcp-client-examples/`](../examples/support-plan-credit/mcp-client-examples/)
- every local `synapsor-runner contract bundle` output;
- every downloadable Synapsor Cloud runner bundle.

## Stdio

Use stdio for Claude Desktop, Cursor, and other local MCP clients:

```json
{
  "command": "npx",
  "args": [
    "-y", "-p", "@synapsor/runner", "synapsor-runner",
    "mcp", "serve", "--config", "./synapsor.runner.json",
    "--store", "./.synapsor/local.db"
  ]
}
```

Relative paths are resolved from the MCP client's working directory. Use the
project template when the client starts in your repository; replace the marked
bundle path in the global template when it does not.

## Streamable HTTP

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Connect a standard Streamable HTTP MCP client to
`http://127.0.0.1:8766/mcp`. Keep it on loopback for local development. For a
network deployment, terminate TLS, require authentication, restrict network
access, and follow the [production guide](production.md).

## Verify The Boundary

```bash
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The preview must list semantic capabilities and must not list `execute_sql`,
approval/apply tools, database URLs, write credentials, or model-controlled
tenant authority.
