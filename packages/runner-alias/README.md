# synapsor-runner

This package is the short unscoped command alias for
[`@synapsor/runner`](https://www.npmjs.com/package/@synapsor/runner), the
database-authority layer that lets AI agents query and propose changes to
Postgres/MySQL without giving the model SQL or commit authority.

```bash
npx -y synapsor-runner start
```

It contains no independent runtime. Version `1.7.1` depends on exactly
`@synapsor/runner@1.7.1` and delegates every command to that package. The
canonical package, documentation, source, and security policy remain under
`@synapsor/runner`.

The bare `synapsor` command is reserved for the separate Synapsor Cloud CLI.
