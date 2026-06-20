# MCP database risk review

`synapsor mcp audit <target>` performs a static MCP database risk review over an exported tool manifest or `tools/list` response.

It does not call business tools. It only inspects names, descriptions, input schemas, output schemas, annotations, and examples when those are present.

Every report includes this disclaimer:

```text
This is a static risk review, not proof that an MCP server is secure.
```

MCP annotations are treated as hints, not enforcement.

## Usage

Human-readable output:

```bash
synapsor mcp audit ./tools-list.json
```

JSON output:

```bash
synapsor mcp audit ./tools-list.json --json
```

During local development, the package script can run the same command:

```bash
corepack pnpm runner mcp audit ./tools-list.json
corepack pnpm runner mcp audit ./tools-list.json --json
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

Remote live MCP server probing is not implemented in this slice. Export the server's `tools/list` response first.

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
