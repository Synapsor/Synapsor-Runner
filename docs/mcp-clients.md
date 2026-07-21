# MCP Client Configs

Synapsor Runner exposes reviewed semantic tools over standard MCP. The model
receives inspect/propose capabilities; it does not receive raw SQL, database
credentials, approval commands, or apply commands.

Proposal tools advertise a display-only [MCP App](mcp-apps.md). Hosts that
implement the Apps extension can render the exact proposal diff inline.
Clients without it receive the same structured/text result, and human approval
still occurs in the standalone operator UI or terminal.

The complete copy-paste templates live in:

- [`examples/support-plan-credit/mcp-client-examples/`](../examples/support-plan-credit/mcp-client-examples/)
- every local `synapsor-runner contract bundle` output;
- every downloadable Synapsor Cloud runner bundle.

For one shared proposal call across Claude Code, Codex, VS Code, OpenAI Agents,
LangChain/LangGraph, Google ADK, LlamaIndex, and generic MCP clients, see
[Client And Framework Recipes](client-recipes.md). Each recipe states whether
it is host-tested, configuration-tested, protocol-tested, or recipe-only.

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

Prefer Runner's owned project lifecycle for one repository:

```bash
synapsor-runner mcp install cursor --project --dry-run \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner mcp install cursor --project --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner mcp status cursor --project --check-launch
```

Runner previews the merge, backs up an existing `.cursor/mcp.json`, preserves
other MCP servers/settings, writes an exact-version `npx` invocation, and
tracks only its own entry with an integrity marker. Repeating install is
idempotent. `mcp uninstall cursor --project --yes` removes only that intact,
Runner-owned entry and also creates a backup.

For global setup, merge `cursor-global.mcp.json` through Cursor's MCP settings
and replace every `<absolute-path-to-bundle>` marker. Restart the MCP server
from Cursor settings after editing.

The model-facing list should contain only the contract's inspect/propose tools.
If Cursor reports a missing config or store, use absolute paths and rerun
`tools preview` from the same working directory.

Cursor can be configured to auto-run model-facing tools. Synapsor therefore
never exposes approval, apply, revert, policy activation, trusted identity, or
credentials as MCP tools. Inline MCP App review is not assumed for Cursor; use
the secured localhost workbench or operator CLI. No Add to Cursor deep link is
generated because Runner has not verified a currently documented generic
payload for this server. See [Host Compatibility](host-compatibility.md).

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

MCP App discovery is automatic from the proposal tool's
`_meta.ui.resourceUri`; it does not require credentials in the client snippet.

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
