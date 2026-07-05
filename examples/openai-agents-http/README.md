# OpenAI Agents SDK + Synapsor Runner Streamable HTTP MCP

This example shows an OpenAI Agents SDK app connecting to a long-running
Synapsor Runner Streamable HTTP MCP server.

Use HTTP when your agent runs as an app/server and should connect to Runner
over a local/private network endpoint instead of launching a stdio child
process.

This example uses `synapsor-runner mcp serve-streamable-http`, the
spec-compatible HTTP MCP transport with `initialize` and session behavior. Use
`synapsor-runner mcp serve-http` only when you intentionally want the smaller
JSON-RPC bridge and an app-owned wrapper.

OpenAI function names cannot contain dots, so start Runner with
`--alias-mode openai`. The model sees aliases such as
`billing__inspect_invoice`; Runner keeps `billing.inspect_invoice` in MCP
metadata and maps calls back to the canonical Synapsor capability.

The model still sees a semantic action. It does not receive raw SQL, database
URLs, write credentials, approval tools, or commit tools.

## Smoke Check

Run this without an OpenAI API key:

```bash
make smoke
```

Expected output:

```text
OpenAI Agents Streamable HTTP example smoke passed.
```

## Terminal 1: Start Synapsor Runner HTTP MCP

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="openai_agent_demo"
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-token"

npx -y -p @synapsor/runner synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --alias-mode openai
```

## Terminal 2: Run The Agent

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY="..."
export SYNAPSOR_RUNNER_HTTP_URL="http://127.0.0.1:8766/mcp"
export SYNAPSOR_RUNNER_HTTP_TOKEN="dev-token"
export SYNAPSOR_INVOICE_ID="INV-3001"

python agent.py
```

Expected behavior:

- the agent calls the OpenAI-safe alias `billing__inspect_invoice` through
  Synapsor HTTP MCP;
- Runner maps that alias back to canonical `billing.inspect_invoice`;
- Synapsor applies trusted tenant/principal context from the server process;
- the response includes scoped data and evidence handles;
- no SQL/write/approval tool is exposed to the model;
- evidence/query audit are saved in the local Runner store.

For production-like deployment, keep HTTP MCP behind private networking/TLS,
bearer auth, and rate limits. See [HTTP MCP](../../docs/http-mcp.md).
