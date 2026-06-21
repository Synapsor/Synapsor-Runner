# MCP Efficiency Benchmark

The benchmark command is planned but not implemented yet.

The intended command is:

```bash
synapsor benchmark mcp-efficiency
```

The benchmark should compare an included fixture, not make universal marketing
claims.

It should measure:

- number of exposed tools;
- serialized `tools/list` bytes;
- token count with a pinned tokenizer;
- scripted tool-call count;
- schema/context bytes and tokens exposed;
- business result bytes and tokens;
- whether raw SQL is exposed;
- whether write credentials are exposed;
- whether approval is separated;
- whether stale-row conflict is checked.

Allowed README phrasing after implementation:

> In the included fixture, semantic capabilities replace generic schema
> exploration and raw SQL with two compact business tools. Run the benchmark to
> inspect tool definitions, reference tool-call count, and tokenized context
> size.

Do not claim guaranteed percentage savings across workloads.
