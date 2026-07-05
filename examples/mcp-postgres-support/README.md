# MCP Postgres support-ticket demo

This local demo exposes semantic MCP tools for a support workflow:

- `support.inspect_ticket`
- `support.propose_ticket_resolution`

The model can inspect one tenant-scoped ticket and propose a bounded status/resolution-note update. It cannot call raw SQL, approval, or commit tools. Approval happens outside the model-facing MCP surface, then the guarded runner applies the approved single-row update with primary-key, tenant, allowed-column, conflict, and idempotency guards.

## Run

From the repository root:

```bash
corepack pnpm test:mcp-local
```

The shared smoke script starts this disposable Postgres fixture, calls the MCP tools through stdio, verifies evidence/resource handles, approves the proposal with the CLI, applies it through guarded writeback, retries idempotently, and proves stale-row conflict.

## Ticket Resolution Proposal

`support.propose_ticket_resolution` demonstrates a bounded support update.
The model can propose the reviewed status and resolution-note fields, but it
cannot approve or commit the change.

Expected output includes:

```text
Source DB changed:
no

Guarded writeback applied.
* tenant guard matched: yes
* allowed columns only: yes
* conflict guard passed: yes
```

Safety guarantee: the proposal records trusted tenant/principal context,
evidence, before/after diff, local approval, guarded writeback receipt, and
replay. Stale rows return `conflict`.

Current limitation: this is local single-row review-mode writeback. It does not
provide hosted RBAC, branches, auto-merge, or production support queues.

## Manual setup

```bash
docker compose -f examples/mcp-postgres-support/docker-compose.yml up -d

export SUPPORT_POSTGRES_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55434/synapsor_runner_mcp_support"
export SUPPORT_POSTGRES_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55434/synapsor_runner_mcp_support"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_support_agent"

npx -y -p @synapsor/runner synapsor-runner mcp serve \
  --config examples/mcp-postgres-support/synapsor.runner.json \
  --store ./tmp/mcp-postgres-support/local.db
```

Configure your local MCP client to run the same command over stdio.
