# synapsor-runner

This package is the short unscoped command alias for
[`@synapsor/runner`](https://www.npmjs.com/package/@synapsor/runner), the MCP
safety layer that lets AI agents query and update Postgres/MySQL without giving
the model raw SQL or database credentials.

```bash
npx -y synapsor-runner start
```

It contains no independent runtime. Version `1.6.6` depends on exactly
`@synapsor/runner@1.6.6` and delegates every command to that package. The
canonical package, documentation, source, and security policy remain under
`@synapsor/runner`.

The bare `synapsor` command is reserved for the separate Synapsor Cloud CLI.
