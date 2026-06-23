# MySQL orders demo

This fixture demonstrates order/refund writeback for tenant `acme`, order `O-1001`.

Run local MySQL:

```bash
docker compose up -d
```

Dry-run without writing:

```bash
npx -y -p @synapsor/runner@alpha synapsor apply --job examples/mysql-orders/job.approved.json --dry-run
```

Apply to the fixture database:

```bash
SYNAPSOR_DATABASE_URL=mysql://synapsor_writer:synapsor_writer_password@localhost:53306/synapsor_runner_demo \
SYNAPSOR_DRY_RUN=false \
npx -y -p @synapsor/runner@alpha synapsor apply --job examples/mysql-orders/job.approved.json
```

Expected cases mirror the Postgres demo: successful apply, idempotent retry, stale-version conflict, tenant mismatch, and disallowed-column rejection.

