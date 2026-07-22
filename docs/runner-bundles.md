# Runner Bundles

A runner bundle is the portable Cloud-to-local side of the canonical loop:

```text
local DSL/spec -> cloud push -> immutable registry version -> runner bundle -> local Runner
```

Every bundle contains:

```text
synapsor.contract.json
synapsor.runner.json
synapsor.cloud.json
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
npx -y -p @synapsor/runner synapsor-runner cloud connect --config ./synapsor.cloud.json
npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For proposal contracts, run the trusted worker in a separate
operator-controlled terminal:

```bash
set -a && . ./.env && set +a
npx -y -p @synapsor/runner synapsor-runner start --config ./synapsor.runner.json --store ./.synapsor/local.db
```

After an MCP tool creates a local proposal, sync its reviewed diff and safe
references to Cloud:

```bash
npx -y -p @synapsor/runner synapsor-runner cloud sync latest \
  --config ./synapsor.cloud.json \
  --store ./.synapsor/local.db
```

For the OpenAI Agents SDK, use the included TypeScript examples. Their stdio
command enables `--alias-mode openai`; the Streamable HTTP example includes the
matching server command and reads its Bearer credential from
`SYNAPSOR_RUNNER_HTTP_TOKEN`. The generic HTTP template uses the same environment
reference. Neither file embeds a credential value. An operator generates and
provisions the opaque token to the Runner process and authorized client; use a
signed identity-provider token instead for shared multi-user deployments. See
[HTTP MCP](http-mcp.md). Claude, Cursor, and generic stdio templates use
canonical dotted capability names and need no HTTP credential.

Approval and writeback remain outside the model-facing MCP tool surface. Use
`proposals`, `apply`, `receipts`, and `replay` from a trusted operator shell.

The bundle's `.env.example` contains names and placeholders only. Fill it for a
local or staging source, source it into the shell or process that launches your
MCP client, and keep the resulting `.env` out of source control.

The Cloud `source_id` scopes the Runner token and job queue. The contract's
source alias selects the local database adapter. They are intentionally
different identifiers. Cloud jobs never contain a database URL or handler
secret.
