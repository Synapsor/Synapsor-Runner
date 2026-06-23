# MCP MySQL orders demo

This local demo exposes semantic MCP tools for an order/refund-review workflow:

- `orders.inspect_order`
- `orders.propose_refund_review`

The proposal updates only internal review fields. It does not issue money movement or pretend a payment provider action is transactional SQL. The source MySQL database remains unchanged until an approved proposal is applied by the trusted runner.

## Run

From the repository root:

```bash
corepack pnpm test:mcp-local
```

The shared smoke script starts this disposable MySQL fixture, calls the MCP tools through stdio, verifies evidence/resource handles, approves the proposal with the CLI, applies it through guarded writeback, retries idempotently, and proves stale-row conflict.

## Manual setup

```bash
docker compose -f examples/mcp-mysql-orders/docker-compose.yml up -d

export ORDERS_MYSQL_READ_URL="mysql://synapsor_reader:synapsor_reader_password@localhost:53307/synapsor_runner_mcp_orders"
export ORDERS_MYSQL_WRITE_URL="mysql://synapsor_writer:synapsor_writer_password@localhost:53307/synapsor_runner_mcp_orders"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_orders_agent"

npx -y -p @synapsor/runner@alpha synapsor mcp serve \
  --config examples/mcp-mysql-orders/synapsor.runner.json \
  --store ./tmp/mcp-mysql-orders/local.db
```

Configure your local MCP client to run the same command over stdio.
