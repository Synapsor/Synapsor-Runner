# OpenAI Agents SDK + Synapsor Runner over stdio

This example shows an OpenAI Agents SDK app launching Synapsor Runner as a
local stdio MCP server.

Use stdio when the agent process can start the MCP server on the same machine.
The model sees Synapsor semantic tools through OpenAI-safe aliases such as
`billing__inspect_invoice`. Runner keeps the canonical Synapsor capability
name, such as `billing.inspect_invoice`, in MCP metadata and maps calls back to
it. The model
does not receive raw SQL, database URLs, write credentials, approval tools, or
commit tools.

## Smoke Check

Run this without an OpenAI API key:

```bash
make smoke
```

Expected output:

```text
OpenAI Agents stdio example smoke passed.
```

## Prerequisites

Generate `synapsor.runner.json` first:

```bash
npx -y -p @synapsor/runner synapsor-runner demo
```

or connect your own staging database:

```bash
npx -y -p @synapsor/runner synapsor-runner onboard db --from-env DATABASE_URL
```

Then install the Python dependencies:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
export OPENAI_API_KEY="..."
export DATABASE_URL="<postgres-or-mysql-read-url>"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="openai_agent_demo"

python agent.py
```

Optional env:

```bash
export SYNAPSOR_CONFIG="./synapsor.runner.json"
export SYNAPSOR_STORE="./.synapsor/local.db"
export SYNAPSOR_TOOL="billing.inspect_invoice"
export SYNAPSOR_INVOICE_ID="INV-3001"
```

Expected behavior:

- the agent can inspect the scoped invoice through Synapsor using an
  OpenAI-safe tool alias;
- Runner maps the alias back to the canonical Synapsor capability;
- the agent cannot run SQL;
- the agent cannot approve or commit writes;
- evidence/query audit are saved in the local Runner store.

If your installed OpenAI Agents SDK does not expose `MCPServerStdio`, update the
SDK or use the Streamable HTTP example.
