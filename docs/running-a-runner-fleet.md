# Running A Small Runner Fleet

Synapsor Runner supports a bounded small-fleet deployment. It does not
turn the OSS package into Synapsor Cloud and it does not promise an unbounded,
multi-region, or SLA-backed control plane.

```text
TLS load balancer
  -> N stateless Streamable HTTP Runners
       -> shared Postgres runtime ledger
       -> bounded Postgres/MySQL source pools
  -> supervised writeback workers
       -> restricted source writer or app-owned executor
```

The model still receives only reviewed semantic tools. Approval, apply,
operator credentials, database credentials, and shared-ledger authority remain
outside MCP.

## Audit Before Deployment

Audit the model-facing surface before connecting a production-like database:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
synapsor-runner audit ./tools-list.json
synapsor-runner audit https://mcp.example.com --bearer-env MCP_AUDIT_TOKEN
```

Treat generic SQL/query tools, model-controlled tenant/principal inputs, and
model-facing approval/apply tools as blockers. Audit is a static review, not a
security proof; follow it with `tools preview`, `doctor`, and the live fleet
verification.

## What The Bounded Fleet Guarantees

With `storage.shared_postgres.mode = "runtime_store"`:

- each mutation holds one schema-scoped Postgres advisory lock;
- concurrent schema migration is serialized under that lock;
- two instances cannot create two active proposals for the same canonical
  tenant/capability/object tuple;
- distinct verified reviewers append decisions without losing one another;
- one worker claim/effect completes, conflicts, retries, or enters dead letter;
- direct SQL and app-owned handler retries use durable source-side receipts;
- fixed-window rate limits are atomic across instances and keyed from verified
  tenant context plus reviewed capability;
- CLI and local UI review reads use the same shared queue as MCP serving.

The current implementation restores the shared ledger into a transient SQLite
store while holding the advisory lock, performs one bounded operation, then
syncs the result. `max_entries` defaults to 10,000 and may be set from 100 to
100,000. Runner fails closed with `POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED`
rather than copying an unbounded ledger. This serialized design is appropriate
for a small self-hosted fleet, not high-throughput horizontal scale.

## Verified Local Topology

The repository includes a synthetic Compose fixture:

```bash
docker compose --profile fleet \
  -f examples/runner-fleet/docker-compose.yml up --build -d --wait
```

The stronger verification command is:

```bash
corepack pnpm test:fleet
```

Prerequisites: Node 22, pnpm through Corepack, Docker Engine, and Docker
Compose. It needs no AWS, Cloud account, external identity provider, or
internet service after container images and dependencies are available.

Latest verified result: **2026-07-12 (America/Los_Angeles), PASS**. Assertions:

```text
two claim-bound Runners share one bounded Postgres ledger
cross-tenant reads are denied
one active proposal survives concurrent creation
rate limits hold across instances
two verified reviewers satisfy a 2-person quorum
apply is blocked at 1/2 and succeeds at 2/2
simultaneous reviewer processes preserve both decisions
two competing workers create exactly one source effect
worker termination before write recovers without an effect
worker termination during an open write transaction rolls back and recovers
worker termination after commit recovers as already-applied
source-down, read-only-ledger, and timeout readiness failures recover without restart
shared dead letters requeue or discard with receipts and events preserved
Postgres and MySQL pool queues fail fast at configured bounds with retry hints
shared runtime-store batch apply preserves one authoritative bridge and durable receipts
backup digest and clean restore match
retention archives before delete and preserves active proposals
```

All source rows, identities, keys, tokens, and credentials are synthetic. The
test tears down its volumes.

## Claim-Bound Sessions

Use asymmetric verification for a networked fleet:

```json
{
  "trusted_context": {
    "provider": "http_claims",
    "values": {
      "tenant_id_key": "tenant_id",
      "principal_key": "sub"
    }
  },
  "session_auth": {
    "provider": "jwt_asymmetric",
    "algorithms": ["RS256"],
    "jwks_url_env": "SYNAPSOR_SESSION_JWKS_URL",
    "issuer": "https://identity.example",
    "audience": "https://runner.example/mcp",
    "tenant_claim": "tenant_id",
    "principal_claim": "sub",
    "clock_skew_seconds": 30,
    "jwks_cache_seconds": 600,
    "jwks_cooldown_seconds": 30,
    "fetch_timeout_ms": 3000,
    "max_response_bytes": 1048576
  },
  "http_security": {
    "deployment": "shared",
    "channel": "trusted_tls_proxy",
    "oauth_resource": {
      "resource": "https://runner.example/mcp",
      "authorization_servers": ["https://identity.example"],
      "scopes_supported": ["synapsor:mcp"],
      "required_scopes": ["synapsor:mcp"]
    },
    "allowed_hosts": ["runner.example"],
    "allowed_origins": ["https://agent-console.example"]
  }
}
```

The external identity provider issues the short-lived client JWT for resource
`https://runner.example/mcp`; Runner only verifies it. The load balancer must
terminate TLS and prevent direct access to the private Runner listeners. If
Runner owns TLS instead, use protected certificate/key env references and set
`channel` to `direct_tls`.

Every served capability context must bind tenant and principal from
`HTTP_CLAIM`. Runner rejects an environment-bound contract mixed into this
server with `TRUSTED_CONTEXT_PROVIDER_CONFLICT` before tools are served.

For same-tenant per-user rows, declare `PRINCIPAL SCOPE KEY assigned_to` (or
the corresponding canonical `principal_scope_key`) on the capability. The
signed `sub` claim then becomes a bound SQL predicate composed with the signed
tenant claim. Session token fingerprint pinning prevents swapping identities
within an MCP session. `tools preview` displays both locks, and
`corepack pnpm test:principal-scope` proves two concurrent principals cannot
read each other's rows or evidence handles on Postgres and MySQL.

Use an HTTPS JWKS URL from an allowlisted identity system. Runner rejects
redirects, oversized responses, unknown algorithms, `none`, missing/unknown
`kid`, bad issuer/audience, expired/not-yet-valid tokens, and private JWK
material. Unknown `kid` triggers at most one controlled refresh. For offline
deployments, configure one public PEM through `public_key_env` or
`public_key_path`; never place a private key in Runner config.

Runner publishes RFC 9728 protected-resource metadata at the path derived from
the public resource and returns scope-aware Bearer challenges. The identity
provider, not Runner, owns user login, client registration, token issuance, and
refresh. An MCP session ID is only protocol state; every request is
reauthenticated and remains pinned to the initialized credential identity.

## Ledger And Source Pools

```json
{
  "storage": {
    "shared_postgres": {
      "mode": "runtime_store",
      "url_env": "SYNAPSOR_LEDGER_DATABASE_URL",
      "schema": "synapsor_runner",
      "lock_timeout_ms": 5000,
      "max_entries": 10000
    }
  },
  "sources": {
    "app_postgres": {
      "engine": "postgres",
      "read_url_env": "APP_POSTGRES_READ_URL",
      "write_url_env": "APP_POSTGRES_WRITE_URL",
      "statement_timeout_ms": 3000,
      "pool": {
        "max_connections": 4,
        "connection_timeout_ms": 2000,
        "idle_timeout_ms": 30000,
        "queue_timeout_ms": 1000,
        "queue_limit": 16
      }
    }
  }
}
```

Budget database connections across every replica and worker:

```text
replicas * sum(source max_connections) + readiness/admin headroom
```

Keep that below database role and instance limits. Queue overflow fails with
`SOURCE_POOL_QUEUE_FULL`; acquisition timeout fails with
`SOURCE_POOL_TIMEOUT`. Neither waits indefinitely or creates a proposal.

Use separate roles:

- source reader: `CONNECT`, schema `USAGE`, and `SELECT` only on reviewed
  tables/views;
- direct writer: reviewed column-level `UPDATE` plus source receipt-table
  `SELECT/INSERT/UPDATE`;
- ledger role: only the configured ledger schema and migration rights;
- migration administrator: run migrations separately when Runner should not
  own DDL authority.

## Fleet-Wide Rate Limits

```json
{
  "rate_limits": {
    "enabled": true,
    "default": { "requests": 60, "window_seconds": 60 },
    "capabilities": {
      "billing.propose_refund": { "requests": 10, "window_seconds": 60 }
    }
  }
}
```

Semantics are fixed-window, keyed by a hash of verified tenant ID and
capability. There is no separate burst allowance: a tenant may consume the
entire configured count immediately, then must wait for the aligned window to
reset. In local SQLite mode limits are process-local. In `runtime_store` mode
they use an atomic shared Postgres bucket. Rejection returns `RATE_LIMITED` and
`retry_after_ms` to the reset boundary, increments a metric, and creates no
proposal.

## Probes And Metrics

- `GET /healthz`: unauthenticated cheap process liveness; no dependency
  checks or configuration inventory.
- `GET /readyz`: 200 only when catalog, required sources, authoritative ledger,
  and required writeback/executor dependencies are ready; otherwise 503.
- `GET /metrics`: disabled unless configured. A non-loopback bind requires a
  separate metrics bearer token.

```json
{
  "metrics": {
    "enabled": true,
    "token_env": "SYNAPSOR_METRICS_TOKEN"
  }
}
```

Do not use the model-facing MCP token as the metrics token. Metrics include
controlled tenant/capability/source/component labels, never object IDs,
principals, database URLs, tokens, or raw errors.

## Reviewers, Quorum, And Workers

Use `signed_key` or `jwt_oidc` operator identity. `dev_env` is explicitly
unverified and is only for local fixtures. A capability may require multiple
distinct reviewers in the canonical contract:

```sql
APPROVAL REQUIRED ROLE billing_lead
REQUIRE 2 APPROVALS
```

The same verified subject cannot fill two slots. Policy auto-approval does not
satisfy a multi-human quorum. Apply and workers reject the proposal until
progress reaches `N/N`. A rejection is terminal and auditable.

Use the shared queue explicitly:

```bash
synapsor-runner proposals list --config ./synapsor.runner.json
synapsor-runner proposals show latest --config ./synapsor.runner.json
synapsor-runner ui --config ./synapsor.runner.json
synapsor-runner worker run --yes --config ./synapsor.runner.json
```

Dead-letter operations require verified operator identity:

```bash
synapsor-runner worker dead-letter list --config ./synapsor.runner.json
synapsor-runner worker dead-letter show wrp_... --config ./synapsor.runner.json
synapsor-runner worker dead-letter requeue wrp_... --retry-budget 3 --yes \
  --config ./synapsor.runner.json --identity alice --identity-key /secure/alice.pem
synapsor-runner worker dead-letter discard wrp_... --reason "closed" --yes \
  --config ./synapsor.runner.json --identity alice --identity-key /secure/alice.pem
```

Requeue preserves history and refuses if a durable applied/already-applied
receipt already proves the effect. Discard closes the queue item without
deleting proposals, receipts, or events.

## Backup, Restore, And Retention

```bash
synapsor-runner store shared-postgres backup \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner \
  --output ./ledger-backup.json
synapsor-runner store shared-postgres verify-backup --input ./ledger-backup.json
synapsor-runner store shared-postgres restore-backup \
  --input ./ledger-backup.json --url-env SYNAPSOR_LEDGER_DATABASE_URL \
  --schema synapsor_runner_restore --yes
```

Restore only accepts an empty target schema and verifies the post-restore
manifest digest. Store archives as sensitive database extracts with owner-only
permissions.

Retention is archive-before-delete:

```bash
synapsor-runner store shared-postgres retention --older-than 30d \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --dry-run
synapsor-runner store shared-postgres retention --older-than 30d \
  --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner \
  --output ./ledger-archive.json --yes
```

The archive is written and digest-verified before deletion. Pending review,
approved, pending-worker, retry, failed, and dead-letter records are retained.
The operation appends an immutable retention event.

Restore runbook:

1. Stop ingress and workers.
2. Verify the backup digest.
3. Restore into a clean schema.
4. Run `store shared-postgres status` and `/readyz` against the restore.
5. Inspect at least one proposal, receipt, and replay through CLI.
6. Point one canary Runner at the restored schema.
7. Resume ingress, then workers, and watch readiness/dead-letter metrics.

## Shutdown, Rotation, And Upgrades

Terminate with `SIGTERM`; Runner stops accepting work, closes HTTP sessions and
source pools, and releases ledger locks. Give workers enough grace for the
configured handler timeout. A hard kill is recoverable through leases and
source-side idempotency receipts, but should remain an incident signal.

Rotate JWKS keys by publishing the new `kid`, waiting at least the configured
cache lifetime while issuers sign with the new key, then retiring the old key.
Do not casually change the issuer or protected-resource audience during a key
rotation. Rotate TLS/mTLS, metrics, handler, database, and ledger credentials
independently through their named environment variables.

Only homogeneous Runner instances at the release under test are verified by
`test:fleet`. Mixed-version operation is not claimed. For rolling upgrades:

1. back up and verify the ledger;
2. run schema/config validation with the target version;
3. drain one worker and remove one Runner from the load balancer;
4. upgrade one canary, verify `/readyz`, MCP tools, proposal inspection, and
   metrics;
5. continue one instance at a time;
6. upgrade workers after HTTP Runners.

Rollback the binary only while contracts/config remain accepted by the prior
minor. If the prior version does not understand a new canonical field or
ledger entry, restore the verified pre-upgrade backup into a clean schema and
roll back the full fleet. Never mix versions merely because both are `1.x`.

## TLS Boundary

Terminate public TLS or mTLS at a trusted load balancer and declare
`channel: trusted_tls_proxy`, or configure Runner's tested TLS/mTLS options
directly. A proxy declaration is a security assertion: firewall the private
listener so clients cannot bypass the proxy, protect the private hop, and
preserve an allowed Host. Keep Runner-to-database TLS verification on, use
private networking where possible, and restrict `/metrics` separately. The
verified Bearer JWT itself, not a proxy-added tenant/principal header, is the
session authority. See [HTTP MCP](http-mcp.md) for channel flags, limits, and
doctor checks.
