# Result Envelope v2

Result envelope v2 gives every model-facing MCP tool call one stable shape.
Client code and agents branch only on `ok`.

Enable it in config:

```json
{
  "result_format": 2
}
```

Or at serve time:

```bash
synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --result-format v2

synapsor-runner mcp serve-streamable-http \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --result-format v2
```

## Shape

```json
{
  "ok": true,
  "summary": "Read invoice INV-3001 through billing.inspect_invoice. Source database changed: no.",
  "action": "billing.inspect_invoice",
  "kind": "read",
  "data": {},
  "proposal": null,
  "error": null,
  "evidence": {
    "bundle_id": "ev_...",
    "note": "audit/replay handle; you do not need to act on it during this turn"
  },
  "source_database_changed": false,
  "_meta": {
    "tenant_id": "tenant_acme",
    "principal": "demo-operator",
    "provenance": "environment",
    "canonical_capability": "billing.inspect_invoice"
  }
}
```

Rules:

- `ok` is the only field callers need to branch on.
- `summary` is always present and safe for an agent to read or echo.
- On success, exactly one of `data` or `proposal` is non-null.
- On failure, both `data` and `proposal` are null.
- `source_database_changed` is always present.
- `_meta.canonical_capability` is always the dotted Synapsor capability name,
  even when the model sees an OpenAI-safe alias.

## Proposal Result

Proposal tools create reviewable changes. They do not commit to the source
database.

```json
{
  "ok": true,
  "summary": "Created proposal wrp_123 for invoices INV-3001. Source database changed: no.",
  "action": "billing.propose_late_fee_waiver",
  "kind": "proposal",
  "data": null,
  "proposal": {
    "id": "wrp_123",
    "state": "review_required",
    "target": "invoices:INV-3001",
    "diff": {
      "late_fee_cents": {
        "before": 2500,
        "proposed": 0
      }
    },
    "approval_required": true,
    "writeback": {
      "mode": "direct_update",
      "applied": false
    },
    "next": "A human must approve outside this model-facing tool surface; nothing is committed yet."
  },
  "error": null,
  "evidence": {
    "bundle_id": "ev_..."
  },
  "source_database_changed": false,
  "_meta": {
    "canonical_capability": "billing.propose_late_fee_waiver"
  }
}
```

For app-owned executors, `proposal.writeback.mode` is `app_handler`.

## Error Result

Model-facing errors are safe and stable. Raw driver details stay in local logs
or ledger inspection, not in the MCP result.

```json
{
  "ok": false,
  "summary": "The database is temporarily unavailable. Retry later.",
  "action": "billing.inspect_invoice",
  "kind": "read",
  "data": null,
  "proposal": null,
  "error": {
    "code": "TEMPORARILY_UNAVAILABLE",
    "message": "The database is temporarily unavailable. Retry later.",
    "retryable": true
  },
  "evidence": null,
  "source_database_changed": false,
  "_meta": {
    "canonical_capability": "billing.inspect_invoice"
  }
}
```

Safe error codes:

```text
NOT_FOUND_IN_TENANT
INVALID_ARGUMENT
POLICY_VIOLATION
CAPABILITY_NOT_FOUND
VERSION_CONFLICT
MULTI_ROW_BLOCKED
APPROVAL_REQUIRED
TEMPORARILY_UNAVAILABLE
INTERNAL
```

Current alpha implementation redacts raw connection and driver messages from v2
MCP results. New `init` and `onboard db` configs write `result_format: 2` by
default. Existing hand-written configs without `result_format` keep the legacy
runtime default for compatibility; pass `--result-format v2` when serving an
older config to force the v2 envelope, or `--result-format v1` for an older
client that still depends on the legacy shape.
