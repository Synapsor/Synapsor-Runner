# Production Readiness

Synapsor Runner is a local, open-source MCP data-plane/runtime for reviewed
Postgres/MySQL business actions. It is not Synapsor Cloud and it is not the
Synapsor C++ DBMS.

Use a staging or disposable database first.

Allowed current claims:

- semantic MCP tools instead of raw SQL;
- source database remains unchanged during proposal creation;
- separate read and write credentials;
- exact row diff;
- local approval outside MCP;
- tenant, column, version, affected-row, and idempotency checks;
- approved app/API handler writeback with handler secrets kept in environment
  variables;
- shadow-mode comparison between agent proposals and human actions;
- stale-row conflict detection in included fixtures;
- local replay for proposal/evidence/approval/writeback receipts.

Do not claim from this repository alone:

- high availability;
- compliance certification;
- mission-critical SLA;
- exactly-once across networks;
- general MCP security;
- prompt-injection immunity;
- physical branches for Postgres/MySQL;
- arbitrary business invariants are automatically understood.

Synapsor Cloud is the production/team control plane for shared approvals, RBAC,
hosted evidence/replay search, runner fleet status, leases, retention, audit
visibility, and support.

Before a public production-data claim, complete the release checklist, counsel
review, security review, and operational validation.
