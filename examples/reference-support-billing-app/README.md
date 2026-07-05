# Reference Support/Billing App

This is the main local reference app for Synapsor Runner.

It shows the commit-safe MCP loop against a disposable Postgres app database:

1. The MCP model sees semantic tools, not `execute_sql`.
2. Reads are scoped by trusted `SYNAPSOR_TENANT_ID` and `SYNAPSOR_PRINCIPAL`.
3. Proposal tools create exact diffs and leave the source database unchanged.
4. Approval happens through the local CLI or UI, outside MCP.
5. The trusted runner applies one guarded update with tenant, allowed-column, idempotency, and `updated_at` conflict checks.
6. Replay exports evidence, diff, approval, writeback receipt, and conflict outcome.

The app fixture is split into `schema.sql` and `seed.sql` so the database shape
and demo data are easy to inspect.

## Start

From the repository root:

```bash
docker compose -f examples/reference-support-billing-app/docker-compose.yml up -d

export REFERENCE_POSTGRES_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55435/synapsor_reference_support_billing"
export REFERENCE_POSTGRES_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_support_operator"
```

Or run the complete success/conflict/replay smoke:

```bash
examples/reference-support-billing-app/scripts/run-demo.sh
```

Validate the reviewed contract:

```bash
npx -y -p @synapsor/runner synapsor-runner config validate --config examples/reference-support-billing-app/synapsor.runner.json
npx -y -p @synapsor/runner synapsor-runner doctor --config examples/reference-support-billing-app/synapsor.runner.json
```

Serve MCP:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp serve \
  --config examples/reference-support-billing-app/synapsor.runner.json \
  --store ./tmp/reference-support-billing/local.db
```

## Tools

The model-facing MCP tools are:

- `support.inspect_ticket`
- `support.propose_ticket_resolution`
- `support.inspect_customer_account`
- `support.propose_plan_credit`
- `billing.inspect_invoice`
- `billing.propose_late_fee_waiver`
- `orders.inspect_order`
- `orders.propose_status_change`

The model does not receive approval tools, commit tools, write credentials, raw SQL, arbitrary table names, arbitrary column names, or tenant authority.

## Safe Write Examples

After `synapsor-runner demo` or after starting this fixture manually, try the same
proposal-first loop without connecting an MCP client:

```bash
npx -y -p @synapsor/runner synapsor-runner propose billing.propose_late_fee_waiver --sample
npx -y -p @synapsor/runner synapsor-runner proposals show latest
npx -y -p @synapsor/runner synapsor-runner proposals approve latest --yes
npx -y -p @synapsor/runner synapsor-runner apply latest
npx -y -p @synapsor/runner synapsor-runner replay latest
```

Expected safety output:

```text
Source DB changed:
no

Guarded writeback applied.
* proposal approved: yes
* primary key matched: yes
* tenant guard matched: yes
* allowed columns only: yes
* conflict guard passed: yes
```

Other proposal examples use the same review/apply/replay path:

```bash
npx -y -p @synapsor/runner synapsor-runner propose support.propose_plan_credit --sample
npx -y -p @synapsor/runner synapsor-runner propose orders.propose_status_change --sample
```

Safety guarantees:

- proposals store evidence, a before/after diff, trusted tenant/principal
  context, and query audit before any write;
- approval stays outside the model-facing MCP tool surface;
- writeback is single-row, primary-key targeted, tenant guarded,
  allowed-column checked, idempotent, and conflict guarded;
- stale rows return `conflict` and are replayable.

Current limitation: v0.1 is intentionally local and single-user. It does not
provide hosted RBAC, workflow DAGs, branches, settlement policies, auto-merge,
or production-scale runner orchestration.

## Review And Replay

After a proposal exists:

```bash
npx -y -p @synapsor/runner synapsor-runner proposals list --store ./tmp/reference-support-billing/local.db
npx -y -p @synapsor/runner synapsor-runner proposals approve <proposal_id> --store ./tmp/reference-support-billing/local.db --actor local_reviewer --yes
npx -y -p @synapsor/runner synapsor-runner proposals writeback-job <proposal_id> --store ./tmp/reference-support-billing/local.db --output ./tmp/reference-support-billing/job.json
npx -y -p @synapsor/runner synapsor-runner apply --job ./tmp/reference-support-billing/job.json --store ./tmp/reference-support-billing/local.db
npx -y -p @synapsor/runner synapsor-runner replay export <proposal_id> --store ./tmp/reference-support-billing/local.db --output ./tmp/reference-support-billing/replay.json
```

To inspect locally in a browser:

```bash
npx -y -p @synapsor/runner synapsor-runner ui \
  --config examples/reference-support-billing-app/synapsor.runner.json \
  --store ./tmp/reference-support-billing/local.db
```

## Stop

```bash
docker compose -f examples/reference-support-billing-app/docker-compose.yml down -v
```
