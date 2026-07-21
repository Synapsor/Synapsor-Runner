# MCP Host Compatibility

This matrix separates host evidence from protocol evidence. It was last
reviewed on 2026-07-20. A working MCP SDK handshake is not presented as proof
that a specific editor renders an extension or protects app-only controls.

| Host/surface | Status | Evidence and boundary |
| --- | --- | --- |
| Cursor project `.cursor/mcp.json` lifecycle | Tested | Runner install/status/uninstall tests cover preview, merge, backup, idempotency, ownership, tamper refusal, paths with spaces, and exact-version `npx` wiring. Local Cursor version observed: 3.7.21 (`517f696d8ab6c53eb04fbfdaae705cd146bf3460`, x64). |
| Cursor stdio Runner launch and `tools/list` | Protocol-tested | `mcp status cursor --project --check-launch` executes the generated command and checks the exact reviewed tools through the official MCP client transport. A final manual Cursor UI pass is still required for a release claim tied to that host version. |
| Cursor MCP Apps inline proposal card | Unknown | Runner advertises the standard display-only resource metadata, but current stable Cursor rendering and app-only authority guarantees have not been reproduced. Use the secured localhost workbench or operator CLI. |
| Cursor approval/apply/revert through MCP | Unsupported | Intentionally absent. Cursor may auto-run model-facing tools; commit authority therefore stays outside MCP regardless of host settings. |
| Generic Add to Cursor deep link | Unsupported | Runner does not generate a link because no current documented generic server payload has been verified end to end. Project install is the supported path. |
| Generic stdio MCP client | Protocol-tested | Official MCP SDK initialization, tool listing, calls, resources, and display-only Apps metadata are covered in the suite. |
| Generic Streamable HTTP MCP client | Protocol-tested | Official MCP SDK sessions, signed context, secret rotation, JWKS, mTLS, aliases, and session isolation are covered. |
| Claude Desktop | Protocol-tested | Packaged stdio configuration and MCP transport are tested; manual host UI behavior varies by version and remains a release checklist item. |
| Claude Code | Configuration-tested and protocol-tested | Claude Code 2.1.216 accepted the secret-free stdio configuration through `mcp add-json`; the same command completed MCP `tools/list`. A manual model-driven proposal call remains a release gate. |
| Codex | Configuration-tested and protocol-tested | Codex CLI 0.144.6 accepted the secret-free stdio configuration through `codex mcp add`; the same command completed MCP `tools/list`. A manual model-driven proposal call remains a release gate. |
| VS Code | Protocol-tested | The checked `.vscode/mcp.json` shape is parsed and the same stdio command completes MCP `tools/list`; manual editor UI behavior is not claimed. |
| OpenAI Agents SDK | Recipe-checked and protocol-tested | Packaged stdio/Streamable HTTP examples are syntax/safety checked and OpenAI-safe aliases are protocol-tested. The exact SDK agent call remains protocol-only until run with an owner-supplied API key. |
| LangChain/LangGraph | Recipe-checked, protocol-only | The current `@langchain/mcp-adapters` recipe lists tools, rejects unsafe authority, and calls the proposal tool. The framework runtime has not been executed in this release environment. |
| Google ADK | Recipe-checked, protocol-only | The current `McpToolset`/`StdioConnectionParams` recipe exposes only the two reviewed tools. The framework runtime has not been executed in this release environment. |
| LlamaIndex | Recipe-checked, protocol-only | The current `BasicMCPClient` recipe lists tools and calls the proposal tool. The framework runtime has not been executed in this release environment. |

## Cursor Project Setup

Current Cursor documentation supports project MCP configuration in
`.cursor/mcp.json`. Runner manages only its `synapsor` entry:

```bash
synapsor-runner mcp install cursor --project --dry-run
synapsor-runner mcp install cursor --project --yes
synapsor-runner mcp status cursor --project --check-launch
```

The generated entry contains command paths only. Database credentials and
trusted tenant/principal values must come from the environment that launches
Runner. Other Cursor MCP servers and settings are preserved.

Primary references:

- [Cursor MCP documentation](https://cursor.com/docs/context/mcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

All adjacent-host source links, runnable snippets, shared proposal input, and
verification commands are in [Client And Framework Recipes](client-recipes.md).

## Authority Fallback

Hosts without a verified app-only human-control boundary receive the same
structured/text proposal result and can open the secured loopback workbench.
Approval, rejection, apply, compensation, policy activation, trusted identity,
and credentials never enter model-visible `tools/list`. Runner does not infer
host safety from a product name or user-agent string.

Runner currently exposes tools, not MCP prompts or an elicitation-based
approval flow. First-run setup and approval do not depend on optional host
prompt/elicitation support.
