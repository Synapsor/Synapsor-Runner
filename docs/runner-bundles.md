# Runner Bundles

A runner bundle is the portable Cloud-to-local side of the canonical loop:

```text
local DSL/spec -> cloud push -> immutable registry version -> runner bundle -> local Runner
```

Every bundle contains:

```text
synapsor.contract.json
synapsor.runner.json
.env.example
README.md
mcp-client-examples/
  claude-desktop.json
  cursor-project.mcp.json
  cursor-global.mcp.json
  openai-agents-stdio.ts
  openai-agents-streamable-http.ts
  generic-stdio.json
  generic-streamable-http.json
```

It never contains database passwords, write credentials, live API tokens,
private keys, customer rows, or machine-specific local paths.

## Create Locally

```bash
synapsor-runner contract bundle ./synapsor.contract.json \
  --out ./synapsor-runner-bundle
```

## Run A Downloaded Bundle

```bash
cd ./synapsor-runner-bundle
cp .env.example .env
set -a && . ./.env && set +a

npx -y -p @synapsor/runner synapsor-runner contract validate ./synapsor.contract.json
npx -y -p @synapsor/runner synapsor-runner config validate --config ./synapsor.runner.json
npx -y -p @synapsor/runner synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For the OpenAI Agents SDK, use the included TypeScript examples. Their stdio
command enables `--alias-mode openai`; the Streamable HTTP example includes the
matching server command. Claude, Cursor, and generic templates use canonical
dotted capability names.

Approval and writeback remain outside the model-facing MCP tool surface. Use
`proposals`, `apply`, `receipts`, and `replay` from a trusted operator shell.

The bundle's `.env.example` contains names and placeholders only. Fill it for a
local or staging source, source it into the shell or process that launches your
MCP client, and keep the resulting `.env` out of source control.
