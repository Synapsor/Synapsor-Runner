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

## Trust Boundaries

```text
MCP client/model
  -> Synapsor Runner MCP server
  -> reviewed capability config
  -> read-only database credential
  -> local proposal/evidence/replay store
  -> human approval outside the model
  -> guarded worker with write credential
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

The model-facing MCP tool call has request/proposal authority. The trusted runner has execution authority only for already-approved, scoped writeback jobs.

In small-fleet mode, a TLS load balancer sends signed sessions to stateless
Runner instances. Every effective capability context must bind tenant and
principal from verified claims. Shared-ledger mutations serialize under a
bounded Postgres advisory lock; source-side receipts remain the durable
idempotency boundary for effects.

## Covered Threats

- Model asks for arbitrary SQL: no generic SQL tool is exposed in the Synapsor path.
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
- Model-callable approval: approval/commit tools are not exposed to MCP clients by default.
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
- Prompt injection itself.
- Business invariants not represented in the capability config, proposal, application handler, or database constraints.
- Generic multi-row business transactions, DDL, UPSERT, model-generated
  predicates, or cross-database atomicity in the Runner direct-write path.
- A compromised IdP/JWKS host, ledger database, source database, TLS
  terminator, or administrator-approved contract.
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
- Allowlist JWKS egress, keep `/metrics` separately authorized, budget source
  pools across replicas, back up/verify the shared ledger, and retain the
  configured `max_entries` safety bound.
- Use verified `signed_key` or `jwt_oidc` reviewers for production-like shared
  queues; `dev_env` is unverified.
- Treat proposal/evidence/replay handles as identifiers, not authorization;
  preserve verified per-session context on every networked resource read.

## Release Blockers

- Client-specific MCP configuration must be tested before claiming support for that client.
- Cloud-linked mode requires a compatible Synapsor Cloud API and scoped runner token.
- Public release should include dependency review, secret scanning, and container-backed smoke results.
