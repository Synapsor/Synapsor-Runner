# @synapsor/dsl

`@synapsor/dsl` is a 0.1 preview authoring layer for Synapsor contracts.

The DSL is not the source of truth. It compiles to `@synapsor/spec` JSON, and
the generated JSON is validated by `@synapsor/spec`.

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
