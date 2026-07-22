# Security Boundary

Synapsor Runner controls a narrow database path for MCP agents. It does not make
MCP generally secure and it does not solve prompt injection.

## Least-privilege database access

Use a read-only database user, restricted views, row-level security, and staging
data where appropriate. Synapsor Runner is not a replacement for database
permissions.

Database permissions protect the connection. Synapsor Runner shapes the
model-facing interface: reviewed semantic capabilities, trusted context
binding, evidence handles, query audit, local inspection, and proposal-first
writes instead of model-facing commit authority.

If all you need is restricted reads, database permissions are a good start.
Use Synapsor Runner when you also want the agent-facing layer: semantic tools,
trusted context, evidence handles, query audit, local inspection, and
proposal-first writes. Proposal workflows add full replay across evidence,
approval, writeback receipts, and events.

Prompt instructions and application validation are separate layers. Prompts
can guide behavior but cannot supply authorization. A fixed, parameterized
application tool can be a sound boundary for a small system; Runner adds a
portable reviewed contract and a consistent proposal, approval, receipt,
replay, and compensation lifecycle. See [Why Synapsor Over Prompt And
Application Guardrails](why-synapsor-vs-app-guardrails.md).

The model-facing MCP server exposes reviewed semantic tools such as
`billing.inspect_invoice` and `billing.propose_late_fee_waiver`.

The model does not receive:

- raw SQL;
- a generic `execute_sql` tool;
- arbitrary table, schema, or column names;
- database URLs or credentials;
- contract activation tools;
- approval tools;
- commit/writeback tools;
- MCP endpoint tokens, JWTs, refresh tokens, client secrets, or TLS keys;
- trusted tenant or principal authority as ordinary model arguments.

## Network transport and identity

Local stdio is the preferred one-client path. The MCP client launches Runner and
communicates over the child process's standard input/output, so Runner opens no
network listener and HTTP authentication does not apply.

A listening HTTP endpoint has no inherent client identity. Runner therefore
requires Bearer authentication by default. On loopback or an explicitly
single-tenant service, Bearer may carry one high-entropy opaque endpoint token;
that token only answers "may this service call the endpoint?" and is not a user
or tenant identity. Shared services require signed per-session JWTs, preferably
RS256/ES256 from an external identity provider, with exact issuer,
audience/resource, time, scope, tenant, and principal validation on every
request. An MCP session ID only routes protocol state and never authenticates a
caller.

Non-loopback HTTP refuses to bind unless Runner owns TLS, an explicitly trusted
TLS proxy protects the public and private hops, or an authenticated emergency
cleartext break-glass mode is selected. TLS protects the channel; mTLS also
authenticates a workload certificate but does not replace per-user/tenant claims
in a shared service. Exact Origin and Host policy, request/session limits, and
credential-pinned MCP sessions narrow browser, DNS-rebinding, exhaustion, and
session-swap attacks.

These controls remain independent: transport authentication permits endpoint
access; verified session claims provide tenant/principal context; the contract
authorizes semantic capabilities; database roles/RLS constrain the connection;
operator identity authorizes activation, approval, apply, reconcile, and
revert. See [HTTP MCP](http-mcp.md).

Reviewed aggregate tools expose one scalar only. Their function, column,
tenant key, optional equality selection, and minimum-group threshold are fixed
in the contract; the model receives no predicate arguments or member rows.
Suppression reduces single-record inference but does not replace statistical
privacy review. See [Bounded Aggregate Reads](aggregate-reads.md).

Trusted context comes from operator-controlled process bindings for local or
explicitly single-tenant use, verified signed HTTP claims for a shared service,
or verified Cloud session context in Cloud mode. Tenant, principal, and
authorization scope must not be accepted from the model as authority.
Canonical `SESSION` content is rejected by Runner with
`SESSION_BINDING_UNSUPPORTED`; Runner never aliases it to environment values,
arbitrary headers, MCP metadata, or model arguments.

With a shared credential, these checks are application-level enforcement and
depend on Runner's fixed predicate implementation. Optional PostgreSQL RLS mode
adds an independent database check for omitted predicates and pooled-context
leakage. Tenant-bound credentials or isolated deployments provide the stronger
boundary when a Runner process must not hold organization-wide authority.
PostgreSQL RLS does not protect against a fully compromised process that can
choose arbitrary trusted settings, and MySQL has no native RLS equivalent. See
[Database-Enforced Tenant And Principal
Scope](database-enforced-scope.md).

A capability may declare `principal_scope_key` (DSL: `PRINCIPAL SCOPE KEY`) to
narrow rows inside a tenant. Runner then adds both fixed, parameterized guards:

```text
tenant_key = verified tenant AND principal_scope_key = verified principal
```

This applies to single-row reads and writes, aggregates, bounded sets, inserts,
deletes, executor envelopes, and reviewed compensation. Missing principal
context fails closed. A principal lock never replaces tenant scope and has no
dynamic supervisor bypass. Use a separately reviewed tenant-wide capability
for broader roles. RLS and restricted database roles remain valuable defense in
depth; the contract does not replace them.

Proposal, evidence, and replay handles are references, not bearer credentials.
Before returning a local MCP resource, Runner resolves the resource's owning
capability context again and requires both tenant and principal to match the
current trusted session. Missing resources and ownership mismatches return the
same generic `RESOURCE_NOT_FOUND` result. Local operator CLI access remains an
explicit host-level administrative boundary.

Proposal tools read the current row through the read credential, store evidence
and an exact before/after diff, and leave the source database unchanged.

Code-first Safe Actions do not create authority when a file is edited. Runner
parses the restricted TypeScript object without importing or executing it,
compiles it into a digest-addressed disabled canonical draft, and keeps the
active contract pointer unchanged. Activation is available only in the
session-token/CSRF-protected localhost Workbench after a matching real staging
proposal proves `source_database_changed:false`; the operator must confirm the
complete digest. A proposal remains pinned to the active contract digest it was
created under, so later activation cannot reinterpret an old approval. Cloud-
linked projects route activation through Cloud governance instead of the local
control. No model-facing MCP tool can validate-and-activate, approve, apply, or
revert.

The local proposal store rejects obvious credential material before persistence:
database URLs, bearer tokens, Synapsor runner tokens, private-key blocks, and
secret-like fields such as password, token, API key, private key, cookie,
credential, connection string, read URL, or write URL. If a selected table
contains one of those fields, remove it from the reviewed visible/evidence
projection before creating proposals.

Writeback is separate. A trusted local runner/apply path uses a write credential
outside the model-facing MCP server and verifies:

- local reviewed config;
- source and capability identity;
- fixed safe schema, table, and column identifiers;
- local approval state;
- proposal and job digests;
- target schema/table;
- primary-key, tenant, and declared principal-row guards;
- allowed mutable columns;
- conflict/version guard;
- idempotency key;
- operation-specific version or source-unique deduplication guard;
- job expiry;
- exactly one reviewed row or every member of one bounded frozen set.

If any authority check cannot be verified, the write fails closed.

For direct SQL writeback, the writer connection is the env var named by the
source `write_url_env` in `synapsor.runner.json`. With `source_db` receipt
authority, the source mutation and receipt commit atomically; the receipt table
can be administrator-precreated or explicitly auto-migrated. With
`runner_ledger` authority, Runner creates no source receipt table, but a crash
after source commit and before ledger completion can require verified operator
reconciliation. It is not distributed exactly-once. See
[Guarded Single-Row CRUD Writeback](guarded-crud-writeback.md).

Bounded-set direct writeback additionally requires a contract-fixed predicate
or complete reviewed item list, `MAX ROWS` plus aggregate bounds,
human/operator approval, exact frozen identities and versions, deterministic
locks, one atomic source transaction, and per-member receipt digests. The
model cannot supply the predicate or cap. See [Bounded Set
Writeback](bounded-set-writeback.md).

When a direct SQL capability opts into reviewed reversibility, an applied
receipt may carry a bounded inverse containing only trusted identity, version,
and reviewed writable values. `revert` is operator-only and creates a new
proposal; it never mutates or approves. Compensation rechecks the exact forward
result under the trusted tenant and uses the normal approval, receipt,
reconciliation, and replay boundaries. See [Reviewed Reversible Change
Sets](reversible-change-sets.md).

When a capability uses an `http_handler` or `command_handler` executor, the
same approval boundary applies. The runner sends a structured proposal/job
payload to the configured handler after approval. Handler URLs, commands, bearer
tokens, database URLs, and write credentials come from environment variables and
are not exposed to MCP tools.

Writeback jobs and change sets also reject path-traversal or SQL-fragment-like
database identifiers such as `../private`, `id/../../tenant_id`, or
`status; DROP TABLE tickets` before adapter execution. Local CLI file paths
remain explicit user-provided paths; they are not model-facing authority.

Local review can happen through the CLI or `synapsor-runner ui`. The UI is a
localhost review surface with a per-run session token and CSRF protection for
approve/reject and Safe Action draft controls. Activation additionally requires
a matching source-unchanged preview plus the complete digest. These operator
controls are not MCP tools. The UI does not expose raw SQL, database URLs, or
write credentials, and it does not let a model widen reviewed tables, columns,
scope, policy, or executor authority.

Contract lint and tests are review aids rather than a proof of complete
security. Capability breadth can still drift as narrow tools accumulate;
surface-fitness lint makes high-signal generic, dense, poorly named, and
near-duplicate surfaces visible for review but does not enforce good design.
Scoped report exports omit evidence rows and kept-out values and are
tamper-evident when their digest/signature verifies; local SQLite is not an
immutable compliance service. Graduated-trust evaluation is operator-only,
disabled by default, and can recommend/export a separate artifact but cannot
approve itself or activate policy.

Synapsor Runner supports reviewed single-row CRUD and the narrowly bounded set
path documented above. It does not support arbitrary SQL, DDL, UPSERT,
model-generated predicates, unbounded sets, or cross-table direct writeback.
Hard DELETE fails closed when cascades, write triggers, or required metadata
visibility prevent a bounded-effect proof.
