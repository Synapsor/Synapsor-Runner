# Contributing

Synapsor Runner is open-source software under Apache License 2.0. Until
Synapsor has a counsel-approved CLA or inbound-rights process for this
repository, external code contributions are not being accepted.

What is welcome now:

- bug reports;
- documentation feedback;
- security reports through the process in `SECURITY.md`;
- feature requests and reproducible examples.

Please do not submit pull requests or code patches unless the maintainers have
explicitly requested them under an approved contribution process.

For maintainers, use small changes with tests. Do not add support for arbitrary
SQL, model-generated or unbounded multi-row predicates, DDL, stored procedures,
or model-generated write statements. Existing bounded-set support must retain
its reviewer-fixed predicate, hard row/value caps, atomic execution, frozen
members, and exact receipts.

Before opening a change:

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test:smoke
```

Keep logs and fixtures free of secrets and customer data.

## Safety Boundary Checklist

Do not change guard semantics without a focused test. In particular, changes
that touch proposal creation, approval, writeback, store leases, receipts,
idempotency, replay, MCP tool exposure, or app-owned handlers must prove:

- no model-facing `execute_sql`, raw SQL, approval, commit, apply, or writeback
  tool was added;
- tenant/principal values come from trusted context, not model-controlled args;
- direct writeback still checks primary key, tenant key, allowed columns,
  expected version/conflict guard, affected-row count, idempotency, and receipt
  recording;
- generated authority remains disabled until exact-digest human activation,
  Scoped Explore remains local authoring-only, and reviewed relationship paths
  cannot be supplied or activated by the model;
- proposal/evidence freshness and supervised worker apply continue to fail
  closed on source, digest, scope, policy, limit, or role-posture drift;
- app-owned handler templates tell developers to re-check tenant/scope,
  expected version, idempotency, allowed action, transaction/rollback, and
  receipt shape.

Useful local gates:

```bash
corepack pnpm verify:local-runner
corepack pnpm verify:packed-runner
corepack pnpm test:mcp-client-configs
```
