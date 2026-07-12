# HTTP MCP

Use HTTP MCP when an app, server-side agent, container, or Python/Node process
needs to connect to a long-running Synapsor Runner service.

Use stdio MCP when a local MCP client such as Claude Desktop, Cursor, or a
local agent tool can launch Synapsor Runner directly.

Synapsor Runner has two HTTP modes:

- `mcp serve-streamable-http`: spec-compatible MCP Streamable HTTP. Use this
  when an MCP SDK/client expects `initialize`, session IDs, POST/GET/DELETE, and
  standard HTTP MCP behavior.
- `mcp serve-http`: a lightweight authenticated JSON-RPC bridge for
  `tools/list`, `tools/call`, and `resources/read`. Use this when your app wants
  simple POST calls or an explicit wrapper around Runner tools.

## Start Standard Streamable HTTP MCP

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

synapsor-runner mcp serve-streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

For OpenAI Agents SDK, expose OpenAI-safe aliases because OpenAI function names
cannot contain dots:

```bash
synapsor-runner mcp serve-streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

Equivalent unified command:

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

The model sees aliases such as `billing__inspect_invoice`. MCP tool metadata
still includes `synapsor.canonical_tool_name`, and Runner maps calls back to
the canonical Synapsor capability such as `billing.inspect_invoice`. Use
`--alias-mode both` only during migrations where some clients still need
canonical dotted names.

Defaults:

```text
host: 127.0.0.1
port: 8766
auth: bearer token required
cors: disabled
sessions: in-memory
```

Use `/mcp` as the MCP endpoint. Health is available at `/healthz`.

## TLS And mTLS

For a non-local long-running service, terminate TLS at a trusted proxy or start
Runner with env-backed PEM material:

```bash
export SYNAPSOR_TLS_CERT_PEM="$(cat ./server.crt)"
export SYNAPSOR_TLS_KEY_PEM="$(cat ./server.key)"

synapsor-runner mcp serve-streamable-http \
  --host 0.0.0.0 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --tls-cert-env SYNAPSOR_TLS_CERT_PEM \
  --tls-key-env SYNAPSOR_TLS_KEY_PEM
```

To require client certificates:

```bash
export SYNAPSOR_TLS_CA_PEM="$(cat ./client-ca.crt)"

synapsor-runner mcp serve-streamable-http \
  --host 0.0.0.0 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --tls-cert-env SYNAPSOR_TLS_CERT_PEM \
  --tls-key-env SYNAPSOR_TLS_KEY_PEM \
  --tls-ca-env SYNAPSOR_TLS_CA_PEM \
  --require-client-cert
```

The CLI reads PEM contents from environment variables and never prints them.
Runner-owned mTLS currently protects the Streamable HTTP MCP boundary. For
app-owned `http_handler` executors, terminate mTLS in your service mesh/proxy
or handler process and keep bearer/signature checks enabled in the handler.

## Start The JSON-RPC Bridge

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-local-token"

synapsor-runner mcp serve-http \
  --host 127.0.0.1 \
  --port 8765 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Defaults:

```text
host: 127.0.0.1
port: 8765
auth: bearer token required
cors: disabled
```

Bridge scope: `serve-http` does not implement MCP Streamable HTTP
`initialize`/session behavior. Standard SDK HTTP MCP clients should use
`serve-streamable-http` instead.

Startup output prints the URL, config path, store path, and token environment
variable name. It does not print token values or database URLs.

## Health Check

```bash
curl -i http://127.0.0.1:8766/healthz
curl -i http://127.0.0.1:8765/healthz
```

The health endpoint is secret-free:

```json
{
  "ok": true,
  "transport": "streamable-http",
  "tools": 1,
  "mode": "read_only"
}
```

## List Tools Through The JSON-RPC Bridge

Unauthorized requests fail:

```bash
curl -i \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8765/mcp
```

Authorized requests include the bearer token:

```bash
curl -i \
  -H "Authorization: Bearer dev-local-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8765/mcp
```

The tool catalog should contain semantic tools such as:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
```

It should not contain:

```text
execute_sql
raw_sql
approval tools
commit/apply tools
database URLs
write credentials
model-controlled tenant authority
arbitrary table or column names
```

## Call A Tool Through The JSON-RPC Bridge

```bash
curl -i \
  -H "Authorization: Bearer dev-local-token" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "billing.inspect_invoice",
      "arguments": { "invoice_id": "INV-3001" }
    }
  }' \
  http://127.0.0.1:8765/mcp
```

The response includes scoped data, trusted context, evidence handles, and
`source_database_mutated: false`. The agent still does not receive SQL,
database credentials, or approval/commit authority.

## Read Evidence Or Replay Resources Through The JSON-RPC Bridge

Use `resources/read` with a `synapsor://...` handle returned by a tool call:

```bash
curl -i \
  -H "Authorization: Bearer dev-local-token" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "resources/read",
    "params": { "uri": "synapsor://evidence/ev_..." }
  }' \
  http://127.0.0.1:8765/mcp
```

## CORS

CORS is disabled by default. If a local browser app needs access during
development, allow one explicit origin:

```bash
synapsor-runner mcp serve-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --cors-origin http://localhost:3000
```

Do not use wildcard CORS for a model-facing database tool service.

## Network Exposure

Synapsor Runner binds to `127.0.0.1` by default.

If you explicitly bind to all interfaces:

```bash
synapsor-runner mcp serve-http --host 0.0.0.0
```

the CLI prints a warning. Treat this as a production-like service:

- keep bearer auth enabled;
- use TLS or a trusted reverse proxy;
- prefer private networking;
- add rate limits and request-size limits at the edge;
- do not log request bodies by default;
- rotate the bearer token if it is exposed.

`--dev-no-auth` is accepted only on `localhost` or `127.0.0.1`. It fails closed
with `--host 0.0.0.0`.

## Trusted Context

Tenant and principal values must come from trusted configuration such as
environment variables or a server-side session. HTTP request arguments cannot
override trusted fields such as:

```text
tenant_id
principal
principal_id
project_id
source_id
allowed_columns
approval_identity
```

Use `read_only` mode first. Proposal/review mode should use a separate trusted
write path and a separate write credential. The model-facing HTTP MCP endpoint
must not receive write credentials.

## OpenAI Agents SDK

See:

```text
examples/openai-agents-http/
examples/openai-agents-stdio/
```

Both examples use the MCP client integration from the OpenAI Agents SDK when it
is available. The stdio example launches Runner as a child process. The HTTP
example connects to `synapsor-runner mcp serve-streamable-http` through
`MCPServerStreamableHttp`. Use the JSON-RPC bridge only when you intentionally
want a small app-owned wrapper instead of standard HTTP MCP.

The boundary is the same in both modes: the agent calls a semantic Synapsor
tool, not raw SQL. OpenAI-facing examples use `--alias-mode openai` so
the model sees OpenAI-valid aliases while Runner preserves canonical Synapsor
tool names in metadata.
