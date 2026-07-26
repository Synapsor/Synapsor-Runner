# Threat Model

Synapsor Runner protects one narrow boundary: model-facing MCP database actions that go through reviewed Synapsor capabilities and guarded writeback jobs.

It is not a general MCP security gateway, not a prompt-injection cure, not a replacement for host security, and not a self-hosted copy of Synapsor Cloud.

## Assets

- Customer Postgres/MySQL credentials.
- Business rows targeted by model-facing workflows.
- Trusted tenant, principal, source, object, allowed-column, and version bindings.
- Proposal diffs, evidence bundles, query audit, approvals, writeback jobs, receipts, and replay records.
- Runner/session/operator tokens, local SQLite state, and optional shared
  Postgres proposal/evidence/replay ledger.
- Exact-digest supervised-worker policy, worker leases, attention events,
  notification delivery records, and webhook signing secrets.
- Generated boundary drafts, review decisions, exact activation digests,
  generation locks, reviewed relationship proofs, and Scoped Explore privacy
  budgets.
- Optional Workbench Ask provider credentials and direct-egress consent held
  only in the local process.

## Trust Boundaries

```text
MCP client/model
  -> Synapsor Runner MCP server
  -> reviewed capability config
  -> read-only database credential
  -> local proposal/evidence/replay store
  -> human or reviewed deterministic policy approval outside the model
  -> manual apply or separately enabled guarded worker with write credential
  -> Postgres/MySQL
```

In Cloud-linked mode:

```text
MCP client/model
  -> local Synapsor Runner MCP server
  -> Synapsor Cloud adapter/capability API
  -> Cloud proposal/approval/replay/job lease
  -> local guarded worker
  -> Postgres/MySQL
```

The model-facing MCP tool call has bounded request/proposal authority. The
trusted runner has execution authority only for already-approved, scoped
writeback jobs. Manual apply is the default. Supervised automatic execution
requires both contract permission and a deployment allowlist for the exact
active digest; the model controls neither.

In small-fleet mode, a TLS load balancer sends signed sessions to stateless
Runner instances. Every effective capability context must bind tenant and
principal from verified claims. Shared-ledger mutations serialize under a
bounded Postgres advisory lock; source-side receipts remain the durable
idempotency boundary for effects.

## Covered Threats

- Model asks for arbitrary SQL: no generic SQL tool is exposed in the Synapsor path.
- Model tries to turn Scoped Explore into generic SQL or production authority:
  Explore accepts only reviewed typed plans, is local authoring-only, and is
  absent from production, unknown-profile, remote, shared HTTP, and non-loopback
  tool catalogs. Protect output starts disabled and requires exact-digest human
  activation.
- Model invents or widens a join: aggregate relationships must be activated,
  catalog-proven many-to-one paths with fan-out one; table/key/join semantics
  and activation are not plan arguments. Ambiguous, one-to-many, many-to-many,
  stale, and over-depth paths fail closed.
- Generated authority widens after schema/role drift: generated capability and
  exploration authority are bound to schema, compiler/Spec, role, grant,
  ownership, RLS, and reviewed-proof fingerprints. Manual legacy projects are
  unaffected unless they adopt a generation lock.
- Optional Workbench Ask becomes a second policy engine: Ask lists and calls the
  exact active MCP/runtime tools, adds no activation/approval/apply authority,
  keeps provider choice outside model control, and treats provider prose/tool
  arguments as untrusted.
- Provider endpoint exfiltration or SSRF: official origins are fixed, custom
  remote origins require HTTPS, plaintext is loopback-only, redirects are
  refused, DNS is revalidated and pinned, and private/link-local/metadata
  destinations fail closed.
- Model supplies `tenant_id`, `principal`, source id, allowed columns, row version, or approval identity: runner rejects trusted-binding overrides.
- Prompt injection in database content asks the model to bypass policy: the runner ignores text as authority and only accepts structured capability/job state.
- Aggregate inference through a one-record group: reviewed aggregate tools
  require minimum-group suppression and never return member rows or IDs. This
  reduces, but does not eliminate, statistical inference risk.
- Policy self-expansion from favorable automated outcomes: graduated trust is
  off by default, excludes auto-approvals from human evidence, requires a
  verified operator decision, and exports without activation.
- Wrong tenant or object: reads and writes include trusted primary-key and tenant predicates.
- Disallowed field update: patch columns must be allowlisted.
- Stale row: conflict guard mismatch returns `conflict` instead of silently writing.
- Duplicate retry: atomic source receipts or durable Runner intents plus
  source-enforced version/unique guards prevent a known duplicate effect;
  ambiguous ledger/source crash windows stop for reconciliation.
- Over-broad write: direct INSERT/UPDATE/DELETE is single-row, tenant-bound,
  operation-guarded, and success requires exactly one affected row.
- Cloud credential leakage: database URLs and write credentials stay local and are not sent to Cloud.
- Model-callable approval or execution: activation, approval, apply, worker,
  notification-routing, and recovery controls are not exposed to MCP clients.
- Stale policy-approved work: supervised execution repeats current policy,
  limit, tenant/principal, target and supporting-evidence freshness,
  generation-lock, writer-posture, receipt, and lease checks before apply.
- Notification confused deputy or replay: webhook destinations and filters are
  operator-owned; payloads are redacted and HMAC-signed with event ID and
  timestamp; response content and delivery replay cannot authorize or mutate.
- Notification flood: the default external route is quiet; related incidents
  coalesce, transient recovery stays internal, and per-sink budgets/cooldowns
  bound non-critical interruption while retaining immutable events.
- Claims/environment confusion: an `http_claims` server fails before serving
  if a capability resolves an environment/static contract context.
- Leaked local resource handle: proposal, evidence, and replay reads resolve
  the owning capability context again and require the same trusted tenant and
  principal; missing or mismatched ownership returns the same generic
  `RESOURCE_NOT_FOUND` response.
- JWT algorithm/key confusion: networked sessions use an explicit RS256/ES256
  allowlist, issuer/audience/time checks, `kid`, and bounded public-key/JWKS
  loading.
- Fleet races: shared proposal creation, distinct reviewer decisions, worker
  claims, and fixed-window rate buckets are serialized/atomic in one ledger
  schema.
- Worker death around an effect: source receipts make retry before write safe
  and recovery after commit return `already_applied` rather than duplicate.

## Not Covered

- A compromised local host, MCP host, or modified runner binary.
- A malicious or compromised non-Synapsor MCP server.
- Credential theft outside the runner process.
- OAuth, SSRF, token-passthrough, or confused-deputy bugs in unrelated MCP systems.
- Sensitive data already returned to a model.
- Reviewed visible data intentionally sent to an operator-selected external
  model provider after Workbench egress consent; the provider's retention and
  training policy remains outside Runner.
- Prompt injection itself.
- Business invariants not represented in the capability config, proposal, application handler, or database constraints.
- Generic multi-row business transactions, DDL, UPSERT, model-generated
  predicates, or cross-database atomicity in the Runner direct-write path.
- A compromised IdP/JWKS host, ledger database, source database, TLS
  terminator, or administrator-approved contract.
- A compromised operator-approved notification destination or signing secret.
- Unbounded/high-throughput or multi-region ledger scale, compliance
  certification, or production SLA.

## Required Operator Controls

- Use a read-only credential for MCP reads.
- Use a separate write credential only in the trusted runner environment.
- Scope runner tokens to the project/source they serve.
- Keep capability config under code review.
- Prefer version/timestamp conflict guards over weak row-hash fallback.
- Review proposal diffs and evidence before approval.
- Monitor conflict/failed receipt rates.
- Keep automatic execution disabled unless both exact-digest opt-ins and a
  separately scoped least-privilege writer are reviewed. Monitor queue,
  dead-letter, UNKNOWN, reconciliation, and writer-posture state.
- Keep notifications disabled unless needed. Store webhook URL/signing secret
  only in operator environment, allowlist egress, and treat Workbench/ledger as
  authoritative rather than a chat or incident system.
- Allowlist JWKS egress, keep `/metrics` separately authorized, budget source
  pools across replicas, back up/verify the shared ledger, and retain the
  configured `max_entries` safety bound.
- Use verified `signed_key` or `jwt_oidc` reviewers for production-like shared
  queues; `dev_env` is unverified.
- Treat proposal/evidence/replay handles as identifiers, not authorization;
  preserve verified per-session context on every networked resource read.
- Keep Scoped Explore and Workbench Ask local to explicit development/staging
  authoring, verify a SELECT-only non-owner role, and disable Explore before
  production. Production should serve only activated named capabilities.
- Review generation-lock and relationship-proof drift instead of bypassing it,
  and do not treat Prisma/Drizzle/OpenAPI names as authorization.
- For Workbench Ask, choose provider/model/origin yourself, acknowledge direct
  egress, keep keys out of project files and chat, and clear in-memory sessions
  when finished.

## Release Blockers

- Client-specific MCP configuration must be tested before claiming support for that client.
- Cloud-linked mode requires a compatible Synapsor Cloud API and scoped runner token.
- Public release should include dependency review, secret scanning, and container-backed smoke results.
