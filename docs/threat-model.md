# Threat Model

Synapsor Runner is a local MCP/database safety layer. It narrows what a model
can do with Postgres/MySQL by exposing reviewed business capabilities instead
of raw SQL or write credentials.

## Protected Boundary

Runner is designed to protect the model-facing database boundary:

- no model-facing `execute_sql`, raw SQL, approval, commit, apply, or writeback
  tools;
- trusted tenant/principal context comes from config/session/env values, not
  model arguments;
- an HTTP-claims server rejects any capability whose effective contract
  context resolves tenant/principal from environment or static values;
- asymmetric sessions verify an explicit RS256/ES256 allowlist, issuer,
  audience, time bounds, and `kid` against bounded public-key/JWKS inputs;
- proposal tools save a proposed change without mutating the source database;
- direct writeback enforces primary key, tenant/scope, allowed columns,
  expected-version/conflict guard, affected-row count, idempotency, and
  receipt/replay recording;
- app-owned executors are called only after approval outside MCP;
- local evidence, query audit, proposal, receipt, and replay records are
  inspectable without rerunning side effects.
- shared-ledger mutations, reviewer decisions, worker claims, and fleet-wide
  rate buckets are serialized/atomic within one configured Postgres schema.

## Main Threats Addressed

- A model or prompt asks for broad SQL access.
- A model tries to choose tenant scope or write credentials.
- A model proposes a stale update after the source row changed.
- A retry could duplicate a write without an idempotency key.
- A developer accidentally exposes approval or commit tools to the MCP client.
- A reviewer needs evidence/replay for what was read and proposed.
- A valid JWT session could otherwise execute an environment-bound contract
  under another tenant.
- Concurrent Runners could otherwise create duplicate proposals, lose an
  approval, exceed a process-local rate limit, or duplicate a recovered write.
- A compromised/redirecting JWKS endpoint could supply unexpected key material.
- Metrics, readiness errors, archives, or dead-letter operations could leak
  credentials or high-cardinality business identifiers.

## Fleet Trust Boundaries

- The TLS load balancer and configured identity issuer are trusted to deliver
  the original bearer token without inventing tenant headers.
- A configured JWKS URL is an operator-controlled network trust decision.
  Runner bounds timeout/size/cache/cooldown, refuses redirects, uses `kid`, and
  rejects private JWK fields, but operators must still allowlist the host and
  protect DNS/egress.
- `/healthz` proves only process liveness. `/readyz` reports safe component
  codes and does not authorize traffic by itself.
- `/metrics` uses separate authorization on non-loopback binds. MCP authority
  does not imply metrics authority.
- The shared Postgres role can read/write sensitive review artifacts. Protect
  it like a database credential and restrict it to one ledger schema.
- The bounded runtime-store bridge serializes operations and copies at most
  `max_entries`; capacity exhaustion fails closed.
- Verified reviewer identity proves possession of a registered key or a valid
  asymmetric operator token. `dev_env` is unverified and not production-safe.

## Non-Goals

Runner does not claim to solve:

- prompt injection generally;
- malicious MCP hosts or compromised local machines;
- stolen database credentials;
- bugs in app-owned handler business logic;
- multi-region/high-throughput HA, compliance certification, SOC 2, or SLA;
- IdP compromise, malicious administrator-approved contracts, or compromised
  ledger/source database servers;
- physical branching of external Postgres/MySQL;
- generic safe execution of arbitrary SQL, DDL, INSERT, DELETE, UPSERT, or
  multi-row writes.

## App-Owned Handler Responsibility

For rich writes, Runner POSTs the approved change to your endpoint after
approval. Your handler is the final business-write boundary and must re-check:

- tenant/scope;
- expected row version or conflict guard;
- idempotency key;
- allowed business action;
- transaction/rollback behavior;
- safe error receipts.

Skipping those checks can reintroduce cross-tenant writes, lost updates, or
duplicate writes.

## Disclosure

Report security issues privately to `security@synapsor.ai`. Do not include
production credentials, customer data, full database rows, bearer tokens, or
private keys in reports.
