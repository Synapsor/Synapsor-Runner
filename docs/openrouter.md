# OpenRouter In Guided Setup And Ask

OpenRouter is a separate provider, not a custom OpenAI URL. Configure
`OPENROUTER_API_KEY` in the environment that launches Runner, then select
**OpenRouter** in model-guided setup. Runner never writes the key to the project,
client configuration, saved job, or model conversation. A nonstandard key
environment-variable name can be selected during setup.

The model picker lists recently published models whose catalog advertises text
input/output, tools, tool choice, and bounded output. The default is
`openai/gpt-5.6-terra`. A catalog listing is not a successful model check: account
access and compatible serving-provider availability are checked on a request.
When discovery fails, the current model remains selected and exact-ID entry is
available. Runner does not silently switch providers or models.

To use the same provider in local Ask after reviewing database access:

```bash
synapsor-runner try ask \
  --provider openrouter \
  --model openai/gpt-5.6-terra \
  --api-key-env OPENROUTER_API_KEY
```

Ask and authoring have separate disclosure reviews. Selecting an external MCP
client does not configure that client's model account or transfer a Runner key
to it. The client still connects to the same four Runner tools.

## Disclosure And Routing

Requests go to `https://openrouter.ai/api/v1/chat/completions` and a serving
provider selected by OpenRouter. The permission review names both destinations.
Authoring sends only the approved structural metadata and business context;
Ask sends only reviewed visible results. Existing redaction, scope and authority
checks remain in force.

Runner requires parameter support, disables serving-provider fallback, and
excludes providers permitting data collection using OpenRouter's routing
preferences. These settings are not a claim of zero retention or a replacement
for reviewing OpenRouter's and the serving provider's terms. The chosen model
stays fixed. Automatic routers, presets, online-search suffixes and batch models
are not accepted in this interactive path.

If no endpoint meets these restrictions, choose another compatible model or
retry later. Runner does not relax the restrictions. Missing credit, rejected
credentials, rate limits and incomplete responses are reported separately.
Incomplete tool calls are not executed. A bounded correction remains with the
same selected model and provider; it cannot grant authority.

Streaming uses the Chat Completions SSE contract. Private provider continuation
blocks needed for a tool round trip stay in memory and are not shown as chat,
stored as operator history, or presented as Runner validation. Required tool
calls, cancellations and output-size limits use Runner's normal checks.

Provider documentation: [API overview](https://openrouter.ai/docs/api/reference/overview),
[routing preferences](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
