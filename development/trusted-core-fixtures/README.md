# Trusted-core compatibility fixtures

`pre-refactor-8989163-ledger.db` was created by `ProposalStore` at commit
`8989163f324e7e8abaf55696796d1f13d7a6d71b`, before the trusted-core
modularization.

The fixture contains only synthetic proposal, evidence, query-audit, approval,
receipt, replay, and Runner-state records. It contains no database URL,
credential, trusted production identity, source row, or kept-out field.

The proposal-store compatibility test copies this immutable fixture to a
temporary path, opens it with the current implementation, validates its
pre-refactor records and integrity fields, writes a synthetic successor
proposal, closes it, and opens it again. This pins schema, migration, codec,
and ordinary read/write compatibility across the refactor.
