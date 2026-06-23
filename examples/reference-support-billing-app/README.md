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
npx -y -p @synapsor/runner@alpha synapsor config validate --config examples/reference-support-billing-app/synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor doctor --config examples/reference-support-billing-app/synapsor.runner.json
```

Serve MCP:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp serve \
  --config examples/reference-support-billing-app/synapsor.runner.json \
  --store ./tmp/reference-support-billing/local.db
```

## Tools

The model-facing MCP tools are:

- `support.inspect_ticket`
- `support.propose_ticket_resolution`
- `billing.inspect_invoice`
- `billing.propose_late_fee_waiver`

The model does not receive approval tools, commit tools, write credentials, raw SQL, arbitrary table names, arbitrary column names, or tenant authority.

## Review And Replay

After a proposal exists:

```bash
npx -y -p @synapsor/runner@alpha synapsor proposals list --store ./tmp/reference-support-billing/local.db
npx -y -p @synapsor/runner@alpha synapsor proposals approve <proposal_id> --store ./tmp/reference-support-billing/local.db --actor local_reviewer --yes
npx -y -p @synapsor/runner@alpha synapsor proposals writeback-job <proposal_id> --store ./tmp/reference-support-billing/local.db --output ./tmp/reference-support-billing/job.json
npx -y -p @synapsor/runner@alpha synapsor apply --job ./tmp/reference-support-billing/job.json --store ./tmp/reference-support-billing/local.db
npx -y -p @synapsor/runner@alpha synapsor replay export <proposal_id> --store ./tmp/reference-support-billing/local.db --output ./tmp/reference-support-billing/replay.json
```

To inspect locally in a browser:

```bash
npx -y -p @synapsor/runner@alpha synapsor ui \
  --config examples/reference-support-billing-app/synapsor.runner.json \
  --store ./tmp/reference-support-billing/local.db
```

## Stop

```bash
docker compose -f examples/reference-support-billing-app/docker-compose.yml down -v
```
