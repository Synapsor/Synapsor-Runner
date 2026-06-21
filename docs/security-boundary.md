# Security Boundary

Synapsor Runner controls a narrow database path for MCP agents. It does not make
MCP generally secure and it does not solve prompt injection.

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

Writeback is separate. A trusted local runner/apply path uses a write credential
outside the model-facing MCP server and verifies:

- local reviewed config;
- source and capability identity;
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

Local review can happen through the CLI or `synapsor ui`. The UI is a localhost
review surface with a per-run session token and CSRF protection for
approve/reject actions. It does not expose raw SQL, database URLs, write
credentials, approval tools, commit tools, or controls that widen reviewed
tables/columns.

Synapsor Runner v0.1 supports guarded single-row `UPDATE` writebacks only. It
does not support arbitrary SQL, DDL, `INSERT`, `DELETE`, `UPSERT`, or multi-row
updates.
