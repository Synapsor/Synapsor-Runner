# MCP Client Setup

The primary local proof path is still the one-command Docker demo:

```bash
./scripts/demo-docker.sh
```

Use this page after that demo passes and you want to attach a local MCP client
or SDK. The simplest local-client contract is stdio. Standard HTTP MCP is
available through Streamable HTTP when your agent connects to a long-running
Runner service.

The checked [Client And Framework Recipes](client-recipes.md) use one shared
`support.propose_plan_credit` flow and distinguish host evidence from standard
MCP protocol evidence.

Proposal tools also advertise a standard display-only
[MCP App](mcp-apps.md). Supporting hosts discover it from tool metadata;
other clients keep the same text/JSON proposal result. Approval and apply
remain outside MCP in both cases.

Command examples use the stable untagged package through `npx`. From a source
checkout, use `./bin/synapsor-runner ...` only when you intentionally want the
local source wrapper.

Checked examples live in:

```text
examples/mcp-client-configs/
```

Validate them with:

```bash
corepack pnpm test:mcp-client-configs
```

## Stdio Vs HTTP MCP

| Mode | Use when | Command |
| --- | --- | --- |
| stdio | Claude Desktop, Cursor, VS Code, or another local MCP client can launch Synapsor Runner | `synapsor-runner mcp serve` |
| Streamable HTTP MCP | Your app/server, Python agent, Node service, or container uses a standard HTTP MCP client | `synapsor-runner mcp serve-streamable-http` |
| JSON-RPC bridge | Your app wants a small explicit wrapper around `tools/list`, `tools/call`, and `resources/read` | `synapsor-runner mcp serve-http` |

Stdio keeps the MCP protocol on process stdin/stdout and is the simplest local
developer path. Streamable HTTP implements MCP initialize/session behavior over
an authenticated `/mcp` endpoint. The JSON-RPC bridge is intentionally smaller
and does not implement MCP initialize/session behavior.

HTTP requires Bearer authentication by default. `Bearer` is the HTTP
presentation scheme; for this loopback example it carries one opaque random
endpoint token, not a user identity or JWT. The operator generates it and
provisions the same environment value to Runner and the authorized client:

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

OpenAI Agents SDK rejects dotted function/tool names such as
`billing.inspect_invoice`. For OpenAI-facing transports, ask Runner to expose
OpenAI-safe aliases while keeping canonical Synapsor capability names in MCP
metadata:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

The model sees names such as `billing__inspect_invoice`; `_meta` includes
`synapsor.canonical_tool_name = billing.inspect_invoice`, and Runner routes the
alias back to the canonical capability. Use `--alias-mode both` only when a
migration needs canonical dotted names and OpenAI-safe aliases exposed at the
same time.

Preview the exact alias mapping before wiring a client:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --alias-mode openai
```

Do not distribute one opaque token to unrelated users or tenants. A
non-loopback service also needs direct TLS or an explicitly trusted TLS proxy;
a shared service uses short-lived signed JWTs issued by your identity provider,
with tenant/principal bound from verified claims. Details: [HTTP MCP](http-mcp.md).

## Generate A Client Snippet

Print a snippet without modifying any client files:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp config claude-desktop \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Supported client names:

```text
generic-stdio
generic
claude-desktop
cursor
vscode
openai-agents
```

For OpenAI Agents SDK, generate the Streamable HTTP start command and Python
snippet:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp client-config \
  --client openai-agents \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The older form is still supported:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp configure --client claude-desktop --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Write is opt-in and requires an explicit destination:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp configure \
  --client cursor \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --write \
  --destination ./cursor-mcp.json
```

When the destination already exists, Synapsor Runner creates a timestamped
backup before writing. Noninteractive scripts must add `--yes`.

The command writes only command arguments and, for HTTP clients, credential
environment references plus external authorization metadata. It never writes
database URLs, passwords, token values, client secrets, or refresh tokens into
the generated client config.

No separate Apps flag is required. A compatible host discovers
`ui://synapsor/proposal-review.html` from proposal-tool metadata. The app can
display the exact diff, but it has no approval/apply authority; use the
standalone local UI or terminal for human review.

## Start Command

From the runner repository:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
```

For reproducible deployments, pin an exact stable version in package manifests
and MCP client configuration. The untagged examples above intentionally resolve
the current `latest` release.

For standard app/server HTTP MCP mode:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./examples/mcp-postgres-billing/synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

For the smaller JSON-RPC bridge, use `synapsor-runner mcp serve-http` instead.
The bridge is not standard Streamable HTTP and cannot provide claim-bound MCP
sessions, so do not use it for a shared identity deployment.

## Generic stdio Client

```json
{
  "mcpServers": {
    "synapsor-runner": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@synapsor/runner",
        "synapsor-runner",
        "mcp",
        "serve",
        "--config",
        "./examples/mcp-postgres-billing/synapsor.runner.json",
        "--store",
        "./.synapsor/local.db"
      ],
      "env": {
        "BILLING_POSTGRES_READ_URL": "${BILLING_POSTGRES_READ_URL}",
        "SYNAPSOR_TENANT_ID": "${SYNAPSOR_TENANT_ID}",
        "SYNAPSOR_PRINCIPAL": "${SYNAPSOR_PRINCIPAL}"
      }
    }
  }
}
```

The MCP server should list semantic tools such as:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
```

It should not list:

```text
execute_sql
run_query
approve_proposal
commit_proposal
```

## Sanity Check The Agent Connection

After installing the MCP client snippet, restart the client and run a deliberately
small tool-call test.

First confirm what Runner exposes:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Then ask the MCP client:

```text
Use the Synapsor Runner MCP tool to inspect invoice INV-3001.
Do not answer from memory.
Return the tool name called, the evidence handle, and whether raw SQL was available.
```

Expected result:

- the client calls a tool such as `billing.inspect_invoice`;
- the response includes an evidence handle or local ledger reference;
- the model reports that raw SQL, write credentials, approval tools, and commit
  tools were not available.

If the answer is generic prose or unrelated task planning with no tool call and
no evidence handle, Synapsor Runner is not connected to that agent session yet.
Check the MCP config path, restart the client, set trusted context env vars, and
run `tools/list` or `synapsor-runner tools preview` again.

## Claude Desktop / Cursor / VS Code

Use the matching checked-in example as the starting point:

```text
examples/mcp-client-configs/claude-desktop.json
examples/mcp-client-configs/cursor.json
examples/mcp-client-configs/vscode.json
```

Each example uses the same stdio command/args/env structure. Replace the placeholder environment variables in your client settings or shell environment.

These checked-in desktop examples use stdio, which is the recommended local
path for Claude Desktop, Cursor, and VS Code. The OpenAI Agents SDK recipe is
syntax-checked, and the HTTP endpoint is interoperability-tested with the
official MCP TypeScript client; repository CI does not claim to exercise an
identity-provider login inside every third-party host.

Do not add a write database URL to the MCP server environment unless you are intentionally running a local review/writeback demo. For normal read/proposal tool calls, use the read URL and trusted context values only.

Before documenting a client UI as officially tested, verify:

1. the server starts;
2. `tools/list` returns semantic tools;
3. read tools return evidence handles;
4. proposal tools return exact diffs and `source_database_changed: false`;
5. no approval or commit tool is model-callable;
6. resource reads work for proposal/evidence/replay handles.

## Troubleshooting

- Server not listed: check the command path, working directory, and config path.
- Tool schema mismatch: run `synapsor-runner audit <exported-tools.json>`.
- Missing trusted context: set `SYNAPSOR_TENANT_ID` and `SYNAPSOR_PRINCIPAL`, or use the environment variables configured in `trusted_context.values`.
- Database unavailable: verify the read credential and host access.
- Proposal waiting review: approve outside the model with `synapsor-runner proposals approve`.
- Stale-row conflict: inspect replay; the source row changed after the proposal was created, so the guarded worker refused to commit.
