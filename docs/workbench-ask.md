# Workbench Ask With Your Model

Workbench Ask is the primary post-activation analytics client for the reviewed
Synapsor tools that already exist. It lets a developer ask a plain-language question through
OpenAI, Anthropic, or an explicitly configured OpenAI-compatible endpoint
without installing an external MCP host first.

Ask does not generate or activate authority. It does not replace the no-model
Workbench composer, which remains an optional exact-plan fallback requiring no
model API key. Developers with an existing model-enabled MCP client can connect
that client instead of configuring another provider in Workbench.

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
- the trusted Runner launch context establishes a `development` or `staging`
  authoring profile;
- at least one reviewed model-facing tool is available;
- generated authority and its generation lock are current when applicable.

It is absent from production, missing/unknown profiles, non-loopback
Workbench, shared remote HTTP, and model-facing MCP configuration. An MCP
request cannot enable Ask, select its provider, or choose a deployment profile.
In the fresh `start --from-env` path, the local launch establishes the
development authoring profile once. Workbench does not ask the developer to
repeat that declaration.

While Scoped Explore is active, Ask uses exactly:

```text
app.describe_data
app.explore_data
```

Even when the project contains named read or proposal capabilities, they are
not combined with those two authoring tools. After Explore is disabled, a new
Ask session may use only the activated named capabilities
in `synapsor.runner.json`, such as:

```text
analytics.weekly_revenue_by_store
retail.propose_order_fulfillment
```

The panel displays the exact tool names and an Ask authority digest. That digest
binds the tool surface, runtime config, deployment profile, and complete active
boundary-set digest. Adding or updating a boundary clears bounded conversation
history and rebinds provider egress to that new authority. The selected
provider/model and an in-memory or environment-backed key remain configured;
the developer is not asked to enter the key again.

## Activate Once, Then Choose A Model Path

Begin with the normal one-command staging path:

```bash
npx -y @synapsor/runner start
```

For the first-run fixture and other PostgreSQL credentials already bound to one
tenant through the reviewed RLS session setting, no tenant or principal value
is entered in Workbench. Runner verifies the binding from the authenticated
read-only database session. Shared credentials or principal-scoped boundaries
still require identity supplied by the application, verified session, or
operator-owned environment; the model can never supply it.

Paste the SELECT-only database URL into Runner's hidden terminal prompt, or
explicitly consent to loading only `DATABASE_URL` from a recognized project
environment file. For an intentionally exported automation path, use
`start --from-env DATABASE_URL`.

Review and activate the boundary, then run the first safe read in Workbench.
The next primary action opens Workbench Ask. Choose the existing-client path
instead when Cursor, Claude, VS Code, Codex, or another MCP host already
provides the model. The no-model composer remains available as a secondary
local-only fallback.

Open **Analyze**, then **Ask with your model**. Workbench shows:

- the reviewed tools the provider may request;
- the current boundary/authority digest;
- provider, model, origin, and credential source;
- that approved visible results may go directly to the provider;
- that Synapsor does not relay the request;
- that the source database is unchanged by a read or proposal call.

## Ask From The CLI

CLI Ask uses the same provider adapters, in-memory MCP gateway, tool schemas,
authority digest, egress decision, and runtime validators as Workbench Ask:

```bash
synapsor-runner try ask \
  --provider openai \
  --model gpt-5-mini

synapsor-runner try ask \
  --provider openai-compatible \
  --model local-model \
  --base-url http://127.0.0.1:11434/v1 \
  --timeout 180
```

The guided provider picker performs one bounded request to a loopback
OpenAI-compatible `/models` endpoint and offers the returned model IDs instead
of silently choosing an unrelated vendor default. Direct scripted
`try ask --provider openai-compatible` remains explicit: pass `--model` and
`--base-url` so automation never changes model because a local server changed.

For smaller local models, the model-facing catalog is a compact resource index
followed by focused details for one exact resource. Each resource includes one
valid reviewed plan example. Declared optional arguments may arrive as `null`,
clean integer strings, or JSON-encoded arrays/objects and are normalized before
the original strict schema runs. Required fields, enum values, cardinality
bounds, unknown-key rejection, reviewed resource/relationship allowlists, and
trusted scope are never relaxed.

If a loopback model describes catalog metadata instead of querying data, Runner
allows one focused correction and one JSON-plan response. Runner compares that
plan with exact terms in the question and reviewed catalog before source
execution. A mismatch runs no query. A matching rescued plan executes through
the normal validator/compiler, and Runner renders the verified result directly
instead of asking the weak model to summarize values it may misread. Models that
use the tool protocol correctly keep the normal model-prose path.

The pre-execution substitution check is not limited to local models. Official
OpenAI and Anthropic Ask calls pass through the same focused reviewed-metadata
check before `app.explore_data` reaches the gateway. If a question explicitly
names an unavailable entity or grouping and the model substitutes a different
reviewed table or field, Runner returns `ASK_PLAN_INTENT_MISMATCH`. The
substituted plan executes no source query, consumes no Explore query or
differencing budget, and is never returned to the provider for a prose summary.
Exact field IDs can be written with their original separators (`encounter_type`),
hyphens (`encounter-type`), or spaces (`encounter type`). A reviewed field label
is also valid intent evidence. A trailing term may be used when the question
names the resource and exactly one of its reviewed direct grouping fields or
labels ends with that term. For example, `shipments by mode` identifies
`carrier_mode` and `shipments per zone` identifies `warehouse_zone`. If both
`carrier_mode` and `delivery_mode` are reviewed, `shipments by mode` refuses
before execution and names both choices. Use the full ID or a reviewed label to
disambiguate. This resolution is derived from reviewed metadata; it contains no
domain vocabulary.

Reviewed enum values also participate in intent checking. Normally, if the
question names an allowed value such as `emergency`, the plan must constrain the
matching exact field in `where`; merely grouping all values does not answer that
question. A categorical comparison is the deliberate exception: “are
apprentices slower than senior staff?” may group the reviewed grade enum, and
must not filter the result down to only one side. A time comparison such as
“emergency visits this month versus last month” still filters `emergency` and
compares periods. An `in` filter must contain exactly the values named by a
normal filter question, not a wider set, and a value that exists on more than
one reviewed field is refused as ambiguous. OpenAI and Anthropic receive one
bounded correction containing the exact requirement. A refused first attempt
runs no source query and spends no Explore budget.

Magnitude comparisons need reviewed numeric grouping. If a question asks
whether bigger, older, or heavier records have a different outcome but the
intended field has no fixed or automatic numeric band, Ask refuses before
execution and points to `G Reviewed metrics and numeric bands`. Raw numeric
values never become a grouping fallback, and an unrelated categorical field is
not substituted. A cross-table version also names the need for a reviewed
relationship or child-count path.

For business-data questions, official-provider prose is not accepted as an
answer until a reviewed Explore plan succeeds. If a provider answers from
general knowledge without tools, Runner forces one catalog pass and one chance
to call `app.explore_data`; otherwise it discards the prose and reports that no
query ran. Generic row words such as `records`, `rows`, or `cases` are not
treated as physical resource names unless the reviewed catalog actually
contains that exact resource. For an unqualified trend, the provider is told to
use reviewed `time_coverage` and `maximum_groups` and choose a month, quarter,
or year grain when a finer bucket would omit or exceed the covered series.

This is a correctness guard in Runner's built-in Ask client. An external MCP
host sends only a structured plan to production HTTP Runner, so that host must
retain the original question and apply its own semantic evaluation; server-side
scope, grammar, suppression, and budgets remain fail-closed regardless.

Without a positional question, the command opens the conversational
`Synapsor Analytics` shell. Ask natural-language follow-ups directly. The
normal answer shows concise model interpretation plus every actual structured
Explore result used; it does not repeat evidence IDs, mutation state, digests,
or analysis references after every read.

The terminal separates untrusted model prose from `RUNNER-VERIFIED DATA` with a
visible rule and terminal styling. Before the first prompt, it summarizes only
the active boundary's reviewed tables and legal operations and offers a starter
question validated against that exact active catalog. Successful output hides
intermediate provider attempts that Runner safely refused before a valid plan;
use `/attempts` to inspect them. One-shot users can pass `--verbose` for the
same detail.

When provider prose repeats at least three rows already present in the
structured result, the human presentation removes only those provably
duplicated row lines. The interpretation remains visible, Runner still renders
the complete authoritative table, and Workbench keeps the original provider
text under **Full model explanation**. Machine-readable output and bounded
conversation history retain the original provider answer.

If a provider executes a successful reviewed plan but returns no visible final
explanation, Runner reserves one bounded provider pass with no tools attached.
That pass may summarize only the Runner results already present in the turn and
cannot run another query. If it still returns no text, Runner preserves the
verified structured result and displays a deterministic local explanation
instead of discarding the answer.

For an unqualified question such as `Which product category is growing
fastest?`, Ask first reads cohort-safe reviewed time coverage and uses one
reviewed two-period comparison: the latest 28 reviewed days against the
preceding 28 days, ordered by reviewed percentage change. It uses the current
UTC date only when the reviewed coverage reaches it. `Largest increase` uses
signed absolute change; `fastest decline` uses ascending percentage change.
The rendered interpretation states the two ranges. Ask does not request an
all-history category-by-week cube.
Runner validates the complete population against the separately reviewed ranked
candidate ceiling, suppresses small cohorts, and only then ranks the result.
This is an Ask interpretation default, not broader authority; both periods, the
measure, the dimension, the time field, and every relationship still pass the
exact active boundary.

The shell keeps short project-local references silently for governance:

```text
/access
/access-workbench
/analyses
/details [last|A2]
/attempts
/limits
/limits --session-tokens 400000
/limits --max-output-tokens 2048
/protect
/protect A2 as analytics.weekly_churn_by_channel
/clear
/exit
```

Use `/access` whenever a refusal shows that the current Explore boundary is too
narrow. In CLI Ask it closes the current chat cleanly and opens the terminal
table/column editor; use `/access-workbench` for the secured visual editor. The
older `/access workbench` spelling remains accepted for compatibility but is
not the advertised command.
Each column has an explicit **Visible to model**, **Withheld from model**, or
**Kept out** tier. Existing active boundaries remain usable while the selected
draft is edited. The edit is an operator-plane review decision: it stages new
disabled authority and a new digest, but the model cannot make the choice or
activate it. After activation, CLI Ask resumes with the same selected provider,
model, and in-memory credential. The exact activation review names that model
destination and renews consent for the new authority in the same human gesture;
an access change made outside this handoff still blocks the next provider call
until the operator reviews the new destination and authority.

Several reviewed boundaries may be active in one authoring session. The model
still receives exactly `app.describe_data` and `app.explore_data`.
`app.describe_data` supplies boundary names with the reviewed resource catalog;
each plan selects one boundary. Runner refuses cross-boundary joins/unions and
requires an explicit boundary when a resource alias overlaps. Adding authority
does not reset the durable rolling 24-hour privacy or differencing budgets.

CLI and Workbench use the same focused two-step flow: make all table, column,
and reviewed-path changes in one editor, then inspect and activate one exact
combined boundary. Routine draft changes do not revoke the currently active
version. Sensitive widening still asks for reviewer identity and reason, while
nullable relationships require an explicit unmatched-row choice because that
choice changes totals. The full `boundary review` route remains available for
the advanced grouped sign-off and audit workflow.

When a question needs a relationship absent from the active boundary, Runner
may show a **Human review path** after the provider turn. This is local
operator-plane metadata, derived from inspected foreign-key proof in the
disabled draft; it is not sent to the provider and is not an MCP tool. The path
remains disabled until a human reviews and activates its exact new boundary.
Kept-out fields do not advertise a widening path. Questions requiring a ratio
or another derived formula instead point to a reviewed database view or named
metric because Explore does not grow a model-controlled expression language.
When no data plan ran and Runner has such a proven path, the normal CLI and
Workbench view shows a deterministic Runner boundary explanation followed by
the exact inspected path. This prevents speculative or contradictory provider
advice from competing with the operator action. JSON retains the original
provider answer, and Workbench keeps it under **Full model explanation**.

Bare `/protect` selects the sole protectable plan from the current answer. If
the answer used several plans, Runner shows a readable picker. If it ran no new
plan, Runner does not silently attach an older analysis. Add a quoted question
before `--provider` to retain one-shot behavior. For later one-shot promotion,
use `synapsor-runner try protect --last --name <capability>`; ambiguous latest
answers require `--from A2`.

## Inspect And Protect Without Leaving The CLI

`/details` is the concise operator evidence view for the latest analysis. It
shows the original question when Runner received it, the exact typed tool call,
Runner's normalized plan, selected boundary and digest, reviewed relationships,
trusted-scope binding mechanism without its value, read-only transaction
posture, suppression and budget decisions, duration and result-size metadata,
evidence/query-audit references, and whether a source query or mutation
occurred. Use `/details A2` to select another recent analysis.

An external MCP host may not provide the human's original question. Evidence
then says **Original question unavailable; the MCP host supplied this typed
tool call** rather than reconstructing or inferring the host conversation.
Refused attempts retain the typed attempted plan, refusal code, rejecting
boundary, failed rule, and whether a source query executed. Neither evidence
view exposes chain-of-thought, returned source rows, hidden values, or trusted
scope values.

`/details A2 --sql` adds an operator-only diagnostic showing the actual
dialect-specific parameterized statement shape and safe parameter types. Every
parameter value is redacted. The statement is never sent to a provider or MCP
client, never becomes an execution input, and is not stored in ordinary
evidence; the normalized plan remains the portable authority record. Workbench
provides the equivalent **What the model requested**, **What Runner executed**,
**What Runner returned**, and **Compiled database statement** disclosures
inside its secured local operator session.

Interactive `/protect` completes in the same terminal. Runner selects the sole
eligible plan or opens a readable picker, suggests an editable capability name,
generates public DSL, canonical JSON, tests, and provenance, and keeps the draft
disabled while showing the exact review. A separate default-yes human prompt
then activates only that previewed digest and returns to the same analytics
session. No Workbench URL, copied analysis ID, typed digest, or `ACTIVATE
sha256:...` phrase is required. Choosing No or Escape leaves the capability
disabled.

Workbench is an optional visual equivalent, not a required continuation. Its
single **Activate this reviewed capability** button binds the currently
previewed digest internally. Both surfaces recompute the artifact digest at
activation time and refuse stale or changed authority. The operator identity,
digest, time, and decision remain recorded. Sensitive widening, lowered cohort
thresholds, writes, and production effects may require additional
consequence-focused review, but the model cannot perform any review, Protect,
or activation action.

Use `--provider anthropic` for the Anthropic Messages/tool-use protocol.
Provider credentials come from the conventional provider environment variable,
an explicitly named environment variable, or a hidden interactive prompt.
`--api-key` and generic `--yes` are refused. JSON automation requires exact
non-secret consent bound to provider, model, origin, profile, boundary, config,
and tool surface.

CLI output labels provider prose as untrusted and renders Runner-verified tool
results separately. A successful Explore call receives an expiring local
analysis reference, but routine conversational output hides that internal
handle. Asking a question itself creates no DSL, contract, or named authority.

## Prove The Active Boundary

Workbench's **Prove this boundary** action drives deterministic attacks through
the same two model-facing authoring tools. It tests raw SQL, model-selected
scope, kept-out fields, unreviewed relationships, result-bound and suppression
overrides, plus suppressed-total subtraction. The subtraction check may run a
bounded grouped aggregate and its complementary scalar total in read-only
transactions. Probe values are discarded and never written to the proof
artifact; if a small cohort was suppressed, Runner must refuse release of the
complementary result. If the current data contains no suppressed cohort, the
artifact says that the subtraction route was not applicable instead of
claiming a refusal that did not occur.

This is a rerunnable boundary-enforcement check, not a claim of differential
privacy or proof against every possible statistical inference technique.
Successful normal analytics do read scoped source rows and return bounded
aggregate results; only refused pre-execution attacks truthfully report that no
source query ran.

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
after configuration. Paste only the key value, not a complete
`OPENAI_API_KEY=...` or `ANTHROPIC_API_KEY=...` assignment and not surrounding
`.env` quotes. Do not paste credentials into an agent chat.

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

The question, reviewed tool definitions, and model-visible portions of bounded
tool results go directly from local Runner to the selected provider. A tool
result can contain reviewed source values, so use a provider and data-handling
policy appropriate for that data. Kept-out fields are unavailable to
selection, filtering, grouping, sorting, joins, or returned results.

A field reviewed as **withheld from model** remains usable in a plan, but its
raw returned values, group labels, and enum/value domain stay out of every
provider request. The catalog retains only the reviewed type and legal
operations needed to compose typed plans. Returned values are replaced with
response-local opaque tokens. Reviewed derived results remain available
without sending the values being counted. Workbench renders actual raw values in the separate local
Runner-verified result and states that the model cannot name them. The same
token is reused for the same value only within that one response; a new
response uses unrelated tokens. Suppression and every other read budget still
apply because the human result is a disclosure channel.

Runner does not persist the conversation, provider response, or returned tool
rows by default. Existing normalized query audit still records the boundary
digest, keyed plan/literal fingerprints, suppression decision, timing, and
result size without storing result values or trusted tenant/principal values.
An operator-created screenshot or external provider may retain data under its
own policy; Runner cannot erase those external copies.

## Authority And Proposal Behavior

Provider tool calls use the official MCP SDK and the same canonical runtime as
an external client:

- exactly one authoring or named-runtime catalog, never both;
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

Analytical tools advertise structured output schemas. The provider may use
those schemas to interpret success, empty, suppression, incomplete comparison,
and refusal outcomes, but output metadata never expands input authority.

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
OpenAI:    https://api.openai.com/v1/responses
Anthropic: https://api.anthropic.com/v1/messages
```

The official adapters use each provider's native tool protocol. OpenAI
function calls and outputs are encoded as Responses API `function_call` and
`function_call_output` items, and Runner sends `store: false` on every official
OpenAI request. Anthropic uses Messages API `tool_use` and `tool_result` blocks.
Custom OpenAI-compatible and loopback providers continue
to use the documented Chat Completions tool-call subset because Runner cannot
assume that a compatible server implements Responses.

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

For a structured provider `400`, Runner shows the provider's bounded message
after removing control characters and common credential/URL forms. Arbitrary
response bodies are never printed. Authentication, permission, and quota
failures remain classified without echoing their bodies.

No URL, model, header, or destination comes from model output.

## Bounded Session Controls

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
| Reserved OpenAI-compatible final pass | 4,096 completion tokens, no tools |
| Conversation history | 4 completed turns, 16 KiB |
| Final answer | 16 KiB |
| Provider request timeout | 30 seconds remote; 120 seconds loopback; operator override 1-600 seconds |
| Ordinary provider-call output request | 1,200 tokens by default; explicit override 256-16,384 |
| Reported session token usage | 200,000 by default; operator ceiling 1,000-5,000,000 |

One Workbench Ask session runs one request at a time. Runner does not
automatically retry provider calls in this release. A developer may retry a
known safe failure from the UI; every retry begins with current authority
validation. Token accounting depends on usage reported by the provider and is
not a monetary spend guarantee.

Set the initial client limits with
`try ask --session-token-budget <tokens> --max-output-tokens <tokens>` or the
parallel `start --cli` flags. In the terminal shell, `/limits` reports usage and
`/limits --session-tokens <higher-value>` raises the cumulative ceiling without
clearing the conversation. Workbench's **Ask limits** panel performs the same
in-memory update. Leaving the output override blank or selecting `automatic`
retains the existing call-specific defaults, including the separately reserved
OpenAI final explanation pass. These settings control model-provider context
and operator spend exposure; they do not alter the boundary digest, database
scope, small-group suppression, or Explore query/differencing budgets.

The timeout applies separately to each provider call in the bounded tool loop,
not to the complete question. Set it with CLI `--timeout <seconds>`, with
`start --cli --timeout <seconds>`, or in Workbench provider settings. Runner
keeps a 600-second wall-clock ceiling even for local endpoints.

Runner does not inject vendor-specific request fields into a generic
OpenAI-compatible endpoint. For Ollama, keep a model resident with the Ollama
server setting before starting it, for example
`OLLAMA_KEEP_ALIVE=10m ollama serve`; warming the model can reduce its first-call
latency but does not replace a suitable Runner request timeout.

## Tested Provider Matrix

Status as of the unreleased 1.7.1 source:

| Provider surface | Verification | Claim |
| --- | --- | --- |
| OpenAI Responses API (`gpt-5-mini` live; current reasoning-family request shape in regression) | Live packed Community Solar and TrailPeak runs against real local PostgreSQL plus deterministic native `function_call`/`function_call_output` turns | Live tested on `gpt-5-mini`; native current-model protocol regression tested |
| Anthropic Messages/tool-use protocol | Deterministic native `tool_use`/`tool_result`, normal/refusal/error paths | Protocol tested; no live Anthropic account run |
| Custom OpenAI-compatible loopback | Deterministic real HTTP server plus tool/refusal/proposal and endpoint-security paths | Protocol tested against the documented Chat Completions subset |
| Ollama `qwen2.5:7b` | Live local PostgreSQL matrix plus a real RS256/JWT-authenticated production Streamable HTTP MCP run; simple enum filtering, a two-hop relationship aggregate, kept-out refusal, exact two-tool surface, and no model-supplied scope | Live tested through Ollama's OpenAI-compatible API |
| LM Studio or another named local server | No live engine run in this release | Compatibility requires the documented Chat Completions and tool-call subset; the label alone is not a claim |

The live OpenAI run used `app.describe_data` and `app.explore_data`, matched the
official MCP aggregate result, changed no source rows, and passed exact-key
artifact scans. See
`development/runner-1.6.6-community-solar-results.json`.

## Troubleshooting

**Ask is missing:** confirm loopback Workbench, a development/staging profile
established by trusted Runner launch or operator configuration, and at least one
active reviewed tool. The fresh guided `start` route supplies that profile
without another Workbench declaration. Production intentionally omits Ask.

**Key required:** export the named variable in the process that launches
Runner, or use the session-only masked paste. Runner does not load `.env`.

**Provider could not authenticate:** this is a provider credential failure, not
a Synapsor boundary refusal. Use **Change provider or key**, then paste only the
key value or select an environment variable that was exported before Workbench
started. A changed environment value requires a Workbench restart. Runner never
includes the provider response body or credential in this error.

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

**CLI Ask refused consent:** interactive CLI use shows the reviewed provider,
model, and endpoint, then accepts Enter as the default **Yes** response. Type
`n` to cancel without contacting the provider. Noninteractive or JSON
automation must supply the exact non-secret authority-bound consent value.
Never put a provider key in a command argument.
