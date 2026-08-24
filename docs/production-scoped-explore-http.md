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

## Production Prerequisites

Prepare these components before drafting production authority. Runner reports
all of them together through `doctor --preflight`; it does not provision them.

| Component | What it must provide | Why Runner needs it |
| --- | --- | --- |
| Application source | A [supported PostgreSQL/MySQL source](database-server-compatibility.md) and a read-only, non-owner credential | PostgreSQL 13-18 and MySQL 8.0.16+ expose the complete reviewed grammar; MySQL 8.0.11-8.0.15 and 5.7 expose documented limited tiers. Runner never uses the control-store writer against this source. |
| Control store | A separate PostgreSQL database and a role allowed to run the fixed Synapsor migration and write accounting records | Production budgets and audit evidence must be atomic across processes and replicas. A MySQL source still requires this PostgreSQL control store; there is no shared-MySQL control store. |
| Identity provider (IdP) | An OAuth authorization server that issues asymmetrically signed JWT access tokens | It authenticates people, issues and refreshes tokens, and publishes signing keys. |
| HTTPS boundary | Direct TLS at Runner or an explicitly trusted TLS-terminating proxy | Bearer tokens must not cross an unprotected network channel. |
| Secret delivery | Environment variables or a secret manager for source/control URLs, JWKS URL or public key, and the accounting HMAC key | Config files contain names and public identity metadata, never secret values. |

The recommended order is: generate the zero-authority runtime config, provision
and migrate the control store, run preflight, draft/review/activate a separate
production boundary, rerun preflight, serve, then connect an OAuth-capable MCP
client. A failed preflight changes no authority.

## OAuth First: Who Does What

Runner is an OAuth **resource server**. It protects the MCP resource and verifies
access tokens; it is not an authorization server and never accepts a user
password, opens a login screen, issues a token, or refreshes one.

| Participant | Responsibility |
| --- | --- |
| Identity provider / authorization server | Authenticates the user, obtains consent when applicable, issues short-lived access tokens and refreshes them, and publishes public signing keys. |
| MCP client | Discovers the authorization server, completes the OAuth flow, stores the token securely, refreshes it, and sends it in the HTTP `Authorization: Bearer ...` header. |
| Synapsor Runner | Publishes protected-resource metadata, challenges unauthenticated requests, verifies each token, binds reviewed tenant/principal claims outside model input, enforces the boundary, and returns only bounded results. |
| Model | Chooses between `app.describe_data` and `app.explore_data` and supplies only the reviewed plan grammar. It never receives token, tenant, principal, credential, or SQL authority. |

An OAuth-capable MCP client follows this standards path:

1. It calls the MCP endpoint without a usable access token.
2. Runner returns `401` with `WWW-Authenticate` and exposes RFC 9728 protected-
   resource metadata at `/.well-known/oauth-protected-resource/mcp`.
3. The metadata names the exact resource, authorization server, and required
   scope. The client completes the authorization flow with that server.
4. The IdP issues a short-lived JWT access token. The client presents it to
   Runner and refreshes it through the IdP when needed.
5. Runner verifies algorithm, signature, `iss`, `aud`, expiry/not-before, scope,
   tenant claim, and principal claim on every session/request path before a data
   plan can execute.

No human copies a JWT in this primary path. Client support varies, so verify the
client's OAuth discovery and refresh behavior. The environment-token client
configuration later in this guide is a bounded manual/testing fallback for
clients that cannot yet complete discovery; it is not a token lifecycle service.

### Token contract and claim mapping

The access token must satisfy this exact contract:

- `iss` equals `session_auth.issuer` exactly.
- `aud` contains or equals `session_auth.audience`, which should be the same MCP
  resource URL as `http_security.oauth_resource.resource`.
- The granted scopes contain every value in
  `http_security.oauth_resource.required_scopes`.
- A multi-tenant deployment includes the exact safe claim named by
  `session_auth.tenant_claim`, such as `tenant_id` or `organization_id`.
- It includes the exact claim named by `session_auth.principal_claim`; `sub` is
  the normal stable user identity.
- Signing uses an allowed asymmetric algorithm such as `RS256`; symmetric
  secrets and unsigned tokens are rejected.

Most IdPs do not emit a tenant claim by default. Map a stable directory or
organization attribute to the exact configured claim name. Do not use a display
name, mutable email address, client-provided header, or model argument as tenant
identity. If the deployment genuinely contains one organization, use
`production_explore.single_organization_id` and omit the tenant claim; the
principal claim remains required.

For **Okta**, create or use a custom authorization server, set its audience to
the Runner resource URL, define the `synapsor.explore` scope, and add a token
claim such as `tenant_id` sourced from a stable user/application profile
attribute. Grant that scope in the access policy. Keep `principal_claim: sub`
unless a different stable subject claim is deliberately reviewed.

For **Keycloak**, configure the client audience mapper with the exact Runner
resource URL, create a client scope for `synapsor.explore`, and add an OIDC token
mapper that emits a stable organization attribute as `tenant_id`. Use Keycloak's
issuer and realm JWKS endpoint and keep `sub` as the principal unless the
deployment has a reviewed alternative.

The generated config uses `session_auth.jwks_url_env`. Runner fetches public
keys from that URL and can follow ordinary IdP key rotation by JWT `kid`; the
JWKS cache duration controls how quickly a new key is observed. Static
`public_key_env` or `public_key_path` is also supported instead, but exactly one
key source may be configured and static-key rotation requires coordinated
secret replacement/restart. A JWKS URL is therefore the normal production
choice. Runner never needs or accepts the IdP private signing key.

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

That parity includes vocabulary diagnostics and field-level grammar. The
compact `app.describe_data` index returns exact IDs, reviewed labels and
descriptions, semantic status, resource operation allowlists, coverage counts,
and the instruction that plans use exact IDs. A focused call for one exact
resource adds each field's legal operations, bounded enum values, and reviewed
relationship grammar. `next_cursor` is accompanied by explicit guidance to page
until a matching resource is found or the catalog ends, so an added table or
boundary does not disappear merely because it falls after the first compact
page. Clearly placeholder-like model-facing IDs require a reviewed label or
description before a new boundary revision can activate; legacy active
authority is warned by `doctor` until reconciled. These rules are identical over
local stdio and secured HTTP and do not depend on JWT claims, host locale, or
source engine.

Short schema-proven code domains such as `P1 | P2 | P3` are reported separately
as `semantic_status: "coded_values"` and coverage `status: "review_advised"`.
They do not block activation or change field authority, but the HTTP client is
explicitly told not to infer their business meaning from the code or abbreviated
column name. A reviewed field label or description changes the status to
`reviewed_vocabulary`. This diagnostic is generated by the same canonical code
used by the CLI, Workbench, and local stdio catalog.

Reviewed automatic numeric bands have the same parity. A model may choose only
an activated field, method, and bounded bucket count; it cannot provide edges,
widths, labels, or formulas. Runner computes boundaries after JWT-derived
tenant/principal predicates are applied, enforces an effective cohort floor of
five, and never returns or audits raw computed edges. Different methods and
bucket counts share the same durable differencing pool. Production adds no
special escape or weaker default for this grammar.

Reviewed exact scalar dimensions have the same parity as well. They remain
absent by default and appear in `app.describe_data` only after a human enables
one eligible field and activates the new digest. Production HTTP accepts the
same ordinary field dimension used by local stdio; it adds no runtime override.
JWT-derived tenant/principal predicates, cohort suppression, group/top-N and
response ceilings, timeout, rolling budgets, extraction, and differencing
controls are unchanged. The grant never creates a numeric band or datatype cast
and cannot be applied to identity, reference, trusted-scope, sensitive, binary,
structural, or otherwise unavailable fields.

Safe child counts fix one reviewed child resource and one catalog-proven,
non-null many-to-one child-to-parent relationship. The generated SQL is a
correlated subaggregate, never a raw one-to-many join. Runner independently
injects the verified tenant and any reviewed principal predicate into both the
parent query and child subquery, rechecks every participating resource and scope
dependency against the generation lock, and releases only parent cohorts of at
least five. A model cannot provide the child table, key, predicate, or formula.

Production HTTP reads the same database capability profile stored in the
boundary lock as local stdio. PostgreSQL 13-18 and MySQL 8.0.16+ expose the
complete reviewed grammar. MySQL 8.0.11-8.0.15 remains usable with
`CHECK`-derived categorical vocabularies omitted; MySQL 5.7 also omits automatic
bands before tool discovery. Native
`ENUM`, fixed bands, dispersion, relative time, and Runner-side
post-suppression operations remain available. The 1.7.0 gate exercises real
RS256-authenticated production HTTP against PostgreSQL 13.23 and MySQL 5.7.44,
in addition to the current-engine production suites. See
[Database Server Compatibility](database-server-compatibility.md) for the full
matrix and server-change reconciliation rules.

## 1. Configure The Secured Runtime

The runtime config contains only environment-variable names and fixed identity
metadata. It contains no secret values or database URLs.

Generate the complete zero-authority skeleton instead of hand-authoring it.
This recommended config-first form supplies source and claim names explicitly;
it can run before a boundary exists. The issuer, MCP audience, and accounting
namespace stay explicit because Runner must not guess deployment identity.

```bash
mkdir -p ./synapsor-production-explore

synapsor-runner config init --production-explore \
  --project-root ./synapsor-production-explore \
  --output ./synapsor-production-explore/synapsor.runner.json \
  --engine postgres \
  --source local_postgres \
  --read-url-env DATABASE_URL \
  --tenant-claim tenant_id \
  --principal-claim sub \
  --tenant-binding tenant_id \
  --principal-binding rep \
  --issuer https://identity.example \
  --audience https://runner.example/mcp \
  --accounting-namespace acme.analytics.production
```

If a production draft already exists, `config init --production-explore` can
reuse its engine, source, read-credential environment name, exact claim names,
and reviewed tenant/principal column bindings. The config-first path avoids the chicken-and-egg failure where an
environment-bound local config is discovered while requesting a production
HTTP-claims draft.

Without an existing production draft, `--engine postgres|mysql` is required.
Runner deliberately does not infer it from `DATABASE_URL`: doing so would read
a credential value merely to decide which config to write and could silently
scaffold the wrong dialect when the variable is unavailable.

When a direct tenant or principal binding is configured and the named source
environment variable is already set, `config init` performs a read-only schema
inspection. A missing, nullable, or large/binary binding produces an actionable
warning naming `--tenant-binding` or `--principal-binding`; the zero-authority
config is still written. Add `--verify-bindings` to require a reachable source
and make any such warning fail before writing the file. If the source variable
is unset and `--verify-bindings` was not requested, offline/CI generation skips
the check silently. Inspection reads the URL only to connect and never writes or
prints it; it reads metadata, not source rows. This behavior is identical for
PostgreSQL and MySQL.

For a multi-tenant MySQL source, name the tenant column up front because MySQL
does not expose PostgreSQL RLS policy metadata that could prove it. Add
`--tenant-binding tenant_id` to the command above, changing `tenant_id` to the
exact non-null tenant column in your schema. Add
`--principal-binding attending` when rows also need a reviewed principal
predicate. Runner records these as review inputs; it does not activate them or
let the model supply either value. Omitting `--tenant-binding` for multi-tenant
MySQL fails during config generation instead of producing a boundary-authoring
dead end. Single-organization MySQL does not need a tenant binding.

If a production MySQL draft predates these bindings, `config init` writes the
new config but does not pretend the old draft reviewed it. Its next action is an
exact `boundary rescan` command. Reconcile, review, and activate that disabled
revision before running production preflight; unchanged curated policy is
preserved by the reconciliation path.

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
    "provider": "http_claims",
    "tenant_binding": "tenant_id",
    "principal_binding": "rep"
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

The shared Postgres control database stores opaque accounting fingerprints,
reservations, and bounded audit metadata. New query records include the
parameterized SQL statement shape and parameter types, but never parameter
values, trusted claim values, credentials, URLs, or result rows. Production Explore query evidence is
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

### Inspect production Explore evidence

Production HTTP evidence and query audit live in that shared PostgreSQL control
store, not in the project's development SQLite file. Pass the reviewed config
to the ordinary operator commands; Runner selects the shared store
transparently and prints the ledger source and schema it consulted:

```bash
synapsor-runner evidence list \
  --config ./synapsor-production-explore/synapsor.runner.json
synapsor-runner evidence browse --since 24h \
  --config ./synapsor-production-explore/synapsor.runner.json
synapsor-runner evidence show <evidence-id> --details \
  --config ./synapsor-production-explore/synapsor.runner.json
synapsor-runner query-audit list --principal analyst@example.org \
  --resource public.orders --outcome refused --since 24h \
  --config ./synapsor-production-explore/synapsor.runner.json
synapsor-runner query-audit browse --since 24h \
  --config ./synapsor-production-explore/synapsor.runner.json
synapsor-runner query-audit show <audit-id> --details \
  --config ./synapsor-production-explore/synapsor.runner.json
```

The list filters accept plaintext or keyed tenant/principal identity,
resource, boundary digest, capability, outcome, metadata search, and time range
against both local SQLite and shared PostgreSQL. `--since` accepts an ISO
timestamp or a duration such as `24h`; `--limit` defaults to 20 and is capped at
200. `--search` searches only stored, redacted audit metadata and normalized
plan identifiers. `--json` is suitable for automation. `evidence browse` is a
stateful terminal audit session with ten records per page by default,
Up/Down selection, Enter to open, Esc to return, continuous record numbers,
next/back/page controls, and timestamp jumps. `/` opens free-text search over
persisted plan fields and audit identifiers. `F` opens structured tenant,
principal, resource, capability, boundary, outcome, and time filters. `C`
visibly clears every active filter and returns to the newest page.
The browser uses a dedicated terminal screen, so paging, searching, opening a
record, and returning to the list redraw in place instead of growing terminal
scrollback. Search covers the redacted normalized-plan fields used to build the
English description, evidence/audit IDs, resource/source IDs, capability, and
query fingerprint. It does not search original question text because that text
is not stored. A zero-result view repeats the search term and those fields;
`text` in older `/text` examples is treated as a placeholder rather than silently
becoming part of the query. Selecting a record opens a compact summary;
authority details, operator SQL, and normalized JSON plan are expanded
and scrolled separately. The original model or
user wording is not persisted, so lists show a deterministic plain-English
description reconstructed from the reviewed plan rather than pretending to
quote the original request. `--follow --json` emits newline-delimited JSON for
a live metadata feed.

Non-interactive `evidence list --search <text>` and
`query-audit list --search <text>` print the same term, searched-field scope,
and original-question retention warning when no text result matches. Their JSON
shape remains unchanged for automation.

Pre-execution refusals are query-audit records, not evidence bundles. When a
refusal identifies a resource, field, and operation already present in the
activated boundary metadata, Runner stores those identifiers as
`attempted_access` and attributes `table_name` to that resource. This makes
`query-audit list --resource <schema.table> --outcome refused` useful without
persisting the rejected value, original request text, or an identifier invented
outside the boundary. Unknown client-authored names remain represented only by
the keyed request-shape fingerprint.

The Workbench Query history view uses the same shared-ledger filters and
plan-derived descriptions. Its Newer records and Older records controls page
through the production audit ledger without loading or rendering the complete
history. Workbench remains a preview authoring surface; the CLI is the preferred
operator surface for exhaustive audit review and machine-readable exports.
Plaintext scope filters are HMACed locally and are never echoed or persisted.
Existing `keyed:<HMAC>` values remain accepted. Records created before keyed
principal metadata was introduced cannot be attributed retroactively because
they only recorded whether principal scope was active.

Plaintext production filters fail closed when the configured accounting HMAC
environment variable is unavailable or too short. Runner exits non-zero before
printing any ledger records; it never degrades a tenant filter to an unfiltered
list or presents a missing-key principal lookup as an empty match. Supply the
configured key or use an already-known `keyed:<HMAC>` fingerprint. When a valid
principal lookup is empty, the output distinguishes no matching current
fingerprint from otherwise-matching legacy records that cannot be attributed.

`evidence show --details` and `query-audit show --details` group identity,
authority, outcome/privacy, and execution metadata. In a color terminal,
successful outcomes are green, refusals are red, warnings are yellow, and
reference labels are dimmed; pipes and `NO_COLOR` receive plain text. For new
records, the detail view renders the **captured parameterized source SQL** that
Runner handed to the driver, including the exact reviewed JOIN and scope shape.
Driver placeholders and parameter types remain; parameter values are absent.
Legacy records instead show an explicitly labelled non-executable template
reconstructed from the keyed plan and scope metadata.

The compatibility field `raw_sql_included: false` continues to mean that no
literal-bearing SQL or parameter values were recorded. New records separately
set `parameterized_sql_included: true` and
`parameter_values_persisted: false`.

These commands open
a bounded read-only PostgreSQL snapshot and do not take the serving writer's
advisory lock. They never print the control URL, credentials, raw tenant or
principal claims, source rows, result values, or SQL parameter values. Operator
detail and exports may print the value-free parameterized SQL statement. If the
control store is unavailable, the error names only the configured environment
variable and schema and never falls back to unrelated local data.

Successful shared-ledger hydration is intentionally quiet because the human
`Ledger:` line already identifies the consulted store. Add `--debug` (or set
`SYNAPSOR_VERBOSE=1`) when the structured `shared_runtime_store_read` event is
needed for diagnostics; failures are always logged.

Internally, Runner materializes that bounded snapshot into a private temporary
SQLite view and runs the same typed ledger readers and redaction rules used by
local operator commands. On Linux it prefers a private `/dev/shm` directory
when at least 256 MiB is available, otherwise it uses the operating system's
temporary directory. The bridge is mode `0700`, is removed after the command,
and is never authoritative: production PostgreSQL remains the only source of
truth and no read command syncs data back.

Workbench evidence and audit views use the same store-selection and filtering
path and display the selected ledger source. This is important for a MySQL
application source as well: production MySQL Explore still requires a separate
PostgreSQL control database because there is no shared-MySQL accounting store.

Evidence and query audit begin only after a request passes the MCP tool's strict
argument schema and Runner has established the exact reviewed boundary and trusted
scope needed to enter the Explore handler. Every successful source
execution has one evidence bundle with its normalized query-audit record. A plan
that reaches Runner and is refused before source execution has a standalone,
metadata-only query-audit record. An unknown top-level argument such as a
model-supplied tenant or principal is rejected earlier by the locked MCP schema;
authentication, HTTP-session, and runtime-bootstrap failures likewise happen before
a reviewed plan exists. Those cases have no normalized plan to persist, so no
query-audit record is created.
When Runner is attached to an interactive terminal, its metadata-only HTTP
access log still records the request lifecycle. That access log never records
tokens, claims, tool arguments, SQL, parameters, or result values. Operators
running under a non-interactive process supervisor should use that supervisor's
ordinary request/process observability; Runner does not persist rejected raw MCP
arguments into the control ledger.

The practical rule is: search `query-audit` for attempts and `evidence` for
released-result proof. `query-audit --outcome refused` includes requests that
Runner stopped before source execution as well as post-execution privacy
refusals; the detail record states `source_query_executed`. `evidence` rejects
`--outcome refused` with the exact `query-audit` command to use because a
refused request did not release a result and therefore has no evidence bundle.

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

Initialize the separate control ledger with the exact configured schema, then
run the first preflight before drafting authority:

```bash
synapsor-runner store shared-postgres apply-migration \
  --url-env SYNAPSOR_CONTROL_DATABASE_URL \
  --schema synapsor_runner \
  --yes

synapsor-runner doctor \
  --config ./synapsor-production-explore/synapsor.runner.json \
  --transport streamable-http \
  --preflight \
  --host 0.0.0.0 \
  --trusted-tls-proxy
```

At this stage, `active-production-boundaries` is expected to fail. Identity,
key, transport, source, control-store reachability/migration, and schema-name
checks still complete in the same report. Fix those infrastructure findings
before review; preflight never creates a boundary.

## 2. Create Separate Production Authority

Use the same read-only, non-owner database credential that production Explore
will serve. PostgreSQL and MySQL application sources are supported.

```bash
export DATABASE_URL='postgresql://readonly_user:...@db.example/app'

synapsor-runner boundary draft \
  --from-env DATABASE_URL \
  --profile production \
  --tenant-claim tenant_id \
  --principal-claim sub \
  --project-root ./synapsor-production-explore

synapsor-runner boundary review \
  --project-root ./synapsor-production-explore \
  --access
```

The draft reads the config already placed in that project and verifies that its
source, claim names, and any configured column bindings match. Review tables, columns, relationships, tenant
scope, optional row-principal scope, cohort minimums, and per-principal query,
extraction, and differencing limits. Activate the exact production boundary
through the normal human review action. A development/staging boundary cannot
be promoted by changing a profile field; production authority is generated and
reviewed separately.

For a mixed database, a global catalog or reference table remains blocked until
an operator explicitly reviews it as Shared reference. Runner never infers that
posture, and refuses it when inspection finds tenant columns, a derived path to
tenant-owned rows, or tenant/RLS evidence. The same field, relationship,
principal, cohort, and budget review remains required. Whole-organization
databases should use the separate boundary-wide single-organization mode rather
than marking every table individually.

## 3. Attest And Serve

After activation, rerun the same preflight. It must be fully ready before the
server starts:

```bash
synapsor-runner doctor \
  --config ./synapsor-production-explore/synapsor.runner.json \
  --transport streamable-http \
  --preflight \
  --host 0.0.0.0 \
  --trusted-tls-proxy

synapsor-runner mcp serve \
  --transport streamable-http \
  --production-explore \
  --host 0.0.0.0 \
  --trusted-tls-proxy \
  --config ./synapsor-production-explore/synapsor.runner.json
```

Use Runner-owned TLS flags instead of `--trusted-tls-proxy` when Runner
terminates TLS itself. Production Explore refuses static endpoint-token flags,
`--dev-no-auth`, and cleartext break glass. It also uses fixed canonical tool
names (`app.describe_data` and `app.explore_data`) and one fixed reviewed result
envelope. Presentation flags such as `--alias-mode`, `--tool-name-style`,
`--openai-tool-aliases`, and `--result-format` are rejected rather than silently
ignored.

`production_explore.enabled: true` is the reviewed runtime opt-in and selects
this locked surface automatically whenever the config is served over
Streamable HTTP. Keep `--production-explore` in deployment commands because it
makes the intended surface visible to operators and generated launch commands
include it. Omitting the flag no longer starts a misleading zero-tool server.
Serving an enabled production config over stdio or the legacy HTTP bridge fails
with the exact Streamable HTTP command instead.

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

The preflight and startup reports name every passing, warning, and failing
prerequisite in one run, plus environment-variable names and reviewed
boundaries. Preflight may be run before activation: a missing boundary is one
failed checklist item, while identity, transport, source, key, and control-store
checks still run. It never
prints secret values or database URLs. Production Explore startup prints
the same complete report when startup is refused, so an operator does not need
one restart per missing prerequisite.

## 4. Connect An MCP Client Through OAuth

Use an OAuth-capable MCP client's remote-server flow first. Point it at the
configured resource URL (for example `https://runner.example/mcp`) without
embedding a bearer token. Runner's `401` challenge and protected-resource
metadata tell the client which authorization server and scope to use. The
client owns login, secure token storage, and refresh; Runner owns verification
and reviewed data scope.

Confirm the client lists exactly `app.describe_data` and `app.explore_data`
after login. If it cannot perform RFC 9728 discovery and token refresh, use the
following explicit fallback rather than putting a literal token in a file.

### Manual/testing fallback: environment token

Runner can emit the native Streamable HTTP configuration for Claude Code,
Cursor, and VS Code. The command reads the public endpoint and authorization
metadata from `http_security.oauth_resource`; it does not read, mint, print, or
write an access-token value. This path merely references a token supplied to the
client process; it cannot refresh that token and is unsuitable as the primary
long-running production authentication lifecycle.

```bash
synapsor-runner mcp client-config \
  --client claude-code \
  --transport streamable-http \
  --client-access-token-env SYNAPSOR_MCP_ACCESS_TOKEN \
  --config ./synapsor-production-explore/synapsor.runner.json

synapsor-runner mcp client-config \
  --client cursor \
  --transport streamable-http \
  --client-access-token-env SYNAPSOR_MCP_ACCESS_TOKEN \
  --config ./synapsor-production-explore/synapsor.runner.json

synapsor-runner mcp client-config \
  --client vscode \
  --transport streamable-http \
  --client-access-token-env SYNAPSOR_MCP_ACCESS_TOKEN \
  --config ./synapsor-production-explore/synapsor.runner.json
```

The generated header is an environment reference, not a credential:

- Claude Code: `Authorization: Bearer ${SYNAPSOR_MCP_ACCESS_TOKEN}`
- Cursor and VS Code: `Authorization: Bearer ${env:SYNAPSOR_MCP_ACCESS_TOKEN}`

For a bounded integration test or manual compatibility check, obtain a
short-lived JWT access token from the authorization server named in Runner's
output, place it in `SYNAPSOR_MCP_ACCESS_TOKEN` in the MCP client process
environment, and restart or reload that client. The token expires and this
fallback has no refresh path. Use the identity provider's login or
secret-injection mechanism; do not paste the token into
`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, shell history, or source
control. Runner verifies the JWT signature, issuer, audience, expiry, OAuth
scope, tenant claim, and principal claim on every session. Runner is the
protected resource, not the authorization server, so it never accepts a
password and never issues or refreshes this token.

`--write --destination <path> --yes` can merge the generated entry into a
client file while preserving other servers and creating a backup. The same
secret-free checks apply. Claude Desktop remains a local stdio target; use the
`claude-code` client target for remote Streamable HTTP.

## Privacy And Concurrency

Runner reserves query, rate, extracted-cell, and differencing allowance before
executing a source query. PostgreSQL transaction advisory locks serialize the
read-check-reserve operation for both the authenticated principal and tenant.
Two concurrent requests cannot both consume the final unit. Query, rate, and
extracted-cell counters cover the whole trusted scope. Differencing variants use
one pool per trusted scope **and root resource**, because variants of one
resource can be subtracted from one another while unrelated resources do not
share a denominator. A ledger audit must therefore group or filter
`production_explore_budget_reservations` by `resource_id` before comparing it
with the response's differencing remainder.

The boundary's per-principal query/rate limits are throughput controls. New
1.7.0 boundaries default to 1,000 queries per rolling 24 hours and 120 requests
per rolling minute. Production `tenant_limits` add a separately configured
tenant-wide ceiling. Extracted cells, differencing variants, minimum cohorts,
suppression, and response bounds are disclosure controls; increasing throughput
does not increase any of them. An exhaustion response identifies the exact
class, used/limit values, root resource for differencing, and rolling-window
expiry upper bound. The detailed operator gauge identifies that resource in
both CLI and Workbench. Compact result metadata retains the backward-compatible
`differencing_queries` remainder and pairs it with
`differencing_variants_for_root_resource`, which states the resource,
used/limit/remaining values, rolling window, and durable cross-session behavior.

Per-principal accounting prevents one user from starving another. Tenant-wide
ceilings and tenant-level complementary-release accounting prevent many
principals from bypassing limits or reconstructing a suppressed cohort by
collusion. Minimum-cohort suppression, group caps, complexity limits, response
limits, timeouts, and the suppression-aware total defense are unchanged.
Related scalar totals also use atomic predicate claims at both principal and
tenant scope: Runner refuses an unfiltered/filtered pair or a parent/child
predicate pair whose subtraction could reconstruct a smaller cohort. This is
a targeted subtraction defense, not differential privacy or a claim that every
combination of otherwise legal filters is uninferable.

Failed or refused attempts consume query and rate allowance. Only released
cells consume extracted-cell allowance. Stranded reservations remain a
conservative charge until they age out of the rolling window.

None of these counters is keyed by an MCP session or bearer token. Reconnecting,
renewing an expired JWT for the same tenant/principal, moving to another Runner
replica, or restarting the server retains the same opaque accounting identity
when the accounting namespace, source, HMAC key, tenant, and principal are
unchanged. In particular, reconnecting cannot reset differencing protection.
The activated-pack field names `max_queries_per_session` and
`max_extracted_cells_per_session` are retained for artifact compatibility; in
Explore their enforced semantics are durable rolling 24-hour trusted-scope
limits, not counters that reset with an MCP session.

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
- Ordinary evidence stores normalized metadata, opaque fingerprints, and the
  value-free parameterized SQL shape. It does not store result rows,
  credentials, trusted claim values, or SQL parameter values. Model-facing
  evidence/replay resources remove the operator SQL field.
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
