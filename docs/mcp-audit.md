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

The default terminal report groups repeated findings into the three most
important root causes. It shows affected tools, a short blast-radius statement,
and one next action instead of repeating the same explanation for every tool.
Use the complete view when triaging every finding:

```bash
npx -y -p @synapsor/runner synapsor-runner audit ./tools-list.json --verbose
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

The JSON contract remains `synapsor.mcp-audit.v1`; its published schema is
[`schemas/mcp-audit-report.schema.json`](../schemas/mcp-audit-report.schema.json).

SARIF 2.1.0 output for code-scanning ingestion:

```bash
npx -y -p @synapsor/runner synapsor-runner audit ./tools-list.json --format sarif > mcp-audit.sarif
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

## Generate review candidates

Audit can create a separate review directory without editing or activating the
source configuration:

```bash
npx -y -p @synapsor/runner synapsor-runner audit generate \
  ./tools-list.json \
  --output ./synapsor-audit-candidates
```

Open the same blocked candidate directly in the secured local review
workbench:

```bash
npx -y -p @synapsor/runner synapsor-runner audit generate \
  ./tools-list.json \
  --output ./synapsor-audit-candidates \
  --open-ui
```

This does not activate the candidate. The generated Runner config has no source
and every proposal writeback is `none`.

The generator uses the same parser and findings as `audit`. It writes:

- a canonical `@synapsor/spec` contract;
- a strict-shadow Runner scaffold with no configured source;
- deny, redaction, and operator-boundary test candidates;
- before/after model tool-surface reports;
- a `REVIEW.md` checklist.

Generated candidates do not carry authority. Every proposal has
`writeback.mode: none`, the Runner scaffold is `shadow`, and the source map is
empty. Subject identifiers and visible/write fields are conspicuous
`review_required_*` placeholders. Input fields that look like SQL, dynamic
identifiers, tenant/principal scope, credentials, approval identity, or row
version are omitted rather than copied into model arguments.

The output excludes raw descriptions, defaults, examples, enum values, bearer
tokens, and credentials. Unknown business meaning becomes a TODO. A developer
must inspect the real schema, choose trusted tenant/principal bindings, run the
generated tests and a Shadow study, then deliberately copy reviewed definitions
into an active contract.

Generation refuses an existing directory. `--force` only replaces a directory
that carries Runner's `synapsor.audit-candidates.v1` ownership marker; it will
not overwrite an arbitrary hand-edited directory.

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

## Related Fixture Benchmark

`synapsor-runner benchmark mcp-efficiency` compares a fixed generic database
MCP shape with the semantic late-fee-waiver path used by Runner. The checked-in
fixture currently demonstrates:

```text
Generic database MCP reference:
  exposed tools: 4
  scripted tool calls: 5
  raw SQL exposed: yes
  approval separated: no
  stale-row conflict checked: no

Synapsor Runner semantic path:
  exposed tools: 2
  scripted tool calls: 2
  raw SQL exposed: no
  approval separated: yes
  stale-row conflict checked: yes
```

The fixture tokenizer is deterministic and repeatable for this repository. It
is not a model billing tokenizer and does not support a universal token-savings
claim.
