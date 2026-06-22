# Synapsor Runner

Safe MCP tools for your Postgres/MySQL database.

Open-source MCP safety layer for Postgres and MySQL.

Give AI agents reviewed database capabilities instead of raw SQL.

Synapsor Runner is a local MCP server that sits between Claude, Cursor, or
another MCP client and your database. The model can inspect scoped data and
create evidence-backed proposals, but it cannot directly write to
Postgres/MySQL. Approved changes are applied outside the model through guarded
writeback, with audit and replay.

Synapsor Runner is open source under Apache License 2.0. Apache-2.0 applies to
this runner repository, not the Synapsor name, logo, hosted Cloud service, or
proprietary Synapsor platform features.

## The Problem

Most database MCP demos expose tools like:

```text
execute_sql("UPDATE invoices SET late_fee_cents = 0 WHERE id = ...")
```

That gives the model too much power:

- raw SQL;
- write credentials;
- model-controlled scope;
- no proposal boundary;
- no approval boundary;
- weak replay/audit story.

## The Synapsor Way

Synapsor exposes semantic tools instead:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
```

The model can propose a business change. It cannot commit it.

```text
MCP client
-> Synapsor Runner
-> trusted context
-> scoped DB read
-> evidence-backed proposal
-> approval outside MCP
-> guarded writeback
-> replay
```

## Try It

Run the alpha CLI from npm:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner --help
```

Then run the local demo:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner demo
```

From a source checkout, you can also use the local wrapper:

```bash
./bin/synapsor demo
```

Want the 15-second fixture-only version first?

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner demo --quick
```

The demo starts a disposable local Postgres app, writes a safe capability
config, and prints the next commands.

Run the happy path:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner propose billing.propose_late_fee_waiver --sample
npx -y -p @synapsor/runner@alpha synapsor-runner proposals show latest
npx -y -p @synapsor/runner@alpha synapsor-runner proposals approve latest --yes
npx -y -p @synapsor/runner@alpha synapsor-runner apply latest
npx -y -p @synapsor/runner@alpha synapsor-runner replay latest
```

What you should see:

```text
Agent called:
billing.propose_late_fee_waiver

Proposal created:
invoice.late_fee_cents
5500 -> 0

Source DB changed:
no

Approval:
required outside MCP

After approval:
guarded writeback applied

Replay:
saved
```

That is the core point: the model can ask for a database-backed business
change, but durable state changes only after reviewed approval and guarded
writeback.

## Audit Your MCP Database Tools

`synapsor-runner audit` is a static MCP/database risk review. It is useful even before
you adopt the full runner.

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner audit examples/dangerous-mcp-tools.json
npx -y -p @synapsor/runner@alpha synapsor-runner audit ./synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor-runner audit --mcp-config ./claude_desktop_config.json
npx -y -p @synapsor/runner@alpha synapsor-runner audit --stdio "node ./my-db-mcp-server.js"
```

It looks for patterns such as:

- arbitrary SQL tools;
- broad database write tools;
- model-facing approval/commit tools;
- missing tenant/principal context;
- dangerous tool names;
- unclear parameter schemas;
- mutation tools without proposal/approval.

Example finding:

```text
Risk: high

Found:
- execute_sql appears to expose arbitrary database access.
- approve_refund appears to let the model approve a durable write.
- update_customer appears to mutate state without a proposal boundary.
- No trusted tenant/principal context was detected.

Suggested safer shape:
- billing.inspect_invoice
- billing.propose_late_fee_waiver
- approval outside MCP
- guarded writeback after approval

Note:
This is a static risk review, not a security guarantee.
```

## Use Your Own Staging Database

Start with staging, a disposable database, or a least-privilege view. Do not
start with your most sensitive production database.

```bash
export DATABASE_URL="postgres://..."
npx -y -p @synapsor/runner@alpha synapsor-runner inspect --from-env DATABASE_URL
npx -y -p @synapsor/runner@alpha synapsor-runner init --wizard --from-env DATABASE_URL
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The default guided setup is read-only. Database credentials stay in your local
environment. MCP client config does not include database URLs. Generated tools
are semantic capabilities, not raw table access. Proposal writeback requires
review mode, approval outside MCP, and a separate trusted write credential.

## Connect Claude, Cursor, Or Another MCP Client

Generate a local MCP client snippet:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Use a specific client shape when needed:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config cursor --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config vscode --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config generic --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The generated config references the local runner command. It does not include:

- database URL;
- database password;
- write credentials;
- approval tools;
- commit/apply tools.

## What The Model Gets

The model gets reviewed semantic capabilities from `synapsor.runner.json`, for
example:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
support.inspect_ticket
support.propose_plan_credit
orders.inspect_order
orders.propose_status_change
```

These are business tools with trusted scope, visible fields, evidence rules,
proposal boundaries, and writeback guards.

## What The Model Never Gets

Synapsor Runner does not expose:

```text
execute_sql
raw_sql
query_database
database URLs
write credentials
approval tools
commit/apply tools
arbitrary table names
arbitrary column names
model-controlled tenant authority
direct write access
```

Approval and writeback stay outside the model-facing MCP tool surface.

## Safety Model

```text
MCP client
-> Synapsor Runner
-> semantic capability
-> trusted tenant/principal context
-> scoped DB read
-> evidence-backed proposal
-> approval outside MCP
-> guarded writeback
-> receipt and replay
```

Current boundaries:

- no generic SQL tools;
- no model-facing approval or apply tools;
- tenant/principal scoping is enforced;
- allowed columns are enforced;
- primary-key targeting is required;
- conflict/version guards are available;
- idempotency keys are used;
- affected row count is checked;
- direct DB writeback is limited to guarded single-row `UPDATE`.

## Safety Checks It Catches

After the happy path, use the demo and tests to inspect failure cases:

- stale-row conflict;
- missing tenant context;
- disallowed write column;
- model-facing commit or approval tool;
- arbitrary SQL tool.

The important stale-row case:

```text
The row changed after the agent saw it.
Result: conflict
Source DB changed by Synapsor: no
```

Conflict handling is a safety check, not the first demo payoff.

## Mini-Synapsor Features In The Runner

| Synapsor concept | Runner version |
| --- | --- |
| Context bindings | Trusted tenant/principal from env, static dev config, HTTP claims, or cloud session |
| Capabilities | Local semantic MCP tools from `synapsor.runner.json` |
| Evidence | Local evidence bundles and query audit records |
| Proposals | Local before/after change sets |
| Approval | Local CLI/UI approval outside MCP |
| Writeback | Guarded single-row `UPDATE` for Postgres/MySQL |
| Replay | Local replay of proposal, evidence, events, receipts, and query audit |
| MCP audit | Static risk review for MCP database tools |

The runner intentionally does not include full Synapsor Cloud/DBMS features such
as workflow DAGs, native branches, time travel, settlement policies, governed
memory, RBAC/SSO, hosted evidence ledger, managed runners, CDC, or C++ DBMS
internals.

## Runner Vs Synapsor Cloud

| Need | Synapsor Runner | Synapsor Cloud |
| --- | --- | --- |
| Local MCP server | Yes | Managed |
| Local trusted context bindings | Yes | Org/session integrated |
| Local semantic capabilities | Yes | Hosted registry + versioning |
| Local evidence/proposal/replay | Yes | Central searchable ledger |
| Local approval | CLI/UI | Multi-user approvals |
| Writeback | Guarded single-row `UPDATE` | Managed production orchestration |
| MCP risk audit | Static/local | Continuous/org-wide |
| RBAC/SSO | No | Yes |
| Policy packs | No/basic | Yes |
| Workflow builder | No | Yes |
| Native branches/time travel | No | Yes |
| Settlement policies | No | Yes |
| Compliance exports | No | Yes |
| Production support/SLA | No | Yes |

The runner is useful by itself for local/staging safety. Synapsor Cloud is for
teams, production governance, central audit, managed runners, enterprise
controls, and proprietary Synapsor platform features.

## Current Limitations

Supported in the current alpha:

- stdio MCP server;
- Postgres/MySQL inspection;
- semantic read tools;
- evidence-backed proposals;
- local approval outside MCP;
- guarded single-row `UPDATE`;
- local SQLite evidence/proposal/replay store;
- tenant, primary-key, allowed-column, idempotency, and conflict guards;
- static MCP risk audit.

Not supported:

- raw `execute_sql`;
- model-generated SQL;
- DDL;
- INSERT;
- DELETE;
- UPSERT;
- multi-row writes;
- stored procedures;
- physical branching of external Postgres/MySQL;
- full Synapsor workflow DAG execution;
- `CREATE AGENT WORKFLOW`;
- Synapsor SQL generation;
- auto-merge or settlement-policy semantics;
- model-callable approval or commit tools;
- general prompt-injection prevention;
- production SLA or compliance certification.

Complete limits: [docs/limitations.md](docs/limitations.md).

Security boundary: [docs/security-boundary.md](docs/security-boundary.md).

## License

Synapsor Runner is open source under the Apache License 2.0 (`Apache-2.0`).

Apache-2.0 applies to this runner repo. It does not grant rights to the
Synapsor name, logo, hosted cloud service, or proprietary Synapsor platform
features. See [TRADEMARKS.md](TRADEMARKS.md).

Synapsor Cloud, hosted governance, managed runners, advanced policy/workflow
engines, enterprise controls, and native Synapsor DBMS/C++ internals remain
proprietary.

## Developer And Contributor Commands

Public docs use `synapsor`. During source-checkout development, if the global
binary is not linked yet, use `./bin/synapsor ...` or
`corepack pnpm runner ...`.

Helper scripts are wrappers and development conveniences, not the main product
interface:

```bash
./scripts/try-synapsor.sh
./scripts/demo-docker.sh
./scripts/open-demo-ui.sh
./scripts/use-your-db.sh
./scripts/mcp-config.sh
```

Contributor checks:

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:mcp-client-configs
corepack pnpm test:onboarding-generated
corepack pnpm test:mcp-local
corepack pnpm test:reference-app
corepack pnpm test:first-run
```

## Repository Map

- `apps/runner`: CLI entrypoint and local UI.
- `packages/mcp-server`: stdio MCP server and configured tool runtime.
- `packages/schema-inspector`: Postgres/MySQL metadata inspection and config generation.
- `packages/proposal-store`: local SQLite evidence/proposal/replay store.
- `packages/postgres`, `packages/mysql`: guarded writeback adapters.
- `packages/worker-core`: shared runner orchestration.
- `recipes`: optional starter contracts.
- `examples`: disposable local demos and reference app.
- `docs`: deeper setup, security, protocol, troubleshooting, and limitation docs.

## Community

Synapsor Runner is maintained by Synapsor.

- Website: https://synapsor.ai
- Docs: https://synapsor.ai/docs
- License: Apache License 2.0 (`Apache-2.0`)
- Issues: use GitHub Issues
