# Proposal: One Result Envelope for all Synapsor Runner tool results

Status: draft for synapsor-runner (OSS)
Author: external integrator feedback (built a full OpenAI Agents SDK + Postgres lab on alpha.6→alpha.11)
Goal: make every tool result (read, proposal, error) share one shape that is both
**machine-branchable** and **LLM-legible**, so agents behave reliably and client
code stops special-casing.

## Why

Observed today (alpha.11), the shapes diverge:

```jsonc
// read success
{ "status": "ok", "action": "billing.inspect_invoice", "data": { ... },
  "evidence_bundle_id": "ev_…", "trusted_context": { ... }, "source_database_changed": false }

// read not-found / tenant mismatch
{ "ok": false, "code": "ROW_NOT_FOUND", "error": "The scoped capability read did not find exactly one authorized row." }

// proposal success
{ "status": "review_required", "proposal_id": "wrp_…", "diff": { "late_fee_cents": { "before": 2500, "proposed": 0 } },
  "source_database_changed": false }
```

Three different top-level keys (`status` vs `ok`), two different success vocabularies,
and raw infra strings leaking into `error`. An LLM driving these has to learn three
branches; in my live tests the model **stalled / misreported** ("database access issue")
when it hit the off-shape error path.

## The envelope

Every tool returns exactly this top-level shape:

```jsonc
{
  "ok": true,                       // boolean — the ONLY field client code must branch on
  "summary": "Invoice INV-3001: $100 + $25 late fee, status overdue.",  // one-line NL for the model to read/echo
  "action": "billing.inspect_invoice",
  "kind": "read",                   // read | proposal
  "data": { ... } | null,           // read payload (the row), or null
  "proposal": { ... } | null,       // proposal payload (see below), or null
  "error": { ... } | null,          // populated iff ok=false (see below)
  "evidence": { "bundle_id": "ev_…", "note": "audit handle; you do not need to act on it" } | null,
  "source_database_changed": false, // ALWAYS present; true only after applied writeback
  "_meta": { "tenant_id": "tenant_acme", "principal": "demo-operator", "provenance": "environment",
             "canonical_capability": "billing.inspect_invoice" }
}
```

Rules:
- `ok` is the single branch point. No more `status` vs `ok`.
- `summary` is mandatory and is the field the model is expected to read first and can
  echo back to the user. Keep it short, factual, no internal ids unless useful.
- Exactly one of `data` / `proposal` is non-null on success; both null on error.
- `_meta` carries the trusted context and the canonical capability name (so OpenAI-safe
  aliases like `billing__inspect_invoice` still expose their real name for reasoning/audit).

### Proposal payload

```jsonc
"proposal": {
  "id": "wrp_…",
  "state": "review_required",      // review_required | approved | applied | conflict | rejected
  "target": "invoices:INV-3001",
  "diff": { "late_fee_cents": { "before": 2500, "proposed": 0 } },
  "approval_required": true,
  "writeback": { "mode": "direct_update" | "app_handler", "applied": false },
  "next": "A human must approve outside this loop; nothing is committed yet."
}
```

This part of today's output is already the best-designed — keep `diff.before/proposed`
and `approval_required` verbatim, just move it under `proposal`.

### Error payload (safe + stable)

```jsonc
"error": {
  "code": "NOT_FOUND_IN_TENANT",   // STABLE enum (below) — never a raw infra string
  "message": "No invoice INV-9999 is visible in your tenant.",  // safe, terse, actionable
  "retryable": false
}
```

Never surface raw driver text (`connect ECONNREFUSED 127.0.0.1:5433`) to the tool
caller — log that to the local ledger only. Leaking it is a small info disclosure
**and** degrades LLM behavior (the model parrots infra errors to the user).

## Stable error code enum

| code | meaning | retryable |
|---|---|---|
| `NOT_FOUND_IN_TENANT` | lookup found 0 authorized rows (missing OR wrong tenant — do not distinguish, it's a scoping signal) | no |
| `INVALID_ARGUMENT` | arg failed schema/`numeric_bounds` | no |
| `POLICY_VIOLATION` | request outside an allowed bound/transition | no |
| `CAPABILITY_NOT_FOUND` | unknown tool name | no |
| `VERSION_CONFLICT` | row changed since the agent saw it (stale-row guard) | no (re-inspect first) |
| `MULTI_ROW_BLOCKED` | a write would touch ≠1 row | no |
| `APPROVAL_REQUIRED` | attempted to apply without approval | no |
| `TEMPORARILY_UNAVAILABLE` | DB/handler unreachable or timed out | yes |
| `INTERNAL` | anything else (details only in ledger) | maybe |

Keep this list small and documented; the model can be told "on `VERSION_CONFLICT`,
re-inspect then re-propose" and act correctly.

## Tool descriptions (ships with the envelope, same impact)

The envelope fixes *results*; descriptions fix *whether the model calls the right
tool at all*. Today they're generic ("Read public.outage_events through a reviewed
Synapsor capability…"). Let capability config carry model-facing text:

```jsonc
{
  "name": "support.inspect_outage",
  "description": "Look up an outage event: its time window, affected plan, and the credit policy that governs waivers/credits. Use this before deciding whether a waiver or credit is justified.",
  "args": {
    "outage_id": { "type": "string", "description": "Outage/incident id, e.g. OUT-9001 (often referenced in the support ticket)." }
  },
  "returns_hint": "Returns the outage window, affected_plan, and credit_policy."
}
```

In my live runs, the difference between a reliable agent and one that stalled before
proposing was exactly this: whether the outage tool's description told the model it
returns the *policy*. Surface `description` + per-arg `description` + `returns_hint`
in `tools/list`. Fall back to today's auto-text only when the author omits them.

## Migration

- Add `"result_format": 2` to `synapsor.runner.json` (or a server flag
  `--result-format v2`); default stays v1 for one minor cycle, then flips.
- During transition the server can **dual-emit**: v2 envelope with a `legacy` mirror
  of the old keys, so existing parsers don't break.
- Document a one-line mapping: `status:"ok"` → `ok:true`; `status:"review_required"`
  → `ok:true, proposal.state:"review_required"`; top-level `code/error` → `error.{code,message}`.

## Acceptance

- All of `tools/call` (read + proposal) and tool-level failures return the envelope.
- `ok` alone is sufficient to branch in client code.
- No raw driver/infra strings appear in any `error.message`.
- `tools/list` exposes author-supplied `description` / arg `description` / `returns_hint`.
