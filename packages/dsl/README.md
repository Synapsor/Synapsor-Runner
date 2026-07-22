# @synapsor/dsl

`@synapsor/dsl` is the SQL-like authoring frontend for canonical Synapsor contracts.

The DSL is not the source of truth. It compiles to `@synapsor/spec` JSON, and
the generated JSON is validated by `@synapsor/spec`.

Part of the Synapsor OSS toolchain:

- [`@synapsor/runner`](https://www.npmjs.com/package/@synapsor/runner): local MCP runtime that serves compiled contracts.
- [`@synapsor/spec`](https://www.npmjs.com/package/@synapsor/spec): canonical contract schemas, types, and validation.
- [Source and issues on GitHub](https://github.com/Synapsor/Synapsor-Runner).

## Example

```sql
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.inspect_invoice
  DESCRIPTION 'Inspect one invoice in the trusted tenant before proposing a waiver.'
  RETURNS HINT 'Returns reviewed invoice fields plus evidence/query-audit handles.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  PRINCIPAL SCOPE KEY assigned_to
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ALLOW READ id, tenant_id, status, late_fee_cents, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
END
```

A longer worked contract lives in
[`examples/billing-late-fee.synapsor.sql`](https://github.com/Synapsor/Synapsor-Runner/blob/main/packages/dsl/examples/billing-late-fee.synapsor.sql),
and the runner README walks the full compile → validate → bundle → serve flow.
For same-tenant owner/assignee isolation, see
[`principal-row-scope.synapsor.sql`](https://github.com/Synapsor/Synapsor-Runner/blob/main/packages/dsl/examples/principal-row-scope.synapsor.sql).
The clause always narrows mandatory tenant scope with the required trusted
principal binding; the model cannot supply or override its value.

Use `.synapsor.sql` for authored DSL files so editors recognize the file as
SQL and provide generic SQL highlighting. Existing `.synapsor` files remain
supported for compatibility. The filename suffix does not change DSL semantics
or generated canonical JSON; this repository does not provide Synapsor-specific
semantic editor highlighting.

## CLI

```bash
synapsor-dsl validate ./contract.synapsor.sql [--strict] [--target canonical|runner]
synapsor-dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json [--strict] [--target canonical|runner]
```

Runner also exposes:

```bash
synapsor-runner dsl validate ./contract.synapsor.sql [--strict]
synapsor-runner dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json [--strict]
```

`--strict` treats safety warnings as errors. Use it in CI for reviewed proposal
contracts. `--target runner` also rejects canonical constructs that Runner does
not execute, including `FROM SESSION`. The `synapsor-runner dsl` commands select
the Runner target automatically.

Continue from authored DSL to a local/Cloud-compatible contract with:

```bash
synapsor-dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json --strict
synapsor-spec validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
```

The generated `synapsor.contract.json` is the portable source of truth. Runner
configuration supplies local database env names and transport settings; Cloud
stores immutable normalized versions and never needs database credentials in
the contract.

## Programmatic API

```ts
import { compileAgentDsl, parseAgentDsl, validateAgentDsl, formatAgentDsl, AgentDslError } from "@synapsor/dsl";
import { assertValidContract, normalizeContract } from "@synapsor/spec";

const source = `CREATE AGENT CONTEXT ...`;

const result = validateAgentDsl(source); // { ok, errors, warnings } with line/column entries
const ast = parseAgentDsl(source);       // AST with line/column spans

try {
  const contract = compileAgentDsl(source); // @synapsor/spec contract JSON
  assertValidContract(normalizeContract(contract));
} catch (error) {
  if (error instanceof AgentDslError) {
    console.error(`${error.message} at ${error.line}:${error.column}`);
  }
}
```

`formatAgentDsl(source)` returns a canonically formatted copy of the DSL text.

## Supported Constructs

- `CREATE AGENT CONTEXT`
- `CREATE CAPABILITY`
- `CREATE AGENT WORKFLOW`
- `BIND ... FROM SESSION|ENVIRONMENT|CLOUD_SESSION|STATIC_DEV|HTTP_CLAIM` in
  the language-neutral grammar; Runner rejects `SESSION` rather than treating
  it as environment input
- `USING CONTEXT`
- `DESCRIPTION`
- `RETURNS HINT`
- `ON schema.table`
- `PRIMARY KEY`
- `TENANT KEY`
- `PRINCIPAL SCOPE KEY` for a tenant-additive trusted owner/assignee row lock
- exact `CONFLICT GUARD column`
- explicit legacy `CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED` for ordinary
  single-row source-DB UPDATE only; omission fails and the weak form warns that
  projection hashing can miss changes outside the captured fields
- `ARG`
- `ARG ... DESCRIPTION`
- `ARG ... MIN ... MAX ...` for `NUMBER`
- `ARG ... MAX LENGTH ...` for `STRING`/`TEXT`
- `ARG ... ENUM(...)` for reviewed string, number, or boolean choices
- `LOOKUP`
- `ALLOW READ`
- `KEEP OUT`
- `REQUIRE EVIDENCE`
- `AGGREGATE READ COUNT ROWS|COUNT NON NULL column|SUM column|AVG column`
- `MIN GROUP SIZE n` for mandatory aggregate suppression
- `PROPOSE ACTION`
- `PROPOSE ACTION name UPDATE|INSERT|DELETE` (operation defaults to `UPDATE`)
- `PROPOSE ACTION name UPDATE|INSERT|DELETE SET` for bounded-set authoring
- `REVERSIBLE` for opt-in, direct-SQL reviewed compensation; it creates no
  model-facing revert or automatic rollback path
- fixed literal `SELECT WHERE term [AND term]` for set UPDATE/DELETE
- `MAX ROWS n` plus `MAX TOTAL column BEFORE|AFTER|ABSOLUTE DELTA maximum`
- `ARG name ROWS MAX n` and typed `ITEM FIELD` declarations for batch INSERT
- `BATCH ITEMS FROM ARG name`, `ITEM field` patches, and `ITEM field` dedup keys
- `DEDUP KEY column = TRUSTED TENANT|PROPOSAL ID|FIXED value` for `INSERT`
- `ADVANCE VERSION column USING INTEGER INCREMENT|DATABASE GENERATED` for
  Runner-ledger `UPDATE`
- `ALLOW WRITE`
- `PATCH`
- `BOUND`
- `TRANSITION`
- `APPROVAL ROLE`
- `REQUIRE n APPROVALS` for a 1..10 distinct-reviewer quorum
- `AUTO APPROVE WHEN field <= integer`
- `LIMIT count PER DAY` after auto-approval
- `LIMIT TOTAL integer PER DAY` after auto-approval
- optional `PER OBJECT DAY` scope for count/total limits
- `WRITEBACK DIRECT SQL|APP HANDLER|CLOUD WORKER|NONE`
- workflow `ALLOW CAPABILITY`

Bounded sets have a hard 100-row ceiling, freeze exact members before review,
and require human/operator approval. The compiler rejects policy auto-approval,
missing fixed selection, missing aggregate bounds, and model-supplied
predicates. See the [bounded-set guide](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/bounded-set-writeback.md).

Multi-term selections are fixed equality clauses, not free-form SQL:

```sql
  SELECT WHERE risk_level = 'high' AND case_status = 'active'
```

`AND` may join up to eight literal equality terms. `OR`, parentheses,
inequalities, ranges, and model-authored predicates are rejected explicitly.
Quoted literals may contain the word `AND` without becoming another term. See
the packaged
[`bounded-set-multi-term.synapsor.sql`](examples/bounded-set-multi-term.synapsor.sql)
example.

Reviewed reversible writes require direct SQL, human/operator approval, and
operation-specific exact guards. After apply, `synapsor-runner revert` creates
a separate proposal. See the [reviewed compensation
guide](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/reversible-change-sets.md).

Unsupported Cloud-generated clauses such as `ROOT EXTERNAL`,
`JOIN EXTERNAL`, `RETURN ANSWER WITH CITATIONS`, `AUTO BRANCH`, or `AUTO MERGE`
fail explicitly instead of being ignored.

The complete clause grammar and constraints, including primary-key-only
`LOOKUP`, fixed-string `PATCH`, workflow declarations, and writeback forms, are
in the [Synapsor DSL Reference](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/dsl-reference.md).
