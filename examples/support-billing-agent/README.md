# Support/Billing Agent Demo

This is the flagship Synapsor Runner demo.

It uses a disposable Postgres support/billing app and shows the full loop:

```text
agent inspects scoped evidence
-> agent creates a proposal
-> source database is unchanged
-> human approves outside MCP
-> guarded writeback applies exactly one row
-> replay shows evidence, diff, approval, receipt, and conflict behavior
```

## Run It

From this folder:

```bash
make demo
```

Expected end state:

```text
Reference support/billing app smoke passed.
```

The model-facing tools are exactly:

- `support.inspect_ticket`
- `support.propose_plan_credit`
- `billing.inspect_invoice`
- `billing.propose_late_fee_waiver`

The demo proves:

- the model-facing tool list contains semantic capabilities such as
  `billing.inspect_invoice` and `billing.propose_late_fee_waiver`;
- the model does not receive `execute_sql`, approval tools, commit/apply tools,
  database URLs, write credentials, arbitrary table names, arbitrary column
  names, or tenant authority;
- proposals do not mutate the source database;
- approved writeback uses tenant, primary-key, allowed-column,
  idempotency, and `updated_at` conflict guards;
- replay contains the evidence and writeback receipt.

## Compare The Unsafe Shortcut

To see why the boundary matters:

```bash
make unsafe
```

That target prints the raw-SQL shape this demo avoids. It does not mutate the
fixture; it shows the path an MCP client should not expose to the model:

```text
execute_sql("UPDATE invoices SET late_fee_cents = 0 ...")
```

Use `make demo` for the real proposal, approval, writeback, idempotent retry,
stale-row conflict, and replay proof.

## What This Wraps

This folder is self-contained for readers and agents looking for the canonical
support/billing demo. The smoke logic is shared with the reference fixture so
the product-facing walkthrough and package tests exercise the same safety
checks.

Relevant files:

- `db/schema.sql`
- `db/seed.sql`
- `synapsor.runner.json`
- `scripts/run-demo.sh`
- `app/README.md`

## Stop And Clean Up

The demo script cleans up its disposable Docker database automatically. If you
interrupt it, run:

```bash
make clean
```
