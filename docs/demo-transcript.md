# First-Run Demo Transcript

This is the expected high-level transcript for:

```bash
./scripts/try-synapsor.sh
```

Exact timings and log paths vary.

```text
Synapsor Runner first-run demo

You are about to see an MCP agent propose a database change without receiving SQL or write credentials.
Full logs will be written to: ./.synapsor/logs/try-synapsor-<timestamp>.log

Step 1: MCP tools exposed
  In this fixture, the model sees semantic tools such as billing.inspect_invoice and billing.propose_late_fee_waiver.

Step 2: Agent inspects business object
Step 3: Agent proposes change
Step 4: Source DB changed: No
Step 5: Human approval outside MCP
Step 6: Trusted runner applies guarded writeback
Step 7: Replay explains what happened
Step 8: Extra safety checks catch stale rows and unsafe tools

Running the disposable Docker proof. This can take a few minutes...

Success. You saw the Synapsor commit boundary.

In the included fixture, the model got:
* billing.inspect_invoice
* billing.propose_late_fee_waiver

The model did not get:
* execute_sql
* write credentials
* approve/commit tools

Next:

1. Open proposal UI:
   npx -y -p @synapsor/runner@alpha synapsor ui --tour --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db

2. Run the reference app:
   corepack pnpm demo:reference

3. Generate MCP client config:
   npx -y -p @synapsor/runner@alpha synapsor mcp config --absolute-paths --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db

4. Use your own staging Postgres/MySQL:
   export DATABASE_URL='<postgres-or-mysql-read-url>'
   npx -y -p @synapsor/runner@alpha synapsor inspect --from-env DATABASE_URL
   npx -y -p @synapsor/runner@alpha synapsor init --wizard --from-env DATABASE_URL
```

The full log should include the lower-level proof:

- local MCP Postgres example passed;
- local MCP MySQL example passed;
- `ACCEPT semantic tools present`;
- `ACCEPT execute_sql approval and commit tools absent`;
- `ACCEPT proposal created successfully`;
- `ACCEPT source row unchanged after proposal`;
- `ACCEPT approval happened outside MCP`;
- `ACCEPT guarded writeback applied`;
- retry was idempotent;
- `ACCEPT stale-row conflict detected`;
- `ACCEPT replay export contains applied receipt`.

The first-run script fails if the log appears to contain database URLs,
fixture passwords, or bearer tokens.
