# Proposal: An app-owned writeback handler helper (safe-by-default executors)

Status: draft for synapsor-runner (OSS)
Goal: make `http_handler` / `command_handler` executors **safe by default**. Today a
handler author must re-implement tenant scoping, the stale-row (`expected_version`)
guard, and idempotency by hand — "match the example." That's a security-critical loop
to leave to copy-paste. Ship a tiny helper that enforces the guards and hands the
developer only the business write.

## The problem, concretely

I wrote a working credit handler for the lab. To be correct it had to, in order:
re-auth the bearer token, reject the wrong `action`, extract tenant/object/version
from a loosely-typed `change_set` (with 3 fallback paths each, copied from the
example), check idempotency, `SELECT … FOR UPDATE`, compare a normalized
`expected_version`, INSERT + UPDATE, and format a receipt with the right status
vocabulary. **Every one of those is a place to introduce a vulnerability** (skip the
version check → lost-update; skip tenant → cross-tenant write; trust body tenant
without signature → spoofing). Most integrators will get at least one wrong.

## The contract (formalize what's currently implicit)

Request the runner POSTs to an `http_handler` (make this a published, versioned schema):

```jsonc
{
  "protocol_version": "1.0",
  "proposal_id": "wrp_…",
  "idempotency_key": "wrp_…:INV-3001",
  "issued_at": "2026-06-28T…Z",
  "signature": "sha256=…",            // NEW: HMAC over the raw body (see Security)
  "change_set": {
    "action": "support.propose_plan_credit",
    "scope":   { "tenant_id": "tenant_acme", "object_id": "INV-3001" },
    "principal": { "id": "human-reviewer" },
    "target":  { "schema": "public", "table": "invoices", "primary_key": { "column": "id", "value": "INV-3001" } },
    "patch":   { "credit_requested_cents": 1500, "credit_reason": "outage credit" },
    "guards":  { "tenant": { "column": "tenant_id", "value": "tenant_acme" },
                 "expected_version": { "column": "updated_at", "value": "2026-05-16T00:00:00Z" } }
  }
}
```

Receipt the handler must return (today's status vocabulary, kept):

```jsonc
{ "status": "applied" | "already_applied" | "conflict" | "failed",
  "rows_affected": 2,
  "source_database_mutated": true,
  "previous_version": "2026-05-16T00:00:00Z",
  "new_version": "2026-06-28T…Z",
  "safe_error_code": "ROW_CHANGED_AFTER_PROPOSAL",   // on conflict/failed
  "details": { "effects": [ { "type": "db.insert", "table": "credits", "id": "CR-…" } ] } }
```

## Helper API (TypeScript — first-party, since the runner is TS/Node)

```ts
import { createWritebackHandler } from "../packages/handler/src/index.js";

export const handler = createWritebackHandler({
  // 1. Authenticity: helper verifies bearer AND the HMAC signature for you.
  tokenEnv: "SYNAPSOR_APP_HANDLER_TOKEN",
  signingSecretEnv: "SYNAPSOR_APP_HANDLER_SIGNING_SECRET",   // optional but recommended

  // 2. Bind one apply() per capability. The helper has ALREADY:
  //    - verified auth + signature + protocol_version
  //    - matched the action
  //    - parsed scope/target/patch/guards into a typed `job`
  //    - opened a transaction, taken `SELECT … FOR UPDATE` on the target row,
  //      enforced tenant match + expected_version (stale-row), and short-circuited
  //      idempotency via the receipts table.
  //  You only write business effects with the provided tx; throw to roll back.
  capabilities: {
    "support.propose_plan_credit": async (job, tx) => {
      const creditId = `CR-${job.proposalId.slice(-12)}`;
      await tx.insert("credits", {
        id: creditId, tenant_id: job.tenantId, invoice_id: job.objectId,
        customer_id: job.row.customer_id, amount_cents: job.patch.credit_requested_cents,
        reason: job.patch.credit_reason, created_by: job.principal,
      });
      await tx.update("invoices", job.objectId, {
        credited_cents: job.row.credited_cents + job.patch.credit_requested_cents,
      });
      return { effects: [{ type: "db.insert", table: "credits", id: creditId }] };
    },
  },

  // 3. DB binding (helper owns the tx + FOR UPDATE + version compare + receipt write).
  source: { engine: "postgres", writeUrlEnv: "SYNAPSOR_APP_WRITE_URL" },
});
// handler is a (req,res) you mount at POST /synapsor/writeback, or an express/fastify route.
```

The helper turns conflict/idempotency/auth into framework concerns. The author writes
**only** the INSERT/UPDATE and returns `effects`; status/`rows_affected`/version
bookkeeping/receipt shape are produced by the helper.

## Helper API (Python reference — handlers are often the app, not Node)

```python
from synapsor_handler import writeback_handler, Job, Tx   # pip install synapsor-handler

@writeback_handler(
    token_env="SYNAPSOR_APP_HANDLER_TOKEN",
    signing_secret_env="SYNAPSOR_APP_HANDLER_SIGNING_SECRET",
    write_url_env="SYNAPSOR_APP_WRITE_URL",
)
def support_propose_plan_credit(job: Job, tx: Tx):
    credit_id = f"CR-{job.proposal_id[-12:]}"
    tx.insert("credits", id=credit_id, tenant_id=job.tenant_id, invoice_id=job.object_id,
              customer_id=job.row["customer_id"], amount_cents=job.patch["credit_requested_cents"],
              reason=job.patch["credit_reason"], created_by=job.principal)
    tx.update("invoices", job.object_id,
              credited_cents=job.row["credited_cents"] + job.patch["credit_requested_cents"])
    return {"effects": [{"type": "db.insert", "table": "credits", "id": credit_id}]}

# Mount as a FastAPI/Flask route:  app.post("/synapsor/writeback")(support_propose_plan_credit.asgi)
```

`Job` is fully typed/validated: `proposal_id`, `idempotency_key`, `tenant_id`,
`object_id`, `principal`, `patch`, and `row` (the locked current row). `Tx` only
exposes scoped `insert`/`update`/`query` against the configured write URL.

## What the helper guarantees (so the author can't forget)

1. **Authenticity** — bearer + HMAC signature over the raw body. Without signing,
   a handler trusts body-supplied `tenant_id`; with it, spoofing a writeback requires
   the secret, not just network reach.
2. **Tenant scope** — the locked-row `SELECT` always includes `tenant_id = scope.tenant_id`.
3. **Stale-row guard** — `expected_version` compared at second precision (matching the
   runner's own `versionValuesMatch`); mismatch → `conflict`, auto-rollback.
4. **Idempotency** — a receipts/dedup row keyed by `idempotency_key`; replay → `already_applied`, no double write.
5. **Atomicity** — author effects + receipt commit in one tx; any throw rolls back and returns a safe `failed`.
6. **Safe receipts** — never leaks raw driver errors; maps exceptions to `safe_error_code`.

## Security notes

- **Sign requests.** Add `signature = HMAC_SHA256(signing_secret, raw_body)` and a
  short `issued_at` skew window. Document it as recommended for any handler not on loopback.
- The handler's DB credential should still be least-privilege (in the lab: `synapsor_app`
  = SELECT/UPDATE invoices + SELECT/INSERT credits, nothing else). The helper doesn't
  replace DB perms; it complements them.
- Receipts table/dedup store: the helper should create-or-require it and, on permission
  error, print the exact `GRANT`/DDL (same gap as the direct-writeback receipts table).

## Why this matters for adoption

App-owned executors are the answer to "rich writes" (INSERT/multi-row/events) — the
thing the runner deliberately won't do itself. But that answer is only safe if the
handler is safe, and right now safety is the integrator's homework. A first-party
helper makes the secure path the easy path, which is exactly the framing the whole
product is built on: don't hand people a footgun, hand them a reviewed capability.

## Acceptance

- `createWritebackHandler` (TS) + `synapsor_handler` (Python) enforce auth, signature,
  tenant, version, idempotency, atomicity with no author code.
- A handler written with the helper passes the same conflict/idempotency/tenant tests
  the runner ships for direct writeback.
- Request/receipt schemas are published and versioned (`protocol_version`).
