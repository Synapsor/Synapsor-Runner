# Exact mutation bindings and verification overlap

Design note for the bounded September 2026 insurance, scope and edit repair.
Runtime qualification results belong in `action-capability-qualification.md`;
passing the regressions below does not establish a live source effect.

## Mutation identity

A selected claim can also be a member of the complete portfolio-claims
collection used to calculate the allowed reserve. These are two verification
bindings for one physical row. Their projections, row digests and roles differ.
The former proposal builder selected dependencies by physical key alone and
rejected this valid evaluator result because it found two dependencies.

For a single-row UPDATE, proposal construction now requires exactly one
dependency for the compiled effect's target binding, resource and primary key.
The compiled rule, envelope, singleton verification binding, source, table and
expected version must agree. Missing, duplicate or substituted target evidence
still fails. A collection binding never supplies mutation authority by merely
containing the same physical row.

Every dependency and complete-collection membership proof remains in the
proposal and worker job. Nothing is globally deduplicated. The evaluator also
refuses conflicting values in overlapping projections of the same physical row,
including the version counter. It uses the union only to check consistency;
the original per-binding facts and digests remain distinct.

The regression uses the actual saved insurance rule and original synthetic
fixture rows, compiles them and runs the evaluator before proposal construction.
It also renames the structural identifiers, tests malformed and cross-scope
references, and carries the resulting proposal through storage, approval, job
parsing and transaction-time semantic revalidation. Changed collection facts
still refuse execution. Live worker, database locking, receipts and readback
need separate qualification.

## Scope and authoring intent

An explicit opposite identity setting in inspected RLS cannot be overridden by
a column-name convention. Guided admission reviews populated contradictory
organization/person bindings as well as missing mappings. Corrections use the
existing exact inspection proof, operator confirmation, atomic review mutation
and freshness checks. Unsupported proof leaves the requirement unresolved.

Generated coverage diagnostics are repair context. The host separately retains
the original policy and accepted operator statements in the existing pending
Action revision record. Those statements feed the approval-intent guard and
bind the model checkpoint's context digest. A changed statement discards partial
components. A generated scope description cannot become an operator allowance.
Old checkpoints without provenance retain their existing conservative treatment.

The checkpoint privacy guard permits an explicit column-choice question to
refer back to one of its named columns with “is bound to”. It still refuses
literal identity assignments, unlisted values, credentials and endpoint URLs,
including when they occur beside an allowed symbolic explanation.

## Interrupted edits

A job interrupted before client selection has no planned Action agenda.
Existing saved rules are not evidence that its new request was fulfilled, so
that state returns to planning. Existing standalone recovery keeps its separate
unfinished agenda. An exact pending Action revision takes its existing revision
route when it targets that agenda. A revision of a separately saved outcome
first recovers its exact baseline while retaining the unrelated unfinished agenda.

When a requested Action revision leaves the business policy unchanged, a new
review explanation or digest cannot close the request. The operator can confirm
that the current rule already satisfies the request or explicitly withdraw it;
the default preserves a pending revision. That record retains its exact baseline
and existing concurrent-revision checks. This does not infer the meaning of
arbitrary edit prose or introduce a second job ledger.
