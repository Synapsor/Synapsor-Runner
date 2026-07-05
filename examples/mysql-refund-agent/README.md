# MySQL Refund Agent

This example points at the MySQL order/refund fixture and proves Synapsor
Runner is not Postgres-only.

The reviewed tools are:

- `orders.inspect_order`
- `orders.propose_refund_review`
- `orders.propose_status_change`

The refund proposal updates only review fields on one existing order. It does
not issue money movement, call a payment provider, or expose a generic SQL
tool.

## Run

```bash
make demo
```

Expected output includes the shared local MCP smoke passing for the MySQL orders
scenario:

```text
MySQL orders
ACCEPT execute_sql approval and commit tools absent
```

The source database remains unchanged until a proposal is approved outside MCP
and applied through guarded writeback.

## Underlying Fixture

This folder wraps `../mcp-mysql-orders/`, which contains the Docker compose
file, seed SQL, and `synapsor.runner.json` contract.
