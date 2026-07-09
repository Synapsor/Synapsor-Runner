# MCP Client Configs

Synapsor Runner exposes reviewed semantic tools over standard MCP. The model
receives inspect/propose capabilities; it does not receive raw SQL, database
credentials, approval commands, or apply commands.

The complete copy-paste templates live in:

- [`examples/support-plan-credit/mcp-client-examples/`](../examples/support-plan-credit/mcp-client-examples/)
- every local `synapsor-runner contract bundle` output;
- every downloadable Synapsor Cloud runner bundle.

Before connecting a client, validate the local boundary:

```bash
synapsor-runner config validate --config ./synapsor.runner.json
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Set database and trusted-context values in the environment that launches the
MCP process. Keep real URLs and tokens in your shell or secret manager, not in
the checked-in client JSON.

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

### Claude Desktop

1. Open Claude Desktop settings and choose the developer option to edit its MCP
   configuration.
2. Merge `claude-desktop.json` into the existing `mcpServers` object.
3. Replace the marked working directory or use absolute paths when Claude does
   not start in the bundle directory.
4. Restart Claude Desktop completely, then confirm the two semantic tools are
   listed.

Claude Desktop launched from a graphical session may not inherit your terminal
environment. Supply the required env values through the OS process environment
or a local secret-manager wrapper; do not paste production credentials into a
repository file.

### Cursor

For one repository, place the project template at `.cursor/mcp.json`. For a
global setup, merge `cursor-global.mcp.json` through Cursor's MCP settings and
replace every `<absolute-path-to-bundle>` marker. Restart the MCP server from
Cursor settings after editing.

The model-facing list should contain only the contract's inspect/propose tools.
If Cursor reports a missing config or store, use absolute paths and rerun
`tools preview` from the same working directory.

### OpenAI Agents SDK

Install the SDK in your agent project and run either TypeScript template:

```bash
npm install @openai/agents
```

OpenAI function names cannot contain dots. The stdio template therefore starts
Runner with `--alias-mode openai`; model-visible names use `__`, while result
metadata preserves the canonical dotted Synapsor capability name.

## Streamable HTTP

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --alias-mode openai \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Connect a standard Streamable HTTP MCP client to
`http://127.0.0.1:8766/mcp`. Keep it on loopback for local development. For a
network deployment, terminate TLS, require authentication, restrict network
access, and follow the [production guide](production.md).

Use `--alias-mode openai` for the OpenAI Agents SDK. Omit it for clients that
accept canonical dotted names, or use `--alias-mode both` only during a planned
migration where duplicate canonical/alias tools are acceptable.

## Verify The Boundary

```bash
synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The preview must list semantic capabilities and must not list `execute_sql`,
approval/apply tools, database URLs, write credentials, or model-controlled
tenant authority.

## Troubleshooting

- `ENOENT` or missing config: use absolute config/store paths.
- empty tool list: run `contract validate`, then `tools preview` against the
  exact config used by the client.
- database connection failure: verify the client process received the read URL
  and trusted tenant/principal env values.
- OpenAI rejects a dotted name: start Runner with `--alias-mode openai`.
- HTTP `initialize` failure: use `mcp serve --transport streamable-http`, not
  the legacy `serve-http` JSON-RPC bridge.
- no ready message: inspect client stderr; Runner keeps stdout protocol-clean.
