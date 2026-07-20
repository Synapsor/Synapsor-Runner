# Raw SQL vs Synapsor

This minimal example shows the fear and the fix without requiring Docker, an
agent SDK, or a database.

## Run

```bash
make demo
```

Expected output includes:

```text
execute_sql
late_fee_cents: 5500 -> 0
Source changed:
  No
Guarded commit complete.
restart-safe retry: yes
stale apply refused: yes
```

The raw-SQL shortcut is:

```text
agent -> execute_sql("UPDATE invoices SET late_fee_cents = 0 ...")
```

The Synapsor path is:

```text
agent -> billing.propose_late_fee_waiver(...)
human approves outside MCP
guarded writeback applies exactly one row
replay records what happened
```

## Why This Exists

Use this folder when you want to show the core idea quickly. It is not a full
database fixture; the full support/billing walkthrough lives in
`../support-billing-agent/`.
