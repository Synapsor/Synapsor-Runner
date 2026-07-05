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
