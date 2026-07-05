# MCP MySQL orders demo

This local demo exposes semantic MCP tools for order/refund-review workflows:

- `orders.inspect_order`
- `orders.propose_refund_review`
- `orders.propose_status_change`

The refund-review proposal updates only internal review fields. The status-change
proposal demonstrates a reviewed state transition such as `paid -> shipped`.
Neither tool issues money movement or pretends a payment provider action is
transactional SQL. The source MySQL database remains unchanged until an
approved proposal is applied by the trusted runner.

## Run

From the repository root:

```bash
corepack pnpm test:mcp-local
```

The shared smoke script starts this disposable MySQL fixture, calls the MCP tools through stdio, verifies evidence/resource handles, approves the proposal with the CLI, applies it through guarded writeback, retries idempotently, and proves stale-row conflict.

## Status-Change Proposal

`orders.propose_status_change` demonstrates a bounded state transition. The
model can propose `paid -> shipped`, but it cannot commit the update.

Manual loop after the fixture is running:

```bash
npx -y -p @synapsor/runner synapsor-runner propose orders.propose_status_change \
  --config examples/mcp-mysql-orders/synapsor.runner.json \
  --store ./tmp/mcp-mysql-orders/local.db \
  --sample

npx -y -p @synapsor/runner synapsor-runner proposals show latest --store ./tmp/mcp-mysql-orders/local.db
npx -y -p @synapsor/runner synapsor-runner proposals approve latest --store ./tmp/mcp-mysql-orders/local.db --yes
npx -y -p @synapsor/runner synapsor-runner apply latest \
  --config examples/mcp-mysql-orders/synapsor.runner.json \
  --store ./tmp/mcp-mysql-orders/local.db
npx -y -p @synapsor/runner synapsor-runner replay latest --store ./tmp/mcp-mysql-orders/local.db
```

Expected safety output includes:

```text
Source DB changed:
no

Guarded writeback applied.
* allowed columns only: yes
* conflict guard passed: yes
```

Safety guarantee: only the reviewed status fields can change, the tenant guard
must match, and a stale `updated_at` value returns `conflict` instead of
overwriting newer order state.

Current limitation: this example is single-row review-mode writeback only. It
does not model payment settlement, fulfillment side effects, bulk updates, or
auto-merge.

## Manual setup

```bash
docker compose -f examples/mcp-mysql-orders/docker-compose.yml up -d

export ORDERS_MYSQL_READ_URL="mysql://synapsor_reader:synapsor_reader_password@localhost:53307/synapsor_runner_mcp_orders"
export ORDERS_MYSQL_WRITE_URL="mysql://synapsor_writer:synapsor_writer_password@localhost:53307/synapsor_runner_mcp_orders"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_orders_agent"

npx -y -p @synapsor/runner synapsor-runner mcp serve \
  --config examples/mcp-mysql-orders/synapsor.runner.json \
  --store ./tmp/mcp-mysql-orders/local.db
```

Configure your local MCP client to run the same command over stdio.
