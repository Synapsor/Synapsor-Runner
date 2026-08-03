# Human Attention And Notifications

Runner keeps the full lifecycle in its ledger and secured Workbench. External
notifications are a quiet interruption channel for meaningful human attention,
not a copy of every state transition.

Notifications are additive, local-first, and disabled by default. Runner needs
no webhook, network connection, Cloud account, or continuously running
dispatcher for its existing proposal, approval, apply, receipt, and replay
flows.

## Architecture

```text
authoritative ledger transition
  -> immutable attention event in the same store transaction
  -> coalesced Human Attention item
  -> separately operated dispatcher
  -> configured JSONL or signed webhook sink
  -> authenticated human opens Workbench
  -> existing approval/recovery control handles the item
```

An event informs. It never authorizes. A webhook response, delivery receipt,
inbox acknowledgement, or notification replay cannot activate a capability,
approve a proposal, apply a write, cancel work, or resolve an unknown database
outcome.

SQLite and shared PostgreSQL runtime stores retain the same event identities,
attention projection, acknowledgement, and delivery state.

## Quiet Default

Under the default route, successful activity remains visible in the ledger,
Workbench timeline, CLI, metrics, and optional digest, but does not interrupt a
human.

No immediate external notification is sent by default for:

- proposal creation, policy auto-approval, approval, or queueing;
- a worker lease or individual retry;
- successful manual or automatic apply;
- an isolated conflict that Runner handled safely;
- planned worker start, pause, resume, drain, or stop;
- capability activation by the same operator.

Immediate delivery defaults to states where timely attention matters:

- human approval required;
- UNKNOWN transaction outcome or reconciliation required;
- dead-letter work;
- sustained worker-health failure;
- queue depth/age crossing an operator threshold;
- schema drift or stale digest blocking authority;
- invalidated writer credential posture;
- critical policy/limit failure;
- an approved proposal approaching expiry while action is still possible.

Informational success events can be sent only through an explicit all-events
route or periodic digest.

## Events And Attention Items

Events are immutable audit facts. Attention items are durable incident
projections over related events.

For example, ten proposals requiring the same role can produce ten immutable
events but one item saying that ten proposals need review. Repeated worker
failures, queue backlog, or the same schema-drift condition update one item and
its occurrence count. Retry attempts stay internal until the configured
attempt/duration threshold is crossed.

Attention states are:

- `open`;
- `acknowledged`;
- `resolved`;
- `expired`.

Acknowledgement means only that a verified operator saw the item. It is not
approval or resolution.

## Configure Sinks

This operator-owned config enables one signed webhook and one optional
development JSONL stream:

```json
{
  "notifications": {
    "enabled": true,
    "workbench_url_env": "SYNAPSOR_WORKBENCH_URL",
    "sinks": [
      {
        "id": "operations",
        "type": "webhook",
        "enabled": true,
        "url_env": "SYNAPSOR_NOTIFY_WEBHOOK_URL",
        "signing_secret_env": "SYNAPSOR_NOTIFY_SIGNING_SECRET",
        "minimum_severity": "warning",
        "events": [
          "proposal.review_required",
          "worker.dead_lettered",
          "worker.unknown_outcome",
          "worker.reconciliation_required",
          "schema.drift_detected"
        ],
        "capabilities": ["billing.propose_small_credit"],
        "environments": ["staging", "production"],
        "delivery": "immediate",
        "max_attempts": 5,
        "timeout_ms": 3000,
        "max_response_bytes": 1024,
        "replay_window_seconds": 300,
        "allow_private_destinations": false,
        "recovery_notifications": false,
        "budgets": {
          "per_minute": 10,
          "per_hour": 100,
          "immediate_informational_per_hour": 0,
          "aggregation_window_seconds": 300,
          "cooldown_seconds": 600,
          "max_unresolved_reminders": 3,
          "digest_cadence_minutes": 1440,
          "escalation_delay_seconds": 60,
          "retry_attempt_threshold": 3,
          "degraded_duration_seconds": 120,
          "queue_depth_threshold": 100,
          "queue_age_seconds": 300
        },
        "quiet_hours": {
          "start_utc_hour": 22,
          "end_utc_hour": 7
        }
      },
      {
        "id": "development",
        "type": "jsonl",
        "enabled": false,
        "destination": "stdout",
        "minimum_severity": "informational",
        "delivery": "all"
      }
    ]
  }
}
```

Set values only in the operator environment:

```bash
export SYNAPSOR_WORKBENCH_URL=https://runner-ops.example.internal
export SYNAPSOR_NOTIFY_WEBHOOK_URL=https://events.example.com/synapsor
export SYNAPSOR_NOTIFY_SIGNING_SECRET='at-least-32-random-bytes'
```

The config stores environment-variable names, not URLs or secrets. Events never
contain credentials, database URLs, SQL, source rows, aggregate group results,
kept-out fields, trusted tenant/principal values, sensitive arguments, or
authority tokens.

## Route By Destination

Every sink has its own event, severity, capability, environment, and delivery
route. A practical split is:

| Sink | Route |
| --- | --- |
| Workbench | Complete event and attention history |
| Team chat webhook | Review-required and operational warnings |
| Incident webhook | UNKNOWN, reconciliation, dead letter, sustained worker failure |
| Email-provider webhook | Daily digest |
| Audit webhook | Explicit all-events redacted stream |

The ledger and Workbench remain the source of truth.

## Operate Without Copying IDs

Inspect the highest-priority item:

```bash
synapsor-runner attention list --config ./synapsor.runner.json
synapsor-runner attention show --config ./synapsor.runner.json
```

Use `attention show <attention_id>` only when selecting a specific item. JSON
automation is available with `--json`.

Acknowledgement is explicit:

```bash
synapsor-runner attention acknowledge --actor alice \
  --config ./synapsor.runner.json
```

Production acknowledgement follows configured verified operator identity and is
cryptographically bound to the exact item digest and occurrence.

Inspect and test delivery:

```bash
synapsor-runner notifications status --config ./synapsor.runner.json
synapsor-runner notifications test --sink operations \
  --config ./synapsor.runner.json
synapsor-runner notifications dispatch --sink operations --limit 20 \
  --config ./synapsor.runner.json
```

`notifications test` sends an unmistakable synthetic event containing no
database or proposal data. Opening Workbench, installing Runner, and starting
MCP never start outbound delivery.

Requeue one dead-letter delivery:

```bash
synapsor-runner notifications replay latest --yes \
  --reason "Webhook repaired and synthetic test passed" \
  --config ./synapsor.runner.json
```

This replays only the immutable redacted notification. It does not replay an
approval or database mutation. Replay is an operator recovery action and
requires the configured `signed_key` or `jwt_oidc` identity. Runner binds the
verified decision to the exact delivery revision and records a redacted
immutable `notification.replayed` audit event.

## Webhook Contract

Runner sends a CloudEvents 1.0 structured JSON body with content type
`application/cloudevents+json`. Important headers are:

```text
X-Synapsor-Event-Id
X-Synapsor-Timestamp
X-Synapsor-Signature-Version: v1
X-Synapsor-Signature: sha256=<hex HMAC>
```

The HMAC-SHA-256 input is the UTF-8 string
`v1.<timestamp>.<event-id>.<exact-body>`. Receivers must:

1. Require signature version `v1`.
2. Reject timestamps outside the configured replay window.
3. Verify the HMAC with a timing-safe comparison.
4. Atomically claim the stable event ID in durable shared storage.
5. Return only a bounded transport acknowledgement.

Runner ignores response content. A receiver cannot return a command.

A minimal Node receiver can verify the exact bytes before parsing JSON:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySynapsorWebhook(rawBody, headers, secret, now = Date.now()) {
  const eventId = headers["x-synapsor-event-id"];
  const timestamp = headers["x-synapsor-timestamp"];
  const version = headers["x-synapsor-signature-version"];
  const suppliedHeader = headers["x-synapsor-signature"];
  if (!eventId || !timestamp || version !== "v1" || !suppliedHeader?.startsWith("sha256=")) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  const ageMs = Math.abs(now - timestampSeconds * 1000);
  if (!Number.isSafeInteger(timestampSeconds) || ageMs > 300_000) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(`v1.${timestamp}.${eventId}.${rawBody}`, "utf8")
      .digest("hex"),
    "hex",
  );
  const supplied = Buffer.from(suppliedHeader.slice("sha256=".length), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
```

Read the request as raw UTF-8 bytes for verification; reserializing parsed JSON
changes the signed body. Store the event ID for at least the replay window and
reject a duplicate before processing it. A process-local `Set` is suitable only
for a single-process test or demo; it does not survive restarts and does not
coordinate multiple receivers. Embedded Node receivers can use
`verifyNotificationWebhookDurably(...)` with an atomic insert-if-absent
`claim_event_id` callback backed by their database or shared cache. The callback
runs only after the signature and timestamp pass and receives the event ID plus
its minimum retention deadline.

The structured body resembles:

```json
{
  "specversion": "1.0",
  "id": "aev_...",
  "type": "ai.synapsor.worker.reconciliation_required",
  "source": "urn:synapsor:runner:production",
  "time": "2026-07-25T00:00:00.000Z",
  "datacontenttype": "application/json",
  "subject": "billing.propose_small_credit",
  "data": {
    "schema_version": "synapsor.notification.v1",
    "severity": "critical",
    "environment": "production",
    "capability": "billing.propose_small_credit",
    "contract_digest": "sha256:...",
    "summary": "A guarded apply needs operator reconciliation.",
    "workbench_url": "https://runner-ops.example.internal/attention/att_..."
  }
}
```

The Workbench URL identifies an item but carries no approval or recovery
authority. The operator must authenticate normally.

HTTPS is required by default. Redirects and unsafe loopback, link-local,
metadata, multicast, unspecified, private, and rebinding destinations are
refused. Intentional private destinations require both
`allow_private_destinations: true` and an exact `private_host_allowlist`.

## Delivery And Noise Guarantees

Delivery is at least once. Sink-specific records use atomic leases, fencing,
bounded retries, jittered backoff, timeout, maximum attempts, and dead-letter
state. Repeated delivery cannot repeat proposal authority or source mutation.

When a non-critical budget is exhausted, Runner preserves every event, updates
the Workbench item, and suppresses or batches external messages. Critical events
bypass ordinary quiet hours and budgets but still coalesce under a separate
bounded emergency ceiling.

Optional digests report redacted counts for proposals, auto-approval, apply,
review-required work, conflicts, retries, dead letters, limits, queue age, and
unresolved critical items. They link to authenticated Workbench detail.

Recovery messages are off by default. When an incident resolves, Workbench is
updated; an external recovery message is sent only when that sink explicitly
enables `recovery_notifications` or the critical-route policy requires it.

## Retry And Dead-Letter Runbook

1. Run `notifications status --json` and inspect sink health, pending delivery,
   and dead-letter counts.
2. Open the corresponding Workbench attention item. Confirm the authoritative
   proposal/worker state before changing delivery.
3. Repair the operator-owned destination, DNS policy, TLS, or secret rotation.
4. Send `notifications test --sink <id>`; it contains no database data.
5. Run `notifications dispatch --sink <id> --limit 20` to drain eligible work.
6. Replay a dead-letter delivery only with
   `notifications replay <delivery_id> --yes --reason "<why replay is safe>"`.

Replay preserves the original immutable event ID. It cannot re-run the database
operation. The exact recovery decision must be verified through the configured
operator identity. A still-failing sink remains observable and does not rewrite
the underlying proposal outcome.

## Supervised Worker Health Gate

An exact supervised-worker capability may list:

```json
{
  "required_attention_sinks": ["operations"]
}
```

If every required sink is unhealthy or untested, an otherwise eligible
policy-approved production write remains queued. Workbench explains that
operator visibility is unavailable. A healthy sink does not approve anything;
after recovery, the worker still repeats every ordinary digest, policy, scope,
freshness, limit, credential, lease, and guarded-write check.

See [Operator-Supervised Automatic
Apply](supervised-automatic-apply.md) for the execution boundary.
