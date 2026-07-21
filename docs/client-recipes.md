# Client And Framework Recipes

Every recipe on this page connects to the same reviewed Runner boundary:

- `support.inspect_customer`
- `support.propose_plan_credit`

The model never receives SQL, database credentials, trusted tenant identity,
approval, apply, activation, or revert authority. A proposal call returns an
exact effect with `source_database_changed: false`; a human reviews and applies
it outside the model-facing client.

Checked-in files live in
[`examples/support-plan-credit/mcp-client-examples/`](../examples/support-plan-credit/mcp-client-examples/).
They contain command paths and environment-variable names only.

## Evidence Labels

| Label | Meaning |
| --- | --- |
| Host-tested | The named host was exercised manually at the recorded version. |
| Configuration-tested | The named host's current CLI or config parser accepted the recipe. |
| Protocol-tested | Runner completed MCP initialization and `tools/list` through the official MCP SDK using the same command/transport. |
| Recipe-checked | The file is syntax-checked, secret-scanned, and matched to current official framework documentation. Its framework runtime was not executed here. |
| Unknown | No compatibility claim is made. |

Protocol evidence is not presented as proof of editor UI behavior. Current
evidence is summarized in [Host Compatibility](host-compatibility.md).

## Shared Preflight

Run from the Runner repository root after supplying your own environment-bound
staging credentials and trusted scope:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview \
  --config ./examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
```

The list must include the two semantic tools above and must not include
`execute_sql`, approve, apply, commit, activation, or revert tools.

Use this exact proposal input in each client:

```json
{
  "customer_id": "CUS-3001",
  "credit_cents": 2500,
  "reason": "SLA outage ticket SUP-481"
}
```

Expected result: a proposal id, exact before/after effect, evidence handle, and
`source_database_changed: false`. Review it outside the client in the secured
Workbench or operator CLI. Do not add an approval or apply MCP server/tool to
make the client flow feel shorter.

## Cursor

**Status:** configuration-tested and protocol-tested with Cursor 3.7.21 on
Linux; final manual editor UI verification remains a release gate.

Use Runner's owned project lifecycle:

```bash
synapsor-runner mcp install cursor --project --dry-run \
  --config ./examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
synapsor-runner mcp install cursor --project --yes \
  --config ./examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
synapsor-runner mcp status cursor --project --check-launch
```

Ask Cursor to inspect `CUS-3001`, then call
`support.propose_plan_credit` with the shared input. Review the Data PR outside
the model-facing tool surface.

## Claude Desktop

**Status:** configuration-parsed and protocol-tested; manual Desktop UI
behavior is not claimed.

Merge
[`claude-desktop.json`](../examples/support-plan-credit/mcp-client-examples/claude-desktop.json)
into Claude Desktop's `mcpServers`, restart the app, and verify the exact tool
list. Then ask for the shared proposal call.

## Claude Code

**Status:** configuration-tested with Claude Code 2.1.216 and
protocol-tested; a manual model-driven call remains a release gate.

Run the checked command from the repository root:

```bash
bash ./examples/support-plan-credit/mcp-client-examples/claude-code.sh
```

Claude Code records project-scoped MCP configuration without embedding source
credentials. It will print the exact proposal prompt after configuration.

Official source checked 2026-07-20:
[Claude Code MCP](https://code.claude.com/docs/en/mcp).

## Codex

**Status:** configuration-tested with Codex CLI 0.144.6 and protocol-tested;
a manual model-driven call remains a release gate.

Merge the contents of
[`codex.config.toml`](../examples/support-plan-credit/mcp-client-examples/codex.config.toml)
into the trusted project's `.codex/config.toml`, start Codex from the repository
root, and ask it to list the Synapsor tools before making the shared proposal
call.

Official source checked 2026-07-20:
[Codex MCP configuration](https://developers.openai.com/codex/mcp/).

## VS Code

**Status:** configuration-parsed and protocol-tested; manual VS Code UI
behavior is not claimed.

Copy or merge
[`vscode.mcp.json`](../examples/support-plan-credit/mcp-client-examples/vscode.mcp.json)
into `.vscode/mcp.json`. Start the server from VS Code, inspect the listed
tools, and ask for the shared proposal call.

Official source checked 2026-07-20:
[VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## OpenAI Agents SDK

**Status:** recipe-checked and underlying stdio/Streamable HTTP protocol-tested.
The exact SDK examples remain protocol-only until their agent calls are run
with an owner-supplied model API key.

Install `@openai/agents`, then run either:

- [`openai-agents-stdio.ts`](../examples/support-plan-credit/mcp-client-examples/openai-agents-stdio.ts)
- [`openai-agents-streamable-http.ts`](../examples/support-plan-credit/mcp-client-examples/openai-agents-streamable-http.ts)

Both examples instruct the agent to inspect the semantic tool list and create
the shared proposal. OpenAI-safe aliases are enabled where required; canonical
Synapsor capability names remain in result metadata.

Official source checked 2026-07-20:
[OpenAI Agents SDK MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/).

## LangChain And LangGraph

**Status:** recipe-checked and protocol-only.

Install `@langchain/mcp-adapters` and run
[`langchain.mjs`](../examples/support-plan-credit/mcp-client-examples/langchain.mjs).
It calls `getTools()`, refuses an unsafe tool surface, and invokes the proposal
tool directly. The returned proposal still requires human review outside the
agent.

Official source checked 2026-07-20:
[LangChain JavaScript MCP](https://docs.langchain.com/oss/javascript/langchain/mcp).
LangGraph can use the same LangChain MCP tools; no Synapsor-specific SDK is
needed.

## Google ADK

**Status:** recipe-checked and protocol-only.

Install the current Google ADK Python package and run
[`google-adk.py`](../examples/support-plan-credit/mcp-client-examples/google-adk.py)
with `GOOGLE_ADK_MODEL` and the provider credential supplied through the
environment. The `McpToolset` is filtered to the two reviewed Synapsor tools.

Official source checked 2026-07-20:
[Google ADK MCP tools](https://adk.dev/tools-custom/mcp-tools/).

## LlamaIndex

**Status:** recipe-checked and protocol-only.

Install `llama-index-tools-mcp` and run
[`llamaindex.py`](../examples/support-plan-credit/mcp-client-examples/llamaindex.py).
It uses `BasicMCPClient` to list tools and make the shared proposal call without
requiring a model-provider API.

Official source checked 2026-07-20:
[LlamaIndex MCP tools](https://developers.llamaindex.ai/python/examples/tools/mcp/).

## Generic MCP Clients

**Status:** protocol-tested through the official TypeScript MCP SDK.

Use:

- [`generic-stdio.mjs`](../examples/support-plan-credit/mcp-client-examples/generic-stdio.mjs)
- [`generic-streamable-http.mjs`](../examples/support-plan-credit/mcp-client-examples/generic-streamable-http.mjs)

Each script performs MCP initialization, validates `tools/list`, rejects
model-visible commit authority, and makes the shared proposal call. The HTTP
script reads its bearer token from `SYNAPSOR_RUNNER_HTTP_TOKEN`; it never embeds
one.

Official source checked 2026-07-20:
[Build an MCP client](https://modelcontextprotocol.io/docs/develop/build-client).

## Verify The Checked Recipes

```bash
corepack pnpm test:mcp-client-configs
```

That deterministic gate syntax-checks and secret-scans every recipe and proves
the shared stdio tool surface. To additionally make the proposal call against
the disposable support-plan-credit PostgreSQL fixture, set
`SYNAPSOR_CLIENT_RECIPES_CALL=1` after exporting the fixture's environment.
The call creates a proposal but performs no approval or source mutation.
