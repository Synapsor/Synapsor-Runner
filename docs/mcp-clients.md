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

For an activated local development/staging Auto Boundary, use the explicit
authoring mode instead of the named production config:

```bash
synapsor-runner mcp install claude-code \
  --project \
  --authoring \
  --project-root . \
  --yes
```

That entry advertises exactly `app.describe_data` and `app.explore_data`.
Cursor and VS Code use the same command with `cursor` or `vscode`. Production,
unknown-profile, remote, and shared HTTP surfaces never advertise those broad
authoring tools.

## Stdio

Use stdio for Claude Code, Claude Desktop, Cursor, VS Code, and other local MCP
clients:

```json
{
  "command": "npx",
  "args": [
    "-y", "@synapsor/runner",
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

### Managed Project Installs

Runner can safely manage its own project-local entry for Cursor, Claude Code,
or VS Code. Choose the client you actually use:

```bash
synapsor-runner mcp install cursor --project --dry-run \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner mcp install claude-code --project --dry-run \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner mcp install vscode --project --dry-run \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Replace `--dry-run` with `--yes` only after reviewing the preview, then verify
the selected client:

```bash
synapsor-runner mcp install claude-code --project --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
synapsor-runner mcp status claude-code --project --check-launch
```

| Client | Managed project file | Server map |
| --- | --- | --- |
| Cursor | `.cursor/mcp.json` | `mcpServers.synapsor` |
| Claude Code | `.mcp.json` | `mcpServers.synapsor` |
| VS Code | `.vscode/mcp.json` | `servers.synapsor` |

Runner previews the merge, backs up an existing file, preserves unrelated
servers and settings, writes an exact-version `npx` invocation, and tracks only
its own entry with a client-specific integrity marker under `.synapsor/`.
Repeating install is idempotent. VS Code JSON-with-comments, comments, and
trailing commas are preserved. `mcp uninstall <client> --project --yes`
removes only an intact Runner-owned entry and creates another backup.

No managed client file contains a database URL, credential, trusted tenant or
principal value, approval authority, or apply authority. Claude Code asks the
human to approve project-scoped MCP servers; that host approval does not grant
Synapsor activation, proposal approval, or writeback authority.

### Cursor

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

### Claude Code And VS Code

For Claude Code, restart or open a new project session after installation and
approve the project MCP server when prompted. For VS Code, reload the window
and start the Synapsor server. `mcp status <client> --project --check-launch`
validates the generated command with a real MCP initialize and `tools/list`
handshake; it does not claim that a model completed a host UI interaction.

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
export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

synapsor-runner mcp serve \
  --transport streamable-http \
  --alias-mode openai \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Connect a standard Streamable HTTP MCP client to
`http://127.0.0.1:8766/mcp` with `Authorization: Bearer` loaded from the same
protected environment value. Keep it on loopback for local development. A
non-loopback listener refuses to bind without direct TLS, an explicitly trusted
TLS proxy, or authenticated emergency break glass. Shared deployments require
identity-provider-issued signed claims. Follow [HTTP MCP](http-mcp.md) and the
[production guide](production.md).

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

Analytical tools advertise a machine-readable MCP `outputSchema`. Named
production analytics also appear in the versioned
`synapsor://analytics/catalog/v1` resource and:

```bash
synapsor-runner tools catalog \
  --config ./synapsor.runner.json \
  --json
```

External clients should validate typed input, consume authoritative
`structuredContent`, and pin the selected capability to the catalog's exact
contract digest. See the runnable
[Host-Neutral TypeScript MCP Client](../examples/host-neutral-typescript-client/)
for stdio and authenticated Streamable HTTP.

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
