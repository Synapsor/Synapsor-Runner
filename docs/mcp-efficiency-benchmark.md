# MCP Efficiency Benchmark

Run:

```bash
synapsor benchmark mcp-efficiency
```

For machine-readable output:

```bash
synapsor benchmark mcp-efficiency --json
```

The benchmark compares an included fixture, not universal model behavior.

Current fixture:

```text
late-fee-waiver
```

Reference path:

```text
list_tables
describe_table invoices
query_database SELECT invoice
formulate raw UPDATE
execute_sql UPDATE invoice
```

Synapsor Runner semantic path:

```text
billing.inspect_invoice
billing.propose_late_fee_waiver
```

It measures:

- number of exposed tools;
- serialized `tools/list` bytes;
- token count with a pinned deterministic fixture tokenizer;
- scripted tool-call count;
- schema/context bytes and tokens exposed;
- business result bytes and tokens;
- whether raw SQL is exposed;
- whether write credentials are exposed;
- whether approval is separated;
- whether stale-row conflict is checked.

Tokenizer:

```text
synapsor-fixture-tokenizer-v1
```

This tokenizer is a deterministic regex tokenizer used only for repeatable
fixture comparison. It is not a model billing tokenizer.

Allowed README phrasing after implementation:

> In the included fixture, semantic capabilities replace generic schema
> exploration and raw SQL with two compact business tools. Run the benchmark to
> inspect tool definitions, reference tool-call count, and tokenized context
> size.

Do not claim guaranteed percentage savings across workloads.
