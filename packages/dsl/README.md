# @synapsor/dsl

`@synapsor/dsl` is a 0.1 preview authoring layer for Synapsor contracts.

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
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX 128
  ALLOW READ id, tenant_id, status, late_fee_cents, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
END
```

A longer worked contract lives in
[`examples/billing-late-fee.synapsor`](https://github.com/Synapsor/Synapsor-Runner/blob/main/packages/dsl/examples/billing-late-fee.synapsor),
and the runner README walks the full compile → validate → bundle → serve flow.

## CLI

```bash
synapsor-dsl validate ./contract.synapsor
synapsor-dsl compile ./contract.synapsor --out ./synapsor.contract.json
```

Runner also exposes:

```bash
synapsor-runner dsl validate ./contract.synapsor
synapsor-runner dsl compile ./contract.synapsor --out ./synapsor.contract.json
```

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

## Supported Preview Constructs

- `CREATE AGENT CONTEXT`
- `CREATE CAPABILITY`
- `CREATE AGENT WORKFLOW`
- `BIND ... FROM SESSION|ENVIRONMENT|CLOUD_SESSION|STATIC_DEV|HTTP_CLAIM`
- `USING CONTEXT`
- `ON schema.table`
- `PRIMARY KEY`
- `TENANT KEY`
- `CONFLICT GUARD`
- `ARG`
- `LOOKUP`
- `ALLOW READ`
- `KEEP OUT`
- `REQUIRE EVIDENCE`
- `PROPOSE ACTION`
- `ALLOW WRITE`
- `PATCH`
- `APPROVAL ROLE`
- `WRITEBACK DIRECT SQL|APP HANDLER|CLOUD WORKER|NONE`
- workflow `ALLOW CAPABILITY`

Unsupported Cloud-generated clauses such as `ROOT EXTERNAL`,
`JOIN EXTERNAL`, `RETURN ANSWER WITH CITATIONS`, `AUTO BRANCH`, or `AUTO MERGE`
fail explicitly instead of being ignored.
