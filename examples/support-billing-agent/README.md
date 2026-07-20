# Support/Billing Agent Demo

This is the flagship Synapsor Runner demo. It uses a disposable PostgreSQL
database with row-level security (RLS) so the database independently checks the
same trusted tenant and principal scope as Runner.

It uses a disposable Postgres support/billing app and shows the full loop:

```text
agent inspects ticket SUP-184 and invoice INV-3001
-> agent creates a proposal
-> reviewer sees the exact $55 late-fee waiver
-> source database is unchanged
-> human approves outside MCP
-> guarded writeback applies exactly one row
-> replay shows evidence, diff, approval, receipt, and conflict behavior
-> strict shadow and effect checks compare behavior without enabling writes
```

## Run It

From this folder:

```bash
make demo
```

Expected end state:

```text
Reference support/billing app smoke passed.
Shadow comparison passed: 6 cases, 2 human outcomes, 1 exact agreement, 1 human rejection.
Effect regression passed: the reviewed $55 waiver effect is unchanged.
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
- the contract-visible result excludes `card_token`, `internal_risk_note`, and
  their seeded secret-looking values;
- trusted tenant and principal values are bound outside model arguments, and
  PostgreSQL RLS denies both cross-tenant and same-tenant cross-principal rows;
- `doctor --check-rls` verifies the live database policies before the demo;
- proposals do not mutate the source database;
- approved writeback uses tenant, primary-key, allowed-column,
  idempotency, and `updated_at` conflict guards;
- an identical retry returns the prior receipt without another mutation;
- stale data fails closed with `VERSION_CONFLICT`;
- replay contains the evidence, query audit, approval, writeback event, and
  receipt;
- strict Shadow Mode records a proposal but cannot approve or mutate it; and
- the shadow report compares cases with authoritative human outcomes before the
  effect fixture checks the expected business change.

RLS is defense in depth, not a claim that a fully compromised Runner process is
contained. A process that can choose arbitrary trusted context or replace the
database credential remains outside this guarantee. Production deployments
must authenticate context upstream, keep the database roles least-privileged,
and protect Runner's environment.

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

Use `make demo` for the live RLS, proposal, approval, writeback, idempotent
retry, stale-row conflict, replay, strict-shadow, human-outcome, and effect
proofs. Run only the deterministic comparison pass with:

```bash
make evaluate
```

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
- `scripts/run-evaluation.sh`
- `app/README.md`
- `shadow-study/cases.jsonl` and `shadow-study/outcomes.jsonl`: deterministic
  true-shadow reference data for agent-versus-authoritative-outcome reports.

See [Shadow Studies](../../docs/shadow-studies.md) for the import and report
commands. The reference cases do not mutate this demo database.

## Stop And Clean Up

The demo script cleans up its disposable Docker database automatically. If you
interrupt it, run:

```bash
make clean
```
