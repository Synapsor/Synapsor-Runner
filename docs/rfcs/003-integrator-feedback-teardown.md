 here's the detailed teardown of the OSS synapsor-runner specifically, split into (A) what trips up a serious dev, and (B) how an LLM actually experiences it. Everything below is from things I hit building and live-testing the lab, not theory. I'll keep Cloud-domain stuff out of it (RBAC, central ledger, etc. — those belong in hosted).

A. Limitations for a serious dev/user

1. Config authoring is the real onboarding cost.
synapsor.runner.json is powerful but you mostly hand-write it. init --wizard exists, but multi-capability, executor-backed configs are manual, and there's no published JSON schema or one-page field reference — I learned the shape by running init and reading dist/runner.mjs. A serious dev wants: a versioned JSON Schema (so editors autocomplete + validate), and a "capability authoring" doc covering read vs proposal, patch (fixed/from_arg), allowed_columns, numeric_bounds, conflict_guard, executor.

2. Env-var sprawl + historical credential ambiguity.
There are a lot: SYNAPSOR_DATABASE_READ_URL, _WRITE_URL, legacy SYNAPSOR_DATABASE_URL, TENANT_ID, PRINCIPAL, RUNNER_HTTP_TOKEN, plus per-executor *_HANDLER_URL/_TOKEN. The apply-uses-SYNAPSOR_DATABASE_URL-vs-write_url_env thing cost me real debugging on alpha.6 (now documented). doctor is good but only checks presence; it doesn't prove the write path (attempt a rolled-back probe write with the writer cred) or handler reachability.

3. Store ↔ server lifecycle is a footgun.
The SQLite store is shared state, and the running server holds it open. Deleting/resetting the store under a live server gives corrupt/confusing behavior — I hit "database access issue" surfaced to the agent because I reset the store without restarting the server. There's no lock, warning, or coordinated reset. Also: running serve-http + serve-streamable-http on one store simultaneously is asking for contention, with no guardrail.

4. The receipt-table permission gotcha.
Direct writeback does CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts, which a least-privilege writer can't do (PG15+ no CREATE on public). Now documented, but doctor could detect it and print the exact GRANT/DDL (or a flag to pre-create). I had to invent the dedicated-schema trick myself.

5. App-owned handlers re-implement security by hand.
The executor contract is "match the example": you must re-check tenant, parse change_set, enforce the expected_version stale-row guard, and do idempotency yourself. It's easy to write an insecure handler (skip the version check, forget tenant scope). There's no published handler SDK/helper and no request signing — the only auth is a bearer token, so the handler trusts the POST body's tenant/version. A first-party handler helper (verify + parse + enforce guards, optional HMAC signature) would remove a whole class of mistakes.

6. Versioning discipline.
@alpha is a moving tag and behavior changed meaningfully across alpha.6→11 (transport, arg types string→number, credential resolution). I had to pin and bump six times. A stable channel + changelog + semver promise is table stakes before serious devs build on it.

7. Two serve modes are easy to confuse.
serve-http (lightweight JSON-RPC, not real MCP) vs serve-streamable-http (spec MCP) on different ports, plus --alias-mode. I pointed the SDK at the wrong one. Consider: make serve-streamable-http the headline, rename serve-http to something like serve-bridge/--legacy-jsonrpc, and have mcp client-config always pair the client with the matching server command (it does for openai-agents — good).

8. Observability is CLI-only.
replay/activity are genuinely nice, but there's no structured event stream/webhook for proposal.created/approved/applied. Even a local webhook would let people build a review UI or Slack-notify a reviewer without polling. (The full ledger is Cloud's job; a local event hook isn't.)

B. How easy is it for an LLM to use/understand?

This is where you have the most leverage, and I have direct evidence.

1. Tool descriptions are the single biggest reliability lever — and they're currently generic.
On the JSON-RPC path my agent was reliable because my function-tool docstrings were rich ("Read an outage event — window, affected plan, credit policy; use this to decide if a waiver is justified"). On the native streamable path the model stalled and refused to propose, and a big reason was the auto-generated description: "Read public.outage_events through a reviewed Synapsor capability with trusted tenant context and evidence." That tells the model the plumbing, not what the tool is for or what it returns. The model didn't realize the outage tool gives it the policy it needed.
→ Let capability config carry a model-facing description + per-arg descriptions + an optional "returns/when to use" hint, and surface them in tools/list. This alone would have made my streamable runs reliable. Right now authors can't easily improve what the model sees.

2. Inconsistent result envelopes hurt the model (and the code).
Success = {status:"ok", data:{...}, evidence_bundle_id, trusted_context, ...}. Not-found = {ok:false, code, error}. Two different shapes for the same tool means the model (and my client) must branch on multiple keys. → One envelope always: {ok: true/false, data?, error?, summary}, where summary is a one-line natural-language result the model can echo to the user. The proposal result (proposal_id, diff: {before, proposed}, source_database_changed:false) is the best-designed part — model-legible and unambiguous; mirror that everywhere.

3. Leaky/raw errors confuse the model.
A failed read surfaced connect ECONNREFUSED 127.0.0.1:5433 straight into the agent, which then told the user "database access issue." Raw infra errors are both a small info leak and bad for LLM behavior. → Safe, terse, actionable tool errors ("temporarily unavailable, retry later" / "not found in your tenant"), with details only in the local ledger.

4. Dotted names vs aliases.
alias-mode openai correctly makes names valid (billing__inspect_invoice), but the alias diverges from any example/instruction that uses the canonical dotted name — so prompts that say "call propose_late_fee_waiver" don't match the tool the model sees. I had to make my agent instructions tool-name-agnostic. → Keep openai-safe aliases as the default for the openai-agents config (you do), and put the canonical name + purpose in the description so the model can still reason about it.

5. Evidence handles are slightly confusing in-loop.
The model gets evidence_bundle_id but can't really do anything with it during the turn (it's for replay). Without a hint, a model may try to "use" it. A one-line "this is an audit handle; you don't need to act on it" in the description avoids wasted reasoning.

6. No recommended agent-instruction snippet.
The biggest gap for first-time LLM integrators: the propose-first pattern needs the model to inspect all evidence before proposing and follow referenced IDs. I had to write that system prompt myself (and rewrite it once for the streamable path). → mcp client-config could optionally emit a recommended instruction block ("gather evidence first; follow referenced ids like OUT-…; propose only within policy; you cannot write or approve"). That would make day-1 agent behavior reliable instead of something each integrator rediscovers.

Net on LLM-friendliness: the conceptual model is excellent for LLMs — propose-only tools are inherently safe and easy for a model to call. The surface (generic descriptions, mixed envelopes, raw errors, alias/name divergence) is where reliability leaks. These are all fixable in the OSS runner and would noticeably raise the floor on agent reliability.

C. If I were prioritizing your OSS updates

P0 (adoption + LLM reliability):
1. Author-supplied rich tool/arg descriptions in config, surfaced in tools/list.
2. One consistent result envelope + safe terse errors + a summary field.
3. Published config JSON Schema + a capability/executor authoring page.

P1 (trust + safety):
4. Stable release channel + changelog/semver.
5. Handler helper/SDK (parse + enforce tenant/version/idempotency, optional HMAC) so app-owned writeback is safe-by-default.
6. doctor that probes the real write path + handler and emits exact GRANT/DDL for receipts; store/server lifecycle guardrails (warn on store-removed-under-server).

P2 (polish):
7. Optional recommended agent-instruction snippet from mcp client-config.
8. Local lifecycle webhook/event stream for proposals.



---------------
01-result-envelope-spec.md

One envelope for every tool result, so ok is the only thing client code (and the model) must branch on:

jsonc
{ "ok": true, "summary": "<one-line NL the model reads/echoes>", "kind": "read|proposal",
  "data": {…}|null, "proposal": {…}|null, "error": {"code","message","retryable"}|null,
  "evidence": {…}|null, "source_database_changed": false, "_meta": {tenant, principal, canonical_capability} }

Key decisions, all grounded in what broke in my live runs:
- Kills the status vs ok / mixed-shape problem (today success uses status:"ok", errors use ok:false — two branches).
- Mandatory summary field — the LLM reads it first; fixed my "model parroted infra error" issue.
- Safe, stable error.code enum (9 codes, table included) — never raw ECONNREFUSED-style strings, which both leak and degrade agent behavior.
- Author-supplied description / per-arg description / returns_hint surfaced in tools/list — this is the single biggest LLM lever; the streamable stall I hit was the outage tool's generic description not telling the model it returns the policy.
- Migration path: result_format: 2 flag + dual-emit + old→new mapping table.

02-handler-helper-interface.md

A first-party helper so app-owned executors are safe by default instead of "match the example."
- Formalizes (and versions) the request/receipt contract that's currently implicit.
- createWritebackHandler (TS) + synapsor_handler (Python — since real handlers are app code) where the author writes only the INSERT/UPDATE and returns effects; the helper enforces auth + HMAC signature, tenant scope, expected_version stale-row guard, idempotency, atomicity, safe receipts for them.
- Calls out request signing (today a handler trusts body-supplied tenant_id behind only a bearer token) and the receipts-table GRANT/DDL gap.
- Rationale tied to your own thesis: rich writes are the executor's job, but that's only safe if the handler is safe — so make the secure path the easy path.

Both are sized to drop into the repo as RFCs. If you want, next I can: turn the error-code enum into a concrete TypeScript type + a v1→v2 adapter shim, or sketch the Job/Tx type definitions for the handler helper so they're ready to implement.
