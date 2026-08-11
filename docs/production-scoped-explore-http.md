# Production Scoped Explore Over HTTP

Production Scoped Explore is an explicit read-only deployment mode for agents
that need to ask different analytical questions inside one reviewed boundary.
It serves exactly two MCP tools:

- `app.describe_data`
- `app.explore_data`

The model receives no raw SQL tool, database credential, unrestricted schema,
activation, approval, apply, Protect, or configuration authority.

This mode is off by default. Normal local and staging Explore keep their
existing stdio and loopback behavior.

## Scope Model

Every production HTTP session must carry a short-lived, asymmetrically signed
JWT. Runner verifies its algorithm, signature, issuer, audience, time bounds,
required OAuth scope, and principal claim on every request. Mixed-tenant
boundaries also require the configured tenant claim. An explicitly reviewed
single-organization boundary fixes the organization outside the JWT instead.

The claims have two distinct jobs:

- For tenant-owned rows, the verified tenant is injected through the reviewed
  direct column or mandatory derived path.
- A reviewer may mark an eligible tenant-independent table **Shared reference**.
  Only that exact table omits a tenant predicate; the tenant still partitions
  production accounting and authentication for the mixed-tenant deployment.
- The verified principal is always the privacy and rate-budget identity.
- When a reviewed table also has a `principal_key`, Runner injects the
  principal as a row predicate and, for PostgreSQL RLS, as the reviewed session
  setting.
- A tenant-wide analytics table may intentionally omit `principal_key`. It is
  still tenant-scoped, while each authenticated principal gets an isolated
  privacy/rate budget. This supports internal tenant-wide BI without pretending
  the table is per-user.

JWT values never become MCP tool arguments. Query strings, arbitrary headers,
MCP metadata, prompts, and model output cannot replace them.

## Reviewed Analytics Parity

Production HTTP uses the same validator, compiler, activated boundary, and
two-tool schemas as local Explore. Reviewed dispersion, missing-data measures,
calendar groupings, named ratios, numeric bands, post-suppression running/lag/
rank/moving-average/share operations, and safe child-count measures therefore
behave identically. Production additionally requires the verified principal,
per-principal and tenant budgets, rate limits, atomic reservations, and secured
transport described below.

Reviewed resource and field labels/descriptions have the same parity. They are
bounded, digest-bound display metadata returned by `app.describe_data`; they do
not change field operations, row scope, suppression, or budgets. Plans still
use exact reviewed IDs. Custom labels are never accepted as plan aliases, and
metadata attached to a kept-out field is omitted from the model-facing HTTP
response. No additional MCP tool or HTTP endpoint is created.

Reviewed automatic numeric bands have the same parity. A model may choose only
an activated field, method, and bounded bucket count; it cannot provide edges,
widths, labels, or formulas. Runner computes boundaries after JWT-derived
tenant/principal predicates are applied, enforces an effective cohort floor of
five, and never returns or audits raw computed edges. Different methods and
bucket counts share the same durable differencing pool. Production adds no
special escape or weaker default for this grammar.

Safe child counts fix one reviewed child resource and one catalog-proven,
non-null many-to-one child-to-parent relationship. The generated SQL is a
correlated subaggregate, never a raw one-to-many join. Runner independently
injects the verified tenant and any reviewed principal predicate into both the
parent query and child subquery, rechecks every participating resource and scope
dependency against the generation lock, and releases only parent cohorts of at
least five. A model cannot provide the child table, key, predicate, or formula.

The 1.7.0 production gates execute the expanded grammar on PostgreSQL 16 and
MySQL 8. These are the documented tested server lines. Fixed post-suppression
operations run in Runner rather than database window SQL, so their behavior is
identical across those engines. No compatibility claim is made here for older
database releases. Automatic quantiles specifically rely on the reviewed
PostgreSQL 16/MySQL 8 `CUME_DIST` implementation; equal-width bands use scoped
`MIN`/`MAX` bounds in the same read-only transaction.

## 1. Create Separate Production Authority

Use the same read-only, non-owner database credential that production Explore
will use. PostgreSQL and MySQL sources are supported.

```bash
export DATABASE_URL='postgresql://readonly_user:...@db.example/app'

synapsor-runner boundary draft \
  --from-env DATABASE_URL \
  --profile production \
  --tenant-claim tenant_id \
  --principal-claim sub \
  --project-root ./synapsor-production-explore

synapsor-runner boundary review \
  --project-root ./synapsor-production-explore
```

Review tables, columns, relationships, tenant scope, optional row-principal
scope, cohort minimums, and per-principal query/extraction/differencing limits.
Activate the exact production boundary through the normal human review action.
A development/staging boundary cannot be promoted by changing a profile field;
production authority is generated and reviewed separately.

For a mixed database, a global catalog or reference table remains blocked until
an operator explicitly reviews it as Shared reference. Runner never infers that
posture, and refuses it when inspection finds tenant columns, a derived path to
tenant-owned rows, or tenant/RLS evidence. The same field, relationship,
principal, cohort, and budget review remains required. Whole-organization
databases should use the separate boundary-wide single-organization mode rather
than marking every table individually.

## 2. Configure The Secured Runtime

The runtime config contains only environment-variable names and fixed identity
metadata. It contains no secret values or database URLs.

Generate the complete zero-authority skeleton instead of hand-authoring it.
Runner reads the reviewed source, engine, database environment name, and claim
names from the production draft. The issuer, MCP audience, and accounting
namespace stay explicit because Runner must not guess deployment identity.

```bash
synapsor-runner config init --production-explore \
  --project-root ./synapsor-production-explore \
  --output ./synapsor.runner.json \
  --issuer https://identity.example \
  --audience https://runner.example/mcp \
  --accounting-namespace acme.analytics.production
```

The generated file includes shared-control-store, JWT/JWKS, secured HTTP,
OAuth, tenant-budget, source-pool, and per-principal session-cap settings. The
expanded example below is the same shape for operators who need to review or
customize it.

```json
{
  "version": 1,
  "mode": "read_only",
  "storage": {
    "shared_postgres": {
      "mode": "runtime_store",
      "url_env": "SYNAPSOR_CONTROL_DATABASE_URL",
      "schema": "synapsor_runner"
    }
  },
  "sources": {
    "local_postgres": {
      "engine": "postgres",
      "read_url_env": "DATABASE_URL",
      "statement_timeout_ms": 3000
    }
  },
  "trusted_context": {
    "provider": "http_claims"
  },
  "session_auth": {
    "provider": "jwt_asymmetric",
    "algorithms": ["RS256"],
    "jwks_url_env": "SYNAPSOR_SESSION_JWKS_URL",
    "issuer": "https://identity.example",
    "audience": "https://runner.example/mcp",
    "tenant_claim": "tenant_id",
    "principal_claim": "sub"
  },
  "http_security": {
    "deployment": "shared",
    "channel": "trusted_tls_proxy",
    "allowed_hosts": ["runner.example"],
    "oauth_resource": {
      "resource": "https://runner.example/mcp",
      "authorization_servers": ["https://identity.example"],
      "scopes_supported": ["synapsor.explore"],
      "required_scopes": ["synapsor.explore"]
    }
  },
  "production_explore": {
    "enabled": true,
    "project_root": "./synapsor-production-explore",
    "required_oauth_scope": "synapsor.explore",
    "budget_hmac_key_env": "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
    "accounting_namespace": "acme.analytics.production",
    "source_max_connections": 8,
    "max_sessions_per_principal": 4,
    "tenant_limits": {
      "max_queries_per_rolling_24_hours": 10000,
      "max_extracted_cells_per_rolling_24_hours": 1000000,
      "max_differencing_queries_per_rolling_24_hours": 2000,
      "requests_per_minute": 1000,
      "max_response_cells_per_response": 500
    }
  }
}
```

The source key must match the source name in the activated boundary. Its engine
and `read_url_env` must exactly match the boundary generation lock.
All active boundaries served by one production Explore process must use that
same reviewed source. Run separate Runner deployments for boundaries backed by
different databases; `doctor` and startup reject a mixed-source deployment.

For `trusted_context.provider = http_claims`, `session_auth.tenant_claim` and
`session_auth.principal_claim` are the authoritative claim names. There is no
second `trusted_context.values` mapping to keep synchronized.

Every MCP session borrows from one process-wide source pool. The optional
`source_max_connections` setting defaults to 8 and caps that pool independently
of session count. Size it well below the application database's connection
allowance and multiply it by the maximum number of Runner replicas when planning
fleet capacity. `max_sessions_per_principal` defaults to 4 and limits concurrent
sessions independently for each verified tenant/principal pair. Unless
`http_security.limits.session_idle_timeout_seconds` is set explicitly,
production Explore reclaims an idle session after 120 seconds.

The shared Postgres control database stores only opaque accounting
fingerprints, reservations, and metadata. Production Explore query evidence is
appended to a dedicated metadata-only table rather than the proposal ledger, so
query volume cannot consume proposal/writeback capacity. Audit events are kept
for seven days. Privacy-release records are retained for the complete rolling
24-hour differencing window and never pruned while they can still defend a
suppressed cohort. The control store must be a separate database from
the application source; it may live on the same PostgreSQL server. Startup and
`doctor` fail closed when a PostgreSQL source and the control ledger name the
same database, or when their separation cannot be attested from the configured
URLs. A MySQL application source still uses Postgres for this concurrency-safe
shared control ledger.

Tenant ceilings remain a deliberate deployment-wide abuse backstop in addition
to per-principal budgets. If a tenant reaches one of those explicit ceilings,
all principals in that tenant are refused until usage leaves the rolling window;
other tenants are unaffected. Size these ceilings above expected legitimate
tenant concurrency while keeping a finite bound on coordinated probing.
`max_response_cells_per_response` is an optional tenant-wide single-response
ceiling. When omitted, each query inherits the selected boundary's reviewed
per-principal response-cell limit. When present, Runner applies the lower of the
tenant and boundary limits, so this setting can tighten but never widen a
response.

Provision secrets through the environment or a secret manager:

```bash
export SYNAPSOR_CONTROL_DATABASE_URL='postgresql://.../synapsor_control'
export SYNAPSOR_SESSION_JWKS_URL='https://identity.example/.well-known/jwks.json'
export SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
```

The HMAC key must contain at least 32 bytes of randomly generated material. A
base64url encoding of 32 random bytes is about 43 characters; a 32-character
hex string contains only 16 bytes and is rejected. Every replica must receive
the same value through a secret manager or protected environment.

Every Runner replica for this deployment must use the same control database,
control schema, accounting namespace, and HMAC key. Rotating the HMAC key starts
a new opaque accounting namespace and therefore requires an operator-planned
privacy-budget transition; do not rotate it as an ordinary stateless secret.

## 3. Attest And Serve

Initialize the separate control ledger once with the same schema named in the
runtime config:

```bash
synapsor-runner store shared-postgres apply-migration \
  --url-env SYNAPSOR_CONTROL_DATABASE_URL \
  --schema synapsor_runner \
  --yes

synapsor-runner doctor \
  --config ./synapsor.runner.json \
  --transport streamable-http \
  --host 0.0.0.0 \
  --trusted-tls-proxy

synapsor-runner mcp serve \
  --transport streamable-http \
  --production-explore \
  --host 0.0.0.0 \
  --trusted-tls-proxy \
  --config ./synapsor.runner.json
```

Use Runner-owned TLS flags instead of `--trusted-tls-proxy` when Runner
terminates TLS itself. Production Explore refuses static endpoint-token flags,
`--dev-no-auth`, and cleartext break glass. It also uses fixed canonical tool
names (`app.describe_data` and `app.explore_data`) and one fixed reviewed result
envelope. Presentation flags such as `--alias-mode`, `--tool-name-style`,
`--openai-tool-aliases`, and `--result-format` are rejected rather than silently
ignored.

Startup and `doctor` fail closed unless all of these hold:

- explicit `production_explore.enabled` opt-in;
- asymmetric JWT identity with exact issuer, audience, tenant, and principal;
- the required OAuth scope;
- direct TLS or an explicitly trusted TLS proxy;
- shared Postgres runtime-store accounting;
- a PostgreSQL control database distinct from every application source
  database;
- shared HMAC material of at least 32 bytes;
- at least one active, exact-digest production boundary;
- exactly one reviewed source across all active boundaries in this deployment;
- matching boundary/runtime claim names and source lock;
- current schema, generation lock, read-only role, grants, ownership, and RLS
  posture;
- the exact two-tool model surface.

The startup report names every passing, warning, and failing prerequisite in
one run, plus environment-variable names and reviewed boundaries. It never
prints secret values or database URLs. `mcp serve --production-explore` prints
the same complete report when startup is refused, so an operator does not need
one restart per missing prerequisite.

## Privacy And Concurrency

Runner reserves query, rate, extracted-cell, and differencing allowance before
executing a source query. PostgreSQL transaction advisory locks serialize the
read-check-reserve operation for both the authenticated principal and tenant.
Two concurrent requests cannot both consume the final unit.

The boundary's per-principal query/rate limits are throughput controls. New
1.7.0 boundaries default to 1,000 queries per rolling 24 hours and 120 requests
per rolling minute. Production `tenant_limits` add a separately configured
tenant-wide ceiling. Extracted cells, differencing variants, minimum cohorts,
suppression, and response bounds are disclosure controls; increasing throughput
does not increase any of them. An exhaustion response identifies the exact
class, used/limit values, and rolling-window expiry upper bound. Remaining
counters are operator metadata and are never included in the model projection.

Per-principal accounting prevents one user from starving another. Tenant-wide
ceilings and tenant-level complementary-release accounting prevent many
principals from bypassing limits or reconstructing a suppressed cohort by
collusion. Minimum-cohort suppression, group caps, complexity limits, response
limits, timeouts, and the suppression-aware total defense are unchanged.

Failed or refused attempts consume query and rate allowance. Only released
cells consume extracted-cell allowance. Stranded reservations remain a
conservative charge until they age out of the rolling window.

Each HTTP query also performs a fresh generation-lock check. Current locks ask
the schema inspector for only the reviewed authority dependencies needed by the
boundary, including relationship and derived-scope proof resources. Runner
still runs dedicated global credential/read-only/grant/ownership checks and
re-proves RLS on every reviewed dependency. For an explicit
single-organization boundary it additionally runs the global tenant/RLS-evidence
refusal check. This is not an authority cache: a reviewed column, FK, RLS, or
grant change is observed on the next request and fails closed. Whole-schema
inspection remains the draft/rescan discovery path.

## Operational Boundaries

- Production Explore is read-only and cannot be turned into write authority.
- Remote Explore results do not create local Protect tokens. An operator can
  separately reproduce and Protect an analysis in the local authoring register.
- Returned database text remains untrusted data.
- Ordinary evidence stores normalized metadata and opaque fingerprints, not
  result rows, credentials, trusted claim values, compiled SQL, or SQL
  parameters.
- The application source executes only parameterized, validated reads in a
  read-only transaction. Use a separate control database so accounting writes
  do not touch the application source database.

Use protected named capabilities instead when the production question shape is
fixed and should have narrower, deterministic authority. Production Explore is
for genuinely ad-hoc questions inside an already reviewed boundary.

## Verification

From a source checkout, the two hermetic engine gates start disposable source
and control databases, generate an in-memory RS256 keypair, mint real JWTs,
start the public Streamable HTTP command on a random loopback port, and clean up
all state afterward:

```bash
corepack pnpm test:production-explore:http
corepack pnpm test:production-explore:mysql-http
```

When Ollama is already installed and running, opt into the external-agent path
without changing the ordinary CI gate:

```bash
SYNAPSOR_TEST_OLLAMA_MODEL='qwen2.5:7b' \
  corepack pnpm test:production-explore:http
```

`SYNAPSOR_TEST_OLLAMA_BASE_URL` may override the default loopback URL
`http://127.0.0.1:11434/v1`. The verifier uses a dedicated principal, sends the
model only the two production tools, and asserts that its accepted plan contains
no model-supplied tenant or principal. No bearer token, private key, database
URL, or model response is written into generated authority artifacts.
