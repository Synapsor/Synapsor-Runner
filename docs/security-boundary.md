# Security Boundary

Synapsor Runner controls a narrow database path for MCP agents. It does not make
MCP generally secure and it does not solve prompt injection.

## Least-privilege database access

Use a read-only database user, restricted views, row-level security, and staging
data where appropriate. Synapsor Runner is not a replacement for database
permissions.

Database permissions protect the connection. Synapsor Runner shapes the
model-facing interface: reviewed semantic capabilities, trusted context
binding, evidence, audit, replay, and proposal-first writes instead of
model-facing commit authority.

The model-facing MCP server exposes reviewed semantic tools such as
`billing.inspect_invoice` and `billing.propose_late_fee_waiver`.

The model does not receive:

- raw SQL;
- a generic `execute_sql` tool;
- arbitrary table, schema, or column names;
- database URLs or credentials;
- approval tools;
- commit/writeback tools;
- trusted tenant or principal authority as ordinary model arguments.

Trusted context comes from local configuration, environment bindings, or Cloud
session context in Cloud mode. Tenant, principal, and authorization scope must
not be accepted from the model as authority.

Proposal tools read the current row through the read credential, store evidence
and an exact before/after diff, and leave the source database unchanged.

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
- primary-key and tenant guards;
- allowed mutable columns;
- conflict/version guard;
- idempotency key;
- job expiry;
- exactly one affected row.

If any authority check cannot be verified, the write fails closed.

When a capability uses an `http_handler` or `command_handler` executor, the
same approval boundary applies. The runner sends a structured proposal/job
payload to the configured handler after approval. Handler URLs, commands, bearer
tokens, database URLs, and write credentials come from environment variables and
are not exposed to MCP tools.

Writeback jobs and change sets also reject path-traversal or SQL-fragment-like
database identifiers such as `../private`, `id/../../tenant_id`, or
`status; DROP TABLE tickets` before adapter execution. Local CLI file paths
remain explicit user-provided paths; they are not model-facing authority.

Local review can happen through the CLI or `synapsor ui`. The UI is a localhost
review surface with a per-run session token and CSRF protection for
approve/reject actions. It does not expose raw SQL, database URLs, write
credentials, approval tools, commit tools, or controls that widen reviewed
tables/columns.

Synapsor Runner supports reviewed single-row business actions only in the
current alpha. It does not support arbitrary SQL, DDL, `INSERT`, `DELETE`,
`UPSERT`, or multi-row updates.
