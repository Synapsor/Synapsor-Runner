# MCP Postgres billing demo

This is the local proof demo for the database-MCP commit-safety wedge.

It exposes semantic MCP tools:

- `billing.inspect_invoice`
- `billing.propose_late_fee_waiver`

It does not expose `execute_sql`, approval, or commit tools to the model.

The demo proves:

- MCP `tools/list` returns semantic tools only.
- A read tool is tenant-scoped and evidence-backed.
- A proposal tool returns an exact before/after diff.
- The source Postgres row is unchanged after proposal creation.
- Approval is outside the model-facing tool surface.
- The generated writeback job is guarded by primary key, tenant, allowed columns, conflict guard, and idempotency.
- A stale row returns `conflict` instead of committing.

## Run

From the repository root:

```bash
corepack pnpm test:mcp-local
```

The script starts a disposable Postgres container, launches the local stdio MCP server through the official MCP client transport, calls the read/proposal tools, approves locally through the CLI, generates a versioned `synapsor.writeback-job.v1` job, applies it through the guarded Postgres adapter, retries idempotently, then proves stale-row conflict.

## Manual setup

```bash
docker compose -f examples/mcp-postgres-billing/docker-compose.yml up -d

export BILLING_POSTGRES_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55433/synapsor_runner_mcp_billing"
export BILLING_POSTGRES_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55433/synapsor_runner_mcp_billing"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_billing_agent"

corepack pnpm runner mcp serve \
  --config examples/mcp-postgres-billing/synapsor.runner.json \
  --store ./tmp/mcp-postgres-billing/local.db
```

Configure a local MCP client to run the same command over stdio.
