# MCP database risk review

`npx -y -p @synapsor/runner synapsor-runner audit <target>` performs a
static MCP database risk review over an exported tool manifest, a remote MCP
`tools/list` endpoint, or a stdio MCP server. The `mcp audit` subcommand is also
available for users who look for the command under the MCP namespace.

From a source checkout, use `./bin/synapsor-runner ...` if the global binary is not
linked yet.

It does not call business tools. It only inspects names, descriptions, input schemas, output schemas, annotations, and examples when those are present.

Every report includes this disclaimer:

```text
This is a static risk review, not proof that an MCP server is secure.
```

MCP annotations are treated as hints, not enforcement.

## Usage

Built-in database MCP risk example:

```bash
npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp
```

This bundled example does not require a source checkout or local examples file.
It audits a deliberately risky database MCP shape with `execute_sql`,
`run_query`, model-callable approval/update/delete tools, arbitrary
table/column inputs, and model-controlled tenant/principal fields.

Human-readable output:

```bash
npx -y -p @synapsor/runner synapsor-runner audit ./tools-list.json
```

Remote `tools/list` endpoint with a bearer token kept in the environment:

```bash
SYNAPSOR_MCP_AUDIT_BEARER="..." \
npx -y -p @synapsor/runner synapsor-runner audit https://mcp.example.com --format json
```

Remote endpoint with a custom bearer-token environment variable:

```bash
npx -y -p @synapsor/runner synapsor-runner audit https://mcp.example.com --bearer-env MCP_AUDIT_TOKEN --format json
```

Stdio MCP server:

```bash
npx -y -p @synapsor/runner synapsor-runner audit 'stdio:node ./server.mjs' --timeout-ms 5000
```

JSON output:

```bash
npx -y -p @synapsor/runner synapsor-runner audit ./tools-list.json --format json
```

Markdown output for issues, PRs, or security review notes:

```bash
npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp --format markdown
```

During local development, the repo-local wrapper can run the same command:

```bash
./bin/synapsor-runner audit ./tools-list.json
./bin/synapsor-runner audit ./tools-list.json --format json
```

## Supported inputs

The audit accepts common exported shapes:

```json
{ "tools": [] }
```

```json
{ "result": { "tools": [] } }
```

```json
{ "data": { "tools": [] } }
```

It also scans nested `adapter`, `mcpServers`, and `servers` blocks when they include tool metadata.

For live targets, the audit calls only JSON-RPC `tools/list`. It does not call business tools, approval tools, commit tools, or writeback tools.

## Findings

The audit flags database-commit risks such as:

- generic `execute_sql`, `run_query`, or raw SQL tools;
- tools accepting arbitrary SQL, schema, table, or column identifiers;
- tools accepting `tenant_id`, `principal`, source ids, allowed columns, row versions, or approval identity as model input;
- model-callable approval, commit, apply, settle, merge, or writeback tools;
- write-like tools with no visible proposal, approval, or guarded-writeback boundary;
- missing structured output schemas;
- missing idempotency/request-key metadata for direct write-like tools;
- missing row-version/conflict-guard metadata for direct write-like tools;
- ambiguous read/write tool boundaries;
- missing business descriptions, annotations, or fixture examples.

## Recommended target shape

A safer model-facing database MCP tool should look like a reviewed semantic proposal capability:

```json
{
  "name": "billing.propose_late_fee_waiver",
  "description": "Create an evidence-backed proposal for support lead approval before trusted writeback.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "invoice_id": { "type": "string" },
      "reason": { "type": "string" }
    },
    "required": ["invoice_id", "reason"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string" },
      "proposal_id": { "type": "string" },
      "evidence_bundle_id": { "type": "string" },
      "source_database_changed": { "type": "boolean" }
    },
    "required": ["status", "proposal_id", "source_database_changed"]
  },
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": false
  },
  "examples": [
    {
      "invoice_id": "INV-3001",
      "reason": "customer requested review"
    }
  ]
}
```

Trusted values such as tenant, principal, source, allowed columns, approval identity, row-version guard, and database credentials must come from Synapsor/runner context, not from model-facing arguments.
