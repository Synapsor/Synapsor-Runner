# OpenAI Agents SDK

Use Synapsor Runner with the OpenAI Agents SDK through standard MCP Streamable
HTTP. Runner exposes semantic database tools to the model and keeps approval,
writeback, database URLs, and write credentials outside the model-facing tool
surface.

## Start Runner

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

For this loopback/single-service example, the operator provisions that same
opaque value to the Runner process and the Python client through protected
environment injection. HTTP `Bearer` describes how the credential is sent; it
does not make the opaque value a JWT, and Runner does not issue it.

`--alias-mode openai` is important because OpenAI function/tool names cannot
contain dots. Runner exposes names such as `billing__inspect_invoice` to the
model and maps calls back to canonical Synapsor capability names such as
`billing.inspect_invoice`.

## Generate The Snippet

```bash
npx -y -p @synapsor/runner synapsor-runner mcp client-config \
  --client openai-agents \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --client-access-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

The generated output includes:

- the Streamable HTTP server command;
- the `/mcp` URL;
- a Python `MCPServerStreamableHttp` snippet;
- the OpenAI alias note.

It does not include database URLs, passwords, write credentials, API keys, or
bearer token values.

For a shared deployment, configure `http_claims`, asymmetric `session_auth`, and
`http_security.oauth_resource`, then use a separate env name such as
`SYNAPSOR_MCP_ACCESS_TOKEN`. Your configured identity provider issues that
short-lived token for the protected-resource audience; Runner validates it on
every request but never stores end-user passwords or issues/refreshes tokens.
The generated client URL is the configured HTTPS protected resource. See
[HTTP MCP](http-mcp.md) for the complete profile and TLS/proxy requirements.

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
