# MCP Client Setup

The primary local proof path is still the one-command Docker demo:

```bash
./scripts/demo-docker.sh
```

Use this page after that demo passes and you want to attach a local MCP client. The tested integration contract here is stdio. Client-specific UIs change, so the checked-in examples verify config shape and `tools/list`, not every client screen.

Command examples use the published alpha package through `npx`. From a source
checkout, use `./bin/synapsor ...` only when you intentionally want the local
source wrapper.

Checked examples live in:

```text
examples/mcp-client-configs/
```

Validate them with:

```bash
corepack pnpm test:mcp-client-configs
```

## Generate A Client Snippet

Print a snippet without modifying any client files:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp config claude-desktop \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Supported client names:

```text
generic-stdio
generic
claude-desktop
cursor
vscode
```

The older form is still supported:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp configure --client claude-desktop --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Write is opt-in and requires an explicit destination:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp configure \
  --client cursor \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --write \
  --destination ./cursor-mcp.json
```

When the destination already exists, Synapsor Runner creates a timestamped
backup before writing. Noninteractive scripts must add `--yes`.

The command writes only the local stdio MCP command and args. It does not write
database URLs or passwords into the client config.

## Start Command

From the runner repository:

```bash
npx -y -p @synapsor/runner@alpha synapsor mcp serve --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
```

For the alpha package, keep the package tag explicit in client configuration.

## Generic stdio Client

```json
{
  "mcpServers": {
    "synapsor": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@synapsor/runner@alpha",
        "synapsor",
        "mcp",
        "serve",
        "--config",
        "./examples/mcp-postgres-billing/synapsor.runner.json",
        "--store",
        "./.synapsor/local.db"
      ],
      "env": {
        "BILLING_POSTGRES_READ_URL": "postgresql://synapsor_reader:...@localhost:55433/synapsor_runner_mcp_billing",
        "SYNAPSOR_TENANT_ID": "acme",
        "SYNAPSOR_PRINCIPAL": "local_billing_agent"
      }
    }
  }
}
```

The MCP server should list semantic tools such as:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
```

It should not list:

```text
execute_sql
run_query
approve_proposal
commit_proposal
```

## Claude Desktop / Cursor / VS Code

Use the matching checked-in example as the starting point:

```text
examples/mcp-client-configs/claude-desktop.json
examples/mcp-client-configs/cursor.json
examples/mcp-client-configs/vscode.json
```

Each example uses the same stdio command/args/env structure. Replace the placeholder environment variables in your client settings or shell environment.

Do not add a write database URL to the MCP server environment unless you are intentionally running a local review/writeback demo. For normal read/proposal tool calls, use the read URL and trusted context values only.

Before documenting a client UI as officially tested, verify:

1. the server starts;
2. `tools/list` returns semantic tools;
3. read tools return evidence handles;
4. proposal tools return exact diffs and `source_database_changed: false`;
5. no approval or commit tool is model-callable;
6. resource reads work for proposal/evidence/replay handles.

## Troubleshooting

- Server not listed: check the command path, working directory, and config path.
- Tool schema mismatch: run `synapsor audit <exported-tools.json>`.
- Missing trusted context: set `SYNAPSOR_TENANT_ID` and `SYNAPSOR_PRINCIPAL`, or use the environment variables configured in `trusted_context.values`.
- Database unavailable: verify the read credential and host access.
- Proposal waiting review: approve outside the model with `synapsor proposals approve`.
- Stale-row conflict: inspect replay; the source row changed after the proposal was created, so the guarded worker refused to commit.
