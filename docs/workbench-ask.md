# Workbench Ask With Your Model

Workbench Ask is an optional local client for the reviewed Synapsor tools that
already exist. It lets a developer ask a plain-language question through
OpenAI, Anthropic, or an explicitly configured OpenAI-compatible endpoint
without installing an external MCP host first.

Ask does not generate or activate authority. It does not replace the no-model
Workbench composer, which remains the default onboarding path and requires no
model API key.

```text
human activates a reviewed boundary or named capability
  -> Workbench lists that exact model-facing tool surface
  -> human selects a provider and acknowledges direct data egress
  -> provider may request one of those reviewed tools
  -> Runner executes the request through the normal MCP/runtime path
  -> provider receives the bounded reviewed result
  -> Workbench renders provider prose as untrusted output
```

The model cannot activate a boundary, Protect a query, approve or apply a
proposal, control a worker, acknowledge attention, reconcile an outcome, or
change provider configuration.

## Availability

Ask appears only when all of these conditions hold:

- Workbench is authenticated and bound to loopback;
- the deployment profile is explicitly `development` or `staging`;
- at least one reviewed model-facing tool is available;
- generated authority and its generation lock are current when applicable.

It is absent from production, missing/unknown profiles, non-loopback
Workbench, shared remote HTTP, and model-facing MCP configuration. An MCP
request cannot enable Ask or select its provider.

While Scoped Explore is active, Ask may use:

```text
app.describe_data
app.explore_data
```

After Explore is disabled, Ask may use only the activated named capabilities
in `synapsor.runner.json`, such as:

```text
analytics.weekly_revenue_by_store
retail.propose_order_fulfillment
```

The panel displays the exact tool names and an Ask authority digest. That digest
binds the tool surface, runtime config, deployment profile, and active
exploration digest when one exists. A material authority change invalidates
egress consent before another provider call.

## Start Without A Model

Begin with the normal one-command staging path:

```bash
export SYNAPSOR_TENANT_ID='<reviewed tenant>'
export SYNAPSOR_PRINCIPAL='<reviewed principal>'
npx -y @synapsor/runner start
```

Paste the SELECT-only database URL into Runner's hidden terminal prompt, or
explicitly consent to loading only `DATABASE_URL` from a recognized project
environment file. For an intentionally exported automation path, use
`start --from-env DATABASE_URL`.

Review and activate the boundary, then run the first safe read or aggregate in
Workbench. At this point the complete no-model path is already working.

Open **Analyze**, then **Ask with your model**. Workbench shows:

- the reviewed tools the provider may request;
- the current boundary/authority digest;
- provider, model, origin, and credential source;
- that approved visible results may go directly to the provider;
- that Synapsor does not relay the request;
- that the source database is unchanged by a read or proposal call.

## Provider Credentials

Workbench Ask does not load provider keys from `.env` files. Instant database
onboarding may separately read only a selected `DATABASE_URL` after explicit
human consent. Export a provider key in the same shell that starts Runner:

```bash
export OPENAI_API_KEY='<provider key>'
npx -y @synapsor/runner start
```

Provide the database URL through the same hidden/consented path above. If
Runner is already running, use the masked Workbench key field instead of
restarting only to add a provider key.

In Workbench select:

```text
Provider: OpenAI
Credential: Read an environment variable
Environment variable name: OPENAI_API_KEY
```

The browser sends only the environment variable name. The value stays in the
local Runner process and is not returned to the browser.

Alternatively, paste a key into the masked Workbench field. Runner holds that
value only in server memory for the current local session and clears the field
after configuration. Do not paste credentials into an agent chat.

Keys and authorization headers are not written to:

- generated DSL, JSON, locks, or config;
- the SQLite/shared ledger, evidence, receipts, or replay;
- browser local/session storage;
- logs, screenshots, telemetry, or command-line arguments.

Select **Clear** to cancel an active request, remove in-memory provider
configuration, and discard bounded conversation history. Stopping Workbench
also clears it.

## Direct Egress

Before the first call, Workbench requires this provider-specific decision:

```text
Your reviewed visible data may be sent directly to this provider using your
credential. Synapsor does not receive it. Fields kept out by the active
boundary are unavailable to this model.
```

Consent is bound to the provider, model, endpoint origin, and current Ask
authority digest. Changing any of those requires a new acknowledgement.
Consent does not activate or widen database authority.

The question, reviewed tool definitions, and bounded tool results go directly
from local Runner to the selected provider. A tool result can contain reviewed
source values, so use a provider and data-handling policy appropriate for that
data. Kept-out fields are unavailable to selection, filtering, grouping,
sorting, joins, or returned results.

Runner does not persist the conversation, provider response, or returned tool
rows by default. Existing normalized query audit still records the boundary
digest, keyed plan/literal fingerprints, suppression decision, timing, and
result size without storing result values or trusted tenant/principal values.
An operator-created screenshot or external provider may retain data under its
own policy; Runner cannot erase those external copies.

## Authority And Proposal Behavior

Provider tool calls use the official MCP SDK and the same canonical runtime as
an external client:

- typed argument validation;
- trusted tenant/principal injection outside model arguments;
- read-only transaction enforcement for Scoped Explore;
- field, relationship, suppression, extraction, and differencing limits;
- proposal construction and exact active contract digest;
- the same error envelope and source-change state.

Provider prose, tool names, arguments, and response metadata remain untrusted.
An unknown or operator-plane tool is refused. A malformed or oversized
request, repeated tool loop, changed authority, timeout, or provider failure
stops safely.

A reviewed write tool may create an inert proposal:

```text
Proposal only
The source database did not change.
The model cannot approve or apply this proposal.
```

The human continues through the separate Workbench/CLI operator workflow.
Ask never receives approval or commit tools.

## Endpoint Security

Official providers use fixed endpoints:

```text
OpenAI:    https://api.openai.com/v1/chat/completions
Anthropic: https://api.anthropic.com/v1/messages
```

Use **Custom OpenAI-compatible** for another endpoint. Remote custom endpoints
must use HTTPS. Plain HTTP is accepted only for an explicit loopback endpoint,
for example:

```text
http://127.0.0.1:11434/v1
```

Runner:

- rejects URL credentials, fragments, and query parameters;
- disables redirects and never forwards a key across one;
- resolves and validates DNS for every connection;
- pins the connection to the validated address while retaining TLS hostname
  verification;
- blocks private, link-local, multicast, unspecified, metadata, and other
  special destinations for remote mode;
- permits custom local mode only on loopback;
- bounds request/response bytes, tool schemas/results, tool calls, iterations,
  history, time, and reported tokens.

No URL, model, header, or destination comes from model output.

## Fixed Session Bounds

The current release enforces:

| Item | Bound |
| --- | ---: |
| Question | 4,000 characters |
| Model identifier | 128 characters |
| Provider request | 256 KiB |
| Provider response | 1 MiB |
| Tool schema surface | 128 KiB and 64 tools |
| One tool result | 128 KiB |
| Tool calls | 4 per provider response, 8 per turn |
| Tool-loop iterations | 6 |
| Conversation history | 4 completed turns, 16 KiB |
| Final answer | 16 KiB |
| Provider request timeout | 30 seconds |
| Reported session token usage | 50,000 tokens |

One Workbench Ask session runs one request at a time. Runner does not
automatically retry provider calls in this release. A developer may retry a
known safe failure from the UI; every retry begins with current authority
validation. Token accounting depends on usage reported by the provider and is
not a monetary spend guarantee.

## Tested Provider Matrix

Status as of the prepared 1.6.4 source:

| Provider surface | Verification | Claim |
| --- | --- | --- |
| OpenAI `gpt-5-mini` | Live packed-Workbench run against real local PostgreSQL on 2026-07-25 | Live tested |
| Anthropic Messages/tool-use protocol | Deterministic mock server, normal/refusal/error paths | Protocol tested; no live Anthropic account run |
| Custom OpenAI-compatible loopback | Real local HTTP server plus deterministic tool/refusal/proposal paths | Tested against the documented Chat Completions subset |
| Ollama or another named compatible server | Not installed in the release environment | Unknown until tested; compatibility is not implied by the label |

The live OpenAI run used `app.describe_data` and `app.explore_data`, matched the
official MCP aggregate result, changed no source rows, and passed exact-key
artifact scans. See
`development/runner-1.6.4-community-solar-results.json`.

## Troubleshooting

**Ask is missing:** confirm loopback Workbench, an explicit development/staging
profile, and at least one active reviewed tool. Production intentionally omits
Ask.

**Key required:** export the named variable in the process that launches
Runner, or use the session-only masked paste. Runner does not load `.env`.

**Authority changed:** inspect the new tool/digest summary and acknowledge
egress again. Do not bypass the check.

**Provider unavailable:** the reviewed boundary and no-model composer remain
usable. Check provider status, local DNS/TLS, key validity, and model access.
Runner returns a redacted failure and does not retry automatically.

**Custom endpoint refused:** use HTTPS remotely or an exact loopback HTTP URL.
Private network and metadata endpoints are intentionally blocked.

**Provider answers without a tool:** Runner refuses to present prose as a
database answer until at least one reviewed Synapsor tool succeeds or returns a
reviewed refusal.

**Proposal did not commit:** that is correct. Open the separate operator
workflow to review, approve, and guardedly apply it.
