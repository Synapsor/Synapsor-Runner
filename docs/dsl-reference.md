# Synapsor DSL Reference

The Synapsor DSL is a reviewable SQL-like authoring format that compiles to the
canonical `@synapsor/spec` contract. Prefer `.synapsor.sql`; legacy `.synapsor`
files remain valid. The filename does not change semantics.

Validate and compile with strict safety warnings enabled:

```bash
synapsor-runner dsl validate ./contract.synapsor.sql --strict
synapsor-runner dsl compile ./contract.synapsor.sql \
  --out ./synapsor.contract.json --strict
```

Keywords are case-insensitive. Blocks start with `CREATE ...` and end with
`END` or `END;`. Lines may end in semicolons. `--` starts a line comment.
Unsupported clauses fail explicitly.

## Agent context

```sql
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END
```

| Clause | Meaning |
| --- | --- |
| `BIND name FROM source key [REQUIRED]` | Defines trusted context. Sources: `SESSION`, `ENV`/`ENVIRONMENT`, `CLOUD_SESSION`, `STATIC_DEV`, `HTTP_CLAIM`. Model tool arguments cannot set these bindings. |
| `TENANT BINDING name` | Selects the binding used for tenant scope. Defaults to a binding named `tenant_id`. |
| `PRINCIPAL BINDING name` | Selects the actor binding. Defaults to a binding named `principal`. |

At least one `BIND` is required. The selected tenant/principal bindings must be
provided by the trusted runtime environment, not by the model.

## Capability identity and target

```sql
CREATE CAPABILITY billing.inspect_invoice
  DESCRIPTION 'Inspect one invoice in the trusted tenant.'
  RETURNS HINT 'Returns reviewed fields and an evidence handle.'
  USING CONTEXT local_operator
  SOURCE billing_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  ...
END
```

| Clause | Requirement and compiled meaning |
| --- | --- |
| `CREATE [AGENT] CAPABILITY namespace.name` | Starts a qualified capability. |
| `DESCRIPTION 'text'` | Model-facing `tools/list` description. Recommended for every tool and required by strict review for proposal quality. |
| `RETURNS HINT 'text'` | Model-facing result guidance. |
| `USING CONTEXT name` | Required. References an agent context. |
| `SOURCE name` | Source key that must match `synapsor.runner.json.sources`. |
| `ON schema.table` | Required fixed target. Table/schema are never model inputs. |
| `PRIMARY KEY column` | Fixed single-row target key. Defaults to `id` in DSL 0.1. Declare it explicitly. |
| `TENANT KEY column` | Required in DSL 0.1. Adds trusted tenant scope to every read/write. |
| `CONFLICT GUARD column` | Captures the row-version value for exact guarded writeback. Prefer a monotonic version or native-precision timestamp. |

## Arguments and lookup

```sql
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id.'
  ARG amount_cents NUMBER REQUIRED MIN 1 MAX 2500 DESCRIPTION 'Amount in cents.'
  ARG confirmed BOOLEAN REQUIRED
```

Argument types are `STRING`/`TEXT`, `NUMBER`, and `BOOLEAN`/`BOOL`.

- `REQUIRED` makes the model-facing argument mandatory.
- `DESCRIPTION 'text'` documents the argument in MCP `tools/list`.
- `MIN n` and `MAX n` are numeric bounds for `NUMBER`.
- `MAX LENGTH n` bounds `STRING`/`TEXT`. Legacy text `MAX n` remains accepted.
- `LOOKUP arg BY column` binds one argument to the target row lookup.

In spec 0.1, lookup is primary-key-only. The `BY` column must equal the declared
`PRIMARY KEY`. A different column fails with `LOOKUP_COLUMN_UNSUPPORTED`; Runner
never silently rewrites it. List/filter queries require a reviewed view or a
different capability design.

## Read surface and evidence

```sql
  ALLOW READ id, tenant_id, status, amount_cents, updated_at
  KEEP OUT card_token, private_notes
  REQUIRE EVIDENCE
  MAX ROWS 1
```

`ALLOW READ` is required and becomes the visible-field allowlist. `KEEP OUT`
records fields that must remain outside the model/evidence surface. Keep-out
fields must not also be visible. `REQUIRE EVIDENCE` records the scoped read and
query audit. `MAX ROWS n` bounds the result; local 0.1 capabilities are designed
around one primary-key row.

## Proposal and patch

Read capabilities end after the read clauses. A proposal capability adds:

```sql
  PROPOSE ACTION waive_late_fee
  ALLOW WRITE late_fee_cents, waiver_reason
  PATCH late_fee_cents = 0
  PATCH waiver_reason = ARG reason
  PATCH status = 'approved'
  PATCH reviewed = TRUE
  PATCH obsolete_note = NULL
```

`PROPOSE ACTION` must precede proposal-only clauses. `ALLOW WRITE` is the exact
patch-column allowlist. Each `PATCH` uses one of:

- `ARG name`: value comes from a validated model argument;
- a quoted fixed string;
- a fixed number;
- `TRUE`, `FALSE`, or `NULL`.

Fixed strings such as `PATCH status = 'approved'` are supported. The patch is
saved as a proposal; it is not executed by the model-facing tool.

## Bounds and transitions

```sql
  BOUND amount_cents 1..2500
  BOUND discount_cents ..500
  BOUND score 1..
  TRANSITION status ALLOW reported -> approved|rejected
  TRANSITION status FROM current_status ALLOW open -> closed, held -> open
```

`BOUND column min..max` applies to a patched numeric column. Either side may be
open, but not both. Strict mode warns when a numeric argument reaches a patch
without argument bounds or a patch bound.

`TRANSITION patched_column [FROM source_column] ALLOW from -> to|to, ...`
allowlists state changes. Without `FROM`, the current value is read from the
patched column. Values may be identifiers or quoted strings.

## Approval and writeback

```sql
  APPROVAL ROLE billing_lead
  REQUIRE 2 APPROVALS
  AUTO APPROVE WHEN amount_cents <= 2500
  LIMIT 20 PER DAY
  LIMIT TOTAL 100000 PER DAY
  WRITEBACK DIRECT SQL
```

`APPROVAL ROLE role` records the required local reviewer role. Local OSS
approval identity is operator-provided; enterprise identity/RBAC belongs to the
Cloud boundary.

`REQUIRE n APPROVALS` is optional and accepts 1 through 10. It compiles to the
canonical `approval.required_approvals` field. The default is 1. Each slot
requires a distinct verified subject; duplicate subjects fail with
`APPROVER_ALREADY_COUNTED`. Apply/workers remain blocked until `n/N`, rejection
is terminal, and policy auto-approval is deferred when `n > 1`.

`AUTO APPROVE WHEN field <= non_negative_integer` is supported only for a
numeric patched field and must follow `APPROVAL ROLE`. Its maximum cannot exceed
the field's `BOUND`. Policy approval still does not apply the write.

Aggregate limits follow the auto-approval clause:

```sql
LIMIT 20 PER DAY
LIMIT TOTAL 100000 PER DAY
```

`LIMIT n PER DAY` caps policy approvals for the trusted tenant and policy in
the UTC calendar day. `LIMIT TOTAL n PER DAY` sums the policy's numeric patch
field over the same scope. Use `PER OBJECT DAY` instead of `PER DAY` to scope a
limit to one trusted tenant, policy, and business object. The check and approval
are one atomic ledger transaction. When any ceiling would be exceeded, Runner
leaves the proposal in `pending_review` and records
`policy_auto_approval_deferred` with observed, proposed, and projected values.
It does not reject or auto-apply the proposal.

Writeback forms:

| Clause | Meaning |
| --- | --- |
| `WRITEBACK DIRECT SQL` | Runner performs one guarded single-row update after approval. |
| `WRITEBACK APP HANDLER EXECUTOR name` | Runner calls a configured app-owned executor after approval. URL/token wiring stays outside the contract. |
| `WRITEBACK CLOUD WORKER` | Delegates approved execution to Cloud worker infrastructure. |
| `WRITEBACK NONE` | Proposal-only; local apply is intentionally unavailable. |

## Workflow declarations

```sql
CREATE AGENT WORKFLOW support.refund_review
  USING CONTEXT local_operator
  ALLOW CAPABILITY support.inspect_order
  ALLOW CAPABILITY support.propose_refund
  REQUIRE EVIDENCE
  APPROVAL REQUIRED ROLE support_lead
  CHECKPOINT PROPOSAL ONLY
END
```

`USING CONTEXT` and at least one `ALLOW CAPABILITY` are required. Optional
clauses are `REQUIRE EVIDENCE`, `APPROVAL REQUIRED ROLE role`, and `CHECKPOINT
NONE|EVERY STEP|PROPOSAL ONLY`. Contracts can declare workflows; Runner 0.1 does
not execute arbitrary Cloud workflow DAGs, settlement, branching, or auto-merge.

## Unsupported syntax

Unknown clauses fail instead of being ignored. Cloud-generated concepts such as
`ROOT EXTERNAL`, `JOIN EXTERNAL`, `RETURN ANSWER WITH CITATIONS`, `AUTO BRANCH`,
and `AUTO MERGE` are not local DSL 0.1 clauses.

The canonical JSON output, not parser implementation details, is the portable
contract. Validate generated JSON with `synapsor-runner contract validate`.
