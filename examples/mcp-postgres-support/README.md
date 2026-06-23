# MCP Postgres support-ticket demo

This local demo exposes semantic MCP tools for a support workflow:

- `support.inspect_ticket`
- `support.propose_ticket_resolution`

The model can inspect one tenant-scoped ticket and propose a bounded status/resolution-note update. It cannot call raw SQL, approval, or commit tools. Approval happens outside the model-facing MCP surface, then the guarded runner applies the approved single-row update with primary-key, tenant, allowed-column, conflict, and idempotency guards.

## Run

From the repository root:

```bash
corepack pnpm test:mcp-local
```

The shared smoke script starts this disposable Postgres fixture, calls the MCP tools through stdio, verifies evidence/resource handles, approves the proposal with the CLI, applies it through guarded writeback, retries idempotently, and proves stale-row conflict.

## Manual setup

```bash
docker compose -f examples/mcp-postgres-support/docker-compose.yml up -d

export SUPPORT_POSTGRES_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55434/synapsor_runner_mcp_support"
export SUPPORT_POSTGRES_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55434/synapsor_runner_mcp_support"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_support_agent"

npx -y -p @synapsor/runner@alpha synapsor mcp serve \
  --config examples/mcp-postgres-support/synapsor.runner.json \
  --store ./tmp/mcp-postgres-support/local.db
```

Configure your local MCP client to run the same command over stdio.
