# OpenAI Agents SDK

Use Synapsor Runner with the OpenAI Agents SDK through standard MCP Streamable
HTTP. Runner exposes semantic database tools to the model and keeps approval,
writeback, database URLs, and write credentials outside the model-facing tool
surface.

## Start Runner

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

`--alias-mode openai` is important because OpenAI function/tool names cannot
contain dots. Runner exposes names such as `billing__inspect_invoice` to the
model and maps calls back to canonical Synapsor capability names such as
`billing.inspect_invoice`.

## Generate The Snippet

```bash
npx -y -p @synapsor/runner synapsor-runner mcp client-config \
  --client openai-agents \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The generated output includes:

- the Streamable HTTP server command;
- the `/mcp` URL;
- a Python `MCPServerStreamableHttp` snippet;
- the OpenAI alias note.

It does not include database URLs, passwords, write credentials, API keys, or
bearer token values.

## Sanity Check

Before giving the agent a real task, ask it to inspect one known object and
return the tool name it called plus the evidence handle. A healthy setup calls a
semantic tool such as `billing__inspect_invoice`. It should not expose
`execute_sql`, approval tools, commit/apply tools, database URLs, or write
credentials.

## Examples

```text
examples/openai-agents-http/
examples/openai-agents-stdio/
```
