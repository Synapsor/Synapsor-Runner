# Cloud Mode

Cloud mode connects the local Synapsor Runner to Synapsor Cloud without sending database credentials to Cloud.

```text
MCP client
  -> local Synapsor Runner MCP server
  -> Synapsor Cloud adapter/capability API
  -> Cloud evidence/proposal/approval/replay
  -> approved writeback job
  -> local guarded runner
  -> Postgres/MySQL
```

## What Cloud Owns

- Reviewed adapter tool catalog.
- Capability invocation envelope.
- Evidence handles.
- Proposal state.
- Approval queue.
- Writeback job leases.
- Hosted replay and activity search.
- Runner status, scopes, and receipts.

## What Stays Local

- Postgres/MySQL read and write credentials.
- Database network access.
- Guarded writeback transaction.
- Receipt table in the target database.
- Local runner process logs and diagnostics.

## Config Shape

Cloud mode uses the same MCP server command with a `mode: "cloud"` config:

```json
{
  "version": 1,
  "mode": "cloud",
  "storage": {
    "sqlite_path": "./.synapsor/local.db"
  },
  "trusted_context": {
    "provider": "cloud_session"
  },
  "cloud": {
    "base_url_env": "SYNAPSOR_CLOUD_BASE_URL",
    "runner_token_env": "SYNAPSOR_RUNNER_TOKEN",
    "runner_id": "synapsor_runner_local",
    "runner_version": "0.1.0-alpha.0",
    "project_id": "token_scope",
    "adapter_id": "mcp.billing",
    "source_id": "src_pg_acme",
    "engines": ["postgres"],
    "capabilities": ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
    "session": {
      "tenant_id": "acme"
    }
  }
}
```

Run:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
synapsor mcp serve --config ./synapsor.cloud.json
```

Validate the Cloud runner token and source scope before serving tools:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
synapsor cloud connect --config ./synapsor.cloud.json
```

`cloud connect` verifies the runner token, registers the runner id/version, sends engine/capability/source metadata, and posts an initial heartbeat. It does not send Postgres/MySQL URLs, passwords, write credentials, prompts, or table data. The `project_id` field may be the literal `token_scope` because Synapsor Cloud validates the real project/source from the scoped runner token.

The runner token should be scoped to adapter read/invoke and writeback claim/result reporting for the intended source. It should not grant proposal approval permission.

## Tool Calls

In Cloud mode, the local MCP server fetches the adapter tool catalog from Synapsor Cloud and delegates tool calls to Cloud adapter APIs. The returned result remains structured and must not expose raw SQL or database credentials.

## Hosted Compatibility Check

After you have a compatible Cloud workspace, external source, MCP adapter, and
scoped runner token, verify the hosted adapter/tool path:

```bash
SYNAPSOR_CLOUD_BASE_URL="https://synapsor.ai" \
SYNAPSOR_RUNNER_TOKEN="syn_wbr_..." \
SYNAPSOR_SOURCE_ID="src_..." \
SYNAPSOR_ADAPTER_ID="mcp.billing" \
SYNAPSOR_MCP_TOOL_NAME="billing.propose_late_fee_waiver" \
SYNAPSOR_MCP_TOOL_INPUT_JSON='{"invoice_id":"INV-3001","reason":"support-approved waiver"}' \
corepack pnpm verify:hosted-cloud-linked
```

That command checks runner-token auth, runner registration, heartbeat, adapter
`tools/list`, semantic tool invocation, proposal/evidence/replay linkage, and
that the tool response does not report source mutation before trusted
writeback. It never creates runner tokens and never prints token values.

To claim and apply one already approved writeback job through the guarded local
adapter, add:

```bash
SYNAPSOR_HOSTED_E2E_APPLY_JOB=1
SYNAPSOR_ENGINE="postgres|mysql"
SYNAPSOR_DATABASE_URL="postgresql://..."
```

Use the trusted worker credential in `SYNAPSOR_DATABASE_URL`. Do not put that
credential in an MCP client config or model-facing tool definition.

## Writeback

The model-facing tool call creates or returns Cloud-managed proposal state. The external database is unchanged until:

1. a human or deterministic Cloud policy approves the exact proposal version/hash;
2. Cloud creates an approved writeback job;
3. the scoped runner claims the job;
4. the local worker applies a guarded single-row update;
5. the runner returns an applied/conflict/failed receipt.

## Current Limits

- Cloud mode requires a compatible Synapsor Cloud deployment and runner token.
- Local and Cloud histories are separate unless an explicit import feature is added later.
- Streamable HTTP transport is not enabled by default; stdio is the primary local MCP transport.
- Approval remains outside model-callable MCP tools.
