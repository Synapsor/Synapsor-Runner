# Postgres support ticket demo

This fixture demonstrates a support-ticket writeback for tenant `acme`, ticket `T-1042`.

Run local Postgres:

```bash
docker compose up -d
```

Dry-run without writing:

```bash
npx -y -p @synapsor/runner@alpha synapsor apply --job examples/postgres-support/job.approved.json --dry-run
```

Apply to the fixture database:

```bash
SYNAPSOR_DATABASE_URL=postgresql://synapsor_writer:synapsor_writer_password@localhost:55432/synapsor_runner_demo \
SYNAPSOR_DRY_RUN=false \
npx -y -p @synapsor/runner@alpha synapsor apply --job examples/postgres-support/job.approved.json
```

Expected cases to test:

- successful apply
- idempotent retry with the same job
- stale-version conflict after changing `updated_at`
- tenant mismatch by changing `tenant_guard.value`
- disallowed-column rejection by adding a patch column not in `allowed_columns`

